import * as path from 'path';
import { loadGraphAsync, type GraphData } from './graph.js';
import { getDataDir } from './git.js';
import { getProjectMemoryEntriesAsync, type ChangeMemoryEntry, type ProjectMemoryEntry } from './project-memory.js';
import { summarizeOwnershipForFilesAsync } from './ownership-insights.js';

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
  dependentsCount: number;
  likelyTestCallers: string[];
  impactSurface: HotspotImpactSurface[];
  primaryOwner: string | null;
  ownerPct: number;
  recentOwner: string | null;
  contributorCount: number;
  busFactor: number;
  testGap: boolean;
  riskSummary: string;
  topics: string[];
  score: number;
  churnScore: number;
  connectivityScore: number;
}

export interface FileHotspot {
  file: string;
  changeCount: number;
  fixCount: number;
  lastChanged: string | null;
  lastChangeTitle: string | null;
  symbolCount: number;
  connectivity: number;
  dependentsCount: number;
  nearbyTests: string[];
  impactSurface: FileHotspotImpact[];
  primaryOwner: string | null;
  ownerPct: number;
  recentOwner: string | null;
  contributorCount: number;
  busFactor: number;
  testGap: boolean;
  riskSummary: string;
  topics: string[];
  score: number;
  churnScore: number;
  connectivityScore: number;
}

export interface HotspotImpactSurface {
  symbol: string;
  file: string | null;
  relation: RelationKind;
  score: number;
  isTest: boolean;
}

export interface FileHotspotImpact {
  file: string;
  relation: 'calls' | 'calledBy';
  score: number;
  isTest: boolean;
}

export interface RiskHotspotsResult {
  analyzedChanges: number;
  symbols: SymbolHotspot[];
  files: FileHotspot[];
}

export interface RiskHotspotsOptions {
  limit?: number;
  topic?: string;
  sortBy?: 'risk' | 'churn' | 'connectivity';
  excludeSinkNodes?: boolean;
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

function hotspotComponents(changeCount: number, fixCount: number, connectivity: number): { churnScore: number; connectivityScore: number; score: number } {
  const churnScore = changeCount * 4 + fixCount * 3;
  const connectivityScore = connectivity;
  return { churnScore, connectivityScore, score: churnScore + connectivityScore };
}

function hotspotScore(changeCount: number, fixCount: number, connectivity: number): number {
  return hotspotComponents(changeCount, fixCount, connectivity).score;
}

function isTestPath(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return /(^|\/)(test|tests)\//.test(normalized) || /\.(test|spec)\.[a-z0-9]+$/.test(normalized);
}

function relationScore(kind: RelationKind): number {
  return relationWeight(kind);
}

function buildSymbolImpactSurface(graph: GraphData, symbol: string, limit = 3): HotspotImpactSurface[] {
  const entries: HotspotImpactSurface[] = [];
  const push = (targetSymbol: string, relation: RelationKind): void => {
    entries.push({
      symbol: targetSymbol,
      file: graph.symbolFile[targetSymbol] ?? null,
      relation,
      score: relationScore(relation) + graphConnectivity(graph, targetSymbol),
      isTest: isTestPath(graph.symbolFile[targetSymbol] ?? null),
    });
  };

  for (const caller of graph.callers[symbol] ?? []) push(caller, 'calledBy');
  for (const callee of graph.symbols[symbol] ?? []) push(callee, 'calls');
  for (const implementation of graph.implementations[symbol] ?? []) push(implementation, 'implements');
  for (const base of graph.implementedFrom[symbol] ?? []) push(base, 'implementedFrom');

  const deduped = new Map<string, HotspotImpactSurface>();
  for (const entry of entries) {
    const key = `${entry.relation}:${entry.symbol}`;
    const existing = deduped.get(key);
    if (!existing || existing.score < entry.score) deduped.set(key, entry);
  }

  return [...deduped.values()]
    .sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol))
    .slice(0, limit);
}

function likelyTestCallers(graph: GraphData, symbol: string): string[] {
  return (graph.callers[symbol] ?? []).filter(caller => isTestPath(graph.symbolFile[caller] ?? null));
}

function fileDependents(graph: GraphData, symbols: string[], currentFile: string): string[] {
  const dependents = new Set<string>();
  for (const symbol of symbols) {
    for (const caller of graph.callers[symbol] ?? []) {
      const callerFile = graph.symbolFile[caller];
      if (!callerFile || callerFile === currentFile) continue;
      dependents.add(callerFile);
    }
  }
  return [...dependents];
}

function candidateGraphFiles(graph: GraphData): string[] {
  return [...new Set([...Object.keys(graph.files), ...Object.values(graph.symbolFile)])];
}

function nearbyTestFiles(file: string, graph: GraphData): string[] {
  const normalized = file.replace(/\\/g, '/');
  const dir = path.posix.dirname(normalized);
  const ext = path.posix.extname(normalized);
  const base = path.posix.basename(normalized, ext).toLowerCase();

  return candidateGraphFiles(graph)
    .filter(candidate => candidate !== file)
    .filter(candidate => isTestPath(candidate))
    .filter(candidate => {
      const candidateNormalized = candidate.replace(/\\/g, '/').toLowerCase();
      const candidateDir = path.posix.dirname(candidateNormalized);
      return candidateDir === dir.toLowerCase()
        || candidateDir.startsWith(`${dir.toLowerCase()}/`)
        || dir.toLowerCase().startsWith(`${candidateDir}/`)
        || candidateNormalized.includes(base);
    })
    .slice(0, 5);
}

function buildFileImpactSurface(graph: GraphData, file: string, symbols: string[], limit = 3): FileHotspotImpact[] {
  const scores = new Map<string, { file: string; relation: 'calls' | 'calledBy'; score: number; isTest: boolean }>();
  const register = (targetFile: string | undefined, relation: 'calls' | 'calledBy', weight: number): void => {
    if (!targetFile || targetFile === file) return;
    const existing = scores.get(`${relation}:${targetFile}`);
    const next = {
      file: targetFile,
      relation,
      score: (existing?.score ?? 0) + weight,
      isTest: isTestPath(targetFile),
    };
    scores.set(`${relation}:${targetFile}`, next);
  };

  for (const symbol of symbols) {
    for (const callee of graph.symbols[symbol] ?? []) {
      register(graph.symbolFile[callee], 'calls', 4 + graphConnectivity(graph, callee));
    }
    for (const caller of graph.callers[symbol] ?? []) {
      register(graph.symbolFile[caller], 'calledBy', 6 + graphConnectivity(graph, caller));
    }
  }

  return [...scores.values()]
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .slice(0, limit);
}

function symbolRiskSummary(entry: SymbolHotspot): string {
  const ownership = entry.primaryOwner
    ? `, owned ${(entry.ownerPct * 100).toFixed(0)}% by ${entry.primaryOwner}`
    : '';
  const busFactorRisk = entry.busFactor === 1 && entry.primaryOwner
    ? `, bus factor risk (sole maintainer: ${entry.primaryOwner})`
    : '';
  return `${entry.symbol} — score ${entry.score.toFixed(1)}, ${entry.dependentsCount} dependents, ${entry.changeCount} changes, ${entry.fixCount} fixes${ownership}${busFactorRisk}${entry.testGap ? ', no nearby tests seen' : ''}`;
}

function fileRiskSummary(entry: FileHotspot): string {
  const ownership = entry.primaryOwner
    ? `, owned ${(entry.ownerPct * 100).toFixed(0)}% by ${entry.primaryOwner}`
    : '';
  const busFactorRisk = entry.busFactor === 1 && entry.primaryOwner
    ? `, bus factor risk (sole maintainer: ${entry.primaryOwner})`
    : '';
  return `${entry.file} — score ${entry.score.toFixed(1)}, ${entry.dependentsCount} dependent files, ${entry.changeCount} changes, ${entry.fixCount} fixes${ownership}${busFactorRisk}${entry.testGap ? ', no nearby tests seen' : ''}`;
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

export async function getAffectedSymbols(
  projectRoot: string,
  seeds: string[],
  opts?: { hops?: number; direction?: ImpactDirection; limit?: number }
): Promise<AffectedSymbolsResult | null> {
  const root = path.resolve(projectRoot);
  const graph = await loadGraphAsync(graphFile(root));
  if (!graph) return null;

  const hops = opts?.hops ?? 2;
  const direction = opts?.direction ?? 'both';
  const limit = opts?.limit ?? 20;
  const entries = await getProjectMemoryEntriesAsync(root);
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

function isValidGraph(value: unknown): value is GraphData {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GraphData>;
  return (
    typeof candidate.symbols === 'object' &&
    candidate.symbols !== null &&
    typeof candidate.callers === 'object' &&
    candidate.callers !== null &&
    typeof candidate.symbolFile === 'object' &&
    candidate.symbolFile !== null
  );
}

export async function getRiskHotspots(projectRoot: string, opts: number | RiskHotspotsOptions = 10): Promise<RiskHotspotsResult | null> {
  const root = path.resolve(projectRoot);
  const graphRaw = await loadGraphAsync(graphFile(root));
  if (!isValidGraph(graphRaw)) {
    return null;
  }
  const graph = graphRaw;

  const {
    limit: maxResults,
    topic,
    sortBy,
    excludeSinkNodes,
  } = typeof opts === 'number'
    ? { limit: opts, topic: undefined as string | undefined, sortBy: 'risk' as const, excludeSinkNodes: false }
    : {
        limit: opts.limit ?? 10,
        topic: opts.topic?.toLowerCase(),
        sortBy: opts.sortBy ?? 'risk',
        excludeSinkNodes: opts.excludeSinkNodes ?? (opts.sortBy === 'connectivity'),
      };
  const entries = (await getProjectMemoryEntriesAsync(root))
    .filter(entry => !topic || (isChangeEntry(entry) && entry.topics.some(item => item.includes(topic))));
  const { changeEntries, symbolStats, fileStats } = buildChangeStats(entries);

  const symbolsByFile = new Map<string, Set<string>>();
  for (const [symbol, file] of Object.entries(graph.symbolFile)) {
    if (!symbolsByFile.has(file)) symbolsByFile.set(file, new Set<string>());
    symbolsByFile.get(file)!.add(symbol);
  }

  function symbolSortKey(entry: { score: number; churnScore: number; connectivityScore: number; dependentsCount: number; symbol: string }): number {
    switch (sortBy) {
      case 'churn': return entry.churnScore;
      case 'connectivity': return entry.connectivityScore;
      default: return entry.score;
    }
  }

  function fileSortKey(entry: { score: number; churnScore: number; connectivityScore: number; dependentsCount: number; file: string }): number {
    switch (sortBy) {
      case 'churn': return entry.churnScore;
      case 'connectivity': return entry.connectivityScore;
      default: return entry.score;
    }
  }

  const rankedSymbolHotspots = [...symbolStats.entries()]
    .map(([symbol, stat]) => {
      const dependentsCount = (graph.callers[symbol] ?? []).length;
      const connectivity = graphConnectivity(graph, symbol);
      const { score, churnScore, connectivityScore } = hotspotComponents(stat.changeCount, stat.fixCount, connectivity);
      const tests = likelyTestCallers(graph, symbol);
      return {
        symbol,
        file: graph.symbolFile[symbol] ?? null,
        changeCount: stat.changeCount,
        fixCount: stat.fixCount,
        lastChanged: stat.lastChanged,
        lastChangeTitle: stat.lastChangeTitle,
        connectivity,
        dependentsCount,
        likelyTestCallers: tests,
        impactSurface: buildSymbolImpactSurface(graph, symbol),
        topics: toTopTopics(stat.topics),
        score,
        churnScore,
        connectivityScore,
      };
    })
    .filter(entry => !excludeSinkNodes || entry.dependentsCount > 0)
    .sort((left, right) => symbolSortKey(right) - symbolSortKey(left) || left.symbol.localeCompare(right.symbol))
    .slice(0, maxResults);

  const rankedFileHotspots = [...fileStats.entries()]
    .map(([file, stat]) => {
      const symbols = [...(symbolsByFile.get(file) ?? new Set<string>())];
      const connectivity = symbols.reduce((total, symbol) => total + graphConnectivity(graph, symbol), 0);
      const dependents = fileDependents(graph, symbols, file);
      const { score, churnScore, connectivityScore } = hotspotComponents(stat.changeCount, stat.fixCount, connectivity);
      return {
        file,
        changeCount: stat.changeCount,
        fixCount: stat.fixCount,
        lastChanged: stat.lastChanged,
        lastChangeTitle: stat.lastChangeTitle,
        symbolCount: symbols.length,
        connectivity,
        dependentsCount: dependents.length,
        nearbyTests: nearbyTestFiles(file, graph),
        impactSurface: buildFileImpactSurface(graph, file, symbols),
        topics: toTopTopics(stat.topics),
        score,
        churnScore,
        connectivityScore,
      };
    })
    .filter(entry => !excludeSinkNodes || entry.dependentsCount > 0)
    .sort((left, right) => fileSortKey(right) - fileSortKey(left) || left.file.localeCompare(right.file))
    .slice(0, maxResults);

  const symbolHotspots: SymbolHotspot[] = await Promise.all(rankedSymbolHotspots.map(async entry => {
    const ownership = entry.file
      ? await summarizeOwnershipForFilesAsync(root, [entry.file], { maxFiles: 1 })
      : await summarizeOwnershipForFilesAsync(root, [], { maxFiles: 1 });
    const enriched: SymbolHotspot = {
      ...entry,
      primaryOwner: ownership.primaryOwner,
      ownerPct: ownership.ownerPct,
      recentOwner: ownership.recentOwner,
      contributorCount: ownership.contributorCount,
      busFactor: ownership.busFactor,
      testGap: entry.likelyTestCallers.length === 0,
      riskSummary: '',
    };
    enriched.riskSummary = symbolRiskSummary(enriched);
    return enriched;
  }));

  const fileHotspots: FileHotspot[] = await Promise.all(rankedFileHotspots.map(async entry => {
    const ownership = await summarizeOwnershipForFilesAsync(root, [entry.file], { maxFiles: 1 });
    const enriched: FileHotspot = {
      ...entry,
      primaryOwner: ownership.primaryOwner,
      ownerPct: ownership.ownerPct,
      recentOwner: ownership.recentOwner,
      contributorCount: ownership.contributorCount,
      busFactor: ownership.busFactor,
      testGap: entry.nearbyTests.length === 0,
      riskSummary: '',
    };
    enriched.riskSummary = fileRiskSummary(enriched);
    return enriched;
  }));

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
        `Dependents: ${entry.dependentsCount}`,
        `Ownership: primary=${entry.primaryOwner ?? 'unknown'} (${(entry.ownerPct * 100).toFixed(0)}%), recent=${entry.recentOwner ?? 'unknown'}, contributors=${entry.contributorCount}, busFactor=${entry.busFactor}`,
        `Likely test callers: ${entry.likelyTestCallers.join(', ') || 'none'}`,
        `Test gap: ${entry.testGap ? 'yes' : 'no'}`,
        entry.impactSurface.length > 0
          ? `Impact surface: ${entry.impactSurface.map(item => `${item.symbol}${item.file ? `@${item.file}` : ''} [${item.relation}]`).join('; ')}`
          : 'Impact surface: none',
        entry.topics.length > 0 ? `Topics: ${entry.topics.join(', ')}` : '',
        `Connectivity: ${entry.connectivity}`,
        `Score: ${entry.score.toFixed(1)}`,
        `Summary: ${entry.riskSummary}`,
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
        `Dependent files: ${entry.dependentsCount}`,
        `Ownership: primary=${entry.primaryOwner ?? 'unknown'} (${(entry.ownerPct * 100).toFixed(0)}%), recent=${entry.recentOwner ?? 'unknown'}, contributors=${entry.contributorCount}, busFactor=${entry.busFactor}`,
        `Nearby tests: ${entry.nearbyTests.join(', ') || 'none'}`,
        `Test gap: ${entry.testGap ? 'yes' : 'no'}`,
        entry.impactSurface.length > 0
          ? `Impact surface: ${entry.impactSurface.map(item => `${item.file} [${item.relation}]`).join('; ')}`
          : 'Impact surface: none',
        `Connectivity: ${entry.connectivity}`,
        `Score: ${entry.score.toFixed(1)}`,
        `Summary: ${entry.riskSummary}`,
      ].filter(Boolean).join('\n')).join('\n\n---\n\n'),
    ].join('\n\n'));
  } else {
    sections.push('## File hotspots\n\nNo file hotspots found.');
  }

  return sections.join('\n\n');
}