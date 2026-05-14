import * as path from 'path';
import { getDataDir } from './git.js';
import { loadGraphAsync, type GraphData } from './graph.js';
import {
  getFeatureMapAsync,
  getProjectMemoryFreshnessAsync,
  getProjectStatusAsync,
  listRecentChangesAsync,
  type ChangeMemoryEntry,
} from './project-memory.js';
import { loadManifestAsync } from './indexer.js';
import { loadArchitectureAsync, refreshArchitectureAsync } from './cognition/architecture/storage.js';
import { loadEvolutionAsync, refreshEvolutionAsync } from './cognition/evolution/engine.js';
import type { ArchitectureModule, ArchitectureSnapshot } from './cognition/architecture/types.js';
import type { EvolutionSnapshot } from './cognition/evolution/types.js';
import type { ProjectDocumentType } from './document-memory.js';
import { summarizeOwnershipForFilesAsync } from './ownership-insights.js';

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
  title: string;
  contentMd: string;
  overallConfidence: number;
  confidenceBreakdown: Record<UnderstandingEvidenceTier, number>;
  keyModules: ProjectOverviewModule[];
  entryPoints: ProjectOverviewEntryPoint[];
  importantDocs: ProjectOverviewDocument[];
  gitHealth: ProjectGitHealth;
  freshness: ProjectIntentFreshness;
  claims: UnderstandingClaim[];
}

export interface ProjectOverviewModule {
  name: string;
  fileCount: number;
  symbolCount: number;
  inbound: number;
  outbound: number;
  instability: number;
  coupling: number;
  riskScore: number;
  zone: string;
  responsibilityHint: string;
  primaryOwner: string | null;
  ownerPct: number;
  recentOwner: string | null;
  contributorCount: number;
  busFactor: number;
  evidence: string[];
}

export interface ProjectOverviewEntryPoint {
  symbol: string;
  file: string;
  reason: string;
}

export interface ProjectOverviewDocument {
  title: string;
  path: string;
  docType: ProjectDocumentType;
  summary: string;
}

export interface ProjectGitHealth {
  totalFilesIndexed: number;
  indexedChunks: number;
  hotspotCount: number;
  churnTrend: 'increasing' | 'stable' | 'decreasing' | 'unknown';
  topChurnModules: string[];
  activeTopics: Array<{ topic: string; count: number }>;
}

export interface ProjectIntentFreshness {
  memoryRefreshedAt: string | null;
  indexedHeadSha: string | null;
  currentHeadSha: string | null;
  needsReindex: boolean;
  reasons: string[];
  dirtyFileCount: number;
  dirtyFilesNewerThanMemory: number;
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function humanizeToken(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
}

function moduleTokens(moduleName: string): string[] {
  return moduleName
    .replace(/\\/g, '/')
    .split('/')
    .flatMap(part => humanizeToken(part).toLowerCase().split(/[^a-z0-9]+/))
    .filter(token => token.length >= 3 && !['src', 'apps', 'libs', 'packages'].includes(token));
}

function fileMatchesModule(moduleName: string, filePath: string): boolean {
  const modulePath = moduleName.replace(/\\/g, '/');
  const normalizedFile = filePath.replace(/\\/g, '/');
  if (normalizedFile === modulePath || normalizedFile.startsWith(`${modulePath}/`)) return true;
  const moduleTail = modulePath.split('/').filter(Boolean).at(-1);
  return Boolean(moduleTail && normalizedFile.includes(`/${moduleTail}/`));
}

function entryPointReason(symbol: string, file: string): string {
  const normalized = file.replace(/\\/g, '/').toLowerCase();
  if (normalized.startsWith('bin/')) return 'CLI bootstrap surface';
  if (normalized.endsWith('/main.ts') || normalized.endsWith('/main.tsx')) return 'Runtime bootstrap entrypoint';
  if (normalized.endsWith('/server.ts')) return 'Server startup surface';
  if (normalized.endsWith('/app.tsx')) return 'Application root component';
  if (normalized.endsWith('/app.module.ts') || symbol.endsWith('AppModule')) return 'Application composition root';
  if (symbol === 'bootstrap') return 'Bootstrap entrypoint function';
  return 'Startup/entrypoint heuristic';
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

function entrypointHints(graph: GraphData): Array<ProjectOverviewEntryPoint> {
  const out: Array<{ symbol: string; file: string }> = [];
  for (const [symbol, file] of Object.entries(graph.symbolFile)) {
    const normalized = file.replace(/\\/g, '/');
    if (
      symbol === 'bootstrap'
      || symbol.endsWith('AppModule')
      || normalized.startsWith('bin/')
      || normalized.endsWith('/main.ts')
      || normalized.endsWith('/main.tsx')
      || normalized.endsWith('/server.ts')
      || normalized.endsWith('/app.tsx')
      || normalized.endsWith('/app.module.ts')
    ) {
      out.push({ symbol, file: normalized });
    }
  }
  out.sort((a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol));
  return out.slice(0, 12).map(item => ({ ...item, reason: entryPointReason(item.symbol, item.file) }));
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

function deriveChurnTrend(evolution: EvolutionSnapshot | null): ProjectGitHealth['churnTrend'] {
  if (!evolution) return 'unknown';

  const deltas = evolution.modules
    .map(module => {
      const latest = module.instabilityTrend.at(-1);
      const previous = module.instabilityTrend.at(-2);
      if (!latest || !previous) return null;
      return latest.churn - previous.churn;
    })
    .filter((value): value is number => typeof value === 'number');

  if (deltas.length === 0) return 'unknown';
  const averageDelta = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  if (averageDelta > 0.5) return 'increasing';
  if (averageDelta < -0.5) return 'decreasing';
  return 'stable';
}

function moduleSupport(
  moduleName: string,
  recentChanges: ChangeMemoryEntry[],
  docs: ProjectOverviewDocument[]
): { topics: string[]; docs: string[] } {
  const topics = new Map<string, number>();
  for (const change of recentChanges) {
    if (!change.files.some(file => fileMatchesModule(moduleName, file))) continue;
    for (const topic of change.topics) {
      topics.set(topic, (topics.get(topic) ?? 0) + 1);
    }
  }

  const moduleWords = moduleTokens(moduleName);
  const matchingDocs = docs
    .filter(doc => {
      const haystack = `${doc.path} ${doc.title} ${doc.summary}`.toLowerCase();
      return moduleWords.some(token => haystack.includes(token));
    })
    .map(doc => doc.title);

  return {
    topics: [...topics.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 3)
      .map(([topic]) => topic),
    docs: matchingDocs.slice(0, 2),
  };
}

function responsibilityHint(module: ArchitectureModule, recentChanges: ChangeMemoryEntry[], docs: ProjectOverviewDocument[]): { hint: string; evidence: string[] } {
  const support = moduleSupport(module.name, recentChanges, docs);
  const fallback = humanizeToken(module.name.split('/').filter(Boolean).at(-1) ?? module.name).toLowerCase();
  const focus = support.docs[0] ?? (support.topics.length > 0 ? support.topics.join(', ') : fallback);
  const zoneText = module.zone ? ` in the ${module.zone} zone` : '';
  return {
    hint: `Likely owns ${focus}${zoneText}.`,
    evidence: uniqueStrings([...support.docs, ...support.topics]).slice(0, 4),
  };
}

function buildKeyModules(
  projectRoot: string,
  graph: GraphData,
  architecture: ArchitectureSnapshot | null,
  evolution: EvolutionSnapshot | null,
  recentChanges: ChangeMemoryEntry[],
  docs: ProjectOverviewDocument[]
): Promise<ProjectOverviewModule[]> {
  if (!architecture) return Promise.resolve([]);

  const riskByModule = new Map((evolution?.hotspots ?? []).map(item => [item.module, item.riskScore]));
  return Promise.all([...architecture.modules]
    .sort((left, right) => {
      const leftRisk = riskByModule.get(left.name) ?? 0;
      const rightRisk = riskByModule.get(right.name) ?? 0;
      return rightRisk - leftRisk
        || right.files - left.files
        || (right.inbound + right.outbound) - (left.inbound + left.outbound)
        || left.name.localeCompare(right.name);
    })
    .slice(0, 8)
    .map(async module => {
      const support = responsibilityHint(module, recentChanges, docs);
      const files = uniqueStrings(Object.values(graph.symbolFile).filter(file => fileMatchesModule(module.name, file)));
      const ownership = await summarizeOwnershipForFilesAsync(projectRoot, files, { maxFiles: 24 });
      return {
        name: module.name,
        fileCount: module.files,
        symbolCount: module.symbols,
        inbound: module.inbound,
        outbound: module.outbound,
        instability: architecture.instability[module.name] ?? 0,
        coupling: architecture.coupling[module.name] ?? 0,
        riskScore: riskByModule.get(module.name) ?? 0,
        zone: module.zone,
        responsibilityHint: support.hint,
        primaryOwner: ownership.primaryOwner,
        ownerPct: ownership.ownerPct,
        recentOwner: ownership.recentOwner,
        contributorCount: ownership.contributorCount,
        busFactor: ownership.busFactor,
        evidence: support.evidence,
      };
    }));
}

function buildOverviewMd(
  title: string,
  claims: UnderstandingClaim[],
  keyModules: ProjectOverviewModule[],
  entryPoints: ProjectOverviewEntryPoint[],
  docs: ProjectOverviewDocument[],
  gitHealth: ProjectGitHealth
): string {
  const topClaims = claims
    .filter(claim => claim.category === 'purpose' || claim.category === 'architecture' || claim.category === 'patterns')
    .slice(0, 3)
    .map(claim => claim.statement);

  const lines = [
    `# ${title}`,
    '',
    ...(topClaims.length > 0 ? [topClaims.join(' '), ''] : ['No overview generated yet.', '']),
    `- Key modules: ${keyModules.slice(0, 4).map(module => module.name).join(', ') || 'none'}`,
    `- Entry points: ${entryPoints.slice(0, 4).map(entry => `${entry.symbol}@${entry.file}`).join(', ') || 'none'}`,
    `- Important docs: ${docs.slice(0, 3).map(doc => doc.title).join(', ') || 'none'}`,
    `- Indexed files: ${gitHealth.totalFilesIndexed}; hotspot modules tracked: ${gitHealth.hotspotCount}; churn trend: ${gitHealth.churnTrend}`,
  ];

  return lines.join('\n');
}

export async function buildProjectIntentSnapshot(projectRoot: string): Promise<ProjectIntentSnapshot | null> {
  const root = path.resolve(projectRoot);
  const graphPath = path.join(getDataDir(root), 'graph.json');
  const graph = await loadGraphAsync(graphPath);
  if (!graph) return null;

  const manifestFile = path.join(getDataDir(root), 'manifest.json');

  const [architecture, evolution, featureMap, status, recentChanges, manifest, freshness] = await Promise.all([
    loadArchitectureAsync(root) ?? refreshArchitectureAsync(root),
    loadEvolutionAsync(root) ?? refreshEvolutionAsync(root),
    getFeatureMapAsync(root),
    getProjectStatusAsync(root),
    listRecentChangesAsync(root, { limit: 20 }),
    loadManifestAsync(manifestFile),
    getProjectMemoryFreshnessAsync(root),
  ]);

  const claims: UnderstandingClaim[] = [];
  const title = path.basename(root);
  const packages = packageDistribution(graph);
  const modules = dominantModules(graph);
  const entrypoints = entrypointHints(graph);
  const frameworks = detectFrameworkPatterns(graph);
  const importantDocs: ProjectOverviewDocument[] = (featureMap?.documentedFeatures ?? []).slice(0, 8).map(entry => ({
    title: entry.title,
    path: entry.path,
    docType: entry.docType,
    summary: entry.summary,
  }));

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

  const keyModules = await buildKeyModules(root, graph, architecture, evolution, recentChanges, importantDocs);
  const gitHealth: ProjectGitHealth = {
    totalFilesIndexed: Object.keys(manifest.fileChunks).length || Object.keys(graph.files).length,
    indexedChunks: Object.values(manifest.fileChunks).reduce((sum, ids) => sum + ids.length, 0),
    hotspotCount: evolution?.hotspots.length ?? 0,
    churnTrend: deriveChurnTrend(evolution),
    topChurnModules: [...(evolution?.hotspots ?? [])]
      .sort((left, right) => right.churn - left.churn || right.riskScore - left.riskScore)
      .slice(0, 5)
      .map(item => item.module),
    activeTopics: status?.activeTopics.slice(0, 5) ?? [],
  };

  const projectFreshness: ProjectIntentFreshness = {
    memoryRefreshedAt: freshness.memoryRefreshedAt,
    indexedHeadSha: freshness.indexedHeadSha,
    currentHeadSha: freshness.currentHeadSha,
    needsReindex: freshness.needsReindex,
    reasons: freshness.reasons,
    dirtyFileCount: freshness.dirtyFileCount,
    dirtyFilesNewerThanMemory: freshness.dirtyFilesNewerThanMemory,
  };

  const contentMd = buildOverviewMd(title, claims, keyModules, entrypoints, importantDocs, gitHealth);

  return {
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    title,
    contentMd,
    overallConfidence,
    confidenceBreakdown,
    keyModules,
    entryPoints: entrypoints,
    importantDocs,
    gitHealth,
    freshness: projectFreshness,
    claims,
  };
}

export function renderProjectIntentSnapshot(snapshot: ProjectIntentSnapshot): string {
  const sections = [
    `Title: ${snapshot.title}`,
    `Generated: ${snapshot.generatedAt}`,
    `Overall confidence: ${snapshot.overallConfidence.toFixed(2)}`,
    `Evidence mix: code=${snapshot.confidenceBreakdown['code-verified']}, architecture=${snapshot.confidenceBreakdown['architecture-inferred']}, docs=${snapshot.confidenceBreakdown['doc-derived']}, memory=${snapshot.confidenceBreakdown['memory-derived']}`,
    '',
    '## Overview',
    snapshot.contentMd,
    '',
    '## Key Modules',
    snapshot.keyModules.length > 0
      ? snapshot.keyModules.map(module => [
          `- ${module.name}`,
          `  files=${module.fileCount}, symbols=${module.symbolCount}, inbound=${module.inbound}, outbound=${module.outbound}, instability=${module.instability.toFixed(2)}, coupling=${module.coupling.toFixed(2)}, risk=${module.riskScore.toFixed(2)}`,
          `  responsibility: ${module.responsibilityHint}`,
          `  ownership: primary=${module.primaryOwner ?? 'unknown'} (${(module.ownerPct * 100).toFixed(0)}%), recent=${module.recentOwner ?? 'unknown'}, contributors=${module.contributorCount}, busFactor=${module.busFactor}`,
          module.evidence.length > 0 ? `  evidence: ${module.evidence.join(', ')}` : '',
        ].filter(Boolean).join('\n')).join('\n')
      : 'none',
    '',
    '## Entry Points',
    snapshot.entryPoints.length > 0
      ? snapshot.entryPoints.map(entry => `- ${entry.symbol}@${entry.file} — ${entry.reason}`).join('\n')
      : 'none',
    '',
    '## Important Docs',
    snapshot.importantDocs.length > 0
      ? snapshot.importantDocs.map(doc => `- ${doc.title} (${doc.docType}) — ${doc.path}\n  ${doc.summary}`).join('\n')
      : 'none',
    '',
    '## Git / Index Health',
    `- indexed files: ${snapshot.gitHealth.totalFilesIndexed}`,
    `- indexed chunks: ${snapshot.gitHealth.indexedChunks}`,
    `- hotspot count: ${snapshot.gitHealth.hotspotCount}`,
    `- churn trend: ${snapshot.gitHealth.churnTrend}`,
    `- top churn modules: ${snapshot.gitHealth.topChurnModules.join(', ') || 'none'}`,
    `- active topics: ${snapshot.gitHealth.activeTopics.map(item => `${item.topic}(${item.count})`).join(', ') || 'none'}`,
    '',
    '## Freshness',
    `- memory refreshed at: ${snapshot.freshness.memoryRefreshedAt ?? 'unknown'}`,
    `- indexed head: ${snapshot.freshness.indexedHeadSha ?? 'unknown'}`,
    `- current head: ${snapshot.freshness.currentHeadSha ?? 'unknown'}`,
    `- dirty files: ${snapshot.freshness.dirtyFileCount}`,
    `- dirty files newer than memory: ${snapshot.freshness.dirtyFilesNewerThanMemory}`,
    `- needs reindex: ${snapshot.freshness.needsReindex ? 'yes' : 'no'}`,
    snapshot.freshness.reasons.length > 0 ? `- reasons: ${snapshot.freshness.reasons.join('; ')}` : '',
    '',
    '## Evidence-backed Claims',
    ...snapshot.claims.map(claim => `- [${claim.evidenceTier}] (${claim.category}) ${claim.statement} (confidence ${claim.confidence.toFixed(2)})`),
  ];
  return sections.join('\n');
}