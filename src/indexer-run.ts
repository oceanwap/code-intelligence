import * as path from 'path';
import * as fs from 'fs';
import { indexDirectory, buildManifest, loadManifest, saveManifest } from './indexer.js';
import { embedAndStore, deletePoints, deleteOrphanPoints } from './embedder.js';
import { buildGraph, saveGraph } from './graph.js';
import { syncProjectMemory } from './project-memory.js';
import { retrieve, type RetrievedChunk } from './retriever.js';
import { getDataDir } from './git.js';

export interface IndexResult {
  chunks: number;
  symbols: number;
  files: number;
  staleRemoved: number;
  orphansRemoved: number;
  memoryEntries: number;
  newMemoryEntries: number;
  staleMemoryRemoved: number;
}

export type ProgressCallback = (
  stage: 'loading-model' | 'embedding' | 'storing',
  done: number,
  total: number
) => void;

/**
 * Full differential index of a project directory.
 * Shared by both the CLI and MCP server.
 */
export async function indexProject(
  projectRoot: string,
  qdrantUrl = 'http://localhost:6333',
  onProgress?: ProgressCallback
): Promise<IndexResult> {
  const root = path.resolve(projectRoot);
  const dataDir = getDataDir(root);
  const manifestFile = path.join(dataDir, 'manifest.json');
  const cacheFile = path.join(dataDir, 'cache.json');

  const chunks = indexDirectory(root);

  const graph = buildGraph(root);
  saveGraph(graph, path.join(dataDir, 'graph.json'));

  const oldManifest = loadManifest(manifestFile);
  const newManifest = buildManifest(root, chunks);
  const isFirstRun = Object.keys(oldManifest.mtimes).length === 0;

  let staleRemoved = 0;
  let orphansRemoved = 0;

  if (!isFirstRun) {
    const staleIds: string[] = [];
    for (const [relPath, chunkIds] of Object.entries(oldManifest.fileChunks)) {
      const absPath = path.join(root, relPath);
      const deleted = !fs.existsSync(absPath);
      const excluded = !deleted && !(relPath in newManifest.fileChunks);
      if (deleted || excluded) {
        staleIds.push(...chunkIds);
        continue;
      }
      const oldMtime = oldManifest.mtimes[relPath];
      if (oldMtime !== undefined && fs.statSync(absPath).mtimeMs !== oldMtime) {
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

  await embedAndStore(chunks, cacheFile, root, qdrantUrl, onProgress);
  const memory = await syncProjectMemory(root, qdrantUrl);

  saveManifest(newManifest, manifestFile);

  return {
    chunks: chunks.length,
    symbols: Object.keys(graph.symbols).length,
    files: Object.keys(graph.files).length,
    staleRemoved,
    orphansRemoved,
    memoryEntries: memory.totalEntries,
    newMemoryEntries: memory.newEntries,
    staleMemoryRemoved: memory.staleRemoved,
  };
}

export { type RetrievedChunk };

export async function queryProject(
  projectRoot: string,
  question: string,
  qdrantUrl = 'http://localhost:6333'
): Promise<RetrievedChunk[]> {
  const root = path.resolve(projectRoot);
  const graphPath = path.join(getDataDir(root), 'graph.json');
  return retrieve(question, root, graphPath, qdrantUrl);
}
