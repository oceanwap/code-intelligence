import * as path from 'path';
import { loadGraph, type GraphData } from './graph.js';
import { getDataDir } from './git.js';
import { getProjectMemoryEntries, type ChangeMemoryEntry, type ProjectMemoryEntry } from './project-memory.js';

type ImpactDirection = 'out' | 'in' | 'both';
type RelationKind = 'calls' | 'calledBy' | 'implements' | 'implementedFrom';

interface ChangeStat {
  changeCount: number;
  fixCount: number;
  lastChanged: string | null;
  lastChangeTitle: string | null;
  topics: Map<string, number>;
}

interface RelationReason {
  kind: RelationKind;
  via: string;
}

export interface AffectedSymbolEntry {
  symbol: string;
  file: string | null;
  distance: number;
  reasons: RelationReason[];
  changeCount: number;
  fixCount: number;
  lastChanged: string | null;
  lastChangeTitle: string | null;
  connectivity: number;
  topics: string[];
  score: number;
}

export interface AffectedSymbolsResult {
  seeds: string[];
  missingSeeds: string[];
  entries: AffectedSymbolEntry[];
  totalDiscovered: number;
}

export interface SymbolHotspot {
  symbol: string;
  file: string | null;
  changeCount: number;
  fixCount: number;
  lastChanged: string | null;
  lastChangeTitle: string | null;
  connectivity: number;
  topics: string[];
  score: number;
}

export interface FileHotspot {
  file: string;
  changeCount: number;
  fixCount: number;
  lastChanged: string | null;
  lastChangeTitle: string | null;
  symbolCount: number;
  connectivity: number;
  topics: string[];
  score: number;
}

export interface RiskHotspotsResult {
  analyzedChanges: number;
  symbols: SymbolHotspot[];
  files: FileHotspot[];
}

export interface RiskHotspotsOptions {
  limit?: number;
  topic?: string;
}

function isChangeEntry(entry: ProjectMemoryEntry): entry is ChangeMemoryEntry {
  return entry.kind === 'change';
}

function addUnique(target: Set<string>, values: string[]): void {
  for (const value of values) {
    if (value) target.add(value);
  }
}

function toTopTopics(topics: Map<string, number>, limit = 4): string[] {
  return [...topics.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([topic]) => topic);
}

function updateStat(stat: ChangeStat, entry: ChangeMemoryEntry): void {
  stat.changeCount += 1;
  if (entry.changeType === 'fix') stat.fixCount += 1;
  if (!stat.lastChanged || Date.parse(entry.timestamp) > Date.parse(stat.lastChanged)) {
    stat.lastChanged = entry.timestamp;
    stat.lastChangeTitle = entry.title;
  }
  for (const topic of entry.topics) {
    stat.topics.set(topic, (stat.topics.get(topic) ?? 0) + 1);
  }
}

function emptyStat(): ChangeStat {
  return {
    changeCount: 0,
    fixCount: 0,
    lastChanged: null,
    lastChangeTitle: null,
    topics: new Map<string, number>(),
  };
}

function buildChangeStats(entries: ProjectMemoryEntry[]): {
  changeEntries: ChangeMemoryEntry[];
  symbolStats: Map<string, ChangeStat>;
  fileStats: Map<string, ChangeStat>;
} {
  const changeEntries = entries.filter(isChangeEntry);
  const symbolStats = new Map<string, ChangeStat>();
  const fileStats = new Map<string, ChangeStat>();

  for (const entry of changeEntries) {
    for (const symbol of new Set(entry.symbols)) {
      if (!symbolStats.has(symbol)) symbolStats.set(symbol, emptyStat());
      updateStat(symbolStats.get(symbol)!, entry);
    }

    for (const file of new Set(entry.files)) {
      if (!fileStats.has(file)) fileStats.set(file, emptyStat());
      updateStat(fileStats.get(file)!, entry);
    }
  }

  return { changeEntries, symbolStats, fileStats };
}

function relationWeight(kind: RelationKind): number {
  switch (kind) {
    case 'calledBy':
      return 6;
    case 'implements':
      return 5;
    case 'calls':
      return 4;
    case 'implementedFrom':
      return 3;
  }
}

function graphConnectivity(graph: GraphData, symbol: string): number {
  const neighbors = new Set<string>();
  addUnique(neighbors, graph.symbols[symbol] ?? []);
  addUnique(neighbors, graph.callers[symbol] ?? []);
  addUnique(neighbors, graph.implementations[symbol] ?? []);
  addUnique(neighbors, graph.implementedFrom[symbol] ?? []);
  addUnique(neighbors, graph.supertypes[symbol] ?? []);
  addUnique(neighbors, graph.subtypes[symbol] ?? []);
  return neighbors.size;
}

function relationNeighbors(graph: GraphData, symbol: string, direction: ImpactDirection): Array<{ symbol: string; reason: RelationReason }> {
  const neighbors: Array<{ symbol: string; reason: RelationReason }> = [];

  if (direction === 'out' || direction === 'both') {
    for (const callee of graph.symbols[symbol] ?? []) {
      neighbors.push({ symbol: callee, reason: { kind: 'calls', via: symbol } });
    }
    for (const implementation of graph.implementations[symbol] ?? []) {
      neighbors.push({ symbol: implementation, reason: { kind: 'implements', via: symbol } });
    }
  }

  if (direction === 'in' || direction === 'both') {
    for (const caller of graph.callers[symbol] ?? []) {
      neighbors.push({ symbol: caller, reason: { kind: 'calledBy', via: symbol } });
    }
    for (const base of graph.implementedFrom[symbol] ?? []) {
      neighbors.push({ symbol: base, reason: { kind: 'implementedFrom', via: symbol } });
    }
  }

  return neighbors;
}

function impactedSymbolScore(entry: AffectedSymbolEntry): number {
  const strongestReason = entry.reasons.reduce((max, reason) => Math.max(max, relationWeight(reason.kind)), 0);
  return strongestReason + entry.changeCount * 4 + entry.fixCount * 3 + entry.connectivity - entry.distance * 6;
}

function hotspotScore(changeCount: number, fixCount: number, connectivity: number): number {
  return changeCount * 4 + fixCount * 3 + connectivity;
}

function formatReason(reason: RelationReason): string {
  switch (reason.kind) {
    case 'calls':
      return `called from ${reason.via}`;
    case 'calledBy':
      return `calls ${reason.via}`;
    case 'implements':
      return `implements or overrides ${reason.via}`;
    case 'implementedFrom':
      return `implemented by ${reason.via}`;
  }
}

function graphFile(projectRoot: string): string {
  return path.join(getDataDir(projectRoot), 'graph.json');
}

export function getAffectedSymbols(
  projectRoot: string,
  seeds: string[],
  opts?: { hops?: number; direction?: ImpactDirection; limit?: number }
): AffectedSymbolsResult | null {
  const root = path.resolve(projectRoot);
  const graph = loadGraph(graphFile(root));
  if (!graph) return null;

  const hops = opts?.hops ?? 2;
  const direction = opts?.direction ?? 'both';
  const limit = opts?.limit ?? 20;
  const entries = getProjectMemoryEntries(root);
  const { symbolStats } = buildChangeStats(entries);

  const queue: Array<{ symbol: string; distance: number }> = [];
  const seen = new Map<string, { distance: number; reasons: RelationReason[] }>();
  const seedSet = new Set(seeds);
  const missingSeeds = seeds.filter(seed => !graph.symbolFile[seed] && !symbolStats.has(seed));

  for (const seed of seeds) {
    if (missingSeeds.includes(seed)) continue;
    queue.push({ symbol: seed, distance: 0 });
    seen.set(seed, { distance: 0, reasons: [] });
  }

  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (current.distance >= hops) continue;

    for (const neighbor of relationNeighbors(graph, current.symbol, direction)) {
      const existing = seen.get(neighbor.symbol);
      const nextDistance = current.distance + 1;
      if (!existing) {
        seen.set(neighbor.symbol, { distance: nextDistance, reasons: [neighbor.reason] });
        queue.push({ symbol: neighbor.symbol, distance: nextDistance });
        continue;
      }
      if (existing.distance === nextDistance) {
        const exists = existing.reasons.some(reason => reason.kind === neighbor.reason.kind && reason.via === neighbor.reason.via);
        if (!exists) existing.reasons.push(neighbor.reason);
      }
    }
  }

  const impacted = [...seen.entries()]
    .filter(([symbol, data]) => !seedSet.has(symbol) && data.distance > 0)
    .map(([symbol, data]) => {
      const stat = symbolStats.get(symbol) ?? emptyStat();
      const entry: AffectedSymbolEntry = {
        symbol,
        file: graph.symbolFile[symbol] ?? null,
        distance: data.distance,
        reasons: data.reasons,
        changeCount: stat.changeCount,
        fixCount: stat.fixCount,
        lastChanged: stat.lastChanged,
        lastChangeTitle: stat.lastChangeTitle,
        connectivity: graphConnectivity(graph, symbol),
        topics: toTopTopics(stat.topics),
        score: 0,
      };
      entry.score = impactedSymbolScore(entry);
      return entry;
    })
    .sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol))
    .slice(0, limit);

  return {
    seeds,
    missingSeeds,
    entries: impacted,
    totalDiscovered: Math.max(0, seen.size - seedSet.size),
  };
}

export function renderAffectedSymbols(result: AffectedSymbolsResult): string {
  const sections = [
    `Seeds: ${result.seeds.join(', ')}`,
    result.missingSeeds.length > 0 ? `Missing seeds: ${result.missingSeeds.join(', ')}` : '',
    `Affected symbols found: ${result.totalDiscovered}`,
  ].filter(Boolean);

  if (result.entries.length === 0) {
    sections.push('No affected symbols found in the current graph neighborhood.');
    return sections.join('\n');
  }

  sections.push(
    result.entries.map(entry => [
      `### ${entry.symbol}`,
      entry.file ? `File: ${entry.file}` : '',
      `Distance: ${entry.distance}`,
      `Why: ${entry.reasons.map(formatReason).join('; ')}`,
      `Change history: ${entry.changeCount} change(s), ${entry.fixCount} fix(es)`,
      entry.lastChanged ? `Last changed: ${entry.lastChanged}${entry.lastChangeTitle ? ` — ${entry.lastChangeTitle}` : ''}` : '',
      entry.topics.length > 0 ? `Topics: ${entry.topics.join(', ')}` : '',
      `Connectivity: ${entry.connectivity}`,
      `Score: ${entry.score.toFixed(1)}`,
    ].filter(Boolean).join('\n')).join('\n\n---\n\n')
  );

  return sections.join('\n\n');
}

export function getRiskHotspots(projectRoot: string, opts: number | RiskHotspotsOptions = 10): RiskHotspotsResult | null {
  const root = path.resolve(projectRoot);
  const graph = loadGraph(graphFile(root));
  if (!graph) return null;

  const { limit: maxResults, topic } = typeof opts === 'number'
    ? { limit: opts, topic: undefined as string | undefined }
    : { limit: opts.limit ?? 10, topic: opts.topic?.toLowerCase() };
  const entries = getProjectMemoryEntries(root)
    .filter(entry => !topic || (isChangeEntry(entry) && entry.topics.some(item => item.includes(topic))));
  const { changeEntries, symbolStats, fileStats } = buildChangeStats(entries);
  const symbolHotspots = [...symbolStats.entries()]
    .map(([symbol, stat]) => ({
      symbol,
      file: graph.symbolFile[symbol] ?? null,
      changeCount: stat.changeCount,
      fixCount: stat.fixCount,
      lastChanged: stat.lastChanged,
      lastChangeTitle: stat.lastChangeTitle,
      connectivity: graphConnectivity(graph, symbol),
      topics: toTopTopics(stat.topics),
      score: hotspotScore(stat.changeCount, stat.fixCount, graphConnectivity(graph, symbol)),
    }))
    .sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol))
    .slice(0, maxResults);

  const symbolsByFile = new Map<string, Set<string>>();
  for (const [symbol, file] of Object.entries(graph.symbolFile)) {
    if (!symbolsByFile.has(file)) symbolsByFile.set(file, new Set<string>());
    symbolsByFile.get(file)!.add(symbol);
  }

  const fileHotspots = [...fileStats.entries()]
    .map(([file, stat]) => {
      const symbols = [...(symbolsByFile.get(file) ?? new Set<string>())];
      const connectivity = symbols.reduce((total, symbol) => total + graphConnectivity(graph, symbol), 0);
      return {
        file,
        changeCount: stat.changeCount,
        fixCount: stat.fixCount,
        lastChanged: stat.lastChanged,
        lastChangeTitle: stat.lastChangeTitle,
        symbolCount: symbols.length,
        connectivity,
        topics: toTopTopics(stat.topics),
        score: hotspotScore(stat.changeCount, stat.fixCount, connectivity),
      };
    })
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .slice(0, maxResults);

  return {
    analyzedChanges: changeEntries.length,
    symbols: symbolHotspots,
    files: fileHotspots,
  };
}

export function renderRiskHotspots(result: RiskHotspotsResult): string {
  const sections = [`Analyzed change entries: ${result.analyzedChanges}`];

  if (result.symbols.length > 0) {
    sections.push([
      '## Symbol hotspots',
      result.symbols.map(entry => [
        `### ${entry.symbol}`,
        entry.file ? `File: ${entry.file}` : '',
        `Change history: ${entry.changeCount} change(s), ${entry.fixCount} fix(es)`,
        entry.lastChanged ? `Last changed: ${entry.lastChanged}${entry.lastChangeTitle ? ` — ${entry.lastChangeTitle}` : ''}` : '',
        entry.topics.length > 0 ? `Topics: ${entry.topics.join(', ')}` : '',
        `Connectivity: ${entry.connectivity}`,
        `Score: ${entry.score.toFixed(1)}`,
      ].filter(Boolean).join('\n')).join('\n\n---\n\n'),
    ].join('\n\n'));
  } else {
    sections.push('## Symbol hotspots\n\nNo symbol hotspots found.');
  }

  if (result.files.length > 0) {
    sections.push([
      '## File hotspots',
      result.files.map(entry => [
        `### ${entry.file}`,
        `Change history: ${entry.changeCount} change(s), ${entry.fixCount} fix(es)`,
        entry.lastChanged ? `Last changed: ${entry.lastChanged}${entry.lastChangeTitle ? ` — ${entry.lastChangeTitle}` : ''}` : '',
        entry.topics.length > 0 ? `Topics: ${entry.topics.join(', ')}` : '',
        `Indexed symbols: ${entry.symbolCount}`,
        `Connectivity: ${entry.connectivity}`,
        `Score: ${entry.score.toFixed(1)}`,
      ].filter(Boolean).join('\n')).join('\n\n---\n\n'),
    ].join('\n\n'));
  } else {
    sections.push('## File hotspots\n\nNo file hotspots found.');
  }

  return sections.join('\n\n');
}