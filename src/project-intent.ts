import * as path from 'path';
import { getDataDir } from './git.js';
import { loadGraphAsync, type GraphData } from './graph.js';
import { getFeatureMapAsync, getProjectStatusAsync, listRecentChangesAsync, type ChangeMemoryEntry } from './project-memory.js';
import { refreshArchitectureAsync } from './cognition/architecture/storage.js';

export type UnderstandingEvidenceTier = 'code-verified' | 'architecture-inferred' | 'doc-derived' | 'memory-derived';

export interface UnderstandingClaim {
  category: 'purpose' | 'architecture' | 'patterns' | 'conventions' | 'entrypoints';
  statement: string;
  evidenceTier: UnderstandingEvidenceTier;
  confidence: number;
  sources: string[];
}

export interface ProjectIntentSnapshot {
  generatedAt: string;
  projectRoot: string;
  overallConfidence: number;
  confidenceBreakdown: Record<UnderstandingEvidenceTier, number>;
  claims: UnderstandingClaim[];
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function tierWeight(tier: UnderstandingEvidenceTier): number {
  if (tier === 'code-verified') return 1;
  if (tier === 'architecture-inferred') return 0.82;
  if (tier === 'doc-derived') return 0.72;
  return 0.62;
}

function pushClaim(claims: UnderstandingClaim[], claim: UnderstandingClaim): void {
  if (!claim.statement.trim()) return;
  claims.push({ ...claim, confidence: clamp01(claim.confidence) });
}

function packageDistribution(graph: GraphData): Array<{ name: string; files: number }> {
  const counts = new Map<string, number>();
  for (const file of Object.values(graph.symbolFile)) {
    const normalized = file.replace(/\\/g, '/');
    const match = normalized.match(/^(packages|apps|libs)\/([^/]+)/);
    if (!match) continue;
    const pkg = `${match[1]}/${match[2]}`;
    counts.set(pkg, (counts.get(pkg) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, files]) => ({ name, files }))
    .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));
}

function dominantModules(graph: GraphData): Array<{ name: string; files: number }> {
  const counts = new Map<string, number>();
  for (const file of Object.values(graph.symbolFile)) {
    const normalized = file.replace(/\\/g, '/');
    const moduleMatch = normalized.match(/^packages\/([^/]+)\/src\/[^/]+\/modules\/([^/]+)/);
    if (!moduleMatch) continue;
    const key = `${moduleMatch[1]}:${moduleMatch[2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, files]) => ({ name, files }))
    .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))
    .slice(0, 8);
}

function entrypointHints(graph: GraphData): Array<{ symbol: string; file: string }> {
  const out: Array<{ symbol: string; file: string }> = [];
  for (const [symbol, file] of Object.entries(graph.symbolFile)) {
    const normalized = file.replace(/\\/g, '/');
    if (symbol === 'bootstrap' || symbol.endsWith('AppModule') || normalized.endsWith('/main.ts') || normalized.endsWith('/app.module.ts')) {
      out.push({ symbol, file: normalized });
    }
  }
  out.sort((a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol));
  return out.slice(0, 12);
}

function detectFrameworkPatterns(graph: GraphData): {
  hasNest: boolean;
  hasReact: boolean;
  hasTypeOrm: boolean;
  hasBull: boolean;
} {
  let hasNest = false;
  let hasReact = false;
  let hasTypeOrm = false;
  let hasBull = false;

  for (const imports of Object.values(graph.files)) {
    for (const specifier of imports) {
      if (specifier.startsWith('@nestjs/')) hasNest = true;
      if (specifier === 'react' || specifier.startsWith('react/')) hasReact = true;
      if (specifier.includes('typeorm')) hasTypeOrm = true;
      if (specifier.includes('@nestjs/bull') || specifier.includes('bullmq')) hasBull = true;
    }
  }

  return { hasNest, hasReact, hasTypeOrm, hasBull };
}

function topChangeKinds(changes: ChangeMemoryEntry[]): string {
  if (changes.length === 0) return 'none';
  const counts = new Map<string, number>();
  for (const change of changes) {
    counts.set(change.changeType, (counts.get(change.changeType) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([kind, count]) => `${kind}(${count})`)
    .join(', ');
}

function architectureGranularity(snapshot: { modules: Array<{ name: string }> }): { coarseRatio: number; isCoarse: boolean } {
  const total = snapshot.modules.length;
  if (total === 0) return { coarseRatio: 0, isCoarse: false };
  const coarse = snapshot.modules.filter(module => !module.name.includes('/src/')).length;
  const coarseRatio = coarse / total;
  return { coarseRatio, isCoarse: coarseRatio >= 0.7 || total <= 2 };
}

export async function buildProjectIntentSnapshot(projectRoot: string): Promise<ProjectIntentSnapshot | null> {
  const root = path.resolve(projectRoot);
  const graphPath = path.join(getDataDir(root), 'graph.json');
  const graph = await loadGraphAsync(graphPath);
  if (!graph) return null;

  const [architecture, featureMap, status, recentChanges] = await Promise.all([
    refreshArchitectureAsync(root),
    getFeatureMapAsync(root),
    getProjectStatusAsync(root),
    listRecentChangesAsync(root, { limit: 20 }),
  ]);

  const claims: UnderstandingClaim[] = [];
  const packages = packageDistribution(graph);
  const modules = dominantModules(graph);
  const entrypoints = entrypointHints(graph);
  const frameworks = detectFrameworkPatterns(graph);

  if (packages.length > 0) {
    pushClaim(claims, {
      category: 'architecture',
      statement: `Monorepo/package structure is active across ${packages.length} package groups; largest groups: ${packages.slice(0, 4).map(item => `${item.name}(${item.files})`).join(', ')}.`,
      evidenceTier: 'code-verified',
      confidence: 0.9,
      sources: packages.slice(0, 4).map(item => item.name),
    });
  }

  if (modules.length > 0) {
    pushClaim(claims, {
      category: 'purpose',
      statement: `Core backend concern clusters appear in modules: ${modules.map(item => `${item.name}(${item.files})`).join(', ')}.`,
      evidenceTier: 'architecture-inferred',
      confidence: 0.8,
      sources: modules.map(item => item.name),
    });
  }

  if (frameworks.hasNest || frameworks.hasReact || frameworks.hasTypeOrm || frameworks.hasBull) {
    const parts = [
      frameworks.hasNest ? 'NestJS backend' : '',
      frameworks.hasReact ? 'React frontend' : '',
      frameworks.hasTypeOrm ? 'TypeORM persistence' : '',
      frameworks.hasBull ? 'queue/worker integration' : '',
    ].filter(Boolean);
    pushClaim(claims, {
      category: 'patterns',
      statement: `Implementation stack pattern indicates ${parts.join(' + ')}.`,
      evidenceTier: 'code-verified',
      confidence: 0.86,
      sources: ['import graph'],
    });
  }

  if (entrypoints.length > 0) {
    pushClaim(claims, {
      category: 'entrypoints',
      statement: `Startup/entrypoint symbols include ${entrypoints.map(item => `${item.symbol}@${item.file}`).join(', ')}.`,
      evidenceTier: 'code-verified',
      confidence: 0.88,
      sources: entrypoints.map(item => item.file),
    });
  }

  if (architecture) {
    const topModules = [...architecture.modules]
      .sort((a, b) => b.files - a.files || (b.inbound + b.outbound) - (a.inbound + a.outbound))
      .slice(0, 6)
      .map(module => `${module.name}(files:${module.files}, edges:${module.inbound + module.outbound})`)
      .join(', ');
    const topDeps = [...architecture.dependencies]
      .filter(dep => dep.from !== dep.to)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 6)
      .map(dep => `${dep.from}->${dep.to}(${dep.weight.toFixed(1)})`)
      .join(', ');
    const granularity = architectureGranularity(architecture);

    pushClaim(claims, {
      category: 'architecture',
      statement: `Architecture snapshot has ${architecture.modules.length} modules and ${architecture.dependencies.length} weighted dependencies.`,
      evidenceTier: 'architecture-inferred',
      confidence: architecture.modules.length > 1 ? 0.82 : 0.62,
      sources: ['architecture snapshot'],
    });
    if (topModules) {
      pushClaim(claims, {
        category: 'architecture',
        statement: `Top modules by footprint/connectivity: ${topModules}.`,
        evidenceTier: 'architecture-inferred',
        confidence: granularity.isCoarse ? 0.66 : 0.82,
        sources: ['architecture modules'],
      });
    }
    if (topDeps) {
      pushClaim(claims, {
        category: 'architecture',
        statement: `Heaviest dependency edges: ${topDeps}.`,
        evidenceTier: 'architecture-inferred',
        confidence: granularity.isCoarse ? 0.64 : 0.8,
        sources: ['architecture dependencies'],
      });
    }
    if (granularity.isCoarse) {
      pushClaim(claims, {
        category: 'architecture',
        statement: `Architecture granularity is currently coarse (${(granularity.coarseRatio * 100).toFixed(0)}% broad buckets). Validate boundaries with coupling_report and dependency_path before deep refactors.`,
        evidenceTier: 'architecture-inferred',
        confidence: 0.6,
        sources: ['architecture granularity heuristic'],
      });
    }
  }

  if (status) {
    pushClaim(claims, {
      category: 'conventions',
      statement: `Recent change mix suggests engineering focus on ${topChangeKinds(recentChanges)} with active topics ${status.activeTopics.slice(0, 5).map(item => `${item.topic}(${item.count})`).join(', ') || 'none'}.`,
      evidenceTier: 'memory-derived',
      confidence: 0.68,
      sources: ['project memory changes'],
    });
  }

  if (featureMap?.documentedFeatures.length) {
    pushClaim(claims, {
      category: 'purpose',
      statement: `Documented feature intent emphasizes: ${featureMap.documentedFeatures.slice(0, 4).map(entry => entry.title).join('; ')}.`,
      evidenceTier: 'doc-derived',
      confidence: 0.7,
      sources: featureMap.documentedFeatures.slice(0, 4).map(entry => entry.path),
    });
  }

  const weighted = claims.map(claim => claim.confidence * tierWeight(claim.evidenceTier));
  const overallConfidence = weighted.length > 0
    ? clamp01(weighted.reduce((sum, score) => sum + score, 0) / weighted.length)
    : 0;

  const confidenceBreakdown: Record<UnderstandingEvidenceTier, number> = {
    'code-verified': claims.filter(claim => claim.evidenceTier === 'code-verified').length,
    'architecture-inferred': claims.filter(claim => claim.evidenceTier === 'architecture-inferred').length,
    'doc-derived': claims.filter(claim => claim.evidenceTier === 'doc-derived').length,
    'memory-derived': claims.filter(claim => claim.evidenceTier === 'memory-derived').length,
  };

  return {
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    overallConfidence,
    confidenceBreakdown,
    claims,
  };
}

export function renderProjectIntentSnapshot(snapshot: ProjectIntentSnapshot): string {
  const sections = [
    `Generated: ${snapshot.generatedAt}`,
    `Overall confidence: ${snapshot.overallConfidence.toFixed(2)}`,
    `Evidence mix: code=${snapshot.confidenceBreakdown['code-verified']}, architecture=${snapshot.confidenceBreakdown['architecture-inferred']}, docs=${snapshot.confidenceBreakdown['doc-derived']}, memory=${snapshot.confidenceBreakdown['memory-derived']}`,
    '',
    ...snapshot.claims.map(claim => `- [${claim.evidenceTier}] (${claim.category}) ${claim.statement} (confidence ${claim.confidence.toFixed(2)})`),
  ];
  return sections.join('\n');
}