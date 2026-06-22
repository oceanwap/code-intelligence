import * as path from 'path';
import { type GraphData } from '../../graph.js';
import { type ArchitectureDependency, type ArchitectureModule, type ArchitectureSnapshot, type ArchitectureZone, type DependencyPathResult } from './types.js';

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function inferModuleName(filePath: string): string {
  const normalized = normalizeFilePath(filePath);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return '<root>';

  if (parts[0] === 'src') return parts.length >= 2 ? `src/${parts[1]}` : 'src';
  if (parts[0] === 'packages' || parts[0] === 'apps' || parts[0] === 'libs') {
    const base = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    if (parts[2] === 'src') {
      const domainFolders = new Set(['modules', 'features', 'domain', 'services', 'controllers', 'pages', 'components', 'lib']);
      if (parts[3] && domainFolders.has(parts[3]) && parts[4]) {
        return `${base}/src/${parts[3]}/${parts[4]}`;
      }
      if (parts[3]) return `${base}/src/${parts[3]}`;
      return `${base}/src`;
    }
    if (parts[2] === 'test' || parts[2] === 'tests') return `${base}/test`;
    if (parts[2] === 'docs') return `${base}/docs`;
    return base;
  }
  if (parts[0] === 'test') return parts.length >= 2 ? `test/${parts[1]}` : 'test';
  if (parts[0] === 'docs') return 'docs';
  if (parts[0] === 'bin') return 'bin';
  return parts[0];
}

function inferZone(moduleName: string): string {
  const parts = moduleName.split('/').filter(Boolean);

  // Monorepo packages each get their own zone (e.g. packages/admin, apps/web).
  if (parts[0] === 'packages' || parts[0] === 'apps' || parts[0] === 'libs') {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
  }

  if (moduleName.startsWith('src/')) return 'application';
  if (moduleName.startsWith('test/')) return 'quality';
  if (moduleName.endsWith('/test')) return 'quality';
  if (moduleName === 'docs') return 'knowledge';
  if (moduleName.endsWith('/docs')) return 'knowledge';
  if (moduleName === 'bin') return 'entrypoints';
  return 'support';
}

function buildImportDependency(currentFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;

  const base = path.posix.dirname(normalizeFilePath(currentFile));
  const resolved = normalizeFilePath(path.posix.normalize(path.posix.join(base, specifier)));
  return inferModuleName(resolved);
}

function mapSymbolToModule(graph: GraphData): Map<string, string> {
  const map = new Map<string, string>();
  for (const [symbol, file] of Object.entries(graph.symbolFile)) {
    map.set(symbol, inferModuleName(file));
  }
  return map;
}

function finalizeModules(
  moduleFiles: Map<string, Set<string>>,
  moduleSymbols: Map<string, number>,
  inboundCounts: Map<string, number>,
  outboundCounts: Map<string, number>
): ArchitectureModule[] {
  return [...moduleFiles.keys()]
    .map(name => ({
      name,
      files: moduleFiles.get(name)?.size ?? 0,
      symbols: moduleSymbols.get(name) ?? 0,
      inbound: inboundCounts.get(name) ?? 0,
      outbound: outboundCounts.get(name) ?? 0,
      zone: inferZone(name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function scoreCoupling(module: ArchitectureModule, dependencies: ArchitectureDependency[]): number {
  const localEdges = dependencies.filter(dep => dep.from === module.name || dep.to === module.name);
  const crossEdges = localEdges.filter(dep => dep.from !== dep.to);
  const weight = crossEdges.reduce((sum, dep) => sum + dep.weight, 0);
  const density = module.files > 0 ? weight / module.files : weight;
  return Number((density + (module.inbound + module.outbound) * 0.5).toFixed(3));
}

function scoreInstability(module: ArchitectureModule): number {
  const denom = module.inbound + module.outbound;
  if (denom === 0) return 0;
  return Number((module.outbound / denom).toFixed(3));
}

function zonesFromModules(modules: ArchitectureModule[]): ArchitectureZone[] {
  const grouped = new Map<string, string[]>();
  for (const module of modules) {
    if (!grouped.has(module.zone)) grouped.set(module.zone, []);
    grouped.get(module.zone)!.push(module.name);
  }

  return [...grouped.entries()]
    .map(([name, members]) => ({ name, modules: members.sort((a, b) => a.localeCompare(b)) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function analyzeArchitecture(graph: GraphData): ArchitectureSnapshot {
  const symbolModule = mapSymbolToModule(graph);
  const moduleFiles = new Map<string, Set<string>>();
  const moduleSymbols = new Map<string, number>();
  const dependencyMap = new Map<string, ArchitectureDependency>();
  const inboundCounts = new Map<string, number>();
  const outboundCounts = new Map<string, number>();

  for (const [symbol, file] of Object.entries(graph.symbolFile)) {
    const moduleName = inferModuleName(file);
    if (!moduleFiles.has(moduleName)) moduleFiles.set(moduleName, new Set<string>());
    moduleFiles.get(moduleName)!.add(file);
    moduleSymbols.set(moduleName, (moduleSymbols.get(moduleName) ?? 0) + 1);

    if (!symbolModule.has(symbol)) symbolModule.set(symbol, moduleName);
  }

  for (const [caller, callees] of Object.entries(graph.symbols)) {
    const from = symbolModule.get(caller);
    if (!from) continue;

    for (const callee of callees) {
      const to = symbolModule.get(callee);
      if (!to) continue;
      const key = `${from}=>${to}`;
      const existing = dependencyMap.get(key) ?? { from, to, calls: 0, imports: 0, weight: 0 };
      existing.calls += 1;
      existing.weight += 1;
      dependencyMap.set(key, existing);
    }
  }

  for (const [file, imports] of Object.entries(graph.files)) {
    const from = inferModuleName(file);
    for (const specifier of imports) {
      const to = buildImportDependency(file, specifier);
      if (!to) continue;
      const key = `${from}=>${to}`;
      const existing = dependencyMap.get(key) ?? { from, to, calls: 0, imports: 0, weight: 0 };
      existing.imports += 1;
      existing.weight += 0.5;
      dependencyMap.set(key, existing);
    }

    // Use resolved workspace / tsconfig-path imports so cross-package edges are captured.
    for (const resolvedFile of graph.resolvedImports?.[file] ?? []) {
      const to = inferModuleName(resolvedFile);
      if (to === from) continue;
      const key = `${from}=>${to}`;
      const existing = dependencyMap.get(key) ?? { from, to, calls: 0, imports: 0, weight: 0 };
      existing.imports += 1;
      existing.weight += 0.5;
      dependencyMap.set(key, existing);
    }
  }

  const dependencies = [...dependencyMap.values()].sort((left, right) => right.weight - left.weight || left.from.localeCompare(right.from) || left.to.localeCompare(right.to));

  for (const dep of dependencies) {
    if (dep.from === dep.to) continue;
    outboundCounts.set(dep.from, (outboundCounts.get(dep.from) ?? 0) + 1);
    inboundCounts.set(dep.to, (inboundCounts.get(dep.to) ?? 0) + 1);
  }

  const modules = finalizeModules(moduleFiles, moduleSymbols, inboundCounts, outboundCounts);
  const coupling: Record<string, number> = Object.create(null) as Record<string, number>;
  const instability: Record<string, number> = Object.create(null) as Record<string, number>;

  for (const module of modules) {
    coupling[module.name] = scoreCoupling(module, dependencies);
    instability[module.name] = scoreInstability(module);
  }

  return {
    generatedAt: new Date().toISOString(),
    modules,
    dependencies,
    coupling,
    instability,
    zones: zonesFromModules(modules),
  };
}

export function findDependencyPath(snapshot: ArchitectureSnapshot, from: string, to: string): DependencyPathResult | null {
  if (from === to) {
    return { from, to, path: [from], totalWeight: 0 };
  }

  const adjacency = new Map<string, Array<{ to: string; weight: number }>>();
  for (const dep of snapshot.dependencies) {
    if (!adjacency.has(dep.from)) adjacency.set(dep.from, []);
    adjacency.get(dep.from)!.push({ to: dep.to, weight: dep.weight });
  }

  const queue: Array<{ node: string; path: string[]; weight: number }> = [{ node: from, path: [from], weight: 0 }];
  const visited = new Set<string>([from]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const next = adjacency.get(current.node) ?? [];
    for (const edge of next) {
      if (visited.has(edge.to)) continue;
      const pathNodes = [...current.path, edge.to];
      const weight = current.weight + edge.weight;
      if (edge.to === to) {
        return {
          from,
          to,
          path: pathNodes,
          totalWeight: Number(weight.toFixed(2)),
        };
      }
      visited.add(edge.to);
      queue.push({ node: edge.to, path: pathNodes, weight });
    }
  }

  return null;
}

export function topUnstableModules(snapshot: ArchitectureSnapshot, limit = 10): Array<{ module: string; instability: number; outbound: number; inbound: number }> {
  const byModule = new Map(snapshot.modules.map(module => [module.name, module]));
  return Object.entries(snapshot.instability)
    .map(([module, score]) => ({
      module,
      instability: score,
      outbound: byModule.get(module)?.outbound ?? 0,
      inbound: byModule.get(module)?.inbound ?? 0,
    }))
    .sort((left, right) => right.instability - left.instability || right.outbound - left.outbound)
    .slice(0, limit);
}
