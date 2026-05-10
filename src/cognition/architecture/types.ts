export interface ArchitectureModule {
  name: string;
  files: number;
  symbols: number;
  inbound: number;
  outbound: number;
  zone: string;
}

export interface ArchitectureDependency {
  from: string;
  to: string;
  calls: number;
  imports: number;
  weight: number;
}

export interface ArchitectureZone {
  name: string;
  modules: string[];
}

export interface ArchitectureSnapshot {
  generatedAt: string;
  modules: ArchitectureModule[];
  dependencies: ArchitectureDependency[];
  coupling: Record<string, number>;
  instability: Record<string, number>;
  zones: ArchitectureZone[];
}

export interface DependencyPathResult {
  from: string;
  to: string;
  path: string[];
  totalWeight: number;
}
