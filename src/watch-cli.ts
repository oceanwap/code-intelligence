/**
 * Watch CLI (US-002 / P1-4).
 *
 * Uses Bun.watch() (Bun-native file watcher; no chokidar dep) to debounce
 * filesystem events and trigger an incremental reindex. Process detaches
 * by default (writes pidfile + re-execs) so the CLI exits immediately; in
 * `--foreground` mode it stays in the current process.
 *
 * Pidfile format: {pid}\n{argv}\n  (per PRD spec).
 * Path: ~/.code-intelligence/watch/<project-hash>.pid
 *
 * Crash-safe restart: if the pidfile exists but the process is no longer
 * alive (kill(pid, 0) returns ESRCH or non-zero), the new watch takes over.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { indexProject } from './indexer-run.js';

export interface WatchOptions {
  projectRoot: string;
  watchPaths: string[];
  qdrantUrl: string;
  debounceMs: number;
  foreground: boolean;
}

export interface WatchStartResult {
  pid: number;
  pidfile: string;
  tookOver: boolean;
}

const WATCH_ROOT = path.join(os.homedir(), '.code-intelligence', 'watch');

export { WATCH_ROOT };

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function projectHash(projectRoot: string): string {
  return crypto.createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
}

export { projectHash };

async function readPidfile(pidfile: string): Promise<{ pid: number; argv: string } | null> {
  try {
    const text = await Bun.file(pidfile).text();
    const [pidStr, ...rest] = text.split('\n');
    const pid = Number(pidStr);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return { pid, argv: rest.join('\n') };
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function writePidfile(pidfile: string, pid: number, argv: string): Promise<void> {
  await ensureDir(path.dirname(pidfile));
  await Bun.write(pidfile, `${pid}\n${argv}\n`);
}

async function clearPidfile(pidfile: string): Promise<void> {
  try {
    await fs.unlink(pidfile);
  } catch {
    // already gone
  }
}

export async function startWatchAsync(opts: WatchOptions): Promise<WatchStartResult> {
  const pidfile = path.join(WATCH_ROOT, `${projectHash(opts.projectRoot)}.pid`);

  // Stale pidfile → take over.
  const existing = await readPidfile(pidfile);
  let tookOver = false;
  if (existing && !isAlive(existing.pid)) {
    await clearPidfile(pidfile);
    tookOver = true;
  } else if (existing && isAlive(existing.pid)) {
    throw new Error(`Another watch is already running for ${opts.projectRoot} (pid ${existing.pid}, pidfile ${pidfile}). Stop it first or remove the pidfile.`);
  }

  if (opts.foreground) {
    // Run inline in this process.
    return startInlineWatch(opts, pidfile, tookOver);
  }
  // Detach: write a pidfile for the current process, then run the watcher in
  // the background. We use a child process via Bun.spawn so the parent can exit.
  return detachWatch(opts, pidfile, tookOver);
}

async function startInlineWatch(opts: WatchOptions, pidfile: string, tookOver: boolean): Promise<WatchStartResult> {
  await writePidfile(pidfile, process.pid, JSON.stringify(opts.watchPaths));
  scheduleReindex(opts);
  startBunWatch(opts);
  process.on('SIGINT', () => { void clearPidfile(pidfile).then(() => process.exit(0)); });
  process.on('SIGTERM', () => { void clearPidfile(pidfile).then(() => process.exit(0)); });
  return { pid: process.pid, pidfile, tookOver };
}

async function detachWatch(opts: WatchOptions, pidfile: string, tookOver: boolean): Promise<WatchStartResult> {
  await ensureDir(WATCH_ROOT);
  // Spawn a detached child running the same command with --foreground.
  // The child writes its own pidfile and runs the watcher; the parent exits.
  const child = Bun.spawn({
    cmd: [process.execPath, process.argv[1] ?? '', 'watch', '--dir', opts.projectRoot, '--foreground',
      ...(opts.watchPaths.length > 0 ? ['--paths', opts.watchPaths.join(',')] : []),
      '--qdrant', opts.qdrantUrl, '--debounce', String(opts.debounceMs)],
    env: process.env,
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
    detached: true,
  });
  const pid = child.pid;
  if (!pid) throw new Error('Failed to spawn detached watch process');
  await writePidfile(pidfile, pid, JSON.stringify(opts.watchPaths));
  // Unref so the parent can exit cleanly.
  child.unref();
  return { pid, pidfile, tookOver };
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReindex(opts: WatchOptions): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runReindex(opts).catch(err => {
      console.error(`[watch] reindex failed: ${(err as Error).message}`);
    });
  }, opts.debounceMs);
}

async function runReindex(opts: WatchOptions): Promise<void> {
  console.log(`[watch] change detected, reindexing ${opts.projectRoot}…`);
  await indexProject(opts.projectRoot, opts.qdrantUrl, undefined, false, 'fast');
  console.log(`[watch] reindex complete.`);
}

function startBunWatch(opts: WatchOptions): void {
  // Bun.watch() is a runtime API not exposed in @types/bun. Try it first, then
  // fall back to node:fs.watch for broader compatibility.
  const bunWithWatch = (Bun as unknown as {
    watch?: (path: string, opts?: { recursive?: boolean }) => {
      addEventListener: (event: string, listener: () => void) => void;
    };
  });
  if (typeof bunWithWatch.watch === 'function') {
    for (const p of opts.watchPaths) {
      try {
        const watcher = bunWithWatch.watch(p, { recursive: true });
        watcher.addEventListener('change', () => scheduleReindex(opts));
      } catch (err) {
        console.error(`[watch] failed to watch ${p}: ${(err as Error).message}`);
      }
    }
    return;
  }
  // Fallback: node:fs.watch. Recursive mode is supported on macOS and Windows.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsWatch = require('node:fs').watch as (
    path: string,
    options: { recursive?: boolean },
    listener: (event: string, filename: string | null) => void,
  ) => { close: () => void };
  for (const p of opts.watchPaths) {
    try {
      fsWatch(p, { recursive: true }, () => scheduleReindex(opts));
    } catch (err) {
      console.error(`[watch] failed to watch ${p}: ${(err as Error).message}`);
    }
  }
}