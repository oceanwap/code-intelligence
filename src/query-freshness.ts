import * as path from 'path';
import { getDataDir, getLineCommitHistoryAsync, type GitLineRange } from './git.js';
import { loadManifestAsync } from './indexer.js';

export interface SliceHistoryMatch {
  sha: string;
  title: string;
  timestamp: string;
  authorName: string;
  changedLines: GitLineRange[];
}

export interface RetrievedSliceFreshness {
  sliceStartLine: number | null;
  sliceEndLine: number | null;
  indexRefreshedAt: string | null;
  indexedFileMtimeMs: number | null;
  currentFileMtimeMs: number | null;
  latestChange: SliceHistoryMatch | null;
  needsReindex: boolean;
  reasons: string[];
}

export async function getRetrievedSliceFreshnessAsync(
  projectRoot: string,
  file: string,
  lineStart: number | null | undefined,
  lineEnd: number | null | undefined
): Promise<RetrievedSliceFreshness> {
  const root = path.resolve(projectRoot);
  const dataDir = getDataDir(root);
  const manifestFile = path.join(dataDir, 'manifest.json');
  const manifest = await loadManifestAsync(manifestFile);
  const absFile = path.join(root, file);

  let currentFileMtimeMs: number | null = null;
  try {
    if (await Bun.file(absFile).exists()) {
      currentFileMtimeMs = Bun.file(absFile).lastModified;
    }
  } catch {
    currentFileMtimeMs = null;
  }

  const indexedFileMtimeMs = manifest.mtimes[file] ?? null;

  let manifestIndexedAt = manifest.indexedAt ?? null;
  if (!manifestIndexedAt) {
    try {
      if (await Bun.file(manifestFile).exists()) {
        manifestIndexedAt = new Date(Bun.file(manifestFile).lastModified).toISOString();
      }
    } catch {
      manifestIndexedAt = null;
    }
  }

  const manifestIndexedAtMs = manifestIndexedAt ? Date.parse(manifestIndexedAt) : null;
  const latestChange = lineStart && lineEnd
    ? await findLatestSliceChangeAsync(root, file, lineStart, lineEnd)
    : null;

  const reasons: string[] = [];
  if (!manifestIndexedAt) {
    reasons.push('code index refresh time is unavailable');
  }
  if (currentFileMtimeMs !== null && indexedFileMtimeMs !== null && currentFileMtimeMs > indexedFileMtimeMs + 1) {
    reasons.push('file changed after this code slice was indexed');
  }
  if (latestChange?.sha === '0000000000000000000000000000000000000000') {
    reasons.push('slice contains uncommitted lines');
  }
  if (latestChange && manifestIndexedAtMs !== null) {
    const latestChangeMs = Date.parse(latestChange.timestamp);
    if (Number.isFinite(latestChangeMs) && latestChangeMs > manifestIndexedAtMs) {
      reasons.push('latest slice change is newer than this code slice index');
    }
  }

  return {
    sliceStartLine: lineStart ?? null,
    sliceEndLine: lineEnd ?? null,
    indexRefreshedAt: manifestIndexedAt,
    indexedFileMtimeMs,
    currentFileMtimeMs,
    latestChange,
    needsReindex: reasons.length > 0,
    reasons,
  };
}

async function findLatestSliceChangeAsync(projectRoot: string, file: string, lineStart: number, lineEnd: number): Promise<SliceHistoryMatch | null> {
  const match = (await getLineCommitHistoryAsync(projectRoot, file, lineStart, lineEnd))[0];
  if (!match) return null;
  return {
    sha: match.sha,
    title: match.summary,
    timestamp: match.authoredAt,
    authorName: match.authorName,
    changedLines: match.lineRanges,
  };
}