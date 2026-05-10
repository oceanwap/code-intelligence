export interface StructureModule {
  name: string;
  files: number;
  symbols: number;
  inbound: number;
  outbound: number;
  centrality: number;
  zone: string;
}

export interface StructureDependency {
  from: string;
  to: string;
  weight: number;
}

export interface StructureCycle {
  path: string[];
}

export interface StructureSnapshot {
  generatedAt: string;
  modules: StructureModule[];
  dependencies: StructureDependency[];
  zones: Array<{ name: string; modules: string[] }>;
  cycles: StructureCycle[];
  symbolToModule: Record<string, string>;
}
