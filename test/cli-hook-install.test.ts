import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';

const HOOK_MARKER = 'Installed by code-intelligence';

function withGitRepo(t: TestContext, fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-hook-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Init a git repo so .git/hooks exists.
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir });
  return Promise.resolve(fn(dir));
}

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_BIN = path.join(REPO_ROOT, 'bin', 'code-intel.js');
const BUN_BIN = process.env['BUN_BIN'] || path.join(os.homedir(), '.bun', 'bin', 'bun');

function runCli(args: string[], cwd: string): { stdout: string; status: number; stderr: string } {
  try {
    const stdout = execFileSync(BUN_BIN, [CLI_BIN, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    return { stdout, status: 0, stderr: '' };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: string; status?: number };
    return {
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : '',
      status: e.status ?? 1,
    };
  }
}

test('code-intel hook install writes post-commit hook', async (t) => {
  await withGitRepo(t, async (dir) => {
    const result = runCli(['hook', 'install'], dir);
    assert.equal(result.status, 0, `cli failed: ${result.stdout}`);
    const hookPath = path.join(dir, '.git', 'hooks', 'post-commit');
    assert.ok(fs.existsSync(hookPath), `hook not found at ${hookPath}`);
    const content = fs.readFileSync(hookPath, 'utf8');
    assert.match(content, new RegExp(HOOK_MARKER));
    assert.match(content, /code-intelligence index/);
    assert.match(result.stdout, /Installed post-commit hook/);
  });
});

test('code-intel hook install is idempotent', async (t) => {
  await withGitRepo(t, async (dir) => {
    runCli(['hook', 'install'], dir);
    const result = runCli(['hook', 'install'], dir);
    assert.equal(result.status, 0);
    const content = fs.readFileSync(path.join(dir, '.git', 'hooks', 'post-commit'), 'utf8');
    assert.match(content, new RegExp(HOOK_MARKER));
    assert.match(result.stdout, /already installed/);
  });
});

test('code-intel hook status reports installed', async (t) => {
  await withGitRepo(t, async (dir) => {
    runCli(['hook', 'install'], dir);
    const result = runCli(['hook', 'status'], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /installed/);
  });
});

test('code-intel hook status reports not-installed when missing', async (t) => {
  await withGitRepo(t, async (dir) => {
    const result = runCli(['hook', 'status'], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /not-installed/);
  });
});

test('code-intel hook uninstall removes the hook', async (t) => {
  await withGitRepo(t, async (dir) => {
    runCli(['hook', 'install'], dir);
    const hookPath = path.join(dir, '.git', 'hooks', 'post-commit');
    assert.ok(fs.existsSync(hookPath));
    const result = runCli(['hook', 'uninstall'], dir);
    assert.equal(result.status, 0);
    assert.ok(!fs.existsSync(hookPath), 'hook should be removed');
  });
});

test('hook template embeds incremental + paths flags', async (t) => {
  await withGitRepo(t, async (dir) => {
    runCli(['hook', 'install'], dir);
    const content = fs.readFileSync(path.join(dir, '.git', 'hooks', 'post-commit'), 'utf8');
    assert.match(content, /--incremental/);
    assert.match(content, /--paths/);
    assert.match(content, /git diff-tree --no-commit-id --name-only -r HEAD~1 HEAD/);
  });
});

test('code-intel hook with unknown action fails cleanly', async (t) => {
  await withGitRepo(t, async (dir) => {
    const result = runCli(['hook', 'frobnicate'], dir);
    assert.notEqual(result.status, 0);
    const combined = result.stdout + result.stderr;
    assert.match(combined, /Unknown action/);
  });
});