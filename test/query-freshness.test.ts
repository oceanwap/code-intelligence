import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { getRetrievedSliceFreshness } from '../src/query-freshness.js';

function makeTempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-query-freshness-test-'));
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

test('getRetrievedSliceFreshness uses exact git line history and returns changed line ranges', t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  runGit(dir, ['init']);
  runGit(dir, ['config', 'user.name', 'Test User']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);

  const filePath = path.join(srcDir, 'auth.ts');
  fs.writeFileSync(filePath, ['export class AuthService {', '  login() {', '    return true;', '  }', '}'].join('\n'));
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'Add auth login flow'], {
    GIT_AUTHOR_DATE: '2026-05-06T09:00:00Z',
    GIT_COMMITTER_DATE: '2026-05-06T09:00:00Z',
  });

  fs.writeFileSync(filePath, ['export class AuthService {', '  login() {', '    return false;', '  }', '}'].join('\n'));
  runGit(dir, ['add', '.']);
  const latestSha = runGit(dir, ['commit', '-m', 'Fix login return path'], {
    GIT_AUTHOR_DATE: '2026-05-06T11:00:00Z',
    GIT_COMMITTER_DATE: '2026-05-06T11:00:00Z',
  });

  const branchDataDir = path.join(dir, '.code-intelligence', 'master');
  fs.mkdirSync(branchDataDir, { recursive: true });
  fs.writeFileSync(
    path.join(branchDataDir, 'manifest.json'),
    JSON.stringify({
      indexedAt: '2026-05-06T10:00:00.000Z',
      mtimes: { 'src/auth.ts': fs.statSync(filePath).mtimeMs },
      fileChunks: { 'src/auth.ts': ['chunk-1'] },
    })
  );

  const freshness = getRetrievedSliceFreshness(dir, 'src/auth.ts', 2, 4);

  assert.equal(freshness.indexRefreshedAt, '2026-05-06T10:00:00.000Z');
  assert.equal(freshness.sliceStartLine, 2);
  assert.equal(freshness.sliceEndLine, 4);
  assert.equal(freshness.latestChange?.sha.length, 40);
  assert.equal(freshness.latestChange?.title, 'Fix login return path');
  assert.equal(freshness.latestChange?.changedLines[0]?.startLine, 3);
  assert.equal(freshness.latestChange?.changedLines[0]?.endLine, 3);
  assert.equal(freshness.needsReindex, true);
  assert.match(freshness.reasons.join(' | '), /latest slice change is newer than this code slice index/);
  assert.match(latestSha, /Fix login return path/);
});