import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectDirectCallExpansionSymbols,
  connectRetrievedChunksWithinResults,
  prioritizeDirectCallResults,
  rankRetrievedChunks,
  type RetrievedChunk,
} from '../src/retriever.js';
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

test('connectRetrievedChunksWithinResults marks links between returned slices', () => {
  const graph: GraphData = {
    symbols: {
      'AuthService.login': ['SessionStore.issue'],
      'SessionStore.issue': [],
      'AuthController.handle': ['AuthService.login'],
    },
    callers: {
      'AuthService.login': ['AuthController.handle'],
      'SessionStore.issue': ['AuthService.login'],
    },
    files: {
      'src/auth.ts': [],
      'src/session.ts': [],
      'src/controller.ts': [],
    },
    symbolFile: {
      'AuthService.login': 'src/auth.ts',
      'SessionStore.issue': 'src/session.ts',
      'AuthController.handle': 'src/controller.ts',
    },
    supertypes: {},
    subtypes: {},
    implementations: {},
    implementedFrom: {},
  };

  const connected = connectRetrievedChunksWithinResults([
    makeChunk({ symbol: 'AuthService.login' }),
    makeChunk({ symbol: 'SessionStore.issue', file: 'src/session.ts' }),
    makeChunk({ symbol: 'AuthController.handle', file: 'src/controller.ts' }),
  ], graph);

  const auth = connected.find(chunk => chunk.symbol === 'AuthService.login');
  assert.equal(auth?.connectionsWithinResults?.total, 2);
  assert.deepEqual(auth?.connectionsWithinResults?.calls, ['SessionStore.issue']);
  assert.deepEqual(auth?.connectionsWithinResults?.usedBy, ['AuthController.handle']);

  const session = connected.find(chunk => chunk.symbol === 'SessionStore.issue');
  assert.deepEqual(session?.connectionsWithinResults?.usedBy, ['AuthService.login']);
});

test('collectDirectCallExpansionSymbols resolves same-file PHP and TS helper methods', () => {
  const graph: GraphData = {
    symbols: {
      'BillingService::createPositions': ['hasDiscount', 'createDiscountPositions'],
      'BillingService.hasInvoice': ['validateInvoice'],
    },
    callSites: {
      'BillingService::createPositions': [
        { symbol: 'hasDiscount', file: 'src/BillingService.php', line: 1 },
        { symbol: 'createDiscountPositions', file: 'src/BillingService.php', line: 2 },
      ],
      'BillingService.hasInvoice': [
        { symbol: 'validateInvoice', file: 'src/billing.ts', line: 10 },
      ],
    },
    callers: {},
    files: {
      'src/BillingService.php': [],
      'src/billing.ts': [],
    },
    symbolFile: {
      'BillingService::createPositions': 'src/BillingService.php',
      'BillingService::hasDiscount': 'src/BillingService.php',
      'BillingService::createDiscountPositions': 'src/BillingService.php',
      'BillingService.hasInvoice': 'src/billing.ts',
      'BillingService.validateInvoice': 'src/billing.ts',
    },
    supertypes: {},
    subtypes: {},
    implementations: {},
    implementedFrom: {},
  };

  const expanded = collectDirectCallExpansionSymbols([
    { symbol: 'BillingService::createPositions', file: 'src/BillingService.php' },
    { symbol: 'BillingService.hasInvoice', file: 'src/billing.ts' },
  ], graph);

  assert.ok(expanded.has('BillingService::hasDiscount'));
  assert.ok(expanded.has('BillingService::createDiscountPositions'));
  assert.ok(expanded.has('BillingService.validateInvoice'));
});

test('prioritizeDirectCallResults moves direct helper symbols ahead of unrelated results', () => {
  const ranked: RetrievedChunk[] = [
    makeChunk({ symbol: 'Utility.formatMoney', score: 11 }),
    makeChunk({ symbol: 'BillingService::createDiscountPositions', score: 7 }),
    makeChunk({ symbol: 'BillingService::hasDiscount', score: 6 }),
  ];

  const prioritized = prioritizeDirectCallResults(
    ranked,
    new Set(['BillingService::hasDiscount', 'BillingService::createDiscountPositions'])
  );

  assert.equal(prioritized[0]?.symbol, 'BillingService::createDiscountPositions');
  assert.equal(prioritized[1]?.symbol, 'BillingService::hasDiscount');
  assert.equal(prioritized[2]?.symbol, 'Utility.formatMoney');
});

test('rankRetrievedChunks promotes parent/child of strong semantic seed', () => {
  const graph: GraphData = {
    symbols: {
      'BillingService::createPositions': ['BillingService::createDiscountPositions'],
      'BillingService::createDiscountPositions': [],
      'Utility::formatMoney': [],
    },
    callers: {
      'BillingService::createPositions': ['BillingController::generateBill'],
      'BillingService::createDiscountPositions': ['BillingService::createPositions'],
    },
    files: {
      'src/BillingService.php': [],
      'src/BillingController.php': [],
      'src/Utility.php': [],
    },
    symbolFile: {
      'BillingService::createPositions': 'src/BillingService.php',
      'BillingService::createDiscountPositions': 'src/BillingService.php',
      'BillingController::generateBill': 'src/BillingController.php',
      'Utility::formatMoney': 'src/Utility.php',
    },
    supertypes: {},
    subtypes: {},
    implementations: {},
    implementedFrom: {},
  };

  const ranked = rankRetrievedChunks(
    'billing create positions',
    [
      makeChunk({ symbol: 'BillingService::createPositions', file: 'src/BillingService.php', score: 0.82, semanticScore: 0.82 }),
      makeChunk({ symbol: 'BillingService::createDiscountPositions', file: 'src/BillingService.php', score: 0.15, semanticScore: 0.15 }),
      makeChunk({ symbol: 'BillingController::generateBill', file: 'src/BillingController.php', score: 0.16, semanticScore: 0.16 }),
      makeChunk({ symbol: 'Utility::formatMoney', file: 'src/Utility.php', score: 0.22, semanticScore: 0.22 }),
    ],
    graph,
    [],
    'default',
    new Set(['BillingService::createPositions'])
  );

  const boostedChild = ranked.find(item => item.symbol === 'BillingService::createDiscountPositions');
  const boostedParent = ranked.find(item => item.symbol === 'BillingController::generateBill');
  const unrelated = ranked.find(item => item.symbol === 'Utility::formatMoney');

  assert.ok((boostedChild?.score ?? 0) > (unrelated?.score ?? 0));
  assert.ok((boostedParent?.score ?? 0) > (unrelated?.score ?? 0));
  assert.ok(boostedChild?.rankingSignals?.includes('child of strong semantic match'));
  assert.ok(boostedParent?.rankingSignals?.includes('parent of strong semantic match'));
});