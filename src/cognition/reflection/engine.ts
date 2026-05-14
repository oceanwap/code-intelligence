import * as path from 'path';
import { getDataDir } from '../../git.js';
import { type BugMemoryEntry, type ChangeMemoryEntry, listRecentBugsAsync, listRecentChangesAsync } from '../../project-memory.js';
import { loadArchitectureAsync, refreshArchitectureAsync } from '../architecture/storage.js';
import { topUnstableModules } from '../architecture/analyzer.js';
import { type ReflectionEntry, type RegressionRiskReport } from './types.js';
import { moduleFromFile } from '../../utils/module-path.js';

interface ReflectionStore {
  updatedAt: string;
  entries: ReflectionEntry[];
}

function reflectionFile(projectRoot: string): string {
  return path.join(getDataDir(projectRoot), 'reflection.json');
}

async function loadStoreAsync(projectRoot: string): Promise<ReflectionStore> {
  const file = reflectionFile(projectRoot);
  try {
    const bunFile = Bun.file(file);
    if (!(await bunFile.exists())) {
      return { updatedAt: new Date().toISOString(), entries: [] };
    }
    return JSON.parse(await bunFile.text()) as ReflectionStore;
  } catch {
    return { updatedAt: new Date().toISOString(), entries: [] };
  }
}

async function saveStoreAsync(projectRoot: string, store: ReflectionStore): Promise<void> {
  await Bun.write(reflectionFile(projectRoot), JSON.stringify(store, null, 2));
}

function overlapScore(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  let hits = 0;
  for (const value of right) {
    if (leftSet.has(value)) hits += 1;
  }
  return hits / Math.max(leftSet.size, new Set(right).size, 1);
}

function relatedFailures(change: ChangeMemoryEntry, bugs: BugMemoryEntry[]): Array<{ id: string; title: string; score: number }> {
  return bugs
    .map(bug => {
      const topicOverlap = overlapScore(change.topics, bug.topics);
      const symbolOverlap = overlapScore(change.symbols, bug.symbols);
      const fileOverlap = overlapScore(change.files, bug.files);
      const score = topicOverlap * 0.5 + symbolOverlap * 0.3 + fileOverlap * 0.2;
      return { id: bug.id, title: bug.title, score: Number(score.toFixed(3)) };
    })
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
}

function estimateRisk(score: number): 'low' | 'medium' | 'high' {
  if (score >= 0.65) return 'high';
  if (score >= 0.35) return 'medium';
  return 'low';
}

export async function reflectChangeAsync(projectRoot: string, changeId?: string): Promise<ReflectionEntry | null> {
  const changes = await listRecentChangesAsync(projectRoot, { limit: 60 });
  const change = changeId
    ? changes.find(entry => entry.sha === changeId || entry.id === changeId)
    : changes[0];

  if (!change) return null;

  const store = await loadStoreAsync(projectRoot);
  const existing = store.entries.find(entry => entry.changeId === change.sha || entry.changeId === change.id);
  if (existing) return existing;

  const architecture = await loadArchitectureAsync(projectRoot) ?? await refreshArchitectureAsync(projectRoot);
  const affectedModules = [...new Set(change.files.map(moduleFromFile))];
  const couplingScores = architecture
    ? affectedModules.map(module => architecture.coupling[module] ?? 0)
    : [0];
  const instabilityScores = architecture
    ? affectedModules.map(module => architecture.instability[module] ?? 0)
    : [0];
  const averageCoupling = couplingScores.reduce((sum, score) => sum + score, 0) / Math.max(couplingScores.length, 1);
  const averageInstability = instabilityScores.reduce((sum, score) => sum + score, 0) / Math.max(instabilityScores.length, 1);

  const prior = store.entries[0];
  const couplingDelta = Number((averageCoupling - (prior?.couplingDelta ?? 0)).toFixed(3));

  const architectureViolations: string[] = [];
  if (affectedModules.length >= 4) architectureViolations.push('wide-cross-module-touch');
  if (averageInstability >= 0.75) architectureViolations.push('high-instability-module-touch');
  if (change.changeType === 'fix' && affectedModules.length >= 3) architectureViolations.push('broad-fix-surface');

  const similarChanges = changes
    .filter(entry => entry.sha !== change.sha)
    .map(entry => {
      const topicOverlap = overlapScore(change.topics, entry.topics);
      const symbolOverlap = overlapScore(change.symbols, entry.symbols);
      const score = topicOverlap * 0.6 + symbolOverlap * 0.4;
      return { id: entry.sha, score };
    })
    .filter(item => item.score >= 0.2)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map(item => item.id);

  const confidenceBase = 0.4 + Math.min(0.35, similarChanges.length * 0.07);
  const confidence = Number(Math.max(0.1, Math.min(0.95, confidenceBase + (change.symbols.length > 0 ? 0.1 : 0))).toFixed(3));
  const riskScore = Math.min(1, averageInstability * 0.45 + Math.min(averageCoupling / 8, 1) * 0.35 + architectureViolations.length * 0.2);

  const entry: ReflectionEntry = {
    changeId: change.sha,
    summary: change.summary,
    affectedModules,
    couplingDelta,
    riskLevel: estimateRisk(riskScore),
    architectureViolations,
    historicalSimilarity: similarChanges,
    confidence,
    createdAt: new Date().toISOString(),
  };

  const next: ReflectionStore = {
    updatedAt: new Date().toISOString(),
    entries: [entry, ...store.entries].slice(0, 500),
  };
  await saveStoreAsync(projectRoot, next);
  return entry;
}

export async function regressionRiskAsync(projectRoot: string, target: string): Promise<RegressionRiskReport> {
  const architecture = await loadArchitectureAsync(projectRoot) ?? await refreshArchitectureAsync(projectRoot);
  const bugs = await listRecentBugsAsync(projectRoot, { limit: 30 });
  const unstable = architecture
    ? topUnstableModules(architecture, 10)
    : [];

  const targetLower = target.toLowerCase();
  const targetModule = moduleFromFile(target);
  const unstableHit = unstable.filter(item => item.module.toLowerCase().includes(targetLower) || item.module === targetModule);
  const failures = bugs
    .map(bug => {
      const topicMatch = bug.topics.some(topic => targetLower.includes(topic) || topic.includes(targetLower));
      const symbolMatch = bug.symbols.some(symbol => symbol.toLowerCase().includes(targetLower));
      const fileMatch = bug.files.some(file => file.toLowerCase().includes(targetLower));
      const score = (topicMatch ? 0.4 : 0) + (symbolMatch ? 0.4 : 0) + (fileMatch ? 0.2 : 0);
      return { id: bug.id, title: bug.title, score: Number(score.toFixed(3)) };
    })
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);

  const instabilityScore = unstableHit.reduce((sum, item) => sum + item.instability, 0) / Math.max(unstableHit.length, 1);
  const failureScore = failures.reduce((sum, failure) => sum + failure.score, 0) / Math.max(failures.length, 1);
  const score = Number(Math.min(1, instabilityScore * 0.55 + failureScore * 0.45).toFixed(3));

  const signals: string[] = [];
  if (unstableHit.length > 0) signals.push('target-touches-unstable-modules');
  if (failures.length > 0) signals.push('historical-failure-overlap');
  if (failures.some(failure => failure.score >= 0.8)) signals.push('high-similarity-regression-pattern');
  if (signals.length === 0) signals.push('no-strong-risk-signal-detected');

  return {
    target,
    score,
    level: estimateRisk(score),
    signals,
    unstableModules: unstableHit.map(item => ({ module: item.module, instability: item.instability })),
    recentFailures: failures,
  };
}

export async function findSimilarFailuresAsync(projectRoot: string, target: string, limit = 10): Promise<BugMemoryEntry[]> {
  const bugs = await listRecentBugsAsync(projectRoot, { limit: 80 });
  const targetLower = target.toLowerCase();

  return bugs
    .filter(bug => bug.symbols.some(symbol => symbol.toLowerCase().includes(targetLower))
      || bug.files.some(file => file.toLowerCase().includes(targetLower))
      || bug.topics.some(topic => targetLower.includes(topic) || topic.includes(targetLower)))
    .slice(0, limit);
}

export async function recentReflectionEntriesAsync(projectRoot: string, limit = 10): Promise<ReflectionEntry[]> {
  const store = await loadStoreAsync(projectRoot);
  return store.entries.slice(0, limit);
}

export async function reflectLatestChangeAsync(projectRoot: string): Promise<ReflectionEntry | null> {
  const latest = (await listRecentChangesAsync(projectRoot, { limit: 1 }))[0];
  if (!latest) return null;
  return await reflectChangeAsync(projectRoot, latest.sha);
}

export function reflectionFilePath(projectRoot: string): string {
  return reflectionFile(projectRoot);
}

export async function reflectionFailuresForChangeAsync(projectRoot: string, changeId: string): Promise<Array<{ id: string; title: string; score: number }>> {
  const changes = await listRecentChangesAsync(projectRoot, { limit: 80 });
  const bugs = await listRecentBugsAsync(projectRoot, { limit: 80 });
  const change = changes.find(entry => entry.sha === changeId || entry.id === changeId);
  if (!change) return [];
  return relatedFailures(change, bugs);
}
