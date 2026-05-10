export type FailureClusterKey =
  | 'dependency_pattern'
  | 'architectural_weakness'
  | 'module_instability'
  | 'async_concurrency'
  | 'dto_leakage'
  | 'caching_issues'
  | 'state_synchronization';

export interface FailureRecord {
  id: string;
  sourceBugId: string;
  fixedBySha: string;
  title: string;
  summary: string;
  timestamp: string;
  symptoms: string[];
  rootCauses: string[];
  triggerConditions: string[];
  affectedBoundaries: string[];
  relatedFailures: string[];
  preventivePatterns: string[];
  files: string[];
  symbols: string[];
  topics: string[];
  clusterKeys: FailureClusterKey[];
}

export interface FailureCluster {
  key: FailureClusterKey;
  label: string;
  count: number;
  failures: Array<{ id: string; title: string; fixedBySha: string; timestamp: string }>;
}

export interface FailureIntelligenceSnapshot {
  generatedAt: string;
  totalFailures: number;
  records: FailureRecord[];
  clusters: FailureCluster[];
}
