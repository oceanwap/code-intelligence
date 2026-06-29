import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  indexDirectory,
  buildContentHashCache,
  loadContentHashCacheAsync,
  saveContentHashCacheAsync,
  sha256File,
  type ContentHashCache,
} from '../src/indexer.js';

function makeProject(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-hash-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), [
    'export function alpha(x: number): number {',
    '  return x + 1;',
    '}',
    '',
    'export class Alpha {',
    '  hello(): string { return "hi"; }',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'src', 'b.ts'), [
    'export const beta = (x: number) => x * 2;',
  ].join('\n'));
  return dir;
}

test('sha256File returns stable hex for a known file', async (t) => {
  const dir = makeProject(t);
  const h1 = await sha256File(path.join(dir, 'src', 'a.ts'));
  const h2 = await sha256File(path.join(dir, 'src', 'a.ts'));
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
});

test('sha256File returns empty string for missing files', async () => {
  const h = await sha256File(path.join(os.tmpdir(), `does-not-exist-${Date.now()}.ts`));
  assert.equal(h, '');
});

test('indexDirectory populates content_hash on every chunk', async (t) => {
  const dir = makeProject(t);
  const chunks = await indexDirectory(dir, { mode: 'fast' });
  assert.ok(chunks.length > 0, 'expected chunks');
  for (const c of chunks) {
    assert.ok(typeof c.content_hash === 'string' && c.content_hash.length === 64, `chunk ${c.id} missing content_hash`);
  }
});

test('content-hash cache hit skips parsing — chunk identity preserved', async (t) => {
  const dir = makeProject(t);

  // First pass: no cache → full parse.
  const first = await indexDirectory(dir, { mode: 'fast' });
  assert.ok(first.length > 0);
  const firstCache = buildContentHashCache(first);

  // Tamper with one of the source files to make sure the next pass is still
  // a full re-parse, then restore it.
  const aPath = path.join(dir, 'src', 'a.ts');
  const original = fs.readFileSync(aPath, 'utf8');
  fs.writeFileSync(aPath, original + '\n// tampered\n');
  const middleRun = await indexDirectory(dir, { mode: 'fast', contentHashCache: firstCache });
  const tamperedHash = middleRun.find(c => c.file === 'src/a.ts')?.content_hash;
  assert.notEqual(tamperedHash, first.find(c => c.file === 'src/a.ts')?.content_hash);

  // Restore file → next pass should hit cache for unchanged files.
  fs.writeFileSync(aPath, original);
  const restored = await indexDirectory(dir, { mode: 'fast', contentHashCache: firstCache });
  const aFromCache = restored.filter(c => c.file === 'src/a.ts');
  const aFromParse = first.filter(c => c.file === 'src/a.ts');
  // Same chunk ids, same code, same line ranges.
  assert.deepEqual(
    aFromCache.map(c => c.id).sort(),
    aFromParse.map(c => c.id).sort()
  );
  assert.deepEqual(
    aFromCache.map(c => c.code).sort(),
    aFromParse.map(c => c.code).sort()
  );
  // Cache-replayed chunks carry the original hash.
  for (const c of aFromCache) assert.equal(c.content_hash, aFromParse[0]?.content_hash);
});

test('loadContentHashCache / saveContentHashCache round-trip', async (t) => {
  const dir = makeProject(t);
  const chunks = await indexDirectory(dir, { mode: 'fast' });
  const cache = buildContentHashCache(chunks);
  const cacheFile = path.join(dir, 'cache.json');
  await saveContentHashCacheAsync(cache, cacheFile);
  const loaded = await loadContentHashCacheAsync(cacheFile);
  assert.equal(loaded.entries['src/a.ts']?.content_hash, cache.entries['src/a.ts']?.content_hash);
  assert.ok(loaded.entries['src/a.ts']?.chunks.length);
});

test('loadContentHashCache returns empty cache on missing file', async () => {
  const cache = await loadContentHashCacheAsync(path.join(os.tmpdir(), `nope-${Date.now()}.json`));
  assert.deepEqual(cache.entries, {});
});

test('content-hash cache from scratch yields same ids as first parse', async (t) => {
  const dir = makeProject(t);
  const first = await indexDirectory(dir, { mode: 'fast' });
  const cache = buildContentHashCache(first);
  // Persist + reload, then replay.
  const cacheFile = path.join(dir, 'cache.json');
  await saveContentHashCacheAsync(cache, cacheFile);
  const reloaded = await loadContentHashCacheAsync(cacheFile);
  const replay = await indexDirectory(dir, { mode: 'fast', contentHashCache: reloaded });
  // Ids are derived from (file, symbol) so they must be identical.
  assert.deepEqual(
    replay.map(c => c.id).sort(),
    first.map(c => c.id).sort()
  );
});

test('cache invalidation when file is missing — chunk absent from replay', async (t) => {
  const dir = makeProject(t);
  const first = await indexDirectory(dir, { mode: 'fast' });
  const cache: ContentHashCache = buildContentHashCache(first);
  // Remove a file and re-index — the cached entry should be ignored
  // (because the file is gone, hash is empty so cache lookup misses).
  fs.unlinkSync(path.join(dir, 'src', 'b.ts'));
  const replay = await indexDirectory(dir, { mode: 'fast', contentHashCache: cache });
  assert.equal(replay.some(c => c.file === 'src/b.ts'), false, 'deleted file should not appear in replay');
});