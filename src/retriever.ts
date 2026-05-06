import { QdrantClient } from '@qdrant/js-client-rest';
import { loadGraph, type GraphData } from './graph.js';
import { collectionName, embedQuery } from './embedder.js';
import { getProjectMemoryEntries, type ProjectMemoryEntry } from './project-memory.js';

const MAX_CHARS = 3000 * 4; // ~3000 tokens (1 token ≈ 4 chars)
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
  score: number;
  semanticScore?: number;
  rankingSignals?: string[];
  scoreBreakdown?: {
    semantic: number;
    symbolOverlap: number;
    fileOverlap: number;
    directMemory: number;
    neighborSupport: number;
    connectivity: number;
  };
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
  memoryEntries: ProjectMemoryEntry[] = []
): RetrievedChunk[] {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return results;

  const { symbolSupport, fileSupport } = buildMemorySupport(queryTokens, memoryEntries);

  return [...results]
    .map(result => {
      const semanticScore = result.semanticScore ?? result.score;
      const symbolOverlap = countOverlap(queryTokens, result.symbol);
      const fileOverlap = countOverlap(queryTokens, result.file);
      const directMemory = (symbolSupport.get(result.symbol) ?? 0) + (fileSupport.get(result.file) ?? 0);
      const neighbors = graphNeighbors(graph, result.symbol);
      const neighborSupport = neighbors.reduce((total, symbol) => total + (symbolSupport.get(symbol) ?? 0), 0);
      const connectivity = neighbors.length;
      const semanticContribution = semanticScore * 10;
      const symbolOverlapContribution = symbolOverlap * 3;
      const fileOverlapContribution = fileOverlap * 2;
      const neighborContribution = Math.min(6, neighborSupport * 0.15);
      const connectivityContribution = Math.min(3, connectivity * 0.3);
      const hybridScore = semanticContribution
        + symbolOverlapContribution
        + fileOverlapContribution
        + directMemory
        + neighborContribution
        + connectivityContribution;

      const rankingSignals: string[] = [];
      if (semanticScore >= 0.5) rankingSignals.push('strong semantic match');
      if (symbolOverlapContribution > 0) rankingSignals.push('symbol token overlap');
      if (fileOverlapContribution > 0) rankingSignals.push('file token overlap');
      if (directMemory > 0) rankingSignals.push('supported by project memory');
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
          directMemory,
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
  qdrantUrl = 'http://localhost:6333'
): Promise<RetrievedChunk[]> {
  const qdrant = new QdrantClient({ url: qdrantUrl });
  const collection = collectionName(projectRoot);

  // 1. Embed the query locally (no API key needed)
  const queryVec = await embedQuery(query);

  // 2. Search Qdrant for top 5 semantic matches
  const hits = await qdrant.search(collection, {
    vector: queryVec,
    limit: 5,
    with_payload: true,
  });

  const results: RetrievedChunk[] = hits.map(h => ({
    file: h.payload!['file'] as string,
    symbol: h.payload!['symbol'] as string,
    type: h.payload!['type'] as string,
    code: h.payload!['code'] as string,
    score: h.score,
    semanticScore: h.score,
  }));

  // 3. Expand via dependency graph: 2-hop outbound + 1-hop inbound (callers)
  const graph = loadGraph(graphPath);
  if (graph) {
    const seen = new Set(results.map(r => r.symbol));
    const relatedSymbols = new Set<string>();

    // Outbound: 2 hops
    const frontier = new Set(results.map(r => r.symbol));
    for (let hop = 0; hop < 2; hop++) {
      const next = new Set<string>();
      for (const sym of frontier) {
        for (const callee of (graph.symbols[sym] ?? [])) {
          if (!seen.has(callee)) { relatedSymbols.add(callee); next.add(callee); }
        }
      }
      next.forEach(s => { seen.add(s); frontier.delete(s); });
      frontier.clear();
      next.forEach(s => frontier.add(s));
    }

    // Inbound: 1 hop — grab symbols that call any of our top results
    for (const r of results) {
      for (const caller of (graph.callers?.[r.symbol] ?? [])) {
        if (!seen.has(caller)) { relatedSymbols.add(caller); seen.add(caller); }
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
          score: 0,
          semanticScore: 0,
        });
        alreadyFound.add(sym);
      }
    }
  }

  const memoryEntries = getProjectMemoryEntries(projectRoot);
  const ranked = rankRetrievedChunks(query, results, graph, memoryEntries);

  // 5. Truncate to ~3000 tokens
  let total = 0;
  return ranked.filter(r => {
    if (total + r.code.length > MAX_CHARS) return false;
    total += r.code.length;
    return true;
  });
}
