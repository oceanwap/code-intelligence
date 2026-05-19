import { QdrantClient } from '@qdrant/js-client-rest';
import { loadGraphAsync, type GraphCallSite, type GraphData } from './graph.js';
import { collectionNameAsync, embedQuery } from './embedder.js';
import { getProjectMemoryEntriesAsync, type ProjectMemoryEntry } from './project-memory.js';
import { getRetrievedSliceFreshnessAsync, type RetrievedSliceFreshness } from './query-freshness.js';

const MAX_CHARS = 3000 * 4; // ~3000 tokens (1 token ≈ 4 chars)
const STRONG_SEMANTIC_SCORE = 0.5;
const STOP_WORDS = new Set([
  'the', 'how', 'what', 'where', 'does', 'get', 'set', 'use', 'for', 'with',
  'from', 'and', 'that', 'this', 'are', 'was', 'not', 'but', 'file', 'code',
  'function', 'class', 'method', 'feature', 'features', 'service', 'system',
  'logic', 'module', 'modules', 'works', 'work', 'about', 'using', 'into',
]);

export interface RetrievedChunk {
  file: string;
  symbol: string;
  type: string;
  code: string;
  lineStart?: number;
  lineEnd?: number;
  graphSummary?: {
    calls: { total: number; symbols: string[]; sites: Array<{ symbol: string; file: string; line: number }> };
    usedBy: { total: number; symbols: string[]; sites: Array<{ symbol: string; file: string; line: number }> };
    supertypes: { total: number; symbols: string[] };
    subtypes: { total: number; symbols: string[] };
    implements: { total: number; symbols: string[] };
    implementedBy: { total: number; symbols: string[] };
  };
  connectionsWithinResults?: {
    total: number;
    calls: string[];
    usedBy: string[];
    supertypes: string[];
    subtypes: string[];
    implements: string[];
    implementedBy: string[];
  };
  score: number;
  semanticScore?: number;
  rankingSignals?: string[];
  freshness?: RetrievedSliceFreshness;
  scoreBreakdown?: {
    semantic: number;
    symbolOverlap: number;
    fileOverlap: number;
    directMemory: number;
    neighborSupport: number;
    connectivity: number;
  };
}

export interface RetrievalPagination {
  page: number;
  pageSize: number;
  totalResults: number;
  totalPages: number;
  hasMore: boolean;
  nextPage: number | null;
  symbolIndexByPage: Array<{
    page: number;
    symbols: string[];
  }>;
}

export interface RetrievalResponse {
  results: RetrievedChunk[];
  pagination: RetrievalPagination;
}

export type RetrievalMode = 'default' | 'architecture';

export class MissingCodeIndexError extends Error {
  collection: string;
  qdrantUrl: string;

  constructor(collection: string, qdrantUrl: string) {
    super(`Code index collection "${collection}" does not exist on ${qdrantUrl}`);
    this.name = 'MissingCodeIndexError';
    this.collection = collection;
    this.qdrantUrl = qdrantUrl;
  }
}

function isQdrantCollectionNotFound(error: unknown): boolean {
  const candidate = error as {
    status?: number;
    message?: string;
    data?: { status?: { error?: string } };
  };
  const detail = `${candidate.message ?? ''}\n${candidate.data?.status?.error ?? ''}`.toLowerCase();
  return candidate.status === 404
    && (detail.includes('collection')
      || detail.includes('/collections/')
      || detail.includes('not found'));
}

function normalizeSemanticThreshold(value: number | undefined): number {
  if (!Number.isFinite(value)) return STRONG_SEMANTIC_SCORE;
  return Math.max(0, Math.min(1, value as number));
}

function normalizePage(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value as number));
}

function normalizePageSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return 6;
  return Math.max(1, Math.min(20, Math.floor(value as number)));
}

function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && token.length <= 24 && !STOP_WORDS.has(token));
}

function countOverlap(queryTokens: Set<string>, value: string | null | undefined): number {
  return tokenize(value).filter(token => queryTokens.has(token)).length;
}

function graphNeighbors(graph: GraphData | null, symbol: string): string[] {
  if (!graph) return [];
  return [...new Set([
    ...(graph.symbols[symbol] ?? []),
    ...(graph.callers?.[symbol] ?? []),
    ...(graph.implementations?.[symbol] ?? []),
    ...(graph.implementedFrom?.[symbol] ?? []),
    ...(graph.supertypes?.[symbol] ?? []),
    ...(graph.subtypes?.[symbol] ?? []),
  ])];
}

function symbolSuffix(symbol: string): string {
  if (symbol.includes('::')) return symbol.split('::').pop() ?? symbol;
  if (symbol.includes('.')) return symbol.split('.').pop() ?? symbol;
  if (symbol.includes('\\')) return symbol.split('\\').pop() ?? symbol;
  return symbol;
}

function callerSymbolPrefix(callerSymbol: string): { prefix: string; separator: '::' | '.' } | null {
  if (callerSymbol.includes('::')) {
    const idx = callerSymbol.lastIndexOf('::');
    return { prefix: callerSymbol.slice(0, idx), separator: '::' };
  }
  if (callerSymbol.includes('.')) {
    const idx = callerSymbol.lastIndexOf('.');
    return { prefix: callerSymbol.slice(0, idx), separator: '.' };
  }
  return null;
}

function resolveCalleeCandidates(
  callerSymbol: string,
  callerFile: string,
  calleeSymbol: string,
  graph: GraphData
): string[] {
  const candidates = new Set<string>();
  if (!calleeSymbol) return [];

  // Exact symbol from call graph.
  candidates.add(calleeSymbol);

  const needsQualification = !calleeSymbol.includes('::') && !calleeSymbol.includes('.') && !calleeSymbol.includes('\\');
  const calleeName = symbolSuffix(calleeSymbol);

  // Class-qualified candidate based on caller's symbol style.
  if (needsQualification) {
    const callerPrefix = callerSymbolPrefix(callerSymbol);
    if (callerPrefix) candidates.add(`${callerPrefix.prefix}${callerPrefix.separator}${calleeName}`);
  }

  // Same-file suffix matches help bridge partially-resolved call sites.
  for (const [symbol, file] of Object.entries(graph.symbolFile)) {
    if (file !== callerFile) continue;
    if (symbol === calleeSymbol) {
      candidates.add(symbol);
      continue;
    }
    if (symbolSuffix(symbol) === calleeName) {
      candidates.add(symbol);
    }
  }

  return [...candidates];
}

export function collectDirectCallExpansionSymbols(
  seedResults: Array<Pick<RetrievedChunk, 'symbol' | 'file'>>,
  graph: GraphData,
  maxCallsPerSeed = 10
): Set<string> {
  const expanded = new Set<string>();

  for (const seed of seedResults) {
    const directCalls = graph.callSites?.[seed.symbol]?.map(site => site.symbol)
      ?? graph.symbols[seed.symbol]
      ?? [];

    for (const callee of directCalls.slice(0, maxCallsPerSeed)) {
      for (const candidate of resolveCalleeCandidates(seed.symbol, seed.file, callee, graph)) {
        expanded.add(candidate);
      }
    }
  }

  return expanded;
}

export function prioritizeDirectCallResults(ranked: RetrievedChunk[], directSymbols: Set<string>): RetrievedChunk[] {
  if (directSymbols.size === 0) return ranked;
  const direct: RetrievedChunk[] = [];
  const rest: RetrievedChunk[] = [];

  for (const result of ranked) {
    if (directSymbols.has(result.symbol)) {
      direct.push(result);
    } else {
      rest.push(result);
    }
  }

  return [...direct, ...rest];
}

function summarizeRelation(values: string[], limit = 5): { total: number; symbols: string[] } {
  const unique = [...new Set(values)];
  return {
    total: unique.length,
    symbols: unique.slice(0, limit),
  };
}

function summarizeSites(values: GraphCallSite[] | undefined, limit = 5): Array<{ symbol: string; file: string; line: number }> {
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

function buildGraphSummary(graph: GraphData | null, symbol: string): RetrievedChunk['graphSummary'] {
  return {
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
  };
}

function intersectReturnedSymbols(values: string[], returnedSymbols: Set<string>, currentSymbol: string): string[] {
  return [...new Set(values)].filter(symbol => symbol !== currentSymbol && returnedSymbols.has(symbol));
}

export function connectRetrievedChunksWithinResults(
  results: RetrievedChunk[],
  graph: GraphData | null
): RetrievedChunk[] {
  const returnedSymbols = new Set(results.map(result => result.symbol));
  return results.map(result => {
    const calls = intersectReturnedSymbols(graph?.symbols[result.symbol] ?? [], returnedSymbols, result.symbol);
    const usedBy = intersectReturnedSymbols(graph?.callers?.[result.symbol] ?? [], returnedSymbols, result.symbol);
    const supertypes = intersectReturnedSymbols(graph?.supertypes?.[result.symbol] ?? [], returnedSymbols, result.symbol);
    const subtypes = intersectReturnedSymbols(graph?.subtypes?.[result.symbol] ?? [], returnedSymbols, result.symbol);
    const implementsSymbols = intersectReturnedSymbols(graph?.implementedFrom?.[result.symbol] ?? [], returnedSymbols, result.symbol);
    const implementedBy = intersectReturnedSymbols(graph?.implementations?.[result.symbol] ?? [], returnedSymbols, result.symbol);
    const total = new Set([
      ...calls,
      ...usedBy,
      ...supertypes,
      ...subtypes,
      ...implementsSymbols,
      ...implementedBy,
    ]).size;

    return {
      ...result,
      connectionsWithinResults: {
        total,
        calls,
        usedBy,
        supertypes,
        subtypes,
        implements: implementsSymbols,
        implementedBy,
      },
    } satisfies RetrievedChunk;
  });
}

function buildMemorySupport(
  queryTokens: Set<string>,
  memoryEntries: ProjectMemoryEntry[]
): { symbolSupport: Map<string, number>; fileSupport: Map<string, number> } {
  const symbolSupport = new Map<string, number>();
  const fileSupport = new Map<string, number>();

  for (const entry of memoryEntries) {
    const topicOverlap = (entry.topics ?? []).filter(topic => queryTokens.has(topic)).length;
    const titleOverlap = countOverlap(queryTokens, entry.title);
    const summaryOverlap = countOverlap(queryTokens, entry.summary);
    const symbolOverlap = (entry.symbols ?? []).reduce((total, symbol) => total + countOverlap(queryTokens, symbol), 0);
    const fileOverlap = (entry.files ?? []).reduce((total, file) => total + countOverlap(queryTokens, file), 0);
    const relevance = topicOverlap * 4 + titleOverlap * 3 + summaryOverlap * 2 + symbolOverlap * 3 + fileOverlap * 2;
    if (relevance === 0) continue;

    for (const symbol of entry.symbols ?? []) {
      symbolSupport.set(symbol, (symbolSupport.get(symbol) ?? 0) + relevance);
    }
    for (const file of entry.files ?? []) {
      fileSupport.set(file, (fileSupport.get(file) ?? 0) + relevance * 0.75);
    }
  }

  return { symbolSupport, fileSupport };
}

export function rankRetrievedChunks(
  query: string,
  results: RetrievedChunk[],
  graph: GraphData | null,
  memoryEntries: ProjectMemoryEntry[] = [],
  mode: RetrievalMode = 'default',
  strongSemanticSeedSymbols: Set<string> = new Set<string>()
): RetrievedChunk[] {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return results;

  const { symbolSupport, fileSupport } = buildMemorySupport(queryTokens, memoryEntries);
  const strongSemanticSeeds = [...strongSemanticSeedSymbols];

  const architectureIntent = mode === 'architecture';

  return [...results]
    .map(result => {
      const semanticScore = result.semanticScore ?? result.score;
      const isStrongSemanticSeed = strongSemanticSeedSymbols.has(result.symbol);
      const isChildOfStrongSemantic = !isStrongSemanticSeed && strongSemanticSeeds
        .some(seed => (graph?.symbols[seed] ?? []).includes(result.symbol));
      const isParentOfStrongSemantic = !isStrongSemanticSeed && strongSemanticSeeds
        .some(seed => (graph?.callers?.[seed] ?? []).includes(result.symbol));
      const semanticRelationBoost = isStrongSemanticSeed
        ? 0
        : (isChildOfStrongSemantic || isParentOfStrongSemantic)
          ? 0.2
          : 0;
      const promotedSemanticScore = Math.min(1, semanticScore + semanticRelationBoost);
      const symbolOverlap = countOverlap(queryTokens, result.symbol);
      const fileOverlap = countOverlap(queryTokens, result.file);
      const directMemory = (symbolSupport.get(result.symbol) ?? 0) + (fileSupport.get(result.file) ?? 0);
      const neighbors = graphNeighbors(graph, result.symbol);
      const neighborSupport = neighbors.reduce((total, symbol) => total + (symbolSupport.get(symbol) ?? 0), 0);
      const connectivity = neighbors.length;
      const semanticContribution = architectureIntent ? promotedSemanticScore * 8 : promotedSemanticScore * 10;
      const symbolOverlapContribution = architectureIntent ? symbolOverlap * 4 : symbolOverlap * 3;
      const fileOverlapContribution = architectureIntent ? fileOverlap * 4 : fileOverlap * 2;
      const directMemoryContribution = architectureIntent ? Math.min(8, directMemory * 0.15) : directMemory;
      const neighborContribution = architectureIntent ? Math.min(8, neighborSupport * 0.2) : Math.min(6, neighborSupport * 0.15);
      const connectivityContribution = Math.min(3, connectivity * 0.3);
      const hybridScore = semanticContribution
        + symbolOverlapContribution
        + fileOverlapContribution
        + directMemoryContribution
        + neighborContribution
        + connectivityContribution;

      const rankingSignals: string[] = [];
      if (semanticScore >= 0.5) rankingSignals.push('strong semantic match');
      if (semanticRelationBoost > 0 && isChildOfStrongSemantic) rankingSignals.push('child of strong semantic match');
      if (semanticRelationBoost > 0 && isParentOfStrongSemantic) rankingSignals.push('parent of strong semantic match');
      if (symbolOverlapContribution > 0) rankingSignals.push('symbol token overlap');
      if (fileOverlapContribution > 0) rankingSignals.push('file token overlap');
      if (directMemoryContribution > 0) rankingSignals.push('supported by project memory');
      if (architectureIntent) rankingSignals.push('architecture-first ranking mode');
      if (neighborContribution > 0) rankingSignals.push('connected to relevant symbols');
      if (connectivityContribution > 0) rankingSignals.push(`graph connectivity ${connectivity}`);

      return {
        ...result,
        semanticScore,
        score: hybridScore,
        rankingSignals,
        scoreBreakdown: {
          semantic: semanticContribution,
          symbolOverlap: symbolOverlapContribution,
          fileOverlap: fileOverlapContribution,
          directMemory: directMemoryContribution,
          neighborSupport: neighborContribution,
          connectivity: connectivityContribution,
        },
      } satisfies RetrievedChunk;
    })
    .sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol));
}

export async function retrieve(
  query: string,
  projectRoot: string,
  graphPath: string,
  qdrantUrl = 'http://localhost:6333',
  mode: RetrievalMode = 'default',
  semanticThreshold?: number
): Promise<RetrievedChunk[]> {
  const response = await retrievePage(query, projectRoot, graphPath, qdrantUrl, mode, semanticThreshold, 1, 6);
  return response.results;
}

export async function retrievePage(
  query: string,
  projectRoot: string,
  graphPath: string,
  qdrantUrl = 'http://localhost:6333',
  mode: RetrievalMode = 'default',
  semanticThreshold?: number,
  page?: number,
  pageSize?: number
): Promise<RetrievalResponse> {
  const strongSemanticThreshold = normalizeSemanticThreshold(semanticThreshold);
  const currentPage = normalizePage(page);
  const currentPageSize = normalizePageSize(pageSize);
  const qdrant = new QdrantClient({ url: qdrantUrl });
  const collection = await collectionNameAsync(projectRoot);

  // 1. Embed the query locally (no API key needed)
  const queryVec = await embedQuery(query);

  // 2. Search Qdrant for top 5 semantic matches
  let hits;
  try {
    hits = await qdrant.search(collection, {
      vector: queryVec,
      limit: 5,
      with_payload: true,
    });
  } catch (error) {
    if (isQdrantCollectionNotFound(error)) {
      throw new MissingCodeIndexError(collection, qdrantUrl);
    }
    throw error;
  }

  const results: RetrievedChunk[] = hits.map(h => ({
    file: h.payload!['file'] as string,
    symbol: h.payload!['symbol'] as string,
    type: h.payload!['type'] as string,
    code: h.payload!['code'] as string,
    lineStart: typeof h.payload?.['lineStart'] === 'number' ? h.payload['lineStart'] as number : undefined,
    lineEnd: typeof h.payload?.['lineEnd'] === 'number' ? h.payload['lineEnd'] as number : undefined,
    score: h.score,
    semanticScore: h.score,
  }));
  const strongSemanticSeedSymbols = new Set(
    results
      .filter(result => (result.semanticScore ?? 0) >= strongSemanticThreshold)
      .map(result => result.symbol)
  );

  // 3. Expand via dependency graph: 2-hop outbound + 1-hop inbound (callers)
  const graph = await loadGraphAsync(graphPath);
  const priorityExpandedSymbols = new Set<string>();
  if (graph) {
    const seen = new Set(results.map(r => r.symbol));
    const relatedSymbols = new Set<string>();
    const strongSemanticSeeds = results
      .filter(result => (result.semanticScore ?? 0) >= strongSemanticThreshold)
      .sort((left, right) => (right.semanticScore ?? 0) - (left.semanticScore ?? 0))
      .slice(0, 4);
    const expansionSeeds = strongSemanticSeeds.length > 0
      ? strongSemanticSeeds
      : results.filter(result => (result.semanticScore ?? 0) > 0).slice(0, 2);

    // Direct helper expansion (both PHP and TS/Node): include functions/methods used by strong semantic seeds.
    for (const symbol of collectDirectCallExpansionSymbols(expansionSeeds, graph, 12)) {
      if (!seen.has(symbol)) relatedSymbols.add(symbol);
      priorityExpandedSymbols.add(symbol);
      seen.add(symbol);
    }

    // Outbound: 2 hops
    const frontier = new Set(expansionSeeds.map(r => r.symbol));
    for (let hop = 0; hop < 2; hop++) {
      const next = new Set<string>();
      for (const sym of frontier) {
        for (const callee of (graph.symbols[sym] ?? [])) {
          if (!seen.has(callee)) {
            relatedSymbols.add(callee);
            if (hop === 0) priorityExpandedSymbols.add(callee);
            next.add(callee);
          }
        }
      }
      next.forEach(s => { seen.add(s); frontier.delete(s); });
      frontier.clear();
      next.forEach(s => frontier.add(s));
    }

    // Inbound: 1 hop — grab parent symbols that call any strong semantic seed
    for (const r of expansionSeeds) {
      for (const caller of (graph.callers?.[r.symbol] ?? [])) {
        if (!seen.has(caller)) {
          relatedSymbols.add(caller);
          priorityExpandedSymbols.add(caller);
          seen.add(caller);
        }
      }
    }

    if (relatedSymbols.size > 0) {
      const { points } = await qdrant.scroll(collection, {
        filter: {
          should: [...relatedSymbols].map(s => ({
            key: 'symbol',
            match: { value: s },
          })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        with_payload: true,
        with_vector: false,
        limit: 20,
      });

      for (const p of points) {
        const sym = p.payload!['symbol'] as string;
        if (!results.find(r => r.symbol === sym)) {
          results.push({
            file: p.payload!['file'] as string,
            symbol: sym,
            type: p.payload!['type'] as string,
            code: p.payload!['code'] as string,
            lineStart: typeof p.payload?.['lineStart'] === 'number' ? p.payload['lineStart'] as number : undefined,
            lineEnd: typeof p.payload?.['lineEnd'] === 'number' ? p.payload['lineEnd'] as number : undefined,
            score: 0,
            semanticScore: 0,
          });
        }
      }
    }
  }

  // 4. Filename-keyword fallback: surface file chunks whose path matches query tokens
  //    (catches short config files that embed poorly due to low semantic signal)
  const queryTokens = query.toLowerCase()
    .split(/[\s\\/.\-_:]+/)
    .filter(t => t.length >= 3 && !STOP_WORDS.has(t));

  if (queryTokens.length > 0) {
    const alreadyFound = new Set(results.map(r => r.symbol));

    // Build OR filter matching query tokens against the file payload field.
    // This lets Qdrant do the filtering rather than fetching all file chunks
    // into memory. We still cap at 200 to guard against very large projects.
    const { points: filePoints } = await qdrant.scroll(collection, {
      filter: {
        must: [{ key: 'type', match: { value: 'file' } }],
        should: queryTokens.map(t => ({ key: 'file', match: { text: t } })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      with_payload: true,
      with_vector: false,
      limit: 200,
    });

    for (const p of filePoints) {
      const sym = p.payload!['symbol'] as string;
      if (!alreadyFound.has(sym)) {
        results.splice(0, 0, {  // inject at front — filename matches are high-intent
          file: p.payload!['file'] as string,
          symbol: sym,
          type: p.payload!['type'] as string,
          code: p.payload!['code'] as string,
          lineStart: typeof p.payload?.['lineStart'] === 'number' ? p.payload['lineStart'] as number : undefined,
          lineEnd: typeof p.payload?.['lineEnd'] === 'number' ? p.payload['lineEnd'] as number : undefined,
          score: 0,
          semanticScore: 0,
        });
        alreadyFound.add(sym);
      }
    }
  }

  const memoryEntries = await getProjectMemoryEntriesAsync(projectRoot);
  const ranked = await Promise.all(
    rankRetrievedChunks(query, results, graph, memoryEntries, mode, strongSemanticSeedSymbols)
      .map(async result => ({
        ...result,
        graphSummary: buildGraphSummary(graph, result.symbol),
        freshness: await getRetrievedSliceFreshnessAsync(projectRoot, result.file, result.lineStart, result.lineEnd),
      }))
  );

  const prioritized = prioritizeDirectCallResults(ranked, priorityExpandedSymbols);

  const connected = connectRetrievedChunksWithinResults(prioritized, graph);
  const totalResults = connected.length;
  const totalPages = Math.max(1, Math.ceil(totalResults / currentPageSize));
  const safePage = Math.min(currentPage, totalPages);

  const symbolIndexByPage = Array.from({ length: totalPages }, (_, index) => {
    const pageNumber = index + 1;
    const pageStart = index * currentPageSize;
    const pageEnd = pageStart + currentPageSize;
    const symbols = connected.slice(pageStart, pageEnd).map(result => result.symbol);
    return { page: pageNumber, symbols };
  });

  const start = (safePage - 1) * currentPageSize;
  const end = start + currentPageSize;
  const pageSlice = connected.slice(start, end);

  // Per-page truncation to keep each page usable by an LLM context window.
  let totalChars = 0;
  const truncatedPage = pageSlice.filter(r => {
    if (totalChars + r.code.length > MAX_CHARS) return false;
    totalChars += r.code.length;
    return true;
  });

  return {
    results: truncatedPage,
    pagination: {
      page: safePage,
      pageSize: currentPageSize,
      totalResults,
      totalPages,
      hasMore: safePage < totalPages,
      nextPage: safePage < totalPages ? safePage + 1 : null,
      symbolIndexByPage,
    },
  };
}
