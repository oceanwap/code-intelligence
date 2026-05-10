export type ConstraintSeverity = 'low' | 'medium' | 'high';

export interface ConstraintRule {
  rule: string;
  severity: ConstraintSeverity;
  description: string;
}

export interface ConstraintViolation {
  rule: string;
  severity: ConstraintSeverity;
  details: string;
  modules: string[];
}

export interface ConstraintSnapshot {
  generatedAt: string;
  rules: ConstraintRule[];
  violations: ConstraintViolation[];
}
