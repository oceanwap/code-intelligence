/**
 * audit/review-pr — Sprint 8 US-001 `review_pr` meta-tool.
 *
 * Fuses six leaves into one merge-decision ToolResult:
 *   1. git_semantic_change_graph(baseRef, headRef)  — changed symbol list
 *   2. audit_symbol(symbol)                         — per changed symbol
 *   3. regression_risk(symbol)                      — per changed symbol
 *   4. composite blast_radius(symbol)               — per changed symbol
 *   5. semantic_duplicates(file)                    — hoisted ONCE (Sprint 6a F7 fix)
 *   6. architecture_drift(root, limit)              — once globally
 *   7. constraint_violations(high)                  — once globally (project-wide)
 *
 * The leaves run in parallel: hoist the cheap, project-wide ones once
 * (graph load + duplicates snapshot + drift + constraint violations) and
 * fan the per-symbol leaves out via `Promise.all`. Wall-time budget:
 * approximately `max(slowest_leaf, per_symbol_fan_out)` — measured against
 * the slowest leaf (smoke: `scripts/smoke-review-pr.ts`).
 *
 * Determinism (PRD FR-7 / no LLM):
 *   - per-symbol rule table:
 *       HOLD   = regression_score >= 0.8 OR constraint_violations_at_symbol >= 1
 *       REVIEW = regression_score >= 0.5 OR blast_radius >= 0.7 OR duplicate_matches >= 2
 *       PASS   = otherwise
 *   - aggregate rule:
 *       BLOCK  = any per-symbol HOLD
 *       REVIEW = any per-symbol REVIEW OR top_blast_radius >= 0.7
 *       PASS   = otherwise
 *   - sort: perSymbol is sorted by `blast_radius desc, regression_score desc,
 *     symbol asc` for deterministic display order.
 *
 * Blackboard write (FR-3) is opt-out via `writeToBlackboard: false`.
 * Default `sessionId` is `review-pr:${baseRef}..${headRef}`.
 *
 * Reason chain (FR-4): leading fact, then per-step facts from each leaf
 * called (per F2 convention). Inherited facts cap at INHERITED_FACTS_CAP.
 */

import * as path from 'node:path';

import { getDataDir } from '../../git.js';
import { loadGraphAsync } from '../../graph.js';
import { buildGitSemanticChangeGraph, type GitSemanticChangeSymbol } from '../../git-change-graph.js';
import { validateGraphPath } from '../../utils/security.js';
import {
  blastRadius as compositeBlastRadius,
  computeGraphMaxima,
} from '../composite/scoring.js';
import { loadSemanticDuplicates, refreshSemanticDuplicatesAsync } from '../duplicates/orchestrator.js';
import { findDuplicatesForTarget } from '../duplicates/signals.js';
import { loadCompositeScoresAsMap } from '../composite/persist.js';
import { architectureDriftAsync } from '../evolution/engine.js';
import { regressionRiskAsync } from '../reflection/engine.js';
import { listConstraintViolationsAsync } from '../constraints/engine.js';
import {
  makeToolResult,
  type ToolResult,
  type Signal,
  type Source,
  type ReasoningFact,
} from '../signalization/types.js';
import { appendScratchpad, readScratchpad } from '../blackboard/scratchpad.js';
import { inheritReasoning } from '../reasoning/bus.js';
import { INHERITED_FACTS_CAP } from './inherited-facts-cap.js';
import { isRecommendEnabled } from '../recommend/post-call.js';
import {
  type ReviewAggregate,
  type ReviewPerSymbol,
  type ReviewPrPayload,
  type ReviewVerdict,
  type MergeDecision,
  type MetaToolOptions,
} from './types.js';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ReviewPrInput {
  projectRoot: string;
  baseRef: string;
  headRef: string;
  topN?: number;
  qdrantUrl?: string;
  writeToBlackboard?: boolean;
  sessionId?: string;
}

const DEFAULT_TOP_N = 10;
const HIGH_REGRESSION_THRESHOLD = 0.8;
const REVIEW_REGRESSION_THRESHOLD = 0.5;
const HIGH_BLAST_RADIUS_THRESHOLD = 0.7;
const REVIEW_DUPLICATE_THRESHOLD = 2;

/**
 * Run the `review_pr` meta-call.
 *
 * Always returns a `ToolResult<ReviewPrPayload>`; never throws on leaf
 * absence (FR-1 / fail-loud, fail-typed). When the change graph is
 * missing, the perSymbol list is empty and the aggregate is a typed
 * empty PASS with a `review_pr.leaf_missing` signal.
 */
export async function reviewPrAsync(input: ReviewPrInput): Promise<ToolResult<ReviewPrPayload>> {
  const { projectRoot, baseRef, headRef } = input;
  const root = path.resolve(projectRoot);
  validateGraphPath(root, 'review_pr');
  const topN = input.topN ?? DEFAULT_TOP_N;
  const qdrantUrl = input.qdrantUrl ?? 'http://localhost:6333';
  const writeToBlackboard = input.writeToBlackboard !== false;
  const sessionId = input.sessionId ?? `review-pr:${baseRef}..${headRef}`;
  void qdrantUrl;

  const signals: Signal[] = [];
  const sources: Source[] = [
    { kind: 'tool', ref: 'review_pr' },
    { kind: 'external', ref: `${baseRef}..${headRef}` },
  ];
  const reasoning: ReasoningFact[] = [];

  // ── Inherit prior facts from the scratchpad (FR-4), capped (B1) ──────
  const priorEntries = await readScratchpad(sessionId, { projectRoot: root });
  const recentEntries = priorEntries.slice(-INHERITED_FACTS_CAP);
  const priorFacts: ReasoningFact[] = [];
  for (const entry of recentEntries) {
    if (Array.isArray(entry.reasoning)) {
      for (const f of entry.reasoning) {
        if (typeof f === 'string' && f.trim()) {
          priorFacts.push({ fact: f });
        }
      }
    }
  }
  reasoning.push(...inheritReasoning(priorFacts));
  const inheritedFacts = reasoning.length;

  // Leading fact.
  reasoning.push({
    fact: `review_pr called for ${baseRef}..${headRef} topN=${topN} inheritedFactsCap=${INHERITED_FACTS_CAP}`,
    source: 'review_pr',
  });

  // ── Once globally: git_semantic_change_graph ──────────────────────────
  const graphFile = path.join(getDataDir(root), 'graph.json');
  const graphForDiff = await loadGraphAsync(graphFile).catch(() => null);
  const changeGraph = await buildGitSemanticChangeGraph(root, graphForDiff, {
    mode: 'range',
    baseRef,
    headRef,
  }).catch((error: Error) => {
    signals.push({ kind: 'review_pr.leaf_error', payload: { leaf: 'git_semantic_change_graph', message: error.message } });
    return null;
  });

  if (!changeGraph) {
    signals.push({ kind: 'review_pr.leaf_missing', payload: { leaf: 'git_semantic_change_graph' } });
    return finalize({
      perSymbol: [],
      baseRef,
      headRef,
      totalChangedSymbols: 0,
      duplicatesAtFiles: 0,
      inheritedFacts,
      reasoning,
      root,
      writeToBlackboard,
      sessionId,
    }, signals, sources, 'AMBIGUOUS');
  }

  reasoning.push({
    fact: `git_semantic_change_graph: ${changeGraph.symbols.length} changed symbol(s); added=${changeGraph.signals.addedSymbols} deleted=${changeGraph.signals.deletedSymbols} modified=${changeGraph.signals.modifiedSymbols}`,
    source: 'git_semantic_change_graph',
  });

  // Filter noise + cap.
  const eligible = changeGraph.symbols.filter((s) => !s.isNoise);
  const top = eligible.slice(0, topN);

  // ── Once globally: graph + maxima + duplicated-snapshot hoist (F7) ───
  const graph = await loadGraphAsync(graphFile).catch(() => null);
  if (!graph) {
    signals.push({ kind: 'review_pr.leaf_missing', payload: { leaf: 'graph' } });
  }
  const maxima = graph ? computeGraphMaxima(graph, null) : null;

  // FIX F7 (Sprint 6a) + PRD B2 memo: load the duplicates snapshot
  // ONCE for the whole diff and again from the mtime-memoized accessor
  // for the composite score map. Bail to `refreshSemanticDuplicatesAsync`
  // when the file is missing — same pattern plan_refactor.ts uses.
  const duplicatesSnapshot = await loadSemanticDuplicates(root)
    .catch(() => null)
    .then(async (snap) => snap ?? await refreshSemanticDuplicatesAsync(root, { withEnrichment: true }).catch(() => null));

  // Pre-warm the composite-scores memo (B2 hits the same Map instance
  // throughout the fan-out). Reading once keeps the per-symbol loop
  // synchronous on the composite lookup.
  const compositeMap = await loadCompositeScoresAsMap({ projectRoot: root }).catch(() => new Map());
  void compositeMap;

  // ── Once globally: architecture_drift ────────────────────────────────
  const drift = await architectureDriftAsync(root, 10).catch((error: Error) => {
    signals.push({ kind: 'review_pr.leaf_error', payload: { leaf: 'architecture_drift', message: error.message } });
    return [];
  });
  reasoning.push({ fact: `architecture_drift: ${drift.length} record(s)`, source: 'architecture_drift' });

  // ── Once globally: constraint_violations (high severity) ─────────────
  const highViolations = await listConstraintViolationsAsync(root, { severity: 'high' }).catch((error: Error) => {
    signals.push({ kind: 'review_pr.leaf_error', payload: { leaf: 'constraint_violations', message: error.message } });
    return [];
  });
  const constraintViolationSymbols = projectWideConstraintTargets(highViolations);
  reasoning.push({
    fact: `constraint_violations(high): ${highViolations.length} record(s) touching ${constraintViolationSymbols.size} symbol target(s)`,
    source: 'constraint_violations',
  });

  // ── Per-symbol scoring (parallel Promise.all) ─────────────────────────
  const perSymbol = await Promise.all(top.map((sym) => scoreSymbol(
    sym,
    root,
    graph,
    maxima,
    duplicatesSnapshot,
    constraintViolationSymbols,
    highViolations.length,
    signals,
    reasoning,
  )));

  // Sort: blast_radius desc, regression_score desc, symbol asc.
  perSymbol.sort(deterministicRank);

  // ── Aggregate verdict ────────────────────────────────────────────────
  const duplicatesAtFiles = countDistinctDuplicateFiles(perSymbol);
  const aggregate = verdictAggregate(perSymbol, changeGraph.symbols.length, duplicatesAtFiles, drift.length, highViolations.length);

  // Reasoning fact for the aggregate.
  reasoning.push({
    fact: `aggregate: ${aggregate.merge_decision} (rule=${aggregate.rule}; hold=${aggregate.hold_count} review=${aggregate.review_count} pass=${aggregate.pass_count} top_blast_radius=${perSymbol[0]?.blast_radius.toFixed(3) ?? '0.000'})`,
    source: 'review_pr',
  });

  const recommendedNext = isRecommendEnabled()
    ? deriveRecommendedNext(aggregate.merge_decision, perSymbol.length, holdCount(perSymbol))
    : [];

  return finalize({
    perSymbol,
    baseRef,
    headRef,
    totalChangedSymbols: changeGraph.symbols.length,
    duplicatesAtFiles,
    aggregate,
    recommendedNext,
    inheritedFacts,
    reasoning,
    root,
    writeToBlackboard,
    sessionId,
  }, signals, sources, inferTier(aggregate.merge_decision));
}

// ---------------------------------------------------------------------------
// Per-symbol scoring
// ---------------------------------------------------------------------------

async function scoreSymbol(
  sym: GitSemanticChangeSymbol,
  root: string,
  graph: Awaited<ReturnType<typeof loadGraphAsync>>,
  maxima: ReturnType<typeof computeGraphMaxima> | null,
  duplicatesSnapshot: Awaited<ReturnType<typeof loadSemanticDuplicates>>,
  constraintViolationSymbols: Set<string>,
  constraintViolationsHigh: number,
  signals: Signal[],
  reasoning: ReasoningFact[],
): Promise<ReviewPerSymbol> {
  const why: string[] = [];

  // regression_risk — direct numeric [0,1] score for the rule table.
  const regression = await regressionRiskAsync(root, sym.symbol).catch((error: Error) => {
    signals.push({
      kind: 'review_pr.leaf_error',
      payload: { leaf: 'regression_risk', symbol: sym.symbol, message: error.message },
    });
    return null;
  });
  const regressionScore = clamp01(regression?.score ?? 0);
  if (regression) {
    reasoning.push({
      fact: `regression_risk: ${sym.symbol} score=${regressionScore.toFixed(3)} level=${regression.level}`,
      source: 'regression_risk',
    });
  } else {
    why.push('regression_risk unavailable; defaulting to 0');
  }

  // composite blast_radius.
  let blastScore = 0;
  if (graph && maxima) {
    const result = compositeBlastRadius(sym.symbol, { graph, memory: null, maxima });
    blastScore = clamp01(result.score);
    reasoning.push({
      fact: `blast_radius: ${sym.symbol} score=${blastScore.toFixed(3)} inbound=${result.breakdown.inbound} outbound=${result.breakdown.outbound}`,
      source: 'composite',
    });
  } else {
    why.push('blast_radius=0 (graph not indexed)');
  }

  // semantic_duplicates against the touched file — uses hoisted snapshot.
  const duplicateMatches = countDuplicatesForFile(duplicatesSnapshot, sym.file);
  if (duplicateMatches > 0) {
    why.push(`${duplicateMatches} duplicate pattern(s) on ${sym.file}`);
  }

  // side effects from graph.
  const sideEffectCount = graph?.sideEffects?.[sym.symbol]?.length ?? 0;
  if (sideEffectCount > 0) {
    why.push(`${sideEffectCount} recorded side effect(s)`);
  }

  // project-wide constraint violation targets this symbol?
  const constraintHit = constraintViolationSymbols.has(sym.symbol) || constraintViolationSymbols.has(sym.file);
  if (constraintHit) {
    why.push(`project constraint violation (high severity, ${constraintViolationsHigh} active)`);
  }

  // Apply per-symbol rule.
  const verdict = verdictPerSymbol(regressionScore, blastScore, duplicateMatches, constraintHit);
  if (verdict === 'HOLD') {
    why.push(`HOLD trigger(s) met`);
  } else if (verdict === 'REVIEW') {
    why.push(`REVIEW trigger(s) met`);
  } else {
    why.push('no triggers met');
  }

  // Confidence — deterministic blend of the same fields the verdict used.
  const confidence = clamp01(0.5 * regressionScore + 0.5 * (duplicateMatches >= 2 ? 1 : blastScore));
  why.push(`confidence=${confidence.toFixed(3)}`);

  return {
    symbol: sym.symbol,
    file: sym.file,
    verdict,
    confidence,
    blast_radius: blastScore,
    regression_score: regressionScore,
    duplicate_matches: duplicateMatches,
    side_effect_count: sideEffectCount,
    why,
  };
}

function countDuplicatesForFile(
  snapshot: Awaited<ReturnType<typeof loadSemanticDuplicates>>,
  file: string,
): number {
  if (!snapshot) return 0;
  try {
    return findDuplicatesForTarget(snapshot, file).length;
  } catch {
    return 0;
  }
}

/**
 * Project-wide high-severity constraint violations are surfaced as a
 * union of (a) symbols whose module is in the violation's `modules[]`,
 * and (b) files whose module is in the violation's `modules[]`. The
 * per-symbol rule checks BOTH the symbol and the file name.
 *
 * Why both: constraint violations describe modules, not individual
 * symbols — a single bad module-level coupling can HOLD every symbol
 * in that module. The SymbolHotspot lookup in audit_symbol would only
 * find the most-referenced symbol; we over-flag via `modules[]`.
 */
function projectWideConstraintTargets(violations: Array<{ modules: string[] }>): Set<string> {
  const targets = new Set<string>();
  for (const v of violations) {
    for (const m of v.modules ?? []) {
      targets.add(m);
    }
  }
  return targets;
}

function countDistinctDuplicateFiles(perSymbol: ReviewPerSymbol[]): number {
  const files = new Set<string>();
  for (const row of perSymbol) {
    if (row.duplicate_matches > 0) files.add(row.file);
  }
  return files.size;
}

function holdCount(perSymbol: ReviewPerSymbol[]): number {
  return perSymbol.filter((r) => r.verdict === 'HOLD').length;
}

// ---------------------------------------------------------------------------
// Deterministic rule tables — exported for the test surface
// ---------------------------------------------------------------------------

/**
 * Per-symbol rule. Documented in the module header. Order matters:
 * the first matching trigger wins so the truthiness chain is stable.
 */
export function verdictPerSymbol(
  regressionScore: number,
  blastRadius: number,
  duplicateMatches: number,
  constraintViolation: boolean,
): ReviewVerdict {
  if (regressionScore >= HIGH_REGRESSION_THRESHOLD || constraintViolation) return 'HOLD';
  if (
    regressionScore >= REVIEW_REGRESSION_THRESHOLD
    || blastRadius >= HIGH_BLAST_RADIUS_THRESHOLD
    || duplicateMatches >= REVIEW_DUPLICATE_THRESHOLD
  ) return 'REVIEW';
  return 'PASS';
}

/**
 * Aggregate rule. The `rule` field is the FIRST violated rule — the
 * order is HOLD → top-blast-radius REVIEW → per-symbol REVIEW → PASS.
 */
export function verdictAggregate(
  perSymbol: ReviewPerSymbol[],
  totalChangedSymbols: number,
  duplicatesAtFiles: number,
  architectureDriftRecords: number,
  constraintViolationsHigh: number,
): ReviewAggregate {
  let hold_count = 0;
  let review_count = 0;
  let pass_count = 0;
  for (const r of perSymbol) {
    if (r.verdict === 'HOLD') hold_count++;
    else if (r.verdict === 'REVIEW') review_count++;
    else pass_count++;
  }
  const topBlast = perSymbol[0]?.blast_radius ?? 0;

  let merge_decision: MergeDecision;
  let rule: string;
  if (hold_count > 0) {
    merge_decision = 'BLOCK';
    rule = 'per_symbol_hold_present';
  } else if (review_count > 0) {
    merge_decision = 'REVIEW';
    rule = 'per_symbol_review_present';
  } else if (topBlast >= HIGH_BLAST_RADIUS_THRESHOLD) {
    merge_decision = 'REVIEW';
    rule = 'top_blast_radius_review';
  } else {
    merge_decision = 'PASS';
    rule = 'all_clear';
  }

  return {
    merge_decision,
    rule,
    hold_count,
    review_count,
    pass_count,
    total_changed_symbols: totalChangedSymbols,
    duplicates_at_files: duplicatesAtFiles,
    architecture_drift_records: architectureDriftRecords,
    constraint_violations_high: constraintViolationsHigh,
  };
}

// ---------------------------------------------------------------------------
// Deterministic rank — perSymbol sorted by blast_radius desc, then
// regression_score desc, then symbol asc.
// ---------------------------------------------------------------------------

function deterministicRank(a: ReviewPerSymbol, b: ReviewPerSymbol): number {
  if (a.blast_radius !== b.blast_radius) return b.blast_radius - a.blast_radius;
  if (a.regression_score !== b.regression_score) return b.regression_score - a.regression_score;
  return a.symbol.localeCompare(b.symbol);
}

// ---------------------------------------------------------------------------
// Recommended-next (env-gated via the existing hook)
// ---------------------------------------------------------------------------

function deriveRecommendedNext(decision: MergeDecision, _perSymbolCount: number, hold: number): string[] {
  const lines: string[] = [];
  if (decision === 'BLOCK') {
    lines.push(`Address ${hold} HOLD verdict(s) before merging — open the per-symbol why[] for trigger detail.`);
    lines.push(`Run audit_symbol on each HOLD symbol to capture a regression test plan.`);
  } else if (decision === 'REVIEW') {
    lines.push(`Walk the perSymbol review list and confirm each symbol\'s why[] before approving.`);
    lines.push(`plan_refactor for the same diff produces intervention-ranked steps if you want to plan a remediation pass.`);
  } else {
    lines.push(`No review-blocking triggers detected — proceed with normal review.`);
  }
  return lines;
}

function inferTier(decision: MergeDecision): ToolResult['confidence_tier'] {
  return decision === 'PASS' ? 'EXTRACTED' : decision === 'REVIEW' ? 'INFERRED' : 'EXTRACTED';
}

// ---------------------------------------------------------------------------
// Finalize + blackboard
// ---------------------------------------------------------------------------

interface FinalizeOpts {
  perSymbol: ReviewPerSymbol[];
  baseRef: string;
  headRef: string;
  totalChangedSymbols: number;
  duplicatesAtFiles: number;
  aggregate?: ReviewAggregate;
  recommendedNext?: string[];
  inheritedFacts: number;
  reasoning: ReasoningFact[];
  root: string;
  writeToBlackboard: boolean;
  sessionId: string;
}

async function finalize(
  opts: FinalizeOpts,
  signals: Signal[],
  sources: Source[],
  tier: ToolResult['confidence_tier'],
): Promise<ToolResult<ReviewPrPayload>> {
  const aggregate: ReviewAggregate = opts.aggregate ?? {
    merge_decision: 'PASS',
    rule: 'empty_diff',
    hold_count: 0,
    review_count: 0,
    pass_count: 0,
    total_changed_symbols: 0,
    duplicates_at_files: 0,
    architecture_drift_records: 0,
    constraint_violations_high: 0,
  };

  const data: ReviewPrPayload = {
    baseRef: opts.baseRef,
    headRef: opts.headRef,
    perSymbol: opts.perSymbol,
    aggregate,
    recommended_next: opts.recommendedNext ?? [],
    reasoning_chain: opts.reasoning,
  };

  const result = makeToolResult<ReviewPrPayload>(data, {
    signals,
    sources,
    reasoning: opts.reasoning,
    confidence_tier: tier,
  });

  if (opts.writeToBlackboard) {
    await appendScratchpad(opts.sessionId, {
      ts: new Date().toISOString(),
      tool: 'review_pr',
      data: result.data,
      reasoning: result.reasoning.map((f) => f.fact),
      confidence_tier: result.confidence_tier,
      sessionId: opts.sessionId,
    }, { projectRoot: opts.root });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ---------------------------------------------------------------------------
// Re-exports for the test surface
// ---------------------------------------------------------------------------

export {
  verdictPerSymbol as _verdictPerSymbol,
  verdictAggregate as _verdictAggregate,
  deterministicRank as _deterministicRank,
};

export type _ReviewPrInput = ReviewPrInput;
export type _MetaToolOptions = MetaToolOptions;
