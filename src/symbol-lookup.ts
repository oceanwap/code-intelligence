/**
 * Shared helpers for symbol lookup, graph expansion, and rendering.
 * Used by both CLI (src/cli.ts) and MCP server (src/mcp-server.ts).
 */
import { QdrantClient } from '@qdrant/js-client-rest';
import * as path from 'path';
import { resolveActiveCollectionAsync } from './embedder.js';
import { loadGraphAsync, type GraphData } from './graph.js';
import { getDataDir } from './git.js';
import { buildEnrichedSymbolContextAsync, type IndexedSymbolPoint } from './symbol-context.js';

export type { IndexedSymbolPoint };

// ─── Qdrant helpers ──────────────────────────────────────────────────────────

export async function scrollSymbolPoints(
  qdrant: QdrantClient,
  collection: string,
  symbols: string[],
): Promise<IndexedSymbolPoint[]> {
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
  return points as IndexedSymbolPoint[];
}

export function groupPointsBySymbol(points: IndexedSymbolPoint[]): Map<string, IndexedSymbolPoint[]> {
  const grouped = new Map<string, IndexedSymbolPoint[]>();
  for (const point of points) {
    const symbol = point.payload?.['symbol'];
    if (typeof symbol !== 'string') continue;
    if (!grouped.has(symbol)) grouped.set(symbol, []);
    grouped.get(symbol)!.push(point);
  }
  return grouped;
}

// ─── Symbol rendering ─────────────────────────────────────────────────────────

function formatLineRanges(ranges: Array<{ startLine: number; endLine: number }>): string {
  return ranges
    .map(range => range.startLine === range.endLine ? `${range.startLine}` : `${range.startLine}-${range.endLine}`)
    .join(', ');
}

function fmt(label: string, relation: { total: number; symbols: string[] } | undefined): string {
  if (!relation || relation.total === 0) return '';
  const suffix = relation.total > relation.symbols.length ? ', ...' : '';
  return `${label}: ${relation.total} (${relation.symbols.join(', ')}${suffix})`;
}

function fmtSites(label: string, relation: { sites: Array<{ symbol: string; file: string; line: number }> } | undefined): string {
  if (!relation || relation.sites.length === 0) return '';
  return `${label} places: ${relation.sites.map(site => `${site.symbol} @ ${site.file}:${site.line}`).join('; ')}`;
}

function fmtList(label: string, values: string[] | undefined): string {
  if (!values || values.length === 0) return '';
  return `${label}: ${values.join(', ')}`;
}

export async function renderSymbolText(
  projectRoot: string,
  graph: GraphData | null,
  symbol: string,
  point?: IndexedSymbolPoint,
): Promise<string> {
  const ctx = await buildEnrichedSymbolContextAsync(projectRoot, graph, symbol, point);
  const lines = [
    `Symbol: ${ctx.symbol} (${ctx.type}) — ${ctx.file}`,
    ctx.lineStart && ctx.lineEnd ? `Lines: ${ctx.lineStart}-${ctx.lineEnd}` : '',
    ctx.freshness.indexRefreshedAt ? `Slice index refreshed: ${ctx.freshness.indexRefreshedAt}` : '',
    ctx.freshness.latestChange
      ? `Latest slice change: ${ctx.freshness.latestChange.timestamp || 'unknown'} ${ctx.freshness.latestChange.sha.slice(0, 12)} ${ctx.freshness.latestChange.title}`
      : '',
    ctx.freshness.latestChange?.changedLines.length
      ? `Changed lines in slice: ${formatLineRanges(ctx.freshness.latestChange.changedLines)}`
      : '',
    ctx.freshness.reasons.length > 0
      ? `Freshness: re-index recommended (${ctx.freshness.reasons.join('; ')})`
      : '',
    fmt('Calls', ctx.graph.calls),
    fmtSites('Call', ctx.graph.calls),
    fmt('Used by', ctx.graph.usedBy),
    fmtSites('Used by', ctx.graph.usedBy),
    fmt('Supertypes', ctx.graph.supertypes),
    fmt('Subtypes', ctx.graph.subtypes),
    fmt('Implements', ctx.graph.implements),
    fmt('Implemented by', ctx.graph.implementedBy),
    fmtList('Recommended next calls', ctx.nextCalls.map(call => `${call.tool} (${call.reason})`)),
    ctx.code ? `\`\`\`\n${ctx.code}\n\`\`\`` : '(code not in index)',
  ].filter(Boolean);
  return [`${'─'.repeat(60)}`, ...lines, '─'.repeat(60)].join('\n');
}

// ─── Graph BFS expansion ──────────────────────────────────────────────────────

export interface GraphExpansionResult {
  discovered: Set<string>;
  capped: boolean;
}

export function expandGraphBfs(
  graph: GraphData,
  seeds: string[],
  hops: number,
  direction: 'out' | 'in' | 'both',
  cap = 60,
): GraphExpansionResult {
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

  const capped = discovered.size > cap;
  return { discovered, capped };
}

// ─── Convenience loaders ──────────────────────────────────────────────────────

export async function loadProjectGraph(projectRoot: string): Promise<GraphData | null> {
  return loadGraphAsync(path.join(getDataDir(projectRoot), 'graph.json'));
}

export async function makeProjectQdrantClient(projectRoot: string, qdrantUrl: string): Promise<{ client: QdrantClient; collection: string }> {
  const client = new QdrantClient({ url: qdrantUrl });
  const collection = await resolveActiveCollectionAsync(client, projectRoot, 'code');
  return { client, collection };
}
