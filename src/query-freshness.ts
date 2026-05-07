import * as fs from 'fs';
import * as path from 'path';
import { getDataDir, getLineCommitHistory, type GitLineRange } from './git.js';
import { loadManifest } from './indexer.js';

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

export function getRetrievedSliceFreshness(
  projectRoot: string,
  file: string,
  lineStart: number | null | undefined,
  lineEnd: number | null | undefined
): RetrievedSliceFreshness {
  const root = path.resolve(projectRoot);
  const dataDir = getDataDir(root);
  const manifestFile = path.join(dataDir, 'manifest.json');
  const manifest = loadManifest(manifestFile);
  const absFile = path.join(root, file);
  const currentFileMtimeMs = fs.existsSync(absFile) ? fs.statSync(absFile).mtimeMs : null;
  const indexedFileMtimeMs = manifest.mtimes[file] ?? null;
  const manifestIndexedAt = manifest.indexedAt
    ?? (fs.existsSync(manifestFile) ? fs.statSync(manifestFile).mtime.toISOString() : null);
  const manifestIndexedAtMs = manifestIndexedAt ? Date.parse(manifestIndexedAt) : null;
  const latestChange = lineStart && lineEnd
    ? findLatestSliceChange(root, file, lineStart, lineEnd)
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

function findLatestSliceChange(projectRoot: string, file: string, lineStart: number, lineEnd: number): SliceHistoryMatch | null {
  const match = getLineCommitHistory(projectRoot, file, lineStart, lineEnd)[0];
  if (!match) return null;
  return {
    sha: match.sha,
    title: match.summary,
    timestamp: match.authoredAt,
    authorName: match.authorName,
    changedLines: match.lineRanges,
  };
}