/**
 * test/plan-refactor-f7-snapshot-hoist.test.ts — F7 regression test.
 *
 * Pins the F7 fix: `plan_refactor` must load the semantic-duplicates
 * snapshot ONCE per call, not once per changed symbol. Before the fix,
 * `loadSemanticDuplicates` (or the fallback `refreshSemanticDuplicatesAsync`)
 * was invoked inside `readDuplicatesForFile`, which ran inside `scoreSymbol`,
 * which ran inside `Promise.all(top.map(...))` — so a 10-symbol diff
 * triggered up to 10 full Qdrant scans on a fresh project.
 *
 * Contract under test:
 *   Given a diff with N=10 changed symbols (all on different files),
 *   when `planRefactorAsync` is invoked,
 *   then `loadSemanticDuplicates(root)` is called exactly 1 time and
 *        `refreshSemanticDuplicatesAsync(root, ...)` is called at most
 *        1 time across the whole call.
 *
 * Mock strategy: `bun:test`'s `mock.module` lets us intercept the
 * orchestrator module BEFORE plan-refactor.ts resolves its `import { ... }`
 * binding. We then dynamically import plan-refactor so it picks up the
 * mocked module. Restoration happens via `mock.restore()` in `t.after`.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mock, afterAll } from 'bun:test';
import test, { type TestContext } from 'node:test';

import * as orchestrator from '../src/cognition/duplicates/orchestrator.js';
import type { SemanticDuplicateSnapshot } from '../src/cognition/duplicates/types.js';

const FAKE_SNAPSHOT: SemanticDuplicateSnapshot = {
  generatedAt: '2026-07-01T00:00:00.000Z',
  projectRoot: '',
  totalPatterns: 0,
  bySource: {} as SemanticDuplicateSnapshot['bySource'],
  bySeverity: {} as SemanticDuplicateSnapshot['bySeverity'],
  patterns: [],
};

let loadCount = 0;
let refreshCount = 0;

const loadSpy = (async (..._args: unknown[]) => {
  loadCount += 1;
  return null;
}) as typeof orchestrator.loadSemanticDuplicates;

const refreshSpy = (async (..._args: unknown[]) => {
  refreshCount += 1;
  return FAKE_SNAPSHOT;
}) as typeof orchestrator.refreshSemanticDuplicatesAsync;

mock.module('../src/cognition/duplicates/orchestrator.js', () => ({
  ...orchestrator,
  loadSemanticDuplicates: loadSpy,
  refreshSemanticDuplicatesAsync: refreshSpy,
}));

afterAll(() => {
  mock.restore();
});

function makeProjectRoot(t: TestContext): string {
  const base = path.resolve(process.cwd(), '.cog-f7-tmp');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'f7-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function initGit(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: process.env });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, env: process.env });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, env: process.env });
  fs.writeFileSync(path.join(dir, '.keep'), 'placeholder');
  execFileSync('git', ['add', '.keep'], { cwd: dir, env: process.env });
  execFileSync('git', ['commit', '-m', 'init', '-q'], { cwd: dir, env: process.env });
}

test('plan_refactor: loadSemanticDuplicates is called exactly once per planRefactorAsync call (F7)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);

  // Seed 10 distinct files, each modified — gives plan_refactor 10 changed
  // symbols across 10 files. Pre-fix this would have triggered 10 calls.
  const N = 10;
  const srcDir = path.join(root, 'src');
  await fsp.mkdir(srcDir, { recursive: true });
  for (let i = 0; i < N; i++) {
    const file = path.join(srcDir, `mod${i}.ts`);
    await fsp.writeFile(file, `export const v${i} = ${i};\n`);
  }
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed 10 files', '-q'], { cwd: root });
  for (let i = 0; i < N; i++) {
    const file = path.join(srcDir, `mod${i}.ts`);
    await fsp.writeFile(file, `export const v${i} = ${i + 100};\n`);
  }
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'modify 10 files', '-q'], { cwd: root });

  loadCount = 0;
  refreshCount = 0;

  // Dynamic import — plan-refactor picks up the mocked orchestrator via
  // bun:test's mock.module.
  const { planRefactorAsync } = await import('../src/cognition/audit/plan-refactor.js');

  await planRefactorAsync({
    projectRoot: root,
    baseRef: 'HEAD~1',
    headRef: 'HEAD',
    topN: 10,
    writeToBlackboard: false,
  });

  assert.equal(
    loadCount, 1,
    `loadSemanticDuplicates was called ${loadCount} time(s) — expected exactly 1 per planRefactorAsync call (F7 regression)`,
  );
  assert.ok(
    refreshCount <= 1,
    `refreshSemanticDuplicatesAsync was called ${refreshCount} time(s) — expected at most 1 per planRefactorAsync call`,
  );
});