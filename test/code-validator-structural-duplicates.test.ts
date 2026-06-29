import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateGeneratedCode } from '../src/code-validator.js';
import { detectSemanticDuplicatesAsync } from '../src/cognition/duplicates/orchestrator.js';

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
