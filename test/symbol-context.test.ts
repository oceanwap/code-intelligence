import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import type { GraphData } from '../src/graph.js';
import { buildEnrichedSymbolContext } from '../src/symbol-context.js';

function makeTempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-symbol-context-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function runGit(dir: string, args: string[], env?: Record<string, string>): void {
  execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
    },
  });
}

test('buildEnrichedSymbolContext adds freshness, graph callsites, and next-call guidance', t => {
  const dir = makeTempDir(t);
  const srcDir = path.join(dir, 'src');
  const dataDir = path.join(dir, '.code-intelligence', 'master');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  runGit(dir, ['init']);
  runGit(dir, ['config', 'user.name', 'Test User']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);

  const authFile = path.join(srcDir, 'auth.ts');
  fs.writeFileSync(authFile, ['export class AuthService {', '  login() {', '    return true;', '  }', '}'].join('\n'));
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'Add auth service'], {
    GIT_AUTHOR_DATE: '2026-05-06T09:00:00Z',
    GIT_COMMITTER_DATE: '2026-05-06T09:00:00Z',
  });

  fs.writeFileSync(path.join(dataDir, 'manifest.json'), JSON.stringify({
    indexedAt: '2026-05-06T10:00:00.000Z',
    mtimes: { 'src/auth.ts': fs.statSync(authFile).mtimeMs },
    fileChunks: { 'src/auth.ts': ['chunk-1'] },
  }));

  const graph: GraphData = {
    symbols: { 'AuthService.login': ['SessionStore.issue'] },
    callSites: { 'AuthService.login': [{ symbol: 'SessionStore.issue', file: 'src/auth.ts', line: 2 }] },
    callers: { 'AuthService.login': ['AuthController.handle'] },
    calledBySites: { 'AuthService.login': [{ symbol: 'AuthController.handle', file: 'src/controller.ts', line: 44 }] },
    files: { 'src/auth.ts': [] },
    symbolFile: { 'AuthService.login': 'src/auth.ts' },
    supertypes: {},
    subtypes: {},
    implementations: {},
    implementedFrom: {},
  };

  const context = buildEnrichedSymbolContext(dir, graph, 'AuthService.login', {
    payload: {
      file: 'src/auth.ts',
      type: 'method',
      code: 'login() {\n  return true;\n}',
      lineStart: 2,
      lineEnd: 4,
    },
  });

  assert.equal(context.file, 'src/auth.ts');
  assert.equal(context.lineStart, 2);
  assert.equal(context.graph.calls.sites[0]?.line, 2);
  assert.equal(context.graph.usedBy.sites[0]?.file, 'src/controller.ts');
  assert.equal(context.nextCalls[0]?.tool, 'why_changed');
  assert.ok(context.nextCalls.some(call => call.tool === 'expand_graph'));
});