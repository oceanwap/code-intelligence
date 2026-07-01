/**
 * test/recommend-cooccur.test.ts — US-006 P4 recommend co-occurrence.
 *
 * Covers (PRD US-006 / OQ-4 acceptance criteria):
 *   1. Empty scratchpad → cold-start default list with score=0.5.
 *   2. Co-occurrence counts from a single session (a → b pairs).
 *   3. Co-occurrence ranks descending by count.
 *   4. Top score is normalized to 1.0 (score in [0,1]).
 *   5. Tie-break by tool name asc (deterministic).
 *   6. topN caps the result length.
 *   7. candidatePool restricts the candidate set.
 *   8. Cold start restricted by candidatePool returns the intersection.
 *   9. Co-occurrence is order-sensitive: (a, b) counts but (b, a) does not.
 *  10. Non-consecutive entries do not count (a, c, b → no count for b).
 *  11. sessionId option restricts the scan to one session.
 *  12. recommendNextAsync is deterministic for a fixed scratchpad.
 *  13. recommendNextAsync with no current tool returns [].
 *  14. recommendNextAsync never throws on bad input.
 *  15. Multi-session scan aggregates counts across sessions.
 *  16. coldStartDefault returns the curated default list.
 *  17. score is in [0,1] for every recommendation.
 *  18. cooccurrenceCount is always a non-negative integer.
 *  19. Empty candidatePool + non-empty scratchpad → returns from cooccurrence only.
 *  20. Output schema is well-typed (Recommendation has tool, score, cooccurrenceCount).
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';

import {
  recommendNextAsync,
  coldStartDefault,
  type Recommendation,
} from '../src/cognition/recommend/cooccur.js';
import { appendScratchpad, readScratchpad } from '../src/cognition/blackboard/scratchpad.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectRoot(t: TestContext): string {
  const base = path.resolve(process.cwd(), '.cog-rec-tmp');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'rec-'));
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

async function writeSession(
  projectRoot: string,
  sessionId: string,
  tools: string[],
): Promise<void> {
  for (const tool of tools) {
    await appendScratchpad(sessionId, {
      ts: new Date().toISOString(),
      tool,
      data: {},
      sessionId,
    }, { projectRoot });
  }
}

// ---------------------------------------------------------------------------
// 1. Cold start
// ---------------------------------------------------------------------------

test('recommend: empty scratchpad → cold-start default with score=0.5', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const recs = await recommendNextAsync('audit_symbol', { projectRoot: root });
  assert.ok(recs.length > 0, 'cold-start must return at least one tool');
  for (const r of recs) {
    assert.equal(r.score, 0.5);
    assert.equal(r.cooccurrenceCount, 0);
  }
});

test('recommend: cold-start list is the curated default', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const recs = await recommendNextAsync('audit_symbol', { projectRoot: root, topN: 100 });
  const tools = recs.map((r) => r.tool);
  assert.deepEqual(tools, coldStartDefault());
});

// ---------------------------------------------------------------------------
// 2. Co-occurrence counts
// ---------------------------------------------------------------------------

test('recommend: co-occurrence counts from a single session (a → b)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeSession(root, 's1', ['audit_symbol', 'trace_workflow', 'audit_symbol', 'trace_workflow']);
  const recs = await recommendNextAsync('audit_symbol', { projectRoot: root, sessionId: 's1' });
  const trace = recs.find((r) => r.tool === 'trace_workflow');
  assert.ok(trace);
  assert.equal(trace?.cooccurrenceCount, 2);
});

test('recommend: ranks descending by co-occurrence count', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeSession(root, 's1', [
    'audit_symbol', 'trace_workflow', // 1 trace
    'audit_symbol', 'plan_refactor', // 1 plan
    'audit_symbol', 'trace_workflow', // 2 trace
    'audit_symbol', 'plan_refactor', // 2 plan
    'audit_symbol', 'trace_workflow', // 3 trace
  ]);
  const recs = await recommendNextAsync('audit_symbol', { projectRoot: root, sessionId: 's1' });
  assert.equal(recs[0]?.tool, 'trace_workflow');
  assert.equal(recs[0]?.cooccurrenceCount, 3);
  assert.equal(recs[1]?.tool, 'plan_refactor');
  assert.equal(recs[1]?.cooccurrenceCount, 2);
});

// ---------------------------------------------------------------------------
// 3-4. Score normalization
// ---------------------------------------------------------------------------

test('recommend: top score is normalized to 1.0', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeSession(root, 's1', [
    'audit_symbol', 'trace_workflow',
    'audit_symbol', 'trace_workflow',
    'audit_symbol', 'trace_workflow',
    'audit_symbol', 'plan_refactor',
  ]);
  const recs = await recommendNextAsync('audit_symbol', { projectRoot: root, sessionId: 's1' });
  assert.equal(recs[0]?.score, 1.0);
  assert.ok(recs[1]?.score !== undefined && recs[1].score < 1.0);
});

test('recommend: score is always in [0,1]', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeSession(root, 's1', ['a', 'b', 'a', 'b', 'a', 'c']);
  const recs = await recommendNextAsync('a', { projectRoot: root, sessionId: 's1' });
  for (const r of recs) {
    assert.ok(r.score >= 0 && r.score <= 1, `score out of range: ${r.score}`);
  }
});

// ---------------------------------------------------------------------------
// 5. Tie-break deterministic
// ---------------------------------------------------------------------------

test('recommend: tie-breaks by tool name asc', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeSession(root, 's1', [
    'a', 'z',
    'a', 'a', // self-loop: counts but should be tie-equal to other zero? no — same count
    'a', 'm',
  ]);
  // a → z (1), a → a (1), a → m (1). All tied at 1. Order should be a, m, z (ascending).
  const recs = await recommendNextAsync('a', { projectRoot: root, sessionId: 's1' });
  const names = recs.map((r) => r.tool);
  // The first 3 should be in ascending order
  assert.equal(names[0], 'a');
  assert.equal(names[1], 'm');
  assert.equal(names[2], 'z');
});

// ---------------------------------------------------------------------------
// 6. topN cap
// ---------------------------------------------------------------------------

test('recommend: topN caps the result length', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const tools: string[] = [];
  for (let i = 0; i < 10; i++) {
    tools.push('a', `b${i}`);
  }
  await writeSession(root, 's1', tools);
  const recs = await recommendNextAsync('a', { projectRoot: root, sessionId: 's1', topN: 3 });
  assert.equal(recs.length, 3);
});

// ---------------------------------------------------------------------------
// 7-8. candidatePool
// ---------------------------------------------------------------------------

test('recommend: candidatePool restricts the candidate set', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeSession(root, 's1', [
    'a', 'b',
    'a', 'c',
    'a', 'd',
  ]);
  const recs = await recommendNextAsync('a', {
    projectRoot: root,
    sessionId: 's1',
    candidatePool: ['b', 'd'],
  });
  const tools = recs.map((r) => r.tool);
  assert.ok(!tools.includes('c'));
  assert.ok(tools.includes('b'));
  assert.ok(tools.includes('d'));
});

test('recommend: candidatePool + cold start returns the intersection', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const recs = await recommendNextAsync('audit_symbol', {
    projectRoot: root,
    candidatePool: ['audit_symbol', 'trace_workflow'],
    topN: 10,
  });
  const tools = recs.map((r) => r.tool);
  assert.ok(tools.includes('audit_symbol'));
  assert.ok(tools.includes('trace_workflow'));
});

// ---------------------------------------------------------------------------
// 9. Order-sensitive co-occurrence
// ---------------------------------------------------------------------------

test('recommend: order-sensitive — (a, b) counts but (b, a) does not', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeSession(root, 's1', ['a', 'b']);
  const ab = await recommendNextAsync('a', { projectRoot: root, sessionId: 's1' });
  // Looking up the LAST tool in the session: nothing follows, so we fall
  // back to the cold-start list (length 4 by default).
  const ba = await recommendNextAsync('b', { projectRoot: root, sessionId: 's1' });
  assert.equal(ab[0]?.tool, 'b');
  assert.equal(ab[0]?.cooccurrenceCount, 1);
  // ba is the cold-start default (no cooccurrence data for b → X).
  assert.ok(ba.length > 0);
  assert.equal(ba[0]?.cooccurrenceCount, 0);
});

// ---------------------------------------------------------------------------
// 10. Non-consecutive pairs do not count
// ---------------------------------------------------------------------------

test('recommend: non-consecutive pairs do not count (a, c, b → b not after a)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeSession(root, 's1', ['a', 'c', 'b']);
  const recs = await recommendNextAsync('a', { projectRoot: root, sessionId: 's1' });
  // Only `c` should be counted (it immediately follows `a`); `b` does not.
  assert.equal(recs[0]?.tool, 'c');
  assert.equal(recs[0]?.cooccurrenceCount, 1);
  assert.ok(!recs.some((r) => r.tool === 'b'));
});

// ---------------------------------------------------------------------------
// 11. sessionId option
// ---------------------------------------------------------------------------

test('recommend: sessionId option restricts the scan to one session', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeSession(root, 's1', ['a', 'b']);
  await writeSession(root, 's2', ['a', 'c']);
  // Single-session scan returns only the b count
  const single = await recommendNextAsync('a', { projectRoot: root, sessionId: 's1' });
  assert.equal(single[0]?.tool, 'b');
  // Multi-session scan aggregates both
  const multi = await recommendNextAsync('a', { projectRoot: root });
  const tools = multi.map((r) => r.tool);
  assert.ok(tools.includes('b'));
  assert.ok(tools.includes('c'));
});

// ---------------------------------------------------------------------------
// 12. Determinism
// ---------------------------------------------------------------------------

test('recommend: deterministic for a fixed scratchpad', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeSession(root, 's1', ['a', 'b', 'a', 'c', 'a', 'b']);
  const r1 = await recommendNextAsync('a', { projectRoot: root, sessionId: 's1' });
  const r2 = await recommendNextAsync('a', { projectRoot: root, sessionId: 's1' });
  assert.deepEqual(r1, r2);
});

// ---------------------------------------------------------------------------
// 13-14. Edge cases
// ---------------------------------------------------------------------------

test('recommend: empty currentTool returns []', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const r = await recommendNextAsync('', { projectRoot: root });
  assert.deepEqual(r, []);
});

test('recommend: never throws on bad input', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  // Various edge cases
  for (const cur of ['', '   ', 'a', 'audit_symbol', 'x'.repeat(1000)]) {
    const r = await recommendNextAsync(cur, { projectRoot: root });
    assert.ok(Array.isArray(r));
  }
});

// ---------------------------------------------------------------------------
// 15. Multi-session aggregation
// ---------------------------------------------------------------------------

test('recommend: multi-session scan aggregates counts across sessions', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeSession(root, 's1', ['a', 'b', 'a', 'b']);
  await writeSession(root, 's2', ['a', 'b']);
  const recs = await recommendNextAsync('a', { projectRoot: root });
  const b = recs.find((r) => r.tool === 'b');
  assert.equal(b?.cooccurrenceCount, 3);
});

// ---------------------------------------------------------------------------
// 16. coldStartDefault
// ---------------------------------------------------------------------------

test('coldStartDefault: returns the curated default list', () => {
  const list = coldStartDefault();
  assert.ok(list.length >= 3);
  assert.ok(list.includes('audit_symbol'));
  assert.ok(list.includes('trace_workflow'));
});

// ---------------------------------------------------------------------------
// 17-18. Score invariants
// ---------------------------------------------------------------------------

test('recommend: every score in [0,1]', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeSession(root, 's1', ['a', 'b', 'a', 'b', 'a', 'b', 'a', 'c']);
  const recs = await recommendNextAsync('a', { projectRoot: root, sessionId: 's1' });
  for (const r of recs) {
    assert.ok(r.score >= 0 && r.score <= 1);
  }
});

test('recommend: cooccurrenceCount is always a non-negative integer', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeSession(root, 's1', ['a', 'b', 'a', 'b']);
  const recs = await recommendNextAsync('a', { projectRoot: root, sessionId: 's1' });
  for (const r of recs) {
    assert.equal(typeof r.cooccurrenceCount, 'number');
    assert.ok(Number.isInteger(r.cooccurrenceCount));
    assert.ok(r.cooccurrenceCount >= 0);
  }
});

// ---------------------------------------------------------------------------
// 19. Empty pool + non-empty scratchpad
// ---------------------------------------------------------------------------

test('recommend: empty candidatePool + non-empty scratchpad → cooccurrence only', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeSession(root, 's1', ['a', 'b']);
  const recs = await recommendNextAsync('a', { projectRoot: root, sessionId: 's1', candidatePool: [] });
  // Empty pool = no candidates. Recs should be empty (or only from cooccurrence filtered to empty).
  // Behavior: filter empties the list. Confirm the contract.
  assert.equal(recs.length, 0);
});

// ---------------------------------------------------------------------------
// 20. Output schema well-typed
// ---------------------------------------------------------------------------

test('recommend: output schema is well-typed (tool, score, cooccurrenceCount)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const recs: Recommendation[] = await recommendNextAsync('a', { projectRoot: root });
  for (const r of recs) {
    assert.equal(typeof r.tool, 'string');
    assert.equal(typeof r.score, 'number');
    assert.equal(typeof r.cooccurrenceCount, 'number');
  }
});
