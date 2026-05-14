import { getHeadCommitAsync } from '../git.js';

/**
 * Determines whether a cognition snapshot file needs to be refreshed.
 *
 * A snapshot is considered fresh when ALL of the following hold:
 *  1. The file exists on disk.
 *  2. Its `generatedAt` timestamp is within `maxAgeMs` of now.
 *  3. The HEAD commit recorded inside the snapshot matches the current HEAD
 *     (if the snapshot stores `indexedHeadSha`).
 *
 * When HEAD has not advanced and the snapshot is young, refreshes are
 * skipped — cutting the typical cold-call overhead from 6 serial refreshes
 * down to 0–1 on warm invocations of query_project / assemble_task_context.
 */

interface MinimalSnapshot {
  generatedAt?: string;
  indexedHeadSha?: string;
}

async function readSnapshotHeader(filePath: string): Promise<MinimalSnapshot | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    const raw = await file.text();
    // Only inspect the first 1024 chars — we only need the header fields.
    // Using 1024 instead of 512 to handle snapshots where generatedAt is
    // preceded by other top-level keys (e.g. large modules/dependencies arrays).
    const excerpt = raw.slice(0, 1024);
    const generatedAtMatch = excerpt.match(/"generatedAt"\s*:\s*"([^"]+)"/);
    const headShaMatch = excerpt.match(/"indexedHeadSha"\s*:\s*"([^"]+)"/);
    return {
      generatedAt: generatedAtMatch?.[1],
      indexedHeadSha: headShaMatch?.[1],
    };
  } catch {
    return null;
  }
}

/**
 * Returns `true` when the snapshot should be rebuilt, `false` when it is
 * still fresh enough to skip a refresh cycle.
 *
 * @param snapshotFile  Absolute path to the JSON snapshot file.
 * @param maxAgeMs      Maximum acceptable age in milliseconds.
 * @param projectRoot   Project root used to resolve the current HEAD sha.
 */
export async function shouldRefresh(
  snapshotFile: string,
  maxAgeMs: number,
  projectRoot: string,
): Promise<boolean> {
  const header = await readSnapshotHeader(snapshotFile);

  // File missing → always refresh.
  if (!header) return true;

  // Age check — if the snapshot is young enough, skip the HEAD comparison.
  if (header.generatedAt) {
    const age = Date.now() - Date.parse(header.generatedAt);
    if (!Number.isNaN(age) && age < maxAgeMs) return false;
  }

  // HEAD comparison — if no new commits, the snapshot is still valid even if
  // it is older than maxAgeMs (e.g. developer working without committing).
  //
  // Note: most cognition snapshots (architecture, attention, evolution, etc.)
  // do not store indexedHeadSha in their JSON, so this branch is currently
  // dormant for those files. It is active for project-intent snapshots and
  // will become more useful as other snapshots adopt HEAD tracking.
  if (header.indexedHeadSha) {
    try {
      const currentHead = await getHeadCommitAsync(projectRoot);
      // Compare the first 8 chars of both SHAs — enough to confirm same commit.
      if (currentHead && currentHead.slice(0, 8) === header.indexedHeadSha.slice(0, 8)) return false;
    } catch {
      // If git is unavailable, fall through to refresh.
    }
  }

  return true;
}

/**
 * Convenience wrapper: runs `refresh` only when `shouldRefresh` returns true.
 * Returns the result of `refresh`, or `null` if the snapshot was still fresh
 * and `load` is not provided.
 */
export async function refreshIfStale<T>(
  snapshotFile: string,
  maxAgeMs: number,
  projectRoot: string,
  refresh: () => Promise<T>,
  load?: () => Promise<T | null>,
): Promise<T | null> {
  const stale = await shouldRefresh(snapshotFile, maxAgeMs, projectRoot);
  if (stale) return refresh();
  return load ? load() : null;
}
