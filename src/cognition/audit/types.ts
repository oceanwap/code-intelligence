/**
 * audit/types — payload contracts for the Layer 3 superpowered tools (US-004).
 *
 * These types describe the shape of the `data` field inside the
 * `ToolResult<T>` envelope that `audit_symbol` and `plan_refactor` emit.
 * They are intentionally narrow: every field is something a deterministic
 * heuristic (no LLM) can populate from the existing leaf outputs.
 *
 * Mapping to existing US-001 / US-003 types:
 *   - `Behavior`     ←  `SideEffect[]` from `render_behavior` (behavior-graph.ts)
 *   - `RiskHotspot`  ←  `SymbolHotspot` from `risk_hotspots` (engineering-insights.ts)
 *   - `ImpactReport` ←  `AffectedSymbolsResult` from `analyze_impact` (engineering-insights.ts)
 *   - `DuplicateMatch` ←  subset of `SemanticDuplicatePattern` (duplicates/types.ts)
 *   - `BlastRadiusBreakdown` ←  `composite/scoring.ts` (US-003)
 *
 * We re-export the existing types under friendly aliases so the audit module
 * never invents a new shape — the audit payload is structurally the same as
 * the leaves it fuses.
 */
import type { SideEffect } from '../../behavior-graph.js';
import type {
  AffectedSymbolsResult,
  SymbolHotspot,
} from '../../engineering-insights.js';
import type { BlastRadiusBreakdown } from '../composite/scoring.js';
import type { GitSemanticChangeSymbol } from '../../git-change-graph.js';

// ---------------------------------------------------------------------------
// audit_symbol
// ---------------------------------------------------------------------------

/** Side-effect list surfaced by `render_behavior` for the target symbol. */
export type Behavior = SideEffect[];

/**
 * Risk hotspot for the target symbol.
 *
 * `null` when the symbol is not present in the risk-hotspots ranking (rare;
 * usually happens for a freshly added symbol before the next index run).
 * `SymbolHotspot` already carries `blastRadius` and `blastRadiusBreakdown`
 * when composite scoring is available (US-003 P2 free upgrade).
 */
export type RiskHotspot = SymbolHotspot | null;

/** Affected-symbols result from `analyze_impact`. */
export type ImpactReport = AffectedSymbolsResult;

/**
 * Slim view of a `SemanticDuplicatePattern` so the audit payload does not
 * inherit the analyzer's full output. The full pattern is still available
 * via `id` against `semantic_duplicates`.
 */
export interface DuplicateMatch {
  id: string;
  title: string;
  category: string;
  severity: 'low' | 'medium' | 'high';
  source: string;
  files: string[];
  description: string;
  recommendation?: string;
}

/** Free-form rationale line from `query_project_memory`. */
export interface RationaleEntry {
  id: string;
  text: string;
  score: number;
  topics: string[];
}

/** Normalized blast-radius {0..1} plus the typed feature breakdown. */
export interface BlastRadius {
  score: number;
  breakdown: BlastRadiusBreakdown;
}

/**
 * `audit_symbol` payload — the 8 fused fields required by US-004.
 *
 * Every field is REQUIRED in the output. When a leaf is unavailable (e.g.
 * the project has not been indexed yet) the corresponding field holds a
 * typed "empty" value (empty array, score 0, etc.) and a `Signal` is
 * appended to the ToolResult envelope explaining the gap. This is FR-1's
 * "fail loud, fail typed" rule: never silently drop a leaf.
 */
export interface AuditSymbolPayload {
  /** Side-effect checklist (`render_behavior`). */
  behavior: Behavior;
  /** Risk hotspot for the symbol (`risk_hotspots`). */
  risk: RiskHotspot;
  /** Call-graph blast footprint (`analyze_impact`). */
  impact: ImpactReport;
  /** Duplicate patterns touching the symbol's file or symbol. */
  dups: DuplicateMatch[];
  /** Rationale lines from project memory (`query_project_memory`). */
  rationale: RationaleEntry[];
  /** Composite blast-radius score + breakdown (US-003 `blastRadius`). */
  blast_radius: BlastRadius;
  /** Deterministic recommendation string (rule table, no LLM). */
  action_recommendation: string;
  /** Reasoning chain (populated by `inheritReasoning` from the bus). */
  reasoning_chain: import('../signalization/types.js').ReasoningFact[];
}

// ---------------------------------------------------------------------------
// plan_refactor
// ---------------------------------------------------------------------------

/**
 * One intervention step in a refactor plan.
 *
 * Ranked deterministically:
 *   1. `confidence`  desc
 *   2. `blast_radius` desc
 *   3. `reversible` desc (true before false)
 *   4. `symbol`      asc
 */
export interface InterventionStep {
  /** Exact symbol name (or path for file-level steps). */
  symbol: string;
  /** Files this intervention touches. */
  files: string[];
  /** Confidence in [0,1]. */
  confidence: number;
  /** Whether the change is purely additive / non-breaking. */
  reversible: boolean;
  /** Composite blast radius in [0,1] for the symbol. */
  blast_radius: number;
  /** "Why" lines — explanations for why this step is in the plan. */
  why: string[];
  /** Underlying change classification (added / modified / deleted). */
  changeKind: GitSemanticChangeSymbol['kind'];
  /** Whether the signature changed (relevant for reversibility). */
  signatureChanged: boolean;
  /** Rename or move info, if any. */
  renameFrom?: string;
  moveFromFile?: string;
}

/**
 * `plan_refactor` payload.
 *
 * `interventions` is sorted by the deterministic rule above. `summary` is a
 * one-line human summary produced by the same heuristic. `reasoning_chain`
 * is propagated from the leaves `plan_refactor` called.
 */
export interface PlanRefactorPayload {
  interventions: InterventionStep[];
  reasoning_chain: import('../signalization/types.js').ReasoningFact[];
  summary: string;
  /** Changed symbol count returned by `git_semantic_change_graph`. */
  totalChangedSymbols: number;
  /** Blast-radius distribution buckets (low / medium / high). */
  blastRadiusDistribution: { low: number; medium: number; high: number };
  /** Reversibility ratio: count(reversible=true) / count(interventions). */
  reversibilityRatio: number;
  /** Base / head refs the plan was computed against. */
  baseRef: string;
  headRef: string;
}

// ---------------------------------------------------------------------------
// review_pr (Sprint 8 US-001)
// ---------------------------------------------------------------------------

/**
 * Per-symbol verdict from the deterministic rule table. No LLM —
 * a heuristic rule (regression score + blast radius + duplicate matches +
 * project-wide constraint violations) maps each changed symbol to one
 * of these three outcomes.
 *
 *   HOLD   — at least one trigger is met (regression_score >= 0.8 OR
 *            a project-wide high-severity constraint violation triggers
 *            for this symbol). Stop and fix before merging.
 *   REVIEW — at least one risk trigger is met (regression_score >= 0.5 OR
 *            blast_radius >= 0.7 OR duplicate_matches >= 2). Worth a human
 *            look before merging; the change may be reversible.
 *   PASS   — no triggers met. Proceed.
 *
 * The rule table is documented in `audit/review-pr.ts`.
 */
export type ReviewVerdict = 'HOLD' | 'REVIEW' | 'PASS';

/**
 * Aggregate decision across the whole PR diff.
 *
 *   BLOCK  — at least one per-symbol verdict is HOLD. Do NOT merge.
 *   REVIEW — at least one per-symbol verdict is REVIEW OR the top per-symbol
 *            blast_radius is >= 0.7. Worth a human pass.
 *   PASS   — every per-symbol verdict is PASS and top blast_radius < 0.7.
 *
 * Mirrors `ReviewVerdict` but at the diff level. The mapping is encoded
 * in `verdictAggregate` in `audit/review-pr.ts`.
 */
export type MergeDecision = 'PASS' | 'REVIEW' | 'BLOCK';

/**
 * One row of `ReviewPrPayload.perSymbol`. The deterministic rule table
 * (`verdictPerSymbol` in audit/review-pr.ts) populates `verdict` + the
 * trigger counts from a row of per-symbol leaves; `confidence` is derived
 * from those triggers and `blast_radius`.
 */
export interface ReviewPerSymbol {
  symbol: string;
  file: string;
  verdict: ReviewVerdict;
  /** Confidence in [0,1]. */
  confidence: number;
  /** Per-symbol blast radius in [0,1]. */
  blast_radius: number;
  /** Per-symbol regression risk score in [0,1]. */
  regression_score: number;
  /** Count of duplicate patterns that touch the symbol's file. */
  duplicate_matches: number;
  /** Number of side effects recorded for the symbol (from graph). */
  side_effect_count: number;
  /** 1-3 short facts that drove the verdict. */
  why: string[];
}

/**
 * Aggregate verdict for the whole diff plus the counts that drove it.
 *
 * `rule` is the name of the first violated rule that drove the decision —
 * a stable identifier so callers can branch on the violation type without
 * re-reading the count fields. Examples:
 *   - `per_symbol_hold_present`       — at least one per-symbol HOLD
 *   - `per_symbol_review_present`     — at least one per-symbol REVIEW
 *   - `top_blast_radius_review`       — top blast_radius >= 0.7
 *   - `all_clear`                     — all-clear PASS
 */
export interface ReviewAggregate {
  merge_decision: MergeDecision;
  rule: string;
  hold_count: number;
  review_count: number;
  pass_count: number;
  total_changed_symbols: number;
  /** Distinct files touched by symbols that have at least one duplicate pattern. */
  duplicates_at_files: number;
  /** Number of architecture-drift records at the time of the call. */
  architecture_drift_records: number;
  /** Number of project-wide HIGH-severity constraint violations. */
  constraint_violations_high: number;
}

/**
 * `review_pr` payload — fuses git_semantic_change_graph + per-symbol
 * audit_symbol + semantic_duplicates + architecture_drift + constraint
 * violations (high severity) + composite blast radius into one
 * merge-decision surface.
 */
export interface ReviewPrPayload {
  baseRef: string;
  headRef: string;
  perSymbol: ReviewPerSymbol[];
  aggregate: ReviewAggregate;
  /**
   * Recommended next steps, derived from the rule table + the existing
   * recommend hook (`CODE_INTEL_RECOMMEND=1` opt-in). When the env flag
   * is off, the array is empty and the meta-tool's output is byte-equal
   * to a non-recommend run (FR-11 backward compat).
   */
  recommended_next: string[];
  /** Reasoning chain (FR-4) — leaf facts appended in call order. */
  reasoning_chain: import('../signalization/types.js').ReasoningFact[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Shared options for both meta-tools. */
export interface MetaToolOptions {
  /** Qdrant URL forwarded to leaves that need it. */
  qdrantUrl?: string;
  /** Skip writing to the per-session blackboard. */
  writeToBlackboard?: boolean;
  /** Explicit session id; otherwise derived deterministically. */
  sessionId?: string;
}
