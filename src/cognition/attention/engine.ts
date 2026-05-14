import * as path from 'path';
import { getDataDir } from '../../git.js';
import { type RetrievedChunk } from '../../retriever.js';
import { loadFailureIntelligenceAsync, refreshFailureIntelligenceAsync } from '../failures/engine.js';
import { loadMemoryGovernanceAsync, refreshMemoryGovernanceAsync } from '../governance/engine.js';
import { loadEvolutionAsync, refreshEvolutionAsync } from '../evolution/engine.js';
import { loadStructureAsync, refreshStructureAsync } from '../structure/engine.js';
import { type AttentionScore, type AttentionSnapshot, type AttentionTier, type AttentionUsage, type ModuleAttention, type SymbolAttention } from './types.js';
import { moduleFromFile } from '../../utils/module-path.js';

function attentionFile(projectRoot: string): string {
  return path.join(getDataDir(projectRoot), 'attention.json');
}

function usageFile(projectRoot: string): string {
  return path.join(getDataDir(projectRoot), 'attention-usage.json');
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function normalize(value: number, max: number): number {
  if (max <= 0) return 0;
  return clamp(value / max);
}

function scoreTier(composite: number): AttentionTier {
  if (composite >= 0.82) return 'CRITICAL';
  if (composite >= 0.65) return 'HIGH';
  if (composite >= 0.45) return 'MEDIUM';
  if (composite >= 0.22) return 'LOW';
  return 'DORMANT';
}

async function loadUsageAsync(projectRoot: string): Promise<AttentionUsage> {
  const file = usageFile(projectRoot);
  try {
    const bunFile = Bun.file(file);
    if (!(await bunFile.exists())) {
      return {
        updatedAt: new Date().toISOString(),
        symbolQueries: {},
        moduleQueries: {},
        toolCalls: {},
      };
    }
    return JSON.parse(await bunFile.text()) as AttentionUsage;
  } catch {
    return {
      updatedAt: new Date().toISOString(),
      symbolQueries: {},
      moduleQueries: {},
      toolCalls: {},
    };
  }
}

async function saveUsageAsync(projectRoot: string, usage: AttentionUsage): Promise<void> {
  await Bun.write(usageFile(projectRoot), JSON.stringify(usage, null, 2));
}

function moduleFromSymbol(symbol: string, symbolToModule: Record<string, string>): string | null {
  return symbolToModule[symbol] ?? null;
}

export async function recordAttentionUsageAsync(
  projectRoot: string,
  event: { tool: string; symbols?: string[]; modules?: string[] }
): Promise<void> {
  const usage = await loadUsageAsync(projectRoot);
  usage.toolCalls[event.tool] = (usage.toolCalls[event.tool] ?? 0) + 1;
  for (const symbol of event.symbols ?? []) {
    usage.symbolQueries[symbol] = (usage.symbolQueries[symbol] ?? 0) + 1;
  }
  for (const module of event.modules ?? []) {
    usage.moduleQueries[module] = (usage.moduleQueries[module] ?? 0) + 1;
  }
  usage.updatedAt = new Date().toISOString();
  await saveUsageAsync(projectRoot, usage);
}

export async function refreshAttentionAsync(projectRoot: string): Promise<AttentionSnapshot | null> {
  const structure = await loadStructureAsync(projectRoot) ?? await refreshStructureAsync(projectRoot);
  if (!structure) return null;

  const evolution = await loadEvolutionAsync(projectRoot) ?? await refreshEvolutionAsync(projectRoot);
  const failure = await loadFailureIntelligenceAsync(projectRoot) ?? await refreshFailureIntelligenceAsync(projectRoot);
  const governance = await loadMemoryGovernanceAsync(projectRoot) ?? await refreshMemoryGovernanceAsync(projectRoot);
  const usage = await loadUsageAsync(projectRoot);

  const churnMap = new Map<string, number>();
  const riskMap = new Map<string, number>();
  const volatilityMap = new Map<string, number>();
  for (const hotspot of evolution.hotspots) {
    churnMap.set(hotspot.module, hotspot.churn);
    riskMap.set(hotspot.module, hotspot.riskScore);
  }
  for (const drift of evolution.drift) {
    volatilityMap.set(drift.module, Math.abs(drift.riskDelta));
  }

  const failureMap = new Map<string, number>();
  for (const record of failure.records) {
    for (const boundary of record.affectedBoundaries) {
      failureMap.set(boundary, (failureMap.get(boundary) ?? 0) + 1);
    }
  }

  const staleMap = new Map<string, number>();
  for (const entry of governance.entries) {
    for (const ref of entry.evidenceRefs) {
      const guessModule = ref.includes('/') ? ref.split('/').slice(0, 2).join('/') : ref;
      staleMap.set(guessModule, Math.max(staleMap.get(guessModule) ?? 0, entry.decayScore));
    }
  }

  const structuralMax = Math.max(...structure.modules.map(module => module.symbols + module.inbound + module.outbound), 1);
  const temporalMax = Math.max(...[...churnMap.values(), 1]);
  const behaviorMax = Math.max(...Object.values(usage.moduleQueries), ...Object.values(usage.symbolQueries), 1);
  const failureMax = Math.max(...failureMap.values(), 1);
  const volatilityMax = Math.max(...volatilityMap.values(), 1);

  const modules: ModuleAttention[] = structure.modules.map(module => {
    const structural = normalize(module.symbols + module.inbound + module.outbound, structuralMax);
    const temporal = normalize(churnMap.get(module.name) ?? 0, temporalMax);
    const behavioral = normalize(usage.moduleQueries[module.name] ?? 0, behaviorMax);
    const failureScore = normalize(failureMap.get(module.name) ?? 0, failureMax);
    const volatility = normalize(volatilityMap.get(module.name) ?? 0, volatilityMax);
    const freshness = 1 - clamp(staleMap.get(module.name) ?? 0);
    const centrality = module.centrality;
    const confidence = clamp(0.55 + (structure.modules.length > 0 ? 0.15 : 0) + (failure.records.length > 0 ? 0.15 : 0) + (evolution.modules.length > 0 ? 0.15 : 0));

    const noisePenalty = clamp((behavioral > 0.85 && structural < 0.35 ? 0.08 : 0) + (behavioral > 0.85 && failureScore < 0.1 ? 0.05 : 0));
    const composite = clamp(
      structural * 0.24
      + temporal * 0.16
      + behavioral * 0.1
      + failureScore * 0.2
      + volatility * 0.14
      + centrality * 0.12
      + freshness * 0.04
      - noisePenalty
    );

    const score: AttentionScore = {
      structural: Number(structural.toFixed(3)),
      temporal: Number(temporal.toFixed(3)),
      behavioral: Number(behavioral.toFixed(3)),
      failure: Number(failureScore.toFixed(3)),
      volatility: Number(volatility.toFixed(3)),
      freshness: Number(freshness.toFixed(3)),
      centrality: Number(centrality.toFixed(3)),
      confidence: Number(confidence.toFixed(3)),
      composite: Number(composite.toFixed(3)),
    };

    return {
      module: module.name,
      tier: scoreTier(score.composite),
      score,
    } satisfies ModuleAttention;
  }).sort((left, right) => right.score.composite - left.score.composite);

  const moduleByName = new Map(modules.map(module => [module.module, module]));
  const symbols: SymbolAttention[] = Object.entries(structure.symbolToModule)
    .map(([symbol, moduleName]) => {
      const moduleScore = moduleByName.get(moduleName);
      if (!moduleScore) return null;
      const behaviorBoost = normalize(usage.symbolQueries[symbol] ?? 0, behaviorMax) * 0.08;
      const composite = clamp(moduleScore.score.composite + behaviorBoost);
      return {
        symbol,
        module: moduleName,
        tier: scoreTier(composite),
        composite: Number(composite.toFixed(3)),
      } satisfies SymbolAttention;
    })
    .filter((item): item is SymbolAttention => item !== null)
    .sort((left, right) => right.composite - left.composite);

  const activeZones = structure.zones
    .map(zone => {
      const sorted = zone.modules
        .map(moduleName => moduleByName.get(moduleName))
        .filter((item): item is ModuleAttention => item !== undefined)
        .sort((left, right) => right.score.composite - left.score.composite)
        .map(item => item.module)
        .slice(0, 6);
      return { zone: zone.name, modules: sorted };
    })
    .filter(zone => zone.modules.length > 0);

  const snapshot: AttentionSnapshot = {
    generatedAt: new Date().toISOString(),
    modules,
    symbols,
    activeZones,
  };

  const file = attentionFile(projectRoot);
  await Bun.write(file, JSON.stringify(snapshot, null, 2));
  return snapshot;
}

export async function loadAttentionAsync(projectRoot: string): Promise<AttentionSnapshot | null> {
  const file = attentionFile(projectRoot);
  try {
    const bunFile = Bun.file(file);
    if (!(await bunFile.exists())) return null;
    return JSON.parse(await bunFile.text()) as AttentionSnapshot;
  } catch {
    return null;
  }
}

export async function attentionOverviewAsync(projectRoot: string): Promise<AttentionSnapshot | null> {
  return (await loadAttentionAsync(projectRoot)) ?? (await refreshAttentionAsync(projectRoot));
}

export async function attentionScoreAsync(projectRoot: string, target: string): Promise<ModuleAttention | SymbolAttention | null> {
  const snapshot = await attentionOverviewAsync(projectRoot);
  if (!snapshot) return null;
  const exactModule = snapshot.modules.find(module => module.module === target || module.module.includes(target));
  if (exactModule) return exactModule;
  return snapshot.symbols.find(symbol => symbol.symbol === target || symbol.symbol.includes(target)) ?? null;
}

export async function activeZonesAsync(projectRoot: string): Promise<Array<{ zone: string; modules: string[] }>> {
  const snapshot = await attentionOverviewAsync(projectRoot);
  return snapshot?.activeZones ?? [];
}

export async function embeddingPriorityAsync(projectRoot: string, limit = 30): Promise<SymbolAttention[]> {
  const snapshot = await attentionOverviewAsync(projectRoot);
  if (!snapshot) return [];
  const rank = (tier: AttentionTier): number => {
    if (tier === 'CRITICAL') return 4;
    if (tier === 'HIGH') return 3;
    if (tier === 'MEDIUM') return 2;
    if (tier === 'LOW') return 1;
    return 0;
  };
  return [...snapshot.symbols]
    .sort((left, right) => rank(right.tier) - rank(left.tier) || right.composite - left.composite)
    .slice(0, limit);
}

export async function rerankByAttentionAsync(projectRoot: string, results: RetrievedChunk[]): Promise<RetrievedChunk[]> {
  const snapshot = await attentionOverviewAsync(projectRoot);
  if (!snapshot || results.length === 0) return results;

  const symbolScore = new Map(snapshot.symbols.map(item => [item.symbol, item.composite]));
  const moduleScore = new Map(snapshot.modules.map(item => [item.module, item.score.composite]));

  return [...results]
    .map(result => {
      const moduleName = moduleFromFile(result.file);
      const attention = symbolScore.get(result.symbol) ?? moduleScore.get(moduleName) ?? 0;
      return {
        ...result,
        score: result.score + attention * 6,
        rankingSignals: [...(result.rankingSignals ?? []), `attention ${attention.toFixed(2)}`],
      } satisfies RetrievedChunk;
    })
    .sort((left, right) => right.score - left.score);
}
