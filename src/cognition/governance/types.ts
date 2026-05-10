export interface GovernanceEntry {
  id: string;
  kind: 'change' | 'bug' | 'document';
  confidence: number;
  source: string;
  createdAt: string;
  lastValidatedAt: string;
  decayScore: number;
  evidenceRefs: string[];
  contradictions: string[];
}

export interface GovernanceHealth {
  totalEntries: number;
  staleEntries: number;
  contradictedEntries: number;
  averageConfidence: number;
}

export interface GovernanceSnapshot {
  generatedAt: string;
  entries: GovernanceEntry[];
  health: GovernanceHealth;
}
