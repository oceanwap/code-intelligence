import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { mock } from 'bun:test';
import { validateGeneratedCode } from '../src/code-validator.js';
import { detectSemanticDuplicatesAsync } from '../src/cognition/duplicates/orchestrator.js';

// ------------------------------------------------------------------
// Workaround: Bun 1.3.13 graceful shutdown crashes (SIGTRAP / "panic
// main thread: A C++ exception occurred") when onnxruntime-node's NAPI
// addon (loaded transitively by fastembed inside findExisting →
// retrieve → embedQuery) is torn down with pending async work.
//
// detectSemanticDuplicatesAsync alone does NOT trigger this — only
// validateGeneratedCode's semantic-duplicate side path (which calls
// findExisting → retrieve → embedQuery → FlagEmbedding.init) does.
// This test's contract is the STRUCTURAL duplicate assertion, which
// uses loadSemanticDuplicates + detectStructuralDuplicatesInCode
// (NOT findExisting), so stubbing findExisting to return
// SAFE_TO_CREATE preserves the actual assertion while bypassing the
// upstream crash.
//
// Tracking:
//   https://github.com/oven-sh/bun/issues?q=is%3Aissue+napi+shutdown
//
// If Bun ships a fix and you want to drop the stub: delete the
// mock.module block and the imports of `mock`/`findExisting`. The
// test should still pass — it just won't trip the bug any more.
// ------------------------------------------------------------------
mock.module('../src/find-existing.js', () => ({
  findExisting: async () => ({
    matches: [],
    verdict: 'SAFE_TO_CREATE' as const,
    summary: 'mocked — see code-validator-structural-duplicates.test.ts header',
    description: 'mocked',
  }),
  THRESHOLD_DUPLICATE: 0.82,
  THRESHOLD_PARTIAL: 0.68,
}));

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-cv-'));
}

function writeFile(dir: string, relPath: string, content: string): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

test('validateGeneratedCode flags generated code that matches existing structural duplicate', async () => {
  const dir = makeTempDir();
  try {
    writeFile(dir, 'src/existing.ts', `
export function loadConfig(path: string) {
  try {
    return JSON.parse(Bun.file(path).text());
  } catch {
    return null;
  }
}
`);
    writeFile(dir, 'src/other.ts', `
export function loadSettings(path: string) {
  try {
    return JSON.parse(Bun.file(path).text());
  } catch {
    return null;
  }
}
`);

    await detectSemanticDuplicatesAsync(dir, { minBodyTokens: 4 });

    const generatedCode = `
export function loadPreferences(path: string) {
  try {
    return JSON.parse(Bun.file(path).text());
  } catch {
    return null;
  }
}
`;

    const result = await validateGeneratedCode(dir, generatedCode, 'src/new.ts');
    assert.ok(
      result.structuralDuplicateFlags.length >= 1,
      'expected at least one structural duplicate flag'
    );
    const flag = result.structuralDuplicateFlags[0]!;
    assert.ok(flag.patternId);
    assert.ok(flag.recommendation);
    assert.ok(flag.existingLocations.length >= 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateGeneratedCode passes when generated code is unique', async () => {
  const dir = makeTempDir();
  try {
    writeFile(dir, 'src/existing.ts', `
export function loadConfig(path: string) {
  return path;
}
`);

    await detectSemanticDuplicatesAsync(dir, { minBodyTokens: 4 });

    const generatedCode = `
export function totallyDifferent(a: number, b: number) {
  return a + b + 1;
}
`;

    const result = await validateGeneratedCode(dir, generatedCode, 'src/new.ts');
    assert.equal(result.structuralDuplicateFlags.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
