/**
 * audit/plan-refactor — US-004 P3a `plan_refactor` meta-tool.
 *
 * Given a `baseRef` and `headRef`, builds a ranked list of intervention
 * steps. Each step carries:
 *   - `confidence`    (deterministic blend of risk + blast radius)
 *   - `reversible`    (true iff change is purely additive)
 *   - `blast_radius`  (composite blast radius for the symbol)
 *   - `why`           (readable explanations for ranking)
 *
 * Determinism (FR-7 / rank table):
 *   1. confidence   desc
 *   2. blast_radius desc
 *   3. reversible   desc  (true before false)
 *   4. symbol       asc
 *
 * Leaves called:
 *   - `git_semantic_change_graph(baseRef, headRef)`   — changed symbol list
 *   - `regression_risk(symbol)`                       — per changed symbol
 *   - `render_behavior(symbol)`                       — per changed symbol
 *   - `semantic_duplicates(target=file)`              — per touched file
 *   - `architecture_drift(projectRoot, limit)`        — once globally
 *
 * No LLM. The `confidence` formula is:
 *
 *   confidence = 0.5 * (1 - normalizedRegressionRisk)
 *              + 0.5 * compositeScore.blastRadius
 *
 * where `normalizedRegressionRisk` is the regression-risk score in [0,1]
 * (defaulting to 0.5 when the leaf is unavailable), and `blastRadius` is the
 * composite-score blast radius in [0,1] (defaulting to 0 when the symbol is
 * missing from the graph).
 *
 * `reversible` is true iff:
 *   - `kind === 'added'`, OR
 *   - `kind === 'modified'` AND
 *     - `!signatureChanged`
 *     - `!probableRenameFrom` AND `!probableMoveFromFile`
 *
 * All other changes (deleted, renamed, moved, signature-changed) are
 * non-reversible — they alter the public surface.
 *
 * Blackboard write (FR-3) is opt-out via `writeToBlackboard: false`.
 * Default sessionId is `plan-refactor:${baseRef}..${headRef}`.
 */

import * as path from 'node:path';

import { getDataDir } from '../../git.js';
import { buildGitSemanticChangeGraph, type GitSemanticChangeSymbol } from '../../git-change-graph.js';
import { loadGraphAsync } from '../../graph.js';
import {
  blastRadius as compositeBlastRadius,
  computeGraphMaxima,
} from '../composite/persist.js';
import { regressionRiskAsync } from '../reflection/engine.js';
import { loadSemanticDuplicates, refreshSemanticDuplicatesAsync } from '../duplicates/orchestrator.js';
import { findDuplicatesForTarget } from '../duplicates/signals.js';
import { architectureDriftAsync } from '../evolution/engine.js';
import { appendScratchpad } from '../blackboard/scratchpad.js';
import {
  makeToolResult,
  type ToolResult,
  type Signal,
  type Source,
  type ReasoningFact,
} from '../signalization/types.js';
import { validateGraphPath } from '../../utils/security.js';
import {
  type InterventionStep,
  type PlanRefactorPayload,
  type MetaToolOptions,
} from './types.js';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface PlanRefactorInput {
  projectRoot: string;
  baseRef: string;
  headRef: string;
  topN?: number;
  qdrantUrl?: string;
  writeToBlackboard?: boolean;
  sessionId?: string;
}

const DEFAULT_TOP_N = 10;
const HIGH_CONFIDENCE_THRESHOLD = 0.65;

export async function planRefactorAsync(input: PlanRefactorInput): Promise<ToolResult<PlanRefactorPayload>> {
  const { projectRoot, baseRef, headRef } = input;
  const root = path.resolve(projectRoot);
  validateGraphPath(root, 'plan_refactor');
  const topN = input.topN ?? DEFAULT_TOP_N;
  const qdrantUrl = input.qdrantUrl ?? 'http://localhost:6333';
  const writeToBlackboard = input.writeToBlackboard !== false;
  const sessionId = input.sessionId ?? `plan-refactor:${baseRef}..${headRef}`;

  const signals: Signal[] = [];
  const sources: Source[] = [
    { kind: 'tool', ref: 'plan_refactor' },
    { kind: 'external', ref: `${baseRef}..${headRef}` },
  ];
  const reasoning: ReasoningFact[] = [
    { fact: `plan_refactor called for ${baseRef}..${headRef}`, source: 'plan_refactor' },
  ];

  // 1. Build the change graph.
  const graphForDiff = await loadGraphAsync(path.join(getDataDir(root), 'graph.json')).catch(() => null);
  const changeGraph = await buildGitSemanticChangeGraph(root, graphForDiff, {
    mode: 'range',
    baseRef,
    headRef,
  }).catch((error: Error) => {
    signals.push({ kind: 'plan_refactor.leaf_error', payload: { leaf: 'git_semantic_change_graph', message: error.message } });
    return null;
  });

  if (!changeGraph) {
    return finalize([], reasoning, signals, sources, {
      baseRef,
      headRef,
      totalChangedSymbols: 0,
      sessionId,
      root,
      writeToBlackboard,
    });
  }

  reasoning.push({
    fact: `git_semantic_change_graph: ${changeGraph.symbols.length} changed symbol(s); added=${changeGraph.signals.addedSymbols} deleted=${changeGraph.signals.deletedSymbols} modified=${changeGraph.signals.modifiedSymbols}`,
    source: 'git_semantic_change_graph',
  });

  // 2. Filter noise + sort by signatureChanged desc, rename/move, etc.
  const eligible = changeGraph.symbols.filter(s => !s.isNoise);
  const top = eligible.slice(0, topN);

  // 3. Load the graph once for blast-radius computation.
  const graph = await loadGraphAsync(path.join(getDataDir(root), 'graph.json')).catch(() => null);
  if (!graph) {
    signals.push({ kind: 'plan_refactor.leaf_missing', payload: { leaf: 'graph' } });
  }
  const maxima = graph ? computeGraphMaxima(graph, null) : null;

  // 3b. Load the semantic-duplicates snapshot ONCE for the whole diff.
  // FIX F7: previously this load happened inside `readDuplicatesForFile`
  // which runs inside `scoreSymbol` inside a per-symbol Promise.all —
  // so a 10-symbol diff triggered up to 10 full Qdrant scans on a
  // fresh project. We hoist it next to the graph/maxima hoist above
  // (see lines above) and pass the resolved snapshot into scoreSymbol.
  const duplicatesSnapshot = await loadSemanticDuplicates(root)
    .catch(() => null)
    .then(async (snap) => snap ?? await refreshSemanticDuplicatesAsync(root, { withEnrichment: true }).catch(() => null));

  // 4. For each changed symbol, run regression_risk + render_behavior +
  //    semantic_duplicates (against the file). These can be parallel per
  //    symbol.
  const perSymbolScores = await Promise.all(top.map(async (sym) => {
    return scoreSymbol(sym, root, graph, maxima, duplicatesSnapshot, qdrantUrl, signals, reasoning);
  }));

  // 5. Architecture drift — called once globally.
  const drift = await architectureDriftAsync(root, 10).catch((error: Error) => {
    signals.push({ kind: 'plan_refactor.leaf_error', payload: { leaf: 'architecture_drift', message: error.message } });
    return [];
  });
  reasoning.push({ fact: `architecture_drift: ${drift.length} record(s)`, source: 'architecture_drift' });
  if (drift.length > 0) {
    const avgInstability = drift.reduce((s, d) => s + d.instabilityDelta, 0) / drift.length;
    sources.push({ kind: 'external', ref: `architecture_drift.avg=${avgInstability.toFixed(3)}` });
  }

  // 6. Sort deterministically + cap.
  const interventions = perSymbolScores
    .filter((s): s is InterventionStep => s != null)
    .sort(deterministicRank);
  const capped = interventions.slice(0, topN);

  return finalize(capped, reasoning, signals, sources, {
    baseRef,
    headRef,
    totalChangedSymbols: changeGraph.symbols.length,
    sessionId,
    root,
    writeToBlackboard,
  });
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
  qdrantUrl: string,
  signals: Signal[],
  reasoning: ReasoningFact[],
): Promise<InterventionStep | null> {
  const why: string[] = [];

  // regression_risk
  const regression = await regressionRiskAsync(root, sym.symbol).catch((error: Error) => {
    signals.push({ kind: 'plan_refactor.leaf_error', payload: { leaf: 'regression_risk', symbol: sym.symbol, message: error.message } });
    return null;
  });
  const regressionScore = clamp01(regression?.score ?? 0.5);
  if (regression) {
    reasoning.push({ fact: `regression_risk: ${sym.symbol} score=${regressionScore.toFixed(3)} level=${regression.level}`, source: 'regression_risk' });
    why.push(`regression_risk score=${regressionScore.toFixed(3)} (${regression.level})`);
  } else {
    why.push('regression_risk unavailable; defaulting to mid-confidence');
  }

  // blast_radius from composite scoring
  let blastScore = 0;
  if (graph && maxima) {
    const result = compositeBlastRadius(sym.symbol, { graph, memory: null, maxima });
    blastScore = result.score;
    reasoning.push({
      fact: `blast_radius: ${sym.symbol} score=${blastScore.toFixed(3)} inbound=${result.breakdown.inbound} outbound=${result.breakdown.outbound}`,
      source: 'composite',
    });
    why.push(`blast_radius=${blastScore.toFixed(3)} (in=${result.breakdown.inbound}, out=${result.breakdown.outbound})`);
  } else {
    why.push('blast_radius=0 (graph not indexed)');
  }

  // semantic_duplicates on the touched file — uses the pre-loaded snapshot
  // hoisted once above the per-symbol loop (FIX F7).
  const dups = await readDuplicatesForFile(duplicatesSnapshot, sym.file, signals);
  if (dups > 0) {
    why.push(`${dups} duplicate pattern(s) on ${sym.file}`);
  }

  // render_behavior: signal-only count; we only push a fact if the graph
  // has side-effects recorded (no need to await a render call).
  const effectCount = graph?.sideEffects?.[sym.symbol]?.length ?? 0;
  if (effectCount > 0) {
    why.push(`${effectCount} recorded side effect(s)`);
  }

  // confidence formula
  const confidence = clamp01(0.5 * (1 - regressionScore) + 0.5 * blastScore);
  why.push(`confidence=${confidence.toFixed(3)}`);

  // reversible rule
  const reversible = computeReversible(sym);
  if (reversible) {
    why.push('reversible: additive / non-breaking');
  } else {
    why.push(`reversible=false (${whyForNonReversible(sym)})`);
  }

  if (confidence >= HIGH_CONFIDENCE_THRESHOLD) {
    why.push('high-confidence intervention');
  }

  return {
    symbol: sym.symbol,
    files: [sym.file],
    confidence,
    reversible,
    blast_radius: blastScore,
    why,
    changeKind: sym.kind,
    signatureChanged: sym.signatureChanged,
    ...(sym.probableRenameFrom ? { renameFrom: sym.probableRenameFrom } : {}),
    ...(sym.probableMoveFromFile ? { moveFromFile: sym.probableMoveFromFile } : {}),
  };
}

async function readDuplicatesForFile(
  snapshot: Awaited<ReturnType<typeof loadSemanticDuplicates>>,
  file: string,
  signals: Signal[],
): Promise<number> {
  try {
    if (!snapshot) return 0;
    // Pass an empty context — findDuplicatesForTarget filters by target string
    // and a missing context just leaves patterns un-scored (still filtered).
    const patterns = findDuplicatesForTarget(snapshot, file);
    return patterns.length;
  } catch (error) {
    signals.push({ kind: 'plan_refactor.leaf_error', payload: { leaf: 'semantic_duplicates', file, message: (error as Error).message } });
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Reversibility
// ---------------------------------------------------------------------------

function computeReversible(sym: GitSemanticChangeSymbol): boolean {
  if (sym.kind === 'added') return true;
  if (sym.kind === 'deleted') return false;
  // modified
  if (sym.signatureChanged) return false;
  if (sym.probableRenameFrom) return false;
  if (sym.probableMoveFromFile) return false;
  return true;
}

function whyForNonReversible(sym: GitSemanticChangeSymbol): string {
  if (sym.kind === 'deleted') return 'symbol deleted';
  if (sym.signatureChanged) return 'signature changed';
  if (sym.probableRenameFrom) return `renamed from ${sym.probableRenameFrom}`;
  if (sym.probableMoveFromFile) return `moved from ${sym.probableMoveFromFile}`;
  return 'unknown reason';
}

// ---------------------------------------------------------------------------
// Deterministic rank
// ---------------------------------------------------------------------------

function deterministicRank(a: InterventionStep, b: InterventionStep): number {
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  if (a.blast_radius !== b.blast_radius) return b.blast_radius - a.blast_radius;
  if (a.reversible !== b.reversible) return a.reversible ? -1 : 1;
  return a.symbol.localeCompare(b.symbol);
}

// ---------------------------------------------------------------------------
// Finalize + blackboard
// ---------------------------------------------------------------------------

interface FinalizeOpts {
  baseRef: string;
  headRef: string;
  totalChangedSymbols: number;
  sessionId: string;
  root: string;
  writeToBlackboard: boolean;
}

async function finalize(
  interventions: InterventionStep[],
  reasoning: ReasoningFact[],
  signals: Signal[],
  sources: Source[],
  opts: FinalizeOpts,
): Promise<ToolResult<PlanRefactorPayload>> {
  const distribution = computeBlastDistribution(interventions);
  const reversibilityRatio = interventions.length === 0
    ? 0
    : interventions.filter(s => s.reversible).length / interventions.length;

  const summary = buildSummary(interventions, distribution, reversibilityRatio, opts);

  const data: PlanRefactorPayload = {
    interventions,
    reasoning_chain: reasoning,
    summary,
    totalChangedSymbols: opts.totalChangedSymbols,
    blastRadiusDistribution: distribution,
    reversibilityRatio,
    baseRef: opts.baseRef,
    headRef: opts.headRef,
  };

  const tier = interventions.length === 0 ? 'AMBIGUOUS' : 'EXTRACTED';

  const result = makeToolResult<PlanRefactorPayload>(data, {
    signals,
    sources,
    reasoning,
    confidence_tier: tier,
  });

  if (opts.writeToBlackboard) {
    await appendScratchpad(opts.sessionId, {
      ts: new Date().toISOString(),
      tool: 'plan_refactor',
      data: result.data,
      reasoning: result.reasoning.map(f => f.fact),
      confidence_tier: result.confidence_tier,
      sessionId: opts.sessionId,
    }, { projectRoot: opts.root });
  }

  return result;
}

function computeBlastDistribution(interventions: InterventionStep[]): PlanRefactorPayload['blastRadiusDistribution'] {
  const dist = { low: 0, medium: 0, high: 0 };
  for (const i of interventions) {
    if (i.blast_radius < 0.34) dist.low++;
    else if (i.blast_radius < 0.67) dist.medium++;
    else dist.high++;
  }
  return dist;
}

function buildSummary(
  interventions: InterventionStep[],
  dist: PlanRefactorPayload['blastRadiusDistribution'],
  reversibilityRatio: number,
  opts: { baseRef: string; headRef: string; totalChangedSymbols: number },
): string {
  if (interventions.length === 0) {
    return `0 interventions ranked for ${opts.baseRef}..${opts.headRef} (${opts.totalChangedSymbols} changed symbol(s) in diff)`;
  }
  return [
    `${interventions.length} intervention(s) ranked for ${opts.baseRef}..${opts.headRef} (${opts.totalChangedSymbols} changed symbol(s) total)`,
    `blast radius: low=${dist.low} medium=${dist.medium} high=${dist.high}`,
    `reversibility: ${(reversibilityRatio * 100).toFixed(0)}% reversible`,
  ].join('; ');
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
  computeReversible,
  whyForNonReversible,
  deterministicRank,
  buildSummary,
};

// Re-export duplicate loader for tests that want to pre-seed the snapshot.
export { loadSemanticDuplicates };
