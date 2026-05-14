import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import { QdrantClient } from '@qdrant/js-client-rest';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { mkdir } from 'node:fs/promises';
import type { CodeChunk } from './indexer.js';
import { toUUID } from './indexer.js';
import { getCurrentBranchAsync } from './git.js';

export const VECTOR_SIZE = 384; // BGE-small-en-v1.5 (local, no API key, ~33 MB, ~3x faster than base)
const UPSERT_BATCH_SIZE = 25;
const MAX_UPSERT_RETRIES = 3;
const EMBED_BATCH_SIZE = (() => {
  const override = Number(process.env.CODE_INTEL_EMBED_BATCH ?? '');
  if (Number.isFinite(override) && override >= 4 && override <= 128) {
    return Math.floor(override);
  }

  const cpuCount = os.cpus().length;
  if (cpuCount <= 4) return 16;
  if (cpuCount <= 8) return 24;
  return 32;
})();
const MAX_EMBED_TEXT_CHARS = 6000;
const EMBED_DEBUG = process.env.CODE_INTEL_EMBED_DEBUG === '1';

type ProcessLogDestination = 'stdout' | 'stderr' | 'split';

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

function runtimeLog(message: string, level: 'info' | 'error' = 'info'): void {
  const destination = parseLogDestination(process.env['CODE_INTEL_LOG_DESTINATION']) ?? 'stdout';
  const stream = destination === 'stdout'
    ? process.stdout
    : destination === 'stderr'
      ? process.stderr
      : level === 'error'
        ? process.stderr
        : process.stdout;
  stream.write(`${message}\n`);
}

function nowMs(): number {
  return performance.now();
}

async function readVectorCache(cacheFile: string): Promise<Record<string, number[]>> {
  try {
    const raw = await Bun.file(cacheFile).text();
    return JSON.parse(raw) as Record<string, number[]>;
  } catch {
    return {};
  }
}

async function writeVectorCache(cacheFile: string, cache: Record<string, number[]>): Promise<void> {
  await mkdir(path.dirname(cacheFile), { recursive: true });
  const payload = JSON.stringify(cache);
  await Bun.write(cacheFile, payload);
}

// Store the model in a shared user-level cache so it is downloaded only once
// regardless of which directory `code-intel` is run from.
const MODEL_CACHE_DIR = path.join(os.homedir(), '.cache', 'code-intelligence', 'models');

// Lazy singleton — model is downloaded once on first use
let _model: FlagEmbedding | null = null;
async function getModel(): Promise<FlagEmbedding> {
  if (!_model) {
    await mkdir(MODEL_CACHE_DIR, { recursive: true });
    _model = await FlagEmbedding.init({
      model: EmbeddingModel.BGESmallENV15,
      cacheDir: MODEL_CACHE_DIR,
    });
  }
  return _model;
}

// Warm up the model so callers can show a loading indicator before embedding
export async function initModel(): Promise<void> {
  await getModel();
}

export async function embedTexts(
  texts: string[],
  onProgress?: (done: number, total: number) => void
): Promise<number[][]> {
  const model = await getModel();
  const results: number[][] = [];
  for await (const batch of model.embed(texts, EMBED_BATCH_SIZE)) {
    for (const vec of batch) results.push(Array.from(vec));
    onProgress?.(Math.min(results.length, texts.length), texts.length);
  }
  return results;
}

function toEmbeddingText(chunk: CodeChunk): string {
  const head = `file: ${chunk.file}\n${chunk.symbol}\n\n`;
  if (chunk.code.length <= MAX_EMBED_TEXT_CHARS) return `${head}${chunk.code}`;
  return `${head}${chunk.code.slice(0, MAX_EMBED_TEXT_CHARS)}\n/* truncated for embedding */`;
}

export async function embedQuery(text: string): Promise<number[]> {
  const model = await getModel();
  return Array.from(await model.queryEmbed(text));
}

async function wait(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function qdrantCollectionExists(qdrant: QdrantClient, collection: string): Promise<boolean> {
  const existing = await qdrant.getCollections();
  return existing.collections.some(item => item.name === collection);
}

function isMissingCollectionError(error: unknown): boolean {
  const candidate = error as {
    status?: number;
    message?: string;
    data?: { status?: { error?: string } };
  };
  const detail = `${candidate.message ?? ''}\n${candidate.data?.status?.error ?? ''}`.toLowerCase();
  return candidate.status === 404 && detail.includes('collection') && detail.includes("doesn't exist");
}

async function clearCache(cache: Record<string, number[]>, cacheFile: string): Promise<void> {
  Object.keys(cache).forEach(key => delete cache[key]);
  await writeVectorCache(cacheFile, cache);
}

async function pruneInvalidVectors(cache: Record<string, number[]>, cacheFile: string): Promise<void> {
  let changed = false;
  for (const [id, vector] of Object.entries(cache)) {
    if (vector.length !== VECTOR_SIZE) {
      delete cache[id];
      changed = true;
    }
  }
  if (changed) await writeVectorCache(cacheFile, cache);
}

async function deleteQdrantPoints(
  qdrant: QdrantClient,
  collection: string,
  pointIds: string[]
): Promise<void> {
  if (!(await qdrantCollectionExists(qdrant, collection))) return;
  try {
    await qdrant.delete(collection, { points: pointIds });
  } catch (error) {
    if (isMissingCollectionError(error)) return;
    throw error;
  }
}

async function upsertWithRetry(
  qdrant: QdrantClient,
  collection: string,
  points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_UPSERT_RETRIES; attempt++) {
    try {
      await qdrant.upsert(collection, { points });
      return;
    } catch (error) {
      if (attempt === MAX_UPSERT_RETRIES) throw error;
      await wait(200 * attempt);
    }
  }
}

export async function scopedCollectionNameAsync(projectRoot: string, scope: 'code' | 'memory'): Promise<string> {
  const branch = await getCurrentBranchAsync(path.resolve(projectRoot));
  const root = path.resolve(projectRoot);
  const key = branch !== null ? root + '\n' + branch : root;
  const hash = crypto
    .createHash('sha256')
    .update(key)
    .digest('hex')
    .slice(0, 8);
  return `${scope}-${hash}`;
}

export async function collectionNameAsync(projectRoot: string): Promise<string> {
  return await scopedCollectionNameAsync(projectRoot, 'code');
}

export async function embedAndStore(
  chunks: CodeChunk[],
  cacheFile: string,
  projectRoot: string,
  qdrantUrl = 'http://localhost:6333',
  onProgress?: (stage: 'loading-model' | 'embedding' | 'storing', done: number, total: number) => void
): Promise<void> {
  const startedAt = nowMs();
  const marks: Record<string, number> = {};
  const mark = (name: string): void => {
    marks[name] = Math.round((nowMs() - startedAt) * 100) / 100;
  };

  const qdrant = new QdrantClient({ url: qdrantUrl });
  const collection = await collectionNameAsync(projectRoot);
  mark('qdrant-client-ready');

  // Load local embedding cache to skip re-embedding unchanged chunks
  const cache = await readVectorCache(cacheFile);
  await pruneInvalidVectors(cache, cacheFile);
  mark('cache-ready');

  const existing = await qdrant.getCollections();
  let collectionNeedsFullSync = false;
  if (existing.collections.find(c => c.name === collection)) {
    // Recreate collection if vector size changed (e.g. model switch)
    const info = await qdrant.getCollection(collection);
    const dim = (info.config?.params?.vectors as { size?: number } | undefined)?.size;
    if (dim !== undefined && dim !== VECTOR_SIZE) {
      runtimeLog(`Collection dim mismatch (${dim} → ${VECTOR_SIZE}), recreating...`);
      await qdrant.deleteCollection(collection);
      await clearCache(cache, cacheFile);
      await qdrant.createCollection(collection, {
        vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
      });
      collectionNeedsFullSync = true;
    }
  } else {
    await qdrant.createCollection(collection, {
      vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
    });
    collectionNeedsFullSync = true;
  }
  mark('collection-ready');

  const points: Array<{
    id: string;
    vector: number[];
    payload: Record<string, unknown>;
  }> = [];

  // Batch-embed only chunks missing from cache
  const uncached = chunks.filter(c => !cache[c.id]);
  mark('uncached-filtered');
  if (uncached.length > 0) {
    onProgress?.('loading-model', 0, 1);
    const texts = uncached.map(toEmbeddingText);
    const vecs = await embedTexts(texts, (d, t) => onProgress?.('embedding', d, t));
    mark('embedding-done');
    uncached.forEach((c, i) => { cache[c.id] = vecs[i]; });
    await writeVectorCache(cacheFile, cache);
    mark('cache-written');
  } else {
    mark('embedding-done');
    mark('cache-written');
  }

  // Only upsert newly-embedded chunks — unchanged chunks are already in Qdrant
  const newlyEmbedded = new Set(uncached.map(c => c.id));
  for (const chunk of chunks) {
    if (!collectionNeedsFullSync && !newlyEmbedded.has(chunk.id)) continue;
    const vector = cache[chunk.id];
    if (!vector) throw new Error(`Missing embedding vector for chunk ${chunk.id}`);
    points.push({
      id: toUUID(chunk.id),
      vector,
      payload: {
        file: chunk.file,
        symbol: chunk.symbol,
        type: chunk.type,
        code: chunk.code,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        chunkId: chunk.id,
      },
    });
  }

  // Upsert in smaller batches with retry to avoid transient socket closures.
  for (let i = 0; i < points.length; i += UPSERT_BATCH_SIZE) {
    await upsertWithRetry(qdrant, collection, points.slice(i, i + UPSERT_BATCH_SIZE));
    onProgress?.('storing', Math.min(i + UPSERT_BATCH_SIZE, points.length), points.length);
  }
  mark('upsert-done');

  if (points.length > 0) {
    runtimeLog(`Upserted ${points.length} chunk(s) into "${collection}"`);
  } else {
    runtimeLog(`No changes — collection "${collection}" is up to date`);
  }

  if (EMBED_DEBUG) {
    runtimeLog(`[embed-debug] runtime=bun uncached=${uncached.length}/${chunks.length} points=${points.length} batch=${EMBED_BATCH_SIZE}`);
    runtimeLog(`[embed-debug] timings(ms) ${Object.entries(marks).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
}

/** Remove chunks from Qdrant and the local cache (used for differential re-index) */
export async function deletePoints(
  chunkIds: string[],
  cacheFile: string,
  projectRoot: string,
  qdrantUrl = 'http://localhost:6333'
): Promise<void> {
  if (chunkIds.length === 0) return;
  const qdrant = new QdrantClient({ url: qdrantUrl });
  const collection = await collectionNameAsync(projectRoot);

  // Remove from local cache
  const cache = await readVectorCache(cacheFile);
  for (const id of chunkIds) delete cache[id];
  await writeVectorCache(cacheFile, cache);

  // Delete from Qdrant
  await deleteQdrantPoints(qdrant, collection, chunkIds.map(toUUID));
}

/**
 * Scroll all Qdrant points and delete any whose chunkId is not in `knownIds`.
 * This catches chunks that were indexed before manifest tracking covered all file types
 * (e.g. plain .json/.md files indexed before the gitignore feature was added).
 * Returns the number of orphaned points deleted.
 */
export async function deleteOrphanPoints(
  knownIds: Set<string>,
  cacheFile: string,
  projectRoot: string,
  qdrantUrl = 'http://localhost:6333'
): Promise<number> {
  const qdrant = new QdrantClient({ url: qdrantUrl });
  const collection = await collectionNameAsync(projectRoot);

  const existing = await qdrant.getCollections();
  if (!existing.collections.find(c => c.name === collection)) return 0;

  const orphanIds: string[] = [];
  let offset: string | number | null | undefined = undefined;

  while (true) {
    const result = await qdrant.scroll(collection, {
      limit: 500,
      offset,
      with_payload: ['chunkId'],
      with_vector: false,
    });

    for (const point of result.points) {
      const chunkId = (point.payload as Record<string, unknown>)?.chunkId as string | undefined;
      if (chunkId && !knownIds.has(chunkId)) {
        orphanIds.push(chunkId);
      }
    }

    if (result.next_page_offset == null) break;
    offset = result.next_page_offset as string | number;
  }

  if (orphanIds.length > 0) {
    const cache = await readVectorCache(cacheFile);
    for (const id of orphanIds) delete cache[id];
    await writeVectorCache(cacheFile, cache);
    await deleteQdrantPoints(qdrant, collection, orphanIds.map(toUUID));
  }

  return orphanIds.length;
}
