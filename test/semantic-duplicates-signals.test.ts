import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectSemanticDuplicatesAsync, loadSemanticDuplicates } from '../src/cognition/duplicates/orchestrator.js';
import {
  getDuplicateSummary,
  findDuplicatesForTarget,
  getDuplicateDensityByModule,
  scoreDuplicatePattern,
} from '../src/cognition/duplicates/signals.js';
import { loadGraphAsync } from '../src/graph.js';
import { getDataDir } from '../src/git.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-dup-'));
}

function writeFile(dir: string, relPath: string, content: string): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function createDuplicateProject(dir: string): void {
  writeFile(dir, 'src/utils/helpers.ts', `
export function loadSnapshot(file: string) {
  try {
    const raw = Bun.file(file).text();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
`);
  writeFile(dir, 'src/cognition/engine.ts', `
export function loadEngineSnapshot(file: string) {
  try {
    const raw = Bun.file(file).text();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
`);
  writeFile(dir, 'src/unique.ts', `
export function uniqueLogic(x: number) {
  return x * x;
}
`);
}

test('scoreDuplicatePattern enriches with cross-module and hotspot signals', async () => {
  const dir = makeTempDir();
  try {
    createDuplicateProject(dir);
    const snapshot = await detectSemanticDuplicatesAsync(dir, { minBodyTokens: 4 });
    const pattern = snapshot.patterns.find(p => p.locations.length >= 2);
    assert.ok(pattern, 'expected a duplicate pattern');
    assert.ok(pattern!.signals, 'expected signals to be computed');
    assert.ok(pattern!.recommendation, 'expected recommendation to be computed');
    assert.ok(pattern!.affectedModules!.length >= 2, 'expected cross-module pattern');
    assert.equal(pattern!.signals!.crossModule, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getDuplicateSummary aggregates top modules and files', async () => {
  const dir = makeTempDir();
  try {
    createDuplicateProject(dir);
    const snapshot = await detectSemanticDuplicatesAsync(dir, { minBodyTokens: 4 });
    const summary = getDuplicateSummary(snapshot);
    assert.ok(summary.totalPatterns >= 1);
    assert.ok(summary.topModules.some(m => m.module === 'src/utils' || m.module === 'src/cognition'));
    assert.ok(summary.topFiles.length >= 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findDuplicatesForTarget filters by file, module, or symbol', async () => {
  const dir = makeTempDir();
  try {
    createDuplicateProject(dir);
    const snapshot = await detectSemanticDuplicatesAsync(dir, { minBodyTokens: 4 });
    const byFile = findDuplicatesForTarget(snapshot, 'src/utils/helpers.ts');
    assert.ok(byFile.length >= 1);
    const byModule = findDuplicatesForTarget(snapshot, 'src/cognition');
    assert.ok(byModule.length >= 1);
    const bySymbol = findDuplicatesForTarget(snapshot, 'loadSnapshot');
    assert.ok(bySymbol.length >= 1);
    const byMissing = findDuplicatesForTarget(snapshot, 'nonexistent');
    assert.equal(byMissing.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getDuplicateDensityByModule computes density relative to module size', async () => {
  const dir = makeTempDir();
  try {
    createDuplicateProject(dir);
    const snapshot = await detectSemanticDuplicatesAsync(dir, { minBodyTokens: 4 });
    const graph = await loadGraphAsync(path.join(getDataDir(dir), 'graph.json'));
    // If the project has not been indexed, graph.json is absent; use a synthetic graph.
    const effectiveGraph = graph ?? {
      symbolFile: {
        'loadSnapshot': 'src/utils/helpers.ts',
        'loadEngineSnapshot': 'src/cognition/engine.ts',
        'uniqueLogic': 'src/unique.ts',
      },
      symbols: {},
      callers: {},
      implementations: {},
    };
    const densities = getDuplicateDensityByModule(snapshot, effectiveGraph);
    assert.ok(densities.length >= 2);
    for (const item of densities) {
      assert.ok(item.duplicateLocationCount > 0);
      assert.ok(item.totalSymbols > 0);
      assert.ok(item.density >= 0 && item.density <= 1);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
