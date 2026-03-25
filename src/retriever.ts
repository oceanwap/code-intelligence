import { QdrantClient } from '@qdrant/js-client-rest';
import { loadGraph } from './graph.js';
import { collectionName, embedQuery } from './embedder.js';

const MAX_CHARS = 3000 * 4; // ~3000 tokens (1 token ≈ 4 chars)

export interface RetrievedChunk {
  file: string;
  symbol: string;
  type: string;
  code: string;
  score: number; // 0 = graph-expanded (not directly ranked)
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
          });
        }
      }
    }
  }

  // 4. Filename-keyword fallback: surface file chunks whose path matches query tokens
  //    (catches short config files that embed poorly due to low semantic signal)
  const STOP_WORDS = new Set(['the', 'how', 'what', 'where', 'does', 'get', 'set', 'use',
    'for', 'with', 'from', 'and', 'that', 'this', 'are', 'was', 'not', 'but',
    'file', 'code', 'function', 'class', 'method']);
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
        });
        alreadyFound.add(sym);
      }
    }
  }

  // 5. Truncate to ~3000 tokens
  let total = 0;
  return results.filter(r => {
    if (total + r.code.length > MAX_CHARS) return false;
    total += r.code.length;
    return true;
  });
}
