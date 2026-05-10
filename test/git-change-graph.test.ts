import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildGraph } from '../src/graph.js';
import { buildGitSemanticChangeGraph } from '../src/git-change-graph.js';

function makeTempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-git-change-graph-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function runGit(dir: string, args: string[], env?: Record<string, string>): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
    },
  }).trim();
}

function initRepo(dir: string): void {
  runGit(dir, ['init']);
  runGit(dir, ['config', 'user.name', 'Test User']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
}

test('git semantic change graph detects signature changes in commit mode', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const servicePath = path.join(srcDir, 'service.ts');
  fs.writeFileSync(
    servicePath,
    [
      'export function compute(value: number): number {',
      '  return value + 1;',
      '}',
      '',
      'export function caller(): number {',
      '  return compute(1);',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial service']);

  fs.writeFileSync(
    servicePath,
    [
      'export function compute(value: number, multiplier: number): string {',
      '  return String(value * multiplier + 1);',
      '}',
      '',
      'export function caller(): string {',
      '  return compute(1, 2);',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'change compute signature']);
  const commitSha = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const result = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
  });

  const compute = result.symbols.find(symbol => symbol.symbol === 'compute' && symbol.kind === 'modified');
  assert.ok(compute, 'expected compute to be marked as modified');
  assert.equal(compute?.signatureChanged, true);
  assert.ok(compute?.signatureDelta, 'expected compute to include signatureDelta');
  assert.deepEqual(compute?.signatureDelta?.paramsAdded, ['multiplier:number']);
  assert.deepEqual(compute?.signatureDelta?.paramsRemoved, []);
  assert.equal(compute?.signatureDelta?.returnTypeChanged, true);
  assert.equal(compute?.signatureDelta?.visibilityChanged, false);
  assert.equal(compute?.signatureDelta?.asyncChanged, false);
  assert.equal(compute?.signatureDelta?.staticChanged, false);
  assert.ok(compute?.evidence.includes('signature_diff'));
  assert.ok(result.signals.signatureChangedSymbols >= 1);
});

test('git semantic change graph computes signatureDelta for parameter removal', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const servicePath = path.join(srcDir, 'service.ts');
  fs.writeFileSync(
    servicePath,
    [
      'export function measure(value: number, offset: number): number {',
      '  return value + offset;',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial measure']);

  fs.writeFileSync(
    servicePath,
    [
      'export function measure(value: number): number {',
      '  return value + 1;',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'remove measure offset']);
  const commitSha = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const result = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
  });

  const measure = result.symbols.find(symbol => symbol.symbol === 'measure' && symbol.kind === 'modified');
  assert.ok(measure, 'expected measure to be marked as modified');
  assert.ok(measure?.signatureDelta, 'expected measure to include signatureDelta');
  assert.deepEqual(measure?.signatureDelta?.paramsAdded, []);
  assert.deepEqual(measure?.signatureDelta?.paramsRemoved, ['offset:number']);
  assert.equal(measure?.signatureDelta?.returnTypeChanged, false);
});

test('git semantic change graph emits rename and usage/caller deltas', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const servicePath = path.join(srcDir, 'service.ts');
  fs.writeFileSync(
    servicePath,
    [
      'export function foo(value: number): number {',
      '  const next = value + 1;',
      '  return next * 2;',
      '}',
      '',
      'export function caller(): number {',
      '  return foo(1);',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial foo']);

  fs.writeFileSync(
    servicePath,
    [
      'export function bar(value: number): number {',
      '  const next = value + 1;',
      '  return next * 2;',
      '}',
      '',
      'export function caller(): number {',
      '  return bar(1);',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'rename foo to bar']);
  const commitSha = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const result = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
  });

  const addedBar = result.symbols.find(symbol => symbol.symbol === 'bar' && symbol.kind === 'added');
  const deletedFoo = result.symbols.find(symbol => symbol.symbol === 'foo' && symbol.kind === 'deleted');

  assert.ok(addedBar, 'expected bar to be marked as added');
  assert.ok(deletedFoo, 'expected foo to be marked as deleted');
  assert.equal(addedBar?.probableRenameFrom, 'foo');
  assert.equal(deletedFoo?.probableRenameTo, 'bar');
  assert.ok((addedBar?.renameConfidence ?? 0) >= 0.85);
  assert.ok((deletedFoo?.renameConfidence ?? 0) >= 0.85);
  assert.ok(addedBar?.evidence.includes('rename_match'));
  assert.ok(addedBar?.evidence.includes('rename_similarity_high'));
  assert.ok(deletedFoo?.evidence.includes('rename_match'));

  assert.ok(typeof deletedFoo?.usageDelta?.delta === 'number');
  assert.ok(typeof deletedFoo?.callerDelta?.removedCallers.length === 'number');
  assert.equal(deletedFoo?.callerDelta?.mode, 'semantic');
  assert.ok(deletedFoo?.evidence.includes('reference_delta_present'));
  assert.ok(deletedFoo?.evidence.includes('caller_delta_present'));
  assert.ok(deletedFoo?.evidence.includes('caller_delta_semantic'));
  assert.ok(result.signals.probableRenames >= 1);
  assert.ok(result.signals.usageDeltaComputedSymbols >= 1);
  assert.ok(result.signals.callerDeltaComputedSymbols >= 1);
  assert.ok(result.signals.semanticCallerDeltaComputedSymbols >= 1);
});

test('git semantic change graph marks deleted symbols as still referenced when callers remain', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const servicePath = path.join(srcDir, 'service.ts');
  fs.writeFileSync(
    servicePath,
    [
      'export function removedFn(value: number): number {',
      '  return value + 1;',
      '}',
      '',
      'export function caller(): number {',
      '  return removedFn(1);',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial removedFn']);

  fs.writeFileSync(
    servicePath,
    [
      'export function caller(): number {',
      '  return removedFn(1);',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'delete function but keep caller']);
  const commitSha = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const result = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
  });

  const deleted = result.symbols.find(symbol => symbol.symbol === 'removedFn' && symbol.kind === 'deleted');
  assert.ok(deleted, 'expected removedFn to be marked as deleted');
  assert.equal(deleted?.stillReferenced, true);
  assert.ok(deleted?.evidence.includes('deleted_still_referenced'));
  assert.ok((deleted?.usageDelta?.afterReferenceCount ?? 0) > 0);
});

test('git semantic change graph avoids false rename when bodies are dissimilar', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const servicePath = path.join(srcDir, 'service.ts');
  fs.writeFileSync(
    servicePath,
    [
      'export function alpha(value: number): number {',
      '  const doubled = value * 2;',
      '  return doubled + 1;',
      '}',
      '',
      'export function caller(): number {',
      '  return alpha(1);',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial alpha']);

  fs.writeFileSync(
    servicePath,
    [
      'export function omega(value: number): number {',
      '  if (value % 2 === 0) {',
      '    return value / 2;',
      '  }',
      '  return value * 3 + 7;',
      '}',
      '',
      'export function caller(): number {',
      '  return omega(1);',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'replace alpha with omega']);
  const commitSha = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const result = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
  });

  const addedOmega = result.symbols.find(symbol => symbol.symbol === 'omega' && symbol.kind === 'added');
  const deletedAlpha = result.symbols.find(symbol => symbol.symbol === 'alpha' && symbol.kind === 'deleted');

  assert.ok(addedOmega, 'expected omega to be marked as added');
  assert.ok(deletedAlpha, 'expected alpha to be marked as deleted');
  assert.equal(addedOmega?.probableRenameFrom, undefined);
  assert.equal(deletedAlpha?.probableRenameTo, undefined);
  assert.equal(addedOmega?.renameConfidence, undefined);
  assert.equal(deletedAlpha?.renameConfidence, undefined);
});

test('git semantic change graph emits move confidence for renamed files', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const originalPath = path.join(srcDir, 'service.ts');
  fs.writeFileSync(
    originalPath,
    [
      'export function retained(value: number): number {',
      '  return value + 1;',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial file for move']);

  const movedPath = path.join(srcDir, 'renamed-service.ts');
  fs.renameSync(originalPath, movedPath);
  fs.writeFileSync(
    movedPath,
    [
      'export function retained(value: number): number {',
      '  const next = value + 1;',
      '  return next;',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '-A']);
  runGit(dir, ['commit', '-m', 'rename service file']);
  const commitSha = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const result = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
  });

  const retained = result.symbols.find(symbol => symbol.symbol === 'retained' && symbol.kind === 'modified');
  assert.ok(retained, 'expected retained to be marked as modified in rename commit');
  assert.ok(retained?.probableMoveFromFile, 'expected probableMoveFromFile to be set');
  assert.ok((retained?.moveConfidence ?? 0) >= 0.9);
  assert.ok(retained?.evidence.includes('move_detected'));
  assert.ok(retained?.evidence.includes('move_confident'));
});

test('git semantic change graph supports range mode across multiple commits', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const servicePath = path.join(srcDir, 'service.ts');
  fs.writeFileSync(
    servicePath,
    [
      'export function base(value: number): number {',
      '  return value + 1;',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial base']);
  const baseRef = runGit(dir, ['rev-parse', 'HEAD']);

  fs.writeFileSync(
    servicePath,
    [
      'export function base(value: number, offset: number): number {',
      '  return value + offset + 1;',
      '}',
    ].join('\n')
  );
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'change base signature']);

  fs.writeFileSync(
    servicePath,
    [
      'export function base(value: number, offset: number): number {',
      '  return value + offset + 1;',
      '}',
      '',
      'export function helper(): number {',
      '  return base(1, 2);',
      '}',
    ].join('\n')
  );
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'add helper caller']);
  const headRef = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const result = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'range',
    baseRef,
    headRef,
    limit: 80,
  });

  assert.equal(result.mode, 'range');
  assert.equal(result.sourceRef, baseRef);
  assert.equal(result.targetRef, headRef);
  assert.ok(result.changedFiles >= 1);
  assert.ok(result.symbols.some(symbol => symbol.symbol === 'helper' && symbol.kind === 'added'));
  assert.ok(result.signals.signatureChangedSymbols >= 1);
});

test('git semantic change graph meets baseline quality gates on labeled fixture', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const servicePath = path.join(srcDir, 'service.ts');
  fs.writeFileSync(
    servicePath,
    [
      'export function alpha(value: number): number {',
      '  const next = value + 1;',
      '  return next * 2;',
      '}',
      '',
      'export function beta(value: number): number {',
      '  return value + 3;',
      '}',
      '',
      'export function caller(): number {',
      '  return alpha(beta(1));',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial fixture']);

  fs.writeFileSync(
    servicePath,
    [
      'export function gamma(value: number): number {',
      '  const next = value + 1;',
      '  return next * 2;',
      '}',
      '',
      'export function beta(value: number, offset: number): number {',
      '  return value + offset + 3;',
      '}',
      '',
      'export function caller(): number {',
      '  return gamma(beta(1, 2));',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'rename alpha, change beta signature']);
  const commitSha = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const result = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
  });

  const expectedChanged = new Set(['alpha', 'gamma', 'beta']);
  const observedChanged = new Set(result.symbols.map(symbol => symbol.symbol));
  assert.ok(result.symbols.every(symbol => symbol.evidence.length > 0));
  const matchedChanged = [...expectedChanged].filter(symbol => observedChanged.has(symbol)).length;
  const changedRecall = matchedChanged / expectedChanged.size;

  const renamePredictions = result.symbols.filter(symbol => Boolean(symbol.probableRenameFrom));
  const renameTruePositives = renamePredictions.filter(symbol =>
    symbol.symbol === 'gamma' && symbol.probableRenameFrom === 'alpha'
  ).length;
  const renamePrecision = renamePredictions.length === 0 ? 0 : renameTruePositives / renamePredictions.length;

  const expectedSignature = new Set(['beta']);
  const signaturePredictions = new Set(
    result.symbols.filter(symbol => symbol.signatureChanged).map(symbol => symbol.symbol)
  );
  const matchedSignature = [...expectedSignature].filter(symbol => signaturePredictions.has(symbol)).length;
  const signatureRecall = matchedSignature / expectedSignature.size;

  assert.ok(
    changedRecall >= 1,
    `changed symbol recall below gate: ${changedRecall.toFixed(3)}`
  );
  assert.ok(
    renamePrecision >= 0.95,
    `rename precision below gate: ${renamePrecision.toFixed(3)}`
  );
  assert.ok(
    signatureRecall >= 1,
    `signature recall below gate: ${signatureRecall.toFixed(3)}`
  );
});

test('git semantic change graph meets range-mode quality gates on multi-commit fixture', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const servicePath = path.join(srcDir, 'service.ts');
  fs.writeFileSync(
    servicePath,
    [
      'export function core(value: number): number {',
      '  return value + 1;',
      '}',
      '',
      'export function util(value: number): number {',
      '  const next = value + 1;',
      '  return next * 2;',
      '}',
      '',
      'export function caller(): number {',
      '  return util(core(1));',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial range fixture']);
  const baseRef = runGit(dir, ['rev-parse', 'HEAD']);

  fs.writeFileSync(
    servicePath,
    [
      'export function core(value: number, offset: number): number {',
      '  return value + offset + 1;',
      '}',
      '',
      'export function util(value: number): number {',
      '  const next = value + 1;',
      '  return next * 2;',
      '}',
      '',
      'export function caller(): number {',
      '  return util(core(1, 2));',
      '}',
    ].join('\n')
  );
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'change core signature']);

  fs.writeFileSync(
    servicePath,
    [
      'export function core(value: number, offset: number): number {',
      '  return value + offset + 1;',
      '}',
      '',
      'export function compute(value: number): number {',
      '  const next = value + 1;',
      '  return next * 2;',
      '}',
      '',
      'export function caller(): number {',
      '  return compute(core(1, 2));',
      '}',
    ].join('\n')
  );
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'rename util to compute']);
  const headRef = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const result = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'range',
    baseRef,
    headRef,
    limit: 80,
  });

  const expectedChanged = new Set(['core', 'util', 'compute']);
  const observedChanged = new Set(result.symbols.map(symbol => symbol.symbol));
  const matchedChanged = [...expectedChanged].filter(symbol => observedChanged.has(symbol)).length;
  const changedRecall = matchedChanged / expectedChanged.size;

  const renamePredictions = result.symbols.filter(symbol => Boolean(symbol.probableRenameFrom));
  const renameTruePositives = renamePredictions.filter(symbol =>
    symbol.symbol === 'compute' && symbol.probableRenameFrom === 'util'
  ).length;
  const renamePrecision = renamePredictions.length === 0 ? 0 : renameTruePositives / renamePredictions.length;

  const expectedSignature = new Set(['core']);
  const signaturePredictions = new Set(
    result.symbols.filter(symbol => symbol.signatureChanged).map(symbol => symbol.symbol)
  );
  const matchedSignature = [...expectedSignature].filter(symbol => signaturePredictions.has(symbol)).length;
  const signatureRecall = matchedSignature / expectedSignature.size;

  assert.ok(
    changedRecall >= 1,
    `range changed symbol recall below gate: ${changedRecall.toFixed(3)}`
  );
  assert.ok(
    renamePrecision >= 0.95,
    `range rename precision below gate: ${renamePrecision.toFixed(3)}`
  );
  assert.ok(
    signatureRecall >= 1,
    `range signature recall below gate: ${signatureRecall.toFixed(3)}`
  );
  assert.ok(result.signals.semanticCallerDeltaComputedSymbols >= 1);
  assert.ok(result.symbols.every(symbol => symbol.evidence.length > 0));
});

test('git semantic change graph falls back to inferred caller delta mode when semantic graphs are unavailable', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const servicePath = path.join(srcDir, 'service.ts');
  fs.writeFileSync(
    servicePath,
    [
      'export function value(): number {',
      '  return 1;',
      '}',
      '',
      'export function caller(): number {',
      '  return value();',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial value']);

  fs.writeFileSync(
    servicePath,
    [
      'export function nextValue(): number {',
      '  return 2;',
      '}',
      '',
      'export function caller(): number {',
      '  return nextValue();',
      '}',
    ].join('\n')
  );

  const result = await buildGitSemanticChangeGraph(dir, null, {
    mode: 'working_tree',
    limit: 80,
  });

  const inferredSymbol = result.symbols.find(symbol => symbol.callerDelta?.mode === 'inferred');
  assert.ok(inferredSymbol, 'expected at least one symbol to use inferred caller delta mode');
  assert.ok(inferredSymbol?.evidence.includes('caller_delta_inferred'));
  assert.ok(inferredSymbol?.evidence.includes('fallback_mode_used'));
  assert.ok(result.metadata.fallbackRatio > 0);
  assert.ok(result.metadata.graphFreshness.status !== 'fresh');
  assert.ok(result.metadata.unresolvedSymbolRatio >= 0);
  assert.ok((inferredSymbol?.confidenceScore ?? 1) <= 0.7);
  assert.ok(result.signals.inferredCallerDeltaComputedSymbols >= 1);
});

test('git semantic change graph detects deleted symbol still referenced across files', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const servicePath = path.join(srcDir, 'service.ts');
  const consumerPath = path.join(srcDir, 'consumer.ts');
  fs.writeFileSync(
    servicePath,
    [
      'export function removedAcrossFiles(value: number): number {',
      '  return value + 10;',
      '}',
    ].join('\n')
  );
  fs.writeFileSync(
    consumerPath,
    [
      "import { removedAcrossFiles } from './service';",
      '',
      'export function consumer(): number {',
      '  return removedAcrossFiles(1);',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial cross-file removed symbol']);

  fs.writeFileSync(servicePath, '');

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'delete removedAcrossFiles from service']);
  const commitSha = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const result = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
  });

  const deleted = result.symbols.find(symbol => symbol.symbol === 'removedAcrossFiles' && symbol.kind === 'deleted');
  assert.ok(deleted, 'expected removedAcrossFiles to be marked as deleted');
  assert.equal(deleted?.stillReferenced, true);
  assert.ok((deleted?.usageDelta?.afterReferenceCount ?? 0) > 0);
  assert.equal(deleted?.callerDelta?.mode, 'semantic');
});

test('git semantic change graph meets multi-file range quality gates for api churn', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const apiPath = path.join(srcDir, 'api.ts');
  const featurePath = path.join(srcDir, 'feature.ts');

  fs.writeFileSync(
    apiPath,
    [
      'export function score(value: number): number {',
      '  return value + 1;',
      '}',
      '',
      'export function mapValue(input: number): number {',
      '  return input * 2;',
      '}',
    ].join('\n')
  );
  fs.writeFileSync(
    featurePath,
    [
      "import { mapValue, score } from './api';",
      '',
      'export function runFeature(seed: number): number {',
      '  return mapValue(score(seed));',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial api churn fixture']);
  const baseRef = runGit(dir, ['rev-parse', 'HEAD']);

  fs.writeFileSync(
    apiPath,
    [
      'export function score(value: number, offset: number): number {',
      '  return value + offset + 1;',
      '}',
      '',
      'export function mapValue(input: number): number {',
      '  return input * 2;',
      '}',
    ].join('\n')
  );
  fs.writeFileSync(
    featurePath,
    [
      "import { mapValue, score } from './api';",
      '',
      'export function runFeature(seed: number): number {',
      '  return mapValue(score(seed, 3));',
      '}',
    ].join('\n')
  );
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'change score signature']);

  fs.writeFileSync(
    apiPath,
    [
      'export function score(value: number, offset: number): number {',
      '  return value + offset + 1;',
      '}',
      '',
      'export function transformValue(input: number): number {',
      '  return input * 2;',
      '}',
    ].join('\n')
  );
  fs.writeFileSync(
    featurePath,
    [
      "import { score, transformValue } from './api';",
      '',
      'export function runFeature(seed: number): number {',
      '  return transformValue(score(seed, 3));',
      '}',
    ].join('\n')
  );
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'rename mapValue to transformValue']);
  const headRef = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const result = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'range',
    baseRef,
    headRef,
    limit: 80,
  });

  const expectedChanged = new Set(['score', 'mapValue', 'transformValue']);
  const observedChanged = new Set(result.symbols.map(symbol => symbol.symbol));
  const matchedChanged = [...expectedChanged].filter(symbol => observedChanged.has(symbol)).length;
  const changedRecall = matchedChanged / expectedChanged.size;

  const renamePredictions = result.symbols.filter(symbol => Boolean(symbol.probableRenameFrom));
  const renameTruePositives = renamePredictions.filter(symbol =>
    symbol.symbol === 'transformValue' && symbol.probableRenameFrom === 'mapValue'
  ).length;
  const renamePrecision = renamePredictions.length === 0 ? 0 : renameTruePositives / renamePredictions.length;

  const expectedSignature = new Set(['score']);
  const signaturePredictions = new Set(
    result.symbols.filter(symbol => symbol.signatureChanged).map(symbol => symbol.symbol)
  );
  const matchedSignature = [...expectedSignature].filter(symbol => signaturePredictions.has(symbol)).length;
  const signatureRecall = matchedSignature / expectedSignature.size;

  assert.ok(changedRecall >= 1, `multi-file changed recall below gate: ${changedRecall.toFixed(3)}`);
  assert.ok(renamePrecision >= 0.95, `multi-file rename precision below gate: ${renamePrecision.toFixed(3)}`);
  assert.ok(signatureRecall >= 1, `multi-file signature recall below gate: ${signatureRecall.toFixed(3)}`);
  assert.ok(result.signals.semanticCallerDeltaComputedSymbols >= 1);
});

test('git semantic change graph avoids rename matches for same-body symbols in different scopes', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const classesPath = path.join(srcDir, 'classes.ts');
  fs.writeFileSync(
    classesPath,
    [
      'export class Alpha {',
      '  value(v: number): number {',
      '    return v * 2 + 1;',
      '  }',
      '}',
      '',
      'export class Beta {',
      '  keep(v: number): number {',
      '    return v + 1;',
      '  }',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial scoped symbols']);

  fs.writeFileSync(
    classesPath,
    [
      'export class Beta {',
      '  keep(v: number): number {',
      '    return v + 1;',
      '  }',
      '}',
      '',
      'export class Gamma {',
      '  value(v: number): number {',
      '    return v * 2 + 1;',
      '  }',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'move same-body method across scope']);
  const commitSha = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const result = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
  });

  const added = result.symbols.find(symbol => symbol.symbol === 'Gamma.value' && symbol.kind === 'added');
  const deleted = result.symbols.find(symbol => symbol.symbol === 'Alpha.value' && symbol.kind === 'deleted');
  assert.ok(added, 'expected Gamma.value to be marked as added');
  assert.ok(deleted, 'expected Alpha.value to be marked as deleted');
  assert.equal(added?.probableRenameFrom, undefined);
  assert.equal(deleted?.probableRenameTo, undefined);
});

test('git semantic change graph filters format-only noise by default and includes it with includeNoise', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const servicePath = path.join(srcDir, 'service.ts');
  fs.writeFileSync(
    servicePath,
    [
      'export function noisyFormat(value: number): number {',
      '  return value + 1;',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial format-only fixture']);

  fs.writeFileSync(
    servicePath,
    [
      'export function noisyFormat(value: number): number {',
      '  return   value   +   1;',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'format only change']);
  const commitSha = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const withoutNoise = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
  });
  const withNoise = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
    includeNoise: true,
  });

  assert.equal(withoutNoise.symbols.length, 0);
  assert.ok(withoutNoise.signals.filteredNoiseSymbols >= 1);
  const noiseSymbol = withNoise.symbols.find(symbol => symbol.symbol === 'noisyFormat');
  assert.ok(noiseSymbol, 'expected noisyFormat symbol when includeNoise=true');
  assert.ok(noiseSymbol?.isNoise);
  assert.ok(noiseSymbol?.noiseTags.includes('format_only'));
  assert.ok(withNoise.signals.noisySymbols >= 1);
});

test('git semantic change graph filters import-only noise by default and includes it with includeNoise', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const depsPath = path.join(srcDir, 'deps.ts');
  const servicePath = path.join(srcDir, 'service.ts');
  fs.writeFileSync(
    depsPath,
    [
      'export const helperA = (value: number): number => value + 1;',
      'export const helperB = (value: number): number => value + 2;',
    ].join('\n')
  );
  fs.writeFileSync(
    servicePath,
    [
      "import { helperA } from './deps';",
      '',
      'export function importOnlyNoise(seed: number): number {',
      '  return helperA(seed);',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial import-only fixture']);

  fs.writeFileSync(
    servicePath,
    [
      "import { helperA, helperB } from './deps';",
      '',
      'export function importOnlyNoise(seed: number): number {',
      '  return helperA(seed);',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'import only change']);
  const commitSha = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const withoutNoise = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
  });
  const withNoise = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
    includeNoise: true,
  });

  assert.ok(withNoise.symbols.length >= withoutNoise.symbols.length);
  if (withNoise.symbols.length > 0) {
    const noisy = withNoise.symbols.find(symbol => symbol.symbol === 'importOnlyNoise');
    assert.ok(noisy, 'expected importOnlyNoise symbol when includeNoise=true when symbols are emitted');
    assert.ok(noisy?.isNoise);
    assert.ok(noisy?.noiseTags.includes('import_only'));
    assert.ok(withNoise.signals.noisySymbols >= 1);
  }
});

test('git semantic change graph filters generated-like paths by default and includes them with includeNoise', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  const generatedDir = path.join(dir, 'dist');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(generatedDir, { recursive: true });
  initRepo(dir);

  const generatedPath = path.join(generatedDir, 'bundle.generated.ts');
  fs.writeFileSync(
    generatedPath,
    [
      'export function generatedNoise(v: number): number {',
      '  return v + 1;',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial generated-like fixture']);

  fs.writeFileSync(
    generatedPath,
    [
      'export function generatedNoise(v: number): number {',
      '  return v + 2;',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'change generated-like output']);
  const commitSha = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const withoutNoise = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
  });
  const withNoise = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
    includeNoise: true,
  });

  assert.equal(withoutNoise.symbols.length, 0);
  assert.ok(withoutNoise.signals.filteredNoiseSymbols >= 1);
  const noisy = withNoise.symbols.find(symbol => symbol.symbol === 'generatedNoise');
  assert.ok(noisy, 'expected generatedNoise symbol when includeNoise=true');
  assert.ok(noisy?.isNoise);
  assert.ok(noisy?.noiseTags.includes('generated_like'));
  assert.ok(withNoise.signals.noisySymbols >= 1);
});

test('git semantic change graph keeps high-signal symbols when mixed with generated-like noise', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  const generatedDir = path.join(dir, 'dist');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(generatedDir, { recursive: true });
  initRepo(dir);

  const servicePath = path.join(srcDir, 'service.ts');
  const generatedPath = path.join(generatedDir, 'bundle.generated.ts');
  fs.writeFileSync(
    servicePath,
    [
      'export function stableCore(value: number): number {',
      '  return value + 1;',
      '}',
      '',
      'export function caller(): number {',
      '  return stableCore(1);',
      '}',
    ].join('\n')
  );
  fs.writeFileSync(
    generatedPath,
    [
      'export function generatedNoise(v: number): number {',
      '  return v + 1;',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial mixed-noise fixture']);

  fs.writeFileSync(
    servicePath,
    [
      'export function stableCore(value: number, offset: number): number {',
      '  return value + offset + 1;',
      '}',
      '',
      'export function caller(): number {',
      '  return stableCore(1, 2);',
      '}',
    ].join('\n')
  );
  fs.writeFileSync(
    generatedPath,
    [
      'export function generatedNoise(v: number): number {',
      '  return v + 2;',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'signature churn plus generated noise']);
  const commitSha = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const defaultResult = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
  });
  const includeNoiseResult = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
    includeNoise: true,
  });

  const coreDefault = defaultResult.symbols.find(symbol => symbol.symbol === 'stableCore');
  assert.ok(coreDefault, 'expected stableCore in default filtered output');
  assert.equal(coreDefault?.signatureChanged, true);
  assert.ok(defaultResult.symbols.every(symbol => !symbol.noiseTags.includes('generated_like')));

  const generatedWithNoise = includeNoiseResult.symbols.find(symbol => symbol.symbol === 'generatedNoise');
  assert.ok(generatedWithNoise, 'expected generatedNoise when includeNoise=true');
  assert.ok(generatedWithNoise?.noiseTags.includes('generated_like'));
  assert.ok(defaultResult.signals.filteredNoiseSymbols >= 1);
});

test('git semantic change graph keeps high-signal symbols when mixed with format-only noise', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const corePath = path.join(srcDir, 'core.ts');
  const noisyPath = path.join(srcDir, 'noisy.ts');
  fs.writeFileSync(
    corePath,
    [
      'export function changeMe(value: number): number {',
      '  return value + 1;',
      '}',
    ].join('\n')
  );
  fs.writeFileSync(
    noisyPath,
    [
      'export function formatOnly(v: number): number {',
      '  return v + 1;',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial mixed format fixture']);

  fs.writeFileSync(
    corePath,
    [
      'export function changeMe(value: number, extra: number): number {',
      '  return value + extra + 1;',
      '}',
    ].join('\n')
  );
  fs.writeFileSync(
    noisyPath,
    [
      'export function formatOnly(v: number): number {',
      '  return  v  +  1;',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'real change plus format noise']);
  const commitSha = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const defaultResult = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
  });
  const includeNoiseResult = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
    includeNoise: true,
  });

  const changed = defaultResult.symbols.find(symbol => symbol.symbol === 'changeMe');
  assert.ok(changed, 'expected changeMe in default filtered output');
  assert.equal(changed?.signatureChanged, true);
  assert.ok(defaultResult.symbols.every(symbol => !symbol.noiseTags.includes('format_only')));

  const noisy = includeNoiseResult.symbols.find(symbol => symbol.symbol === 'formatOnly');
  assert.ok(noisy, 'expected formatOnly when includeNoise=true');
  assert.ok(noisy?.noiseTags.includes('format_only'));
  assert.ok(defaultResult.signals.filteredNoiseSymbols >= 1);
});

test('git semantic change graph keeps high-signal symbols when mixed with import-only noise', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const depsPath = path.join(srcDir, 'deps.ts');
  const corePath = path.join(srcDir, 'core.ts');
  const noisyPath = path.join(srcDir, 'noisy-import.ts');

  fs.writeFileSync(
    depsPath,
    [
      'export const helperA = (v: number): number => v + 1;',
      'export const helperB = (v: number): number => v + 2;',
    ].join('\n')
  );
  fs.writeFileSync(
    corePath,
    [
      'export function importantCore(value: number): number {',
      '  return value + 1;',
      '}',
    ].join('\n')
  );
  fs.writeFileSync(
    noisyPath,
    [
      "import { helperA } from './deps';",
      '',
      'export function importNoise(seed: number): number {',
      '  return helperA(seed);',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial mixed import noise fixture']);

  fs.writeFileSync(
    corePath,
    [
      'export function importantCore(value: number, extra: number): number {',
      '  return value + extra + 1;',
      '}',
    ].join('\n')
  );
  fs.writeFileSync(
    noisyPath,
    [
      "import { helperA, helperB } from './deps';",
      '',
      'export function importNoise(seed: number): number {',
      '  return helperA(seed);',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'real change plus import-only noise']);
  const commitSha = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const defaultResult = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
  });
  const includeNoiseResult = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
    includeNoise: true,
  });

  const core = defaultResult.symbols.find(symbol => symbol.symbol === 'importantCore');
  assert.ok(core, 'expected importantCore in default filtered output');
  assert.equal(core?.signatureChanged, true);
  assert.ok(defaultResult.symbols.every(symbol => !symbol.noiseTags.includes('import_only')));
  assert.ok(includeNoiseResult.symbols.length >= defaultResult.symbols.length);
});

test('git semantic change graph range mode preserves high-signal symbols while filtering mixed noise', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  const generatedDir = path.join(dir, 'dist');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(generatedDir, { recursive: true });
  initRepo(dir);

  const servicePath = path.join(srcDir, 'service.ts');
  const noisyPath = path.join(srcDir, 'noise.ts');
  const generatedPath = path.join(generatedDir, 'bundle.generated.ts');

  fs.writeFileSync(
    servicePath,
    [
      'export function rangeCore(v: number): number {',
      '  return v + 1;',
      '}',
    ].join('\n')
  );
  fs.writeFileSync(
    noisyPath,
    [
      'export function rangeFormat(v: number): number {',
      '  return v + 1;',
      '}',
    ].join('\n')
  );
  fs.writeFileSync(
    generatedPath,
    [
      'export function rangeGenerated(v: number): number {',
      '  return v + 1;',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial range mixed fixture']);
  const baseRef = runGit(dir, ['rev-parse', 'HEAD']);

  fs.writeFileSync(
    servicePath,
    [
      'export function rangeCore(v: number, extra: number): number {',
      '  return v + extra + 1;',
      '}',
    ].join('\n')
  );
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'range core signature change']);

  fs.writeFileSync(
    noisyPath,
    [
      'export function rangeFormat(v: number): number {',
      '  return  v  +  1;',
      '}',
    ].join('\n')
  );
  fs.writeFileSync(
    generatedPath,
    [
      'export function rangeGenerated(v: number): number {',
      '  return v + 2;',
      '}',
    ].join('\n')
  );
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'range mixed noise changes']);
  const headRef = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const defaultResult = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'range',
    baseRef,
    headRef,
    limit: 80,
  });
  const includeNoiseResult = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'range',
    baseRef,
    headRef,
    limit: 80,
    includeNoise: true,
  });

  const core = defaultResult.symbols.find(symbol => symbol.symbol === 'rangeCore');
  assert.ok(core, 'expected rangeCore in default filtered output');
  assert.equal(core?.signatureChanged, true);
  assert.ok(defaultResult.symbols.every(symbol => symbol.noiseTags.length === 0));
  assert.ok(defaultResult.signals.filteredNoiseSymbols >= 1);
  assert.ok(includeNoiseResult.symbols.length >= defaultResult.symbols.length);
});

test('git semantic change graph validates required refs for commit and range mode', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const filePath = path.join(srcDir, 'service.ts');
  fs.writeFileSync(
    filePath,
    [
      'export function value(): number {',
      '  return 1;',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial commit for validation checks']);

  const graph = buildGraph(dir);

  await assert.rejects(
    () => buildGitSemanticChangeGraph(dir, graph, {
      mode: 'commit',
      limit: 80,
    }),
    /commitSha is required when mode=commit\./
  );

  await assert.rejects(
    () => buildGitSemanticChangeGraph(dir, graph, {
      mode: 'range',
      limit: 80,
    }),
    /baseRef and headRef are required when mode=range\./
  );
});

test('git semantic change graph working tree mode exposes HEAD and WORKTREE refs and returns empty symbols when clean', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const filePath = path.join(srcDir, 'clean.ts');
  fs.writeFileSync(
    filePath,
    [
      'export function cleanValue(): number {',
      '  return 1;',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'clean baseline']);

  const graph = buildGraph(dir);
  const result = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'working_tree',
    limit: 80,
  });

  assert.equal(result.mode, 'working_tree');
  assert.equal(result.sourceRef, 'HEAD');
  assert.equal(result.targetRef, 'WORKTREE');
  assert.equal(result.changedFiles, 0);
  assert.equal(result.symbols.length, 0);
});

test('git semantic change graph clamps limit to min and max bounds', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const bigPath = path.join(srcDir, 'big.ts');
  const initialLines: string[] = [];
  const changedLines: string[] = [];
  for (let i = 0; i < 30; i += 1) {
    initialLines.push(`export function fn${i}(value: number): number {`);
    initialLines.push('  return value + 1;');
    initialLines.push('}');
    initialLines.push('');

    changedLines.push(`export function fn${i}(value: number, extra: number): number {`);
    changedLines.push('  return value + extra + 1;');
    changedLines.push('}');
    changedLines.push('');
  }

  fs.writeFileSync(bigPath, initialLines.join('\n'));
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial big fixture']);

  fs.writeFileSync(bigPath, changedLines.join('\n'));
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'change many symbols']);
  const commitSha = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const minResult = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 1,
  });
  const maxResult = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 500,
  });

  assert.equal(minResult.symbols.length, 10);
  assert.ok(maxResult.symbols.length <= 200);
  assert.ok(maxResult.symbols.length >= 30);
});

test('git semantic change graph caps usage and caller enrichment to first 25 symbols', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const manyPath = path.join(srcDir, 'many.ts');
  const initialLines: string[] = [];
  const changedLines: string[] = [];
  for (let i = 0; i < 35; i += 1) {
    initialLines.push(`export function many${i}(value: number): number {`);
    initialLines.push('  return value + 1;');
    initialLines.push('}');
    initialLines.push('');

    changedLines.push(`export function many${i}(value: number, extra: number): number {`);
    changedLines.push('  return value + extra + 1;');
    changedLines.push('}');
    changedLines.push('');
  }

  fs.writeFileSync(manyPath, initialLines.join('\n'));
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial usage cap fixture']);

  fs.writeFileSync(manyPath, changedLines.join('\n'));
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'change usage cap fixture']);
  const commitSha = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const result = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 200,
  });

  assert.ok(result.symbols.length >= 35);
  assert.equal(result.signals.usageDeltaComputedSymbols, 25);
  assert.equal(result.signals.callerDeltaComputedSymbols, 25);
});

test('git semantic change graph emits freshness metadata and heavy fallback evidence with null graph', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const servicePath = path.join(srcDir, 'fallback.ts');
  fs.writeFileSync(
    servicePath,
    [
      'export function beforeValue(v: number): number {',
      '  return v + 1;',
      '}',
      '',
      'export function caller(): number {',
      '  return beforeValue(1);',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial fallback metadata fixture']);

  fs.writeFileSync(
    servicePath,
    [
      'export function afterValue(v: number): number {',
      '  return v + 2;',
      '}',
      '',
      'export function caller(): number {',
      '  return afterValue(1);',
      '}',
    ].join('\n')
  );

  const result = await buildGitSemanticChangeGraph(dir, null, {
    mode: 'working_tree',
    limit: 80,
  });

  assert.equal(result.metadata.memoryFreshness.status, 'not_applicable');
  assert.equal(result.metadata.memoryFreshness.score, 1);
  assert.ok(result.metadata.memoryFreshness.reason?.length);
  assert.equal(result.metadata.graphFreshness.status, 'missing');
  assert.ok(result.metadata.fallbackRatio >= 0.5);
  assert.ok(result.metadata.unresolvedSymbolRatio >= 0.5);

  const symbol = result.symbols.find(entry => entry.symbol === 'beforeValue' || entry.symbol === 'afterValue');
  assert.ok(symbol, 'expected renamed working-tree symbol to be present');
  assert.ok(symbol?.evidence.includes('stale_graph_context'));
  assert.ok(symbol?.evidence.includes('fallback_heavy'));
  assert.ok(symbol?.evidence.includes('unresolved_heavy'));
});

test('git semantic change graph emits medium rename confidence evidence for partial-signature-compatible renames', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const servicePath = path.join(srcDir, 'service.ts');
  fs.writeFileSync(
    servicePath,
    [
      'export function alpha(value: number): number {',
      '  const doubled = value * 2;',
      '  return doubled + 1;',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial medium rename fixture']);

  fs.writeFileSync(
    servicePath,
    [
      'export function beta(value: number, extraA: number, extraB: number): string {',
      '  const doubled = value * 2;',
      '  return String(doubled + 1);',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'rename with incompatible signature']);
  const commitSha = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const result = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
  });

  const beta = result.symbols.find(symbol => symbol.symbol === 'beta' && symbol.kind === 'added');
  assert.ok(beta, 'expected beta to be marked as added');
  assert.equal(beta?.probableRenameFrom, 'alpha');
  assert.ok((beta?.renameConfidence ?? 0) > 0);
  assert.ok((beta?.renameConfidence ?? 1) < 0.85);
  assert.ok(beta?.evidence.includes('rename_similarity_medium'));
});

test('git semantic change graph does not emit move confidence for non-rename file status', async t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  initRepo(dir);

  const servicePath = path.join(srcDir, 'service.ts');
  fs.writeFileSync(
    servicePath,
    [
      'export function localOnly(value: number): number {',
      '  return value + 1;',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial non-move fixture']);

  fs.writeFileSync(
    servicePath,
    [
      'export function localOnly(value: number, extra: number): number {',
      '  return value + extra + 1;',
      '}',
    ].join('\n')
  );

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'modify without file rename']);
  const commitSha = runGit(dir, ['rev-parse', 'HEAD']);

  const graph = buildGraph(dir);
  const result = await buildGitSemanticChangeGraph(dir, graph, {
    mode: 'commit',
    commitSha,
    limit: 80,
  });

  const localOnly = result.symbols.find(symbol => symbol.symbol === 'localOnly' && symbol.kind === 'modified');
  assert.ok(localOnly, 'expected localOnly to be modified');
  assert.equal(localOnly?.probableMoveFromFile, undefined);
  assert.equal(localOnly?.moveConfidence, undefined);
  assert.equal(localOnly?.evidence.includes('move_detected'), false);
  assert.equal(localOnly?.evidence.includes('move_confident'), false);
});
