export type DuplicateSeverity = 'low' | 'medium' | 'high';
export type DuplicateSource = 'ts-morph' | 'ast-grep' | 'semgrep' | 'madge' | 'codeql';

export interface DuplicateLocation {
  file: string;
  line: number;
  column: number;
  symbol: string;
  module: string;
}

export interface DuplicateSignals {
  crossModule: boolean;
  crossLayer: boolean;
  inHotspot: boolean;
  inUnstableModule: boolean;
  churnScore: number;
  attentionScore: number;
  bugCount: number;
}

export interface SemanticDuplicatePattern {
  /** Stable id for the pattern. */
  id: string;
  /** Human-readable category. */
  category: string;
  /** Short title. */
  title: string;
  /** Longer explanation of why this is a duplicate / anti-pattern. */
  description: string;
  /** How severe the finding is. */
  severity: DuplicateSeverity;
  /** Which analyzer produced it. */
  source: DuplicateSource;
  /** Analyzer-specific rule id (e.g. ast-grep rule id). */
  ruleId?: string;
  /** All locations that participate in the pattern. */
  locations: DuplicateLocation[];
  /** Modules touched by this pattern (computed by signal enrichment). */
  affectedModules?: string[];
  /** Files touched by this pattern (computed by signal enrichment). */
  affectedFiles?: string[];
  /** Cross-layer / hotspot / instability signals (computed by enrichment). */
  signals?: DuplicateSignals;
  /** Actionable recommendation (computed by enrichment). */
  recommendation?: string;
  /** Extra metadata from the analyzer. */
  meta?: Record<string, unknown>;
}

export interface SemanticDuplicateSnapshot {
  generatedAt: string;
  projectRoot: string;
  totalPatterns: number;
  bySource: Record<DuplicateSource, number>;
  bySeverity: Record<DuplicateSeverity, number>;
  patterns: SemanticDuplicatePattern[];
}

export interface ExternalToolResult {
  tool: DuplicateSource;
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  patterns: SemanticDuplicatePattern[];
}

export interface SemanticDuplicateOptions {
  /** Minimum number of occurrences for a structural duplicate to be reported. */
  minOccurrences?: number;
  /** Minimum token count for a function/method body to be considered. */
  minBodyTokens?: number;
  /** Max body token count; huge functions are usually not interesting duplicates. */
  maxBodyTokens?: number;
  /** Include test files. */
  includeTests?: boolean;
  /** Only scan files matching these globs. */
  includeGlobs?: string[];
  /** Skip files matching these globs. */
  excludeGlobs?: string[];
}
