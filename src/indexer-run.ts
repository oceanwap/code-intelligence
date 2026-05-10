import * as path from 'path';
import { indexDirectory, buildManifestAsync, loadManifestAsync, saveManifestAsync, listIndexableFiles } from './indexer.js';
import type { CodeChunk } from './indexer.js';
import { embedAndStore, deletePoints, deleteOrphanPoints } from './embedder.js';
import { buildGraphAsync, saveGraph } from './graph.js';
import { syncProjectMemory } from './project-memory.js';
import { retrieve, type RetrievedChunk, type RetrievalMode } from './retriever.js';
import { getDataDir } from './git.js';
import { refreshArchitectureAsync } from './cognition/architecture/storage.js';
import { refreshStructureAsync } from './cognition/structure/engine.js';
import { refreshAttentionAsync } from './cognition/attention/engine.js';
import { reflectLatestChangeAsync } from './cognition/reflection/engine.js';
import { refreshFailureIntelligenceAsync } from './cognition/failures/engine.js';
import { validateArchitectureAsync } from './cognition/constraints/engine.js';
import { refreshEvolutionAsync } from './cognition/evolution/engine.js';
import { refreshMemoryGovernanceAsync } from './cognition/governance/engine.js';

export interface IndexResult {
  mode: IndexMode;
  discoveredChunks: number;
  indexedChunks: number;
  filteredOutChunks: number;
  chunks: number;
  symbols: number;
  files: number;
  staleRemoved: number;
  orphansRemoved: number;
  memoryEntries: number;
  newMemoryEntries: number;
  staleMemoryRemoved: number;
  architectureModules: number;
  reflectionGenerated: boolean;
  failureRecords: number;
  constraintViolations: number;
  evolutionModules: number;
  staleMemoryEntries: number;
  structureModules: number;
  attentionCritical: number;
  totalDurationMs: number;
  stageDurationsMs: Record<string, number>;
}

export type ProgressCallback = (
  stage: 'pre-scanning' | 'parsing' | 'building-graph' | 'building-manifest' | 'cleaning' | 'loading-model' | 'embedding' | 'storing' | 'syncing-memory' | 'computing-cognition',
  done: number,
  total: number
) => void;

export type IndexMode = 'fast' | 'full';

const FAST_KEEP_RATIO = 0.3;
const FAST_KEEP_MIN = 90;
const FAST_CHUNK_SCORE_THRESHOLD = 7;
const FAST_MAX_CHUNKS_DEFAULT = 3500;

function fastChunkBudget(): number {
  const override = Number(process.env.CODE_INTEL_FAST_MAX_CHUNKS ?? '');
  if (Number.isFinite(override) && override >= 500 && override <= 50000) {
    return Math.floor(override);
  }
  return FAST_MAX_CHUNKS_DEFAULT;
}

function nowMs(): number {
  return performance.now();
}

function isLowSignalPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase();
  return normalized.startsWith('test/')
    || normalized.startsWith('tests/')
    || normalized.startsWith('docs/')
    || normalized.startsWith('examples/')
    || normalized.startsWith('scripts/')
    || normalized.includes('/fixtures/')
    || normalized.includes('/__snapshots__/')
    || normalized.endsWith('.snap');
}

function isHighValuePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase();
  const base = path.basename(normalized);
  return base === 'readme.md'
    || base === 'package.json'
    || base === 'tsconfig.json'
    || base === 'dockerfile'
    || base === 'index.ts'
    || base === 'main.ts'
    || base === 'server.ts'
    || normalized.startsWith('src/');
}

async function fileSize(absPath: string): Promise<number> {
  return Bun.file(absPath).size;
}

async function cheapContentSignal(absPath: string): Promise<number> {
  try {
    const size = await fileSize(absPath);
    if (size <= 0) return 0;

    const limit = Math.min(4096, size);
    const text = await Bun.file(absPath).slice(0, limit).text();

    let score = 0;
    if (/\b(export|module\.exports|exports\.)\b/.test(text)) score += 2;
    if (/\b(class|interface|function|const|let|var)\b/.test(text)) score += 2;
    if (/\b(todo|fixme|hack|deprecated)\b/i.test(text)) score += 1;
    return score;
  } catch {
    return 0;
  }
}

async function buildFastCandidateSet(projectRoot: string): Promise<Set<string>> {
  const absFiles = await listIndexableFiles(projectRoot);
  const scored = await Promise.all(absFiles.map(async absPath => {
    const relPath = path.relative(projectRoot, absPath);
    const normalized = relPath.replace(/\\/g, '/').toLowerCase();
    const ext = path.extname(normalized);
    let score = 0;

    if (normalized.startsWith('src/')) score += 6;
    if (isHighValuePath(normalized)) score += 6;
    if (isLowSignalPath(normalized)) score -= 6;

    if (ext === '.ts' || ext === '.tsx') score += 4;
    else if (ext === '.js' || ext === '.jsx') score += 3;
    else if (ext === '.php') score += 3;
    else score += 1;

    try {
      const size = await fileSize(absPath);
      if (size < 60) score -= 2;
      else if (size < 256) score -= 1;
      else if (size <= 80_000) score += 2;
      else if (size > 250_000) score -= 2;
    } catch {
      score -= 1;
    }

    score += await cheapContentSignal(absPath);
    return { relPath, score };
  }));

  if (scored.length === 0) return new Set<string>();

  scored.sort((a: typeof scored[0], b: typeof scored[0]) => b.score - a.score || a.relPath.localeCompare(b.relPath));
  const keepCount = Math.min(scored.length, Math.max(FAST_KEEP_MIN, Math.ceil(scored.length * FAST_KEEP_RATIO)));
  const picked = new Set<string>(scored.slice(0, keepCount).map((item: typeof scored[0]) => item.relPath));

  for (const file of scored) {
    if (isHighValuePath(file.relPath)) picked.add(file.relPath);
  }

  return picked;
}

function highValueFile(relPath: string): boolean {
  const base = path.basename(relPath).toLowerCase();
  return base === 'package.json' || base === 'tsconfig.json' || base === 'readme.md';
}

function chunkScore(
  chunk: CodeChunk,
  graph: { symbols: Record<string, string[]>; callers: Record<string, string[]> }
): number {
  let score = 0;
  const normalizedFile = chunk.file.replace(/\\/g, '/').toLowerCase();
  const degree = (graph.symbols[chunk.symbol]?.length ?? 0) + (graph.callers[chunk.symbol]?.length ?? 0);

  if (chunk.type !== 'file') score += 5;
  if (chunk.type === 'class') score += 2;
  if (normalizedFile.startsWith('src/')) score += 3;
  if (isLowSignalPath(normalizedFile)) score -= 4;
  if (chunk.symbol.includes('<anonymous>')) score -= 3;
  if (chunk.code.length < 80) score -= 1;
  if (chunk.code.length > 16000) score -= 2;
  if (chunk.type === 'file' && !highValueFile(normalizedFile)) score -= 2;

  score += Math.min(4, degree);
  if (highValueFile(normalizedFile)) score += 3;
  return score;
}

function selectChunksForIndex(
  chunks: CodeChunk[],
  graph: { symbols: Record<string, string[]>; callers: Record<string, string[]> },
  mode: IndexMode
): CodeChunk[] {
  if (mode === 'full') return chunks;
  const selected = chunks.filter(chunk => {
    const degree = (graph.symbols[chunk.symbol]?.length ?? 0) + (graph.callers[chunk.symbol]?.length ?? 0);
    if (highValueFile(chunk.file)) return true;
    if (degree >= 2 && chunk.type !== 'file') return true;
    return chunkScore(chunk, graph) >= FAST_CHUNK_SCORE_THRESHOLD;
  });

  const budget = fastChunkBudget();
  if (selected.length <= budget) return selected;

  return selected
    .slice()
    .sort((left, right) => {
      const leftScore = chunkScore(left, graph);
      const rightScore = chunkScore(right, graph);
      return rightScore - leftScore
        || left.file.localeCompare(right.file)
        || left.symbol.localeCompare(right.symbol);
    })
    .slice(0, budget);
}

/**
 * Full differential index of a project directory.
 * Shared by both the CLI and MCP server.
 */
export async function indexProject(
  projectRoot: string,
  qdrantUrl = 'http://localhost:6333',
  onProgress?: ProgressCallback,
  fromScratch = false,
  mode: IndexMode = 'fast'
): Promise<IndexResult> {
  const runStartedAt = nowMs();
  const stageDurationsMs: Record<string, number> = {};
  const measure = async <T>(stage: string, fn: () => Promise<T> | T): Promise<T> => {
    const startedAt = nowMs();
    const result = await fn();
    stageDurationsMs[stage] = Math.round((nowMs() - startedAt) * 100) / 100;
    return result;
  };

  const root = path.resolve(projectRoot);
  const dataDir = getDataDir(root);
  const manifestFile = path.join(dataDir, 'manifest.json');
  const cacheFile = path.join(dataDir, 'cache.json');

  let includeFiles: Set<string> | undefined;
  if (mode === 'fast') {
    onProgress?.('pre-scanning', 0, 1);
    includeFiles = await measure('pre-scanning', () => buildFastCandidateSet(root));
    onProgress?.('pre-scanning', 1, 1);
  }

  onProgress?.('parsing', 0, 1);
  const discoveredChunks = await measure('parsing', () => indexDirectory(root, { mode, includeFiles }));
  onProgress?.('parsing', 1, 1);

  onProgress?.('building-graph', 0, 1);
  const graph = await measure('building-graph', () => buildGraphAsync(root, { mode, includeFiles }));
  await saveGraph(graph, path.join(dataDir, 'graph.json'));
  onProgress?.('building-graph', 1, 1);

  const chunks = selectChunksForIndex(discoveredChunks, graph, mode);

  onProgress?.('building-manifest', 0, 1);
  const [oldManifest, newManifest] = await measure('building-manifest', async () => {
    const old = await loadManifestAsync(manifestFile);
    const next = await buildManifestAsync(root, chunks);
    return [old, next] as const;
  });
  onProgress?.('building-manifest', 1, 1);

  const hasPreviousIndex = Object.keys(oldManifest.mtimes).length > 0;
  const isFirstRun = !hasPreviousIndex;

  let staleRemoved = 0;
  let orphansRemoved = 0;

  // If reindexing from scratch, delete all points in Qdrant
  onProgress?.('cleaning', 0, 1);
  await measure('cleaning', async () => {
    if (fromScratch && hasPreviousIndex) {
      const allOldIds = Object.values(oldManifest.fileChunks).flat();
      if (allOldIds.length > 0) {
        await deletePoints(allOldIds, cacheFile, root, qdrantUrl);
        staleRemoved = allOldIds.length;
      }
      return;
    }

    if (!isFirstRun) {
      const staleIds: string[] = [];
      for (const [relPath, chunkIds] of Object.entries(oldManifest.fileChunks)) {
        const newMtime = newManifest.mtimes[relPath];
        const excluded = !(relPath in newManifest.fileChunks);
        if (newMtime === undefined || excluded) {
          staleIds.push(...chunkIds);
          continue;
        }
        const oldMtime = oldManifest.mtimes[relPath];
        if (oldMtime !== undefined && newMtime !== oldMtime) {
          staleIds.push(...chunkIds);
        }
      }
      if (staleIds.length > 0) {
        await deletePoints(staleIds, cacheFile, root, qdrantUrl);
        staleRemoved = staleIds.length;
      }

      const knownIds = new Set(Object.values(newManifest.fileChunks).flat());
      orphansRemoved = await deleteOrphanPoints(knownIds, cacheFile, root, qdrantUrl);
    }
  });
  onProgress?.('cleaning', 1, 1);

  await measure('embedding+storing', () => embedAndStore(chunks, cacheFile, root, qdrantUrl, onProgress));
  
  onProgress?.('syncing-memory', 0, 1);
  const memory = await measure('syncing-memory', () => syncProjectMemory(root, qdrantUrl));
  onProgress?.('syncing-memory', 1, 1);
  
  onProgress?.('computing-cognition', 0, 8);
  const cognition = await measure('computing-cognition', async () => {
    const structure = await refreshStructureAsync(root);
    onProgress?.('computing-cognition', 1, 8);
    const architecture = await refreshArchitectureAsync(root);
    onProgress?.('computing-cognition', 2, 8);
    const attention = await refreshAttentionAsync(root);
    onProgress?.('computing-cognition', 3, 8);
    const reflection = await reflectLatestChangeAsync(root);
    onProgress?.('computing-cognition', 4, 8);
    const failures = await refreshFailureIntelligenceAsync(root);
    onProgress?.('computing-cognition', 5, 8);
    const constraints = await validateArchitectureAsync(root);
    onProgress?.('computing-cognition', 6, 8);
    const evolution = await refreshEvolutionAsync(root);
    onProgress?.('computing-cognition', 7, 8);
    const governance = await refreshMemoryGovernanceAsync(root);
    onProgress?.('computing-cognition', 8, 8);
    return {
      structure,
      architecture,
      attention,
      reflection,
      failures,
      constraints,
      evolution,
      governance,
    };
  });

  const { structure, architecture, attention, reflection, failures, constraints, evolution, governance } = cognition;

  await saveManifestAsync(newManifest, manifestFile);
  const totalDurationMs = Math.round((nowMs() - runStartedAt) * 100) / 100;

  return {
    mode,
    discoveredChunks: discoveredChunks.length,
    indexedChunks: chunks.length,
    filteredOutChunks: Math.max(0, discoveredChunks.length - chunks.length),
    chunks: chunks.length,
    symbols: Object.keys(graph.symbols).length,
    files: Object.keys(graph.files).length,
    staleRemoved,
    orphansRemoved,
    memoryEntries: memory.totalEntries,
    newMemoryEntries: memory.newEntries,
    staleMemoryRemoved: memory.staleRemoved,
    architectureModules: architecture?.modules.length ?? 0,
    reflectionGenerated: reflection !== null,
    failureRecords: failures.totalFailures,
    constraintViolations: constraints.violations.length,
    evolutionModules: evolution.modules.length,
    staleMemoryEntries: governance.health.staleEntries,
    structureModules: structure?.modules.length ?? 0,
    attentionCritical: attention?.modules.filter(module => module.tier === 'CRITICAL').length ?? 0,
    totalDurationMs,
    stageDurationsMs,
  };
}

export { type RetrievedChunk };

export async function queryProject(
  projectRoot: string,
  question: string,
  qdrantUrl = 'http://localhost:6333',
  mode: RetrievalMode = 'default'
): Promise<RetrievedChunk[]> {
  const root = path.resolve(projectRoot);
  const graphPath = path.join(getDataDir(root), 'graph.json');
  return retrieve(question, root, graphPath, qdrantUrl, mode);
}
