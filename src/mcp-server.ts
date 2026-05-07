import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs';
import {
  buildFeatureBrief,
  renderFeatureBrief,
} from './feature-knowledge.js';
import {
  getAffectedSymbols as getAffectedSymbolsInsight,
  getRiskHotspots as getRiskHotspotsInsight,
  renderAffectedSymbols as renderAffectedSymbolsInsight,
  renderRiskHotspots as renderRiskHotspotsInsight,
} from './engineering-insights.js';
import { indexProject, queryProject } from './indexer-run.js';
import { loadGraph, type GraphData } from './graph.js';
import {
  getFeatureMap,
  getBugBrief,
  getProjectMemoryCount,
  getProjectMemoryFreshness,
  getProjectStatus,
  getWhyChanged,
  listRecentChanges,
  listRecentBugs,
  queryProjectMemory,
  renderBugBrief,
  renderFeatureMap,
  renderMemoryQueryResults,
  renderProjectStatus,
  renderRecentBugs,
  renderRecentChanges,
  renderWhyChanged,
  syncProjectMemory,
} from './project-memory.js';
import { QdrantClient } from '@qdrant/js-client-rest';
import { collectionName } from './embedder.js';
import { getDataDir, getCurrentBranch } from './git.js';
import {
  serializeFeatureBriefResponse,
  serializeQueryProjectResponse,
} from './output-format.js';
import { buildEnrichedSymbolContext, type IndexedSymbolPoint } from './symbol-context.js';

const PROJECT_ROOT_DESC = 'Absolute path to the project root. For git repositories, indexes and project memory are branch-scoped, so check status or re-index after switching branches.';
const QDRANT_URL_DESC = 'Qdrant server URL (default: http://localhost:6333). Use only if the local vector store is not running on the default port.';

type IndexedPoint = IndexedSymbolPoint;

function formatLineRanges(ranges: Array<{ startLine: number; endLine: number }>): string {
  return ranges
    .map(range => range.startLine === range.endLine ? `${range.startLine}` : `${range.startLine}-${range.endLine}`)
    .join(', ');
}

function formatGraphRelation(label: string, relation: { total: number; symbols: string[] } | undefined): string {
  if (!relation || relation.total === 0) return '';
  const suffix = relation.total > relation.symbols.length ? ', ...' : '';
  return `**${label}:** ${relation.total} (${relation.symbols.join(', ')}${suffix})`;
}

function formatCallSiteRelation(label: string, relation: { sites: Array<{ symbol: string; file: string; line: number }> } | undefined): string {
  if (!relation || relation.sites.length === 0) return '';
  return `**${label} places:** ${relation.sites.map(site => `${site.symbol} @ ${site.file}:${site.line}`).join('; ')}`;
}

function formatSymbolRelation(label: string, values: string[] | undefined): string {
  if (!values || values.length === 0) return '';
  return `**${label}:** ${values.join(', ')}`;
}

async function scrollSymbolPoints(qdrant: QdrantClient, collection: string, symbols: string[]): Promise<IndexedPoint[]> {
  if (symbols.length === 0) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { points } = await qdrant.scroll(collection, {
    filter: {
      should: symbols.map(symbol => ({ key: 'symbol', match: { value: symbol } })),
    } as any,
    with_payload: true,
    with_vector: false,
    limit: Math.max(symbols.length * 3, 10),
  });

  return points as IndexedPoint[];
}

function groupPointsBySymbol(points: IndexedPoint[]): Map<string, IndexedPoint[]> {
  const grouped = new Map<string, IndexedPoint[]>();
  for (const point of points) {
    const symbol = point.payload?.['symbol'];
    if (typeof symbol !== 'string') continue;
    if (!grouped.has(symbol)) grouped.set(symbol, []);
    grouped.get(symbol)!.push(point);
  }
  return grouped;
}

function renderIndexedSymbol(projectRoot: string, graph: GraphData | null, symbol: string, point?: IndexedPoint): string {
  const context = buildEnrichedSymbolContext(projectRoot, graph, symbol, point);
  return [
    `**${context.symbol}** (${context.type}) — ${context.file}`,
    context.lineStart && context.lineEnd ? `**Lines:** ${context.lineStart}-${context.lineEnd}` : '',
    context.freshness.indexRefreshedAt ? `**Slice index refreshed:** ${context.freshness.indexRefreshedAt}` : '',
    context.freshness.latestChange
      ? `**Latest slice change:** ${context.freshness.latestChange.timestamp || 'unknown'} ${context.freshness.latestChange.sha.slice(0, 12)} ${context.freshness.latestChange.title}`
      : '',
    context.freshness.latestChange?.changedLines.length
      ? `**Changed lines in slice:** ${formatLineRanges(context.freshness.latestChange.changedLines)}`
      : '',
    context.freshness.reasons.length > 0
      ? `**Freshness:** re-index recommended (${context.freshness.reasons.join('; ')})`
      : '',
    formatGraphRelation('Calls', context.graph.calls),
    formatCallSiteRelation('Call', context.graph.calls),
    formatGraphRelation('Used by', context.graph.usedBy),
    formatCallSiteRelation('Used by', context.graph.usedBy),
    formatGraphRelation('Supertypes', context.graph.supertypes),
    formatGraphRelation('Subtypes', context.graph.subtypes),
    formatGraphRelation('Implements', context.graph.implements),
    formatGraphRelation('Implemented by', context.graph.implementedBy),
    `**Recommended next MCP calls:** ${context.nextCalls.map(call => `${call.tool} (${call.reason})`).join('; ')}`,
    context.code ? `\`\`\`\n${context.code}\n\`\`\`` : '*(code not in index)*',
  ].filter(Boolean).join('\n');
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'code-intelligence', version: '1.0.0' });

  server.registerTool(
    'index_project',
    {
      description: 'First tool to call for a repo or branch that may not be indexed yet. Parses code, stores code embeddings, builds the call graph, and refreshes offline project memory from git history and docs. Re-run after meaningful file changes or branch switches. Typical workflow: index_project -> index_status or project_status -> feature_map/query_project/query_project_memory -> get_symbol/get_symbols/expand_graph/get_file_chunks.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      const result = await indexProject(root, qdrantUrl);
      const lines = [
        `Indexed ${result.chunks} chunks from ${root}`,
        `Symbols in graph: ${result.symbols}`,
        `Files in graph: ${result.files}`,
        `Project memory entries: ${result.memoryEntries}`,
      ];
      if (result.staleRemoved > 0) lines.push(`Removed ${result.staleRemoved} stale chunk(s)`);
      if (result.orphansRemoved > 0) lines.push(`Removed ${result.orphansRemoved} orphaned chunk(s)`);
      if (result.newMemoryEntries > 0) lines.push(`Added ${result.newMemoryEntries} new project-memory entr${result.newMemoryEntries === 1 ? 'y' : 'ies'}`);
      if (result.staleMemoryRemoved > 0) lines.push(`Removed ${result.staleMemoryRemoved} stale project-memory entr${result.staleMemoryRemoved === 1 ? 'y' : 'ies'}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'query_project',
    {
      description: 'Use for implementation questions about code behavior, ownership, data flow, or where logic lives. This is the main semantic code-search entry point and returns ranked code plus graph-expanded related symbols. Prefer query_project_memory for history, status, bug timeline, or document questions. Typical follow-up: get_symbol for one result, get_symbols for several, expand_graph for an execution path, or get_file_chunks for a whole file.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        question: z.string().describe('Natural language implementation question about the codebase, for example "how does authentication work" or "where is rate limiting applied".'),
        format: z.enum(['text', 'json']).optional().describe('Output format. Use json when the client wants structured scores, signals, and code fields (default: text).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, question, format = 'text', qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      const results = await queryProject(root, question, qdrantUrl);
      const memoryFreshness = getProjectMemoryFreshness(root);
      if (!results.length) {
        return { content: [{ type: 'text', text: 'No results found.' }] };
      }
      if (format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(serializeQueryProjectResponse(question, results, memoryFreshness), null, 2) }] };
      }
      const sections = [];
      sections.push(`Project memory refreshed: ${memoryFreshness.memoryRefreshedAt ?? 'unknown'}`);
      if (memoryFreshness.reasons.length > 0) {
        sections.push(`Project memory freshness: re-index recommended (${memoryFreshness.reasons.join('; ')})`);
      }
      const output = results
        .map(r => {
          const hybridScore = r.score;
          const semanticScore = r.semanticScore ?? 0;
          return [
            `**File:** ${r.file}`,
            `**Symbol:** ${r.symbol} (${r.type})`,
            r.lineStart && r.lineEnd ? `**Lines:** ${r.lineStart}-${r.lineEnd}` : '',
            `**Ranking:** hybrid ${hybridScore.toFixed(3)} | semantic ${semanticScore.toFixed(3)}`,
            r.freshness?.indexRefreshedAt
              ? `**Slice index refreshed:** ${r.freshness.indexRefreshedAt}`
              : '',
            r.freshness?.latestChange
              ? `**Latest slice change:** ${r.freshness.latestChange.timestamp || 'unknown'} ${r.freshness.latestChange.sha.slice(0, 12)} ${r.freshness.latestChange.title}`
              : '',
            r.freshness?.latestChange?.changedLines.length
              ? `**Changed lines in slice:** ${formatLineRanges(r.freshness.latestChange.changedLines)}`
              : '',
            r.freshness && r.freshness.reasons.length > 0
              ? `**Freshness:** re-index recommended (${r.freshness.reasons.join('; ')})`
              : '',
            formatGraphRelation('Calls', r.graphSummary?.calls),
            formatCallSiteRelation('Call', r.graphSummary?.calls),
            formatGraphRelation('Used by', r.graphSummary?.usedBy),
            formatCallSiteRelation('Used by', r.graphSummary?.usedBy),
            formatGraphRelation('Supertypes', r.graphSummary?.supertypes),
            formatGraphRelation('Subtypes', r.graphSummary?.subtypes),
            formatGraphRelation('Implements', r.graphSummary?.implements),
            formatGraphRelation('Implemented by', r.graphSummary?.implementedBy),
            (r.connectionsWithinResults?.total ?? 0) > 0
              ? `**Connected returned slices:** ${r.connectionsWithinResults?.total}`
              : '',
            formatSymbolRelation('Returned calls', r.connectionsWithinResults?.calls),
            formatSymbolRelation('Returned used by', r.connectionsWithinResults?.usedBy),
            formatSymbolRelation('Returned supertypes', r.connectionsWithinResults?.supertypes),
            formatSymbolRelation('Returned subtypes', r.connectionsWithinResults?.subtypes),
            formatSymbolRelation('Returned implements', r.connectionsWithinResults?.implements),
            formatSymbolRelation('Returned implemented by', r.connectionsWithinResults?.implementedBy),
            r.rankingSignals && r.rankingSignals.length > 0
              ? `**Ranking signals:** ${r.rankingSignals.join('; ')}`
              : '',
            r.scoreBreakdown
              ? `**Score breakdown:** semantic ${r.scoreBreakdown.semantic.toFixed(2)}, symbol overlap ${r.scoreBreakdown.symbolOverlap.toFixed(2)}, file overlap ${r.scoreBreakdown.fileOverlap.toFixed(2)}, memory ${r.scoreBreakdown.directMemory.toFixed(2)}, neighbor support ${r.scoreBreakdown.neighborSupport.toFixed(2)}, connectivity ${r.scoreBreakdown.connectivity.toFixed(2)}`
              : '',
            `\`\`\`\n${r.code}\n\`\`\``,
          ].join('\n');
        })
        .join('\n\n---\n\n');
      sections.push(output);
      return { content: [{ type: 'text', text: sections.join('\n\n') }] };
    }
  );

  // --- index_status ---
  server.registerTool(
    'index_status',
    {
      description: 'Lightweight readiness check. Use this before exploration when you are not sure the current branch is indexed, or when results may be stale after branch/file changes. If the project is not indexed, call index_project next. If it is indexed, choose project_status for a current-state summary, feature_map for high-level project understanding, query_project for code questions, or query_project_memory for history/status questions.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
      },
    },
    async ({ projectRoot }) => {
      const root = path.resolve(projectRoot);
      const branch = getCurrentBranch(root);
      const dataDir = getDataDir(root);
      const manifestFile = path.join(dataDir, 'manifest.json');
      const graphFile = path.join(dataDir, 'graph.json');

      if (!fs.existsSync(manifestFile)) {
        const msg = branch
          ? `Not indexed on branch "${branch}".\nRun index_project on: ${root}`
          : `Not indexed.\nRun index_project on: ${root}`;
        return { content: [{ type: 'text', text: msg }] };
      }

      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8')) as {
        mtimes: Record<string, number>;
        fileChunks: Record<string, string[]>;
      };
      const fileCount = Object.keys(manifest.fileChunks).length;
      const chunkCount = (Object.values(manifest.fileChunks) as string[][]).reduce((n, ids) => n + ids.length, 0);

      const graph = fs.existsSync(graphFile)
        ? JSON.parse(fs.readFileSync(graphFile, 'utf-8')) as { symbols: Record<string, string[]>; callers: Record<string, string[]> }
        : null;
      const symbolCount = graph ? Object.keys(graph.symbols).length : 0;
      const edgeCount = graph
        ? (Object.values(graph.symbols) as string[][]).reduce((n, arr) => n + arr.length, 0)
        : 0;

      const lines = [
        `Status:  Indexed`,
        ...(branch ? [`Branch:  ${branch}`] : []),
        `Files:   ${fileCount}`,
        `Chunks:  ${chunkCount}`,
        `Symbols: ${symbolCount}`,
        `Call graph edges: ${edgeCount}`,
        `Project memory entries: ${getProjectMemoryCount(root)}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'project_status',
    {
      description: 'Best first read-only project-memory tool after indexing. Use this for an engineer-style snapshot of the current branch: latest change, dirty files, active topics, and recent fixes. Prefer this over query_project when the question is "what is going on in this project right now" rather than "how is this implemented". Common next steps: recent_changes for a timeline, feature_map for capabilities/architecture, or query_project/query_project_memory for deeper investigation.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      const status = getProjectStatus(root);
      if (!status) {
        return { content: [{ type: 'text', text: 'No project memory found. Run index_project first.' }] };
      }
      return { content: [{ type: 'text', text: renderProjectStatus(status) }] };
    }
  );

  server.registerTool(
    'recent_changes',
    {
      description: 'Use for timeline-style questions such as "what changed recently", "recent fixes in auth", or "show refactors touching caching". Results come from offline project memory built from git history and are summarized by impacted symbols, files, and topics instead of raw diffs. This is usually the right follow-up after project_status when you want a chronological view.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        limit: z.number().int().min(1).max(25).optional().describe('Number of recent changes to return (default: 10)'),
        type: z.enum(['feature', 'fix', 'refactor', 'docs', 'test', 'ops', 'chore']).optional().describe('Optional change-type filter. Use this to narrow history to fixes, features, refactors, docs, tests, ops, or chores.'),
        topic: z.string().optional().describe('Optional topic filter, for example "auth", "cache", or "deployment". Useful when you already know the feature area.'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, limit = 10, type, topic, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      const entries = listRecentChanges(root, { limit, type, topic });
      return { content: [{ type: 'text', text: renderRecentChanges(entries) }] };
    }
  );

  server.registerTool(
    'recent_bugs',
    {
      description: 'Use for bug-history questions such as "what broke recently", "recent auth bugs", or "show regressions touching caching". Results come from offline bug memory synthesized from local fix history, so they surface likely past failures rather than every change.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        limit: z.number().int().min(1).max(25).optional().describe('Number of recent bug-memory entries to return (default: 10).'),
        topic: z.string().optional().describe('Optional topic filter, for example "auth", "cache", or "graph".'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, limit = 10, topic, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      const entries = listRecentBugs(root, { limit, topic });
      return { content: [{ type: 'text', text: renderRecentBugs(entries) }] };
    }
  );

  server.registerTool(
    'feature_map',
    {
      description: 'Use this to understand what the project does at a high level before diving into code. It prioritizes documented features, architecture, storage layout, supported languages, and recent feature-oriented changes from offline document memory. Prefer this over query_project when the question is about capabilities or system shape rather than implementation details.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      const featureMap = getFeatureMap(root);
      if (!featureMap) {
        return { content: [{ type: 'text', text: 'No project memory found. Run index_project first.' }] };
      }
      return { content: [{ type: 'text', text: renderFeatureMap(featureMap) }] };
    }
  );

  server.registerTool(
    'feature_brief',
    {
      description: 'Best first tool for feature-specific knowledge. Use this when you want a project-engineer brief for one feature area in a single MCP call. It combines offline docs, semantic code anchors, recent rationale, hotspots, and likely neighboring symbols, then suggests the exact symbols to inspect in a second call with get_symbols or expand_graph.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        feature: z.string().describe('Natural language feature name or area, for example "authentication", "cache invalidation", or "graph expansion".'),
        format: z.enum(['text', 'json']).optional().describe('Output format. Use json when the client wants structured anchors, rationale, hotspots, and impact data (default: text).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, feature, format = 'text', qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      const graphPath = path.join(getDataDir(root), 'graph.json');
      if (!fs.existsSync(graphPath)) {
        return { content: [{ type: 'text', text: 'Project not indexed. Run index_project first.' }] };
      }

      await syncProjectMemory(root, qdrantUrl);
      const brief = await buildFeatureBrief(root, feature, qdrantUrl);
      if (format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(serializeFeatureBriefResponse(brief), null, 2) }] };
      }
      return { content: [{ type: 'text', text: renderFeatureBrief(brief) }] };
    }
  );

  server.registerTool(
    'analyze_impact',
    {
      description: 'Use before edits, refactors, or deep debugging when you want a ranked impact neighborhood instead of a raw graph dump. It combines callers, callees, inheritance and implementation edges, plus recent project-memory history, to surface the most relevant nearby symbols around one or more seeds.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        seeds: z.array(z.string()).min(1).max(20).describe('Exact seed symbol names to analyze, for example ["buildGraph"] or ["AuthService.login", "TokenStore.refresh"].'),
        hops: z.number().int().min(1).max(3).optional().describe('How many structural hops to follow from the seeds (default: 2).'),
        direction: z.enum(['out', 'in', 'both']).optional().describe('Follow downstream dependencies, upstream dependents, or both (default: both).'),
        limit: z.number().int().min(1).max(30).optional().describe('Maximum number of ranked related symbols to return (default: 15).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, seeds, hops = 2, direction = 'both', limit = 15, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      const analysis = getAffectedSymbolsInsight(root, seeds, { hops, direction, limit });
      if (!analysis) {
        return { content: [{ type: 'text', text: 'Project not indexed. Run index_project first.' }] };
      }
      return { content: [{ type: 'text', text: renderAffectedSymbolsInsight(analysis) }] };
    }
  );

  server.registerTool(
    'risk_hotspots',
    {
      description: 'Use this to identify high-risk symbols and files before planning a change. It ranks hotspots by recent project-memory changes, fix frequency, and graph connectivity so agents can quickly spot unstable or highly connected areas that deserve extra caution. Add topic when you already know the subsystem you care about.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum number of symbol and file hotspots to return per section (default: 10).'),
        topic: z.string().optional().describe('Optional topic filter, for example "auth", "cache", or "graph".'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, limit = 10, topic, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      const hotspots = getRiskHotspotsInsight(root, { limit, topic });
      if (!hotspots) {
        return { content: [{ type: 'text', text: 'Project not indexed. Run index_project first.' }] };
      }
      return { content: [{ type: 'text', text: renderRiskHotspotsInsight(hotspots) }] };
    }
  );

  server.registerTool(
    'why_changed',
    {
      description: 'Use this when you have an exact symbol or file target and want the recent rationale and change history, not a semantic search result. It searches offline project memory for matching symbols or files and returns the most relevant recent changes, summaries, and topics. Prefer this over query_project_memory when you already know the target name.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        target: z.string().describe('Exact or near-exact symbol or file target, for example "AuthService.login", "buildGraph", or "src/cache.ts".'),
        mode: z.enum(['auto', 'symbol', 'file']).optional().describe('Match by symbol, file path, or both (default: auto).'),
        topic: z.string().optional().describe('Optional topic filter when you want the history only within one subsystem.'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum number of matching changes to return (default: 10).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, target, mode = 'auto', topic, limit = 10, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      const result = getWhyChanged(root, { target, mode, topic, limit });
      if (!result) {
        return { content: [{ type: 'text', text: 'No project memory found. Run index_project first.' }] };
      }
      return { content: [{ type: 'text', text: renderWhyChanged(result) }] };
    }
  );

  server.registerTool(
    'bug_brief',
    {
      description: 'Use this when you have an exact symbol or file target and want the nearby bug history instead of general change history. It searches offline bug memory for matching symbols or files and returns the most relevant fixed bugs, summaries, and topics.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        target: z.string().describe('Exact or near-exact symbol or file target, for example "AuthService.login", "buildGraph", or "src/cache.ts".'),
        mode: z.enum(['auto', 'symbol', 'file']).optional().describe('Match by symbol, file path, or both (default: auto).'),
        topic: z.string().optional().describe('Optional topic filter when you want bug history only within one subsystem.'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum number of matching bug entries to return (default: 10).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, target, mode = 'auto', topic, limit = 10, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      const result = getBugBrief(root, { target, mode, topic, limit });
      if (!result) {
        return { content: [{ type: 'text', text: 'No project memory found. Run index_project first.' }] };
      }
      return { content: [{ type: 'text', text: renderBugBrief(result) }] };
    }
  );

  server.registerTool(
    'query_project_memory',
    {
      description: 'Semantic search over offline project memory, which combines git-derived change memory with document-derived project facts. Use this for questions about history, status, rationale, features, architecture, or recent bugs, for example "what changed in auth recently", "why was caching touched", or "what does this project do". Prefer query_project for source-level implementation questions.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        question: z.string().describe('Natural language question about project history, status, rationale, or documented facts.'),
        limit: z.number().int().min(1).max(10).optional().describe('Number of matching memory entries to return (default: 5)'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, question, limit = 5, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      const hits = await queryProjectMemory(root, question, qdrantUrl, limit);
      return { content: [{ type: 'text', text: renderMemoryQueryResults(hits) }] };
    }
  );

  // --- get_symbol ---
  server.registerTool(
    'get_symbol',
    {
      description: 'Precision drilldown for one exact symbol. Use this after query_project when a specific function, class, or method looks relevant, or when you already know the symbol name. Returns source plus inbound and outbound graph context. If you have several symbols to inspect, prefer get_symbols to avoid repeated round trips.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        symbol: z.string().describe('Exact symbol name to look up, for example "handleRequest", "AuthService", or "AuthService.login". Best used with a symbol name taken from query_project, list_symbols, or expand_graph output.'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, symbol, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      const graph = loadGraph(path.join(getDataDir(root), 'graph.json'));
      const qdrant = new QdrantClient({ url: qdrantUrl });
      const collection = collectionName(root);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { points } = await qdrant.scroll(collection, {
        filter: { must: [{ key: 'symbol', match: { value: symbol } }] } as any,
        with_payload: true,
        with_vector: false,
        limit: 10,
      });

      if (points.length === 0) {
        return { content: [{ type: 'text', text: `Symbol "${symbol}" not found in index.` }] };
      }

      const output = points.map(p => renderIndexedSymbol(root, graph, symbol, p)).join('\n\n---\n\n');

      return { content: [{ type: 'text', text: output }] };
    }
  );

  // --- get_symbols (batch) ---
  server.registerTool(
    'get_symbols',
    {
      description: 'Batch drilldown for multiple exact symbols. Use this when query_project, get_symbol, or expand_graph gives you a list of callers/callees that you want to inspect together. This is more efficient than repeated get_symbol calls and is the right tool for comparing several related symbols at once.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        symbols: z.array(z.string()).min(1).max(50).describe('Array of exact symbol names to inspect, for example ["handleRequest", "AuthService.login"]. Usually taken from query_project, get_symbol, or expand_graph output.'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, symbols, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      const graph = loadGraph(path.join(getDataDir(root), 'graph.json'));
      const qdrant = new QdrantClient({ url: qdrantUrl });
      const collection = collectionName(root);

      // Single Qdrant scroll with OR filter — O(1) round trip regardless of symbol count
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { points } = await qdrant.scroll(collection, {
        filter: {
          should: symbols.map(s => ({ key: 'symbol', match: { value: s } })),
        } as any,
        with_payload: true,
        with_vector: false,
        limit: symbols.length * 3, // allow multiple chunks per symbol
      });

      if (points.length === 0) {
        return { content: [{ type: 'text', text: `None of the requested symbols were found in the index.` }] };
      }

      // Group points by symbol to deduplicate
      const bySymbol = new Map<string, typeof points>();
      for (const p of points) {
        const sym = p.payload!['symbol'] as string;
        if (!bySymbol.has(sym)) bySymbol.set(sym, []);
        bySymbol.get(sym)!.push(p);
      }

      // Report any not found
      const notFound = symbols.filter(s => !bySymbol.has(s));

      const sections: string[] = [];
      for (const [sym, pts] of bySymbol) {
        for (const p of pts) {
          sections.push(renderIndexedSymbol(root, graph, sym, p));
        }
      }

      if (notFound.length) {
        sections.push(`**Not found:** ${notFound.join(', ')}`);
      }

      return { content: [{ type: 'text', text: sections.join('\n\n---\n\n') }] };
    }
  );

  server.registerTool(
    'find_references',
    {
      description: 'Direct Serena-style reference lookup for one exact symbol. Use this after get_symbol or list_symbols when you need narrow upstream evidence instead of a wider subgraph. It returns graph-based callers for functions and methods, plus implementation/override references for base types or methods, with code snippets when the referenced symbols are indexed.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        symbol: z.string().describe('Exact symbol name to inspect, for example "buildGraph", "AuthService.login", or "Worker.run".'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum number of direct reference symbols to render (default: 10).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, symbol, limit = 10, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      const graph = loadGraph(path.join(getDataDir(root), 'graph.json'));

      if (!graph) {
        return { content: [{ type: 'text', text: 'Project not indexed. Run index_project first.' }] };
      }

      const callers = graph.callers?.[symbol] ?? [];
      const implementations = graph.implementations?.[symbol] ?? [];
      const totalReferences = new Set([...callers, ...implementations]);

      if (totalReferences.size === 0) {
        return { content: [{ type: 'text', text: `No direct graph references found for "${symbol}".` }] };
      }

      const shownSymbols = [...totalReferences].slice(0, limit);
      const shownSet = new Set(shownSymbols);
      const qdrant = new QdrantClient({ url: qdrantUrl });
      const collection = collectionName(root);
      const pointMap = groupPointsBySymbol(await scrollSymbolPoints(qdrant, collection, shownSymbols));

      const sections: string[] = [
        `**Direct references for ${symbol}**`,
        graph.symbolFile[symbol] ? `Declared in: ${graph.symbolFile[symbol]}` : '',
        callers.length ? `Call references: ${callers.length}` : '',
        implementations.length ? `Implementation references: ${implementations.length}` : '',
        shownSymbols.length < totalReferences.size ? `Showing first ${shownSymbols.length} of ${totalReferences.size} direct references.` : '',
      ].filter(Boolean);

      const groups: Array<{ title: string; symbols: string[] }> = [
        { title: 'Call References', symbols: callers.filter(ref => shownSet.has(ref)) },
        { title: 'Implementation References', symbols: implementations.filter(ref => shownSet.has(ref)) },
      ].filter(group => group.symbols.length > 0);

      for (const group of groups) {
        sections.push(`\n### ${group.title}`);
        for (const ref of group.symbols) {
          sections.push(renderIndexedSymbol(root, graph, ref, pointMap.get(ref)?.[0]));
        }
      }

      return { content: [{ type: 'text', text: sections.join('\n\n') }] };
    }
  );

  server.registerTool(
    'find_implementations',
    {
      description: 'Serena-style implementation lookup for one exact type or method symbol. Use this when tracing interface adopters, subclasses, or method overrides, for example "StorageProvider", "BaseIndexer", or "BaseIndexer.run". Results come from the indexed inheritance graph and include code snippets for local implementations when available.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        symbol: z.string().describe('Exact base symbol to inspect, such as an interface, class, or method. Examples: "StorageProvider", "BaseIndexer", "BaseIndexer.run".'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum number of implementations to render (default: 10).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, symbol, limit = 10, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      const graph = loadGraph(path.join(getDataDir(root), 'graph.json'));

      if (!graph) {
        return { content: [{ type: 'text', text: 'Project not indexed. Run index_project first.' }] };
      }

      const implementations = graph.implementations?.[symbol] ?? [];
      if (implementations.length === 0) {
        return { content: [{ type: 'text', text: `No implementations found for "${symbol}".` }] };
      }

      const shownSymbols = implementations.slice(0, limit);
      const qdrant = new QdrantClient({ url: qdrantUrl });
      const collection = collectionName(root);
      const pointMap = groupPointsBySymbol(await scrollSymbolPoints(qdrant, collection, shownSymbols));

      const sections: string[] = [
        `**Implementations of ${symbol}**`,
        graph.symbolFile[symbol] ? `Declared in: ${graph.symbolFile[symbol]}` : '',
        `Known implementations: ${implementations.length}`,
        shownSymbols.length < implementations.length ? `Showing first ${shownSymbols.length} implementations.` : '',
      ].filter(Boolean);

      for (const implementation of shownSymbols) {
        sections.push(renderIndexedSymbol(root, graph, implementation, pointMap.get(implementation)?.[0]));
      }

      return { content: [{ type: 'text', text: sections.join('\n\n') }] };
    }
  );

  // --- expand_graph ---
  server.registerTool(
    'expand_graph',
    {
      description: 'Use this when you need execution-path or dependency context around one or a few seed symbols. It expands the call graph outward, inward, or both, and returns reachable symbols with code. Prefer this over repeated get_symbol calls when tracing a flow through a subsystem. Start with 1-2 hops unless you intentionally want a wider boundary view.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        seeds: z.array(z.string()).min(1).max(20).describe('Exact starting symbol names to expand from. Usually taken from query_project or get_symbol output.'),
        hops: z.number().int().min(1).max(3).optional().describe('How many hops to follow in each direction (default: 2). Use 1 for tight traces and 2 for a broader module view.'),
        direction: z.enum(['out', 'in', 'both']).optional().describe('Follow outbound calls, inbound callers, or both (default: both). Use out for downstream effects, in for upstream entry points, and both for general reasoning.'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, seeds, hops = 2, direction = 'both', qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      const graph = loadGraph(path.join(getDataDir(root), 'graph.json'));

      if (!graph) {
        return { content: [{ type: 'text', text: 'Project not indexed. Run index_project first.' }] };
      }

      // BFS expansion
      const discovered = new Set<string>(seeds);
      const frontier = new Set<string>(seeds);

      for (let hop = 0; hop < hops; hop++) {
        const next = new Set<string>();
        for (const sym of frontier) {
          if (direction === 'out' || direction === 'both') {
            for (const callee of (graph.symbols[sym] ?? [])) {
              if (!discovered.has(callee)) { discovered.add(callee); next.add(callee); }
            }
          }
          if (direction === 'in' || direction === 'both') {
            for (const caller of (graph.callers?.[sym] ?? [])) {
              if (!discovered.has(caller)) { discovered.add(caller); next.add(caller); }
            }
          }
        }
        frontier.clear();
        next.forEach(s => frontier.add(s));
        if (frontier.size === 0) break;
      }

      // Cap at 60 symbols to keep response manageable
      const symbolList = [...discovered].slice(0, 60);
      const capped = discovered.size > 60;

      const qdrant = new QdrantClient({ url: qdrantUrl });
      const collection = collectionName(root);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { points } = await qdrant.scroll(collection, {
        filter: {
          should: symbolList.map(s => ({ key: 'symbol', match: { value: s } })),
        } as any,
        with_payload: true,
        with_vector: false,
        limit: symbolList.length * 2,
      });

      const bySymbol = new Map<string, typeof points[0]>();
      for (const p of points) {
        const sym = p.payload!['symbol'] as string;
        if (!bySymbol.has(sym)) bySymbol.set(sym, p); // first chunk wins
      }

      const sections: string[] = [
        `**Subgraph: ${discovered.size} symbols reachable from [${seeds.join(', ')}]** (${hops}-hop ${direction})${capped ? ' — capped at 60' : ''}`,
        '',
      ];

      // Output seeds first, then rest
      const ordered = [...seeds, ...symbolList.filter(s => !seeds.includes(s))];
      for (const sym of ordered) {
        const p = bySymbol.get(sym);
        sections.push(`### ${sym}`);
        sections.push(renderIndexedSymbol(root, graph, sym, p));
      }

      return { content: [{ type: 'text', text: sections.join('\n\n') }] };
    }
  );

  // --- list_symbols ---
  server.registerTool(
    'list_symbols',
    {
      description: 'Orientation tool for seeing the indexed API surface grouped by file. Use this when you know the module area but not the exact symbol names yet, or when you want entry points before using get_symbol/get_symbols/expand_graph. It is especially useful with fileFilter for narrowing to one subsystem such as auth, api, or graph.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        fileFilter: z.string().optional().describe('Only show symbols from files whose path contains this string, for example "auth" or "src/api". Use this to narrow orientation to one module.'),
      },
    },
    async ({ projectRoot, fileFilter }) => {
      const root = path.resolve(projectRoot);
      const graph = loadGraph(path.join(getDataDir(root), 'graph.json'));

      if (!graph) {
        return { content: [{ type: 'text', text: 'Project not indexed. Run index_project first.' }] };
      }

      const byFile: Record<string, string[]> = {};
      for (const [sym, filePath] of Object.entries(graph.symbolFile)) {
        if (fileFilter && !filePath.includes(fileFilter)) continue;
        (byFile[filePath] ??= []).push(sym);
      }

      if (Object.keys(byFile).length === 0) {
        return { content: [{ type: 'text', text: fileFilter ? `No symbols found in files matching "${fileFilter}".` : 'No symbols found.' }] };
      }

      const lines: string[] = [];
      for (const [file, symbols] of Object.entries(byFile).sort()) {
        lines.push(`**${file}**`);
        for (const sym of symbols.sort()) {
          const outDeg = (graph.symbols[sym] ?? []).length;
          const inDeg = (graph.callers?.[sym] ?? []).length;
          lines.push(`  - ${sym}  (calls ${outDeg}, calledBy ${inDeg})`);
        }
        lines.push('');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // --- get_file_chunks ---
  server.registerTool(
    'get_file_chunks',
    {
      description: 'File-level drilldown. Use this when you already know a file path and want the full indexed API surface in one call, including each symbol and its local graph context. Prefer this over query_project when the file is known and you need a compact file summary before reading specific symbols.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        file: z.string().describe('Relative file path within the project root, for example "src/auth/service.ts". Use a repo-relative path, not an absolute path.'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, file, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      const qdrant = new QdrantClient({ url: qdrantUrl });
      const collection = collectionName(root);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { points } = await qdrant.scroll(collection, {
        filter: { must: [{ key: 'file', match: { value: file } }] } as any,
        with_payload: true,
        with_vector: false,
        limit: 100,
      });

      if (points.length === 0) {
        return { content: [{ type: 'text', text: `No chunks found for "${file}". Path must be relative to project root.` }] };
      }

      const graph = loadGraph(path.join(getDataDir(root), 'graph.json'));
      const output = points.map(p => renderIndexedSymbol(root, graph, p.payload!['symbol'] as string, p)).join('\n\n---\n\n');

      return { content: [{ type: 'text', text: output }] };
    }
  );

  return server;
}

const PORT = process.env['PORT'] ? parseInt(process.env['PORT']) : null;
const useHttp = PORT !== null || process.argv.includes('--http');
const httpPort = PORT ?? 3737;

if (useHttp) {
  // HTTP Streamable mode — persistent server VS Code connects to via URL.
  // A fresh McpServer is created per request (stateless: no session tracking).
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/mcp') {
      const body = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
      });
      const parsedBody = body.length > 0 ? JSON.parse(body.toString()) : undefined;

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } else {
      res.writeHead(404).end();
    }
  });

  httpServer.listen(httpPort, () => {
    console.log(`code-intelligence MCP server listening on http://localhost:${httpPort}/mcp`);
  });
} else {
  // Stdio mode — spawned per-session by VS Code
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
}
