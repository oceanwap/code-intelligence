/**
 * composite/cross-output-index — PRD FR-6 cross-output Qdrant index.
 *
 * Reindexes prior tool outputs into a SEPARATE Qdrant collection with
 * payload fields `tool, target, session_id, ts` (plus `text` for the
 * embedded body). Existing code/memory collections are untouched
 * (PRD NG-6).
 *
 * Why a separate collection:
 *   - The existing code-embedding collection (`code-<hash>`) has its
 *     payload schema baked into the indexer pipeline (src/embedder.ts).
 *     Adding new payload fields would force an embedding re-build across
 *     every consumer (NG-6 hard block).
 *   - Tool outputs are heterogeneous (different schemas, no source code
 *     shape to exploit) — they deserve their own collection with their
 *     own lifecycle.
 *
 * Collection naming follows the existing pattern (`code-<hash>`,
 * `memory-<hash>`) — see `src/embedder.ts:scopedCollectionNameAsync`.
 * Here we add `cross-output-<hash>`. Same hash source (project root) so
 * branch switches and multi-tenant isolation behave identically.
 *
 * Opt-in flag surface (FR-6): callers explicitly enable cross-output
 * augmentation. We deliberately do NOT enable it by default — every
 * consumer goes through the `CrossOutputSearchOpts.crossOutput: true`
 * flag so the existing query paths are byte-identical otherwise.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { VECTOR_SIZE } from '../../embedder.js';
import { embedQuery, embedTexts } from '../../embedder.js';

/** Payload schema for every cross-output point (PRD FR-6). */
export interface CrossOutputPayload {
  /** Tool name that produced the output (e.g. 'query_project'). */
  tool: string;
  /** Target symbol/file/argument the tool was invoked against. */
  target: string;
  /** Session id (per blackboard scratchpad session). */
  session_id: string;
  /** ISO timestamp captured when the tool emitted the output. */
  ts: string;
  /** Free-form text body that was embedded. Truncated to fit model limits. */
  text: string;
}

export interface CrossOutputPoint {
  id: string;
  vector: number[];
  payload: CrossOutputPayload;
}

export interface CrossOutputSearchOpts {
  /** When true, run a cross-output search and return results alongside the caller's primary payload. */
  crossOutput: boolean;
  /** Max results to return (default: 5). */
  limit?: number;
  /** Optional filter by tool name. */
  tool?: string;
  /** Optional filter by session_id. */
  sessionId?: string;
}

export interface CrossOutputSearchHit {
  tool: string;
  target: string;
  sessionId: string;
  ts: string;
  score: number;
  text: string;
}

/** Options for the cross-output index. */
export interface CrossOutputIndexOptions {
  /** Override the project root (testing only). */
  projectRoot?: string;
  /** Override the Qdrant URL (testing only). */
  qdrantUrl?: string;
}

/** Stable SHA256 hash of the resolved project root, mirroring `src/embedder.ts:projectHash`. */
function projectHash(projectRoot: string): string {
  const root = path.resolve(projectRoot);
  return crypto.createHash('sha256').update(root).digest('hex').slice(0, 8);
}

/** Cross-output collection name. Mirrors `code-<hash>` / `memory-<hash>` pattern. */
export function crossOutputCollectionName(opts?: CrossOutputIndexOptions): string {
  const root = opts?.projectRoot ?? process.cwd();
  return `cross-output-${projectHash(root)}`;
}

/** Return true when the Qdrant collection already exists. */
async function qdrantCollectionExists(qdrant: QdrantClient, collection: string): Promise<boolean> {
  const existing = await qdrant.getCollections();
  return existing.collections.some(c => c.name === collection);
}

/**
 * Create the cross-output collection if it does not yet exist.
 *
 * Idempotent: safe to call on every upsert. Vectors are sized to VECTOR_SIZE
 * (384, matching BGE-small-en-v1.5) so the same embedding model backs both
 * code and cross-output (NG-6 leaves the code collection untouched).
 */
export async function ensureCrossOutputCollectionAsync(opts?: CrossOutputIndexOptions): Promise<string> {
  const collection = crossOutputCollectionName(opts);
  const qdrant = new QdrantClient({ url: opts?.qdrantUrl ?? 'http://localhost:6333' });
  if (await qdrantCollectionExists(qdrant, collection)) return collection;

  await qdrant.createCollection(collection, {
    vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
  });
  return collection;
}

/**
 * Embed a batch of cross-output texts and upsert them.
 *
 * `texts` must have the same length as `payloads`. The function computes
 * embeddings locally via the same BGE-small-en-v1.5 model the code
 * collection uses (no API key needed).
 *
 * Returns the point ids that were upserted, in input order. Caller can
 * persist these for later reference if needed.
 */
export async function upsertCrossOutputAsync(
  payloads: CrossOutputPayload[],
  opts?: CrossOutputIndexOptions
): Promise<string[]> {
  if (payloads.length === 0) return [];
  const collection = await ensureCrossOutputCollectionAsync(opts);
  const qdrant = new QdrantClient({ url: opts?.qdrantUrl ?? 'http://localhost:6333' });

  const texts = payloads.map(p => p.text);
  const vectors = await embedTexts(texts);

  const points = payloads.map((p, i) => ({
    id: hashId(p.tool, p.target, p.session_id, p.ts, i),
    vector: vectors[i] ?? [],
    payload: { ...p },
  }));

  for (let i = 0; i < points.length; i += 25) {
    await qdrant.upsert(collection, { points: points.slice(i, i + 25) as never });
  }
  return points.map(p => p.id);
}

/**
 * Convenience helper: build + upsert in one call. Useful for hook
 * integrations that want a single awaitable per tool output.
 */
export async function exportCrossOutputAsync(
  payloads: CrossOutputPayload[],
  opts?: CrossOutputIndexOptions
): Promise<string[]> {
  return upsertCrossOutputAsync(payloads, opts);
}

/**
 * Run a cross-output semantic search. Returns `[]` when `crossOutput`
 * is false (the opt-in contract per PRD FR-6).
 *
 * Filter: when `tool` / `sessionId` are provided, the Qdrant query
 * restricts the search to matching payloads.
 */
export async function searchCrossOutputAsync(
  query: string,
  searchOpts: CrossOutputSearchOpts,
  indexOpts?: CrossOutputIndexOptions
): Promise<CrossOutputSearchHit[]> {
  if (!searchOpts?.crossOutput) return [];
  if (!query || !query.trim()) return [];

  const collection = crossOutputCollectionName(indexOpts);
  const qdrant = new QdrantClient({ url: indexOpts?.qdrantUrl ?? 'http://localhost:6333' });

  let exists = false;
  try {
    exists = await qdrantCollectionExists(qdrant, collection);
  } catch {
    return [];
  }
  if (!exists) return [];

  const queryVec = await embedQuery(query);
  const limit = searchOpts.limit ?? 5;

  // Build filter. Empty filter object = no restriction.
  const filter: Record<string, unknown> = {};
  const must: Array<Record<string, unknown>> = [];
  if (searchOpts.tool) {
    must.push({ key: 'tool', match: { value: searchOpts.tool } });
  }
  if (searchOpts.sessionId) {
    must.push({ key: 'session_id', match: { value: searchOpts.sessionId } });
  }
  if (must.length > 0) filter['must'] = must;

  let hits;
  try {
    hits = await qdrant.search(collection, {
      vector: queryVec,
      limit,
      with_payload: true,
      ...(Object.keys(filter).length > 0 ? { filter: filter as never } : {}),
    });
  } catch {
    return [];
  }

  const out: CrossOutputSearchHit[] = [];
  for (const hit of hits) {
    const payload = (hit.payload ?? {}) as Partial<CrossOutputPayload>;
    if (!payload.tool || !payload.target || !payload.session_id || !payload.ts) continue;
    out.push({
      tool: payload.tool,
      target: payload.target,
      sessionId: payload.session_id,
      ts: payload.ts,
      score: hit.score,
      text: typeof payload.text === 'string' ? payload.text : '',
    });
  }
  return out;
}

/**
 * Render a list of cross-output hits for human/LLM display. Stable
 * formatting — used in the `query_project` augmentation section.
 */
export function renderCrossOutputHits(hits: CrossOutputSearchHit[]): string {
  if (hits.length === 0) return '';
  const lines: string[] = ['Cross-output context:'];
  for (const hit of hits) {
    lines.push(`  - [${hit.tool}] ${hit.target} (session ${hit.sessionId}, ${hit.ts}, score ${hit.score.toFixed(3)})`);
    if (hit.text) {
      const preview = hit.text.length > 200 ? `${hit.text.slice(0, 200)}…` : hit.text;
      lines.push(`      ${preview.replace(/\s+/g, ' ').trim()}`);
    }
  }
  return lines.join('\n');
}

/**
 * Truncate text for embedding. Mirrors the cap used by `embedder.ts` so
 * cross-output embeddings are bounded the same way as code embeddings.
 */
export function truncateForEmbedding(text: string, maxChars = 6000): string {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n/* truncated for embedding */`;
}

/**
 * Build a stable UUID-like id from the cross-output payload.
 *
 * Same `(tool, target, session_id, ts)` re-emitted by the same tool
 * idempotently overwrites the same point — useful for re-indexing
 * without growing storage.
 */
function hashId(tool: string, target: string, sessionId: string, ts: string, idx: number): string {
  const key = `${tool}::${target}::${sessionId}::${ts}::${idx}`;
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Helper: build a payload from a tool-call result the caller already has.
 *
 * `text` may be a stringified JSON object/array, a markdown string, or any
 * plain text. Long strings are truncated to keep embedding latency bounded.
 */
export function buildCrossOutputPayload(input: {
  tool: string;
  target: string;
  sessionId: string;
  ts?: string;
  text: string;
}): CrossOutputPayload {
  return {
    tool: input.tool,
    target: input.target,
    session_id: input.sessionId,
    ts: input.ts ?? new Date().toISOString(),
    text: truncateForEmbedding(input.text),
  };
}