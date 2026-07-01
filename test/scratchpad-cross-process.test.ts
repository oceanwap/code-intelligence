/**
 * test/scratchpad-cross-process.test.ts — F3 cross-process regression test.
 *
 * Pins the F3 contract: `appendScratchpad` is safe under multi-process
 * contention on the same sessionId. The in-process mutex (Q2 fix, commit
 * 4b273f7) only covers a single Node/Bun process; VS Code multi-window,
 * HTTP transport mode, and `spawn('bun cli')` + MCP server over stdio can
 * each run in their own process and would race the same `<sessionId>.json`.
 *
 * The F3 fix wraps each append in a `proper-lockfile` advisory flock
 * keyed on the sibling `<sessionId>.lock` directory. POSIX `mkdir` is the
 * atomic primitive; the lock file is a DIRECTORY (not a regular file)
 * that the holder creates on acquire and removes on release.
 *
 * Contract under test:
 *   Open two child bun processes. Each writes 10 × >4 KB appends to
 *   the same sessionId. Parent joins, then `readScratchpad` reports
 *   EXACTLY 20 valid entries with both processes' markers and no garbage.
 *
 * If the cross-process lock is missing, the two children race the
 * kernel buffer: writes above PIPE_BUF (1024 B macOS, 4096 B Linux)
 * interleave byte-for-byte and `readScratchpad` loses entries or
 * returns malformed lines (the line-skip malformed handling would
 * silently drop them, and `entries.length < 20`).
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import test, { type TestContext } from 'node:test';

import {
  appendScratchpad,
  clearScratchpad,
  readScratchpad,
  type ScratchpadEntry,
} from '../src/cognition/blackboard/scratchpad.js';

const BUN_PATH = process.execPath; // bun is what we're running under; reuse it
const WORKER_SCRIPT = path.join(import.meta.dir, 'scratchpad-cross-process-worker.mjs');

function makeProjectRoot(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cog-cp-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function initGit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, env: process.env });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, env: process.env });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, env: process.env });
  fs.writeFileSync(path.join(dir, '.keep'), 'placeholder');
  execFileSync('git', ['add', '.keep'], { cwd: dir, env: process.env });
  execFileSync('git', ['commit', '-m', 'init', '-q'], { cwd: dir, env: process.env });
}

/** Spawn one child worker. Returns a Promise that resolves when the child exits. */
function spawnChild(projectRoot: string, sessionId: string, marker: string): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(BUN_PATH, [WORKER_SCRIPT], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PROJECT_ROOT: projectRoot,
        SESSION_ID: sessionId,
        MARKER: marker,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ stdout, stderr, status: code ?? 0 }));
  });
}

test('appendScratchpad: cross-process — 2 children × 10 >4 KB appends → exactly 20 valid entries (F3)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const sessionId = 'audit:cross-process-test';
  await clearScratchpad(sessionId, { projectRoot: root });

  // Sanity: parent process can already append via the same code path.
  // This guards against false positives in the child processes below
  // (e.g. if `readScratchpad` itself were broken, the parent would
  // also fail).
  const parentEntry: ScratchpadEntry = {
    ts: new Date().toISOString(),
    tool: 'parent-sanity',
    data: { marker: 'PARENT-SANITY' },
  };
  await appendScratchpad(sessionId, parentEntry, { projectRoot: root });
  await clearScratchpad(sessionId, { projectRoot: root });

  // Spawn two children CONCURRENTLY. Each writes 10 × >4 KB appends to
  // the same sessionId. The cross-process advisory lock must serialize
  // them — without it the two children's writes interleave at the
  // kernel buffer and `readScratchpad` silently drops torn lines.
  const [childA, childB] = await Promise.all([
    spawnChild(root, sessionId, 'PROC-A'),
    spawnChild(root, sessionId, 'PROC-B'),
  ]);
  assert.equal(childA.status, 0, `child A failed: ${childA.stderr}`);
  assert.equal(childB.status, 0, `child B failed: ${childB.stderr}`);

  // Each child reports what it wrote via JSON; sanity check the
  // children wrote what we asked them to.
  const aReport = JSON.parse(childA.stdout.trim()) as { marker: string; wrote: number };
  const bReport = JSON.parse(childB.stdout.trim()) as { marker: string; wrote: number };
  assert.equal(aReport.marker, 'PROC-A');
  assert.equal(aReport.wrote, 10, `child A reported writing ${aReport.wrote} entries, expected 10`);
  assert.equal(bReport.marker, 'PROC-B');
  assert.equal(bReport.wrote, 10, `child B reported writing ${bReport.wrote} entries, expected 10`);

  // Parent joins: read the scratchpad back. With the F3 cross-process
  // lock in place, every line round-trips as valid JSON; without it,
  // the read would silently drop interleaved bytes as malformed lines.
  const entries = await readScratchpad(sessionId, { projectRoot: root });
  assert.equal(entries.length, 20, `expected 20 entries, got ${entries.length} — entries were lost to a cross-process race (F3 regression)`);

  // Both processes' markers must be present (no process silently dropped).
  const markers = entries
    .map(entry => (entry.data as { marker?: string }).marker)
    .filter((m): m is string => typeof m === 'string');
  const procACount = markers.filter(m => m === 'PROC-A').length;
  const procBCount = markers.filter(m => m === 'PROC-B').length;
  assert.equal(procACount, 10, `expected 10 PROC-A markers, got ${procACount}`);
  assert.equal(procBCount, 10, `expected 10 PROC-B markers, got ${procBCount}`);

  // Every entry is a valid ScratchpadEntry — no garbage lines survived
  // (the line-skip malformed handling would have silently dropped them,
  // so 20-entries-without-garbage is the success signal).
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    assert.equal(typeof e.ts, 'string', `entry ${i}: ts is not a string (likely a partial write)`);
    assert.equal(typeof e.tool, 'string', `entry ${i}: tool is not a string`);
    assert.ok(e.data != null, `entry ${i}: data is null (likely garbage from a torn write)`);
  }
});