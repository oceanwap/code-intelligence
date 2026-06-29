import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { writeGraphExportAsync } from '../src/graph-export.js';
import { loadGraphAsync, type GraphData } from '../src/graph.js';
import { getDataDir } from '../src/git.js';

function makeProject(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-graph-export-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.code-intelligence', 'main'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function alpha() {}\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const beta = 1;\n');
  return dir;
}

function writeGraph(dir: string, graph: GraphData): void {
  const dataDir = getDataDir(dir);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'graph.json'), JSON.stringify(graph));
}

test('graph export: html writes a vis.js page with the graph data', async (t) => {
  const dir = makeProject(t);
  writeGraph(dir, {
    symbols: { 'a.alpha': [], 'b.beta': [] },
    callers: {},
    files: { 'src/a.ts': [], 'src/b.ts': [] },
    symbolFile: { 'a.alpha': 'src/a.ts', 'b.beta': 'src/b.ts' },
    supertypes: {},
    subtypes: {},
    implementations: {},
    implementedFrom: {},
    entityRelations: {},
    resolvedImports: {},
  });
  const out = path.join(dir, 'graph.html');
  const result = await writeGraphExportAsync(dir, 'html', out);
  assert.equal(result.format, 'html');
  assert.ok(result.byteCount > 0);
  const body = fs.readFileSync(out, 'utf8');
  assert.match(body, /<script src="https:\/\/unpkg\.com\/vis-network/);
  assert.match(body, /a\.alpha/);
  assert.match(body, /b\.beta/);
});

test('graph export: svg writes a valid SVG file', async (t) => {
  const dir = makeProject(t);
  writeGraph(dir, {
    symbols: { 'a.alpha': [], 'b.beta': [] },
    callers: {},
    files: { 'src/a.ts': [], 'src/b.ts': [] },
    symbolFile: { 'a.alpha': 'src/a.ts', 'b.beta': 'src/b.ts' },
    supertypes: {},
    subtypes: {},
    implementations: {},
    implementedFrom: {},
    entityRelations: {},
    resolvedImports: {},
  });
  const out = path.join(dir, 'graph.svg');
  const result = await writeGraphExportAsync(dir, 'svg', out);
  assert.equal(result.format, 'svg');
  const body = fs.readFileSync(out, 'utf8');
  assert.match(body, /<svg /);
  assert.match(body, /<\/svg>/);
  assert.match(body, /<circle/);
});

test('graph export: graphml writes a valid GraphML file', async (t) => {
  const dir = makeProject(t);
  writeGraph(dir, {
    symbols: { 'a.alpha': ['b.beta'] },
    callers: {},
    files: { 'src/a.ts': [], 'src/b.ts': [] },
    symbolFile: { 'a.alpha': 'src/a.ts', 'b.beta': 'src/b.ts' },
    supertypes: {},
    subtypes: {},
    implementations: {},
    implementedFrom: {},
    entityRelations: {},
    resolvedImports: {},
  });
  const out = path.join(dir, 'graph.graphml');
  const result = await writeGraphExportAsync(dir, 'graphml', out);
  assert.equal(result.format, 'graphml');
  const body = fs.readFileSync(out, 'utf8');
  assert.match(body, /<\?xml/);
  assert.match(body, /graphml/);
  assert.match(body, /<node /);
  assert.match(body, /<edge /);
  assert.ok(result.edgeCount >= 1);
});

test('graph export: throws on unsupported format', async (t) => {
  const dir = makeProject(t);
  writeGraph(dir, {
    symbols: {}, callers: {}, files: {}, symbolFile: {},
    supertypes: {}, subtypes: {}, implementations: {}, implementedFrom: {},
    entityRelations: {}, resolvedImports: {},
  });
  await assert.rejects(
    () => writeGraphExportAsync(dir, 'pdf' as never, path.join(dir, 'x.pdf')),
    /Unsupported format/,
  );
});

test('graph export: throws on missing graph.json', async (t) => {
  const dir = makeProject(t);
  // Don't write graph.json.
  await assert.rejects(
    () => writeGraphExportAsync(dir, 'html', path.join(dir, 'g.html')),
    /No graph\.json/,
  );
});

test('graph export: rejects path traversal in out path', async (t) => {
  const dir = makeProject(t);
  writeGraph(dir, {
    symbols: {}, callers: {}, files: {}, symbolFile: {},
    supertypes: {}, subtypes: {}, implementations: {}, implementedFrom: {},
    entityRelations: {}, resolvedImports: {},
  });
  await assert.rejects(
    () => writeGraphExportAsync(dir, 'html', path.join(dir, '..', 'escape.html')),
    (err: unknown) => err instanceof Error && /security|SecurityError|escapes|\.\./i.test(err.message),
  );
});

test('graph export: result includes node and edge counts', async (t) => {
  const dir = makeProject(t);
  writeGraph(dir, {
    symbols: { 'a.alpha': ['b.beta'], 'b.beta': [] },
    callers: { 'b.beta': ['a.alpha'] },
    files: { 'src/a.ts': ['./b'], 'src/b.ts': [] },
    symbolFile: { 'a.alpha': 'src/a.ts', 'b.beta': 'src/b.ts' },
    supertypes: {},
    subtypes: {},
    implementations: {},
    implementedFrom: {},
    entityRelations: {},
    resolvedImports: { 'src/a.ts': ['src/b.ts'] },
  });
  const out = path.join(dir, 'g.html');
  const result = await writeGraphExportAsync(dir, 'html', out);
  assert.ok(result.nodeCount >= 2, `expected at least 2 nodes, got ${result.nodeCount}`);
  assert.ok(result.edgeCount >= 1, `expected at least 1 edge, got ${result.edgeCount}`);
});

test('graph export: loadGraphAsync is reachable (sanity)', async (t) => {
  const dir = makeProject(t);
  writeGraph(dir, {
    symbols: {}, callers: {}, files: {}, symbolFile: {},
    supertypes: {}, subtypes: {}, implementations: {}, implementedFrom: {},
    entityRelations: {}, resolvedImports: {},
  });
  const graph = await loadGraphAsync(path.join(getDataDir(dir), 'graph.json'));
  assert.ok(graph, 'loadGraphAsync should return the graph we just wrote');
  assert.deepEqual(graph!.symbols, {});
});