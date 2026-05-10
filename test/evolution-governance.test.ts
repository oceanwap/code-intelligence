import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { saveCognitionConfigAsync } from '../src/cognition/config.js';
import {
  architectureDriftAsync,
  hotspotAnalysisAsync,
  instabilityTimelineAsync,
  refreshEvolutionAsync,
} from '../src/cognition/evolution/engine.js';
import {
  contradictionReportAsync,
  memoryHealthAsync,
  refreshMemoryGovernanceAsync,
  staleMemoryAsync,
} from '../src/cognition/governance/engine.js';

function makeTempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-evolution-governance-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeArchitecture(dir: string, instabilityCore = 0.5, couplingCore = 2.5): void {
  const dataDir = path.join(dir, '.code-intelligence');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'architecture.json'),
    JSON.stringify(
      {
        generatedAt: '2026-05-10T00:00:00.000Z',
        modules: [
          { name: 'src/core', files: 3, symbols: 12, inbound: 4, outbound: 3, zone: 'application' },
          { name: 'src/api', files: 2, symbols: 8, inbound: 2, outbound: 4, zone: 'application' },
        ],
        dependencies: [
          { from: 'src/api', to: 'src/core', calls: 7, imports: 2, weight: 8 },
        ],
        coupling: {
          'src/core': couplingCore,
          'src/api': 1.7,
        },
        instability: {
          'src/core': instabilityCore,
          'src/api': 0.75,
        },
        zones: [
          { name: 'application', modules: ['src/api', 'src/core'] },
        ],
      },
      null,
      2
    )
  );
}

function writeProjectMemory(dir: string): void {
  const dataDir = path.join(dir, '.code-intelligence');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'project-memory.json'),
    JSON.stringify(
      {
        branch: null,
        headSha: null,
        syncedAt: '2026-05-10T00:00:00.000Z',
        maxCommits: 150,
        entries: [
          {
            id: 'bug:1',
            kind: 'bug',
            timestamp: '2026-05-09T00:00:00.000Z',
            title: 'Fix race in core state',
            body: '',
            summary: 'bug memory: touches Core.sync. Signature: TypeError.',
            changeType: 'fix',
            topics: ['core', 'sync'],
            files: ['src/core/state.ts'],
            symbols: ['Core.sync'],
            impacts: [],
            source: 'fix-commit',
            fixedBySha: 'aa11aa11aa11aa11',
            status: 'fixed',
            evidenceScore: 1,
            symptoms: ['state mismatch'],
            errorSignatures: ['TypeError'],
            failingTests: ['test/core.test.ts'],
          },
          {
            id: 'bug:2',
            kind: 'bug',
            timestamp: '2026-05-08T00:00:00.000Z',
            title: 'Fix cache invalidation in core',
            body: '',
            summary: 'bug memory: touches Core.cache.',
            changeType: 'fix',
            topics: ['core', 'cache'],
            files: ['src/core/cache.ts'],
            symbols: ['Core.cache'],
            impacts: [],
            source: 'fix-commit',
            fixedBySha: 'bb22bb22bb22bb22',
            status: 'fixed',
            evidenceScore: 3,
            symptoms: ['stale reads'],
            errorSignatures: ['TimeoutError'],
            failingTests: ['test/cache.test.ts'],
          },
          {
            id: 'bug:3',
            kind: 'bug',
            timestamp: '2026-05-07T00:00:00.000Z',
            title: 'Fix dependency leak in core',
            body: '',
            summary: 'bug memory: touches Core.boundary.',
            changeType: 'fix',
            topics: ['core', 'boundary'],
            files: ['src/core/boundary.ts'],
            symbols: ['Core.boundary'],
            impacts: [],
            source: 'fix-commit',
            fixedBySha: 'cc33cc33cc33cc33',
            status: 'fixed',
            evidenceScore: 2,
            symptoms: ['cross-module leak'],
            errorSignatures: ['ReferenceError'],
            failingTests: ['test/boundary.test.ts'],
          },
          {
            id: 'change:old-feature',
            kind: 'change',
            sha: 'dd44dd44dd44dd44',
            parents: [],
            authorName: 'Test User',
            authorEmail: 'test@example.com',
            timestamp: '2024-01-01T00:00:00.000Z',
            title: 'Add core orchestration feature',
            body: '',
            changeType: 'feature',
            summary: 'feature change: touches core orchestration.',
            topics: ['core', 'orchestration'],
            files: ['src/core/orchestration.ts'],
            symbols: ['Core.orchestrate'],
            impacts: [],
          },
        ],
      },
      null,
      2
    )
  );
}

test('evolution tracks drift and timeline across snapshots', async t => {
  const dir = makeTempDir(t);
  writeArchitecture(dir, 0.45, 2.0);
  writeProjectMemory(dir);

  const first = await refreshEvolutionAsync(dir);
  assert.ok(first.modules.length >= 2);

  writeArchitecture(dir, 0.82, 3.4);
  const second = await refreshEvolutionAsync(dir);
  assert.ok(second.modules.length >= 2);

  const drift = await architectureDriftAsync(dir, 5);
  assert.ok(drift.length > 0);
  assert.ok(drift.some(item => item.module === 'src/core' && item.instabilityDelta !== 0));

  const hotspots = await hotspotAnalysisAsync(dir, 5, 'core');
  assert.ok(hotspots.length > 0);
  assert.equal(hotspots[0]?.module, 'src/core');

  const timeline = await instabilityTimelineAsync(dir, 'src/core', 5);
  assert.ok(timeline.length >= 2);
});

test('governance reports stale and contradictory entries and respects config thresholds', async t => {
  const dir = makeTempDir(t);
  writeArchitecture(dir, 0.86, 3.2);
  writeProjectMemory(dir);

  await saveCognitionConfigAsync(dir, {
    governance: {
      staleConfidenceThreshold: 0.9,
      staleDecayThreshold: 0.2,
    },
    failure: {
      recurringFailureBoundaryCount: 2,
    },
  });

  const snapshot = await refreshMemoryGovernanceAsync(dir);
  assert.ok(snapshot.entries.length > 0);

  const health = await memoryHealthAsync(dir);
  assert.ok(health.staleEntries > 0);
  assert.ok(health.contradictedEntries > 0);

  const stale = await staleMemoryAsync(dir, 20);
  assert.ok(stale.length > 0);

  const contradictions = await contradictionReportAsync(dir, 20);
  assert.ok(contradictions.length > 0);
});
