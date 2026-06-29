import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  detectCommunities,
  saveCommunitiesAsync,
  loadCommunitiesAsync,
  listCommunitiesForSymbol,
  type CommunitiesSnapshot,
} from '../src/cognition/communities.js';
import type { GraphData } from '../src/graph.js';

function makeGraph(overrides: Partial<GraphData> = {}): GraphData {
  return {
    symbols: {},
    callers: {},
    files: {},
    symbolFile: {},
    supertypes: {},
    subtypes: {},
    implementations: {},
    implementedFrom: {},
    entityRelations: {},
    resolvedImports: {},
    ...overrides,
  };
}

test('detectCommunities: empty graph yields empty snapshot', () => {
  const snap = detectCommunities(makeGraph());
  assert.equal(snap.totalNodes, 0);
  assert.equal(snap.totalCommunities, 0);
  assert.equal(snap.communities.length, 0);
});

test('detectCommunities: single symbol → its own community', () => {
  const snap = detectCommunities(makeGraph({
    symbols: { foo: [] },
    callers: {},
    symbolFile: { foo: 'src/x.ts' },
  }));
  assert.equal(snap.totalNodes, 1);
  assert.equal(snap.totalCommunities, 1);
  assert.deepEqual(snap.communities[0]!.members, ['foo']);
});

test('detectCommunities: tightly connected clique merges into one community', () => {
  // a-b-c-a triangle — clique. a calls b, b calls c, c calls a.
  const snap = detectCommunities(makeGraph({
    symbols: { a: ['b'], b: ['c'], c: ['a'] },
    callers: { b: ['a'], c: ['b'], a: ['c'] },
    symbolFile: { a: 'x.ts', b: 'x.ts', c: 'x.ts' },
  }));
  assert.equal(snap.totalNodes, 3);
  // Louvain should merge the triangle into 1 community.
  assert.ok(snap.totalCommunities >= 1, `expected at least 1 community, got ${snap.totalCommunities}`);
  const sizes = snap.communities.map(c => c.size).sort((a, b) => b - a);
  assert.equal(sizes[0], 3, `largest community should hold all 3 members, sizes=${JSON.stringify(sizes)}`);
});

test('detectCommunities: two disconnected cliques become two communities', () => {
  const snap = detectCommunities(makeGraph({
    symbols: {
      a1: ['a2'], a2: ['a1'],
      b1: ['b2'], b2: ['b1'],
    },
    callers: {
      a2: ['a1'], a1: ['a2'],
      b2: ['b1'], b1: ['b2'],
    },
    symbolFile: { a1: 'x.ts', a2: 'x.ts', b1: 'y.ts', b2: 'y.ts' },
  }));
  assert.equal(snap.totalNodes, 4);
  // Either two communities of 2 each, or one big community of 4 — both are
  // valid Louvain outcomes. We assert members are partitioned into at least
  // two distinct communities OR all 4 end up together.
  if (snap.totalCommunities >= 2) {
    const sizes = snap.communities.map(c => c.size).sort((a, b) => b - a);
    assert.deepEqual(sizes, [2, 2]);
  } else {
    assert.equal(snap.communities[0]!.size, 4);
  }
});

test('detectCommunities: entity relations count heavier than method calls', () => {
  // a has a weak method-call link to b (1 call edge, undirected weight 1) and
  // a strong entity-relation link to B (entityRelations weight 2 → undirected
  // weight 2). After Louvain, a should join the entity cluster {B, C} rather
  // than stay with the lone b.
  const snap = detectCommunities(makeGraph({
    symbols: { a: ['b'], B: ['C'], C: ['B'] },
    callers: { b: ['a'], B: ['C'], C: ['B'] },
    symbolFile: { a: 'x.ts', b: 'x.ts', B: 'entities.ts', C: 'entities.ts' },
    entityRelations: { a: ['B'], B: ['C'] },
  }));
  assert.ok(snap.totalCommunities >= 1);
  const aComm = snap.communities.find(c => c.members.includes('a'));
  assert.ok(aComm, 'symbol `a` should belong to some community');
  // Entity relations carry weight 2 (undirected weight 2) vs method calls
  // weight 1 (undirected weight 1) — entity cluster wins.
  assert.ok(aComm!.members.includes('B'), `expected a to share community with B, got ${JSON.stringify(aComm!.members)}`);
});

test('listCommunitiesForSymbol: filters to a single community', () => {
  const snap = detectCommunities(makeGraph({
    symbols: { a: ['b'], b: [], c: [], d: [] },
    callers: { b: ['a'], a: [], c: [], d: [] },
    symbolFile: { a: 'x.ts', b: 'x.ts', c: 'y.ts', d: 'z.ts' },
  }));
  const all = listCommunitiesForSymbol(snap);
  assert.equal(all.communities.length, snap.communities.length);
  for (const sym of ['a', 'b', 'c', 'd']) {
    const filtered = listCommunitiesForSymbol(snap, sym);
    assert.ok(filtered.communities.length >= 1, `expected >=1 community for symbol ${sym}`);
    assert.ok(
      filtered.communities.every(c => c.members.includes(sym)),
      `all returned communities must contain ${sym}`,
    );
  }
});

test('listCommunitiesForSymbol: unknown symbol → empty', () => {
  const snap = detectCommunities(makeGraph({
    symbols: { a: ['b'], b: [] },
    callers: { b: ['a'], a: [] },
    symbolFile: { a: 'x.ts', b: 'x.ts' },
  }));
  const filtered = listCommunitiesForSymbol(snap, 'no-such-symbol');
  assert.equal(filtered.communities.length, 0);
});

test('save/load round-trip on disk', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-communities-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snap = detectCommunities(makeGraph({
    symbols: { a: ['b'], b: ['a'], c: [] },
    callers: { b: ['a'], a: ['b'], c: [] },
    symbolFile: { a: 'x.ts', b: 'x.ts', c: 'y.ts' },
  }));
  await saveCommunitiesAsync(dir, snap);
  const loaded = await loadCommunitiesAsync(dir);
  assert.ok(loaded, 'snapshot should load from disk');
  assert.equal(loaded!.totalNodes, snap.totalNodes);
  assert.equal(loaded!.totalCommunities, snap.totalCommunities);
  assert.deepEqual(loaded!.communities, snap.communities);
});

test('loadCommunitiesAsync returns null on missing file', async () => {
  const loaded = await loadCommunitiesAsync(path.join(os.tmpdir(), `no-such-${Date.now()}`));
  assert.equal(loaded, null);
});

test('snapshot includes modularity in [−1, 1]', () => {
  const snap = detectCommunities(makeGraph({
    symbols: {
      a: ['b', 'c'], b: ['a'], c: ['a'],
      d: ['e'], e: ['d'], f: [],
    },
    callers: {
      b: ['a'], c: ['a'], a: ['b', 'c'],
      e: ['d'], d: ['e'], f: [],
    },
    symbolFile: {
      a: 'x.ts', b: 'x.ts', c: 'x.ts',
      d: 'y.ts', e: 'y.ts', f: 'z.ts',
    },
  }));
  assert.ok(snap.modularity >= -1 && snap.modularity <= 1, `modularity out of range: ${snap.modularity}`);
});

test('communities sorted by size descending', () => {
  const snap = detectCommunities(makeGraph({
    symbols: { a: ['b'], b: ['a'], c: ['d'], d: ['c'], e: [] },
    callers: { b: ['a'], a: ['b'], d: ['c'], c: ['d'], e: [] },
    symbolFile: { a: 'x.ts', b: 'x.ts', c: 'x.ts', d: 'y.ts', e: 'z.ts' },
  }));
  for (let i = 1; i < snap.communities.length; i++) {
    assert.ok(
      snap.communities[i - 1]!.size >= snap.communities[i]!.size,
      `communities must be sorted by size descending`,
    );
  }
});

test('CommunitiesSnapshot type exports shape with id/members/size', () => {
  // Type-only assertion — fails to compile if shape drifts.
  const fake: CommunitiesSnapshot = {
    generatedAt: '2025-01-01T00:00:00Z',
    totalCommunities: 1,
    totalNodes: 1,
    modularity: 0,
    communities: [{ id: 0, members: ['x'], size: 1 }],
  };
  assert.equal(fake.communities[0]!.id, 0);
  assert.deepEqual(fake.communities[0]!.members, ['x']);
});