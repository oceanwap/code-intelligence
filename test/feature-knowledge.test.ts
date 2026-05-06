import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseFeatureSeeds, chooseFeatureTopic, rankFeatureAnchors } from '../src/feature-knowledge.js';
import type { GraphData } from '../src/graph.js';
import type { RetrievedChunk } from '../src/indexer-run.js';
import type { ProjectMemorySearchHit } from '../src/project-memory.js';

function makeKnowledgeHit(overrides: Partial<ProjectMemorySearchHit>): ProjectMemorySearchHit {
  return {
    score: 0.9,
    entry: {
      id: 'change:auth',
      kind: 'change',
      sha: 'auth1234def567890',
      parents: [],
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      timestamp: '2026-05-06T00:00:00.000Z',
      title: 'Improve auth login flow',
      body: '',
      changeType: 'feature',
      summary: 'feature change: touches AuthService.login.',
      topics: ['auth', 'session'],
      files: ['src/auth.ts'],
      symbols: ['AuthService.login'],
      impacts: [],
      ...overrides.entry,
    },
    ...overrides,
  };
}

function makeCodeHit(overrides: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    file: 'src/auth.ts',
    symbol: 'AuthService.login',
    type: 'method',
    code: 'login() { return true; }',
    score: 0.88,
    ...overrides,
  };
}

test('chooseFeatureTopic prefers stable feature topic from query and memory hits', () => {
  const topic = chooseFeatureTopic(
    'auth login flow',
    [makeKnowledgeHit({ entry: { topics: ['auth', 'session'] } })],
    [makeCodeHit({ file: 'src/auth.ts', symbol: 'AuthService.login' })]
  );

  assert.equal(topic, 'auth');
});

test('chooseFeatureSeeds prefers exact symbols over file chunks', () => {
  const seeds = chooseFeatureSeeds(
    [
      makeKnowledgeHit({ entry: { symbols: ['AuthService.login', 'TokenStore.refresh'] } }),
      makeKnowledgeHit({ entry: { symbols: ['AuthService.login'] }, score: 0.7 }),
    ],
    [
      makeCodeHit({ symbol: 'AuthService.login', score: 0.91 }),
      makeCodeHit({ symbol: 'README.md', type: 'file', file: 'README.md', score: 0.95 }),
      makeCodeHit({ symbol: 'TokenStore.refresh', file: 'src/token.ts', score: 0.62 }),
    ],
    3
  );

  assert.deepEqual(seeds, ['AuthService.login', 'TokenStore.refresh']);
});

test('rankFeatureAnchors combines graph, topic, and history signals', () => {
  const graph: GraphData = {
    symbols: {
      'AuthService.login': ['SessionStore.issue'],
      'Helper.normalize': [],
      'SessionStore.issue': [],
    },
    callers: {
      'AuthService.login': ['AuthController.handle'],
    },
    files: {
      'src/auth.ts': [],
      'src/session.ts': [],
      'src/helper.ts': [],
    },
    symbolFile: {
      'AuthService.login': 'src/auth.ts',
      'SessionStore.issue': 'src/session.ts',
      'Helper.normalize': 'src/helper.ts',
      'AuthController.handle': 'src/auth.ts',
    },
    supertypes: {},
    subtypes: {},
    implementations: {},
    implementedFrom: {},
  };

  const anchors = rankFeatureAnchors(
    'auth login flow',
    'auth',
    [
      makeKnowledgeHit({ entry: { symbols: ['AuthService.login', 'SessionStore.issue'], topics: ['auth', 'session'] } }),
    ],
    [
      makeCodeHit({ symbol: 'Helper.normalize', file: 'src/helper.ts', score: 0.94 }),
      makeCodeHit({ symbol: 'AuthService.login', file: 'src/auth.ts', score: 0.73 }),
      makeCodeHit({ symbol: 'SessionStore.issue', file: 'src/session.ts', score: 0.55 }),
    ],
    {
      graph,
      hotspots: {
        analyzedChanges: 2,
        symbols: [{
          symbol: 'AuthService.login',
          file: 'src/auth.ts',
          changeCount: 2,
          fixCount: 1,
          lastChanged: '2026-05-06T00:00:00.000Z',
          lastChangeTitle: 'Improve auth login flow',
          connectivity: 2,
          topics: ['auth'],
          score: 14,
        }],
        files: [],
      },
      limit: 3,
    }
  );

  assert.equal(anchors[0]?.symbol, 'AuthService.login');
  assert.ok(anchors[0]?.signals.some(signal => signal.includes('topic match')));
  assert.ok(anchors[0]?.signals.some(signal => signal.includes('project memory')));
  assert.ok(anchors[0]?.signals.some(signal => signal.includes('hotspots')));
});