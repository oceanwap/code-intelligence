#!/usr/bin/env bun

import { resolve } from 'node:path';

interface BenchOptions {
  dir: string;
  runs: number;
  mode: 'fast' | 'full';
  fromScratch: boolean;
  skipBuild: boolean;
  fair: boolean;
}

function parseArgs(argv: string[]): BenchOptions {
  const opts: BenchOptions = {
    dir: '.',
    runs: 3,
    mode: 'fast',
    fromScratch: false,
    skipBuild: false,
    fair: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir' && argv[i + 1]) {
      opts.dir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--runs' && argv[i + 1]) {
      opts.runs = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--mode' && argv[i + 1]) {
      opts.mode = argv[i + 1] === 'full' ? 'full' : 'fast';
      i += 1;
      continue;
    }
    if (arg === '--from-scratch') {
      opts.fromScratch = true;
      continue;
    }
    if (arg === '--skip-build') {
      opts.skipBuild = true;
      continue;
    }
    if (arg === '--no-fair') {
      opts.fair = false;
      continue;
    }
  }

  if (!Number.isFinite(opts.runs) || opts.runs <= 0) {
    throw new Error('--runs must be a positive number');
  }

  return opts;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[index];
}

function stageTimingsFromOutput(stdout: string): string | null {
  const line = stdout
    .split('\n')
    .map(part => part.trim())
    .find(part => part.startsWith('Stage timings:'));
  return line ? line.replace(/^Stage timings:\s*/, '') : null;
}

function runProcess(cmd: string[], cwd: string): { ok: boolean; stdout: string; stderr: string; elapsedMs: number } {
  const startedAt = Bun.nanoseconds();
  const proc = Bun.spawnSync(cmd, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const elapsedMs = Number(Bun.nanoseconds() - startedAt) / 1_000_000;
  return {
    ok: proc.exitCode === 0,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
    elapsedMs,
  };
}

function ensureBuild(cwd: string): void {
  const build = runProcess(['bun', 'run', 'build'], cwd);
  if (!build.ok) {
    console.error('Build failed before benchmark');
    console.error(build.stdout);
    console.error(build.stderr);
    process.exit(1);
  }
}

function benchmarkRuntime(cwd: string, indexArgs: string[], runs: number): {
  runtime: 'bun';
  avgMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  lastStageTimings: string | null;
} {
  const command = ['bun', 'dist/cli.js', 'index', ...indexArgs];

  const measurements: number[] = [];
  let lastStageTimings: string | null = null;

  for (let i = 0; i < runs; i += 1) {
    const run = runProcess(command, cwd);
    if (!run.ok) {
      console.error(`\nbun run ${i + 1}/${runs} failed`);
      console.error(run.stdout);
      console.error(run.stderr);
      process.exit(1);
    }

    measurements.push(run.elapsedMs);
    const stageTimings = stageTimingsFromOutput(run.stdout);
    if (stageTimings) lastStageTimings = stageTimings;
    process.stdout.write(`  bun run ${i + 1}/${runs}: ${run.elapsedMs.toFixed(2)}ms\n`);
  }

  return {
    runtime: 'bun',
    avgMs: mean(measurements),
    p95Ms: percentile(measurements, 95),
    minMs: Math.min(...measurements),
    maxMs: Math.max(...measurements),
    lastStageTimings,
  };
}

function withFromScratch(args: string[]): string[] {
  return args.includes('--from-scratch') ? args : [...args, '--from-scratch'];
}

const opts = parseArgs(Bun.argv.slice(2));
const cwd = process.cwd();
const targetDir = resolve(cwd, opts.dir);

if (!opts.skipBuild) {
  console.log('Building dist before benchmark...');
  ensureBuild(cwd);
}

const indexArgs = [targetDir];
if (opts.mode === 'full') indexArgs.push('--full-index');
if (opts.fromScratch) indexArgs.push('--from-scratch');

console.log(`Benchmark target: ${targetDir}`);
console.log(`Index mode: ${opts.mode}`);
console.log(`From scratch: ${opts.fromScratch ? 'yes' : 'no'}`);
console.log('Runtime scope: bun');
console.log(`Fair mode: ${opts.fair ? 'on' : 'off'}`);
console.log(`Runs per runtime: ${opts.runs}`);
console.log('');

const bunArgs = opts.fair ? withFromScratch(indexArgs) : indexArgs;
const bunStats = benchmarkRuntime(cwd, bunArgs, opts.runs);

console.log('\nSummary');
console.log(`  Bun  avg: ${bunStats.avgMs.toFixed(2)}ms (p95 ${bunStats.p95Ms.toFixed(2)}ms, min ${bunStats.minMs.toFixed(2)}ms, max ${bunStats.maxMs.toFixed(2)}ms)`);
if (bunStats.lastStageTimings) console.log(`  Bun stage timings: ${bunStats.lastStageTimings}`);
