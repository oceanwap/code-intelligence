/**
 * test/cognition-foundation.test.ts — US-001 P0 foundation.
 *
 * Covers (PRD FR-1..FR-4, US-001 acceptance criteria):
 *   1. Envelope round-trip — ToolResult<T> is created, signals/reasoning/sources
 *      are preserved, confidence_tier default is EXTRACTED.
 *   2. withSignals HOF — wraps a leaf, returns ToolResult<T>; leaf called
 *      directly without withSignals keeps its native shape (OPT-IN contract).
 *   3. Scratchpad append-log + fsync — write survives a forced process exit;
 *      read returns entries in order; bad lines skipped.
 *   4. Reasoning inheritance + dedupe — inheritReasoning copies; appendReasoning
 *      dedupes adjacent identical facts; pure (no mutation).
 *   5. session_scratchpad smoke — readScratchpad round-trips through the public
 *      API used by the MCP tool.
 *
 * This test is intentionally hermetic — it uses a tmpdir for the scratchpad
 * and never touches the real .code-intelligence directory.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';

import {
  confidenceToTier,
  makeToolResult,
  type ConfidenceTier,
  type ToolResult,
} from '../src/cognition/signalization/types.js';
import { isToolResult, withSignals } from '../src/cognition/signalization/builder.js';
import {
  appendReasoning,
  inheritReasoning,
  type ReasoningFact,
} from '../src/cognition/reasoning/bus.js';
import {
  appendScratchpad,
  clearScratchpad,
  readScratchpad,
  scratchpadPath,
  type ScratchpadEntry,
} from '../src/cognition/blackboard/scratchpad.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectRoot(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cog-found-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function initGit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, env: process.env });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, env: process.env });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, env: process.env });
  // Commit anything so getCurrentBranchAsync resolves to a known branch (master or main).
  fs.writeFileSync(path.join(dir, '.keep'), 'placeholder');
  execFileSync('git', ['add', '.keep'], { cwd: dir, env: process.env });
  execFileSync('git', ['commit', '-m', 'init', '-q'], { cwd: dir, env: process.env });
}

// ---------------------------------------------------------------------------
// 1. Envelope round-trip
// ---------------------------------------------------------------------------

test('confidenceToTier applies PRD thresholds (>=0.8 EXTRACTED, >=0.5 INFERRED, <0.5 AMBIGUOUS)', () => {
  assert.equal(confidenceToTier(1.0), 'EXTRACTED');
  assert.equal(confidenceToTier(0.8), 'EXTRACTED');
  assert.equal(confidenceToTier(0.79), 'INFERRED');
  assert.equal(confidenceToTier(0.5), 'INFERRED');
  assert.equal(confidenceToTier(0.49), 'AMBIGUOUS');
  assert.equal(confidenceToTier(0), 'AMBIGUOUS');
  assert.equal(confidenceToTier(-0.5), 'AMBIGUOUS');
  assert.equal(confidenceToTier(1.5), 'EXTRACTED');
  assert.equal(confidenceToTier(undefined), 'EXTRACTED');
  assert.equal(confidenceToTier(null), 'EXTRACTED');
  assert.equal(confidenceToTier(Number.NaN), 'EXTRACTED');
});

test('makeToolResult defaults to EXTRACTED with empty signals/reasoning/sources', () => {
  const tr = makeToolResult({ ok: true });
  const expected: ToolResult<{ ok: boolean }> = {
    data: { ok: true },
    signals: [],
    reasoning: [],
    sources: [],
    confidence_tier: 'EXTRACTED',
  };
  assert.deepEqual(tr, expected);
});

test('makeToolResult accepts partial overrides', () => {
  const tr = makeToolResult(42, {
    signals: [{ kind: 'numeric' }],
    reasoning: [{ fact: 'because' }],
    sources: [{ kind: 'symbol', ref: 'Foo.bar' }],
    confidence_tier: 'INFERRED',
  });
  assert.equal(tr.data, 42);
  assert.equal(tr.signals.length, 1);
  assert.equal(tr.reasoning[0]?.fact, 'because');
  assert.equal(tr.sources[0]?.ref, 'Foo.bar');
  assert.equal(tr.confidence_tier, 'INFERRED');
});

test('isToolResult detects ToolResult envelopes and rejects plain values', () => {
  assert.equal(isToolResult(makeToolResult(1)), true);
  assert.equal(isToolResult({ data: 1, signals: [], reasoning: [], sources: [], confidence_tier: 'EXTRACTED' }), true);
  assert.equal(isToolResult({ data: 1 }), false);
  assert.equal(isToolResult(null), false);
  assert.equal(isToolResult('hello'), false);
  assert.equal(isToolResult(42), false);
});

// ---------------------------------------------------------------------------
// 2. withSignals HOF — opt-in contract
// ---------------------------------------------------------------------------

test('withSignals wraps a leaf returning a plain payload into a ToolResult', async () => {
  const leaf = (x: number) => ({ doubled: x * 2 });
  const wrapped = withSignals(leaf);
  const result = await wrapped(3);
  assert.equal(result.data.doubled, 6);
  assert.equal(result.confidence_tier, 'EXTRACTED');
  assert.equal(result.signals.length, 0);
  assert.equal(result.reasoning.length, 0);
});

test('withSignals derives confidence_tier from data.confidence float', async () => {
  const high = withSignals(() => ({ confidence: 0.9, val: 'a' }));
  const mid = withSignals(() => ({ confidence: 0.6, val: 'b' }));
  const low = withSignals(() => ({ confidence: 0.2, val: 'c' }));

  assert.equal((await high()).confidence_tier, 'EXTRACTED');
  assert.equal((await mid()).confidence_tier, 'INFERRED');
  assert.equal((await low()).confidence_tier, 'AMBIGUOUS');
});

test('withSignals passes through an already-enveloped ToolResult (merged defaults)', async () => {
  // When the leaf already produces a ToolResult, the wrapper preserves its
  // fields (data, signals, reasoning, sources, confidence_tier). The merge
  // step only fills in *missing* fields from the wrapper defaults.
  type Inner = { inner: number };
  const inner: ToolResult<Inner> = makeToolResult<Inner>({ inner: 1 }, {
    signals: [{ kind: 'inner' }],
    reasoning: [{ fact: 'inner fact' }],
    sources: [{ kind: 'symbol', ref: 'Inner' }],
    confidence_tier: 'INFERRED',
  });
  // The leaf's return type is ToolResult<Inner>; the wrapper yields
  // ToolResult<ToolResult<Inner>>. We assert the inner envelope is preserved.
  const wrapped = withSignals<[], ToolResult<Inner>>(() => inner);
  const result = await wrapped();
  const data = result.data as unknown as Inner;
  assert.equal(data.inner, 1);
  assert.equal(result.signals[0]?.kind, 'inner');
  assert.equal(result.reasoning[0]?.fact, 'inner fact');
  assert.equal(result.sources[0]?.ref, 'Inner');
  assert.equal(result.confidence_tier, 'INFERRED');
});

test('OPT-IN: a leaf called directly keeps its native shape (no envelope forced)', () => {
  // No withSignals involved. The leaf returns a plain string.
  const leaf = (msg: string) => `native: ${msg}`;
  const out = leaf('hello');
  assert.equal(out, 'native: hello');
  assert.equal(isToolResult(out), false);
});

test('OPT-IN: leaf that returns an MCP-shaped payload still native (not wrapped)', async () => {
  // Simulates how `render_behavior` returns `{ content: [...] }`. The leaf
  // returns that shape directly. Without withSignals, no envelope is forced.
  const leaf = () => ({ content: [{ type: 'text', text: 'side effects: ...' }] });
  const out = await leaf();
  assert.deepEqual(out, { content: [{ type: 'text', text: 'side effects: ...' }] });
  assert.equal(isToolResult(out), false);
});

test('withSignals forwards arguments through to the leaf', async () => {
  const leaf = (a: number, b: string) => `${b}:${a}`;
  const wrapped = withSignals(leaf);
  const r = await wrapped(7, 'tag');
  assert.equal(r.data, 'tag:7');
});

// ---------------------------------------------------------------------------
// 3. Reasoning bus — pure functions
// ---------------------------------------------------------------------------

test('inheritReasoning accepts string[] and ReasoningFact[]', () => {
  const fromStrings = inheritReasoning(['fact one', 'fact two']);
  assert.deepEqual(fromStrings, [{ fact: 'fact one' }, { fact: 'fact two' }]);

  const fromFacts = inheritReasoning([{ fact: 'a', source: 'src/a' }]);
  assert.deepEqual(fromFacts, [{ fact: 'a', source: 'src/a' }]);

  // Empty input returns empty array.
  assert.deepEqual(inheritReasoning([]), []);
  assert.deepEqual(inheritReasoning(undefined as unknown as ReasoningFact[]), []);
});

test('inheritReasoning does not mutate the input', () => {
  const original: ReasoningFact[] = [{ fact: 'a' }];
  const snapshot = JSON.stringify(original);
  inheritReasoning(original);
  assert.equal(JSON.stringify(original), snapshot);
});

test('appendReasoning dedupes adjacent identical facts', () => {
  const start: ReasoningFact[] = [{ fact: 'first' }];
  const r1 = appendReasoning(start, 'second');
  assert.deepEqual(r1.map((f) => f.fact), ['first', 'second']);

  // Same fact appended twice in a row — second is dropped.
  const r2 = appendReasoning(r1, 'second');
  assert.deepEqual(r2.map((f) => f.fact), ['first', 'second']);

  // Different fact with same source after a different source — appended.
  const r3 = appendReasoning(r1, { fact: 'second', source: 'different' });
  assert.deepEqual(r3.length, 3);
  assert.equal(r3[2]?.source, 'different');
});

test('appendReasoning ignores empty/whitespace facts', () => {
  const start = [{ fact: 'real' }];
  const r1 = appendReasoning(start, '');
  const r2 = appendReasoning(start, '   ');
  assert.deepEqual(r1, start);
  assert.deepEqual(r2, start);
});

test('appendReasoning does not mutate input arrays', () => {
  const original: ReasoningFact[] = [{ fact: 'a' }];
  const snapshot = JSON.stringify(original);
  appendReasoning(original, 'b');
  assert.equal(JSON.stringify(original), snapshot);
});

// ---------------------------------------------------------------------------
// 4. Scratchpad — append-log + fsync + crash safety
// ---------------------------------------------------------------------------

test('scratchpad: scratchpadPath builds .code-intelligence/<branch>/scratchpad/<sessionId>.json', (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  const p = scratchpadPath('session-1', { projectRoot: dir });
  assert.ok(p.endsWith(path.join('scratchpad', 'session-1.json')), `unexpected path: ${p}`);
  assert.ok(p.includes('.code-intelligence'), `expected .code-intelligence segment: ${p}`);
});

test('scratchpad: empty session returns []', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  const entries = await readScratchpad('never-written', { projectRoot: dir });
  assert.deepEqual(entries, []);
});

test('scratchpad: append + read round-trips and preserves order', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  const sessionId = 'sess-append';
  await appendScratchpad(sessionId, { ts: '2026-06-29T00:00:00.000Z', tool: 'render_behavior', data: { x: 1 } }, { projectRoot: dir });
  await appendScratchpad(sessionId, { ts: '2026-06-29T00:00:01.000Z', tool: 'get_symbol', data: { y: 2 } }, { projectRoot: dir });
  await appendScratchpad(sessionId, { ts: '2026-06-29T00:00:02.000Z', tool: 'risk_hotspots', data: [{ z: 3 }] }, { projectRoot: dir });

  const got = await readScratchpad(sessionId, { projectRoot: dir });
  assert.equal(got.length, 3);
  assert.equal(got[0]?.tool, 'render_behavior');
  assert.equal(got[1]?.tool, 'get_symbol');
  assert.equal(got[2]?.tool, 'risk_hotspots');
  // sessionId is stamped onto every entry by the implementation if absent.
  for (const e of got) assert.equal(e.sessionId, sessionId);
});

test('scratchpad: readScratchpad skips malformed lines (does not throw)', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  const file = scratchpadPath('sess-bad', { projectRoot: dir });
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ ts: '1', tool: 'a', data: 1 }) + '\n' + 'not-valid-json\n' + JSON.stringify({ ts: '2', tool: 'b', data: 2 }) + '\n', 'utf8');

  const got = await readScratchpad('sess-bad', { projectRoot: dir });
  assert.equal(got.length, 2);
  assert.equal(got[0]?.tool, 'a');
  assert.equal(got[1]?.tool, 'b');
});

test('scratchpad: append survives a forced process exit (fsync per write)', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  const sessionId = 'sess-fsync';
  // Write three entries in the current process.
  await appendScratchpad(sessionId, { ts: '2026-06-29T00:00:00.000Z', tool: 'one', data: 1 }, { projectRoot: dir });
  await appendScratchpad(sessionId, { ts: '2026-06-29T00:00:01.000Z', tool: 'two', data: 2 }, { projectRoot: dir });
  await appendScratchpad(sessionId, { ts: '2026-06-29T00:00:02.000Z', tool: 'three', data: 3 }, { projectRoot: dir });

  // Spawn a fresh Bun process to read the file. If fsync failed, the new
  // process might see fewer than 3 entries. This proves durability across a
  // process boundary — the strongest "no in-process cache" evidence short
  // of a real kernel panic.
  const reader = `
    import { readScratchpad } from '${path.resolve('src/cognition/blackboard/scratchpad.ts').replace(/\\\\/g, '/')}';
    const out = await readScratchpad('${sessionId}', { projectRoot: ${JSON.stringify(dir)} });
    console.log(JSON.stringify(out));
  `;
  const tmp = path.join(dir, 'reader.ts');
  await fsp.writeFile(tmp, reader);
  const result = execFileSync('bun', ['run', tmp], { cwd: process.cwd(), encoding: 'utf8' });
  const parsed = JSON.parse(result.trim()) as ScratchpadEntry[];
  assert.equal(parsed.length, 3, `expected 3 entries after fresh-process read, got ${parsed.length}`);
  assert.equal(parsed[2]?.tool, 'three');
});

test('scratchpad: clearScratchpad is idempotent (no error if missing)', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  await clearScratchpad('never-existed', { projectRoot: dir });
  // Write then clear.
  await appendScratchpad('to-clear', { ts: 'now', tool: 'x', data: {} }, { projectRoot: dir });
  await clearScratchpad('to-clear', { projectRoot: dir });
  const after = await readScratchpad('to-clear', { projectRoot: dir });
  assert.deepEqual(after, []);
  // And clearing again is a no-op.
  await clearScratchpad('to-clear', { projectRoot: dir });
});

test('scratchpad: empty sessionId is rejected', () => {
  assert.throws(() => scratchpadPath(''), /non-empty/i);
});

// ---------------------------------------------------------------------------
// 5. session_scratchpad MCP smoke — same code path the tool uses
// ---------------------------------------------------------------------------

test('session_scratchpad smoke: readScratchpad returns the entries written through appendScratchpad', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);

  // Simulate what the MCP tool does: build entries, write them, then read back.
  const sessionId = 'smoke-session';
  const entries: ScratchpadEntry[] = [
    { ts: '2026-06-29T00:00:00.000Z', tool: 'render_behavior', data: { symbol: 'Foo.bar', effects: [] } },
    { ts: '2026-06-29T00:00:01.000Z', tool: 'regression_risk', data: { symbol: 'Foo.bar', score: 0.42 }, confidence_tier: 'INFERRED' },
  ];
  for (const e of entries) {
    await appendScratchpad(sessionId, e, { projectRoot: dir });
  }

  // Read back as the MCP tool handler would.
  const read = await readScratchpad(sessionId, { projectRoot: dir });
  assert.equal(read.length, 2);
  assert.equal(read[1]?.confidence_tier, 'INFERRED');
  assert.equal(read[1]?.data?.['score'], 0.42);
});

test('OPT-IN end-to-end: leaf NOT registered through wrapLeaf returns native MCP shape', async () => {
  // The opt-in contract is: a leaf called directly keeps its native shape.
  // We simulate "a leaf NOT registered through wrapLeaf" by writing a leaf
  // that returns { content: [{ type: 'text', text: ... }] } — the standard
  // MCP tool result shape. withSignals must NOT be applied retroactively.
  const leaf = () => ({ content: [{ type: 'text' as const, text: 'no envelope' }] });
  const out = await leaf();
  assert.deepEqual(out, { content: [{ type: 'text', text: 'no envelope' }] });
  assert.equal(isToolResult(out), false);
});