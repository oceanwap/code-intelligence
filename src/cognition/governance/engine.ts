import * as path from 'path';
import { getDataDir } from '../../git.js';
import { getFeatureMapAsync, listRecentBugsAsync, listRecentChangesAsync } from '../../project-memory.js';
import { loadArchitectureAsync, refreshArchitectureAsync } from '../architecture/storage.js';
import { loadCognitionConfigAsync } from '../config.js';
import { loadFailureIntelligenceAsync, refreshFailureIntelligenceAsync } from '../failures/engine.js';
import { type GovernanceEntry, type GovernanceHealth, type GovernanceSnapshot } from './types.js';

function governanceFile(projectRoot: string): string {
  return path.join(getDataDir(projectRoot), 'memory-governance.json');
}

function moduleFromFile(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return '<root>';
  if (parts[0] === 'src') return parts.length >= 2 ? `src/${parts[1]}` : 'src';
  if (parts[0] === 'test') return parts.length >= 2 ? `test/${parts[1]}` : 'test';
  return parts[0];
}

function daysSince(isoDate: string, now: number): number {
  const parsed = Date.parse(isoDate);
  if (Number.isNaN(parsed)) return 365;
  return Math.max(0, (now - parsed) / 86_400_000);
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function saveSnapshotAsync(projectRoot: string, snapshot: GovernanceSnapshot): Promise<void> {
  await Bun.write(governanceFile(projectRoot), JSON.stringify(snapshot, null, 2));
}

async function loadSnapshotAsync(projectRoot: string): Promise<GovernanceSnapshot | null> {
  const file = governanceFile(projectRoot);
  try {
    const bunFile = Bun.file(file);
    if (!(await bunFile.exists())) return null;
    return JSON.parse(await bunFile.text()) as GovernanceSnapshot;
  } catch {
    return null;
  }
}

export async function refreshMemoryGovernanceAsync(projectRoot: string): Promise<GovernanceSnapshot> {
  const cfg = await loadCognitionConfigAsync(projectRoot);
  const now = Date.now();
  const generatedAt = new Date(now).toISOString();

  const architecture = await loadArchitectureAsync(projectRoot) ?? await refreshArchitectureAsync(projectRoot);
  const failures = await loadFailureIntelligenceAsync(projectRoot) ?? await refreshFailureIntelligenceAsync(projectRoot);

  const unstableModules = new Set<string>(
    architecture
      ? Object.entries(architecture.instability)
        .filter(([, score]) => score >= cfg.governance.unstableModuleThreshold)
          .map(([module]) => module)
      : []
  );

  const frequentFailureModules = new Set<string>();
  const failureCounts = new Map<string, number>();
  for (const record of failures.records) {
    for (const boundary of record.affectedBoundaries) {
      failureCounts.set(boundary, (failureCounts.get(boundary) ?? 0) + 1);
    }
  }
  for (const [module, count] of failureCounts.entries()) {
    if (count >= cfg.failure.recurringFailureBoundaryCount) frequentFailureModules.add(module);
  }

  const changes = await listRecentChangesAsync(projectRoot, { limit: 180 });
  const bugs = await listRecentBugsAsync(projectRoot, { limit: 180 });
  const featureMap = await getFeatureMapAsync(projectRoot);
  const docs = featureMap?.documentedFeatures ?? [];

  const entries: GovernanceEntry[] = [];

  for (const change of changes) {
    const ageDays = daysSince(change.timestamp, now);
    const decayScore = clamp(ageDays / cfg.governance.changeDecayWindowDays);
    const baseConfidence = 0.66;
    const confidence = Number(clamp(baseConfidence * (1 - decayScore * 0.55)).toFixed(3));
    const contradictions: string[] = [];
    const modules = change.files.map(moduleFromFile);

    if (change.changeType === 'feature' && modules.some(module => frequentFailureModules.has(module))) {
      contradictions.push('feature-change-on-recurring-failure-module');
    }
    if (modules.some(module => unstableModules.has(module))) {
      contradictions.push('references-unstable-architecture-module');
    }

    entries.push({
      id: `change:${change.id}`,
      kind: 'change',
      confidence,
      source: 'git-derived-change-memory',
      createdAt: change.timestamp,
      lastValidatedAt: ageDays <= 45 ? generatedAt : change.timestamp,
      decayScore: Number(decayScore.toFixed(3)),
      evidenceRefs: [change.sha, ...change.files.slice(0, 5), ...change.symbols.slice(0, 5)],
      contradictions,
    });
  }

  for (const bug of bugs) {
    const ageDays = daysSince(bug.timestamp, now);
    const decayScore = clamp(ageDays / cfg.governance.bugDecayWindowDays);
    const evidenceBoost = clamp(bug.evidenceScore / 5, 0, 0.2);
    const baseConfidence = 0.7 + evidenceBoost;
    const confidence = Number(clamp(baseConfidence * (1 - decayScore * 0.5)).toFixed(3));
    const contradictions: string[] = [];
    const modules = bug.files.map(moduleFromFile);
    if (modules.some(module => unstableModules.has(module))) contradictions.push('bug-linked-unstable-architecture-module');
    if (bug.symbols.length > 0 && docs.length > 0) contradictions.push('evidence-backed-symbol-history');

    entries.push({
      id: `bug:${bug.id}`,
      kind: 'bug',
      confidence,
      source: 'bug-memory',
      createdAt: bug.timestamp,
      lastValidatedAt: ageDays <= 45 ? generatedAt : bug.timestamp,
      decayScore: Number(decayScore.toFixed(3)),
      evidenceRefs: [bug.id, ...bug.files.slice(0, 5), ...bug.symbols.slice(0, 5)],
      contradictions,
    });
  }

  const health: GovernanceHealth = {
    totalEntries: entries.length,
    staleEntries: entries.filter(entry => entry.decayScore >= cfg.governance.staleDecayThreshold || entry.confidence <= cfg.governance.staleConfidenceThreshold).length,
    contradictedEntries: entries.filter(entry => entry.contradictions.length > 0).length,
    averageConfidence: Number(average(entries.map(entry => entry.confidence)).toFixed(3)),
  };

  const snapshot: GovernanceSnapshot = {
    generatedAt,
    entries,
    health,
  };

  await saveSnapshotAsync(projectRoot, snapshot);
  return snapshot;
}

export async function loadMemoryGovernanceAsync(projectRoot: string): Promise<GovernanceSnapshot | null> {
  return await loadSnapshotAsync(projectRoot);
}

export async function memoryHealthAsync(projectRoot: string): Promise<GovernanceHealth> {
  const snapshot = await loadMemoryGovernanceAsync(projectRoot) ?? await refreshMemoryGovernanceAsync(projectRoot);
  return snapshot.health;
}

export async function contradictionReportAsync(projectRoot: string, limit = 20): Promise<GovernanceEntry[]> {
  const snapshot = await loadMemoryGovernanceAsync(projectRoot) ?? await refreshMemoryGovernanceAsync(projectRoot);
  return snapshot.entries.filter(entry => entry.contradictions.length > 0).slice(0, limit);
}

export async function staleMemoryAsync(projectRoot: string, limit = 20): Promise<GovernanceEntry[]> {
  const cfg = await loadCognitionConfigAsync(projectRoot);
  const snapshot = await loadMemoryGovernanceAsync(projectRoot) ?? await refreshMemoryGovernanceAsync(projectRoot);
  return snapshot.entries
    .filter(entry => entry.decayScore >= cfg.governance.staleDecayThreshold || entry.confidence <= cfg.governance.staleConfidenceThreshold)
    .sort((left, right) => right.decayScore - left.decayScore || left.confidence - right.confidence)
    .slice(0, limit);
}
