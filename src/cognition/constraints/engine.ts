import * as path from 'path';
import { getDataDir } from '../../git.js';
import { loadGraphAsync } from '../../graph.js';
import { loadArchitectureAsync, refreshArchitectureAsync } from '../architecture/storage.js';
import { loadCognitionConfigAsync } from '../config.js';
import { type ArchitectureSnapshot } from '../architecture/types.js';
import { type ConstraintRule, type ConstraintSeverity, type ConstraintSnapshot, type ConstraintViolation } from './types.js';

const RULES: ConstraintRule[] = [
  {
    rule: 'domain_must_not_import_infrastructure',
    severity: 'high',
    description: 'Core cognition/domain modules should not depend directly on infrastructure-like entrypoint modules.',
  },
  {
    rule: 'dto_must_not_cross_service_boundary',
    severity: 'medium',
    description: 'DTO-related symbols should not flow directly across module boundaries without explicit contracts.',
  },
  {
    rule: 'no_circular_module_dependencies',
    severity: 'high',
    description: 'Module dependency graph should remain acyclic where practical.',
  },
  {
    rule: 'avoid_unstable_imports',
    severity: 'medium',
    description: 'High-instability modules should avoid accumulating broad outbound dependency surfaces.',
  },
  {
    rule: 'prevent_layer_bypass',
    severity: 'medium',
    description: 'Application layers should avoid bypassing expected boundaries (for example direct links into test/docs zones).',
  },
];

function snapshotFile(projectRoot: string): string {
  return path.join(getDataDir(projectRoot), 'constraints.json');
}

function moduleFromFile(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return '<root>';
  if (parts[0] === 'src') return parts.length >= 2 ? `src/${parts[1]}` : 'src';
  if (parts[0] === 'test') return parts.length >= 2 ? `test/${parts[1]}` : 'test';
  return parts[0];
}

function severityOf(rule: string): ConstraintSeverity {
  return RULES.find(item => item.rule === rule)?.severity ?? 'medium';
}

function detectCycles(snapshot: ArchitectureSnapshot): ConstraintViolation[] {
  const adjacency = new Map<string, string[]>();
  for (const dep of snapshot.dependencies) {
    if (dep.from === dep.to) continue;
    if (!adjacency.has(dep.from)) adjacency.set(dep.from, []);
    adjacency.get(dep.from)!.push(dep.to);
  }

  const visited = new Set<string>();
  const stack = new Set<string>();
  const cycles = new Set<string>();

  function walk(node: string, pathNodes: string[]): void {
    if (stack.has(node)) {
      const idx = pathNodes.indexOf(node);
      if (idx >= 0) {
        const cycle = [...pathNodes.slice(idx), node].join(' -> ');
        cycles.add(cycle);
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    stack.add(node);
    const next = adjacency.get(node) ?? [];
    for (const target of next) {
      walk(target, [...pathNodes, target]);
    }
    stack.delete(node);
  }

  for (const moduleName of adjacency.keys()) {
    walk(moduleName, [moduleName]);
  }

  return [...cycles].slice(0, 25).map(cycle => ({
    rule: 'no_circular_module_dependencies',
    severity: severityOf('no_circular_module_dependencies'),
    details: `Detected circular dependency: ${cycle}`,
    modules: cycle.split(' -> ').filter(Boolean),
  }));
}

function detectUnstableImports(snapshot: ArchitectureSnapshot, instabilityThreshold: number, weightThreshold: number): ConstraintViolation[] {
  return snapshot.dependencies
    .filter(dep => dep.from !== dep.to)
    .filter(dep => (snapshot.instability[dep.from] ?? 0) >= instabilityThreshold && dep.weight >= weightThreshold)
    .slice(0, 50)
    .map(dep => ({
      rule: 'avoid_unstable_imports',
      severity: severityOf('avoid_unstable_imports'),
      details: `${dep.from} is unstable (${(snapshot.instability[dep.from] ?? 0).toFixed(2)}) and depends on ${dep.to} with weight ${dep.weight.toFixed(2)}.`,
      modules: [dep.from, dep.to],
    }));
}

function detectLayerBypass(snapshot: ArchitectureSnapshot): ConstraintViolation[] {
  return snapshot.dependencies
    .filter(dep => dep.from.startsWith('src/') && (dep.to.startsWith('test/') || dep.to === 'docs'))
    .slice(0, 50)
    .map(dep => ({
      rule: 'prevent_layer_bypass',
      severity: severityOf('prevent_layer_bypass'),
      details: `Layer bypass: ${dep.from} depends on ${dep.to}.`,
      modules: [dep.from, dep.to],
    }));
}

function detectDomainInfrastructure(snapshot: ArchitectureSnapshot): ConstraintViolation[] {
  return snapshot.dependencies
    .filter(dep => dep.from.startsWith('src/cognition') && (dep.to === 'bin' || dep.to === 'docs'))
    .slice(0, 30)
    .map(dep => ({
      rule: 'domain_must_not_import_infrastructure',
      severity: severityOf('domain_must_not_import_infrastructure'),
      details: `Cognition domain module ${dep.from} depends on infrastructure-like module ${dep.to}.`,
      modules: [dep.from, dep.to],
    }));
}

async function detectDtoBoundaryAsync(projectRoot: string): Promise<ConstraintViolation[]> {
  const graph = await loadGraphAsync(path.join(getDataDir(projectRoot), 'graph.json'));
  if (!graph) return [];

  const dtoSymbols = Object.keys(graph.symbolFile).filter(symbol => /dto/i.test(symbol));
  const violations: ConstraintViolation[] = [];

  for (const symbol of dtoSymbols) {
    const callers = graph.callers[symbol] ?? [];
    const dtoModule = moduleFromFile(graph.symbolFile[symbol] ?? '');
    for (const caller of callers) {
      const callerFile = graph.symbolFile[caller];
      if (!callerFile) continue;
      const callerModule = moduleFromFile(callerFile);
      if (callerModule !== dtoModule) {
        violations.push({
          rule: 'dto_must_not_cross_service_boundary',
          severity: severityOf('dto_must_not_cross_service_boundary'),
          details: `DTO symbol ${symbol} is consumed across boundary ${callerModule} -> ${dtoModule}.`,
          modules: [callerModule, dtoModule],
        });
      }
    }
  }

  return violations.slice(0, 50);
}

export async function validateArchitectureAsync(projectRoot: string): Promise<ConstraintSnapshot> {
  const cfg = await loadCognitionConfigAsync(projectRoot);
  const architecture = await loadArchitectureAsync(projectRoot) ?? await refreshArchitectureAsync(projectRoot);
  const violations = architecture
    ? [
        ...detectCycles(architecture),
        ...detectUnstableImports(architecture, cfg.constraints.unstableImportInstabilityThreshold, cfg.constraints.unstableImportWeightThreshold),
        ...detectLayerBypass(architecture),
        ...detectDomainInfrastructure(architecture),
        ...(await detectDtoBoundaryAsync(projectRoot)),
      ]
    : [];

  const snapshot: ConstraintSnapshot = {
    generatedAt: new Date().toISOString(),
    rules: RULES,
    violations,
  };

  await Bun.write(snapshotFile(projectRoot), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

export async function loadConstraintSnapshotAsync(projectRoot: string): Promise<ConstraintSnapshot | null> {
  const file = snapshotFile(projectRoot);
  try {
    const bunFile = Bun.file(file);
    if (!(await bunFile.exists())) return null;
    return JSON.parse(await bunFile.text()) as ConstraintSnapshot;
  } catch {
    return null;
  }
}

export async function listConstraintViolationsAsync(
  projectRoot: string,
  opts?: { severity?: ConstraintSeverity; limit?: number }
): Promise<ConstraintViolation[]> {
  const snapshot = await loadConstraintSnapshotAsync(projectRoot) ?? await validateArchitectureAsync(projectRoot);
  const severity = opts?.severity;
  const limit = opts?.limit ?? 20;
  return snapshot.violations
    .filter(item => !severity || item.severity === severity)
    .slice(0, limit);
}

export async function boundaryAnalysisAsync(projectRoot: string, moduleName?: string): Promise<Array<{ module: string; inbound: number; outbound: number; instability: number; coupling: number }>> {
  const architecture = await loadArchitectureAsync(projectRoot) ?? await refreshArchitectureAsync(projectRoot);
  if (!architecture) return [];

  return architecture.modules
    .filter(module => !moduleName || module.name === moduleName || module.name.includes(moduleName))
    .map(module => ({
      module: module.name,
      inbound: module.inbound,
      outbound: module.outbound,
      instability: architecture.instability[module.name] ?? 0,
      coupling: architecture.coupling[module.name] ?? 0,
    }))
    .sort((left, right) => right.coupling - left.coupling || right.instability - left.instability);
}
