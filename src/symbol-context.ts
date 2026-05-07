import type { GraphData } from './graph.js';
import type { RetrievedSliceFreshness } from './query-freshness.js';
import { getRetrievedSliceFreshness } from './query-freshness.js';

export interface IndexedSymbolPoint {
  payload?: Record<string, unknown> | null;
}

export interface SymbolNextCall {
  tool: 'why_changed' | 'bug_brief' | 'expand_graph' | 'analyze_impact' | 'get_file_chunks';
  reason: string;
}

export interface EnrichedSymbolContext {
  symbol: string;
  file: string;
  type: string;
  code: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  freshness: RetrievedSliceFreshness;
  graph: {
    calls: { total: number; symbols: string[]; sites: Array<{ symbol: string; file: string; line: number }> };
    usedBy: { total: number; symbols: string[]; sites: Array<{ symbol: string; file: string; line: number }> };
    supertypes: { total: number; symbols: string[] };
    subtypes: { total: number; symbols: string[] };
    implements: { total: number; symbols: string[] };
    implementedBy: { total: number; symbols: string[] };
  };
  nextCalls: SymbolNextCall[];
}

function summarizeRelation(values: string[], limit = 5): { total: number; symbols: string[] } {
  const unique = [...new Set(values)];
  return {
    total: unique.length,
    symbols: unique.slice(0, limit),
  };
}

function summarizeSites(
  values: Array<{ symbol: string; file: string; line: number }> | undefined,
  limit = 5
): Array<{ symbol: string; file: string; line: number }> {
  const entries = values ?? [];
  const seen = new Set<string>();
  const result: Array<{ symbol: string; file: string; line: number }> = [];
  for (const entry of entries) {
    const key = `${entry.symbol}::${entry.file}::${entry.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ symbol: entry.symbol, file: entry.file, line: entry.line });
    if (result.length >= limit) break;
  }
  return result;
}

function coerceString(payload: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === 'string' ? value : null;
}

function coerceNumber(payload: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = payload?.[key];
  return typeof value === 'number' ? value : null;
}

export function buildEnrichedSymbolContext(
  projectRoot: string,
  graph: GraphData | null,
  symbol: string,
  point?: IndexedSymbolPoint
): EnrichedSymbolContext {
  const payload = point?.payload ?? null;
  const file = coerceString(payload, 'file') ?? graph?.symbolFile?.[symbol] ?? '?';
  const type = coerceString(payload, 'type') ?? 'unknown';
  const code = coerceString(payload, 'code');
  const lineStart = coerceNumber(payload, 'lineStart');
  const lineEnd = coerceNumber(payload, 'lineEnd');

  const freshness = file !== '?'
    ? getRetrievedSliceFreshness(projectRoot, file, lineStart, lineEnd)
    : {
        sliceStartLine: lineStart,
        sliceEndLine: lineEnd,
        indexRefreshedAt: null,
        indexedFileMtimeMs: null,
        currentFileMtimeMs: null,
        latestChange: null,
        needsReindex: false,
        reasons: [],
      } satisfies RetrievedSliceFreshness;

  return {
    symbol,
    file,
    type,
    code,
    lineStart,
    lineEnd,
    freshness,
    graph: {
      calls: {
        ...summarizeRelation(graph?.symbols[symbol] ?? []),
        sites: summarizeSites(graph?.callSites?.[symbol]),
      },
      usedBy: {
        ...summarizeRelation(graph?.callers?.[symbol] ?? []),
        sites: summarizeSites(graph?.calledBySites?.[symbol]),
      },
      supertypes: summarizeRelation(graph?.supertypes?.[symbol] ?? []),
      subtypes: summarizeRelation(graph?.subtypes?.[symbol] ?? []),
      implements: summarizeRelation(graph?.implementedFrom?.[symbol] ?? []),
      implementedBy: summarizeRelation(graph?.implementations?.[symbol] ?? []),
    },
    nextCalls: [
      { tool: 'why_changed', reason: 'get recent rationale and matching changes for this symbol' },
      { tool: 'bug_brief', reason: 'check nearby bug history for this symbol or file' },
      { tool: 'expand_graph', reason: 'follow execution flow beyond the direct neighbors shown here' },
      { tool: 'analyze_impact', reason: 'rank the likely blast radius before editing' },
      { tool: 'get_file_chunks', reason: 'inspect the surrounding file around this slice' },
    ],
  };
}