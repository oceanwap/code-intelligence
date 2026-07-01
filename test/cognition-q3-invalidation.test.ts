/**
 * test/cognition-q3-invalidation.test.ts — Q3 fix: composite-scores.json
 * must be regenerated on every indexer run, and the file must carry a
 * `lastRegeneratedAt` timestamp so dev / QA can spot staleness.
 *
 * Root cause of Q3: `computeAndPersistCompositeScores` was exported from
 * `src/cognition/composite/persist.ts` but had zero callers in the indexer
 * pipeline. `composite-scores.json` was written once (typically by a test
 * fixture) and then frozen — every blast-radius-based ranking
 * (`query_project`, `risk_hotspots`, `semantic_duplicates`) read stale
 * scores forever.
 *
 * The fix wires `computeAndPersistCompositeScores` into the indexer's
 * cognition phase (see `src/indexer-run.ts`). This file pins three
 * contracts:
 *   1. The new on-disk format includes a top-level `lastRegeneratedAt`
 *      ISO timestamp alongside `scores`.
 *   2. Re-running `computeAndPersistCompositeScores` updates the
 *      timestamp (so a reindex visibly invalidates the file).
 *   3. Legacy unwrapped files (the format pre-fix) are still readable
 *      via `loadCompositeScores` — FR-11 back-compat.
 *
 * The indexer pipeline itself is heavyweight (requires Qdrant + fastembed),
 * so we exercise the persistence surface directly with hand-built graph +
 * memory fixtures. The wiring in `src/indexer-run.ts` is reviewed by code
 * inspection (the call sits at the end of the cognition phase, after
 * `graph` and `getProjectMemoryEntriesAsync(root)` are both stable).
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';

import {
  compositeScoresPath,
  computeAndPersistCompositeScores,
  loadCompositeScores,
} from '../src/cognition/composite/persist.js';
import type { GraphData } from '../src/graph.js';
import type { ChangeMemoryEntry, ProjectMemoryEntry } from '../src/project-memory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectRoot(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cog-q3-'));
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

function buildFixtureGraph(): GraphData {
  return {
    symbols: {
      'HUB.run': ['EDGE.invoke'],
      'EDGE.invoke': [],
    },
    callers: {
      'HUB.run': ['main'],
      'EDGE.invoke': ['HUB.run'],
    },
    symbolFile: {
      'HUB.run': 'src/hub.ts',
      'EDGE.invoke': 'src/edge.ts',
    },
    files: {
      'src/hub.ts': [],
      'src/edge.ts': [],
    },
    supertypes: {},
    subtypes: {},
    implementations: {},
    implementedFrom: {},
    resolvedImports: {},
  };
}

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
  return [changeEntry];
}

// ---------------------------------------------------------------------------
// Q3.1 — lastRegeneratedAt is set on first compute
// ---------------------------------------------------------------------------

test('computeAndPersistCompositeScores writes lastRegeneratedAt timestamp', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  const graph = buildFixtureGraph();
  const entries = buildFixtureMemory();
  await computeAndPersistCompositeScores(graph, entries, { projectRoot: dir });

  const raw = await fsp.readFile(compositeScoresPath({ projectRoot: dir }), 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(typeof parsed['lastRegeneratedAt'], 'string', 'lastRegeneratedAt must be a string');
  assert.equal(typeof parsed['scores'], 'object', 'scores must be an object');
  const ts = parsed['lastRegeneratedAt'] as string;
  // ISO 8601 parse round-trip
  const parsedTs = new Date(ts).toISOString();
  assert.equal(parsedTs, ts, 'lastRegeneratedAt must be a valid ISO 8601 timestamp');
});

// ---------------------------------------------------------------------------
// Q3.2 — Re-running updates lastRegeneratedAt
// ---------------------------------------------------------------------------

test('computeAndPersistCompositeScores: re-run updates lastRegeneratedAt', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  const graph = buildFixtureGraph();
  const entries = buildFixtureMemory();

  // Pin the first timestamp via opts so we can prove the file actually
  // changed (a `new Date().toISOString()` call inside the function would
  // advance milliseconds even in a tight loop).
  await computeAndPersistCompositeScores(graph, entries, {
    projectRoot: dir,
    lastRegeneratedAt: '2026-06-29T00:00:00.000Z',
  });
  const firstRaw = await fsp.readFile(compositeScoresPath({ projectRoot: dir }), 'utf8');
  const first = JSON.parse(firstRaw) as Record<string, unknown>;
  assert.equal(first['lastRegeneratedAt'], '2026-06-29T00:00:00.000Z');

  // Re-run with a later timestamp — simulate an indexer reindex.
  await computeAndPersistCompositeScores(graph, entries, {
    projectRoot: dir,
    lastRegeneratedAt: '2026-06-30T00:00:00.000Z',
  });
  const secondRaw = await fsp.readFile(compositeScoresPath({ projectRoot: dir }), 'utf8');
  const second = JSON.parse(secondRaw) as Record<string, unknown>;
  assert.equal(second['lastRegeneratedAt'], '2026-06-30T00:00:00.000Z');
  assert.notEqual(firstRaw, secondRaw, 'file should be byte-different across regen');
});

// ---------------------------------------------------------------------------
// Q3.3 — Legacy unwrapped files are still readable (FR-11 back-compat)
// ---------------------------------------------------------------------------

test('loadCompositeScores reads legacy unwrapped composite-scores.json (FR-11 back-compat)', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);

  // Hand-write a legacy-format file: a flat symbol → CompositeScore map,
  // no wrapper, no lastRegeneratedAt. This is what every existing fixture
  // looks like — we must not break readers that consume those files.
  const legacy = {
    'HUB.run': {
      symbol: 'HUB.run',
      blastRadius: 0.42,
      intentAlignment: 0.5,
      changeRisk: 0.3,
      overall: 0.41,
      blastRadiusBreakdown: {
        inbound: 1,
        outbound: 2,
        totalDegree: 3,
        connectivity: 3,
        inboundNormalized: 0.25,
        outboundNormalized: 0.5,
        totalDegreeNormalized: 0.5,
        connectivityNormalized: 0.5,
        symbolMissingFromGraph: false,
      },
      intentAlignmentBreakdown: {
        goalTokenCount: 0,
        directSymbolOverlap: 0,
        fileOverlap: 0,
        neighborSymbolSupport: 0,
        topicOverlap: 0,
        memorySymbolHits: 0,
        directSymbolOverlapNormalized: 0,
        fileOverlapNormalized: 0,
        neighborSymbolSupportNormalized: 0,
        topicOverlapNormalized: 0,
        goalEmpty: true,
      },
      changeRiskBreakdown: {
        changeCount: 0,
        fixCount: 0,
        connectivity: 0,
        instability: 0,
        changeCountNormalized: 0,
        fixCountNormalized: 0,
        connectivityNormalized: 0,
        instabilityNormalized: 0,
        memoryMissing: true,
      },
      computedAt: '2026-06-29T00:00:00.000Z',
    },
  };
  const file = compositeScoresPath({ projectRoot: dir });
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(legacy, null, 2), 'utf8');

  const loaded = await loadCompositeScores({ projectRoot: dir });
  assert.deepEqual(loaded, legacy, 'legacy unwrapped file must round-trip through loadCompositeScores');
  assert.equal(loaded['HUB.run']?.blastRadius, 0.42);
});

// ---------------------------------------------------------------------------
// Q3.4 — Wrapped write + load round-trips
// ---------------------------------------------------------------------------

test('save → load round-trips the wrapped { lastRegeneratedAt, scores } format', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  const graph = buildFixtureGraph();
  const entries = buildFixtureMemory();
  const scores = await computeAndPersistCompositeScores(graph, entries, {
    projectRoot: dir,
    lastRegeneratedAt: '2026-07-01T00:00:00.000Z',
  });
  assert.ok(Object.keys(scores).length > 0);

  const loaded = await loadCompositeScores({ projectRoot: dir });
  assert.deepEqual(loaded, scores, 'loaded scores must match the persisted scores');
});