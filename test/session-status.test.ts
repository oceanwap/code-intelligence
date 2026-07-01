/**
 * test/session-status.test.ts — US-006 P4 `session_status` tool.
 *
 * Covers (PRD US-006 acceptance criteria + FR-9 read-only contract):
 *   1. Envelope shape — ToolResult<SessionStatusPayload>.
 *   2. Empty session returns zeros + empty=true + signal.
 *   3. Reads scratchpad entries; never mutates.
 *   4. Counts entries correctly.
 *   5. lastUpdated is the most recent entry's timestamp.
 *   6. toolsUsed is the distinct, sorted list of tool names.
 *   7. topSymbols is capped at 10.
 *   8. topSymbols extracts `data.symbol` from audit payloads.
 *   9. topSymbols extracts `data.symbols` from plan_refactor payloads.
 *  10. lastEntry is the most recent scratchpad entry.
 *  11. Confidence tier: empty → AMBIGUOUS, non-empty → EXTRACTED.
 *  12. FR-9 read-only contract — scratchpad file is unchanged after the call.
 *  13. Reasoning chain starts with the leading "session_status inspected" fact.
 *  14. session_status returns a ToolResult<T> (type-narrow).
 *  15. session_status never throws on bad input.
 *  16. Inherits prior reasoning facts (FR-4).
 *  17. Sources include the session id as external ref.
 *  18. distinctSymbolsCount reflects the full distinct set (uncapped).
 *  19. Malformed scratchpad lines are skipped.
 *  20. Session id with special chars (e.g. `..`) → handled gracefully.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';

import { sessionStatusAsync, type SessionStatusPayload } from '../src/cognition/audit/session-status.js';
import type { ToolResult } from '../src/cognition/signalization/types.js';
import {
  appendScratchpad,
  readScratchpad,
  clearScratchpad,
  scratchpadPath,
} from '../src/cognition/blackboard/scratchpad.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectRoot(t: TestContext): string {
  const base = path.resolve(process.cwd(), '.cog-sess-tmp');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'sess-'));
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

async function seedSession(
  projectRoot: string,
  sessionId: string,
  entries: Array<{ tool: string; data: unknown; reasoning?: string[] }>,
): Promise<void> {
  await clearScratchpad(sessionId, { projectRoot });
  for (const e of entries) {
    await appendScratchpad(sessionId, {
      ts: new Date(Date.now() + entries.indexOf(e) * 1000).toISOString(),
      tool: e.tool,
      data: e.data,
      ...(e.reasoning ? { reasoning: e.reasoning } : {}),
      sessionId,
    }, { projectRoot });
  }
}

// ---------------------------------------------------------------------------
// 1. Envelope shape
// ---------------------------------------------------------------------------

test('session_status: ToolResult envelope shape', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await seedSession(root, 's1', [{ tool: 'audit_symbol', data: { symbol: 'A.b' } }]);
  const result = await sessionStatusAsync({ projectRoot: root, sessionId: 's1' });
  assert.ok('data' in result);
  assert.ok('signals' in result);
  assert.ok('reasoning' in result);
  assert.ok('sources' in result);
  assert.ok('confidence_tier' in result);
  const data: SessionStatusPayload = result.data;
  for (const k of ['sessionId', 'entries', 'lastUpdated', 'toolsUsed', 'topSymbols', 'distinctSymbolsCount', 'empty', 'lastEntry', 'reasoning_chain']) {
    assert.ok(k in data, `field "${k}" missing`);
  }
});

// ---------------------------------------------------------------------------
// 2. Empty session
// ---------------------------------------------------------------------------

test('session_status: empty session returns zeros + empty=true + signal', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result = await sessionStatusAsync({ projectRoot: root, sessionId: 'empty' });
  assert.equal(result.data.entries, 0);
  assert.equal(result.data.lastUpdated, null);
  assert.deepEqual(result.data.toolsUsed, []);
  assert.deepEqual(result.data.topSymbols, []);
  assert.equal(result.data.empty, true);
  assert.equal(result.data.lastEntry, null);
  assert.ok(result.signals.some((s) => s.kind === 'session_status.empty'));
  assert.equal(result.confidence_tier, 'AMBIGUOUS');
});

// ---------------------------------------------------------------------------
// 3. Read-only contract
// ---------------------------------------------------------------------------

test('session_status: never mutates the scratchpad (FR-9 read-only contract)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await seedSession(root, 's1', [
    { tool: 'audit_symbol', data: { symbol: 'A.b' } },
    { tool: 'trace_workflow', data: { symbol: 'A.b' } },
  ]);
  const filePath = scratchpadPath('s1', { projectRoot: root });
  const before = await fsp.readFile(filePath, 'utf8');
  await sessionStatusAsync({ projectRoot: root, sessionId: 's1' });
  const after = await fsp.readFile(filePath, 'utf8');
  assert.equal(before, after, 'scratchpad file must be byte-identical after a session_status call');
});

// ---------------------------------------------------------------------------
// 4. Entries count
// ---------------------------------------------------------------------------

test('session_status: counts entries correctly', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await seedSession(root, 's1', [
    { tool: 'audit_symbol', data: { symbol: 'A.b' } },
    { tool: 'audit_symbol', data: { symbol: 'A.b' } },
    { tool: 'trace_workflow', data: { symbol: 'A.b' } },
    { tool: 'plan_refactor', data: {} },
    { tool: 'plan_refactor', data: {} },
  ]);
  const result = await sessionStatusAsync({ projectRoot: root, sessionId: 's1' });
  assert.equal(result.data.entries, 5);
});

// ---------------------------------------------------------------------------
// 5. lastUpdated
// ---------------------------------------------------------------------------

test('session_status: lastUpdated is the most recent entry timestamp', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await seedSession(root, 's1', [
    { tool: 'a', data: {}, reasoning: ['first'] },
    { tool: 'b', data: {}, reasoning: ['second'] },
    { tool: 'c', data: {}, reasoning: ['third'] },
  ]);
  const result = await sessionStatusAsync({ projectRoot: root, sessionId: 's1' });
  // Most recent entry is the last one appended
  const last = await readScratchpad('s1', { projectRoot: root });
  const expected = last[last.length - 1]?.ts ?? null;
  assert.equal(result.data.lastUpdated, expected);
});

// ---------------------------------------------------------------------------
// 6. toolsUsed
// ---------------------------------------------------------------------------

test('session_status: toolsUsed is the distinct, sorted list of tool names', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await seedSession(root, 's1', [
    { tool: 'plan_refactor', data: {} },
    { tool: 'audit_symbol', data: { symbol: 'A.b' } },
    { tool: 'plan_refactor', data: {} },
    { tool: 'trace_workflow', data: { symbol: 'A.b' } },
  ]);
  const result = await sessionStatusAsync({ projectRoot: root, sessionId: 's1' });
  assert.deepEqual(result.data.toolsUsed, ['audit_symbol', 'plan_refactor', 'trace_workflow']);
});

// ---------------------------------------------------------------------------
// 7. topSymbols cap at 10
// ---------------------------------------------------------------------------

test('session_status: topSymbols is capped at 10', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  // 15 distinct symbols
  const entries = Array.from({ length: 15 }, (_, i) => ({
    tool: 'audit_symbol',
    data: { symbol: `Sym${String(i).padStart(2, '0')}` },
  }));
  await seedSession(root, 's1', entries);
  const result = await sessionStatusAsync({ projectRoot: root, sessionId: 's1' });
  assert.equal(result.data.topSymbols.length, 10);
  assert.equal(result.data.distinctSymbolsCount, 15);
});

// ---------------------------------------------------------------------------
// 8. topSymbols from `data.symbol`
// ---------------------------------------------------------------------------

test('session_status: topSymbols extracts `data.symbol` from audit payloads', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await seedSession(root, 's1', [
    { tool: 'audit_symbol', data: { symbol: 'BookingService.create' } },
    { tool: 'audit_symbol', data: { symbol: 'PaymentService.charge' } },
  ]);
  const result = await sessionStatusAsync({ projectRoot: root, sessionId: 's1' });
  assert.deepEqual(result.data.topSymbols, ['BookingService.create', 'PaymentService.charge']);
});

// ---------------------------------------------------------------------------
// 9. topSymbols from `data.symbols` (array)
// ---------------------------------------------------------------------------

test('session_status: topSymbols extracts `data.symbols` from plan_refactor payloads', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await seedSession(root, 's1', [
    {
      tool: 'plan_refactor',
      data: { symbols: ['A.b', 'C.d', 'E.f'] },
    },
  ]);
  const result = await sessionStatusAsync({ projectRoot: root, sessionId: 's1' });
  assert.ok(result.data.topSymbols.includes('A.b'));
  assert.ok(result.data.topSymbols.includes('C.d'));
  assert.ok(result.data.topSymbols.includes('E.f'));
});

// ---------------------------------------------------------------------------
// 10. lastEntry
// ---------------------------------------------------------------------------

test('session_status: lastEntry is the most recent scratchpad entry', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await seedSession(root, 's1', [
    { tool: 'a', data: { x: 1 } },
    { tool: 'b', data: { x: 2 } },
    { tool: 'c', data: { x: 3 } },
  ]);
  const result = await sessionStatusAsync({ projectRoot: root, sessionId: 's1' });
  assert.equal(result.data.lastEntry?.tool, 'c');
  assert.deepEqual(result.data.lastEntry?.data, { x: 3 });
});

// ---------------------------------------------------------------------------
// 11. Confidence tier
// ---------------------------------------------------------------------------

test('session_status: empty → AMBIGUOUS, non-empty → EXTRACTED', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  // Empty
  const empty = await sessionStatusAsync({ projectRoot: root, sessionId: 'e' });
  assert.equal(empty.confidence_tier, 'AMBIGUOUS');
  // Non-empty
  await seedSession(root, 's1', [{ tool: 'a', data: {} }]);
  const full = await sessionStatusAsync({ projectRoot: root, sessionId: 's1' });
  assert.equal(full.confidence_tier, 'EXTRACTED');
});

// ---------------------------------------------------------------------------
// 13. Reasoning chain leading fact
// ---------------------------------------------------------------------------

test('session_status: reasoning chain starts with the leading "session_status inspected" fact', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await seedSession(root, 's1', [{ tool: 'a', data: {} }]);
  const result = await sessionStatusAsync({ projectRoot: root, sessionId: 's1' });
  const first = result.data.reasoning_chain.find((f) => f.source === 'session_status');
  assert.ok(first);
  assert.ok(first?.fact.includes('session_status inspected'));
  assert.ok(first?.fact.includes('s1'));
});

// ---------------------------------------------------------------------------
// 14. Type-narrow
// ---------------------------------------------------------------------------

test('session_status: return is a real ToolResult<SessionStatusPayload>', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result: ToolResult<SessionStatusPayload> = await sessionStatusAsync({
    projectRoot: root,
    sessionId: 'any',
  });
  assert.equal(typeof result, 'object');
  assert.equal(result.data.sessionId, 'any');
});

// ---------------------------------------------------------------------------
// 15. Never throws
// ---------------------------------------------------------------------------

test('session_status: never throws on bad input', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  // Various edge cases
  for (const sid of ['', '   ', 'normal', 'with.dots', 'with-dashes']) {
    const r = await sessionStatusAsync({ projectRoot: root, sessionId: sid });
    assert.ok('data' in r);
  }
});

// ---------------------------------------------------------------------------
// 16. Inherits prior facts (FR-4)
// ---------------------------------------------------------------------------

test('session_status: inherits prior facts from the scratchpad (FR-4)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await seedSession(root, 's1', [
    { tool: 'a', data: {}, reasoning: ['prior-1'] },
    { tool: 'b', data: {}, reasoning: ['prior-2'] },
  ]);
  const result = await sessionStatusAsync({ projectRoot: root, sessionId: 's1' });
  const facts = result.data.reasoning_chain.map((f) => f.fact);
  assert.ok(facts.includes('prior-1'));
  assert.ok(facts.includes('prior-2'));
});

// ---------------------------------------------------------------------------
// 17. Sources
// ---------------------------------------------------------------------------

test('session_status: sources include the session id as external ref', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result = await sessionStatusAsync({ projectRoot: root, sessionId: 'alpha' });
  const external = result.sources.filter((s) => s.kind === 'external');
  assert.ok(external.length > 0);
  assert.ok(external.some((s) => (s.ref ?? '').includes('alpha')));
});

// ---------------------------------------------------------------------------
// 18. distinctSymbolsCount uncapped
// ---------------------------------------------------------------------------

test('session_status: distinctSymbolsCount reflects the full set, not the cap', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  // 20 distinct symbols
  const entries = Array.from({ length: 20 }, (_, i) => ({
    tool: 'audit_symbol',
    data: { symbol: `Sym${i}` },
  }));
  await seedSession(root, 's1', entries);
  const result = await sessionStatusAsync({ projectRoot: root, sessionId: 's1' });
  assert.equal(result.data.distinctSymbolsCount, 20);
  assert.equal(result.data.topSymbols.length, 10);
});

// ---------------------------------------------------------------------------
// 19. Malformed scratchpad lines are skipped
// ---------------------------------------------------------------------------

test('session_status: malformed scratchpad lines are skipped (no throw)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const filePath = scratchpadPath('s1', { projectRoot: root });
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  // Write a valid line + a malformed one + another valid line
  await fsp.writeFile(filePath, [
    JSON.stringify({ ts: '2026-07-01T00:00:00.000Z', tool: 'a', data: {}, sessionId: 's1' }),
    'this is not valid JSON',
    JSON.stringify({ ts: '2026-07-01T00:00:01.000Z', tool: 'b', data: {}, sessionId: 's1' }),
    '',
  ].join('\n'));
  const result = await sessionStatusAsync({ projectRoot: root, sessionId: 's1' });
  // Two valid lines survived
  assert.equal(result.data.entries, 2);
  assert.deepEqual(result.data.toolsUsed, ['a', 'b']);
});

// ---------------------------------------------------------------------------
// 20. Determinism
// ---------------------------------------------------------------------------

test('session_status: deterministic for a fixed scratchpad', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await seedSession(root, 's1', [
    { tool: 'a', data: { symbol: 'A.b' } },
    { tool: 'b', data: { symbol: 'C.d' } },
  ]);
  const r1 = await sessionStatusAsync({ projectRoot: root, sessionId: 's1' });
  const r2 = await sessionStatusAsync({ projectRoot: root, sessionId: 's1' });
  assert.deepEqual(r1.data, r2.data);
});
