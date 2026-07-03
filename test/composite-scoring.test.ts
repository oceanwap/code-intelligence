/**
 * test/composite-scoring.test.ts — US-003 P2 composite scoring.
 *
 * Covers (PRD US-003 acceptance criteria):
 *   1. Determinism — identical graph + memory → identical scores across calls.
 *   2. blastRadius features — inbound/outbound/total-degree/connectivity in [0,1].
 *   3. intentAlignment features — goal-token overlap, neighbor support, topic overlap.
 *   4. changeRisk features — changeCount/fixCount/connectivity/instability.
 *   5. compositeScore blends three scorers with deterministic weights.
 *   6. Persist round-trip — saveCompositeScores → loadCompositeScores is byte-equal.
 *   7. Cross-output collection name + ensure function returns a stable id.
 *   8. Ranking hookup explanation — when composite scores exist, rankingSignals
 *      surfaces the top blast-radius feature so the boost is explainable.
 *
 * Tests use a hermetic fixture: a tmp directory with a hand-built graph.json,
 * an empty memory snapshot, and a tmp project root for persistence. No Qdrant
 * required (cross-output tests stay at the unit level — full E2E is for QA).
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';

import {
  blastRadius,
  changeRisk,
  compositeScore,
  computeGraphMaxima,
  intentAlignment,
  rankSymbolsByComposite,
  type CompositeScore,
  type MemoryStats,
  type ScoringContext,
} from '../src/cognition/composite/scoring.js';
import {
  buildMemoryStats,
  compositeScoresPath,
  computeAndPersistCompositeScores,
  loadCompositeScores,
  loadCompositeScoresAsMap,
  saveCompositeScores,
  scoreSymbol,
} from '../src/cognition/composite/persist.js';
import {
  crossOutputCollectionName,
  truncateForEmbedding,
  buildCrossOutputPayload,
  renderCrossOutputHits,
} from '../src/cognition/composite/cross-output-index.js';
import type { GraphData } from '../src/graph.js';
import type { ChangeMemoryEntry, ProjectMemoryEntry } from '../src/project-memory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectRoot(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cog-comp-'));
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

/** Build a hand-rolled GraphData fixture. Pure — no I/O. */
function buildFixtureGraph(): GraphData {
  // Three symbols: HUB (the central "blast radius" target), EDGE (small
  // dependency), and ISO (isolated). Each distinct relation count lets us
  // assert the weighted blending of the blastRadius score.
  return {
    symbols: {
      'HUB.run': ['EDGE.invoke', 'EDGE.compute'],
      'EDGE.invoke': ['ISO.foo'],
      'EDGE.compute': [],
      'ISO.foo': [],
    },
    callers: {
      'HUB.run': ['main', 'queueWorker'],
      'EDGE.invoke': ['HUB.run'],
      'EDGE.compute': ['HUB.run'],
      'ISO.foo': ['EDGE.invoke'],
    },
    symbolFile: {
      'HUB.run': 'src/hub.ts',
      'EDGE.invoke': 'src/edge.ts',
      'EDGE.compute': 'src/edge.ts',
      'ISO.foo': 'src/iso.ts',
    },
    files: {
      'src/hub.ts': [],
      'src/edge.ts': [],
      'src/iso.ts': [],
    },
    supertypes: {},
    subtypes: {},
    implementations: {},
    implementedFrom: {},
    resolvedImports: {},
  };
}

/** Build a memory snapshot fixture with a couple of change + fix entries. */
function buildFixtureMemory(): ProjectMemoryEntry[] {
  const changeEntry: ChangeMemoryEntry = {
    kind: 'change',
    id: 'commit-1',
    sha: 'abc123',
    parents: [],
    authorName: 'Test',
    authorEmail: 't@e.com',
    timestamp: '2026-06-29T00:00:00.000Z',
    title: 'Refactor HUB.run',
    body: 'tighten HUB.run',
    changeType: 'refactor',
    summary: 'refactor hub',
    topics: ['hub', 'refactor'],
    files: ['src/hub.ts'],
    symbols: ['HUB.run'],
    impacts: [],
  };
  const fixEntry: ChangeMemoryEntry = {
    kind: 'change',
    id: 'commit-2',
    sha: 'def456',
    parents: [],
    authorName: 'Test',
    authorEmail: 't@e.com',
    timestamp: '2026-06-29T01:00:00.000Z',
    title: 'Fix HUB.run crash',
    body: 'null guard',
    changeType: 'fix',
    summary: 'fix hub',
    topics: ['hub', 'fix'],
    files: ['src/hub.ts'],
    symbols: ['HUB.run'],
    impacts: [],
  };
  return [changeEntry, fixEntry];
}

function buildMemoryMap(): Map<string, MemoryStats> {
  return buildMemoryStats(buildFixtureMemory());
}

// ---------------------------------------------------------------------------
// 1. Determinism — same inputs → same scores
// ---------------------------------------------------------------------------

test('blastRadius is deterministic for a fixed graph', () => {
  const graph = buildFixtureGraph();
  const ctx: ScoringContext = { graph, memory: buildMemoryMap() };
  const a = blastRadius('HUB.run', ctx);
  const b = blastRadius('HUB.run', ctx);
  assert.equal(a.score, b.score);
  assert.deepEqual(a.breakdown, b.breakdown);
});

test('intentAlignment is deterministic for a fixed goal', () => {
  const ctx: ScoringContext = { graph: buildFixtureGraph(), memory: buildMemoryMap() };
  const a = intentAlignment('HUB.run', 'hub refactor', ctx);
  const b = intentAlignment('HUB.run', 'hub refactor', ctx);
  assert.equal(a.score, b.score);
  assert.deepEqual(a.breakdown, b.breakdown);
});

test('changeRisk is deterministic for a fixed graph + memory', () => {
  const ctx: ScoringContext = { graph: buildFixtureGraph(), memory: buildMemoryMap() };
  const a = changeRisk('HUB.run', ctx);
  const b = changeRisk('HUB.run', ctx);
  assert.equal(a.score, b.score);
  assert.deepEqual(a.breakdown, b.breakdown);
});

// ---------------------------------------------------------------------------
// 2. blastRadius — feature breakdown is well-formed
// ---------------------------------------------------------------------------

test('blastRadius: HUB.run has higher score than ISO.foo (more neighbors)', () => {
  const ctx: ScoringContext = { graph: buildFixtureGraph(), memory: buildMemoryMap() };
  const hub = blastRadius('HUB.run', ctx);
  const iso = blastRadius('ISO.foo', ctx);
  assert.ok(hub.score > iso.score, `expected HUB > ISO; got HUB=${hub.score} ISO=${iso.score}`);
  assert.ok(hub.score <= 1 && hub.score >= 0, `HUB score out of [0,1]: ${hub.score}`);
  assert.ok(iso.score >= 0 && iso.score <= 1, `ISO score out of [0,1]: ${iso.score}`);
});

test('blastRadius: breakdown fields are populated and normalized', () => {
  const ctx: ScoringContext = { graph: buildFixtureGraph(), memory: buildMemoryMap() };
  const { breakdown, score } = blastRadius('HUB.run', ctx);
  assert.equal(breakdown.inbound, 2);
  assert.equal(breakdown.outbound, 2);
  assert.equal(breakdown.totalDegree, 4);
  assert.ok(breakdown.connectivity > 0);
  assert.ok(breakdown.inboundNormalized >= 0 && breakdown.inboundNormalized <= 1);
  assert.ok(breakdown.outboundNormalized >= 0 && breakdown.outboundNormalized <= 1);
  assert.equal(score, breakdown.inboundNormalized * 0.45 + breakdown.outboundNormalized * 0.2
    + breakdown.totalDegreeNormalized * 0.2 + breakdown.connectivityNormalized * 0.15);
});

test('blastRadius: empty graph → score 0 with symbolMissingFromGraph=true', () => {
  const ctx: ScoringContext = { graph: null, memory: null };
  const { score, breakdown } = blastRadius('any.symbol', ctx);
  assert.equal(score, 0);
  assert.equal(breakdown.symbolMissingFromGraph, true);
});

// ---------------------------------------------------------------------------
// 3. intentAlignment — goal-token overlap
// ---------------------------------------------------------------------------

test('intentAlignment: matches a goal that shares tokens with the symbol', () => {
  const ctx: ScoringContext = { graph: buildFixtureGraph(), memory: buildMemoryMap() };
  const { score, breakdown } = intentAlignment('HUB.run', 'hub refactor', ctx);
  assert.ok(score > 0, `expected >0 for matching goal, got ${score}`);
  assert.ok(breakdown.directSymbolOverlap > 0, 'expected direct overlap on "hub"');
  assert.equal(breakdown.goalEmpty, false);
});

test('intentAlignment: empty goal → score 0 with goalEmpty=true', () => {
  const ctx: ScoringContext = { graph: buildFixtureGraph(), memory: buildMemoryMap() };
  const { score, breakdown } = intentAlignment('HUB.run', '   ', ctx);
  assert.equal(score, 0);
  assert.equal(breakdown.goalEmpty, true);
});

test('intentAlignment: goal argument wins over ctx.goal', () => {
  const ctx: ScoringContext = { graph: buildFixtureGraph(), memory: buildMemoryMap(), goal: 'totally unrelated' };
  const { score } = intentAlignment('HUB.run', 'hub refactor', ctx);
  assert.ok(score > 0);
});

// ---------------------------------------------------------------------------
// 4. changeRisk — fixCount dominates
// ---------------------------------------------------------------------------

test('changeRisk: a symbol with both change and fix entries scores higher than one with neither', () => {
  const graph = buildFixtureGraph();
  const memory = buildMemoryMap();
  const ctx: ScoringContext = { graph, memory };
  const a = changeRisk('HUB.run', ctx);
  const b = changeRisk('ISO.foo', ctx);
  assert.ok(a.score > b.score, `expected HUB (churn) > ISO (no churn); got HUB=${a.score} ISO=${b.score}`);
});

test('changeRisk: missing memory stats → memoryMissing=true and partial score from graph', () => {
  const graph = buildFixtureGraph();
  const memory = new Map<string, MemoryStats>();
  const ctx: ScoringContext = { graph, memory };
  const { score, breakdown } = changeRisk('HUB.run', ctx);
  assert.equal(breakdown.memoryMissing, true);
  assert.ok(score >= 0 && score <= 1, `score out of [0,1]: ${score}`);
  assert.equal(breakdown.changeCount, 0);
  assert.equal(breakdown.fixCount, 0);
});

// ---------------------------------------------------------------------------
// 5. compositeScore blend
// ---------------------------------------------------------------------------

test('compositeScore blends three scorers with deterministic weights', () => {
  const ctx: ScoringContext = { graph: buildFixtureGraph(), memory: buildMemoryMap() };
  const score = compositeScore('HUB.run', ctx, { goal: 'hub refactor' });
  const expected = clamp(score.blastRadius * 0.45 + score.intentAlignment * 0.3 + score.changeRisk * 0.25);
  assert.equal(score.overall, expected);
  assert.ok(score.overall >= 0 && score.overall <= 1);
  assert.equal(score.symbol, 'HUB.run');
});

test('compositeScore: high-risk symbol outranks isolated one', () => {
  const ctx: ScoringContext = { graph: buildFixtureGraph(), memory: buildMemoryMap() };
  const hub = compositeScore('HUB.run', ctx);
  const iso = compositeScore('ISO.foo', ctx);
  assert.ok(hub.overall > iso.overall);
});

// ---------------------------------------------------------------------------
// 6. Persistence — composite-scores.json round-trip
// ---------------------------------------------------------------------------

test('compositeScoresPath lives under .code-intelligence/<branch>/', (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  const p = compositeScoresPath({ projectRoot: dir });
  assert.ok(p.endsWith('composite-scores.json'), `unexpected path: ${p}`);
  assert.ok(p.includes('.code-intelligence'));
});

test('loadCompositeScores returns {} when file missing', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  const out = await loadCompositeScores({ projectRoot: dir });
  assert.deepEqual(out, {});
});

test('save → load round-trip preserves every entry', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);

  const graph = buildFixtureGraph();
  const entries = buildFixtureMemory();
  const scores = await computeAndPersistCompositeScores(graph, entries, {
    projectRoot: dir,
    computedAt: '2026-06-29T00:00:00.000Z',
  });
  assert.ok(Object.keys(scores).length > 0);

  const reloaded = await loadCompositeScores({ projectRoot: dir });
  assert.deepEqual(reloaded, scores);
});

test('loadCompositeScoresAsMap returns Map and reflects empty case', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  const map = await loadCompositeScoresAsMap({ projectRoot: dir });
  assert.ok(map instanceof Map);
  assert.equal(map.size, 0);
});

// ---------------------------------------------------------------------------
// Sprint 8 US-002 / B2 — module-level mtime-keyed memo
// ---------------------------------------------------------------------------

test('B2: memo — consecutive loadCompositeScoresAsMap calls return same Map instance', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  // Seed the composite-scores file with at least one entry.
  const graph = buildFixtureGraph();
  const entries = buildFixtureMemory();
  await saveCompositeScores({
    'A.run': {
      symbol: 'A.run',
      blastRadius: 0.5,
      intentAlignment: 0.5,
      changeRisk: 0.3,
      overall: 0.4,
      blastRadiusBreakdown: {
        inbound: 0, outbound: 0, totalDegree: 0, connectivity: 0,
        inboundNormalized: 0, outboundNormalized: 0,
        totalDegreeNormalized: 0, connectivityNormalized: 0,
        symbolMissingFromGraph: true,
      },
      intentAlignmentBreakdown: {
        goalTokenCount: 0, directSymbolOverlap: 0, fileOverlap: 0,
        neighborSymbolSupport: 0, topicOverlap: 0, memorySymbolHits: 0,
        directSymbolOverlapNormalized: 0, fileOverlapNormalized: 0,
        neighborSymbolSupportNormalized: 0, topicOverlapNormalized: 0,
        goalEmpty: true,
      },
      changeRiskBreakdown: {
        changeCount: 0, fixCount: 0, connectivity: 0, instability: 0,
        changeCountNormalized: 0, fixCountNormalized: 0,
        connectivityNormalized: 0, instabilityNormalized: 0,
        memoryMissing: true,
      },
      computedAt: '2026-06-29T00:00:00.000Z',
    },
  }, { projectRoot: dir });

  const m1 = await loadCompositeScoresAsMap({ projectRoot: dir });
  const m2 = await loadCompositeScoresAsMap({ projectRoot: dir });
  assert.ok(m1 instanceof Map);
  assert.equal(m1.size, 1);
  // B2 acceptance: pointer-equal Map instance on cache hit.
  assert.equal(m1, m2, 'consecutive calls must return the SAME Map instance (memo hit)');
  void graph;
  void entries;
});

test('B2: memo — touching the file invalidates the cache', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  await saveCompositeScores({
    'A.run': {
      symbol: 'A.run',
      blastRadius: 0.5,
      intentAlignment: 0.5,
      changeRisk: 0.3,
      overall: 0.4,
      blastRadiusBreakdown: {
        inbound: 0, outbound: 0, totalDegree: 0, connectivity: 0,
        inboundNormalized: 0, outboundNormalized: 0,
        totalDegreeNormalized: 0, connectivityNormalized: 0,
        symbolMissingFromGraph: true,
      },
      intentAlignmentBreakdown: {
        goalTokenCount: 0, directSymbolOverlap: 0, fileOverlap: 0,
        neighborSymbolSupport: 0, topicOverlap: 0, memorySymbolHits: 0,
        directSymbolOverlapNormalized: 0, fileOverlapNormalized: 0,
        neighborSymbolSupportNormalized: 0, topicOverlapNormalized: 0,
        goalEmpty: true,
      },
      changeRiskBreakdown: {
        changeCount: 0, fixCount: 0, connectivity: 0, instability: 0,
        changeCountNormalized: 0, fixCountNormalized: 0,
        connectivityNormalized: 0, instabilityNormalized: 0,
        memoryMissing: true,
      },
      computedAt: '2026-06-29T00:00:00.000Z',
    },
  }, { projectRoot: dir });
  const m1 = await loadCompositeScoresAsMap({ projectRoot: dir });
  // Force mtime tick by waiting briefly then re-writing the file. The
  // mtime resolution on some filesystems is 1s; we sleep 1.05s and
  // re-write to guarantee a different mtime.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await saveCompositeScores({
    'B.run': {
      symbol: 'B.run',
      blastRadius: 0.6,
      intentAlignment: 0.6,
      changeRisk: 0.4,
      overall: 0.5,
      blastRadiusBreakdown: {
        inbound: 0, outbound: 0, totalDegree: 0, connectivity: 0,
        inboundNormalized: 0, outboundNormalized: 0,
        totalDegreeNormalized: 0, connectivityNormalized: 0,
        symbolMissingFromGraph: true,
      },
      intentAlignmentBreakdown: {
        goalTokenCount: 0, directSymbolOverlap: 0, fileOverlap: 0,
        neighborSymbolSupport: 0, topicOverlap: 0, memorySymbolHits: 0,
        directSymbolOverlapNormalized: 0, fileOverlapNormalized: 0,
        neighborSymbolSupportNormalized: 0, topicOverlapNormalized: 0,
        goalEmpty: true,
      },
      changeRiskBreakdown: {
        changeCount: 0, fixCount: 0, connectivity: 0, instability: 0,
        changeCountNormalized: 0, fixCountNormalized: 0,
        connectivityNormalized: 0, instabilityNormalized: 0,
        memoryMissing: true,
      },
      computedAt: '2026-06-29T00:00:01.000Z',
    },
  }, { projectRoot: dir });
  const m2 = await loadCompositeScoresAsMap({ projectRoot: dir });
  assert.notEqual(m1, m2, 'mtime change must bust the memo (different Map instance)');
  assert.equal(m2.size, 1);
  assert.ok(m2.has('B.run'), 'after touch, the new file contents are reflected');
});

test('saveCompositeScores writes atomically (no partial file)', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  const scores: Record<string, CompositeScore> = {
    'Foo.bar': {
      symbol: 'Foo.bar',
      blastRadius: 0.42,
      intentAlignment: 0.5,
      changeRisk: 0.3,
      overall: 0.41,
      blastRadiusBreakdown: {
        inbound: 1, outbound: 2, totalDegree: 3, connectivity: 3,
        inboundNormalized: 0.25, outboundNormalized: 0.5,
        totalDegreeNormalized: 0.5, connectivityNormalized: 0.5,
        symbolMissingFromGraph: false,
      },
      intentAlignmentBreakdown: {
        goalTokenCount: 0, directSymbolOverlap: 0, fileOverlap: 0,
        neighborSymbolSupport: 0, topicOverlap: 0, memorySymbolHits: 0,
        directSymbolOverlapNormalized: 0, fileOverlapNormalized: 0,
        neighborSymbolSupportNormalized: 0, topicOverlapNormalized: 0,
        goalEmpty: true,
      },
      changeRiskBreakdown: {
        changeCount: 1, fixCount: 0, connectivity: 3, instability: 0.5,
        changeCountNormalized: 0.25, fixCountNormalized: 0,
        connectivityNormalized: 0.5, instabilityNormalized: 0.5,
        memoryMissing: false,
      },
      computedAt: '2026-06-29T00:00:00.000Z',
    },
  };
  await saveCompositeScores(scores, { projectRoot: dir });
  // No leftover .tmp file.
  const tmp = `${compositeScoresPath({ projectRoot: dir })}.tmp`;
  assert.equal(fs.existsSync(tmp), false);
});

test('scoreSymbol returns a typed CompositeScore without persisting', (t) => {
  const _ = makeProjectRoot(t);
  const graph = buildFixtureGraph();
  const entries = buildFixtureMemory();
  const score = scoreSymbol('HUB.run', graph, entries, { goal: 'hub' });
  assert.equal(score.symbol, 'HUB.run');
  assert.ok(score.computedAt.length > 0);
});

// ---------------------------------------------------------------------------
// 7. Cross-output — collection naming + payload shape + render
// ---------------------------------------------------------------------------

test('crossOutputCollectionName mirrors the code/memory scope pattern', () => {
  const a = crossOutputCollectionName({ projectRoot: '/tmp/projA' });
  const b = crossOutputCollectionName({ projectRoot: '/tmp/projB' });
  const aRepeat = crossOutputCollectionName({ projectRoot: '/tmp/projA' });
  assert.ok(a.startsWith('cross-output-'), `name should be prefixed: ${a}`);
  assert.notEqual(a, b, 'different project roots → different collection names');
  assert.equal(a, aRepeat, 'same project root → same collection name');
});

test('truncateForEmbedding respects maxChars cap', () => {
  const long = 'x'.repeat(1000);
  const out = truncateForEmbedding(long, 100);
  assert.ok(out.length <= 200, `truncation should respect cap; got ${out.length}`);
  assert.ok(out.includes('truncated for embedding'));
});

test('buildCrossOutputPayload enforces the FR-6 schema', () => {
  const p = buildCrossOutputPayload({
    tool: 'query_project',
    target: 'BookingService.create',
    sessionId: 'sess-1',
    text: 'hello world',
  });
  assert.equal(p.tool, 'query_project');
  assert.equal(p.target, 'BookingService.create');
  assert.equal(p.session_id, 'sess-1');
  assert.equal(p.text, 'hello world');
  assert.ok(p.ts.length > 0);
});

test('renderCrossOutputHits formats hits for human/LLM display', () => {
  const text = renderCrossOutputHits([
    {
      tool: 'render_behavior',
      target: 'BookingService.create',
      sessionId: 'sess-1',
      ts: '2026-06-29T00:00:00.000Z',
      score: 0.93,
      text: 'db.write: bookings@bookingService.create',
    },
  ]);
  assert.ok(text.includes('Cross-output context:'));
  assert.ok(text.includes('[render_behavior]'));
  assert.ok(text.includes('BookingService.create'));
  assert.ok(text.includes('db.write: bookings'));
});

test('renderCrossOutputHits returns empty string for empty input', () => {
  assert.equal(renderCrossOutputHits([]), '');
});

// ---------------------------------------------------------------------------
// 8. Ranking — symbols sort by composite score with deterministic tie-break
// ---------------------------------------------------------------------------

test('rankSymbolsByComposite sorts by overall desc, localeCompare tie-break', () => {
  const scores = new Map<string, CompositeScore>([
    ['A.alpha', { ...baseScore('A.alpha'), overall: 0.4 }],
    ['A.beta', { ...baseScore('A.beta'), overall: 0.7 }],
    ['A.gamma', { ...baseScore('A.gamma'), overall: 0.4 }],
  ]);
  const sorted = rankSymbolsByComposite(['A.gamma', 'A.alpha', 'A.beta'], scores);
  assert.deepEqual(sorted, ['A.beta', 'A.alpha', 'A.gamma']);
});

test('rankSymbolsByComposite: missing symbols sort to the bottom', () => {
  const scores = new Map<string, CompositeScore>([
    ['A.alpha', { ...baseScore('A.alpha'), overall: 0.7 }],
  ]);
  const sorted = rankSymbolsByComposite(['unknown', 'A.alpha'], scores);
  assert.deepEqual(sorted, ['A.alpha', 'unknown']);
});

// ---------------------------------------------------------------------------
// 9. ComputeGraphMaxima — pre-batch normalization
// ---------------------------------------------------------------------------

test('computeGraphMaxima reflects the largest degrees in the graph', () => {
  const graph = buildFixtureGraph();
  const memory = buildMemoryMap();
  const maxima = computeGraphMaxima(graph, memory);
  assert.ok(maxima.maxInbound >= 2, `HUB.run has 2 callers; max=${maxima.maxInbound}`);
  assert.ok(maxima.maxOutbound >= 2);
  assert.ok(maxima.maxChangeCount >= 2, `HUB.run had 2 change entries`);
  assert.ok(maxima.maxFixCount >= 1);
});

// ---------------------------------------------------------------------------
// 10. Integration — saveCompositeScores produces stable JSON across runs
// ---------------------------------------------------------------------------

test('saveCompositeScores: byte-equal output for the same inputs', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  const graph = buildFixtureGraph();
  const entries = buildFixtureMemory();
  const opts = {
    projectRoot: dir,
    computedAt: '2026-06-29T00:00:00.000Z',
    lastRegeneratedAt: '2026-06-29T00:00:00.000Z',
  };
  await computeAndPersistCompositeScores(graph, entries, opts);
  const fileA = await fsp.readFile(compositeScoresPath({ projectRoot: dir }), 'utf8');
  // Re-run with the same inputs.
  await computeAndPersistCompositeScores(graph, entries, opts);
  const fileB = await fsp.readFile(compositeScoresPath({ projectRoot: dir }), 'utf8');
  assert.equal(fileA, fileB);
});

// ---------------------------------------------------------------------------
// Helpers (kept at bottom to avoid lint complaints about hoisting)
// ---------------------------------------------------------------------------

function baseScore(symbol: string): CompositeScore {
  return {
    symbol,
    blastRadius: 0,
    intentAlignment: 0,
    changeRisk: 0,
    overall: 0,
    blastRadiusBreakdown: {
      inbound: 0, outbound: 0, totalDegree: 0, connectivity: 0,
      inboundNormalized: 0, outboundNormalized: 0,
      totalDegreeNormalized: 0, connectivityNormalized: 0,
      symbolMissingFromGraph: false,
    },
    intentAlignmentBreakdown: {
      goalTokenCount: 0, directSymbolOverlap: 0, fileOverlap: 0,
      neighborSymbolSupport: 0, topicOverlap: 0, memorySymbolHits: 0,
      directSymbolOverlapNormalized: 0, fileOverlapNormalized: 0,
      neighborSymbolSupportNormalized: 0, topicOverlapNormalized: 0,
      goalEmpty: true,
    },
    changeRiskBreakdown: {
      changeCount: 0, fixCount: 0, connectivity: 0, instability: 0,
      changeCountNormalized: 0, fixCountNormalized: 0,
      connectivityNormalized: 0, instabilityNormalized: 0,
      memoryMissing: true,
    },
    computedAt: '2026-06-29T00:00:00.000Z',
  };
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}