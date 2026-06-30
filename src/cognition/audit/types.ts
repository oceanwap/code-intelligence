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
