import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs';
import { indexProject, queryProject } from './indexer-run.js';
import { loadGraph } from './graph.js';
import {
  getFeatureMap,
  getProjectMemoryCount,
  getProjectStatus,
  listRecentChanges,
  queryProjectMemory,
  renderFeatureMap,
  renderMemoryQueryResults,
  renderProjectStatus,
  renderRecentChanges,
  syncProjectMemory,
} from './project-memory.js';
import { QdrantClient } from '@qdrant/js-client-rest';
import { collectionName } from './embedder.js';
import { getDataDir, getCurrentBranch } from './git.js';

const PROJECT_ROOT_DESC = 'Absolute path to the project root. For git repositories, indexes and project memory are branch-scoped, so check status or re-index after switching branches.';
const QDRANT_URL_DESC = 'Qdrant server URL (default: http://localhost:6333). Use only if the local vector store is not running on the default port.';

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
        qdrantUrl: z.string().optional().describe(QDRANT_URL_DESC),
      },
    },
    async ({ projectRoot, question, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      const results = await queryProject(root, question, qdrantUrl);
      if (!results.length) {
        return { content: [{ type: 'text', text: 'No results found.' }] };
      }
      const graphPath = path.join(getDataDir(root), 'graph.json');
      const graph = loadGraph(graphPath);
      const output = results
        .map(r => {
          const label = r.score > 0 ? `score: ${r.score.toFixed(3)}` : 'related';
          const callees = graph?.symbols[r.symbol] ?? [];
          const callers = graph?.callers?.[r.symbol] ?? [];
          const graphParts = [
            callees.length ? `calls: ${callees.join(', ')}` : '',
            callers.length ? `calledBy: ${callers.join(', ')}` : '',
          ].filter(Boolean).join(' | ');
          return [
            `**File:** ${r.file}`,
            `**Symbol:** ${r.symbol} (${r.type}) [${label}]${graphParts ? ` — ${graphParts}` : ''}`,
            `\`\`\`\n${r.code}\n\`\`\``,
          ].join('\n');
        })
        .join('\n\n---\n\n');
      return { content: [{ type: 'text', text: output }] };
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

      const callees = graph?.symbols[symbol] ?? [];
      const callers = graph?.callers?.[symbol] ?? [];

      const output = points.map(p => {
        const file = p.payload!['file'] as string;
        const type = p.payload!['type'] as string;
        const code = p.payload!['code'] as string;
        return [
          `**File:** ${file}`,
          `**Type:** ${type}`,
          callees.length ? `**Calls (${callees.length}):** ${callees.join(', ')}` : '',
          callers.length ? `**Called by (${callers.length}):** ${callers.join(', ')}` : '',
          `\`\`\`\n${code}\n\`\`\``,
        ].filter(Boolean).join('\n');
      }).join('\n\n---\n\n');

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
        const callees = graph?.symbols[sym] ?? [];
        const callers = graph?.callers?.[sym] ?? [];
        for (const p of pts) {
          const file = p.payload!['file'] as string;
          const type = p.payload!['type'] as string;
          const code = p.payload!['code'] as string;
          sections.push([
            `**${sym}** (${type}) — ${file}`,
            callees.length ? `Calls (${callees.length}): ${callees.join(', ')}` : '',
            callers.length ? `Called by (${callers.length}): ${callers.join(', ')}` : '',
            `\`\`\`\n${code}\n\`\`\``,
          ].filter(Boolean).join('\n'));
        }
      }

      if (notFound.length) {
        sections.push(`**Not found:** ${notFound.join(', ')}`);
      }

      return { content: [{ type: 'text', text: sections.join('\n\n---\n\n') }] };
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
        const callees = graph.symbols[sym] ?? [];
        const callers = graph.callers?.[sym] ?? [];
        const file = p ? (p.payload!['file'] as string) : graph.symbolFile?.[sym] ?? '?';
        const type = p ? (p.payload!['type'] as string) : 'unknown';
        const code = p ? `\`\`\`\n${p.payload!['code'] as string}\n\`\`\`` : '*(code not in index)*';
        sections.push([
          `### ${sym} (${type}) — ${file}`,
          callees.length ? `→ calls: ${callees.join(', ')}` : '',
          callers.length ? `← calledBy: ${callers.join(', ')}` : '',
          code,
        ].filter(Boolean).join('\n'));
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
      const output = points.map(p => {
        const symbol = p.payload!['symbol'] as string;
        const type = p.payload!['type'] as string;
        const code = p.payload!['code'] as string;
        const callees = graph?.symbols[symbol] ?? [];
        const callers = graph?.callers?.[symbol] ?? [];
        return [
          `**${symbol}** (${type})`,
          callees.length ? `calls: ${callees.join(', ')}` : '',
          callers.length ? `calledBy: ${callers.join(', ')}` : '',
          `\`\`\`\n${code}\n\`\`\``,
        ].filter(Boolean).join('\n');
      }).join('\n\n---\n\n');

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
