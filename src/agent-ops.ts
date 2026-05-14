import * as path from 'path';
import { queryProject } from './indexer-run.js';
import { getWorkingTreeChangesAsync, getCurrentBranchAsync, branchSlug } from './git.js';
import {
  getFeatureMapAsync,
  listRecentBugsAsync,
  listRecentChangesAsync,
  queryProjectMemory,
  syncProjectMemory,
} from './project-memory.js';
import { refreshArchitectureAsync, loadArchitectureAsync } from './cognition/architecture/storage.js';
import { refreshStructureAsync, loadStructureAsync } from './cognition/structure/engine.js';
import { refreshAttentionAsync, loadAttentionAsync, rerankByAttentionAsync } from './cognition/attention/engine.js';
import { refreshFailureIntelligenceAsync } from './cognition/failures/engine.js';
import { refreshEvolutionAsync, loadEvolutionAsync } from './cognition/evolution/engine.js';
import { refreshMemoryGovernanceAsync, loadMemoryGovernanceAsync } from './cognition/governance/engine.js';
import { validateArchitectureAsync, listConstraintViolationsAsync } from './cognition/constraints/engine.js';
import { regressionRiskAsync } from './cognition/reflection/engine.js';
import { loadGraphAsync } from './graph.js';
import { getDataDir } from './git.js';
import { moduleFromFile } from './utils/module-path.js';
import { shouldRefresh } from './cognition/freshness-gate.js';
import { THRESHOLD_DUPLICATE, THRESHOLD_PARTIAL, ExistingMatch, ExistingMatchTier } from './find-existing.js';

// Max ages for each cognition snapshot before a refresh is triggered.
const FRESHNESS_MS = {
  structure:    5 * 60 * 1_000,   //  5 min
  architecture: 5 * 60 * 1_000,   //  5 min
  attention:   10 * 60 * 1_000,   // 10 min
  failures:    15 * 60 * 1_000,   // 15 min
  evolution:   10 * 60 * 1_000,   // 10 min
  governance:  10 * 60 * 1_000,   // 10 min
};

const TASK_STOP_WORDS = new Set([
  'the', 'and', 'with', 'from', 'that', 'this', 'what', 'when', 'where', 'why',
  'how', 'for', 'into', 'about', 'over', 'under', 'your', 'their', 'please', 'fix',
]);

function tokenizeTask(task: string): string[] {
  return task
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter(token => token.length >= 3 && !TASK_STOP_WORDS.has(token));
}

function scoreTaskTopic(candidate: string, taskTokens: Set<string>): number {
  let score = 0;
  for (const token of candidate.toLowerCase().split(/[^a-z0-9_./-]+/)) {
    if (!token) continue;
    if (taskTokens.has(token)) score += 1;
  }
  return score;
}

function topTaskTopic(task: string): string | undefined {
  const tokens = tokenizeTask(task);
  return tokens.length > 0 ? tokens[0] : undefined;
}

export async function ensureCognitionBaseline(projectRoot: string, qdrantUrl = 'http://localhost:6333'): Promise<void> {
  const root = path.resolve(projectRoot);
  const dataDir = getDataDir(root);

  // Always sync memory — it is fast and HEAD-aware internally.
  await syncProjectMemory(root, qdrantUrl);

  // Refresh each cognition layer only when its snapshot is stale.
  const [needsStructure, needsArch, needsAttention, needsFailures, needsEvolution, needsGovernance] =
    await Promise.all([
      shouldRefresh(`${dataDir}/structure.json`,             FRESHNESS_MS.structure,    root),
      shouldRefresh(`${dataDir}/architecture.json`,          FRESHNESS_MS.architecture, root),
      shouldRefresh(`${dataDir}/attention.json`,             FRESHNESS_MS.attention,    root),
      shouldRefresh(`${dataDir}/failure-intelligence.json`,  FRESHNESS_MS.failures,     root),
      shouldRefresh(`${dataDir}/evolution.json`,             FRESHNESS_MS.evolution,    root),
      shouldRefresh(`${dataDir}/memory-governance.json`,     FRESHNESS_MS.governance,   root),
    ]);

  await Promise.all([
    needsStructure    ? refreshStructureAsync(root)              : Promise.resolve(),
    needsArch         ? refreshArchitectureAsync(root)           : Promise.resolve(),
    needsAttention    ? refreshAttentionAsync(root)              : Promise.resolve(),
    needsFailures     ? refreshFailureIntelligenceAsync(root)    : Promise.resolve(),
    needsEvolution    ? refreshEvolutionAsync(root)              : Promise.resolve(),
    needsGovernance   ? refreshMemoryGovernanceAsync(root)       : Promise.resolve(),
  ]);

  // Constraint validation is cheap and always runs after architecture refresh.
  await validateArchitectureAsync(root);
}

export interface PreflightChangeEntry {
  path: string;
  status: string;
  module: string;
  attentionTier: string;
  attentionScore: number;
  regressionRisk: number;
  regressionLevel: string;
  violations: string[];
  relatedBugCount: number;
  recentChangeCount: number;
}

export interface PreflightChangesResult {
  generatedAt: string;
  totalChangedFiles: number;
  highRiskFiles: number;
  entries: PreflightChangeEntry[];
}

export async function buildPreflightChanges(projectRoot: string, qdrantUrl = 'http://localhost:6333'): Promise<PreflightChangesResult> {
  await ensureCognitionBaseline(projectRoot, qdrantUrl);

  const [workingTree, attention, violations, bugs, recentChanges] = await Promise.all([
    getWorkingTreeChangesAsync(projectRoot),
    loadAttentionAsync(projectRoot),
    listConstraintViolationsAsync(projectRoot, { limit: 200 }),
    listRecentBugsAsync(projectRoot, { limit: 120 }),
    listRecentChangesAsync(projectRoot, { limit: 120 }),
  ]);

  const moduleAttention = new Map((attention?.modules ?? []).map(entry => [entry.module, entry]));

  const entries = await Promise.all(workingTree.map(async file => {
    const moduleName = moduleFromFile(file.path);
    const attentionForModule = moduleAttention.get(moduleName);
    const regression = await regressionRiskAsync(projectRoot, file.path);

    const moduleViolations = violations
      .filter(item => item.modules.some(module => module === moduleName || module.includes(moduleName)))
      .slice(0, 5)
      .map(item => `[${item.severity}] ${item.rule}`);

    const relatedBugCount = bugs.filter(bug =>
      bug.files.some(bugFile => bugFile === file.path || bugFile.includes(moduleName))
    ).length;

    const recentChangeCount = recentChanges.filter(change =>
      change.files.some(changed => changed === file.path || changed.includes(moduleName))
    ).length;

    return {
      path: file.path,
      status: file.status,
      module: moduleName,
      attentionTier: attentionForModule?.tier ?? 'DORMANT',
      attentionScore: Number((attentionForModule?.score.composite ?? 0).toFixed(3)),
      regressionRisk: regression.score,
      regressionLevel: regression.level,
      violations: moduleViolations,
      relatedBugCount,
      recentChangeCount,
    } satisfies PreflightChangeEntry;
  }));

  const sorted = [...entries].sort((left, right) => {
    const leftRisk = left.regressionRisk + left.attentionScore + (left.violations.length * 0.15);
    const rightRisk = right.regressionRisk + right.attentionScore + (right.violations.length * 0.15);
    return rightRisk - leftRisk;
  });

  const highRiskFiles = sorted.filter(entry =>
    entry.regressionLevel === 'high' || entry.attentionTier === 'CRITICAL' || entry.violations.length > 0
  ).length;

  return {
    generatedAt: new Date().toISOString(),
    totalChangedFiles: sorted.length,
    highRiskFiles,
    entries: sorted,
  };
}

export interface AssembledTaskContext {
  task: string;
  generatedAt: string;
  topModules: Array<{ module: string; tier: string; score: number }>;
  constraints: Array<{ severity: string; rule: string; details: string; modules: string[] }>;
  semanticCode: Array<{ file: string; symbol: string; score: number; lineStart?: number; lineEnd?: number }>;
  recentChanges: Array<{ title: string; timestamp: string; topics: string[]; files: string[] }>;
  relatedBugs: Array<{ title: string; timestamp: string; evidenceScore: number; files: string[] }>;
  memoryHits: Array<{ id: string; score: number; summary: string }>;
  /**
   * Code that may ALREADY handle what this task describes.
   * Agents must review these before writing new code to avoid duplication.
   */
  existingHandlers: ExistingMatch[];
}

// Reuse the canonical thresholds from find-existing.ts.
const HANDLER_DUPLICATE_THRESHOLD = THRESHOLD_DUPLICATE;
const HANDLER_PARTIAL_THRESHOLD   = THRESHOLD_PARTIAL;

export async function assembleTaskContext(
  projectRoot: string,
  task: string,
  qdrantUrl = 'http://localhost:6333',
  limit = 8
): Promise<AssembledTaskContext> {
  const root = path.resolve(projectRoot);
  await ensureCognitionBaseline(root, qdrantUrl);

  const topic = topTaskTopic(task);
  let semantic = await queryProject(root, task, qdrantUrl);
  semantic = await rerankByAttentionAsync(root, semantic);

  const [attention, violations, changes, bugs, memoryHits, graph] = await Promise.all([
    loadAttentionAsync(root),
    listConstraintViolationsAsync(root, { limit: 25 }),
    listRecentChangesAsync(root, { limit: 30, topic }),
    listRecentBugsAsync(root, { limit: 20, topic }),
    queryProjectMemory(root, task, qdrantUrl, 8),
    loadGraphAsync(path.join(getDataDir(root), 'graph.json')),
  ]);

  const taskTokens = new Set(tokenizeTask(task));

  const topModules = (attention?.modules ?? [])
    .map(module => ({
      module: module.module,
      tier: module.tier,
      score: module.score.composite,
      taskScore: scoreTaskTopic(module.module, taskTokens),
    }))
    .sort((left, right) => (right.taskScore - left.taskScore) || (right.score - left.score))
    .slice(0, limit)
    .map(({ module, tier, score }) => ({ module, tier, score: Number(score.toFixed(3)) }));

  // Classify high-similarity semantic results as existing handlers.
  // Produces ExistingMatch objects (canonical type from find-existing.ts) so the
  // caller can pass them directly to renderFindExisting or handle uniformly.
  const existingHandlers: ExistingMatch[] = [];
  for (const item of semantic) {
    if (item.score < HANDLER_PARTIAL_THRESHOLD) continue;
    const tier: ExistingMatchTier =
      item.score >= HANDLER_DUPLICATE_THRESHOLD ? 'LIKELY_DUPLICATE' : 'PARTIAL_MATCH';
    const usageCount = graph ? (graph.callers[item.symbol]?.length ?? 0) : 0;
    const rec = tier === 'LIKELY_DUPLICATE'
      ? usageCount > 3
        ? `Extend or reuse \`${item.symbol}\` (${item.file}) — it is used in ${usageCount} places and covers this concern closely.`
        : `Consider reusing \`${item.symbol}\` (${item.file}) before creating a new implementation.`
      : `\`${item.symbol}\` (${item.file}) partially overlaps — review it first to avoid duplicating logic.`;
    existingHandlers.push({
      symbol: item.symbol,
      file: item.file,
      similarityScore: Number(item.score.toFixed(3)),
      usageCount,
      tier,
      recommendation: rec,
    });
    if (existingHandlers.length >= limit) break;
  }

  return {
    task,
    generatedAt: new Date().toISOString(),
    topModules,
    constraints: violations.slice(0, limit).map(item => ({
      severity: item.severity,
      rule: item.rule,
      details: item.details,
      modules: item.modules,
    })),
    semanticCode: semantic.slice(0, limit).map(item => ({
      file: item.file,
      symbol: item.symbol,
      score: Number(item.score.toFixed(3)),
      lineStart: item.lineStart,
      lineEnd: item.lineEnd,
    })),
    recentChanges: changes.slice(0, limit).map(change => ({
      title: change.title,
      timestamp: change.timestamp,
      topics: change.topics,
      files: change.files,
    })),
    relatedBugs: bugs.slice(0, limit).map(bug => ({
      title: bug.title,
      timestamp: bug.timestamp,
      evidenceScore: bug.evidenceScore,
      files: bug.files,
    })),
    memoryHits: memoryHits.slice(0, limit).map(hit => ({
      id: hit.entry.id,
      score: Number(hit.score.toFixed(3)),
      summary: hit.entry.summary,
    })),
    existingHandlers,
  };
}

export async function generateProjectBrief(projectRoot: string, qdrantUrl = 'http://localhost:6333'): Promise<string> {
  await ensureCognitionBaseline(projectRoot, qdrantUrl);

  const [branch, architecture, structure, attention, constraints, evolution, governance, featureMap, recentChanges, recentBugs] = await Promise.all([
    getCurrentBranchAsync(projectRoot),
    loadArchitectureAsync(projectRoot),
    loadStructureAsync(projectRoot),
    loadAttentionAsync(projectRoot),
    listConstraintViolationsAsync(projectRoot, { limit: 10 }),
    loadEvolutionAsync(projectRoot),
    loadMemoryGovernanceAsync(projectRoot),
    getFeatureMapAsync(projectRoot),
    listRecentChangesAsync(projectRoot, { limit: 8 }),
    listRecentBugsAsync(projectRoot, { limit: 6 }),
  ]);

  const topAttention = (attention?.modules ?? []).slice(0, 8)
    .map(module => `- ${module.module} (${module.tier}, ${module.score.composite.toFixed(3)})`)
    .join('\n') || '- none';

  const topConstraints = constraints
    .map(item => `- [${item.severity}] ${item.rule}: ${item.details}`)
    .join('\n') || '- none';

  const recentChangeLines = recentChanges
    .map(change => `- ${change.timestamp.slice(0, 10)} ${change.title}`)
    .join('\n') || '- none';

  const recentBugLines = recentBugs
    .map(bug => `- ${bug.timestamp.slice(0, 10)} ${bug.title}`)
    .join('\n') || '- none';

  const featureLines = (featureMap?.documentedFeatures ?? [])
    .slice(0, 8)
    .map(feature => `- ${feature.title}: ${feature.summary}`)
    .join('\n') || '- none';

  const hotspotLines = (evolution?.hotspots ?? [])
    .slice(0, 6)
    .map(hotspot => `- ${hotspot.module}: risk ${hotspot.riskScore.toFixed(3)}, churn ${hotspot.churn}, bugs ${hotspot.bugs}`)
    .join('\n') || '- none';

  return [
    '# Project Brief',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Branch: ${branch ?? 'n/a'}`,
    '',
    '## System Snapshot',
    `- Modules: ${architecture?.modules.length ?? 0}`,
    `- Dependencies: ${architecture?.dependencies.length ?? 0}`,
    `- Structure cycles: ${structure?.cycles.length ?? 0}`,
    `- Critical attention modules: ${(attention?.modules ?? []).filter(module => module.tier === 'CRITICAL').length}`,
    `- Constraint violations: ${constraints.length}`,
    `- Stale memory entries: ${governance?.health.staleEntries ?? 0}`,
    '',
    '## Top Attention Zones',
    topAttention,
    '',
    '## Key Constraints',
    topConstraints,
    '',
    '## Feature Surface',
    featureLines,
    '',
    '## Current Hotspots',
    hotspotLines,
    '',
    '## Recent Changes',
    recentChangeLines,
    '',
    '## Recent Bug Memory',
    recentBugLines,
  ].join('\n');
}

interface SnapshotSummary {
  modules: number;
  constraints: number;
  criticalAttention: number;
  staleMemory: number;
  hotspotTop: string[];
}

async function summarizeBranchSnapshots(projectRoot: string, branch: string): Promise<SnapshotSummary | null> {
  const dataDir = path.join(projectRoot, '.code-intelligence', branchSlug(branch));

  const readJson = async (name: string): Promise<Record<string, unknown> | null> => {
    try {
      const file = Bun.file(path.join(dataDir, name));
      if (!(await file.exists())) return null;
      return JSON.parse(await file.text()) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const [architecture, attention, constraints, governance, evolution] = await Promise.all([
    readJson('architecture.json'),
    readJson('attention.json'),
    readJson('constraints.json'),
    readJson('memory-governance.json'),
    readJson('evolution.json'),
  ]);

  if (!architecture && !attention && !constraints && !governance && !evolution) return null;

  const modules = Array.isArray(architecture?.['modules']) ? architecture?.['modules'].length : 0;
  const constraintsCount = Array.isArray(constraints?.['violations']) ? constraints?.['violations'].length : 0;
  const criticalAttention = Array.isArray(attention?.['modules'])
    ? (attention?.['modules'] as Array<Record<string, unknown>>).filter(item => item['tier'] === 'CRITICAL').length
    : 0;
  const staleMemory = Number((governance?.['health'] as Record<string, unknown> | undefined)?.['staleEntries'] ?? 0);
  const hotspotTop = Array.isArray(evolution?.['hotspots'])
    ? (evolution?.['hotspots'] as Array<Record<string, unknown>>).slice(0, 5).map(item => String(item['module'] ?? 'unknown'))
    : [];

  return {
    modules,
    constraints: constraintsCount,
    criticalAttention,
    staleMemory,
    hotspotTop,
  };
}

export async function compareBranchCognition(projectRoot: string, targetBranch: string): Promise<{
  currentBranch: string | null;
  targetBranch: string;
  current: SnapshotSummary | null;
  target: SnapshotSummary | null;
  deltas: Record<string, number>;
}> {
  const currentBranch = await getCurrentBranchAsync(projectRoot);
  const current = currentBranch ? await summarizeBranchSnapshots(projectRoot, currentBranch) : null;
  const target = await summarizeBranchSnapshots(projectRoot, targetBranch);

  const deltas = {
    modules: (current?.modules ?? 0) - (target?.modules ?? 0),
    constraints: (current?.constraints ?? 0) - (target?.constraints ?? 0),
    criticalAttention: (current?.criticalAttention ?? 0) - (target?.criticalAttention ?? 0),
    staleMemory: (current?.staleMemory ?? 0) - (target?.staleMemory ?? 0),
  };

  return { currentBranch, targetBranch, current, target, deltas };
}

export async function cognitionDiff(projectRoot: string): Promise<{
  generatedAt: string;
  branch: string | null;
  indexedAt: string | null;
  attentionCritical: number;
  constraints: number;
  staleMemory: number;
  topHotspots: string[];
}> {
  const branch = await getCurrentBranchAsync(projectRoot);
  const summary = branch ? await summarizeBranchSnapshots(projectRoot, branch) : null;
  const manifest = Bun.file(path.join(getDataDir(projectRoot), 'manifest.json'));
  const indexedAt = await manifest.exists() ? new Date(manifest.lastModified).toISOString() : null;

  return {
    generatedAt: new Date().toISOString(),
    branch,
    indexedAt,
    attentionCritical: summary?.criticalAttention ?? 0,
    constraints: summary?.constraints ?? 0,
    staleMemory: summary?.staleMemory ?? 0,
    topHotspots: summary?.hotspotTop ?? [],
  };
}

export interface TestImpactResult {
  target: string;
  tests: Array<{ file: string; score: number; reasons: string[]; matchedSymbols: string[] }>;
}

export async function buildTestImpact(projectRoot: string, target: string, limit = 20): Promise<TestImpactResult> {
  const graphPath = path.join(getDataDir(projectRoot), 'graph.json');
  const graph = await loadGraphAsync(graphPath);
  const allSymbols = Object.keys(graph?.symbolFile ?? {});
  const targetFile = graph?.symbolFile[target];
  const targetLower = target.toLowerCase();

  const tests: Array<{ file: string; score: number; reasons: string[]; matchedSymbols: string[] }> = [];
  const glob = new Bun.Glob('**/*.{test,spec}.{ts,tsx,js,jsx}');

  for await (const relPath of glob.scan({ cwd: projectRoot, onlyFiles: true })) {
    const filePath = relPath.replace(/\\/g, '/');
    const absPath = path.join(projectRoot, filePath);
    const file = Bun.file(absPath);
    let text = '';
    try {
      text = await file.text();
    } catch {
      continue;
    }

    const reasons: string[] = [];
    const matchedSymbols: string[] = [];
    let score = 0;

    if (targetFile && text.includes(path.basename(targetFile))) {
      score += 2;
      reasons.push(`mentions target file basename ${path.basename(targetFile)}`);
    }

    if (text.includes(target)) {
      score += 4;
      reasons.push('contains exact target token');
      matchedSymbols.push(target);
    }

    if (targetFile && text.includes(targetFile.replace(/\\/g, '/'))) {
      score += 3;
      reasons.push('contains target file path');
    }

    const symbolHits = allSymbols.filter(symbol => {
      if (matchedSymbols.includes(symbol)) return false;
      if (!text.includes(symbol)) return false;
      return symbol.toLowerCase().includes(targetLower) || targetLower.includes(symbol.toLowerCase());
    }).slice(0, 8);

    if (symbolHits.length > 0) {
      score += Math.min(4, symbolHits.length);
      reasons.push('references related indexed symbols');
      matchedSymbols.push(...symbolHits);
    }

    if (score <= 0) continue;
    tests.push({ file: filePath, score, reasons, matchedSymbols: [...new Set(matchedSymbols)] });
  }

  return {
    target,
    tests: tests
      .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
      .slice(0, limit),
  };
}
