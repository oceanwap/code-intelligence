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
 * Concurrency — TWO LAYERS:
 *
 *   1. In-process mutex (Q2 fix, commit 4b273f7): every `appendScratchpad`
 *      call chains onto the previous tail promise for that sessionId, so
 *      concurrent calls on the same sessionId within one process execute
 *      strictly sequentially. Different sessionIds do not contend.
 *      Rationale: POSIX `write(2)` is atomic only for buffers <= PIPE_BUF
 *      (1024 B macOS, 4096 B Linux). Larger writes can interleave
 *      byte-for-byte across overlapping async calls even on `O_APPEND`
 *      descriptors; the chain keeps the open→write→fsync→close sequence
 *      atomic per sessionId within one process.
 *
 *   2. Cross-process advisory lock (Sprint 6a F3 fix): the in-process
 *      mutex does NOT cover multi-process races (VS Code multi-window,
 *      HTTP transport mode, `spawn('bun cli')` + MCP server over stdio
 *      sharing the same `<sessionId>.json`). Layer (1) is bypassed when
 *      the two writers are in different processes. We wrap the per-call
 *      doAppend in a `proper-lockfile` flock keyed on the sibling
 *      `<sessionId>.lock` file. `proper-lockfile` (MIT, ~3 KB, no native
 *      bindings) provides exponential-backoff retries with a hard
 *      stale-timeout (default 10s). The advisory lock sits INSIDE the
 *      in-process chain so single-process callers still get the fast
 *      zero-fsync-contention path; the cross-process layer is what
 *      serializes across process boundaries.
 *
 * Lock acquisition contract (CRITICAL):
 *   - `sanitizeSessionId(sessionId)` is called EAGERLY before either
 *     layer is acquired. A rejected sessionId throws synchronously with
 *     `SecurityError` — no I/O happens, no lock is taken. This preserves
 *     the F1 security contract from Sprint 5 hardening (the eager-sync
 *     rule that lets `appendScratchpad('../escape', ...)` reject without
 *     ever opening a file).
 *   - Lock acquisition runs INSIDE the in-process chain, so the chain
 *     tail waits for both the previous in-process call AND any prior
 *     cross-process holder before opening the file.
 *   - Lock files are pre-touched (idempotent `O_CREAT`) before
 *     `lockfile.lock` so `lockfile.unlock` can `lstat` the target on
 *     release. Without the pre-touch, `unlock` ENOENTs on a fresh
 *     scratchpad. The touch is a single fsync-less write, costs ~one
 *     syscall.
 *
 * readScratchpad does NOT take a lock: POSIX `read(2)` is safe alongside
 * `O_APPEND` writers for any single entry <= PIPE_BUF, and our existing
 * line-skip malformed handling (see `safeScratchpadReviver`) covers any
 * oversize entries that happen to interleave. Locking reads would add a
 * cross-process synchronization point on every read with no correctness
 * benefit.
 *
 * This is intentionally minimal: no rotation, no indexing. The scratchpad
 * is per-session, single-writer-per-session across processes; locking is
 * the append path's job.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { getDataDir } from '../../git.js';
import { SecurityError } from '../../utils/security.js';

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

/** Maximum length of a sessionId, in characters. Bounds path length. */
const SESSION_ID_MAX_LENGTH = 128;

/**
 * Reject any sessionId that could escape the scratchpad directory.
 *
 * A sessionId is appended to the data dir as `<sessionId>.json`. To keep the
 * resolved path inside the data dir, the id must NOT contain:
 *   - path separators (`/` or `\`)
 *   - null bytes (`\x00`)
 *   - the `..` parent-dir segment (as the whole string or any path segment)
 *
 * Also rejects empty/whitespace strings and ids longer than 128 chars. Throws
 * `SecurityError` on rejection so callers (and the MCP tool layer) can map
 * the failure to a typed, fail-loud response.
 */
export function sanitizeSessionId(sessionId: unknown): string {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.trim().length === 0) {
    throw new SecurityError('scratchpad: sessionId must be a non-empty string');
  }
  if (sessionId.length > SESSION_ID_MAX_LENGTH) {
    throw new SecurityError(
      `scratchpad: sessionId exceeds max length of ${SESSION_ID_MAX_LENGTH} characters`,
    );
  }
  // Reject path separators and null bytes in a single pass.
  if (/[\/\\\x00]/.test(sessionId)) {
    throw new SecurityError(
      'scratchpad: sessionId contains a forbidden path separator or null byte',
    );
  }
  // Reject `..` as a path segment (defense in depth — bare `..` is the only
  // remaining way to reach a parent directory after the separator check).
  if (sessionId === '..' || sessionId.split(/[\/\\]/).includes('..')) {
    throw new SecurityError('scratchpad: sessionId contains a forbidden ".." segment');
  }
  return sessionId;
}

/**
 * Compute the scratchpad file path for a given session.
 *
 * The branch segment uses the project's current git branch (per `getDataDir`).
 * Tests may pass `projectRoot` to avoid touching the real `.code-intelligence`.
 *
 * The sessionId is sanitized at the single chokepoint: every entry point
 * (append/read/clear) routes through this function, so path-traversal
 * rejection is centralized.
 */
export function scratchpadPath(sessionId: string, opts?: ScratchpadOptions): string {
  const safe = sanitizeSessionId(sessionId);
  const root = opts?.projectRoot ?? process.cwd();
  const dataDir = getDataDir(root);
  return path.join(dataDir, 'scratchpad', `${safe}.json`);
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
      // FIX F11: apply the safe reviver so tagged non-JSON values
      // (Buffer, BigInt, Map, Set) are restored to their original
      // types. The previous implementation called JSON.parse with no
      // reviver, leaving tagged shapes as plain objects and silently
      // breaking the round-trip contract.
      entries.push(JSON.parse(trimmed, safeScratchpadReviver) as ScratchpadEntry);
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
 *
 * FIX F11: route the entry through a JSON-safe replacer so non-JSON-native
 * values (Buffer, BigInt, Map, Set, function) are tagged and stringified
 * before write. The reader below reverses the tags via a reviver. The
 * previous implementation called `JSON.stringify(payload)` directly,
 * which silently dropped these fields and broke round-trip equality.
 *
 * FIX Q2: serialize concurrent calls on the same sessionId via a per-id
 * promise chain. POSIX `write(2)` is atomic only for buffers <= PIPE_BUF
 * (1024 B macOS, 4096 B Linux); larger writes can interleave byte-for-byte
 * across processes, and even within a single process two overlapping
 * `await fs.open(...)` + `await fh.write(...)` calls would race the
 * kernel buffer. The mutex makes the open→write→fsync→close sequence
 * strictly sequential per sessionId within one process.
 *
 * FIX F3 (Sprint 6a review-wave): wrap the chain tail in a cross-process
 * advisory file lock keyed on a `<sessionId>.lock` sibling file. The
 * in-process mutex above does NOT cover multi-process races (VS Code
 * multi-window, HTTP transport, `spawn('bun cli')` + MCP server over
 * stdio sharing the same sessionId). The advisory lock sits INSIDE the
 * chain so single-process callers still get fast sequential execution;
 * the cross-process layer serializes across process boundaries.
 */
export async function appendScratchpad(sessionId: string, entry: ScratchpadEntry, opts?: ScratchpadOptions): Promise<void> {
  // Per-sessionId serialization. See module header for the rationale.
  // The previous tail promise (or a resolved sentinel) is awaited before
  // the new tail's `doAppend` runs; the new tail is published as the next
  // "previous" for whoever comes after.
  //
  // Sanitize eagerly so a SecurityError throws synchronously, matching the
  // pre-mutex contract. (Sanitization is pure; calling it here is safe and
  // matches the test that expects `appendScratchpad('../escape', ...)` to
  // reject with SecurityError without ever opening a file.) The lock is
  // acquired LATER, inside the chain — so a rejected sessionId never
  // touches the filesystem or takes a lock.
  sanitizeSessionId(sessionId);

  const previous = appendMutex.get(sessionId) ?? Promise.resolve();
  const next = previous.then(() => doAppendWithLock(sessionId, entry, opts));
  appendMutex.set(sessionId, next);
  // Best-effort cleanup: once this append settles, if no later caller has
  // replaced us in the map, drop the entry so the map doesn't grow
  // unbounded across long-lived processes. The `.then(onFulfilled,
  // onRejected)` form is intentional: it gives us a settled-cleanup
  // Promise that we can `void` without creating an unhandled-rejection
  // trail when `next` rejects (which would surface as a logged
  // SecurityError even though the original `await appendScratchpad(...)`
  // already saw the rejection).
  void next.then(
    () => cleanupMutexEntry(sessionId, next),
    () => cleanupMutexEntry(sessionId, next),
  );
  return next;
}

function cleanupMutexEntry(sessionId: string, tail: Promise<unknown>): void {
  if (appendMutex.get(sessionId) === tail) {
    appendMutex.delete(sessionId);
  }
}

/**
 * Cross-process advisory lock wrapper around `doAppend`.
 *
 * `proper-lockfile` uses `mkdir` as the atomic lock primitive — the
 * sibling `<file>.lock` path is created as a DIRECTORY, not a regular
 * file. We do NOT pre-touch it: pre-touching as a regular file would
 * cause `mkdir` to fail with EEXIST and proper-lockfile would report
 * "Lock file is already being held" on the very first call. The lock
 * directory is created on lock acquire and removed on release.
 *
 * Acquires the lock with exponential-backoff retries (~5 s total) and
 * a 10 s stale timeout (force-take on a crashed holder). `realpath:
 * false` lets us lock before the scratchpad file exists (the first
 * append creates the file inside `doAppend` via `fs.open(file, 'a')`).
 */
async function doAppendWithLock(sessionId: string, entry: ScratchpadEntry, opts?: ScratchpadOptions): Promise<void> {
  const file = scratchpadPath(sessionId, opts);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const release = await lockfile.lock(file, {
    realpath: false,
    stale: 10_000,
    retries: { retries: 50, factor: 1.2, minTimeout: 10, maxTimeout: 100 },
  });
  try {
    await doAppend(sessionId, entry, opts);
  } finally {
    await release();
  }
}

/**
 * The actual append, factored out so `appendScratchpad` can serialize it
 * via the per-sessionId promise chain without a recursive `await`.
 */
async function doAppend(sessionId: string, entry: ScratchpadEntry, opts?: ScratchpadOptions): Promise<void> {
  const file = scratchpadPath(sessionId, opts);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const fh = await fs.open(file, 'a');
  try {
    const payload = entry.sessionId == null ? { ...entry, sessionId } : entry;
    await fh.write(JSON.stringify(payload, safeScratchpadReplacer) + '\n');
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Per-sessionId serialization queue for `appendScratchpad`.
 *
 * Each entry is the tail promise of the chain; the next call awaits the
 * previous tail before its own `doAppend` runs. The map entry is dropped
 * once the tail settles and no later caller has replaced it (best-effort
 * cleanup). Memory cost: O(active concurrent sessionIds).
 *
 * Module-level state. Not exported.
 */
const appendMutex = new Map<string, Promise<unknown>>();

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

// ---------------------------------------------------------------------------
// FIX F11: JSON-safe round-trip helpers.
//
// The scratchpad is a JSON append-log. JSON.stringify drops Buffer / BigInt /
// Map / Set / function values silently — the previous behaviour was that
// `data: { buf: Buffer.from('x') }` round-tripped to `data: { buf: {} }`.
// We tag non-JSON values via a replacer on write, and untag them on read
// via a reviver. Tagged shapes are stable: `{ __type: 'Buffer', data: <base64> }`
// for Buffer, `{ __type: 'BigInt', value: '<decimal>' }` for BigInt,
// `{ __type: 'Map', value: Array<[k, v]> }` for Map, and
// `{ __type: 'Set', value: Array<v> }` for Set. Functions are dropped with
// a warning-shaped sentinel (we never want to round-trip a function in
// serialized state).
// ---------------------------------------------------------------------------

/** Public for tests: shape of a tagged non-JSON value. */
export interface TaggedScratchpadValue {
  __type: 'Buffer' | 'BigInt' | 'Map' | 'Set';
  data?: string;
  value?: string | unknown[];
}

/**
 * Public for tests. Pre-process a value for JSON.stringify so that
 * Buffer / BigInt / Map / Set / function values are tagged recursively.
 *
 * JSON.stringify's replacer argument is only invoked for the top-level
 * value and the direct properties of the top-level value — it is NOT
 * called for nested properties of nested objects. That means a plain
 * replacer misses `data.buf: Buffer` (Buffer is one level deeper). This
 * function recursively walks the input and tags non-JSON-native values
 * at every depth, so JSON.stringify sees a fully-safe object.
 */
export function safeScratchpadReplacer(_key: string, rawValue: unknown): unknown {
  if (rawValue == null) return rawValue;
  if (typeof rawValue === 'bigint') {
    return { __type: 'BigInt', value: rawValue.toString() } satisfies TaggedScratchpadValue;
  }
  if (isBufferLike(rawValue)) {
    return {
      __type: 'Buffer',
      data: rawValue.toString('base64'),
    } satisfies TaggedScratchpadValue;
  }
  if (rawValue instanceof Map) {
    return {
      __type: 'Map',
      value: Array.from(rawValue.entries()).map(([k, v]) => [tagValueForSerialize(k), tagValueForSerialize(v)]),
    } satisfies TaggedScratchpadValue;
  }
  if (rawValue instanceof Set) {
    return {
      __type: 'Set',
      value: Array.from(rawValue.values()).map(tagValueForSerialize),
    } satisfies TaggedScratchpadValue;
  }
  if (typeof rawValue === 'function') {
    // Drop functions entirely. The caller is expected to serialize any
    // function-shaped value before writing; a function in the scratchpad
    // is a contract violation.
    return undefined;
  }
  // Recurse into plain objects + arrays so nested non-JSON values
  // are tagged too. JSON.stringify's replacer is shallow; we make
  // up for that by walking the structure here.
  if (Array.isArray(rawValue)) {
    return rawValue.map(tagValueForSerialize);
  }
  if (typeof rawValue === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawValue as Record<string, unknown>)) {
      out[k] = tagValueForSerialize(v);
    }
    return out;
  }
  return rawValue;
}

/**
 * Recursive helper used by `safeScratchpadReplacer` to pre-tag values
 * at every depth. The function returns a fresh value (or the original
 * if it is JSON-safe), so the input is not mutated.
 */
function tagValueForSerialize(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'bigint') {
    return { __type: 'BigInt', value: value.toString() } satisfies TaggedScratchpadValue;
  }
  if (isBufferLike(value)) {
    return { __type: 'Buffer', data: value.toString('base64') } satisfies TaggedScratchpadValue;
  }
  if (value instanceof Map) {
    return {
      __type: 'Map',
      value: Array.from(value.entries()).map(([k, v]) => [tagValueForSerialize(k), tagValueForSerialize(v)]),
    } satisfies TaggedScratchpadValue;
  }
  if (value instanceof Set) {
    return {
      __type: 'Set',
      value: Array.from(value.values()).map(tagValueForSerialize),
    } satisfies TaggedScratchpadValue;
  }
  if (typeof value === 'function') {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map(tagValueForSerialize);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = tagValueForSerialize(v);
    }
    return out;
  }
  return value;
}

/** Public for tests. */
export function safeScratchpadReviver(_key: string, rawValue: unknown): unknown {
  if (rawValue == null || typeof rawValue !== 'object') return rawValue;
  const obj = rawValue as Record<string, unknown>;
  if (obj['__type'] === 'Buffer' && typeof obj['data'] === 'string') {
    return Buffer.from(obj['data'], 'base64');
  }
  if (obj['__type'] === 'BigInt' && typeof obj['value'] === 'string') {
    return BigInt(obj['value']);
  }
  if (obj['__type'] === 'Map' && Array.isArray(obj['value'])) {
    return new Map(obj['value'] as Array<[unknown, unknown]>);
  }
  if (obj['__type'] === 'Set' && Array.isArray(obj['value'])) {
    return new Set(obj['value'] as unknown[]);
  }
  return rawValue;
}

function isBufferLike(value: unknown): value is Buffer {
  return typeof Buffer !== 'undefined'
    && typeof value === 'object'
    && value !== null
    && (value instanceof Buffer
      || (typeof (value as { toString?: unknown }).toString === 'function'
        && (value as { constructor?: { name?: string } }).constructor?.name === 'Buffer'));
}