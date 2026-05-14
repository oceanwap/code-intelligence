import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildProjectIntentSnapshot } from '../src/project-intent.js';

function makeTempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-intent-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeIntentFixtures(dir: string): void {
  const dataDir = path.join(dir, '.code-intelligence');
  fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(
    path.join(dataDir, 'graph.json'),
    JSON.stringify(
      {
        symbols: {
          bootstrap: ['buildProjectIntentSnapshot'],
          buildProjectIntentSnapshot: ['loadGraph'],
          loadGraph: [],
        },
        callers: {
          buildProjectIntentSnapshot: ['bootstrap'],
          loadGraph: ['buildProjectIntentSnapshot'],
        },
        files: {
          'src/mcp-server.ts': ['./project-intent.js'],
          'src/project-intent.ts': ['./graph.js'],
        },
        symbolFile: {
          bootstrap: 'src/mcp-server.ts',
          buildProjectIntentSnapshot: 'src/project-intent.ts',
          loadGraph: 'src/graph.ts',
          AppModule: 'src/app.module.ts',
        },
        supertypes: {},
        subtypes: {},
        implementations: {},
        implementedFrom: {},
      },
      null,
      2
    )
  );

  fs.writeFileSync(
    path.join(dataDir, 'architecture.json'),
    JSON.stringify(
      {
        generatedAt: '2026-05-14T00:00:00.000Z',
        modules: [
          { name: 'src/project-intent', files: 3, symbols: 8, inbound: 3, outbound: 2, zone: 'application' },
          { name: 'src/mcp-server', files: 2, symbols: 5, inbound: 1, outbound: 4, zone: 'delivery' },
        ],
        dependencies: [
          { from: 'src/mcp-server', to: 'src/project-intent', calls: 4, imports: 1, weight: 5 },
        ],
        coupling: {
          'src/project-intent': 2.2,
          'src/mcp-server': 3.4,
        },
        instability: {
          'src/project-intent': 0.4,
          'src/mcp-server': 0.7,
        },
        zones: [
          { name: 'application', modules: ['src/project-intent'] },
          { name: 'delivery', modules: ['src/mcp-server'] },
        ],
      },
      null,
      2
    )
  );

  fs.writeFileSync(
    path.join(dataDir, 'evolution.json'),
    JSON.stringify(
      {
        generatedAt: '2026-05-14T00:00:00.000Z',
        modules: [
          {
            module: 'src/project-intent',
            instabilityTrend: [
              { at: '2026-05-13T00:00:00.000Z', instability: 0.35, coupling: 2.1, bugs: 1, churn: 2, risk: 0.41 },
              { at: '2026-05-14T00:00:00.000Z', instability: 0.4, coupling: 2.2, bugs: 1, churn: 3, risk: 0.46 },
            ],
            couplingTrend: [],
            bugTrend: [],
            riskScore: 0.46,
          },
          {
            module: 'src/mcp-server',
            instabilityTrend: [
              { at: '2026-05-13T00:00:00.000Z', instability: 0.6, coupling: 3.1, bugs: 1, churn: 4, risk: 0.59 },
              { at: '2026-05-14T00:00:00.000Z', instability: 0.7, coupling: 3.4, bugs: 2, churn: 6, risk: 0.71 },
            ],
            couplingTrend: [],
            bugTrend: [],
            riskScore: 0.71,
          },
        ],
        drift: [],
        hotspots: [
          { module: 'src/mcp-server', riskScore: 0.71, churn: 6, bugs: 2, instability: 0.7, coupling: 3.4 },
          { module: 'src/project-intent', riskScore: 0.46, churn: 3, bugs: 1, instability: 0.4, coupling: 2.2 },
        ],
      },
      null,
      2
    )
  );

  fs.writeFileSync(
    path.join(dataDir, 'manifest.json'),
    JSON.stringify(
      {
        indexedAt: '2026-05-14T00:00:00.000Z',
        mtimes: {
          'src/mcp-server.ts': 10,
          'src/project-intent.ts': 20,
        },
        fileChunks: {
          'src/mcp-server.ts': ['a', 'b'],
          'src/project-intent.ts': ['c'],
        },
      },
      null,
      2
    )
  );

  fs.writeFileSync(
    path.join(dataDir, 'project-memory.json'),
    JSON.stringify(
      {
        branch: null,
        headSha: null,
        syncedAt: '2026-05-14T00:00:00.000Z',
        maxCommits: 150,
        entries: [
          {
            id: 'change:1',
            kind: 'change',
            sha: 'abc12345',
            parents: [],
            authorName: 'Test User',
            authorEmail: 'test@example.com',
            timestamp: '2026-05-14T00:00:00.000Z',
            title: 'Improve overview rendering',
            body: '',
            changeType: 'feature',
            summary: 'feature change: touches project intent and MCP surface.',
            topics: ['overview', 'mcp'],
            files: ['src/project-intent.ts', 'src/mcp-server.ts'],
            symbols: ['buildProjectIntentSnapshot', 'bootstrap'],
            impacts: [],
          },
          {
            id: 'doc:1',
            kind: 'document',
            timestamp: '2026-05-14T00:00:00.000Z',
            title: 'Project Overview',
            body: 'Overview body',
            summary: 'overview note: Project Overview. Explains the MCP overview flow.',
            changeType: 'docs',
            topics: ['overview', 'mcp'],
            files: ['README.md'],
            symbols: ['project_intent_snapshot'],
            impacts: [],
            path: 'README.md',
            docType: 'overview',
            section: 'Project Overview',
            sourceMtimeMs: 100,
          },
        ],
      },
      null,
      2
    )
  );
}

test('buildProjectIntentSnapshot returns structured overview metadata', async t => {
  const dir = makeTempDir(t);
  writeIntentFixtures(dir);

  const snapshot = await buildProjectIntentSnapshot(dir);
  assert.ok(snapshot);
  assert.equal(snapshot?.title, path.basename(dir));
  assert.match(snapshot?.contentMd ?? '', /Key modules:/);
  assert.equal(snapshot?.keyModules[0]?.name, 'src/mcp-server');
  assert.match(snapshot?.keyModules[0]?.responsibilityHint ?? '', /Likely owns/);
  assert.equal(snapshot?.keyModules[0]?.primaryOwner, null);
  assert.equal(snapshot?.keyModules[0]?.busFactor, 0);
  assert.ok(snapshot?.entryPoints.some(entry => entry.symbol === 'bootstrap'));
  assert.equal(snapshot?.importantDocs[0]?.title, 'Project Overview');
  assert.equal(snapshot?.gitHealth.totalFilesIndexed, 2);
  assert.equal(snapshot?.gitHealth.indexedChunks, 3);
  assert.equal(snapshot?.gitHealth.churnTrend, 'increasing');
  assert.equal(snapshot?.freshness.memoryRefreshedAt, '2026-05-14T00:00:00.000Z');
});