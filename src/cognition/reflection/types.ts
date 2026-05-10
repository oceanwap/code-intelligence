export interface ReflectionEntry {
  changeId: string;
  summary: string;
  affectedModules: string[];
  couplingDelta: number;
  riskLevel: 'low' | 'medium' | 'high';
  architectureViolations: string[];
  historicalSimilarity: string[];
  confidence: number;
  createdAt: string;
}

export interface RegressionRiskReport {
  target: string;
  score: number;
  level: 'low' | 'medium' | 'high';
  signals: string[];
  unstableModules: Array<{ module: string; instability: number }>;
  recentFailures: Array<{ id: string; title: string; score: number }>;
}
