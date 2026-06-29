import * as path from 'path';
import { getDataDir } from '../../git.js';
import { loadGraphAsync, type GraphData } from '../../graph.js';
import { loadArchitectureAsync, refreshArchitectureAsync } from '../architecture/storage.js';
import { type StructureCycle, type StructureDependency, type StructureModule, type StructureSnapshot } from './types.js';
import { moduleFromFile } from '../../utils/module-path.js';
import { saveValidatedSnapshotAsync, loadValidatedSnapshotAsync } from '../../pipeline-contract.js';

function structureFile(projectRoot: string): string {
  return path.join(getDataDir(projectRoot), 'structure.json');
}

function inferZone(moduleName: string): string {
  if (moduleName.startsWith('src/')) return 'application';
  if (moduleName.startsWith('test/')) return 'quality';
  if (moduleName === 'docs') return 'knowledge';
  if (moduleName === 'bin') return 'entrypoints';
  return 'support';
}

function detectCycles(dependencies: StructureDependency[]): StructureCycle[] {
  const adjacency = new Map<string, string[]>();
  for (const dep of dependencies) {
    if (dep.from === dep.to) continue;
    if (!adjacency.has(dep.from)) adjacency.set(dep.from, []);
    adjacency.get(dep.from)!.push(dep.to);
  }

  const visited = new Set<string>();
  const stack = new Set<string>();
  const found = new Set<string>();

  function walk(node: string, trace: string[]): void {
    if (stack.has(node)) {
      const idx = trace.indexOf(node);
      if (idx >= 0) {
        const cycle = [...trace.slice(idx), node];
        found.add(cycle.join(' -> '));
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    stack.add(node);
    for (const next of adjacency.get(node) ?? []) {
      walk(next, [...trace, next]);
    }
    stack.delete(node);
  }

  for (const moduleName of adjacency.keys()) {
    walk(moduleName, [moduleName]);
  }

  return [...found]
    .slice(0, 50)
    .map(item => ({ path: item.split(' -> ') }));
}

function buildFromGraph(graph: GraphData): StructureSnapshot {
  const symbolToModule: Record<string, string> = Object.create(null) as Record<string, string>;
  const moduleFiles = new Map<string, Set<string>>();
  const moduleSymbols = new Map<string, number>();
  const outbound = new Map<string, number>();
  const inbound = new Map<string, number>();
  const dependencyMap = new Map<string, StructureDependency>();

  for (const [symbol, file] of Object.entries(graph.symbolFile)) {
    const moduleName = moduleFromFile(file);
    symbolToModule[symbol] = moduleName;
    if (!moduleFiles.has(moduleName)) moduleFiles.set(moduleName, new Set<string>());
    moduleFiles.get(moduleName)!.add(file);
    moduleSymbols.set(moduleName, (moduleSymbols.get(moduleName) ?? 0) + 1);
  }

  for (const [caller, callees] of Object.entries(graph.symbols)) {
    const from = symbolToModule[caller];
    if (!from) continue;
    for (const callee of callees) {
      const to = symbolToModule[callee];
      if (!to) continue;
      const key = `${from}=>${to}`;
      const existing = dependencyMap.get(key) ?? { from, to, weight: 0 };
      existing.weight += 1;
      dependencyMap.set(key, existing);
    }
  }

  const dependencies = [...dependencyMap.values()]
    .sort((left, right) => right.weight - left.weight || left.from.localeCompare(right.from));

  for (const dep of dependencies) {
    if (dep.from === dep.to) continue;
    outbound.set(dep.from, (outbound.get(dep.from) ?? 0) + 1);
    inbound.set(dep.to, (inbound.get(dep.to) ?? 0) + 1);
  }

  const maxCentralityBase = Math.max(
    1,
    ...[...moduleFiles.keys()].map(moduleName => (inbound.get(moduleName) ?? 0) + (outbound.get(moduleName) ?? 0))
  );

  const modules: StructureModule[] = [...moduleFiles.keys()]
    .map(moduleName => {
      const centralityRaw = (inbound.get(moduleName) ?? 0) + (outbound.get(moduleName) ?? 0);
      return {
        name: moduleName,
        files: moduleFiles.get(moduleName)?.size ?? 0,
        symbols: moduleSymbols.get(moduleName) ?? 0,
        inbound: inbound.get(moduleName) ?? 0,
        outbound: outbound.get(moduleName) ?? 0,
        centrality: Number((centralityRaw / maxCentralityBase).toFixed(3)),
        zone: inferZone(moduleName),
      } satisfies StructureModule;
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const zoneMap = new Map<string, string[]>();
  for (const moduleName of modules.map(module => module.name)) {
    const zone = inferZone(moduleName);
    if (!zoneMap.has(zone)) zoneMap.set(zone, []);
    zoneMap.get(zone)!.push(moduleName);
  }

  return {
    generatedAt: new Date().toISOString(),
    modules,
    dependencies,
    zones: [...zoneMap.entries()].map(([name, list]) => ({ name, modules: list.sort() })),
    cycles: detectCycles(dependencies),
    symbolToModule,
  };
}

export async function refreshStructureAsync(projectRoot: string): Promise<StructureSnapshot | null> {
  const graphPath = path.join(getDataDir(projectRoot), 'graph.json');
  const graph = await loadGraphAsync(graphPath);
  if (!graph) return null;

  if (!(await loadArchitectureAsync(projectRoot))) await refreshArchitectureAsync(projectRoot);

  const snapshot = buildFromGraph(graph);
  const file = structureFile(projectRoot);
  await Bun.write(file, JSON.stringify(snapshot, null, 2));
  return snapshot;
}

export async function loadStructureAsync(projectRoot: string): Promise<StructureSnapshot | null> {
  const file = structureFile(projectRoot);
  try {
    const bunFile = Bun.file(file);
    if (!(await bunFile.exists())) return null;
    return JSON.parse(await bunFile.text()) as StructureSnapshot;
  } catch {
    return null;
  }
}
