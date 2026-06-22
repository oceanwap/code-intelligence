import * as path from 'path';
import { getDataDir, getFileChurnAsync } from '../../git.js';
import { listRecentBugsAsync } from '../../project-memory.js';
import { loadArchitectureAsync, refreshArchitectureAsync } from '../architecture/storage.js';
import { loadCognitionConfigAsync } from '../config.js';
import { type ArchitectureSnapshot } from '../architecture/types.js';
import { type ArchitectureDriftRecord, type EvolutionHotspot, type EvolutionPoint, type EvolutionSnapshot, type ModuleEvolution } from './types.js';
import { moduleFromFile } from '../../utils/module-path.js';

function evolutionFile(projectRoot: string): string {
  return path.join(getDataDir(projectRoot), 'evolution.json');
}

function appendTrend(previous: EvolutionPoint[] | undefined, next: EvolutionPoint, maxTrendPoints: number): EvolutionPoint[] {
  const base = previous ?? [];
  return [...base, next].slice(-maxTrendPoints);
}

function latestOf(points: EvolutionPoint[] | undefined): EvolutionPoint | null {
  if (!points || points.length === 0) return null;
  return points[points.length - 1] ?? null;
}

function computeRisk(
  instability: number,
  coupling: number,
  bugs: number,
  churn: number,
  norms: { couplingNormalization: number; bugNormalization: number; churnNormalization: number }
): number {
  const normalizedCoupling = Math.min(1, coupling / norms.couplingNormalization);
  const normalizedBugs = Math.min(1, bugs / norms.bugNormalization);
  const normalizedChurn = Math.min(1, churn / norms.churnNormalization);
  return Number((instability * 0.35 + normalizedCoupling * 0.25 + normalizedBugs * 0.25 + normalizedChurn * 0.15).toFixed(3));
}

async function loadSnapshotAsync(projectRoot: string): Promise<EvolutionSnapshot | null> {
  const file = evolutionFile(projectRoot);
  try {
    const bunFile = Bun.file(file);
    if (!(await bunFile.exists())) return null;
    return JSON.parse(await bunFile.text()) as EvolutionSnapshot;
  } catch {
    return null;
  }
}

async function saveSnapshotAsync(projectRoot: string, snapshot: EvolutionSnapshot): Promise<void> {
  await Bun.write(evolutionFile(projectRoot), JSON.stringify(snapshot, null, 2));
}

function buildModuleMetrics(architecture: ArchitectureSnapshot): Map<string, { instability: number; coupling: number }> {
  const out = new Map<string, { instability: number; coupling: number }>();
  for (const module of architecture.modules) {
    out.set(module.name, {
      instability: architecture.instability[module.name] ?? 0,
      coupling: architecture.coupling[module.name] ?? 0,
    });
  }
  return out;
}

async function buildChurnMapAsync(projectRoot: string): Promise<Map<string, number>> {
  // Derive churn directly from git history so it survives reindexes and branch switches.
  const fileChurn = await getFileChurnAsync(projectRoot, 200);
  const map = new Map<string, number>();
  for (const [file, count] of fileChurn.entries()) {
    const module = moduleFromFile(file);
    map.set(module, (map.get(module) ?? 0) + count);
  }
  return map;
}

async function buildBugMapAsync(projectRoot: string): Promise<Map<string, number>> {
  const bugs = await listRecentBugsAsync(projectRoot, { limit: 120 });
  const map = new Map<string, number>();
  for (const bug of bugs) {
    for (const file of bug.files) {
      const module = moduleFromFile(file);
      map.set(module, (map.get(module) ?? 0) + 1);
    }
  }
  return map;
}

export async function refreshEvolutionAsync(projectRoot: string): Promise<EvolutionSnapshot> {
  const cfg = await loadCognitionConfigAsync(projectRoot);
  const architecture = await loadArchitectureAsync(projectRoot) ?? await refreshArchitectureAsync(projectRoot);
  const previous = await loadSnapshotAsync(projectRoot);

  if (!architecture) {
    const empty: EvolutionSnapshot = {
      generatedAt: new Date().toISOString(),
      modules: [],
      drift: [],
      hotspots: [],
    };
    await saveSnapshotAsync(projectRoot, empty);
    return empty;
  }

  const metrics = buildModuleMetrics(architecture);
  const churnMap = await buildChurnMapAsync(projectRoot);
  const bugMap = await buildBugMapAsync(projectRoot);
  const previousByModule = new Map((previous?.modules ?? []).map(module => [module.module, module]));

  const now = new Date().toISOString();
  const modules: ModuleEvolution[] = [...metrics.entries()].map(([moduleName, current]) => {
    const previousModule = previousByModule.get(moduleName);
    const churn = churnMap.get(moduleName) ?? 0;
    const bugs = bugMap.get(moduleName) ?? 0;
    const risk = computeRisk(current.instability, current.coupling, bugs, churn, cfg.evolution);
    const point: EvolutionPoint = {
      at: now,
      instability: current.instability,
      coupling: current.coupling,
      bugs,
      churn,
      risk,
    };

    return {
      module: moduleName,
      instabilityTrend: appendTrend(previousModule?.instabilityTrend, point, cfg.evolution.maxTrendPoints),
      couplingTrend: appendTrend(previousModule?.couplingTrend, point, cfg.evolution.maxTrendPoints),
      bugTrend: appendTrend(previousModule?.bugTrend, point, cfg.evolution.maxTrendPoints),
      riskScore: risk,
    };
  }).sort((left, right) => right.riskScore - left.riskScore);

  const drift: ArchitectureDriftRecord[] = modules
    .map(module => {
      const previousPoint = latestOf(previousByModule.get(module.module)?.instabilityTrend);
      const latestPoint = latestOf(module.instabilityTrend);
      if (!latestPoint || !previousPoint) return null;
      const instabilityDelta = Number((latestPoint.instability - previousPoint.instability).toFixed(3));
      const couplingDelta = Number((latestPoint.coupling - previousPoint.coupling).toFixed(3));
      const riskDelta = Number((latestPoint.risk - previousPoint.risk).toFixed(3));
      return {
        module: module.module,
        instabilityDelta,
        couplingDelta,
        riskDelta,
      } satisfies ArchitectureDriftRecord;
    })
    .filter((item): item is ArchitectureDriftRecord => item !== null)
    .sort((left, right) => Math.abs(right.riskDelta) - Math.abs(left.riskDelta));

  const hotspots: EvolutionHotspot[] = modules.slice(0, 25).map(module => {
    const latest = latestOf(module.instabilityTrend)!;
    return {
      module: module.module,
      riskScore: module.riskScore,
      churn: latest.churn,
      bugs: latest.bugs,
      instability: latest.instability,
      coupling: latest.coupling,
    };
  });

  const snapshot: EvolutionSnapshot = {
    generatedAt: now,
    modules,
    drift,
    hotspots,
  };

  await saveSnapshotAsync(projectRoot, snapshot);
  return snapshot;
}

export async function loadEvolutionAsync(projectRoot: string): Promise<EvolutionSnapshot | null> {
  return await loadSnapshotAsync(projectRoot);
}

export async function architectureDriftAsync(projectRoot: string, limit = 10): Promise<ArchitectureDriftRecord[]> {
  const snapshot = await loadEvolutionAsync(projectRoot) ?? await refreshEvolutionAsync(projectRoot);
  return snapshot.drift.slice(0, limit);
}

export async function hotspotAnalysisAsync(projectRoot: string, limit = 10, topic?: string): Promise<EvolutionHotspot[]> {
  const snapshot = await loadEvolutionAsync(projectRoot) ?? await refreshEvolutionAsync(projectRoot);
  const lowered = topic?.toLowerCase();
  return snapshot.hotspots
    .filter(item => !lowered || item.module.toLowerCase().includes(lowered))
    .slice(0, limit);
}

export async function instabilityTimelineAsync(projectRoot: string, moduleName: string, points = 12): Promise<EvolutionPoint[]> {
  const snapshot = await loadEvolutionAsync(projectRoot) ?? await refreshEvolutionAsync(projectRoot);
  const target = snapshot.modules.find(module => module.module === moduleName || module.module.includes(moduleName));
  if (!target) return [];
  return target.instabilityTrend.slice(-points);
}
