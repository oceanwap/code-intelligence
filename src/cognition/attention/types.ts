export type AttentionTier = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'DORMANT';

export interface AttentionScore {
  structural: number;
  temporal: number;
  behavioral: number;
  failure: number;
  volatility: number;
  freshness: number;
  centrality: number;
  confidence: number;
  composite: number;
}

export interface ModuleAttention {
  module: string;
  tier: AttentionTier;
  score: AttentionScore;
}

export interface SymbolAttention {
  symbol: string;
  module: string;
  tier: AttentionTier;
  composite: number;
}

export interface AttentionSnapshot {
  generatedAt: string;
  modules: ModuleAttention[];
  symbols: SymbolAttention[];
  activeZones: Array<{ zone: string; modules: string[] }>;
}

export interface AttentionUsage {
  updatedAt: string;
  symbolQueries: Record<string, number>;
  moduleQueries: Record<string, number>;
  toolCalls: Record<string, number>;
}
