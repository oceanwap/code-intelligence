import * as path from 'path';
import { getDataDir } from '../../git.js';
import { type BugMemoryEntry, listRecentBugsAsync } from '../../project-memory.js';
import { loadArchitectureAsync, refreshArchitectureAsync } from '../architecture/storage.js';
import { loadCognitionConfigAsync } from '../config.js';
import { type FailureCluster, type FailureClusterKey, type FailureIntelligenceSnapshot, type FailureRecord } from './types.js';

function failureFile(projectRoot: string): string {
  return path.join(getDataDir(projectRoot), 'failure-intelligence.json');
}

function moduleFromFile(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return '<root>';
  if (parts[0] === 'src') return parts.length >= 2 ? `src/${parts[1]}` : 'src';
  if (parts[0] === 'test') return parts.length >= 2 ? `test/${parts[1]}` : 'test';
  return parts[0];
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function overlap(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let hits = 0;
  for (const value of rightSet) {
    if (leftSet.has(value)) hits += 1;
  }
  return hits / Math.max(leftSet.size, rightSet.size, 1);
}

function extractRootCauses(entry: BugMemoryEntry): string[] {
  const text = `${entry.title}\n${entry.summary}\n${entry.body}`.toLowerCase();
  const causes: string[] = [];

  if (/(import|dependency|coupling|module)/.test(text)) causes.push('dependency-direction-pressure');
  if (/(boundary|layer|cross-service|leak)/.test(text)) causes.push('architecture-boundary-weakness');
  if (/(race|concurrency|async|await|deadlock|parallel)/.test(text)) causes.push('async-concurrency-risk');
  if (/(cache|ttl|stale|evict|invalidation)/.test(text)) causes.push('cache-consistency-breakdown');
  if (/(state|sync|synchroniz|ordering|eventual)/.test(text)) causes.push('state-synchronization-gap');
  if (/(dto|serialization|deserializ|contract|schema)/.test(text)) causes.push('dto-contract-drift');
  if (causes.length === 0) causes.push('insufficient-root-cause-evidence');

  return dedupe(causes);
}

function extractTriggerConditions(entry: BugMemoryEntry): string[] {
  const text = `${entry.title}\n${entry.summary}\n${entry.body}`.toLowerCase();
  const triggers: string[] = [];

  if (/(null|undefined|missing|empty)/.test(text)) triggers.push('missing-or-null-input');
  if (/(timeout|slow|latency|retry)/.test(text)) triggers.push('timing-and-retry-window');
  if (/(concurrent|parallel|race)/.test(text)) triggers.push('concurrent-execution');
  if (/(startup|boot|init)/.test(text)) triggers.push('initialization-order');
  if (/(deploy|migration|upgrade|version)/.test(text)) triggers.push('environment-or-version-shift');
  if (triggers.length === 0) triggers.push('implicit-unverified-assumption');

  return dedupe(triggers);
}

function preventivePatterns(rootCauses: string[]): string[] {
  const patterns: string[] = [];
  for (const cause of rootCauses) {
    if (cause === 'dependency-direction-pressure') patterns.push('enforce-dependency-direction-checks');
    if (cause === 'architecture-boundary-weakness') patterns.push('add-boundary-contract-tests');
    if (cause === 'async-concurrency-risk') patterns.push('guard-critical-sections-and-ordering');
    if (cause === 'cache-consistency-breakdown') patterns.push('introduce-cache-invalidation-contract');
    if (cause === 'state-synchronization-gap') patterns.push('define-state-transition-invariants');
    if (cause === 'dto-contract-drift') patterns.push('add-schema-compatibility-validation');
  }
  if (patterns.length === 0) patterns.push('capture-manual-root-cause-followup');
  return dedupe(patterns);
}

function clusterKeys(record: FailureRecord, unstableModules: Set<string>): FailureClusterKey[] {
  const keys: FailureClusterKey[] = [];
  if (record.rootCauses.includes('dependency-direction-pressure')) keys.push('dependency_pattern');
  if (record.rootCauses.includes('architecture-boundary-weakness')) keys.push('architectural_weakness');
  if (record.rootCauses.includes('async-concurrency-risk')) keys.push('async_concurrency');
  if (record.rootCauses.includes('dto-contract-drift')) keys.push('dto_leakage');
  if (record.rootCauses.includes('cache-consistency-breakdown')) keys.push('caching_issues');
  if (record.rootCauses.includes('state-synchronization-gap')) keys.push('state_synchronization');
  if (record.affectedBoundaries.some(boundary => unstableModules.has(boundary))) keys.push('module_instability');
  return dedupe(keys) as FailureClusterKey[];
}

function buildRelatedFailures(current: BugMemoryEntry, all: BugMemoryEntry[]): string[] {
  return all
    .filter(item => item.id !== current.id)
    .map(item => {
      const topicScore = overlap(current.topics, item.topics);
      const symbolScore = overlap(current.symbols, item.symbols);
      const fileScore = overlap(current.files, item.files);
      const score = topicScore * 0.5 + symbolScore * 0.3 + fileScore * 0.2;
      return { id: item.id, score };
    })
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map(item => item.id);
}

function clusterLabel(key: FailureClusterKey): string {
  if (key === 'dependency_pattern') return 'Dependency Pattern';
  if (key === 'architectural_weakness') return 'Architectural Weakness';
  if (key === 'module_instability') return 'Module Instability';
  if (key === 'async_concurrency') return 'Async/Concurrency';
  if (key === 'dto_leakage') return 'DTO Leakage';
  if (key === 'caching_issues') return 'Caching Issues';
  return 'State Synchronization';
}

function buildClusters(records: FailureRecord[]): FailureCluster[] {
  const buckets = new Map<FailureClusterKey, FailureRecord[]>();
  for (const record of records) {
    for (const key of record.clusterKeys) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(record);
    }
  }

  return [...buckets.entries()]
    .map(([key, failures]) => ({
      key,
      label: clusterLabel(key),
      count: failures.length,
      failures: failures
        .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
        .slice(0, 20)
        .map(item => ({
          id: item.id,
          title: item.title,
          fixedBySha: item.fixedBySha,
          timestamp: item.timestamp,
        })),
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

export async function refreshFailureIntelligenceAsync(projectRoot: string): Promise<FailureIntelligenceSnapshot> {
  const cfg = await loadCognitionConfigAsync(projectRoot);
  const architecture = await loadArchitectureAsync(projectRoot) ?? await refreshArchitectureAsync(projectRoot);
  const unstableModules = new Set<string>(
    architecture
      ? Object.entries(architecture.instability)
          .filter(([, score]) => score >= cfg.failure.unstableModuleThreshold)
          .map(([module]) => module)
      : []
  );

  const bugs = await listRecentBugsAsync(projectRoot, { limit: 150 });
  const records: FailureRecord[] = bugs.map(bug => {
    const rootCauses = extractRootCauses(bug);
    const affectedBoundaries = dedupe(bug.files.map(moduleFromFile));
    const record: FailureRecord = {
      id: `failure:${bug.id}`,
      sourceBugId: bug.id,
      fixedBySha: bug.fixedBySha,
      title: bug.title,
      summary: bug.summary,
      timestamp: bug.timestamp,
      symptoms: dedupe(bug.symptoms),
      rootCauses,
      triggerConditions: extractTriggerConditions(bug),
      affectedBoundaries,
      relatedFailures: buildRelatedFailures(bug, bugs),
      preventivePatterns: preventivePatterns(rootCauses),
      files: bug.files,
      symbols: bug.symbols,
      topics: bug.topics,
      clusterKeys: [] as FailureClusterKey[],
    };
    record.clusterKeys = clusterKeys(record, unstableModules);
    return record;
  });

  const snapshot: FailureIntelligenceSnapshot = {
    generatedAt: new Date().toISOString(),
    totalFailures: records.length,
    records: records.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp)),
    clusters: buildClusters(records),
  };

  await Bun.write(failureFile(projectRoot), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

export async function loadFailureIntelligenceAsync(projectRoot: string): Promise<FailureIntelligenceSnapshot | null> {
  const file = failureFile(projectRoot);
  try {
    const bunFile = Bun.file(file);
    if (!(await bunFile.exists())) return null;
    return JSON.parse(await bunFile.text()) as FailureIntelligenceSnapshot;
  } catch {
    return null;
  }
}

export async function rootCauseHistoryAsync(projectRoot: string, target: string, limit = 10): Promise<FailureRecord[]> {
  const snapshot = await loadFailureIntelligenceAsync(projectRoot) ?? await refreshFailureIntelligenceAsync(projectRoot);
  const targetLower = target.toLowerCase();
  return snapshot.records
    .filter(record =>
      record.symbols.some(symbol => symbol.toLowerCase().includes(targetLower))
      || record.files.some(file => file.toLowerCase().includes(targetLower))
      || record.topics.some(topic => targetLower.includes(topic) || topic.includes(targetLower))
      || record.affectedBoundaries.some(boundary => boundary.toLowerCase().includes(targetLower))
    )
    .slice(0, limit);
}

export async function historicalRegressionsAsync(projectRoot: string, target?: string, limit = 10): Promise<FailureRecord[]> {
  const snapshot = await loadFailureIntelligenceAsync(projectRoot) ?? await refreshFailureIntelligenceAsync(projectRoot);
  const base = target ? await rootCauseHistoryAsync(projectRoot, target, 100) : snapshot.records;
  return base
    .filter(record => record.relatedFailures.length > 0 || record.clusterKeys.includes('module_instability'))
    .slice(0, limit);
}

export async function failureClustersAsync(projectRoot: string, limit = 8): Promise<FailureCluster[]> {
  const snapshot = await loadFailureIntelligenceAsync(projectRoot) ?? await refreshFailureIntelligenceAsync(projectRoot);
  return snapshot.clusters.slice(0, limit);
}
