import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { getFileOwnershipSummaryAsync } from '../src/git.js';
import { summarizeOwnershipForFilesAsync } from '../src/ownership-insights.js';

function makeTempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-ownership-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function runGit(dir: string, args: string[], env?: Record<string, string>): void {
  const proc = spawnSync('git', args, {
    cwd: dir,
    stdio: 'pipe',
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
  });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function writeRepoFixture(dir: string): void {
  runGit(dir, ['init']);
  runGit(dir, ['config', 'user.name', 'Owner One']);
  runGit(dir, ['config', 'user.email', 'owner1@example.com']);

  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'alpha.ts'), 'line1\nline2\nline3\nline4\nline5\n');
  fs.writeFileSync(path.join(dir, 'src', 'beta.ts'), 'beta1\nbeta2\nbeta3\nbeta4\n');

  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial commit'], {
    GIT_AUTHOR_NAME: 'Owner One',
    GIT_AUTHOR_EMAIL: 'owner1@example.com',
    GIT_COMMITTER_NAME: 'Owner One',
    GIT_COMMITTER_EMAIL: 'owner1@example.com',
    GIT_AUTHOR_DATE: '2026-05-10T10:00:00Z',
    GIT_COMMITTER_DATE: '2026-05-10T10:00:00Z',
  });

  fs.writeFileSync(path.join(dir, 'src', 'alpha.ts'), 'line1\nline2 changed\nline3 changed\nline4\nline5\n');
  runGit(dir, ['add', 'src/alpha.ts']);
  runGit(dir, ['commit', '-m', 'second commit'], {
    GIT_AUTHOR_NAME: 'Owner Two',
    GIT_AUTHOR_EMAIL: 'owner2@example.com',
    GIT_COMMITTER_NAME: 'Owner Two',
    GIT_COMMITTER_EMAIL: 'owner2@example.com',
    GIT_AUTHOR_DATE: '2026-05-11T10:00:00Z',
    GIT_COMMITTER_DATE: '2026-05-11T10:00:00Z',
  });
}

test('getFileOwnershipSummaryAsync derives primary owner and bus factor from git blame', async t => {
  const dir = makeTempDir(t);
  writeRepoFixture(dir);

  const summary = await getFileOwnershipSummaryAsync(dir, 'src/alpha.ts');
  assert.ok(summary);
  assert.equal(summary?.contributorCount, 2);
  assert.equal(summary?.busFactor, 2);
  assert.equal(summary?.primaryOwner?.authorName, 'Owner One');
  assert.ok((summary?.primaryOwner?.percentage ?? 0) > 0.4);
  assert.equal(summary?.recentOwner?.authorName, 'Owner Two');
});

test('summarizeOwnershipForFilesAsync aggregates ownership across files', async t => {
  const dir = makeTempDir(t);
  writeRepoFixture(dir);

  const summary = await summarizeOwnershipForFilesAsync(dir, ['src/alpha.ts', 'src/beta.ts']);
  assert.equal(summary.fileCount, 2);
  assert.equal(summary.primaryOwner, 'Owner One');
  assert.equal(summary.recentOwner, 'Owner Two');
  assert.equal(summary.busFactor, 1);
  assert.ok(summary.ownerPct >= 0.75);
});