import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectStructuralDuplicatesAsync } from '../src/cognition/duplicates/engine.js';
import { detectSemanticDuplicatesAsync, loadSemanticDuplicates } from '../src/cognition/duplicates/orchestrator.js';
import { runAstGrepAsync, runSemgrepAsync, runMadgeAsync } from '../src/cognition/duplicates/external.js';
import { semanticDuplicatesFile } from '../src/cognition/duplicates/storage.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-dup-'));
}

function writeFile(dir: string, relPath: string, content: string): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

test('detectStructuralDuplicatesAsync finds duplicate function bodies', async () => {
  const dir = makeTempDir();
  try {
    writeFile(dir, 'src/a.ts', `
export function addOne(x: number) {
  const result = x + 1;
  return result;
}
`);
    writeFile(dir, 'src/b.ts', `
export function increment(y: number) {
  const outcome = y + 1;
  return outcome;
}
`);
    writeFile(dir, 'src/c.ts', `
export function unrelated(z: number) {
  return z * 2;
}
`);

    const patterns = await detectStructuralDuplicatesAsync(dir, { minBodyTokens: 4 });
    assert.equal(patterns.length, 1, 'expected one duplicate group');
    const pattern = patterns[0]!;
    assert.equal(pattern.category, 'structural-duplicate');
    assert.equal(pattern.locations.length, 2);
    const symbols = pattern.locations.map(l => l.symbol).sort();
    assert.deepEqual(symbols, ['addOne', 'increment']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectStructuralDuplicatesAsync finds duplicate class methods', async () => {
  const dir = makeTempDir();
  try {
    writeFile(dir, 'src/users.ts', `
class UserRepo {
  async findById(id: string) {
    const row = await db.query('SELECT * FROM users WHERE id = ?', [id]);
    return row[0];
  }
}
`);
    writeFile(dir, 'src/orders.ts', `
class OrderRepo {
  async findById(id: string) {
    const row = await db.query('SELECT * FROM orders WHERE id = ?', [id]);
    return row[0];
  }
}
`);

    const patterns = await detectStructuralDuplicatesAsync(dir, { minBodyTokens: 4 });
    assert.ok(patterns.length >= 1, 'expected at least one duplicate group');
    const methodPattern = patterns.find(p => p.locations.some(l => l.symbol.includes('findById')));
    assert.ok(methodPattern, 'expected a duplicate method pattern');
    assert.equal(methodPattern!.locations.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectSemanticDuplicatesAsync writes and loads snapshot', async () => {
  const dir = makeTempDir();
  try {
    writeFile(dir, 'src/a.ts', `
export function duplicateOne(value: string) {
  if (!value) return '';
  const trimmed = value.trim();
  return trimmed.toLowerCase();
}
`);
    writeFile(dir, 'src/b.ts', `
export function duplicateTwo(value: string) {
  if (!value) return '';
  const trimmed = value.trim();
  return trimmed.toLowerCase();
}
`);

    const snapshot = await detectSemanticDuplicatesAsync(dir);
    assert.ok(snapshot.totalPatterns >= 1);
    assert.ok(snapshot.bySource['ts-morph'] >= 1);

    const file = semanticDuplicatesFile(dir);
    assert.ok(fs.existsSync(file), 'snapshot file should be written');

    const loaded = await loadSemanticDuplicates(dir);
    assert.ok(loaded);
    assert.equal(loaded!.totalPatterns, snapshot.totalPatterns);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('external tool wrappers report missing tools gracefully', async () => {
  const dir = makeTempDir();
  try {
    const astGrep = await runAstGrepAsync(dir);
    assert.notEqual(astGrep.exitCode, 0);
    assert.equal(astGrep.patterns.length, 0);

    const semgrep = await runSemgrepAsync(dir);
    assert.notEqual(semgrep.exitCode, 0);
    assert.equal(semgrep.patterns.length, 0);

    const madge = await runMadgeAsync(dir);
    assert.notEqual(madge.exitCode, 0);
    assert.equal(madge.patterns.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
