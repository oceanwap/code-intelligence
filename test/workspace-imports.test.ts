import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildGraph } from '../src/graph.js';
import {
  loadWorkspacePackagesAsync,
  loadTsConfigPathsAsync,
  loadWorkspaceResolverAsync,
  resolveImportToFile,
} from '../src/workspace-imports.js';

function makeTempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-workspace-imports-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('loadWorkspacePackagesAsync detects pnpm workspace packages', async (t) => {
  const dir = makeTempDir(t);
  fs.mkdirSync(path.join(dir, 'packages', 'core'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'packages', 'util'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'root', private: true }));
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  fs.writeFileSync(
    path.join(dir, 'packages', 'core', 'package.json'),
    JSON.stringify({ name: '@acme/core', main: 'index.ts' }),
  );
  fs.writeFileSync(path.join(dir, 'packages', 'core', 'index.ts'), 'export const core = 1;');
  fs.writeFileSync(
    path.join(dir, 'packages', 'util', 'package.json'),
    JSON.stringify({ name: '@acme/util', module: 'lib/util.ts' }),
  );
  fs.mkdirSync(path.join(dir, 'packages', 'util', 'lib'));
  fs.writeFileSync(path.join(dir, 'packages', 'util', 'lib', 'util.ts'), 'export const util = 1;');

  const packages = await loadWorkspacePackagesAsync(dir);
  const names = packages.map(p => p.name).sort();
  assert.deepEqual(names, ['@acme/core', '@acme/util', 'root']);

  const core = packages.find(p => p.name === '@acme/core');
  assert.equal(core?.entry, 'packages/core/index.ts');

  const util = packages.find(p => p.name === '@acme/util');
  assert.equal(util?.entry, 'packages/util/lib/util.ts');
});

test('resolveImportToFile resolves workspace package and subpath imports', async (t) => {
  const dir = makeTempDir(t);
  fs.mkdirSync(path.join(dir, 'packages', 'core', 'helpers'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'root' }));
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  fs.writeFileSync(
    path.join(dir, 'packages', 'core', 'package.json'),
    JSON.stringify({ name: '@acme/core', main: 'index.ts' }),
  );
  fs.writeFileSync(path.join(dir, 'packages', 'core', 'index.ts'), 'export const core = 1;');
  fs.writeFileSync(path.join(dir, 'packages', 'core', 'helpers', 'format.ts'), 'export const fmt = 1;');

  const resolver = await loadWorkspaceResolverAsync(dir);
  assert.equal(await resolveImportToFile('apps/web.ts', '@acme/core', resolver), 'packages/core/index.ts');
  assert.equal(
    await resolveImportToFile('apps/web.ts', '@acme/core/helpers/format', resolver),
    'packages/core/helpers/format.ts',
  );
  assert.equal(await resolveImportToFile('apps/web.ts', 'nonexistent-pkg', resolver), null);
});

test('resolveImportToFile resolves tsconfig path mappings', async (t) => {
  const dir = makeTempDir(t);
  fs.mkdirSync(path.join(dir, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'root' }));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      paths: {
        '@/*': ['src/*'],
        '~utils': ['src/lib/utils.ts'],
      },
    },
  }));
  fs.writeFileSync(path.join(dir, 'src', 'lib', 'utils.ts'), 'export const u = 1;');
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const app = 1;');

  const resolver = await loadWorkspaceResolverAsync(dir);
  assert.equal(await resolveImportToFile('src/page.ts', '@/lib/utils', resolver), 'src/lib/utils.ts');
  assert.equal(await resolveImportToFile('src/page.ts', '@/app', resolver), 'src/app.ts');
  assert.equal(await resolveImportToFile('src/page.ts', '~utils', resolver), 'src/lib/utils.ts');
});

test('buildGraph populates resolvedImports for workspace and tsconfig imports', async (t) => {
  const dir = makeTempDir(t);
  fs.mkdirSync(path.join(dir, 'packages', 'shared'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'root' }));
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  fs.writeFileSync(
    path.join(dir, 'packages', 'shared', 'package.json'),
    JSON.stringify({ name: '@demo/shared', main: 'index.ts' }),
  );
  fs.writeFileSync(path.join(dir, 'packages', 'shared', 'index.ts'), 'export const shared = 1;');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      paths: { '@/*': ['src/*'] },
    },
  }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'helper.ts'), 'export const helper = 1;');
  fs.writeFileSync(
    path.join(dir, 'src', 'app.ts'),
    "import { shared } from '@demo/shared';\nimport { helper } from '@/helper';\nexport const app = shared + helper;",
  );

  const graph = await buildGraph(dir);
  assert.deepEqual(graph.resolvedImports['src/app.ts'].sort(), [
    'packages/shared/index.ts',
    'src/helper.ts',
  ]);
});
