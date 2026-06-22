import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { getAffectedSymbols, getRiskHotspots } from '../src/engineering-insights.js';

function makeTempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-insights-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeFixtures(dir: string): void {
  const dataDir = path.join(dir, '.code-intelligence');
  fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(
    path.join(dataDir, 'graph.json'),
    JSON.stringify(
      {
        symbols: {
          entry: ['Base.run'],
          'Base.run': ['helper'],
          'Concrete.run': ['helper'],
          helper: [],
        },
        callers: {
          'Base.run': ['entry'],
          helper: ['Base.run', 'Concrete.run'],
        },
        files: {
          'src/base.ts': [],
          'src/runner.ts': [],
        },
        symbolFile: {
          Base: 'src/base.ts',
          'Base.run': 'src/base.ts',
          helper: 'src/base.ts',
          Concrete: 'src/runner.ts',
          'Concrete.run': 'src/runner.ts',
          entry: 'src/runner.ts',
        },
        supertypes: {
          Concrete: ['Base'],
        },
        subtypes: {
          Base: ['Concrete'],
        },
        implementations: {
          Base: ['Concrete'],
          'Base.run': ['Concrete.run'],
        },
        implementedFrom: {
          Concrete: ['Base'],
          'Concrete.run': ['Base.run'],
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
        syncedAt: '2026-05-06T00:00:00.000Z',
        maxCommits: 150,
        entries: [
          {
            id: 'change:entry',
            kind: 'change',
            sha: 'entry0001',
            parents: [],
            authorName: 'Test User',
            authorEmail: 'test@example.com',
            timestamp: '2026-05-05T10:00:00.000Z',
            title: 'Add runner entrypoint',
            body: '',
            changeType: 'feature',
            summary: 'feature change: touches entry.',
            topics: ['runner', 'entry'],
            files: ['src/runner.ts'],
            symbols: ['entry'],
            impacts: [],
          },
          {
            id: 'change:base-fix',
            kind: 'change',
            sha: 'base0002',
            parents: [],
            authorName: 'Test User',
            authorEmail: 'test@example.com',
            timestamp: '2026-05-04T10:00:00.000Z',
            title: 'Fix base runner contract',
            body: '',
            changeType: 'fix',
            summary: 'fix change: touches Base.run.',
            topics: ['runner', 'contract'],
            files: ['src/base.ts'],
            symbols: ['Base.run'],
            impacts: [],
          },
          {
            id: 'change:refine-run',
            kind: 'change',
            sha: 'base0003',
            parents: [],
            authorName: 'Test User',
            authorEmail: 'test@example.com',
            timestamp: '2026-05-03T10:00:00.000Z',
            title: 'Refine run implementations',
            body: '',
            changeType: 'refactor',
            summary: 'refactor change: touches Base.run and Concrete.run.',
            topics: ['runner', 'flow'],
            files: ['src/base.ts', 'src/runner.ts'],
            symbols: ['Base.run', 'Concrete.run'],
            impacts: [],
          },
        ],
      },
      null,
      2
    )
  );
}

test('getAffectedSymbols ranks callers, dependencies, and implementations around a seed', async t => {
  const dir = makeTempDir(t);
  writeFixtures(dir);

  const result = await getAffectedSymbols(dir, ['Base.run'], { hops: 2, direction: 'both', limit: 10 });
  assert.ok(result);
  assert.equal(result.missingSeeds.length, 0);
  assert.ok(result.totalDiscovered >= 3);

  const bySymbol = new Map(result.entries.map(entry => [entry.symbol, entry]));
  assert.equal(bySymbol.get('entry')?.distance, 1);
  assert.equal(bySymbol.get('helper')?.distance, 1);
  assert.equal(bySymbol.get('Concrete.run')?.distance, 1);

  assert.ok(bySymbol.get('entry')?.reasons.some(reason => reason.kind === 'calledBy' && reason.via === 'Base.run'));
  assert.ok(bySymbol.get('Concrete.run')?.reasons.some(reason => reason.kind === 'implements' && reason.via === 'Base.run'));
  assert.equal(bySymbol.get('Concrete.run')?.changeCount, 1);
  assert.equal(bySymbol.get('Concrete.run')?.fixCount, 0);
});

test('getRiskHotspots ranks unstable, connected symbols and files', async t => {
  const dir = makeTempDir(t);
  writeFixtures(dir);

  const result = await getRiskHotspots(dir, 5);
  assert.ok(result);

  assert.equal(result.symbols[0]?.symbol, 'Base.run');
  assert.equal(result.symbols[0]?.changeCount, 2);
  assert.equal(result.symbols[0]?.fixCount, 1);
  assert.equal(result.symbols[0]?.dependentsCount, 1);
  assert.equal(result.symbols[0]?.testGap, true);
  assert.ok(result.symbols[0]?.impactSurface.some(entry => entry.symbol === 'entry'));
  assert.match(result.symbols[0]?.riskSummary ?? '', /Base\.run/);
  assert.ok(result.symbols.some(entry => entry.symbol === 'Concrete.run'));

  assert.equal(result.files[0]?.file, 'src/base.ts');
  assert.equal(result.files[0]?.changeCount, 2);
  assert.equal(result.files[0]?.fixCount, 1);
  assert.equal(result.files[0]?.testGap, true);
  assert.ok(result.files[0]?.impactSurface.some(entry => entry.file === 'src/runner.ts'));
  assert.match(result.files[0]?.riskSummary ?? '', /src\/base\.ts/);
  assert.ok(result.files.some(entry => entry.file === 'src/runner.ts'));
});

test('getRiskHotspots filters history by topic before ranking', async t => {
  const dir = makeTempDir(t);
  writeFixtures(dir);

  const result = await getRiskHotspots(dir, { limit: 5, topic: 'contract' });
  assert.ok(result);

  assert.deepEqual(result.symbols.map(entry => entry.symbol), ['Base.run']);
  assert.deepEqual(result.files.map(entry => entry.file), ['src/base.ts']);
});

test('getRiskHotspots returns null when graph is missing', async t => {
  const dir = makeTempDir(t);
  const dataDir = path.join(dir, '.code-intelligence');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'project-memory.json'), JSON.stringify({ entries: [] }));

  const result = await getRiskHotspots(dir, 5);
  assert.equal(result, null);
});

test('getRiskHotspots returns null for malformed graph instead of throwing', async t => {
  const dir = makeTempDir(t);
  const dataDir = path.join(dir, '.code-intelligence');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'graph.json'),
    JSON.stringify({ symbols: {}, callers: {} })
  );
  fs.writeFileSync(path.join(dataDir, 'project-memory.json'), JSON.stringify({ entries: [] }));

  const result = await getRiskHotspots(dir, 5);
  assert.equal(result, null);
});

test('getRiskHotspots can sort by churn separately from connectivity', async t => {
  const dir = makeTempDir(t);
  writeFixtures(dir);

  const churnResult = await getRiskHotspots(dir, { limit: 5, sortBy: 'churn' });
  assert.ok(churnResult);
  assert.equal(churnResult.symbols[0]?.symbol, 'Base.run');
  assert.ok((churnResult.symbols[0]?.churnScore ?? 0) > (churnResult.symbols[0]?.connectivityScore ?? 0));

  const connectivityResult = await getRiskHotspots(dir, { limit: 5, sortBy: 'connectivity' });
  assert.ok(connectivityResult);
  assert.equal(connectivityResult.symbols[0]?.symbol, 'Base.run');
  assert.ok(connectivityResult.symbols.every(entry => entry.dependentsCount > 0));
});