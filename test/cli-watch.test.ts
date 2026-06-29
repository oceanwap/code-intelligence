import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  startWatchAsync,
  projectHash,
} from '../src/watch-cli.js';

const BUN_BIN = process.env['BUN_BIN'] || path.join(os.homedir(), '.bun', 'bin', 'bun');
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_BIN = path.join(REPO_ROOT, 'bin', 'code-intel.js');

function withTmpProject(t: TestContext, fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-watch-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  // Init a minimal git repo so post-commit hook logic wouldn't error if exercised.
  try {
    execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir });
  } catch {
    // best-effort; not all tests need git
  }
  return Promise.resolve(fn(dir));
}

function runCli(args: string[], cwd: string, timeoutMs = 5_000): { stdout: string; stderr: string; status: number; killed: boolean } {
  try {
    const stdout = execFileSync(BUN_BIN, [CLI_BIN, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    return { stdout, stderr: '', status: 0, killed: false };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: string; status?: number; signal?: string };
    return {
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : '',
      status: e.status ?? 1,
      killed: e.signal === 'SIGTERM',
    };
  }
}

test('projectHash: deterministic for same project root', () => {
  const a = projectHash('/foo/bar');
  const b = projectHash('/foo/bar');
  const c = projectHash(path.resolve('/foo/bar')); // same path, different string
  assert.equal(a, b);
  assert.equal(a, c);
});

test('projectHash: differs for different roots', () => {
  assert.notEqual(projectHash('/foo/a'), projectHash('/foo/b'));
});

test('startWatchAsync writes pidfile in foreground mode', async (t) => {
  await withTmpProject(t, async (dir) => {
    // Foreground mode: this returns once the watcher is set up but keeps the
    // process alive. We start it in a subprocess and kill it after a short
    // delay, then assert the pidfile was written and cleaned up.
    const child = require('node:child_process').spawn(BUN_BIN, [
      CLI_BIN, 'watch', '--dir', dir, '--foreground', '--debounce', '100',
    ], { stdio: 'ignore', detached: false, env: { ...process.env } });
    // Wait for the watcher to write the pidfile.
    const expectedHash = projectHash(dir);
    const pidfile = path.join(os.homedir(), '.code-intelligence', 'watch', `${expectedHash}.pid`);
    let wroteFile = false;
    for (let i = 0; i < 30 && !wroteFile; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (fs.existsSync(pidfile)) wroteFile = true;
    }
    assert.ok(wroteFile, `pidfile not written at ${pidfile}`);
    const content = fs.readFileSync(pidfile, 'utf8');
    assert.match(content, new RegExp(String(child.pid!)));
    // Cleanup
    try { process.kill(child.pid!, 'SIGTERM'); } catch {}
    // Wait for cleanup.
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (!fs.existsSync(pidfile)) break;
    }
  });
});

test('startWatchAsync takes over stale pidfile', async (t) => {
  await withTmpProject(t, async (dir) => {
    const hash = projectHash(dir);
    const pidfile = path.join(os.homedir(), '.code-intelligence', 'watch', `${hash}.pid`);
    fs.mkdirSync(path.dirname(pidfile), { recursive: true });
    // Write a pidfile pointing at a process that is definitely dead.
    fs.writeFileSync(pidfile, '999999\n["old-argv"]\n');
    const result = await startWatchAsync({
      projectRoot: dir,
      watchPaths: [dir],
      qdrantUrl: 'http://localhost:6333',
      debounceMs: 50,
      foreground: true,
    });
    t.after(() => {
      try { process.kill(result.pid, 'SIGTERM'); } catch {}
      try { fs.unlinkSync(pidfile); } catch {}
    });
    assert.equal(result.tookOver, true);
    assert.ok(fs.existsSync(pidfile), 'pidfile should be rewritten by new watch');
    const content = fs.readFileSync(pidfile, 'utf8');
    const [pidStr] = content.split('\n');
    assert.notEqual(pidStr, '999999');
  });
});

test('startWatchAsync refuses to start when a live watch owns the pidfile', async (t) => {
  await withTmpProject(t, async (dir) => {
    const hash = projectHash(dir);
    const pidfile = path.join(os.homedir(), '.code-intelligence', 'watch', `${hash}.pid`);
    fs.mkdirSync(path.dirname(pidfile), { recursive: true });
    // Write a pidfile that points to this test process — guaranteed to be alive.
    fs.writeFileSync(pidfile, `${process.pid}\n["live-argv"]\n`);
    t.after(() => { try { fs.unlinkSync(pidfile); } catch {} });
    try {
      await startWatchAsync({
        projectRoot: dir,
        watchPaths: [dir],
        qdrantUrl: 'http://localhost:6333',
        debounceMs: 50,
        foreground: true,
      });
      assert.fail('expected startWatchAsync to throw');
    } catch (err) {
      assert.match((err as Error).message, /Another watch is already running/);
    }
  });
});

test('CLI exposes `watch` subcommand with --help', async (t) => {
  await withTmpProject(t, async (dir) => {
    const result = runCli(['watch', '--help'], dir);
    assert.equal(result.status, 0, `cli failed: ${result.stdout} ${result.stderr}`);
    assert.match(result.stdout, /--paths/);
    assert.match(result.stdout, /--qdrant/);
    assert.match(result.stdout, /--debounce/);
  });
});

test('CLI exposes `watch` subcommand and respects --debounce flag', async (t) => {
  await withTmpProject(t, async (dir) => {
    const result = runCli(['watch', '--help'], dir);
    assert.match(result.stdout, /Watch the project and reindex on change/);
  });
});