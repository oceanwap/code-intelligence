/**
 * test/scratchpad-security.test.ts — F1 (Sprint 5) sessionId path-traversal guard.
 *
 * Regression test for the read-only path-traversal bug found in Sprint 4 QA
 * (`session_status("../../../../package")` resolved a `.json` path outside the
 * data dir). The fix lives at the single chokepoint `scratchpadPath`, which
 * every scratchpad entry point (`append` / `read` / `clear`) routes through.
 *
 * Coverage:
 *   1. `sanitizeSessionId` rejects the empty/whitespace/`..`/separator/null-byte
 *      /over-length class with a typed `SecurityError`.
 *   2. Legitimate ids (alphanumeric, `.`, `-`, `_`) are accepted unchanged.
 *   3. `scratchpadPath` propagates the `SecurityError`.
 *   4. `appendScratchpad`, `readScratchpad`, `clearScratchpad` all propagate
 *      the `SecurityError` (no silent rename, no fallback path).
 *   5. `sessionStatusAsync` swallows the read error and returns a typed empty
 *      result — preserves FR-1 fail-typed + the existing
 *      "session_status: never throws on bad input" AC.
 *   6. The 5 Sprint 5 adversarial probes are pinned: empty, `..`, `/etc/passwd`,
 *      `a/b`, `foo\bar` all fail closed (read throws, no file outside dataDir).
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';

import {
  appendScratchpad,
  clearScratchpad,
  readScratchpad,
  sanitizeSessionId,
  scratchpadPath,
  type ScratchpadEntry,
} from '../src/cognition/blackboard/scratchpad.js';
import { sessionStatusAsync } from '../src/cognition/audit/session-status.js';
import { SecurityError } from '../src/utils/security.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectRoot(t: TestContext): string {
  const base = path.resolve(process.cwd(), '.cog-sec-tmp');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'sec-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function initGit(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: process.env });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, env: process.env });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, env: process.env });
  fs.writeFileSync(path.join(dir, '.keep'), 'placeholder');
  execFileSync('git', ['add', '.keep'], { cwd: dir, env: process.env });
  execFileSync('git', ['commit', '-m', 'init', '-q'], { cwd: dir, env: process.env });
}

// ---------------------------------------------------------------------------
// 1. sanitizeSessionId — reject class
// ---------------------------------------------------------------------------

const REJECTED_IDS: ReadonlyArray<[string, string]> = [
  ['', 'empty string'],
  ['   ', 'whitespace only'],
  ['\t\n  ', 'mixed whitespace'],
  ['..', 'parent dir'],
  ['../etc', 'parent-traversal via slash'],
  ['a/..', 'parent-traversal mid path'],
  ['/etc/passwd', 'absolute posix path'],
  ['\\etc\\passwd', 'absolute windows path'],
  ['a/b', 'forward slash segment'],
  ['foo\\bar', 'backslash segment'],
  ['good\x00bad', 'null byte injection'],
  ['a'.repeat(129), 'over 128 chars'],
  ['a'.repeat(1024), 'way over 128 chars'],
];

for (const [bad, label] of REJECTED_IDS) {
  test(`sanitizeSessionId rejects: ${label}`, () => {
    assert.throws(
      () => sanitizeSessionId(bad),
      (err: unknown) => err instanceof SecurityError,
      `expected SecurityError for ${JSON.stringify(bad)}`,
    );
  });
}

test('sanitizeSessionId rejects non-string inputs (number, null, undefined, object)', () => {
  for (const v of [42, null, undefined, {}, [], true]) {
    assert.throws(
      () => sanitizeSessionId(v),
      (err: unknown) => err instanceof SecurityError,
      `expected SecurityError for ${JSON.stringify(v)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. sanitizeSessionId — accept class (legitimate ids stay valid)
// ---------------------------------------------------------------------------

const ACCEPTED_IDS = [
  'normal',
  'with.dots',
  'with-dashes',
  'with_underscores',
  'MixedCase123',
  'a',                         // single char
  'a'.repeat(128),             // exactly the max length
  'session-2026-07-01-abc123',
  '0',
  'foo.bar.baz',
];

for (const ok of ACCEPTED_IDS) {
  test(`sanitizeSessionId accepts: ${JSON.stringify(ok).slice(0, 32)}`, () => {
    const got = sanitizeSessionId(ok);
    assert.equal(got, ok);
  });
}

// ---------------------------------------------------------------------------
// 3. scratchpadPath propagates the SecurityError
// ---------------------------------------------------------------------------

test('scratchpadPath throws SecurityError for empty / `..` / over-length ids', (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  for (const bad of ['', '   ', '..', '../etc', 'a/b', 'foo\\bar', 'a'.repeat(129)]) {
    assert.throws(
      () => scratchpadPath(bad, { projectRoot: dir }),
      (err: unknown) => err instanceof SecurityError,
      `expected SecurityError for ${JSON.stringify(bad)}`,
    );
  }
});

test('scratchpadPath builds a path inside the scratchpad dir for valid ids', (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  const p = scratchpadPath('session-1', { projectRoot: dir });
  assert.ok(p.endsWith(path.join('scratchpad', 'session-1.json')), `unexpected path: ${p}`);
  assert.ok(p.includes('.code-intelligence'), `expected .code-intelligence segment: ${p}`);
  assert.ok(!p.includes('..'), `path must not contain '..': ${p}`);
});

// ---------------------------------------------------------------------------
// 4. append/read/clear propagate SecurityError (no silent rename)
// ---------------------------------------------------------------------------

test('appendScratchpad propagates SecurityError for invalid sessionId', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  await assert.rejects(
    () =>
      appendScratchpad(
        '../escape',
        { ts: '2026-07-01T00:00:00.000Z', tool: 'x', data: {} },
        { projectRoot: dir },
      ),
    (err: unknown) => err instanceof SecurityError,
  );
  // No file should have been created anywhere in `dir` outside the data dir.
  const stray = await walkForStray(dir);
  assert.equal(stray.length, 0, `unexpected writes: ${stray.join(', ')}`);
});

test('readScratchpad propagates SecurityError for invalid sessionId', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  await assert.rejects(
    () => readScratchpad('a/b', { projectRoot: dir }),
    (err: unknown) => err instanceof SecurityError,
  );
});

test('clearScratchpad propagates SecurityError for invalid sessionId', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  await assert.rejects(
    () => clearScratchpad('foo\\bar', { projectRoot: dir }),
    (err: unknown) => err instanceof SecurityError,
  );
});

// ---------------------------------------------------------------------------
// 5. sessionStatusAsync returns typed empty on invalid sessionId (never throws)
// ---------------------------------------------------------------------------

test('session_status: invalid sessionId returns typed empty, never throws', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  for (const bad of ['', '   ', '..', '../etc', '/etc/passwd', 'a/b', 'foo\\bar', 'a'.repeat(129)]) {
    const r = await sessionStatusAsync({ projectRoot: root, sessionId: bad });
    assert.ok('data' in r, `expected ToolResult shape for ${JSON.stringify(bad)}`);
    assert.equal(r.data.empty, true, `expected empty=true for ${JSON.stringify(bad)}`);
    assert.equal(r.data.entries, 0, `expected entries=0 for ${JSON.stringify(bad)}`);
    assert.ok(
      r.signals.some((s) => s.kind === 'session_status.read_failed'),
      `expected read_failed signal for ${JSON.stringify(bad)}`,
    );
    assert.equal(r.confidence_tier, 'AMBIGUOUS');
  }
});

test('session_status: traversal probe never reads outside dataDir', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  // Place a file at <root>/package.json (one level above dataDir/.code-intel/...
  // scratchpad/). If path traversal is reintroduced, this would be the file
  // resolved by `../../../package` from inside the scratchpad dir.
  const outsideFile = path.join(root, 'package.json');
  await fsp.writeFile(outsideFile, JSON.stringify({ ts: 'evil', tool: 'sploit', data: 'PWN' }) + '\n');
  const r = await sessionStatusAsync({ projectRoot: root, sessionId: '../../../package' });
  // Must be a typed empty, never a payload derived from the outside file.
  assert.equal(r.data.empty, true);
  assert.equal(r.data.entries, 0);
  assert.equal(r.data.lastEntry, null);
  assert.notEqual(r.data.toolsUsed[0], 'sploit');
});

// ---------------------------------------------------------------------------
// 6. 5 adversarial probes — pinned for Sprint 5 sign-off
// ---------------------------------------------------------------------------

const ADVERSARIAL: ReadonlyArray<[string, string]> = [
  ['', 'empty string'],
  ['../../../etc/passwd', 'parent-traversal posix'],
  ['/etc/passwd', 'absolute posix'],
  ['a/b', 'forward slash segment'],
  ['foo\\bar', 'backslash segment'],
];

for (const [probe, label] of ADVERSARIAL) {
  test(`adversarial probe: session_status(${JSON.stringify(probe)}) — ${label}`, async (t) => {
    const root = makeProjectRoot(t);
    initGit(root);
    const r = await sessionStatusAsync({ projectRoot: root, sessionId: probe });
    // Never throws; returns typed empty.
    assert.ok('data' in r);
    assert.equal(r.data.empty, true);
    assert.equal(r.data.entries, 0);
    assert.equal(r.data.lastUpdated, null);
    assert.equal(r.data.lastEntry, null);
    assert.deepEqual(r.data.toolsUsed, []);
    assert.deepEqual(r.data.topSymbols, []);
  });
}

// ---------------------------------------------------------------------------
// Helpers (local)
// ---------------------------------------------------------------------------

async function walkForStray(root: string): Promise<string[]> {
  const found: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        stack.push(p);
      } else if (e.isFile()) {
        // The only file outside .code-intelligence the tmpdir should contain
        // is the .keep placeholder written by initGit. Anything else is a
        // stray write caused by path traversal.
        if (e.name === '.keep') continue;
        // The data dir may legitimately have files; this is for a fresh tmp.
        if (p.includes('.code-intelligence')) continue;
        found.push(p);
      }
    }
  }
  return found;
}

// Re-export to satisfy linters that warn on unused imports.
export type { ScratchpadEntry };
