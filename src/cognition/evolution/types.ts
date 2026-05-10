export interface EvolutionPoint {
  at: string;
  instability: number;
  coupling: number;
  bugs: number;
  churn: number;
  risk: number;
}

export interface ModuleEvolution {
  module: string;
  instabilityTrend: EvolutionPoint[];
  couplingTrend: EvolutionPoint[];
  bugTrend: EvolutionPoint[];
  riskScore: number;
}

export interface ArchitectureDriftRecord {
  module: string;
  instabilityDelta: number;
  couplingDelta: number;
  riskDelta: number;
}

export interface EvolutionHotspot {
  module: string;
  riskScore: number;
  churn: number;
  bugs: number;
  instability: number;
  coupling: number;
}

export interface EvolutionSnapshot {
  generatedAt: string;
  modules: ModuleEvolution[];
  drift: ArchitectureDriftRecord[];
  hotspots: EvolutionHotspot[];
}
