import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs';
import { indexProject, queryProject } from './indexer-run.js';
import { loadGraph } from './graph.js';
import { QdrantClient } from '@qdrant/js-client-rest';
import { collectionName } from './embedder.js';
import { getDataDir, getCurrentBranch } from './git.js';

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'code-intelligence', version: '1.0.0' });

  server.registerTool(
    'index_project',
    {
      description: 'Parse and index a codebase using ts-morph AST. Stores embeddings in Qdrant and builds a dependency graph. Must be run before querying.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root to index'),
        qdrantUrl: z.string().optional().describe('Qdrant server URL (default: http://localhost:6333)'),
      },
    },
    async ({ projectRoot, qdrantUrl = 'http://localhost:6333' }) => {
      const root = path.resolve(projectRoot);
      const result = await indexProject(root, qdrantUrl);
      const lines = [
        `Indexed ${result.chunks} chunks from ${root}`,
        `Symbols in graph: ${result.symbols}`,
        `Files in graph: ${result.files}`,
      ];
      if (result.staleRemoved > 0) lines.push(`Removed ${result.staleRemoved} stale chunk(s)`);
      if (result.orphansRemoved > 0) lines.push(`Removed ${result.orphansRemoved} orphaned chunk(s)`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'query_project',
    {
      description: 'Search an indexed codebase with a natural language question. Returns relevant functions/classes with file paths and scores.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root (must be indexed first)'),
        question: z.string().describe('Natural language question about the codebase'),
        qdrantUrl: z.string().optional().describe('Qdrant server URL (default: http://localhost:6333)'),
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
      description: 'Check whether a project has been indexed and show stats (chunks, symbols, call graph edges). Call this before query_project to confirm the project is ready, or to decide if re-indexing is needed.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root'),
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
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // --- get_symbol ---
  server.registerTool(
    'get_symbol',
    {
      description: 'Retrieve the full source code and call graph context for a specific named symbol (function, class, or method). Returns code, file path, symbols it calls, and symbols that call it. Use after query_project to drill into a result, or when you know a symbol name.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root'),
        symbol: z.string().describe('Symbol name to look up, e.g. "handleRequest", "AuthService", "AuthService.login"'),
        qdrantUrl: z.string().optional().describe('Qdrant URL (default: http://localhost:6333)'),
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
      description: 'Retrieve source code and call graph context for multiple named symbols in a single call. Use instead of calling get_symbol repeatedly when you have a list of callees/callers to inspect. Returns code, file, calls, and calledBy for each symbol.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root'),
        symbols: z.array(z.string()).min(1).max(50).describe('Array of symbol names to look up, e.g. ["handleRequest", "AuthService.login"]'),
        qdrantUrl: z.string().optional().describe('Qdrant URL (default: http://localhost:6333)'),
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
      description: 'Given a set of seed symbols, return the full N-hop call subgraph with code for every reachable symbol — both outbound (callees) and inbound (callers). Use to understand an entire execution path or module boundary in one shot, instead of iterating get_symbol per node.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root'),
        seeds: z.array(z.string()).min(1).max(20).describe('Starting symbol names to expand from'),
        hops: z.number().int().min(1).max(3).optional().describe('How many hops to follow in each direction (default: 2)'),
        direction: z.enum(['out', 'in', 'both']).optional().describe('Follow outbound calls, inbound callers, or both (default: both)'),
        qdrantUrl: z.string().optional().describe('Qdrant URL (default: http://localhost:6333)'),
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
      description: 'List all indexed symbols (functions, classes, methods) grouped by file. Optionally filter by file path substring. Use to orient yourself in a codebase before querying, or to find all entry points in a module.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root'),
        fileFilter: z.string().optional().describe('Only show symbols from files whose path contains this string (e.g. "auth" or "src/api")'),
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
      description: 'Get all indexed chunks (functions, classes, methods) from a specific file. Use to see the full API surface of a file when you know its path.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root'),
        file: z.string().describe('Relative file path within the project root, e.g. "src/auth/service.ts"'),
        qdrantUrl: z.string().optional().describe('Qdrant URL (default: http://localhost:6333)'),
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
