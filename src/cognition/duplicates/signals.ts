import * as path from 'path';
import { loadArchitectureAsync, refreshArchitectureAsync } from '../architecture/storage.js';
import { loadAttentionAsync, refreshAttentionAsync } from '../attention/engine.js';
import { loadEvolutionAsync, refreshEvolutionAsync } from '../evolution/engine.js';
import { loadGraphAsync } from '../../graph.js';
import { getDataDir } from '../../git.js';
import { moduleFromFile } from '../../utils/module-path.js';
import { type SemanticDuplicatePattern, type DuplicateLocation, type DuplicateSeverity, type DuplicateSignals } from './types.js';
import { type ArchitectureSnapshot } from '../architecture/types.js';
import { type AttentionSnapshot } from '../attention/types.js';
import { type EvolutionSnapshot } from '../evolution/types.js';

export interface ScoredDuplicatePattern extends SemanticDuplicatePattern {
  signals: DuplicateSignals;
  affectedModules: string[];
  affectedFiles: string[];
  recommendation: string;
}

export interface DuplicateSummary {
  generatedAt: string;
  totalPatterns: number;
  bySeverity: Record<DuplicateSeverity, number>;
  topModules: Array<{ module: string; patternCount: number; locationCount: number; density?: number }>;
  topFiles: Array<{ file: string; patternCount: number; locationCount: number }>;
  highSeverityPatterns: ScoredDuplicatePattern[];
}

export interface DuplicateContext {
  architecture: ArchitectureSnapshot | null;
  attention: AttentionSnapshot | null;
  evolution: EvolutionSnapshot | null;
  graph: { symbolFile: Record<string, string> } | null;
}

const LAYER_DOMAIN = new Set(['src/cognition', 'src/utils', 'src/project-memory']);
const LAYER_INFRA = new Set(['bin', 'src/cli', 'src/mcp-server', 'src/indexer']);

export async function loadDuplicateContextAsync(projectRoot: string): Promise<DuplicateContext> {
  const [architecture, attention, evolution, graph] = await Promise.all([
    loadArchitectureAsync(projectRoot) ?? refreshArchitectureAsync(projectRoot),
    loadAttentionAsync(projectRoot) ?? refreshAttentionAsync(projectRoot),
    loadEvolutionAsync(projectRoot) ?? refreshEvolutionAsync(projectRoot),
    loadGraphAsync(path.join(getDataDir(projectRoot), 'graph.json')),
  ]);
  return { architecture, attention, evolution, graph };
}

function affectedModulesOf(pattern: SemanticDuplicatePattern): string[] {
  return [...new Set(pattern.locations.map(loc => loc.module))];
}

function affectedFilesOf(pattern: SemanticDuplicatePattern): string[] {
  return [...new Set(pattern.locations.map(loc => loc.file))];
}

function classifyLayer(moduleName: string): 'domain' | 'infra' | 'app' | 'other' {
  if (moduleName.startsWith('src/cognition') || moduleName.startsWith('src/utils')) return 'domain';
  if (moduleName.startsWith('bin') || moduleName.startsWith('src/cli') || moduleName.startsWith('src/mcp-server')) return 'infra';
  if (moduleName.startsWith('src/')) return 'app';
  return 'other';
}

function computeCrossLayer(modules: string[]): boolean {
  const layers = new Set(modules.map(classifyLayer));
  return layers.has('domain') && layers.has('infra');
}

function computeInHotspot(modules: string[], attention: AttentionSnapshot | null): boolean {
  if (!attention) return false;
  const tierSet = new Set(['CRITICAL', 'HIGH']);
  return attention.modules.some(item => modules.includes(item.module) && tierSet.has(item.tier));
}

function computeAttentionScore(modules: string[], attention: AttentionSnapshot | null): number {
  if (!attention) return 0;
  let maxScore = 0;
  for (const item of attention.modules) {
    if (modules.includes(item.module)) {
      maxScore = Math.max(maxScore, item.score.composite);
    }
  }
  return Number(maxScore.toFixed(3));
}

function computeInUnstableModule(modules: string[], architecture: ArchitectureSnapshot | null): boolean {
  if (!architecture) return false;
  const threshold = 0.65;
  return modules.some(module => (architecture.instability[module] ?? 0) >= threshold);
}

function computeChurnScore(files: string[], evolution: EvolutionSnapshot | null): number {
  if (!evolution) return 0;
  let total = 0;
  for (const moduleEvolution of evolution.modules) {
    const latest = moduleEvolution.couplingTrend.at(-1) ?? moduleEvolution.couplingTrend[0];
    if (!latest) continue;
    // We don't have per-file churn, so approximate with module churn when any affected file is in the module.
    const moduleFiles = files.filter(f => moduleFromFile(f) === moduleEvolution.module);
    if (moduleFiles.length > 0) {
      total += latest.churn;
    }
  }
  return total;
}

function computeBugCount(modules: string[], evolution: EvolutionSnapshot | null): number {
  if (!evolution) return 0;
  return evolution.modules
    .filter(item => modules.includes(item.module))
    .reduce((sum, item) => sum + (item.bugTrend.at(-1)?.bugs ?? item.bugTrend[0]?.bugs ?? 0), 0);
}

function buildRecommendation(pattern: SemanticDuplicatePattern, signals: DuplicateSignals): string {
  const size = pattern.locations.length;
  const modules = affectedModulesOf(pattern);
  const files = affectedFilesOf(pattern);

  const parts: string[] = [];

  if (signals.crossLayer) {
    parts.push('This pattern crosses domain/infrastructure layers — review whether it belongs in a shared boundary module.');
  } else if (signals.crossModule && modules.length >= 2) {
    parts.push(`This pattern appears across ${modules.length} modules — consider extracting a shared helper in a common dependency.`);
  } else if (modules.length === 1) {
    parts.push(`This pattern is repeated within ${modules[0]} — introduce an internal shared helper or abstraction.`);
  }

  if (signals.inHotspot) {
    parts.push('It is in a high-attention module, so deduplication is likely to have high impact.');
  }
  if (signals.inUnstableModule) {
    parts.push('It is in an unstable module, so duplication increases propagation risk.');
  }
  if (size >= 5) {
    parts.push(`With ${size} occurrences, this is a strong candidate for extraction.`);
  }

  if (parts.length === 0) {
    parts.push(`Review ${size} occurrences for possible extraction or parameterization.`);
  }

  return parts.join(' ');
}

export function scoreDuplicatePattern(
  pattern: SemanticDuplicatePattern,
  context: DuplicateContext
): ScoredDuplicatePattern {
  const modules = affectedModulesOf(pattern);
  const files = affectedFilesOf(pattern);

  const signals: DuplicateSignals = {
    crossModule: modules.length > 1,
    crossLayer: computeCrossLayer(modules),
    inHotspot: computeInHotspot(modules, context.attention),
    inUnstableModule: computeInUnstableModule(modules, context.architecture),
    churnScore: computeChurnScore(files, context.evolution),
    attentionScore: computeAttentionScore(modules, context.attention),
    bugCount: computeBugCount(modules, context.evolution),
  };

  return {
    ...pattern,
    affectedModules: modules,
    affectedFiles: files,
    signals,
    recommendation: buildRecommendation(pattern, signals),
  };
}

export function scoreDuplicatePatterns(
  patterns: SemanticDuplicatePattern[],
  context: DuplicateContext
): ScoredDuplicatePattern[] {
  return patterns.map(p => scoreDuplicatePattern(p, context));
}

function severityOrder(severity: DuplicateSeverity): number {
  return { high: 0, medium: 1, low: 2 }[severity];
}

export function getDuplicateSummary(
  snapshot: { generatedAt: string; totalPatterns: number; bySeverity: Record<DuplicateSeverity, number>; patterns: SemanticDuplicatePattern[] },
  context?: DuplicateContext
): DuplicateSummary {
  const scored = context ? scoreDuplicatePatterns(snapshot.patterns, context) : (snapshot.patterns as ScoredDuplicatePattern[]);

  const moduleStats = new Map<string, { patternCount: number; locationCount: number }>();
  const fileStats = new Map<string, { patternCount: number; locationCount: number }>();

  for (const pattern of scored) {
    for (const module of pattern.affectedModules ?? affectedModulesOf(pattern)) {
      const existing = moduleStats.get(module) ?? { patternCount: 0, locationCount: 0 };
      existing.patternCount += 1;
      existing.locationCount += pattern.locations.filter(loc => loc.module === module).length;
      moduleStats.set(module, existing);
    }
    for (const file of pattern.affectedFiles ?? affectedFilesOf(pattern)) {
      const existing = fileStats.get(file) ?? { patternCount: 0, locationCount: 0 };
      existing.patternCount += 1;
      existing.locationCount += pattern.locations.filter(loc => loc.file === file).length;
      fileStats.set(file, existing);
    }
  }

  const totalSymbolsByModule = new Map<string, number>();
  if (context?.graph) {
    for (const file of Object.values(context.graph.symbolFile)) {
      const module = moduleFromFile(file);
      totalSymbolsByModule.set(module, (totalSymbolsByModule.get(module) ?? 0) + 1);
    }
  }

  const topModules = [...moduleStats.entries()]
    .map(([module, stats]) => ({
      module,
      ...stats,
      density: totalSymbolsByModule.has(module)
        ? Number((Math.min(1, stats.locationCount / Math.max(1, totalSymbolsByModule.get(module)!))).toFixed(3))
        : undefined,
    }))
    .sort((a, b) => b.patternCount - a.patternCount || b.locationCount - a.locationCount)
    .slice(0, 10);

  const topFiles = [...fileStats.entries()]
    .map(([file, stats]) => ({ file, ...stats }))
    .sort((a, b) => b.patternCount - a.patternCount || b.locationCount - a.locationCount)
    .slice(0, 10);

  const highSeverityPatterns = scored
    .filter(p => p.severity === 'high')
    .sort((a, b) => {
      if (a.signals?.crossLayer !== b.signals?.crossLayer) return a.signals?.crossLayer ? -1 : 1;
      return b.locations.length - a.locations.length;
    })
    .slice(0, 10);

  return {
    generatedAt: snapshot.generatedAt,
    totalPatterns: snapshot.totalPatterns,
    bySeverity: snapshot.bySeverity,
    topModules,
    topFiles,
    highSeverityPatterns,
  };
}

export function findDuplicatesForTarget(
  snapshot: { patterns: SemanticDuplicatePattern[] },
  target: string,
  context?: DuplicateContext
): ScoredDuplicatePattern[] {
  const targetLower = target.toLowerCase();
  const scored = context
    ? scoreDuplicatePatterns(snapshot.patterns, context)
    : (snapshot.patterns as ScoredDuplicatePattern[]);

  return scored.filter(pattern => {
    if (pattern.affectedFiles?.some(f => f.toLowerCase().includes(targetLower))) return true;
    if (pattern.affectedModules?.some(m => m.toLowerCase().includes(targetLower))) return true;
    if (pattern.locations.some(loc => loc.symbol.toLowerCase().includes(targetLower))) return true;
    if (pattern.id.toLowerCase().includes(targetLower)) return true;
    return false;
  });
}

export function getDuplicateDensityByModule(
  snapshot: { patterns: SemanticDuplicatePattern[] },
  graph: { symbolFile: Record<string, string> } | null
): Array<{ module: string; duplicateLocationCount: number; totalSymbols: number; density: number }> {
  if (!graph) return [];

  const moduleSymbols = new Map<string, number>();
  for (const file of Object.values(graph.symbolFile)) {
    const module = moduleFromFile(file);
    moduleSymbols.set(module, (moduleSymbols.get(module) ?? 0) + 1);
  }

  const duplicateLocations = new Map<string, number>();
  for (const pattern of snapshot.patterns) {
    for (const loc of pattern.locations) {
      duplicateLocations.set(loc.module, (duplicateLocations.get(loc.module) ?? 0) + 1);
    }
  }

  return [...moduleSymbols.keys()]
    .map(module => {
      const total = moduleSymbols.get(module) ?? 0;
      const dupLocs = duplicateLocations.get(module) ?? 0;
      return {
        module,
        duplicateLocationCount: dupLocs,
        totalSymbols: total,
        density: total > 0 ? Number((Math.min(1, dupLocs / total)).toFixed(3)) : 0,
      };
    })
    .filter(item => item.duplicateLocationCount > 0)
    .sort((a, b) => b.density - a.density || b.duplicateLocationCount - a.duplicateLocationCount);
}
