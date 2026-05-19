import assert from 'node:assert/strict';
import test from 'node:test';
import {
  serializeFeatureBriefResponse,
  serializeQueryProjectResponse,
} from '../src/output-format.js';
import type { FeatureBrief } from '../src/feature-knowledge.js';
import type { RetrievedChunk } from '../src/retriever.js';

test('serializeQueryProjectResponse exposes an explicit ranking contract', () => {
  const results: RetrievedChunk[] = [
    {
      file: 'src/auth.ts',
      symbol: 'AuthService.login',
      type: 'method',
      code: 'login() { return true; }',
      lineStart: 12,
      lineEnd: 18,
      score: 12.4,
      semanticScore: 0.72,
      freshness: {
        sliceStartLine: 12,
        sliceEndLine: 18,
        indexRefreshedAt: '2026-05-06T12:00:00.000Z',
        indexedFileMtimeMs: 100,
        currentFileMtimeMs: 100,
        latestChange: {
          sha: 'auth1234def567890',
          title: 'Improve auth login flow',
          timestamp: '2026-05-06T11:00:00.000Z',
          authorName: 'Test User',
          changedLines: [{ startLine: 14, endLine: 15 }],
        },
        needsReindex: false,
        reasons: [],
      },
      graphSummary: {
        calls: { total: 2, symbols: ['SessionStore.issue', 'AuditLog.record'], sites: [{ symbol: 'SessionStore.issue', file: 'src/session.ts', line: 21 }] },
        usedBy: { total: 3, symbols: ['AuthController.handle', 'LoginRoute.post', 'CliAuthCommand.run'], sites: [{ symbol: 'AuthController.handle', file: 'src/controller.ts', line: 44 }] },
        supertypes: { total: 1, symbols: ['BaseAuthService'] },
        subtypes: { total: 0, symbols: [] },
        implements: { total: 1, symbols: ['AuthPort.login'] },
        implementedBy: { total: 0, symbols: [] },
      },
      connectionsWithinResults: {
        total: 2,
        calls: ['SessionStore.issue'],
        usedBy: ['AuthController.handle'],
        supertypes: [],
        subtypes: [],
        implements: [],
        implementedBy: [],
      },
      rankingSignals: ['strong semantic match', 'supported by project memory'],
      scoreBreakdown: {
        semantic: 7.2,
        symbolOverlap: 3,
        fileOverlap: 2,
        directMemory: 4,
        neighborSupport: 1.5,
        connectivity: 1.2,
      },
    },
  ];

  const response = serializeQueryProjectResponse('auth login flow', results, {
    memoryRefreshedAt: '2026-05-06T12:00:00.000Z',
    indexedHeadSha: 'head123',
    currentHeadSha: 'head123',
    dirtyFileCount: 0,
    dirtyFilesNewerThanMemory: 0,
    needsReindex: false,
    reasons: [],
  });

  assert.equal(response.question, 'auth login flow');
  assert.equal(response.memory.refreshedAt, '2026-05-06T12:00:00.000Z');
  assert.equal(response.resultCount, 1);
  assert.equal(response.results[0]?.location.startLine, 12);
  assert.equal(response.results[0]?.freshness.indexRefreshedAt, '2026-05-06T12:00:00.000Z');
  assert.equal(response.results[0]?.freshness.latestChange?.changedLines[0]?.startLine, 14);
  assert.equal(response.results[0]?.graph.usedBy.total, 3);
  assert.deepEqual(response.results[0]?.graph.calls.symbols, ['SessionStore.issue', 'AuditLog.record']);
  assert.equal(response.results[0]?.graph.calls.sites[0]?.line, 21);
  assert.equal(response.results[0]?.graph.usedBy.sites[0]?.file, 'src/controller.ts');
  assert.equal(response.results[0]?.connectionsWithinResults.total, 2);
  assert.deepEqual(response.results[0]?.connectionsWithinResults.usedBy, ['AuthController.handle']);
  assert.equal(response.results[0]?.ranking.hybridScore, 12.4);
  assert.equal(response.results[0]?.ranking.semanticScore, 0.72);
  assert.deepEqual(response.results[0]?.ranking.signals, ['strong semantic match', 'supported by project memory']);
  assert.equal(response.results[0]?.ranking.breakdown.directMemory, 4);
  assert.equal('score' in (response.results[0] ?? {}), false);
  assert.equal('scoreBreakdown' in (response.results[0] ?? {}), false);
});

  test('serializeQueryProjectResponse includes pagination guidance when provided', () => {
    const result: RetrievedChunk = {
      file: 'src/billing.ts',
      symbol: 'BillingService.createPositions',
      type: 'method',
      code: 'createPositions() { return []; }',
      score: 4.2,
      semanticScore: 0.61,
    };
    const response = serializeQueryProjectResponse(
      'billing query',
      [result],
      undefined,
      {
        page: 1,
        pageSize: 6,
        totalResults: 18,
        totalPages: 3,
        hasMore: true,
        nextPage: 2,
        symbolIndexByPage: [
          { page: 1, symbols: ['BillingService.createPositions', 'BillingService.hasDiscount'] },
          { page: 2, symbols: ['BillingService.createDiscountPositions'] },
          { page: 3, symbols: ['BillPosition.whereIn'] },
        ],
        callGraphPreviewLines: [
          'Small call graph:',
          '  BillingService.createPositions',
          '  └─ BillingService.createDiscountPositions',
        ],
      }
    );

    assert.equal(response.pagination?.page, 1);
    assert.equal(response.pagination?.nextPage, 2);
    assert.equal(response.pagination?.hasMore, true);
    assert.equal(response.pagination?.symbolIndexByPage.length, 3);
    assert.equal(response.pagination?.callGraphPreviewLines[0], 'Small call graph:');
    assert.equal(response.pagination?.symbolIndexByPage[1]?.symbols[0], 'BillingService.createDiscountPositions');
    assert.ok(response.pagination?.guidance.includes('page=2'));
  });

test('serializeFeatureBriefResponse flattens knowledge and guidance into stable fields', () => {
  const brief: FeatureBrief = {
    feature: 'auth login flow',
    topic: 'auth',
    seedSymbols: ['AuthService.login', 'SessionStore.issue'],
    docs: [{
      title: 'Authentication Flow',
      source: 'README.md > Authentication',
      summary: 'Explains the login and session flow.',
    }],
    knowledgeHits: [{
      score: 0.91,
      entry: {
        id: 'bug:auth',
        kind: 'bug',
        timestamp: '2026-05-06T00:00:00.000Z',
        title: 'Improve auth login flow',
        body: '',
        summary: 'bug memory: touches AuthService.login. Fixed by auth1234 via Improve auth login flow. Topics: auth, session.',
        changeType: 'fix',
        topics: ['auth', 'session'],
        files: ['src/auth.ts'],
        symbols: ['AuthService.login'],
        source: 'fix-commit',
        fixedBySha: 'auth1234def567890',
        status: 'fixed',
        evidenceScore: 7,
        symptoms: ['login flow guard'],
        errorSignatures: ['TypeError'],
        failingTests: ['src/auth.test.ts'],
        impacts: [{
          file: 'src/auth.ts',
          status: 'M',
          symbols: ['AuthService.login'],
          hints: ['auth'],
        }],
      },
    }],
    codeAnchors: [{
      symbol: 'AuthService.login',
      file: 'src/auth.ts',
      type: 'method',
      score: 13.5,
      semanticScore: 0.83,
      signals: ['supported by project memory', 'topic match: auth'],
    }],
    recentChanges: [{
      id: 'change:auth',
      kind: 'change',
      sha: 'auth1234def567890',
      parents: ['base1234def567890'],
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
    }],
    whyChanged: {
      target: 'AuthService.login',
      mode: 'symbol',
      totalMatches: 1,
      activeTopics: [{ topic: 'auth', count: 1 }],
      matches: [{
        matchedSymbols: ['AuthService.login'],
        matchedFiles: ['src/auth.ts'],
        entry: {
          id: 'change:auth',
          kind: 'change',
          sha: 'auth1234def567890',
          parents: ['base1234def567890'],
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
        },
      }],
    },
    hotspots: {
      analyzedChanges: 2,
      symbols: [{
        symbol: 'AuthService.login',
        file: 'src/auth.ts',
        changeCount: 2,
        fixCount: 1,
        lastChanged: '2026-05-06T00:00:00.000Z',
        lastChangeTitle: 'Improve auth login flow',
        connectivity: 3,
        topics: ['auth'],
        score: 14,
      }],
      files: [{
        file: 'src/auth.ts',
        changeCount: 2,
        fixCount: 1,
        lastChanged: '2026-05-06T00:00:00.000Z',
        lastChangeTitle: 'Improve auth login flow',
        symbolCount: 1,
        connectivity: 3,
        topics: ['auth'],
        score: 12,
      }],
    },
    impact: {
      seeds: ['AuthService.login'],
      missingSeeds: [],
      totalDiscovered: 1,
      entries: [{
        symbol: 'SessionStore.issue',
        file: 'src/session.ts',
        distance: 1,
        reasons: [{ kind: 'calls', via: 'AuthService.login' }],
        changeCount: 1,
        fixCount: 0,
        lastChanged: '2026-05-06T00:00:00.000Z',
        lastChangeTitle: 'Improve auth login flow',
        connectivity: 2,
        topics: ['auth'],
        score: 8,
      }],
    },
  };

  const response = serializeFeatureBriefResponse(brief);

  assert.equal(response.feature, 'auth login flow');
  assert.equal(response.recommendedNextCalls.getSymbols[0], 'AuthService.login');
  assert.equal(response.knowledgeHits[0]?.entry.kind, 'bug');
  assert.equal(response.knowledgeHits[0]?.entry.source, 'fix commit auth1234def567890');
  assert.equal(response.knowledgeHits[0]?.entry.fixedBySha, 'auth1234def567890');
  assert.equal(response.knowledgeHits[0]?.entry.evidenceScore, 7);
  assert.deepEqual(response.knowledgeHits[0]?.entry.errorSignatures, ['TypeError']);
  assert.deepEqual(response.knowledgeHits[0]?.entry.failingTests, ['src/auth.test.ts']);
  assert.equal(response.codeAnchors[0]?.ranking.hybridScore, 13.5);
  assert.equal(response.codeAnchors[0]?.ranking.semanticScore, 0.83);
  assert.deepEqual(response.whyChanged?.matches[0]?.matchedSymbols, ['AuthService.login']);
  assert.equal(response.impact?.entries[0]?.reasons[0]?.kind, 'calls');
  assert.equal('entry' in ((response as unknown as { brief?: unknown }) ?? {}), false);
});