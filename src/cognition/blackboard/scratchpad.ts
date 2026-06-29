/**
 * blackboard/scratchpad — per-session append-log with fsync.
 *
 * Storage layout (PRD FR-3):
 *   .code-intelligence/<branch>/scratchpad/<sessionId>.json
 *
 * Semantics:
 *   - The file is a JSON append-log. Each line is a `JSON.stringify(entry)`
 *     followed by `\n`.
 *   - Every write calls `fh.sync()` (fsync) before closing the handle so the
 *     data survives a crash.
 *   - No in-process cache. Reads always re-open the file.
 *   - `clearScratchpad` removes the file. Idempotent — no error if absent.
 *
 * This is intentionally minimal: no locking, no rotation, no indexing. The
 * scratchpad is per-session, single-writer; locking is the caller's job.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getDataDir } from '../../git.js';

export interface ScratchpadEntry {
  ts: string;
  tool: string;
  data: unknown;
  reasoning?: string[];
  confidence_tier?: string;
  sessionId?: string;
}

export interface ScratchpadOptions {
  /** Override the project root data dir (testing only). */
  projectRoot?: string;
}

/**
 * Compute the scratchpad file path for a given session.
 *
 * The branch segment uses the project's current git branch (per `getDataDir`).
 * Tests may pass `projectRoot` to avoid touching the real `.code-intelligence`.
 */
export function scratchpadPath(sessionId: string, opts?: ScratchpadOptions): string {
  if (!sessionId || !sessionId.trim()) {
    throw new Error('scratchpad: sessionId must be a non-empty string');
  }
  const root = opts?.projectRoot ?? process.cwd();
  const dataDir = getDataDir(root);
  return path.join(dataDir, 'scratchpad', `${sessionId}.json`);
}

/**
 * Read all entries from a session's scratchpad.
 *
 * Returns `[]` if the file does not exist. Bad lines are skipped (the file is
 * append-only; a partial write before a crash should not break a read).
 */
export async function readScratchpad(sessionId: string, opts?: ScratchpadOptions): Promise<ScratchpadEntry[]> {
  const file = scratchpadPath(sessionId, opts);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries: ScratchpadEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ScratchpadEntry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

/**
 * Append a single entry to the session's scratchpad, fsync'd to disk.
 *
 * Creates the directory recursively. Opens the file in append mode, writes the
 * entry followed by a newline, fsyncs, and closes. No in-process cache.
 */
export async function appendScratchpad(sessionId: string, entry: ScratchpadEntry, opts?: ScratchpadOptions): Promise<void> {
  const file = scratchpadPath(sessionId, opts);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const fh = await fs.open(file, 'a');
  try {
    const payload = entry.sessionId == null ? { ...entry, sessionId } : entry;
    await fh.write(JSON.stringify(payload) + '\n');
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Remove the scratchpad file for a session. Idempotent — succeeds even if the
 * file does not exist.
 */
export async function clearScratchpad(sessionId: string, opts?: ScratchpadOptions): Promise<void> {
  const file = scratchpadPath(sessionId, opts);
  try {
    await fs.unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}