import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  attentionOverviewAsync,
  attentionScoreAsync,
  embeddingPriorityAsync,
  recordAttentionUsageAsync,
  refreshAttentionAsync,
} from '../src/cognition/attention/engine.js';

function makeTempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-attention-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeFixtureCognition(dir: string): void {
  const dataDir = path.join(dir, '.code-intelligence');
  fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(
    path.join(dataDir, 'structure.json'),
    JSON.stringify(
      {
        generatedAt: '2026-05-10T00:00:00.000Z',
        modules: [
          { name: 'src/core', files: 3, symbols: 10, inbound: 4, outbound: 3, centrality: 1, zone: 'application' },
          { name: 'src/api', files: 2, symbols: 6, inbound: 2, outbound: 2, centrality: 0.57, zone: 'application' },
        ],
        dependencies: [{ from: 'src/api', to: 'src/core', weight: 6 }],
        zones: [{ name: 'application', modules: ['src/api', 'src/core'] }],
        cycles: [],
        symbolToModule: {
          'Core.run': 'src/core',
          'Core.cache': 'src/core',
          'Api.handle': 'src/api',
        },
      },
      null,
      2
    )
  );

  fs.writeFileSync(
    path.join(dataDir, 'evolution.json'),
    JSON.stringify(
      {
        generatedAt: '2026-05-10T00:00:00.000Z',
        modules: [],
        drift: [{ module: 'src/core', instabilityDelta: 0.2, couplingDelta: 0.3, riskDelta: 0.25 }],
        hotspots: [
          { module: 'src/core', riskScore: 0.8, churn: 8, bugs: 4, instability: 0.8, coupling: 3.2 },
          { module: 'src/api', riskScore: 0.4, churn: 2, bugs: 1, instability: 0.5, coupling: 1.1 },
        ],
      },
      null,
      2
    )
  );

  fs.writeFileSync(
    path.join(dataDir, 'failure-intelligence.json'),
    JSON.stringify(
      {
        generatedAt: '2026-05-10T00:00:00.000Z',
        totalFailures: 2,
        records: [
          {
            id: 'failure:1',
            sourceBugId: 'bug:1',
            fixedBySha: 'aa11',
            title: 'Core failure',
            summary: 'core issue',
            timestamp: '2026-05-09T00:00:00.000Z',
            symptoms: ['x'],
            rootCauses: ['dependency-direction-pressure'],
            triggerConditions: ['concurrent-execution'],
            affectedBoundaries: ['src/core'],
            relatedFailures: [],
            preventivePatterns: ['enforce-dependency-direction-checks'],
            files: ['src/core/a.ts'],
            symbols: ['Core.run'],
            topics: ['core'],
            clusterKeys: ['dependency_pattern'],
          },
          {
            id: 'failure:2',
            sourceBugId: 'bug:2',
            fixedBySha: 'bb22',
            title: 'Another core failure',
            summary: 'core cache issue',
            timestamp: '2026-05-08T00:00:00.000Z',
            symptoms: ['y'],
            rootCauses: ['cache-consistency-breakdown'],
            triggerConditions: ['timing-and-retry-window'],
            affectedBoundaries: ['src/core'],
            relatedFailures: [],
            preventivePatterns: ['introduce-cache-invalidation-contract'],
            files: ['src/core/cache.ts'],
            symbols: ['Core.cache'],
            topics: ['core', 'cache'],
            clusterKeys: ['caching_issues'],
          },
        ],
        clusters: [],
      },
      null,
      2
    )
  );

  fs.writeFileSync(
    path.join(dataDir, 'memory-governance.json'),
    JSON.stringify(
      {
        generatedAt: '2026-05-10T00:00:00.000Z',
        health: { totalEntries: 2, staleEntries: 0, contradictedEntries: 0, averageConfidence: 0.7 },
        entries: [
          {
            id: 'change:1',
            kind: 'change',
            confidence: 0.7,
            source: 'git',
            createdAt: '2026-05-01T00:00:00.000Z',
            lastValidatedAt: '2026-05-09T00:00:00.000Z',
            decayScore: 0.2,
            evidenceRefs: ['src/core'],
            contradictions: [],
          },
        ],
      },
      null,
      2
    )
  );
}

test('refreshAttention computes module tiers and embedding priorities', async t => {
  const dir = makeTempDir(t);
  writeFixtureCognition(dir);

  await recordAttentionUsageAsync(dir, { tool: 'query_project', symbols: ['Core.run'], modules: ['src/core'] });
  await recordAttentionUsageAsync(dir, { tool: 'query_project', symbols: ['Core.cache'], modules: ['src/core'] });

  const snapshot = await refreshAttentionAsync(dir);
  assert.ok(snapshot);
  assert.ok(snapshot.modules.length >= 2);

  const overview = await attentionOverviewAsync(dir);
  assert.ok(overview);
  assert.equal(overview?.modules[0]?.module, 'src/core');

  const score = await attentionScoreAsync(dir, 'src/core');
  assert.ok(score);
  if (score && 'score' in score) {
    assert.ok(score.score.composite > 0.45);
  }

  const queue = await embeddingPriorityAsync(dir, 5);
  assert.ok(queue.length > 0);
  assert.equal(queue[0]?.module, 'src/core');
});
