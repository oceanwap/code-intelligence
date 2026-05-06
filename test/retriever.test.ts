import assert from 'node:assert/strict';
import test from 'node:test';
import { rankRetrievedChunks, type RetrievedChunk } from '../src/retriever.js';
import type { GraphData } from '../src/graph.js';
import type { ProjectMemoryEntry } from '../src/project-memory.js';

function makeChunk(overrides: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    file: 'src/auth.ts',
    symbol: 'AuthService.login',
    type: 'method',
    code: 'login() { return true; }',
    score: 0.7,
    semanticScore: 0.7,
    ...overrides,
  };
}

test('rankRetrievedChunks lifts feature-relevant symbols over generic helpers', () => {
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
      'src/helper.ts': [],
      'src/session.ts': [],
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

  const memoryEntries: ProjectMemoryEntry[] = [
    {
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
      summary: 'feature change: touches AuthService.login and SessionStore.issue.',
      topics: ['auth', 'login', 'session'],
      files: ['src/auth.ts', 'src/session.ts'],
      symbols: ['AuthService.login', 'SessionStore.issue'],
      impacts: [],
    },
  ];

  const ranked = rankRetrievedChunks(
    'auth login flow',
    [
      makeChunk({ symbol: 'Helper.normalize', file: 'src/helper.ts', score: 0.93, semanticScore: 0.93 }),
      makeChunk({ symbol: 'AuthService.login', file: 'src/auth.ts', score: 0.70, semanticScore: 0.70 }),
      makeChunk({ symbol: 'SessionStore.issue', file: 'src/session.ts', score: 0.41, semanticScore: 0.41 }),
    ],
    graph,
    memoryEntries
  );

  assert.equal(ranked[0]?.symbol, 'AuthService.login');
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
  assert.equal(ranked[0]?.semanticScore, 0.7);
  assert.ok(ranked[0]?.rankingSignals?.includes('supported by project memory'));
  assert.ok((ranked[0]?.scoreBreakdown?.directMemory ?? 0) > 0);
  assert.ok((ranked[0]?.scoreBreakdown?.semantic ?? 0) > 0);
});