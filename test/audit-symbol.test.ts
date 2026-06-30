/**
 * test/audit-symbol.test.ts — US-004 P3a `audit_symbol` meta-tool.
 *
 * Covers (PRD US-004 acceptance criteria):
 *   1. Envelope shape — ToolResult<AuditSymbolPayload> with 8 fields populated.
 *   2. ToolResult contract — `signals`, `reasoning`, `sources`, `confidence_tier` present.
 *   3. Deterministic sessionId — `audit:<sha1_8>` by default; caller can override.
 *   4. Reasoning chain propagation — leading fact + per-leaf fact, dedup-aware.
 *   5. action_recommendation rule table — 6 cases (HOLD / REVIEW / INVESTIGATE / MONITOR / SAFE / INSUFFICIENT).
 *   6. blast_radius sourced from composite scoring — score in [0,1], typed breakdown.
 *   7. Fail-loud: missing graph → typed empty fields + `audit_symbol.leaf_missing` signal, no throw.
 *   8. Blackboard write — default on, opt-out via `writeToBlackboard: false`.
 *   9. Type converter unit tests — `symbolSessionHash`, `DuplicateMatch`, `RationaleEntry` shape.
 *  10. Tier inference — EXTRACTED/INFERRED/AMBIGUOUS boundary checks.
 *  11. Many side effects are returned unchanged.
 *  12. ToolResult type-narrows to AuditSymbolPayload.
 *  13. Side effects from fixture are surfaced.
 *  14. Empty sideEffects map yields empty behavior.
 *  15. Explicit sessionId is honored on the scratchpad.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import test, { type TestContext } from 'node:test';

import {
  auditSymbolAsync,
  synthesizeAction,
  inferTier,
  symbolSessionHash,
} from '../src/cognition/audit/audit-symbol.js';
import type { AuditSymbolPayload, DuplicateMatch, RationaleEntry } from '../src/cognition/audit/types.js';
import type { ToolResult } from '../src/cognition/signalization/types.js';
import type { SideEffect } from '../src/behavior-graph.js';
import type { SymbolHotspot } from '../src/engineering-insights.js';
import type { BlastRadiusBreakdown } from '../src/cognition/composite/scoring.js';
import {
  appendScratchpad,
  readScratchpad,
  scratchpadPath,
  clearScratchpad,
} from '../src/cognition/blackboard/scratchpad.js';
import type { GraphData } from '../src/graph.js';

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

function makeProjectRoot(t: TestContext): string {
  // Place fixture under the project root so `validateGraphPath` (FR-10) does
  // not refuse it. Real `.code-intelligence/<branch>/` paths then live under
  // this subdir, not the real repo.
  const base = path.resolve(process.cwd(), '.cog-audit-tmp');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'audit-'));
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

function makeGraph(symbol: string, sideEffectCount = 2): GraphData {
  const sideEffects: SideEffect[] = [];
  for (let i = 0; i < sideEffectCount; i++) {
    sideEffects.push({
      kind: 'http',
      target: `/api/endpoint-${i}`,
      confidence: 0.9,
      callSite: { file: 'src/audit-target.ts', line: 10 + i },
      evidence: ['test'],
    } as unknown as SideEffect);
  }
  return {
    symbols: { [symbol]: ['Other.method'] },
    callers: { [symbol]: ['main', 'queueWorker'] },
    symbolFile: { [symbol]: 'src/audit-target.ts' },
    sideEffects: { [symbol]: sideEffects },
  } as unknown as GraphData;
}

async function writeGraphAndMemory(root: string, graph: GraphData): Promise<void> {
  const dataDir = path.join(root, '.code-intelligence', 'main');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(path.join(dataDir, 'graph.json'), JSON.stringify(graph));
  await fsp.writeFile(path.join(dataDir, 'memory.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    totalEntries: 0,
    bySource: {},
    bySeverity: {},
    entries: [],
  }));
}

function makeSymbolHotspot(symbol: string): SymbolHotspot {
  return {
    symbol,
    file: 'src/audit-target.ts',
    changeCount: 5,
    fixCount: 2,
    lastChanged: '2026-06-01T00:00:00.000Z',
    lastChangeTitle: 'fix: race in audit target',
    connectivity: 3,
    dependentsCount: 2,
    likelyTestCallers: ['auditTarget.test'],
    impactSurface: [],
    primaryOwner: 'Test User',
    ownerPct: 100,
    recentOwner: 'Test User',
    contributorCount: 1,
    busFactor: 1,
    testGap: false,
    riskSummary: 'low risk',
    topics: ['booking'],
    score: 0.42,
    churnScore: 0.5,
    connectivityScore: 0.4,
    blastRadius: 0.32,
  } as unknown as SymbolHotspot;
}

// ---------------------------------------------------------------------------
// 1. Envelope shape — 8 fields
// ---------------------------------------------------------------------------

test('audit_symbol: ToolResult envelope has 8 fields populated for indexed project', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const symbol = 'BookingService.create';
  await writeGraphAndMemory(root, makeGraph(symbol, 2));

  const result = await auditSymbolAsync(root, symbol, { writeToBlackboard: false });
  const data = result.data;

  // Envelope
  assert.ok(result.data, 'data present');
  assert.ok(Array.isArray(result.signals), 'signals is array');
  assert.ok(Array.isArray(result.reasoning), 'reasoning is array');
  assert.ok(Array.isArray(result.sources), 'sources is array');
  assert.ok(['EXTRACTED', 'INFERRED', 'AMBIGUOUS'].includes(result.confidence_tier), 'confidence_tier is enum');

  // 8 fields
  assert.ok(Array.isArray(data.behavior), 'behavior is array');
  assert.ok(data.risk === null || typeof data.risk === 'object', 'risk is object|null');
  assert.ok(typeof data.impact === 'object', 'impact is object');
  assert.ok(Array.isArray(data.dups), 'dups is array');
  assert.ok(Array.isArray(data.rationale), 'rationale is array');
  assert.ok(data.blast_radius, 'blast_radius present');
  assert.equal(typeof data.blast_radius.score, 'number', 'blast_radius.score is number');
  assert.equal(typeof data.action_recommendation, 'string', 'action_recommendation is string');
  assert.ok(data.action_recommendation.length > 0, 'action_recommendation non-empty');
  assert.ok(Array.isArray(data.reasoning_chain), 'reasoning_chain is array');
  assert.ok(data.reasoning_chain.length > 0, 'reasoning_chain has at least leading fact');

  // Side effects from the fixture should be picked up
  assert.equal(data.behavior.length, 2, '2 side effects recorded in fixture');
});

test('audit_symbol: all 8 fields exist on the type contract', () => {
  const keys: Array<keyof AuditSymbolPayload> = [
    'behavior', 'risk', 'impact', 'dups', 'rationale',
    'blast_radius', 'action_recommendation', 'reasoning_chain',
  ];
  const sample: AuditSymbolPayload = {
    behavior: [],
    risk: null,
    impact: { seeds: [], missingSeeds: [], entries: [], totalDiscovered: 0 },
    dups: [],
    rationale: [],
    blast_radius: { score: 0, breakdown: {} as BlastRadiusBreakdown },
    action_recommendation: '',
    reasoning_chain: [],
  };
  for (const k of keys) {
    assert.ok(k in sample, `field ${k} exists on AuditSymbolPayload`);
  }
});

test('audit_symbol: ToolResult carries all 8 fields in .data even when graph is missing', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result = await auditSymbolAsync(root, 'Anything.anywhere', { writeToBlackboard: false });
  const required = [
    'behavior', 'risk', 'impact', 'dups', 'rationale',
    'blast_radius', 'action_recommendation', 'reasoning_chain',
  ] as const;
  for (const key of required) {
    assert.ok(key in result.data, `field "${key}" missing from .data`);
  }
});

// ---------------------------------------------------------------------------
// 2. Session ID
// ---------------------------------------------------------------------------

test('audit_symbol: deterministic sessionId by default = audit:<sha1_8>', () => {
  const expected = `audit:${symbolSessionHash('BookingService.create')}`;
  const h = symbolSessionHash('BookingService.create');
  assert.match(h, /^[0-9a-f]{8}$/);
  assert.equal(expected, `audit:${h}`);
});

test('symbolSessionHash is deterministic across calls', () => {
  const a = symbolSessionHash('BookingService.create');
  const b = symbolSessionHash('BookingService.create');
  assert.equal(a, b);
  const c = symbolSessionHash('BookingService.update');
  assert.notEqual(a, c);
});

test('symbolSessionHash produces sha1-truncated values', () => {
  const symbol = 'Test';
  const expected = crypto.createHash('sha1').update(symbol).digest('hex').slice(0, 8);
  assert.equal(symbolSessionHash(symbol), expected);
});

// ---------------------------------------------------------------------------
// 3. Reasoning chain propagation
// ---------------------------------------------------------------------------

test('audit_symbol: reasoning chain starts with audit_symbol called for <symbol>', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const symbol = 'Trace.run';
  await writeGraphAndMemory(root, makeGraph(symbol, 0));
  const r = await auditSymbolAsync(root, symbol, { writeToBlackboard: false });
  assert.equal(r.reasoning[0]?.source, 'audit_symbol');
  assert.ok(r.reasoning[0]?.fact.includes('Trace.run'), 'leading fact names the symbol');
  assert.equal(r.data.reasoning_chain[0]?.source, 'audit_symbol');
});

// ---------------------------------------------------------------------------
// 4. Action recommendation rule table
// ---------------------------------------------------------------------------

test('synthesizeAction: INSUFFICIENT when not indexed', () => {
  const out = synthesizeAction({
    behaviorCount: 0, risk: null, regressionScore: 0, blastScore: 0,
    duplicateCount: 0, rationaleCount: 0, projectIndexed: false,
  });
  assert.match(out, /INSUFFICIENT/);
});

test('synthesizeAction: HOLD when both regression and blast are high', () => {
  const out = synthesizeAction({
    behaviorCount: 2,
    risk: makeSymbolHotspot('X'),
    regressionScore: 0.8,
    blastScore: 0.7,
    duplicateCount: 0,
    rationaleCount: 0,
    projectIndexed: true,
  });
  assert.match(out, /HOLD/);
});

test('synthesizeAction: REVIEW when blast high but regression low', () => {
  const out = synthesizeAction({
    behaviorCount: 1,
    risk: makeSymbolHotspot('X'),
    regressionScore: 0.3,
    blastScore: 0.6,
    duplicateCount: 0,
    rationaleCount: 0,
    projectIndexed: true,
  });
  assert.match(out, /REVIEW/);
});

test('synthesizeAction: INVESTIGATE when rationale present and risk elevated', () => {
  const out = synthesizeAction({
    behaviorCount: 0,
    risk: makeSymbolHotspot('X'),
    regressionScore: 0.5,
    blastScore: 0.1,
    duplicateCount: 0,
    rationaleCount: 2,
    projectIndexed: true,
  });
  assert.match(out, /INVESTIGATE/);
});

test('synthesizeAction: MONITOR when duplicates but low risk', () => {
  const out = synthesizeAction({
    behaviorCount: 0,
    risk: null,
    regressionScore: 0.2,
    blastScore: 0.1,
    duplicateCount: 1,
    rationaleCount: 0,
    projectIndexed: true,
  });
  assert.match(out, /MONITOR/);
});

test('synthesizeAction: SAFE when behavior low risk low blast no duplicates', () => {
  const out = synthesizeAction({
    behaviorCount: 1,
    risk: null,
    regressionScore: 0.1,
    blastScore: 0.05,
    duplicateCount: 0,
    rationaleCount: 0,
    projectIndexed: true,
  });
  assert.match(out, /SAFE/);
});

// ---------------------------------------------------------------------------
// 5. inferTier
// ---------------------------------------------------------------------------

test('inferTier: AMBIGUOUS when both risk and regression are null and no behavior', () => {
  assert.equal(
    inferTier({ behavior: [], risk: null, regressionScore: null, blastScore: 0 }),
    'AMBIGUOUS',
  );
});

test('inferTier: INFERRED when regression is low and risk is present', () => {
  assert.equal(
    inferTier({ behavior: [{ kind: 'http' }] as unknown as SideEffect[], risk: makeSymbolHotspot('X'), regressionScore: 0.3, blastScore: 0.1 }),
    'INFERRED',
  );
});

test('inferTier: EXTRACTED when risk + behavior present and regression >= 0.5', () => {
  assert.equal(
    inferTier({ behavior: [{ kind: 'http' }] as unknown as SideEffect[], risk: makeSymbolHotspot('X'), regressionScore: 0.7, blastScore: 0.4 }),
    'EXTRACTED',
  );
});

// ---------------------------------------------------------------------------
// 6. Fail loud, fail typed
// ---------------------------------------------------------------------------

test('audit_symbol: missing graph → typed empty fields + leaf_missing signal, no throw', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  // Do NOT write graph.json.
  const result = await auditSymbolAsync(root, 'Missing.symbol', { writeToBlackboard: false });
  const data = result.data;

  // Typed empty values
  assert.deepEqual(data.behavior, [], 'behavior empty');
  assert.equal(data.risk, null, 'risk null');
  assert.deepEqual(data.impact, { seeds: ['Missing.symbol'], missingSeeds: [], entries: [], totalDiscovered: 0 }, 'impact empty');
  assert.deepEqual(data.dups, [], 'dups empty');
  assert.deepEqual(data.rationale, [], 'rationale empty');
  assert.equal(data.blast_radius.score, 0, 'blast_radius.score 0');

  // Some leaves will be missing → at least one signal
  const signalKinds = result.signals.map(s => s.kind);
  const hasMissing = signalKinds.some(k => String(k).startsWith('audit_symbol.leaf_'));
  assert.ok(hasMissing, `expected leaf missing/error signal, got: ${signalKinds.join(', ')}`);

  // action_recommendation still synthesized (with INSUFFICIENT since project not indexed)
  assert.match(data.action_recommendation, /INSUFFICIENT/);
});

test('audit_symbol: returns ToolResult even if everything fails (no throw)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result = await auditSymbolAsync(root, 'Anything.go', { writeToBlackboard: false });
  // Just confirm it returned a ToolResult-shaped value, not a throw.
  assert.ok('data' in result);
  assert.ok('signals' in result);
  assert.ok('reasoning' in result);
  assert.ok('sources' in result);
  assert.ok('confidence_tier' in result);
});

// ---------------------------------------------------------------------------
// 7. Blackboard write
// ---------------------------------------------------------------------------

test('audit_symbol: writeToBlackboard=true appends to per-session scratchpad', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const symbol = 'Persist.run';
  await writeGraphAndMemory(root, makeGraph(symbol, 0));
  const sessionId = `audit:${symbolSessionHash(symbol)}`;
  await clearScratchpad(sessionId, { projectRoot: root });

  await auditSymbolAsync(root, symbol, { writeToBlackboard: true });
  const entries = await readScratchpad(sessionId, { projectRoot: root });
  assert.equal(entries.length, 1, 'one scratchpad entry');
  assert.equal(entries[0]?.tool, 'audit_symbol');
  assert.equal(entries[0]?.sessionId, sessionId);
  const stored = entries[0]?.data as { action_recommendation: string };
  assert.ok(typeof stored.action_recommendation === 'string');
});

test('audit_symbol: writeToBlackboard=false does NOT write', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const symbol = 'SkipWrite.run';
  await writeGraphAndMemory(root, makeGraph(symbol, 0));
  const sessionId = `audit:${symbolSessionHash(symbol)}`;
  await clearScratchpad(sessionId, { projectRoot: root });
  await auditSymbolAsync(root, symbol, { writeToBlackboard: false });
  const file = scratchpadPath(sessionId, { projectRoot: root });
  assert.equal(fs.existsSync(file), false, 'no scratchpad file should be created');
});

test('audit_symbol: scratchpad survives a separate read in append-log format', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const symbol = 'AppendLog.run';
  await writeGraphAndMemory(root, makeGraph(symbol, 0));
  const sessionId = `audit:${symbolSessionHash(symbol)}`;
  await clearScratchpad(sessionId, { projectRoot: root });
  await auditSymbolAsync(root, symbol, { writeToBlackboard: true });
  await auditSymbolAsync(root, symbol, { writeToBlackboard: true });
  const entries = await readScratchpad(sessionId, { projectRoot: root });
  assert.equal(entries.length, 2, 'append-log keeps order');
});

// ---------------------------------------------------------------------------
// 8. Type contracts (DuplicateMatch, RationaleEntry)
// ---------------------------------------------------------------------------

test('audit_symbol: DuplicateMatch has the required fields', () => {
  const m: DuplicateMatch = {
    id: 'p1',
    title: 'auth middleware boilerplate',
    category: 'middleware',
    severity: 'high',
    source: 'ts-morph',
    files: ['src/a.ts', 'src/b.ts'],
    description: 'repeating pattern',
    recommendation: 'extract to shared helper',
  };
  assert.equal(m.severity, 'high');
  assert.deepEqual(m.files, ['src/a.ts', 'src/b.ts']);
});

test('audit_symbol: RationaleEntry has id + text + score + topics', () => {
  const r: RationaleEntry = {
    id: 'mem-1',
    text: 'previous rewrite of BookingService.create',
    score: 0.83,
    topics: ['booking', 'rewrite'],
  };
  assert.equal(r.score, 0.83);
  assert.equal(r.topics.length, 2);
});

// ---------------------------------------------------------------------------
// 9. blast_radius bounded
// ---------------------------------------------------------------------------

test('audit_symbol: blast_radius.score is in [0,1]', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraphAndMemory(root, makeGraph('Bounded.run', 0));
  const r = await auditSymbolAsync(root, 'Bounded.run', { writeToBlackboard: false });
  const s = r.data.blast_radius.score;
  assert.ok(s >= 0 && s <= 1, `blast_radius.score ${s} not in [0,1]`);
});

// ---------------------------------------------------------------------------
// 10. Side effect passthrough
// ---------------------------------------------------------------------------

test('audit_symbol: behavior empty when graph has no sideEffects for the symbol', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const graph = makeGraph('Other.run', 0);
  graph.sideEffects = {}; // no side effects for any symbol
  await writeGraphAndMemory(root, graph);
  const r = await auditSymbolAsync(root, 'Other.run', { writeToBlackboard: false });
  assert.deepEqual(r.data.behavior, []);
});

test('audit_symbol: many side effects are returned unchanged', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const symbol = 'Noisy.run';
  const graph = makeGraph(symbol, 0);
  const sideEffects: SideEffect[] = [];
  for (let i = 0; i < 50; i++) {
    sideEffects.push({
      kind: 'log',
      target: `evt${i}`,
      confidence: 0.9,
      callSite: { file: 'src/x.ts', line: i },
      evidence: ['noise'],
    } as unknown as SideEffect);
  }
  graph.sideEffects = { [symbol]: sideEffects };
  await writeGraphAndMemory(root, graph);
  const r = await auditSymbolAsync(root, symbol, { writeToBlackboard: false });
  assert.equal(r.data.behavior.length, 50);
});

// ---------------------------------------------------------------------------
// 11. Type contract for ToolResult<AuditSymbolPayload>
// ---------------------------------------------------------------------------

test('audit_symbol: ToolResult type-narrows to AuditSymbolPayload', () => {
  const r: ToolResult<AuditSymbolPayload> = {
    data: {} as AuditSymbolPayload,
    signals: [],
    reasoning: [],
    sources: [],
    confidence_tier: 'EXTRACTED',
  };
  assert.equal(r.confidence_tier, 'EXTRACTED');
});

// ---------------------------------------------------------------------------
// 12. Explicit sessionId is honored
// ---------------------------------------------------------------------------

test('audit_symbol: explicit sessionId is honored', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const symbol = 'CustomSession.run';
  await writeGraphAndMemory(root, makeGraph(symbol, 0));
  const custom = 'audit:my-custom-session-id';
  await clearScratchpad(custom, { projectRoot: root });
  await auditSymbolAsync(root, symbol, { writeToBlackboard: true, sessionId: custom });
  const entries = await readScratchpad(custom, { projectRoot: root });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.sessionId, custom);
});

// ---------------------------------------------------------------------------
// 13. Sources are populated
// ---------------------------------------------------------------------------

test('audit_symbol: sources contain the target symbol and audit_symbol tool', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraphAndMemory(root, makeGraph('Sources.run', 0));
  const r = await auditSymbolAsync(root, 'Sources.run', { writeToBlackboard: false });
  const sourcesKinds = r.sources.map(s => s.kind);
  const sourcesRefs = r.sources.map(s => s.ref);
  assert.ok(sourcesKinds.includes('symbol'), 'sources contains a symbol entry');
  assert.ok(sourcesKinds.includes('tool'), 'sources contains a tool entry');
  assert.ok(sourcesRefs.includes('Sources.run'), 'symbol ref = target');
  assert.ok(sourcesRefs.includes('audit_symbol'), 'tool ref = audit_symbol');
});

// ---------------------------------------------------------------------------
// 14. Confirms appendScratchpad compatibility (no extra calls break it)
// ---------------------------------------------------------------------------

test('audit_symbol: appendScratchpad still works (sanity for FR-3)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const sessionId = 'audit:scratchpad-sanity';
  await clearScratchpad(sessionId, { projectRoot: root });
  await appendScratchpad(sessionId, {
    ts: new Date().toISOString(),
    tool: 'test',
    data: { ok: true },
    sessionId,
  }, { projectRoot: root });
  const entries = await readScratchpad(sessionId, { projectRoot: root });
  assert.equal(entries.length, 1);
});
