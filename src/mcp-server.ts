import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { z } from 'zod';
import * as path from 'path';
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
import { indexProject, queryProjectPage, type IndexMode, type ProgressCallback } from './indexer-run.js';
import { loadGraphAsync, type GraphData } from './graph.js';
import {
  getFeatureMapAsync,
  getBugBriefAsync,
  getProjectMemoryCountAsync,
  getProjectMemoryFreshnessAsync,
  getProjectStatusAsync,
  getWhyChangedAsync,
  listRecentChangesAsync,
  listRecentBugsAsync,
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
import { collectionNameAsync, resolveActiveCollectionAsync } from './embedder.js';
import { getDataDir, getCurrentBranchAsync } from './git.js';
import {
  serializeFeatureBriefResponse,
  serializeQueryProjectResponse,
} from './output-format.js';
import {
  scrollSymbolPoints,
  groupPointsBySymbol,
  expandGraphBfs,
  makeProjectQdrantClient,
  loadProjectGraph,
  renderSymbolText,
  type IndexedSymbolPoint,
} from './symbol-lookup.js';
import { findDependencyPath, topUnstableModules } from './cognition/architecture/analyzer.js';
import { loadArchitectureAsync, refreshArchitectureAsync } from './cognition/architecture/storage.js';
import {
  findSimilarFailuresAsync,
  reflectChangeAsync,
  reflectLatestChangeAsync,
  reflectionFailuresForChangeAsync,
  regressionRiskAsync,
} from './cognition/reflection/engine.js';
import {
  failureClustersAsync,
  historicalRegressionsAsync,
  refreshFailureIntelligenceAsync,
  rootCauseHistoryAsync,
} from './cognition/failures/engine.js';
import {
  boundaryAnalysisAsync,
  listConstraintViolationsAsync,
  validateArchitectureAsync,
} from './cognition/constraints/engine.js';
import { loadCognitionConfigAsync } from './cognition/config.js';
import {
  architectureDriftAsync,
  hotspotAnalysisAsync,
  instabilityTimelineAsync,
  loadEvolutionAsync,
  refreshEvolutionAsync,
} from './cognition/evolution/engine.js';
import {
  contradictionReportAsync,
  loadMemoryGovernanceAsync,
  memoryHealthAsync,
  refreshMemoryGovernanceAsync,
  staleMemoryAsync,
} from './cognition/governance/engine.js';
import {
  activeZonesAsync,
  attentionOverviewAsync,
  attentionScoreAsync,
  embeddingPriorityAsync,
  loadAttentionAsync,
  recordAttentionUsageAsync,
  refreshAttentionAsync,
  rerankByAttentionAsync,
} from './cognition/attention/engine.js';
import { loadStructureAsync, refreshStructureAsync } from './cognition/structure/engine.js';
import {
  assembleTaskContext,
  buildPreflightChanges,
  buildTestImpact,
  cognitionDiff,
  compareBranchCognition,
  generateProjectBrief,
} from './agent-ops.js';
import { buildGitSemanticChangeGraph } from './git-change-graph.js';
import { buildProjectIntentSnapshot, renderProjectIntentSnapshot } from './project-intent.js';
import { findExisting, renderFindExisting } from './find-existing.js';
import { whereShouldThisLive, renderPlacementOracle } from './placement-oracle.js';
import { validateIntent, renderIntentValidation } from './intent-validator.js';
import { validateGeneratedCode, renderCodeValidation } from './code-validator.js';
import { getModuleConventions, renderModuleConventions } from './module-conventions.js';
import { buildRepoMap, renderRepoMap } from './repo-map.js';

const PROJECT_ROOT_DESC = 'Absolute path to the project root. For git repositories, indexes and project memory are branch-scoped, so check status or re-index after switching branches.';
const QDRANT_URL_DESC = 'Qdrant server URL (default: http://localhost:6333). Use only if the local vector store is not running on the default port.';

type IndexedPoint = IndexedSymbolPoint;

type McpLogLevel = 'debug' | 'info' | 'warn' | 'error';
type ProcessLogDestination = 'stdout' | 'stderr' | 'split';

const PORT = process.env['PORT'] ? parseInt(process.env['PORT']) : null;
const useHttp = PORT !== null || process.argv.includes('--http');
const httpPort = PORT ?? 3737;

function parseLogDestination(value: string | undefined): ProcessLogDestination | null {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'stdout':
      return 'stdout';
    case 'stderr':
      return 'stderr';
    case 'split':
      return 'split';
    default:
      return null;
  }
}

const MCP_LOG_DESTINATION: ProcessLogDestination = parseLogDestination(process.env['CODE_INTEL_LOG_DESTINATION'])
  ?? (useHttp ? 'split' : 'stderr');

process.env['CODE_INTEL_LOG_DESTINATION'] = MCP_LOG_DESTINATION;

const LOG_LEVEL_PRIORITY: Record<McpLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const INDEX_STAGE_LABELS: Record<Parameters<ProgressCallback>[0], string> = {
  'pre-scanning': 'Pre-scanning files',
  parsing: 'Parsing files',
  'building-graph': 'Building call graph',
  'building-manifest': 'Building manifest',
  cleaning: 'Cleaning stale data',
  'loading-model': 'Loading embedding model',
  embedding: 'Embedding code',
  storing: 'Storing embeddings',
  'syncing-memory': 'Syncing project memory',
  'computing-cognition': 'Computing cognition layers',
};

function isTruthyEnvValue(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? '');
}

function parseLogLevel(value: string | undefined): McpLogLevel {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'debug':
      return 'debug';
    case 'warn':
      return 'warn';
    case 'error':
      return 'error';
    case 'info':
    default:
      return 'info';
  }
}

const MCP_LOG_LEVEL: McpLogLevel = isTruthyEnvValue(process.env['CODE_INTEL_MCP_DEBUG'])
  ? 'debug'
  : parseLogLevel(process.env['CODE_INTEL_MCP_LOG_LEVEL']);

function shouldLog(level: McpLogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[MCP_LOG_LEVEL];
}

function truncateForLog(value: string, max = 180): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function summarizeForLog(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateForLog(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(MCP_LOG_LEVEL === 'debug' && value.stack
        ? { stack: truncateForLog(value.stack, 1200) }
        : {}),
    };
  }
  if (Array.isArray(value)) {
    if (depth >= 2) return `[array(${value.length})]`;
    const sample = value.slice(0, 5).map(item => summarizeForLog(item, depth + 1));
    return value.length > 5 ? [...sample, `… +${value.length - 5} more`] : sample;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (depth >= 2) {
      return `{keys:${entries.slice(0, 8).map(([key]) => key).join(',')}}`;
    }

    const summary: Record<string, unknown> = {};
    for (const [key, entryValue] of entries.slice(0, 12)) {
      summary[key] = /token|secret|password|api[-_]?key|authorization/i.test(key)
        ? '[redacted]'
        : summarizeForLog(entryValue, depth + 1);
    }
    if (entries.length > 12) {
      summary['__truncatedKeys'] = entries.length - 12;
    }
    return summary;
  }
  return String(value);
}

function formatLogMeta(meta: unknown): string {
  if (meta === undefined) return '';
  const safeMeta = summarizeForLog(meta);
  if (typeof safeMeta === 'string') return safeMeta;
  try {
    return JSON.stringify(safeMeta);
  } catch {
    return String(safeMeta);
  }
}

function logStreamForLevel(level: McpLogLevel): NodeJS.WriteStream {
  if (MCP_LOG_DESTINATION === 'stdout') return process.stdout;
  if (MCP_LOG_DESTINATION === 'stderr') return process.stderr;
  return level === 'error' ? process.stderr : process.stdout;
}

function mcpLog(level: McpLogLevel, message: string, meta?: unknown): void {
  if (!shouldLog(level)) return;
  const suffix = meta === undefined ? '' : ` ${formatLogMeta(meta)}`;
  logStreamForLevel(level).write(`[code-intel:mcp][${level}] ${new Date().toISOString()} ${message}${suffix}\n`);
}

function drawLogProgressBar(done: number, total: number): string {
  const width = 25;
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);
  const filled = Math.round((width * pct) / 100);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${String(pct).padStart(3)}% ${done}/${total}`;
}

function summarizeToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return summarizeForLog(result);

  const typed = result as {
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  };

  if (Array.isArray(typed.content)) {
    const firstItem = typed.content[0];
    return {
      contentItems: typed.content.length,
      firstType: firstItem?.type,
      firstTextPreview: typeof firstItem?.text === 'string' ? truncateForLog(firstItem.text, 220) : undefined,
      hasStructuredContent: typed.structuredContent !== undefined,
      isError: typed.isError === true,
    };
  }

  return summarizeForLog(result);
}

function createIndexProgressLogger(projectRoot: string, indexMode: IndexMode, fromScratch: boolean): ProgressCallback {
  mcpLog('info', `Scanning ${projectRoot}...`);
  if (fromScratch) {
    mcpLog('warn', 'Full reindex mode enabled; deleting all previous index data before rebuild');
  }
  mcpLog('info', `Index mode: ${indexMode}`);

  let lastMessage = '';
  return (stage, done, total) => {
    const label = INDEX_STAGE_LABELS[stage] ?? stage;
    const message = total <= 1
      ? `  ${label}${done === 0 ? '...' : ' complete'}`
      : `  ${label} ${drawLogProgressBar(done, total)}`;

    if (message === lastMessage) return;
    lastMessage = message;
    mcpLog('info', message);
  };
}

function attachToolLogging(server: McpServer): void {
  const originalRegisterTool = server.registerTool.bind(server);

  server.registerTool = ((name: string, config: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
    return (originalRegisterTool as (...args: unknown[]) => unknown)(
      name,
      config,
      async (...handlerArgs: unknown[]) => {
        const startedAt = performance.now();
        mcpLog('info', `Tool started: ${name}`);
        if (MCP_LOG_LEVEL === 'debug') {
          mcpLog('debug', `Tool input: ${name}`, handlerArgs[0]);
        }

        try {
          const result = await handler(...handlerArgs);
          const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
          if (MCP_LOG_LEVEL === 'debug') {
            mcpLog('debug', `Tool result: ${name}`, summarizeToolResult(result));
          }
          mcpLog('info', `Tool completed: ${name}`, { durationMs });
          return result;
        } catch (error) {
          const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
          mcpLog('error', `Tool failed: ${name}`, { durationMs, error });
          throw error;
        }
      }
    );
  }) as typeof server.registerTool;
}

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

// scrollSymbolPoints, groupPointsBySymbol, expandGraphBfs, renderSymbolText
// are imported from ./symbol-lookup.js

async function renderIndexedSymbol(projectRoot: string, graph: GraphData | null, symbol: string, point?: IndexedPoint): Promise<string> {
  return renderSymbolText(projectRoot, graph, symbol, point);
}

async function enforceCognitionPipeline(projectRoot: string, qdrantUrl = 'http://localhost:6333'): Promise<{
  structureModules: number;
  attentionCritical: number;
  constraintViolations: number;
}> {
  await syncProjectMemory(projectRoot, qdrantUrl);
  const structure = await refreshStructureAsync(projectRoot);
  const architecture = await refreshArchitectureAsync(projectRoot);
  const attention = await refreshAttentionAsync(projectRoot);
  await refreshFailureIntelligenceAsync(projectRoot);
  await validateArchitectureAsync(projectRoot);
  await refreshEvolutionAsync(projectRoot);
  const constraints = await validateArchitectureAsync(projectRoot);
  await refreshMemoryGovernanceAsync(projectRoot);

  return {
    structureModules: structure?.modules.length ?? architecture?.modules.length ?? 0,
    attentionCritical: attention?.modules.filter(module => module.tier === 'CRITICAL').length ?? 0,
    constraintViolations: constraints.violations.length,
  };
}

async function checkQdrantHealthAsync(qdrantUrl: string): Promise<{ status: 'healthy' | 'degraded' | 'unavailable'; message?: string }> {
  try {
    const res = await fetch(`${qdrantUrl.replace(/\/$/, '')}/healthz`);
    if (res.ok) return { status: 'healthy' };
    const text = await res.text().catch(() => '');
    return { status: 'degraded', message: `Qdrant healthz returned ${res.status}: ${text}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'unavailable', message: `Qdrant unreachable at ${qdrantUrl}: ${message}` };
  }
}

function isQdrantUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes('fetch failed')
    || message.includes('econnrefused')
    || message.includes('connectionrefused')
    || message.includes('unreachable')
    || message.includes('connect')
    || message.includes('qdrant')
    || message.includes('collection')
    || message.includes('not found');
}

function qdrantUnavailableResponse(qdrantUrl: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text', text: `Qdrant backend unavailable at ${qdrantUrl}` }],
    isError: true,
  };
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'code-intelligence', version: '1.0.0' });
  attachToolLogging(server);

  const registerSnapshotResource = (name: string, fileName: string, description: string): void => {
    server.registerResource(
      name,
      `code-intel://snapshot/${fileName}`,
      { mimeType: 'application/json', description },
      async () => {
        const root = process.cwd();
        mcpLog('debug', `Resource requested: ${name}`, { root, fileName });
        const file = Bun.file(path.join(getDataDir(root), fileName));
        if (!(await file.exists())) {
          mcpLog('warn', `Resource unavailable: ${name}`, { root, fileName });
          return {
            contents: [{
              uri: `code-intel://snapshot/${fileName}`,
              mimeType: 'application/json',
              text: JSON.stringify({ error: `${fileName} not found`, hint: 'Run index_project first.' }, null, 2),
            }],
          };
        }
        return {
          contents: [{
            uri: `code-intel://snapshot/${fileName}`,
            mimeType: 'application/json',
            text: await file.text(),
          }],
        };
      }
    );
  };

  registerSnapshotResource('structure_snapshot', 'structure.json', 'Current structure cognition snapshot (modules, dependencies, zones, cycles).');
  registerSnapshotResource('architecture_snapshot', 'architecture.json', 'Current architecture cognition snapshot (coupling, instability, dependencies).');
  registerSnapshotResource('attention_snapshot', 'attention.json', 'Current attention cognition snapshot (module/symbol tiers and scores).');

  server.registerTool(
    'index_project',
    {
      description: 'First tool to call for a repo or branch that may not be indexed yet. Parses code, stores code embeddings, builds the call graph, and refreshes offline project memory from git history and docs. Re-run after meaningful file changes or branch switches. Use fromScratch=true to clear all previous index data and rebuild from zero. Typical workflow: index_project -> index_status or project_status -> feature_map/query_project/query_project_memory -> get_symbol/get_symbols/expand_graph/get_file_chunks.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
        fromScratch: z.boolean().optional().describe('If true, delete all previous index data and reindex from zero. Use this to clear accumulated stale data or after major refactors. Default: false (differential index).'),
        indexMode: z.enum(['fast', 'full']).optional().describe('fast = high-signal indexing for speed/quality, full = exhaustive indexing including lower-relevance data. Default: fast.'),
      },
    },
    async ({ projectRoot, qdrantUrl = 'http://localhost:6333', fromScratch = false, indexMode = 'fast' }) => {
      const root = path.resolve(projectRoot);
      const result = await indexProject(root, qdrantUrl, createIndexProgressLogger(root, indexMode, fromScratch), fromScratch, indexMode);
      mcpLog('info', 'Index project summary', {
        root,
        mode: result.mode,
        discoveredChunks: result.discoveredChunks,
        indexedChunks: result.indexedChunks,
        filteredOutChunks: result.filteredOutChunks,
        symbols: result.symbols,
        files: result.files,
        totalDurationMs: result.totalDurationMs,
      });
      const lines = [];
      if (fromScratch) {
        lines.push('🔄 Full reindex from scratch (deleted all previous data)');
      }
      lines.push(
        `Index mode: ${result.mode}`,
        `Discovered ${result.discoveredChunks} chunks in ${root}`,
        `Indexed ${result.indexedChunks} chunks (${result.filteredOutChunks} filtered out)`,
        `Index duration: ${result.totalDurationMs}ms`,
        `Stage timings: ${Object.entries(result.stageDurationsMs).map(([stage, ms]) => `${stage}=${ms}ms`).join(', ') || 'none'}`,
        `Symbols in graph: ${result.symbols}`,
        `Files in graph: ${result.files}`,
        `Project memory entries: ${result.memoryEntries}`,
        `Architecture modules: ${result.architectureModules}`,
        `Failure records: ${result.failureRecords}`,
        `Constraint violations: ${result.constraintViolations}`,
        `Evolution modules: ${result.evolutionModules}`,
        `Stale memory entries: ${result.staleMemoryEntries}`,
        `Structure modules: ${result.structureModules}`,
        `Critical attention modules: ${result.attentionCritical}`,
      );
      if (result.staleRemoved > 0) lines.push(`Removed ${result.staleRemoved} stale chunk(s)`);
      if (result.orphansRemoved > 0) lines.push(`Removed ${result.orphansRemoved} orphaned chunk(s)`);
      if (result.newMemoryEntries > 0) lines.push(`Added ${result.newMemoryEntries} new project-memory entr${result.newMemoryEntries === 1 ? 'y' : 'ies'}`);
      if (result.staleMemoryRemoved > 0) lines.push(`Removed ${result.staleMemoryRemoved} stale project-memory entr${result.staleMemoryRemoved === 1 ? 'y' : 'ies'}`);
      if (result.memoryDriftWarning) lines.push(`⚠️ ${result.memoryDriftWarning}`);
      if (result.externalScanEntries > 0) lines.push(`Ingested ${result.externalScanEntries} external scan entr${result.externalScanEntries === 1 ? 'y' : 'ies'} (audit/outdated/knip/lint)`);
      if (result.reflectionGenerated) lines.push('Generated reflection entry for latest indexed change');
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
        mode: z.enum(['default', 'architecture']).optional().describe('Retrieval mode. Use architecture for package/module/topology-first results (default: default).'),
        semanticThreshold: z.number().min(0).max(1).optional().describe('Semantic threshold for expanding caller/callee neighborhood from strong matches (default: 0.5).'),
        page: z.number().int().min(1).optional().describe('Result page number (default: 1).'),
        pageSize: z.number().int().min(1).max(20).optional().describe('Results per page (default: 6).'),
        format: z.enum(['text', 'json']).optional().describe('Output format. Use json when the client wants structured scores, signals, and code fields (default: text).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, question, mode = 'default', semanticThreshold = 0.5, page = 1, pageSize = 6, format = 'text', qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      try {
        const pipeline = await enforceCognitionPipeline(root, qdrantUrl);

        // Check constraint violations and show as warning (always return results)
        const config = await loadCognitionConfigAsync(root);
        let violationWarning = '';
        if (config.policy.hardPolicyEnabled && config.policy.blockOnSeverity !== 'none') {
          const violations = await listConstraintViolationsAsync(root);
          const severityOrder = { high: 3, medium: 2, low: 1, none: 0 };
          const blockThreshold = severityOrder[config.policy.blockOnSeverity];
          const blockingViolations = violations.filter(v => severityOrder[v.severity] >= blockThreshold);

          if (blockingViolations.length > 0) {
            violationWarning = `⚠️  CONSTRAINT VIOLATIONS (severity >= ${config.policy.blockOnSeverity}):\n${blockingViolations.map(v => `  - ${v.rule}: ${v.details} (in modules: ${v.modules.join(', ')})`).join('\n')}\n`;
          }
        }

        const response = await queryProjectPage(root, question, qdrantUrl, {
          mode,
          semanticThreshold,
          page,
          pageSize,
        });
        let results = response.results;
        results = await rerankByAttentionAsync(root, results);
        const memoryFreshness = await getProjectMemoryFreshnessAsync(root);
        const structure = await loadStructureAsync(root);
        await recordAttentionUsageAsync(root, {
          tool: 'query_project',
          symbols: results.map(result => result.symbol).slice(0, 10),
          modules: results
            .map(result => structure?.symbolToModule[result.symbol])
            .filter((value): value is string => typeof value === 'string')
            .slice(0, 10),
        });

        if (!results.length) {
          return { content: [{ type: 'text', text: 'No results found.' }] };
        }
        if (format === 'json') {
          return { content: [{ type: 'text', text: JSON.stringify(serializeQueryProjectResponse(question, results, memoryFreshness, response.pagination), null, 2) }] };
        }
        const sections = [];
        if (violationWarning) {
          sections.push(violationWarning);
        }
        sections.push(`Pipeline enforced: structure modules ${pipeline.structureModules}, critical attention ${pipeline.attentionCritical}, constraint violations ${pipeline.constraintViolations}`);
        sections.push(`Results page ${response.pagination.page}/${response.pagination.totalPages} (page size ${response.pagination.pageSize}, total ${response.pagination.totalResults})`);
        if (response.pagination.hasMore && response.pagination.nextPage) {
          sections.push(`More context available: call query_project again with page=${response.pagination.nextPage} and pageSize=${response.pagination.pageSize}`);
        }
        if (response.pagination.symbolIndexByPage.length > 0) {
          sections.push('Symbols by page:');
          sections.push(...response.pagination.symbolIndexByPage.map(entry => `- page ${entry.page}: ${entry.symbols.join(', ') || '(none)'}`));
        }
        sections.push(...response.pagination.callGraphPreviewLines);
        sections.push(`Project memory refreshed: ${memoryFreshness.memoryRefreshedAt ?? 'unknown'}`);
        if (memoryFreshness.reasons.length > 0) {
          sections.push(`Project memory freshness: re-index recommended (${memoryFreshness.reasons.join('; ')})`);
        }
        if (mode === 'architecture') {
          const snapshot = await buildProjectIntentSnapshot(root);
          if (snapshot) {
            const overviewClaims = snapshot.claims
              .filter(claim => claim.category === 'architecture' || claim.category === 'patterns' || claim.category === 'entrypoints')
              .slice(0, 6)
              .map(claim => `- [${claim.evidenceTier}] ${claim.statement}`);
            if (overviewClaims.length > 0) {
              sections.push('Architecture overview:');
              sections.push(...overviewClaims);
            }
          }
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
        sections.push(`Results page ${response.pagination.page}/${response.pagination.totalPages} (page size ${response.pagination.pageSize}, total ${response.pagination.totalResults})`);
        if (response.pagination.hasMore && response.pagination.nextPage) {
          sections.push(`More context available: call query_project again with page=${response.pagination.nextPage} and pageSize=${response.pagination.pageSize}`);
        }
        return { content: [{ type: 'text', text: sections.join('\n\n') }] };
      } catch (error) {
        if (isQdrantUnavailableError(error)) return qdrantUnavailableResponse(qdrantUrl);
        throw error;
      }
    }
  );

  server.registerTool(
    'smart_query',
    {
      description: 'Answer natural language questions about the codebase by retrieving relevant code context and synthesizing an answer via a local LLM (Ollama). Use this when you want a concise, synthesized explanation rather than raw search results. Requires Ollama to be running.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        question: z.string().describe('Natural language question about the codebase.'),
        model: z.string().optional().describe('Ollama model name (default: qwen2.5:3b).'),
        ollamaUrl: z.string().optional().describe('Ollama server URL (default: http://localhost:11434).'),
        pageSize: z.number().int().min(1).max(8).optional().describe('Number of code chunks to retrieve (default: 4, max: 8).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, question, model = 'qwen2.5:3b', ollamaUrl = 'http://localhost:11434', pageSize = 4, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      
      // 1. Fetch code context via queryProjectPage (small pageSize to stay within token budget)
      const response = await queryProjectPage(root, question, qdrantUrl, {
        mode: 'default',
        semanticThreshold: 0.5,
        page: 1,
        pageSize,
      });
      
      const results = response.results;
      
      if (!results.length) {
        return { content: [{ type: 'text', text: 'No relevant code found for this question.' }] };
      }
      
      // 2. Build prompt
      const contextParts = results.map(r => {
        const lines = r.lineStart && r.lineEnd ? ` (lines ${r.lineStart}-${r.lineEnd})` : '';
        return `File: ${r.file}${lines}\nSymbol: ${r.symbol} (${r.type})\n\n\`\`\`\n${r.code}\n\`\`\`\n`;
      });
      
      const prompt = `You are a code intelligence assistant. Answer the user's question about the codebase using ONLY the provided code context. Be concise and accurate.\n\nQuestion: ${question}\n\nCode Context:\n\n${contextParts.join('\n---\n\n')}\n\nAnswer:`;
      
      // 3. Call Ollama
      try {
        const res = await fetch(`${ollamaUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt,
            stream: false,
          }),
        });
        
        if (!res.ok) {
          const errorText = await res.text().catch(() => 'Unknown error');
          return {
            content: [{ type: 'text', text: `Ollama request failed (${res.status}): ${errorText}\n\nHint: Make sure Ollama is running at ${ollamaUrl} and the model '${model}' is pulled.` }],
            isError: true,
          };
        }
        
        const data = await res.json() as { response?: string; error?: string };
        
        if (data.error) {
          return {
            content: [{ type: 'text', text: `Ollama error: ${data.error}\n\nHint: Make sure the model '${model}' is available (run: ollama pull ${model})` }],
            isError: true,
          };
        }
        
        const answer = data.response ?? 'No response from model.';
        
        return { content: [{ type: 'text', text: answer }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Failed to connect to Ollama at ${ollamaUrl}: ${message}\n\nHint: Make sure Ollama is running (ollama serve).` }],
          isError: true,
        };
      }
    }
  );

  // --- index_status ---
  server.registerTool(
    'index_status',
    {
      description: 'Lightweight readiness check. Use this before exploration when you are not sure the current branch is indexed, or when results may be stale after branch/file changes. If the project is not indexed, call index_project next. If it is indexed, choose project_status for a current-state summary, feature_map for high-level project understanding, query_project for code questions, or query_project_memory for history/status questions.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      const branch = await getCurrentBranchAsync(root);
      const dataDir = getDataDir(root);
      const manifestFile = path.join(dataDir, 'manifest.json');
      const graphFile = path.join(dataDir, 'graph.json');

      const qdrantHealth = await checkQdrantHealthAsync(qdrantUrl);

      let manifestRaw: string | null = null;
      try {
        manifestRaw = await Bun.file(manifestFile).text();
      } catch {
        manifestRaw = null;
      }

      if (!manifestRaw) {
        const lines = [
          `Status:  Not indexed`,
          ...(branch ? [`Branch:  ${branch}`] : []),
          `Qdrant:  ${qdrantHealth.status}${qdrantHealth.message ? ` (${qdrantHealth.message})` : ''}`,
          `Run index_project on: ${root}`,
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      const manifest = JSON.parse(manifestRaw) as {
        mtimes: Record<string, number>;
        fileChunks: Record<string, string[]>;
      };
      const fileCount = Object.keys(manifest.fileChunks).length;
      const chunkCount = (Object.values(manifest.fileChunks) as string[][]).reduce((n, ids) => n + ids.length, 0);

      let graph: { symbols: Record<string, string[]>; callers: Record<string, string[]> } | null = null;
      try {
        graph = JSON.parse(await Bun.file(graphFile).text()) as { symbols: Record<string, string[]>; callers: Record<string, string[]> };
      } catch {
        graph = null;
      }
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
        `Project memory entries: ${await getProjectMemoryCountAsync(root)}`,
        `Qdrant:  ${qdrantHealth.status}${qdrantHealth.message ? ` (${qdrantHealth.message})` : ''}`,
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
      const status = await getProjectStatusAsync(root);
      if (!status) {
        return { content: [{ type: 'text', text: 'No project memory found. Run index_project first.' }] };
      }
      return { content: [{ type: 'text', text: renderProjectStatus(status) }] };
    }
  );

  server.registerTool(
    'architecture_overview',
    {
      description: 'Architecture cognition snapshot built from symbol graph dependencies. Use before planning edits to understand module boundaries, dependency direction, and architecture zones.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        refresh: z.boolean().optional().describe('Recompute architecture snapshot from latest graph before returning it (default: false).'),
      },
    },
    async ({ projectRoot, refresh = false }) => {
      const root = path.resolve(projectRoot);
      const snapshot = refresh
        ? await refreshArchitectureAsync(root)
        : (await loadArchitectureAsync(root) ?? await refreshArchitectureAsync(root));
      if (!snapshot) {
        return { content: [{ type: 'text', text: 'Project not indexed. Run index_project first.' }] };
      }

      const topCoupled = Object.entries(snapshot.coupling as Record<string, number>)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 8)
        .map(([module, score]) => `${module} (${score.toFixed(2)})`);
      const unstable = topUnstableModules(snapshot, 8)
        .map(entry => `${entry.module} (${entry.instability.toFixed(2)})`);
      const zones = (snapshot.zones as Array<{ name: string; modules: string[] }>)
        .map(zone => `${zone.name}: ${zone.modules.join(', ')}`)
        .join('\n');

      const lines = [
        `Architecture generated: ${snapshot.generatedAt}`,
        `Modules: ${snapshot.modules.length}`,
        `Dependencies: ${snapshot.dependencies.length}`,
        '',
        '**Top Coupled Modules**',
        topCoupled.length > 0 ? topCoupled.join('\n') : 'none',
        '',
        '**Unstable Modules**',
        unstable.length > 0 ? unstable.join('\n') : 'none',
        '',
        '**Zones**',
        zones || 'none',
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'dependency_path',
    {
      description: 'Find a module-level dependency path between two modules. Use this to reason about transitive dependency direction before introducing new imports or cross-module calls.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        from: z.string().describe('Source module name, e.g. "src/cognition".'),
        to: z.string().describe('Target module name, e.g. "src/indexer".'),
      },
    },
    async ({ projectRoot, from, to }) => {
      const root = path.resolve(projectRoot);
      const snapshot = await loadArchitectureAsync(root) ?? await refreshArchitectureAsync(root);
      if (!snapshot) {
        return { content: [{ type: 'text', text: 'Project not indexed. Run index_project first.' }] };
      }

      const result = findDependencyPath(snapshot, from, to);
      if (!result) {
        return { content: [{ type: 'text', text: `No dependency path found from ${from} to ${to}.` }] };
      }

      return {
        content: [{
          type: 'text',
          text: [
            `Dependency path from ${from} to ${to}:`,
            result.path.join(' -> '),
            `Total edge weight: ${result.totalWeight.toFixed(2)}`,
          ].join('\n'),
        }],
      };
    }
  );

  server.registerTool(
    'coupling_report',
    {
      description: 'Report module coupling scores and strongest dependency edges. Use this before refactors to identify tightly-coupled zones likely to regress.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        limit: z.number().int().min(1).max(30).optional().describe('Maximum modules and edges to return (default: 10).'),
      },
    },
    async ({ projectRoot, limit = 10 }) => {
      const root = path.resolve(projectRoot);
      const snapshot = await loadArchitectureAsync(root) ?? await refreshArchitectureAsync(root);
      if (!snapshot) {
        return { content: [{ type: 'text', text: 'Project not indexed. Run index_project first.' }] };
      }

      const modules = Object.entries(snapshot.coupling as Record<string, number>)
        .sort((left, right) => right[1] - left[1])
        .slice(0, limit)
        .map(([module, score]) => `${module}: ${score.toFixed(2)}`);
      const edges = (snapshot.dependencies as Array<{ from: string; to: string; weight: number; calls: number; imports: number }>)
        .sort((left, right) => right.weight - left.weight)
        .slice(0, limit)
        .map(dep => `${dep.from} -> ${dep.to} (weight ${dep.weight.toFixed(2)}, calls ${dep.calls}, imports ${dep.imports})`);
      const coarseModules = snapshot.modules.filter(module => !module.name.includes('/')).length;
      const coarseRatio = snapshot.modules.length > 0 ? coarseModules / snapshot.modules.length : 0;
      const caveat = coarseRatio >= 0.7
        ? 'Note: module granularity appears coarse (many top-level buckets). Prefer validating high-weight edges and risk hotspots together.'
        : '';

      return {
        content: [{
          type: 'text',
          text: [
            '**Coupling Scores**',
            modules.length > 0 ? modules.join('\n') : 'none',
            '',
            '**Heaviest Dependencies**',
            edges.length > 0 ? edges.join('\n') : 'none',
            caveat ? `\n${caveat}` : '',
          ].join('\n'),
        }],
      };
    }
  );

  server.registerTool(
    'unstable_modules',
    {
      description: 'List modules with the highest instability score (outbound / total dependencies). Use this to identify volatile areas before code generation.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        limit: z.number().int().min(1).max(30).optional().describe('Maximum number of modules to return (default: 10).'),
      },
    },
    async ({ projectRoot, limit = 10 }) => {
      const root = path.resolve(projectRoot);
      const snapshot = await loadArchitectureAsync(root) ?? await refreshArchitectureAsync(root);
      if (!snapshot) {
        return { content: [{ type: 'text', text: 'Project not indexed. Run index_project first.' }] };
      }

      const unstable = topUnstableModules(snapshot, limit)
        .map(item => `${item.module}: instability ${item.instability.toFixed(2)} (outbound ${item.outbound}, inbound ${item.inbound})`);
      const allZeroInstability = snapshot.modules.length > 0
        && snapshot.modules.every(module => (snapshot.instability[module.name] ?? 0) === 0);

      const text = [
        unstable.length > 0 ? unstable.join('\n') : 'No unstable modules found.',
        allZeroInstability
          ? '\nCaveat: instability scores are all 0.00. Treat this as low-confidence and cross-check with dependency edges/coupling.'
          : '',
      ].filter(Boolean).join('\n');

      return { content: [{ type: 'text', text }] };
    }
  );

  server.registerTool(
    'attention_overview',
    {
      description: 'Show attention snapshot across modules and symbols computed after structural cognition.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        refresh: z.boolean().optional().describe('Recompute attention snapshot before returning data (default: true).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, refresh = true, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      if (refresh) await enforceCognitionPipeline(root, qdrantUrl);
      const snapshot = await attentionOverviewAsync(root) ?? await refreshAttentionAsync(root);
      if (!snapshot) {
        return { content: [{ type: 'text', text: 'No attention snapshot available. Run index_project first.' }] };
      }

      const top = snapshot.modules.slice(0, 10)
        .map(module => `${module.module}: tier ${module.tier}, composite ${module.score.composite.toFixed(3)}`);

      return {
        content: [{
          type: 'text',
          text: [
            `Attention generated: ${snapshot.generatedAt}`,
            `Modules scored: ${snapshot.modules.length}`,
            `Symbols scored: ${snapshot.symbols.length}`,
            '',
            '**Top Attention Modules**',
            top.join('\n') || 'none',
          ].join('\n'),
        }],
      };
    }
  );

  server.registerTool(
    'attention_score',
    {
      description: 'Return detailed attention breakdown for a target module or symbol.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        target: z.string().describe('Module or symbol target.'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, target, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await enforceCognitionPipeline(root, qdrantUrl);
      const score = await attentionScoreAsync(root, target);
      if (!score) {
        return { content: [{ type: 'text', text: `No attention score found for target "${target}".` }] };
      }

      if ('score' in score) {
        return {
          content: [{
            type: 'text',
            text: [
              `Module: ${score.module}`,
              `Tier: ${score.tier}`,
              `Structural: ${score.score.structural.toFixed(3)}`,
              `Temporal: ${score.score.temporal.toFixed(3)}`,
              `Behavioral: ${score.score.behavioral.toFixed(3)}`,
              `Failure: ${score.score.failure.toFixed(3)}`,
              `Volatility: ${score.score.volatility.toFixed(3)}`,
              `Freshness: ${score.score.freshness.toFixed(3)}`,
              `Centrality: ${score.score.centrality.toFixed(3)}`,
              `Confidence: ${score.score.confidence.toFixed(3)}`,
              `Composite: ${score.score.composite.toFixed(3)}`,
            ].join('\n'),
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: [
            `Symbol: ${score.symbol}`,
            `Module: ${score.module}`,
            `Tier: ${score.tier}`,
            `Composite: ${score.composite.toFixed(3)}`,
          ].join('\n'),
        }],
      };
    }
  );

  server.registerTool(
    'active_zones',
    {
      description: 'Show active architecture zones ordered by attention concentration.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await enforceCognitionPipeline(root, qdrantUrl);
      const zones = await activeZonesAsync(root);
      if (zones.length === 0) {
        return { content: [{ type: 'text', text: 'No active zones found.' }] };
      }
      return { content: [{ type: 'text', text: zones.map(zone => `${zone.zone}: ${zone.modules.join(', ')}`).join('\n') }] };
    }
  );

  server.registerTool(
    'hotspots',
    {
      description: 'Attention-driven hotspot view of modules requiring immediate engineering focus.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        limit: z.number().int().min(1).max(30).optional().describe('Maximum number of hotspots to return (default: 10).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, limit = 10, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await enforceCognitionPipeline(root, qdrantUrl);
      const snapshot = await attentionOverviewAsync(root);
      if (!snapshot) {
        return { content: [{ type: 'text', text: 'No attention snapshot available.' }] };
      }
      const lines = snapshot.modules.slice(0, limit)
        .map(module => `${module.module}: ${module.tier} (${module.score.composite.toFixed(3)})`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'regression_hotspots',
    {
      description: 'Failure-prone hotspots correlated from historical regressions and temporal risk.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        limit: z.number().int().min(1).max(30).optional().describe('Maximum number of regression hotspots to return (default: 10).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, limit = 10, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await enforceCognitionPipeline(root, qdrantUrl);
      const failures = await historicalRegressionsAsync(root, undefined, limit);
      if (failures.length === 0) {
        return { content: [{ type: 'text', text: 'No regression hotspots found.' }] };
      }
      const lines = failures.map(entry => `${entry.timestamp} ${entry.title} :: ${entry.clusterKeys.join(', ') || 'none'}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'embedding_priority',
    {
      description: 'Return selective semantic enrichment queue based on attention tiers.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum number of symbols in priority queue (default: 30).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, limit = 30, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await enforceCognitionPipeline(root, qdrantUrl);
      const queue = await embeddingPriorityAsync(root, limit);
      if (queue.length === 0) {
        return { content: [{ type: 'text', text: 'No embedding priority data found.' }] };
      }
      const lines = queue.map(item => `${item.symbol}: tier ${item.tier}, composite ${item.composite.toFixed(3)} (${item.module})`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'reflect_change',
    {
      description: 'Generate or fetch a reflection entry for a change. Reflection estimates risk, boundary pressure, and historical similarity before code generation continues.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        changeId: z.string().optional().describe('Commit SHA or change entry id. If omitted, reflects the latest indexed change.'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, changeId, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await enforceCognitionPipeline(root, qdrantUrl);
      const snapshot = await loadArchitectureAsync(root) ?? await refreshArchitectureAsync(root);
      if (!snapshot) {
        return { content: [{ type: 'text', text: 'Project not indexed. Run index_project first.' }] };
      }

      const reflection = changeId ? await reflectChangeAsync(root, changeId) : await reflectLatestChangeAsync(root);
      if (!reflection) {
        return { content: [{ type: 'text', text: 'No change found to reflect.' }] };
      }

      const failureLinks = (await reflectionFailuresForChangeAsync(root, reflection.changeId))
        .map(item => `${item.id} (${item.score.toFixed(2)})`)
        .join(', ');

      return {
        content: [{
          type: 'text',
          text: [
            `Change: ${reflection.changeId}`,
            `Summary: ${reflection.summary}`,
            `Risk level: ${reflection.riskLevel}`,
            `Coupling delta: ${reflection.couplingDelta.toFixed(3)}`,
            `Confidence: ${reflection.confidence.toFixed(3)}`,
            `Affected modules: ${reflection.affectedModules.join(', ') || 'none'}`,
            `Architecture violations: ${reflection.architectureViolations.join(', ') || 'none'}`,
            `Historical similarity: ${reflection.historicalSimilarity.join(', ') || 'none'}`,
            `Similar failures: ${failureLinks || 'none'}`,
          ].join('\n'),
        }],
      };
    }
  );

  server.registerTool(
    'regression_risk',
    {
      description: 'Estimate regression risk for a target symbol, file, or module using instability and bug-history overlap.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        target: z.string().describe('Target symbol, module, or file path to score for regression risk.'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, target, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await enforceCognitionPipeline(root, qdrantUrl);
      const report = await regressionRiskAsync(root, target);
      return {
        content: [{
          type: 'text',
          text: [
            `Target: ${report.target}`,
            `Risk score: ${report.score.toFixed(3)}`,
            `Risk level: ${report.level}`,
            `Signals: ${report.signals.join(', ')}`,
            `Unstable modules: ${report.unstableModules.map(item => `${item.module} (${item.instability.toFixed(2)})`).join(', ') || 'none'}`,
            `Recent similar failures: ${report.recentFailures.map(item => `${item.id} (${item.score.toFixed(2)})`).join(', ') || 'none'}`,
          ].join('\n'),
        }],
      };
    }
  );

  server.registerTool(
    'similar_failures',
    {
      description: 'Return historical bug-memory entries similar to a target area. Use before implementation planning to avoid repeating known failure patterns.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        target: z.string().describe('Target symbol, file, or topic to match against bug history.'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum number of failures to return (default: 10).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, target, limit = 10, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await enforceCognitionPipeline(root, qdrantUrl);
      const failures = await findSimilarFailuresAsync(root, target, limit);
      if (failures.length === 0) {
        return { content: [{ type: 'text', text: `No similar failures found for target "${target}".` }] };
      }

      const lines = failures.map(entry => [
        `${entry.timestamp} ${entry.fixedBySha.slice(0, 12)} ${entry.title}`,
        `Summary: ${entry.summary}`,
        `Topics: ${entry.topics.join(', ') || 'none'}`,
        `Symptoms: ${entry.symptoms.join(' | ') || 'none'}`,
        `Error signatures: ${entry.errorSignatures.join(' | ') || 'none'}`,
      ].join('\n')).join('\n\n---\n\n');

      return { content: [{ type: 'text', text: lines }] };
    }
  );

  server.registerTool(
    'failure_clusters',
    {
      description: 'Cluster historical failures by recurring engineering patterns such as dependency issues, boundary weakness, async hazards, cache faults, and module instability.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        limit: z.number().int().min(1).max(20).optional().describe('Maximum number of clusters to return (default: 8).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, limit = 8, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      await refreshFailureIntelligenceAsync(root);
      const clusters = await failureClustersAsync(root, limit);
      if (clusters.length === 0) {
        return { content: [{ type: 'text', text: 'No failure clusters available. Run index_project after bug-memory data exists.' }] };
      }

      const text = clusters.map(cluster => [
        `${cluster.label} (${cluster.key})`,
        `Count: ${cluster.count}`,
        `Recent examples: ${cluster.failures.slice(0, 5).map(item => `${item.fixedBySha.slice(0, 12)} ${item.title}`).join(' | ') || 'none'}`,
      ].join('\n')).join('\n\n---\n\n');

      return { content: [{ type: 'text', text }] };
    }
  );

  server.registerTool(
    'root_cause_history',
    {
      description: 'Return causal failure history for a target symbol/file/topic, including symptoms, root causes, triggers, affected boundaries, and preventive patterns.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        target: z.string().describe('Symbol, file, module, or topic target used to match failure history.'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum number of root-cause entries to return (default: 10).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, target, limit = 10, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      await refreshFailureIntelligenceAsync(root);
      const history = await rootCauseHistoryAsync(root, target, limit);
      if (history.length === 0) {
        return { content: [{ type: 'text', text: `No root-cause history found for target "${target}".` }] };
      }

      const text = history.map(entry => [
        `${entry.timestamp} ${entry.fixedBySha.slice(0, 12)} ${entry.title}`,
        `Summary: ${entry.summary}`,
        `Root causes: ${entry.rootCauses.join(' | ') || 'none'}`,
        `Trigger conditions: ${entry.triggerConditions.join(' | ') || 'none'}`,
        `Affected boundaries: ${entry.affectedBoundaries.join(' | ') || 'none'}`,
        `Symptoms: ${entry.symptoms.join(' | ') || 'none'}`,
        `Preventive patterns: ${entry.preventivePatterns.join(' | ') || 'none'}`,
        `Related failures: ${entry.relatedFailures.join(', ') || 'none'}`,
      ].join('\n')).join('\n\n---\n\n');

      return { content: [{ type: 'text', text }] };
    }
  );

  server.registerTool(
    'historical_regressions',
    {
      description: 'List likely historical regressions, optionally scoped to a target area, based on recurring related failures and unstable-module involvement.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        target: z.string().optional().describe('Optional symbol/file/topic filter.'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum number of regressions to return (default: 10).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, target, limit = 10, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      await refreshFailureIntelligenceAsync(root);
      const regressions = await historicalRegressionsAsync(root, target, limit);
      if (regressions.length === 0) {
        return { content: [{ type: 'text', text: target ? `No historical regressions found for target "${target}".` : 'No historical regressions found.' }] };
      }

      const text = regressions.map(entry => [
        `${entry.timestamp} ${entry.fixedBySha.slice(0, 12)} ${entry.title}`,
        `Summary: ${entry.summary}`,
        `Cluster keys: ${entry.clusterKeys.join(', ') || 'none'}`,
        `Root causes: ${entry.rootCauses.join(' | ') || 'none'}`,
        `Related failures: ${entry.relatedFailures.join(', ') || 'none'}`,
      ].join('\n')).join('\n\n---\n\n');

      return { content: [{ type: 'text', text }] };
    }
  );

  server.registerTool(
    'validate_architecture',
    {
      description: 'Run architecture constraints and return a validation snapshot for circular dependencies, unstable imports, forbidden coupling, DTO leakage, and layer bypassing.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      const snapshot = await validateArchitectureAsync(root);
      const bySeverity = snapshot.violations.reduce<Record<string, number>>((acc, item) => {
        acc[item.severity] = (acc[item.severity] ?? 0) + 1;
        return acc;
      }, {});

      const lines = [
        `Validation generated: ${snapshot.generatedAt}`,
        `Rules: ${snapshot.rules.length}`,
        `Violations: ${snapshot.violations.length}`,
        `Severity counts: high=${bySeverity['high'] ?? 0}, medium=${bySeverity['medium'] ?? 0}, low=${bySeverity['low'] ?? 0}`,
      ];

      if (snapshot.violations.length > 0) {
        lines.push('');
        lines.push('Top violations:');
        lines.push(...snapshot.violations.slice(0, 10).map(item => `[${item.severity}] ${item.rule} :: ${item.details}`));
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'constraint_violations',
    {
      description: 'List architecture constraint violations, optionally filtered by severity.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        severity: z.enum(['low', 'medium', 'high']).optional().describe('Optional severity filter.'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of violations to return (default: 20).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, severity, limit = 20, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      const violations = await listConstraintViolationsAsync(root, { severity, limit });
      if (violations.length === 0) {
        return { content: [{ type: 'text', text: 'No matching constraint violations found.' }] };
      }

      const text = violations
        .map(item => `[${item.severity}] ${item.rule}\n${item.details}\nModules: ${item.modules.join(' -> ') || 'none'}`)
        .join('\n\n---\n\n');

      return { content: [{ type: 'text', text }] };
    }
  );

  server.registerTool(
    'boundary_analysis',
    {
      description: 'Analyze module boundary pressure using inbound/outbound dependency counts, instability, and coupling.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        module: z.string().optional().describe('Optional module filter, e.g. "src/cognition" or "src/indexer".'),
      },
    },
    async ({ projectRoot, module }) => {
      const root = path.resolve(projectRoot);
      const analysis = await boundaryAnalysisAsync(root, module);
      if (analysis.length === 0) {
        return { content: [{ type: 'text', text: module ? `No boundary analysis data found for module filter "${module}".` : 'No boundary analysis data found.' }] };
      }

      const lines = analysis.map(item => `${item.module}: inbound ${item.inbound}, outbound ${item.outbound}, instability ${item.instability.toFixed(2)}, coupling ${item.coupling.toFixed(2)}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'architecture_drift',
    {
      description: 'Track architecture drift over time by comparing module instability, coupling, and risk deltas across evolution snapshots.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        limit: z.number().int().min(1).max(30).optional().describe('Maximum number of drift records to return (default: 10).'),
        refresh: z.boolean().optional().describe('Recompute evolution snapshot before reading drift data (default: true).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, limit = 10, refresh = true, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      if (refresh) await refreshEvolutionAsync(root);
      const drift = await architectureDriftAsync(root, limit);
      if (drift.length === 0) {
        return { content: [{ type: 'text', text: 'No architecture drift data yet. Run index_project multiple times as the repository evolves.' }] };
      }

      const lines = drift.map(item => `${item.module}: instability ${item.instabilityDelta >= 0 ? '+' : ''}${item.instabilityDelta.toFixed(3)}, coupling ${item.couplingDelta >= 0 ? '+' : ''}${item.couplingDelta.toFixed(3)}, risk ${item.riskDelta >= 0 ? '+' : ''}${item.riskDelta.toFixed(3)}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'hotspot_analysis',
    {
      description: 'Return temporal hotspots ranked by composite risk from instability, coupling, bug recurrence, and churn.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        limit: z.number().int().min(1).max(30).optional().describe('Maximum number of hotspots to return (default: 10).'),
        topic: z.string().optional().describe('Optional module/topic filter.'),
        refresh: z.boolean().optional().describe('Recompute evolution snapshot before reading hotspot data (default: true).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, limit = 10, topic, refresh = true, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      if (refresh) await refreshEvolutionAsync(root);
      const hotspots = await hotspotAnalysisAsync(root, limit, topic);
      if (hotspots.length === 0) {
        return { content: [{ type: 'text', text: topic ? `No hotspots found for topic "${topic}".` : 'No hotspots found.' }] };
      }

      const lines = hotspots.map(item => `${item.module}: risk ${item.riskScore.toFixed(3)}, churn ${item.churn}, bugs ${item.bugs}, instability ${item.instability.toFixed(2)}, coupling ${item.coupling.toFixed(2)}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'instability_timeline',
    {
      description: 'Show instability trend points for a module over time, including coupling, bug count, churn, and risk at each point.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        module: z.string().describe('Exact or partial module name, e.g. "src/cognition".'),
        points: z.number().int().min(1).max(30).optional().describe('Number of recent timeline points to return (default: 12).'),
        refresh: z.boolean().optional().describe('Recompute evolution snapshot before reading timeline data (default: true).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, module, points = 12, refresh = true, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      if (refresh) await refreshEvolutionAsync(root);
      const timeline = await instabilityTimelineAsync(root, module, points);
      if (timeline.length === 0) {
        return { content: [{ type: 'text', text: `No instability timeline found for module filter "${module}".` }] };
      }

      const lines = timeline.map(point => `${point.at}: instability ${point.instability.toFixed(3)}, coupling ${point.coupling.toFixed(3)}, bugs ${point.bugs}, churn ${point.churn}, risk ${point.risk.toFixed(3)}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'memory_health',
    {
      description: 'Report governance health of long-lived memory, including stale entry count, contradiction count, and average confidence.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        refresh: z.boolean().optional().describe('Recompute memory governance snapshot before reporting (default: true).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, refresh = true, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      if (refresh) await refreshMemoryGovernanceAsync(root);
      const health = await memoryHealthAsync(root);
      const lines = [
        `Total entries: ${health.totalEntries}`,
        `Stale entries: ${health.staleEntries}`,
        `Contradicted entries: ${health.contradictedEntries}`,
        `Average confidence: ${health.averageConfidence.toFixed(3)}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'contradiction_report',
    {
      description: 'List memory entries with detected contradictions against architecture/failure evidence.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of contradictory entries to return (default: 20).'),
        refresh: z.boolean().optional().describe('Recompute memory governance snapshot before reporting (default: true).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, limit = 20, refresh = true, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      if (refresh) await refreshMemoryGovernanceAsync(root);
      const entries = await contradictionReportAsync(root, limit);
      if (entries.length === 0) {
        return { content: [{ type: 'text', text: 'No memory contradictions detected.' }] };
      }

      const text = entries
        .map(entry => `${entry.id}\nkind=${entry.kind}, confidence=${entry.confidence.toFixed(3)}, decay=${entry.decayScore.toFixed(3)}\ncontradictions: ${entry.contradictions.join(' | ')}`)
        .join('\n\n---\n\n');
      return { content: [{ type: 'text', text }] };
    }
  );

  server.registerTool(
    'stale_memory',
    {
      description: 'List stale memory entries that should be revalidated due to age-related decay or low confidence.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of stale entries to return (default: 20).'),
        refresh: z.boolean().optional().describe('Recompute memory governance snapshot before reporting (default: true).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, limit = 20, refresh = true, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      if (refresh) await refreshMemoryGovernanceAsync(root);
      const entries = await staleMemoryAsync(root, limit);
      if (entries.length === 0) {
        return { content: [{ type: 'text', text: 'No stale memory entries found.' }] };
      }

      const text = entries
        .map(entry => `${entry.id}\nkind=${entry.kind}, confidence=${entry.confidence.toFixed(3)}, decay=${entry.decayScore.toFixed(3)}\nlastValidatedAt=${entry.lastValidatedAt}`)
        .join('\n\n---\n\n');
      return { content: [{ type: 'text', text }] };
    }
  );

  server.registerTool(
    'cognition_gate',
    {
      description: 'Run a single pre-generation cognition pass: architecture, risk, failures, constraints, temporal hotspots, and memory governance. Use this as an agent gate before editing code.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        target: z.string().optional().describe('Optional symbol/file/module target for focused risk and failure lookup.'),
        topic: z.string().optional().describe('Optional subsystem/topic filter used for hotspot and failure narrowing.'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, target, topic, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);

      const architecture = await refreshArchitectureAsync(root);
      const constraints = await validateArchitectureAsync(root);
      await refreshFailureIntelligenceAsync(root);
      await refreshEvolutionAsync(root);
      await refreshMemoryGovernanceAsync(root);

      const focusedTarget = target ?? topic ?? architecture?.modules[0]?.name ?? 'project';
      const risk = await regressionRiskAsync(root, focusedTarget);
      const failures = (topic
        ? await findSimilarFailuresAsync(root, topic, 5)
        : await findSimilarFailuresAsync(root, focusedTarget, 5));
      const hotspots = await hotspotAnalysisAsync(root, 5, topic);
      const drift = await architectureDriftAsync(root, 5);
      const memory = await memoryHealthAsync(root);

      const lines = [
        `Gate target: ${focusedTarget}`,
        architecture
          ? `Architecture: ${architecture.modules.length} modules, ${architecture.dependencies.length} dependencies`
          : 'Architecture: unavailable',
        `Constraint violations: ${constraints.violations.length}`,
        `Regression risk: ${risk.score.toFixed(3)} (${risk.level})`,
        `Risk signals: ${risk.signals.join(', ')}`,
        `Similar failures: ${failures.length}`,
        `Temporal hotspots: ${hotspots.map(item => `${item.module} (${item.riskScore.toFixed(2)})`).join(', ') || 'none'}`,
        `Architecture drift: ${drift.map(item => `${item.module} (${item.riskDelta >= 0 ? '+' : ''}${item.riskDelta.toFixed(2)})`).join(', ') || 'none'}`,
        `Memory health: stale=${memory.staleEntries}, contradicted=${memory.contradictedEntries}, avgConfidence=${memory.averageConfidence.toFixed(3)}`,
        '',
        '**Recommended Next MCP Calls**',
        '1) constraint_violations (inspect violations before planning)',
        '2) root_cause_history (if risk is medium/high)',
        '3) architecture_overview or dependency_path (confirm boundary-safe plan)',
        '4) reflect_change after edits',
      ];

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'generate_project_brief',
    {
      description: 'Generate a compact agent onboarding brief (CLAUDE.md-style) from cognition snapshots and project memory.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      const brief = await generateProjectBrief(root, qdrantUrl);
      return { content: [{ type: 'text', text: brief }] };
    }
  );

  server.registerTool(
    'cognition_diff',
    {
      description: 'Return a compact cognition-state delta summary for the current branch snapshots, including indexed freshness and current risk counters.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
      },
    },
    async ({ projectRoot }) => {
      const root = path.resolve(projectRoot);
      const diff = await cognitionDiff(root);
      return {
        content: [{
          type: 'text',
          text: [
            `Generated: ${diff.generatedAt}`,
            `Branch: ${diff.branch ?? 'n/a'}`,
            `Indexed at: ${diff.indexedAt ?? 'unknown'}`,
            `Critical attention modules: ${diff.attentionCritical}`,
            `Constraint violations: ${diff.constraints}`,
            `Stale memory entries: ${diff.staleMemory}`,
            `Top hotspots: ${diff.topHotspots.join(', ') || 'none'}`,
          ].join('\n'),
        }],
      };
    }
  );

  server.registerTool(
    'compare_branch_cognition',
    {
      description: 'Compare cognition snapshots between the current branch and a target branch to identify regressions in risk, attention, constraints, and stale memory.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        targetBranch: z.string().describe('Branch name to compare against, usually "main".'),
      },
    },
    async ({ projectRoot, targetBranch }) => {
      const root = path.resolve(projectRoot);
      const cmp = await compareBranchCognition(root, targetBranch);

      if (!cmp.current && !cmp.target) {
        return { content: [{ type: 'text', text: 'No branch-scoped cognition snapshots found for either branch.' }] };
      }

      const text = [
        `Current branch: ${cmp.currentBranch ?? 'n/a'}`,
        `Target branch: ${cmp.targetBranch}`,
        '',
        '**Current**',
        cmp.current
          ? `modules=${cmp.current.modules}, constraints=${cmp.current.constraints}, criticalAttention=${cmp.current.criticalAttention}, staleMemory=${cmp.current.staleMemory}`
          : 'no snapshot',
        '',
        '**Target**',
        cmp.target
          ? `modules=${cmp.target.modules}, constraints=${cmp.target.constraints}, criticalAttention=${cmp.target.criticalAttention}, staleMemory=${cmp.target.staleMemory}`
          : 'no snapshot',
        '',
        '**Delta (current-target)**',
        `modules=${cmp.deltas.modules >= 0 ? '+' : ''}${cmp.deltas.modules}`,
        `constraints=${cmp.deltas.constraints >= 0 ? '+' : ''}${cmp.deltas.constraints}`,
        `criticalAttention=${cmp.deltas.criticalAttention >= 0 ? '+' : ''}${cmp.deltas.criticalAttention}`,
        `staleMemory=${cmp.deltas.staleMemory >= 0 ? '+' : ''}${cmp.deltas.staleMemory}`,
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    }
  );

  server.registerTool(
    'git_semantic_change_graph',
    {
      description: 'Git-focused semantic change graph. Summarizes changed symbols (added/deleted/modified), usage impact (callers/callees), and compact risk signals from working tree, commit, or ref range.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        mode: z.enum(['working_tree', 'commit', 'range']).optional().describe('Source mode: working tree (default), single commit, or base..head range.'),
        commitSha: z.string().optional().describe('Required when mode=commit.'),
        baseRef: z.string().optional().describe('Required when mode=range. Example: main.'),
        headRef: z.string().optional().describe('Required when mode=range. Example: HEAD.'),
        limit: z.number().int().min(10).max(200).optional().describe('Maximum number of changed symbols to return (default: 80).'),
        includeNoise: z.boolean().optional().describe('Include low-signal noise symbols (`format_only`, `import_only`, `generated_like`). Default: false.'),
        format: z.enum(['text', 'json']).optional().describe('Output format (default: text).'),
      },
    },
    async ({ projectRoot, mode = 'working_tree', commitSha, baseRef, headRef, limit = 80, includeNoise = false, format = 'text' }) => {
      const root = path.resolve(projectRoot);
      const graph = await loadGraphAsync(path.join(getDataDir(root), 'graph.json'));

      const result = await buildGitSemanticChangeGraph(root, graph, {
        mode,
        commitSha,
        baseRef,
        headRef,
        limit,
        includeNoise,
      });

      if (format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      const lines = [
        `Mode: ${result.mode}`,
        `Source: ${result.sourceRef}`,
        `Target: ${result.targetRef}`,
        `Changed files: ${result.changedFiles}`,
        `Metadata: graphFreshness=${result.metadata.graphFreshness.status}(${result.metadata.graphFreshness.score.toFixed(2)};resolved=${result.metadata.graphFreshness.resolvedRatio.toFixed(2)}), memoryFreshness=${result.metadata.memoryFreshness.status}(${result.metadata.memoryFreshness.score.toFixed(2)}), fallbackRatio=${result.metadata.fallbackRatio.toFixed(2)}, unresolvedSymbolRatio=${result.metadata.unresolvedSymbolRatio.toFixed(2)}`,
        `Signals: added=${result.signals.addedSymbols}, deleted=${result.signals.deletedSymbols}, modified=${result.signals.modifiedSymbols}, signatureChanged=${result.signals.signatureChangedSymbols}, probableRenames=${result.signals.probableRenames}, probableMoves=${result.signals.probableMoves}, deletedStillReferenced=${result.signals.deletedStillReferenced}, likelyFalsePositiveDeletions=${result.signals.deletionLikelyFalsePositiveSymbols}, testImpacted=${result.signals.testImpactedSymbols}, usageDeltaComputed=${result.signals.usageDeltaComputedSymbols}, callerDeltaComputed=${result.signals.callerDeltaComputedSymbols}, callerDeltaSemantic=${result.signals.semanticCallerDeltaComputedSymbols}, callerDeltaInferred=${result.signals.inferredCallerDeltaComputedSymbols}, noisySymbols=${result.signals.noisySymbols}, filteredNoiseSymbols=${result.signals.filteredNoiseSymbols}`,
        '',
        '**Top Files by Symbol Change Count**',
        ...(result.topFiles.length > 0
          ? result.topFiles.map(item => `- ${item.file} [${item.status}] changedSymbols=${item.changedSymbolCount}`)
          : ['- none']),
        '',
        '**Changed Symbols**',
        ...(result.symbols.length > 0
          ? result.symbols.map(symbol => {
            const usage = `callers=${symbol.callers.length}, callees=${symbol.callees.length}, tests=${symbol.likelyTestCallers.length}`;
            const deletedRef = symbol.kind === 'deleted' && symbol.stillReferenced ? ' | stillReferenced=true' : '';
            const deletionCaveat = symbol.deletionLikelyFalsePositive ? ' | deletionLikelyFalsePositive=true' : '';
            const sig = symbol.signatureChanged ? ' | signatureChanged=true' : '';
            const sigDelta = symbol.signatureDelta
              ? ` | signatureDelta=+${symbol.signatureDelta.paramsAdded.length}/-${symbol.signatureDelta.paramsRemoved.length},returnTypeChanged=${symbol.signatureDelta.returnTypeChanged},visibilityChanged=${symbol.signatureDelta.visibilityChanged},asyncChanged=${symbol.signatureDelta.asyncChanged},staticChanged=${symbol.signatureDelta.staticChanged}`
              : '';
            const rename = symbol.probableRenameFrom
              ? ` | probableRenameFrom=${symbol.probableRenameFrom}`
              : (symbol.probableRenameTo ? ` | probableRenameTo=${symbol.probableRenameTo}` : '');
            const move = symbol.probableMoveFromFile ? ` | probableMoveFrom=${symbol.probableMoveFromFile}` : '';
            const renameConfidence = typeof symbol.renameConfidence === 'number'
              ? ` | renameConfidence=${symbol.renameConfidence.toFixed(2)}`
              : '';
            const moveConfidence = typeof symbol.moveConfidence === 'number'
              ? ` | moveConfidence=${symbol.moveConfidence.toFixed(2)}`
              : '';
            const noise = symbol.noiseTags.length > 0 ? ` | noise=${symbol.noiseTags.join(',')}` : '';
            const usageDelta = symbol.usageDelta
              ? ` | refsDelta=${symbol.usageDelta.delta >= 0 ? '+' : ''}${symbol.usageDelta.delta} (${symbol.usageDelta.beforeReferenceCount}->${symbol.usageDelta.afterReferenceCount})`
              : '';
            const callerDelta = symbol.callerDelta
              ? ` | callerDelta=+${symbol.callerDelta.addedCallers.length}/-${symbol.callerDelta.removedCallers.length}(${symbol.callerDelta.mode})`
              : '';
            const evidence = symbol.evidence.length > 0 ? ` | evidence=${symbol.evidence.join(',')}` : '';
            return `- ${symbol.symbol} (${symbol.kind}) @ ${symbol.file} [${symbol.status}] | confidence=${symbol.confidence}(${symbol.confidenceScore.toFixed(2)}) | ${usage}${usageDelta}${callerDelta}${sig}${sigDelta}${rename}${renameConfidence}${move}${moveConfidence}${deletedRef}${deletionCaveat}${noise}${evidence}`;
          })
          : ['- none']),
      ];

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'prepare_task_execution',
    {
      description: 'One-shot task kickoff endpoint that combines preflight change risk, assembled task context, and likely impacted tests.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        task: z.string().describe('Task description, for example "fix authentication session expiry bug".'),
        target: z.string().optional().describe('Optional symbol or file path for test impact, for example "AuthService.login" or "src/auth/service.ts".'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum tests to return (default: 20).'),
        format: z.enum(['text', 'json', 'signals']).optional().describe('Output format. Use signals for compact decision cues, json for full automation payload.'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, task, target, limit = 20, format = 'text', qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      const [preflight, context, testImpact] = await Promise.all([
        buildPreflightChanges(root, qdrantUrl),
        assembleTaskContext(root, task, qdrantUrl, Math.min(20, Math.max(3, limit))),
        target ? buildTestImpact(root, target, limit) : Promise.resolve({ target: target ?? '', tests: [] }),
      ]);

      const criticalAttentionTouched = preflight.entries.filter(entry => entry.attentionTier === 'CRITICAL').length;
      const highRegressionTouched = preflight.entries.filter(entry => entry.regressionLevel === 'high').length;
      const filesWithConstraintHits = preflight.entries.filter(entry => entry.violations.length > 0).length;
      const dominantModules = context.topModules.slice(0, 5).map(item => item.module);
      const topRiskFiles = preflight.entries
        .slice(0, 5)
        .map(entry => ({
          path: entry.path,
          status: entry.status,
          regressionLevel: entry.regressionLevel,
          regressionRisk: Number(entry.regressionRisk.toFixed(3)),
          attentionTier: entry.attentionTier,
          hasConstraintHit: entry.violations.length > 0,
        }));

      const signals = {
        task,
        generatedAt: new Date().toISOString(),
        changeSignals: {
          totalChangedFiles: preflight.totalChangedFiles,
          highRiskFiles: preflight.highRiskFiles,
          criticalAttentionTouched,
          highRegressionTouched,
          filesWithConstraintHits,
          hasHighRiskWork: preflight.highRiskFiles > 0,
        },
        contextSignals: {
          dominantModules,
          semanticSnippetCount: context.semanticCode.length,
          constraintCount: context.constraints.length,
          relatedBugCount: context.relatedBugs.length,
          memoryHitCount: context.memoryHits.length,
        },
        testSignals: target
          ? {
              target: testImpact.target,
              likelyTestCount: testImpact.tests.length,
              topTests: testImpact.tests.slice(0, 5).map(test => ({ file: test.file, score: test.score })),
            }
          : null,
        topRiskFiles,
      };

      if (format === 'signals') {
        return { content: [{ type: 'text', text: JSON.stringify(signals, null, 2) }] };
      }

      if (format === 'json') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              task,
              generatedAt: signals.generatedAt,
              signals,
              preflight,
              context,
              testImpact: target ? testImpact : null,
            }, null, 2),
          }],
        };
      }

      const text = [
        `Task: ${task}`,
        `Generated: ${signals.generatedAt}`,
        '',
        '**Signals**',
        `changed=${signals.changeSignals.totalChangedFiles}, highRisk=${signals.changeSignals.highRiskFiles}, criticalAttentionTouched=${signals.changeSignals.criticalAttentionTouched}, highRegressionTouched=${signals.changeSignals.highRegressionTouched}, constraintHitFiles=${signals.changeSignals.filesWithConstraintHits}`,
        `dominantModules=${signals.contextSignals.dominantModules.join(', ') || 'none'}`,
        target
          ? `testSignals=target:${signals.testSignals?.target}, likelyTests:${signals.testSignals?.likelyTestCount ?? 0}`
          : 'testSignals=skipped (no target provided)',
        '',
        '**Preflight**',
        `changed files=${preflight.totalChangedFiles}, high risk=${preflight.highRiskFiles}`,
        ...preflight.entries.slice(0, 8).map(entry =>
          `- ${entry.path} [${entry.status}] attention=${entry.attentionTier} risk=${entry.regressionLevel}(${entry.regressionRisk.toFixed(3)})`
        ),
        '',
        '**Context**',
        `top modules=${context.topModules.length}, semantic snippets=${context.semanticCode.length}, constraints=${context.constraints.length}, related bugs=${context.relatedBugs.length}`,
        ...context.topModules.slice(0, 6).map(item => `- ${item.module} (${item.tier}, ${item.score.toFixed(3)})`),
      ].join('\n');

      const withTests = target
        ? [
            text,
            '',
            '**Test Impact**',
            `target=${testImpact.target}`,
            `likely tests=${testImpact.tests.length}`,
            ...(testImpact.tests.slice(0, 10).map(test =>
              `- ${test.file} (score ${test.score}) | reasons: ${test.reasons.join('; ') || 'none'}`
            )),
          ].join('\n')
        : [text, '', '**Test Impact**', 'skipped (no target provided)'].join('\n');

      return { content: [{ type: 'text', text: withTests }] };
    }
  );

  server.registerTool(
    'project_intent_snapshot',
    {
      description: 'Generate a structured project-understanding snapshot with explicit evidence tiers (code-verified, architecture-inferred, doc-derived, memory-derived). Use this for project purpose/philosophy/pattern understanding with confidence transparency.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
        format: z.enum(['text', 'json']).optional().describe('Output format (default: text).'),
      },
    },
    async ({ projectRoot, qdrantUrl = 'http://localhost:6333', format = 'text' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      const snapshot = await buildProjectIntentSnapshot(root);
      if (!snapshot) {
        return { content: [{ type: 'text', text: 'Project not indexed. Run index_project first.' }] };
      }
      if (format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }] };
      }
      return { content: [{ type: 'text', text: renderProjectIntentSnapshot(snapshot) }] };
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
      const entries = await listRecentChangesAsync(root, { limit, type, topic });
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
      const entries = await listRecentBugsAsync(root, { limit, topic });
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
      const featureMap = await getFeatureMapAsync(root);
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
      const graph = await loadGraphAsync(path.join(getDataDir(root), 'graph.json'));
      if (!graph) {
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
      try {
        await syncProjectMemory(root, qdrantUrl);
        const analysis = await getAffectedSymbolsInsight(root, seeds, { hops, direction, limit });
        if (!analysis) {
          return { content: [{ type: 'text', text: 'Project not indexed. Run index_project first.' }] };
        }
        return { content: [{ type: 'text', text: renderAffectedSymbolsInsight(analysis) }] };
      } catch (error) {
        if (isQdrantUnavailableError(error)) return qdrantUnavailableResponse(qdrantUrl);
        throw error;
      }
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
        sortBy: z.enum(['risk', 'churn', 'connectivity']).optional().describe("Sort hotspots by composite risk, raw churn, or graph connectivity. 'connectivity' automatically excludes sink nodes (inbound = 0)."),
        excludeSinkNodes: z.boolean().optional().describe('Exclude symbols/files with zero inbound dependents from the results (default: true when sortBy=connectivity, false otherwise).'),
        format: z.enum(['text', 'json']).optional().describe('Output format. Use json for structured dependents, test-gap, and impact-surface metadata (default: text).'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, limit = 10, topic, sortBy, excludeSinkNodes, format = 'text', qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      await syncProjectMemory(root, qdrantUrl);
      try {
        const hotspots = await getRiskHotspotsInsight(root, { limit, topic, sortBy, excludeSinkNodes });
        if (!hotspots) {
          return { content: [{ type: 'text', text: 'Project not indexed. Run index_project first.' }] };
        }
        if (format === 'json') {
          return { content: [{ type: 'text', text: JSON.stringify(hotspots, null, 2) }] };
        }
        return { content: [{ type: 'text', text: renderRiskHotspotsInsight(hotspots) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : '';
        mcpLog('error', `risk_hotspots failed: ${message}`, { topic, stack });
        return {
          content: [{ type: 'text', text: `risk_hotspots failed: ${message}\n${stack ?? ''}` }],
          isError: true,
        };
      }
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
      const result = await getWhyChangedAsync(root, { target, mode, topic, limit });
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
      const result = await getBugBriefAsync(root, { target, mode, topic, limit });
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
      try {
        const graph = await loadGraphAsync(path.join(getDataDir(root), 'graph.json'));
        const qdrant = new QdrantClient({ url: qdrantUrl });
        const collection = await resolveActiveCollectionAsync(qdrant, root, 'code');

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

        const output = await Promise.all(points.map(p => renderIndexedSymbol(root, graph, symbol, p)));

        return { content: [{ type: 'text', text: output.join('\n\n---\n\n') }] };
      } catch (error) {
        if (isQdrantUnavailableError(error)) return qdrantUnavailableResponse(qdrantUrl);
        throw error;
      }
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
      try {
        const graph = await loadGraphAsync(path.join(getDataDir(root), 'graph.json'));
        const qdrant = new QdrantClient({ url: qdrantUrl });
        const collection = await resolveActiveCollectionAsync(qdrant, root, 'code');

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
            sections.push(await renderIndexedSymbol(root, graph, sym, p));
          }
        }

        if (notFound.length) {
          sections.push(`**Not found:** ${notFound.join(', ')}`);
        }

        return { content: [{ type: 'text', text: sections.join('\n\n---\n\n') }] };
      } catch (error) {
        if (isQdrantUnavailableError(error)) return qdrantUnavailableResponse(qdrantUrl);
        throw error;
      }
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
      try {
        const graph = await loadGraphAsync(path.join(getDataDir(root), 'graph.json'));

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
      const collection = await resolveActiveCollectionAsync(qdrant, root, 'code');
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
          sections.push(await renderIndexedSymbol(root, graph, ref, pointMap.get(ref)?.[0]));
        }
      }

      return { content: [{ type: 'text', text: sections.join('\n\n') }] };
      } catch (error) {
        if (isQdrantUnavailableError(error)) return qdrantUnavailableResponse(qdrantUrl);
        throw error;
      }
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
      try {
        const graph = await loadGraphAsync(path.join(getDataDir(root), 'graph.json'));

        if (!graph) {
          return { content: [{ type: 'text', text: 'Project not indexed. Run index_project first.' }] };
        }

        const implementations = graph.implementations?.[symbol] ?? [];
        if (implementations.length === 0) {
          return { content: [{ type: 'text', text: `No implementations found for "${symbol}".` }] };
        }

        const shownSymbols = implementations.slice(0, limit);
        const qdrant = new QdrantClient({ url: qdrantUrl });
        const collection = await resolveActiveCollectionAsync(qdrant, root, 'code');
        const pointMap = groupPointsBySymbol(await scrollSymbolPoints(qdrant, collection, shownSymbols));

        const sections: string[] = [
          `**Implementations of ${symbol}**`,
          graph.symbolFile[symbol] ? `Declared in: ${graph.symbolFile[symbol]}` : '',
          `Known implementations: ${implementations.length}`,
          shownSymbols.length < implementations.length ? `Showing first ${shownSymbols.length} implementations.` : '',
        ].filter(Boolean);

        for (const implementation of shownSymbols) {
          sections.push(await renderIndexedSymbol(root, graph, implementation, pointMap.get(implementation)?.[0]));
        }

        return { content: [{ type: 'text', text: sections.join('\n\n') }] };
      } catch (error) {
        if (isQdrantUnavailableError(error)) return qdrantUnavailableResponse(qdrantUrl);
        throw error;
      }
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
      try {
        const graph = await loadGraphAsync(path.join(getDataDir(root), 'graph.json'));

        if (!graph) {
          return { content: [{ type: 'text', text: 'Project not indexed. Run index_project first.' }] };
        }

        // BFS expansion (shared utility)
        const { discovered, capped } = expandGraphBfs(graph, seeds, hops, direction);
        const symbolList = [...discovered].slice(0, 60);

        const qdrant = new QdrantClient({ url: qdrantUrl });
        const collection = await resolveActiveCollectionAsync(qdrant, root, 'code');

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
          sections.push(await renderIndexedSymbol(root, graph, sym, p));
        }

        return { content: [{ type: 'text', text: sections.join('\n\n') }] };
      } catch (error) {
        if (isQdrantUnavailableError(error)) return qdrantUnavailableResponse(qdrantUrl);
        throw error;
      }
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
      const graph = await loadGraphAsync(path.join(getDataDir(root), 'graph.json'));

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
      try {
        const qdrant = new QdrantClient({ url: qdrantUrl });
        const collection = await resolveActiveCollectionAsync(qdrant, root, 'code');

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

        const graph = await loadGraphAsync(path.join(getDataDir(root), 'graph.json'));
        const output = await Promise.all(points.map(p => renderIndexedSymbol(root, graph, p.payload!['symbol'] as string, p)));

        return { content: [{ type: 'text', text: output.join('\n\n---\n\n') }] };
      } catch (error) {
        if (isQdrantUnavailableError(error)) return qdrantUnavailableResponse(qdrantUrl);
        throw error;
      }
    }
  );

  // --- find_existing ---
  server.registerTool(
    'find_existing',
    {
      description: 'CALL THIS BEFORE WRITING ANY NEW CODE. Searches the indexed codebase for symbols that already implement what you are about to create. Returns a MATCH_FOUND / PARTIAL_MATCH / SAFE_TO_CREATE verdict so you know whether to extend existing code or create something new. Prevents duplicate implementations. Required first step in any code-generation workflow.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        description: z.string().describe('Plain-language description of what you are about to implement, e.g. "a function that validates email addresses" or "an HTTP retry wrapper with exponential backoff".'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
        limit: z.number().optional().describe('Maximum number of matches to return (default: 6).'),
      },
    },
    async ({ projectRoot, description, qdrantUrl = 'http://localhost:6333', limit = 6 }) => {
      const result = await findExisting(path.resolve(projectRoot), description, qdrantUrl, limit);
      return { content: [{ type: 'text', text: renderFindExisting(result) }] };
    }
  );

  // --- where_should_this_live ---
  server.registerTool(
    'where_should_this_live',
    {
      description: 'Recommends the best module(s) for placing new code. Call this after find_existing returns SAFE_TO_CREATE and before writing the new code. Scores candidate modules by semantic relatedness, architectural instability, coupling, and active constraint rules. Prevents architectural drift caused by placing code in the wrong layer or module.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        description: z.string().describe('Plain-language description of the new capability to add, e.g. "rate limiting middleware for API routes" or "a service that computes churn scores for modules".'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
        topN: z.number().optional().describe('Number of module recommendations to return (default: 3).'),
      },
    },
    async ({ projectRoot, description, qdrantUrl = 'http://localhost:6333', topN = 3 }) => {
      const result = await whereShouldThisLive(path.resolve(projectRoot), description, qdrantUrl, topN);
      return { content: [{ type: 'text', text: renderPlacementOracle(result) }] };
    }
  );

  // --- validate_intent ---
  server.registerTool(
    'validate_intent',
    {
      description: 'Checks whether a proposed change aligns with the documented project intent, active git topics, and feature map. Returns a HIGH / MEDIUM / LOW alignment verdict and a plain-language explanation. Call before implementing any significant new capability to catch scope creep or drift from the project\'s core domain before it starts.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        description: z.string().describe('Plain-language description of the proposed change or feature, e.g. "add a newsletter subscription system" or "add rate limiting to the auth endpoints".'),
      },
    },
    async ({ projectRoot, description }) => {
      const result = await validateIntent(path.resolve(projectRoot), description);
      return { content: [{ type: 'text', text: renderIntentValidation(result) }] };
    }
  );

  // --- validate_generated_code ---
  server.registerTool(
    'validate_generated_code',
    {
      description: 'Post-generation gate: validates generated code before committing. Checks for (1) likely duplicate symbols vs the indexed codebase, (2) import statements that would trigger architectural constraint violations, and (3) naming inconsistencies against the target module\'s conventions. Returns PASS / WARN / BLOCK verdict. Call after generating code, before writing it to disk.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        code: z.string().describe('The generated code string to validate.'),
        targetFile: z.string().optional().describe('Intended file path (relative to project root) where the code will be written. Used for module-aware constraint and naming checks.'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, code, targetFile, qdrantUrl = 'http://localhost:6333' }) => {
      const result = await validateGeneratedCode(path.resolve(projectRoot), code, targetFile, qdrantUrl);
      return { content: [{ type: 'text', text: renderCodeValidation(result) }] };
    }
  );

  // --- module_conventions ---
  server.registerTool(
    'module_conventions',
    {
      description: 'Returns a per-module style guide extracted from the indexed codebase: dominant function-name prefixes, async conventions, error-handling style, and export patterns. Call before writing new code for an existing module so the new code follows established conventions rather than introducing inconsistent patterns.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        module: z.string().describe('Module name as it appears in the architecture (e.g. "src/auth", "src/cognition", "packages/admin"). Use get_overview or project_status to find module names.'),
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, module: moduleName, qdrantUrl = 'http://localhost:6333' }) => {
      const conventions = await getModuleConventions(path.resolve(projectRoot), moduleName, qdrantUrl);
      if (!conventions) {
        return { content: [{ type: 'text', text: `No indexed symbols found for module "${moduleName}". Check the module name with get_overview or project_status.` }] };
      }
      return { content: [{ type: 'text', text: renderModuleConventions(conventions) }] };
    }
  );

  // --- repo_map ---
  server.registerTool(
    'repo_map',
    {
      description: 'Generate an aider-style repo map: a compact file→symbol→signature overview of the codebase ranked by call-graph PageRank. Optionally focus the map on seed symbols or file paths. Use this to get a high-level orientation of a project before diving into code.',
      inputSchema: {
        projectRoot: z.string().describe(PROJECT_ROOT_DESC),
        seeds: z.array(z.string()).optional().describe('Optional seed symbols or file paths to focus ranking on. Symbols near seeds will score higher.'),
        maxLines: z.number().optional().describe('Maximum output lines (default: 1000). Lower for a tighter map.'),
        includeMethods: z.boolean().optional().describe('Whether to include class methods (default: true).'),
      },
    },
    async ({ projectRoot, seeds, maxLines, includeMethods }) => {
      const result = await buildRepoMap(path.resolve(projectRoot), {
        seeds: seeds ?? [],
        maxLines: maxLines ?? 1000,
        includeMethods: includeMethods !== false,
      });
      return { content: [{ type: 'text', text: renderRepoMap(result) }] };
    }
  );

  return server;
}

mcpLog('info', 'Starting code-intelligence MCP server', {
  mode: useHttp ? 'http' : 'stdio',
  httpPort: useHttp ? httpPort : undefined,
  logLevel: MCP_LOG_LEVEL,
  logDestination: MCP_LOG_DESTINATION,
  pid: process.pid,
});

if (useHttp) {
  // HTTP Streamable mode — persistent server VS Code connects to via URL.
  // A fresh McpServer is created per request (stateless: no session tracking).
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    mcpLog('info', 'HTTP request received', { method: req.method, url: req.url });
    if (req.url === '/mcp') {
      const body = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
      });
      const parsedBody = body.length > 0 ? JSON.parse(body.toString()) : undefined;
      if (MCP_LOG_LEVEL === 'debug') {
        mcpLog('debug', 'HTTP request body', parsedBody);
      }

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      mcpLog('info', 'HTTP request handled', { method: req.method, url: req.url, statusCode: res.statusCode });
    } else {
      mcpLog('warn', 'HTTP request rejected', { method: req.method, url: req.url, statusCode: 404 });
      res.writeHead(404).end();
    }
  });

  httpServer.listen(httpPort, () => {
    mcpLog('info', `code-intelligence MCP server listening on http://localhost:${httpPort}/mcp`);
  });
} else {
  // Stdio mode — spawned per-session by VS Code
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
  mcpLog('info', 'code-intelligence MCP server connected over stdio');
}
