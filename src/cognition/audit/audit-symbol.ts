/**
 * audit/audit-symbol — US-004 P3a `audit_symbol` meta-tool.
 *
 * Fuses six leaves into a single ToolResult<AuditSymbolPayload>:
 *   1. get_symbol         — symbol presence + graph context
 *   2. render_behavior    — side-effect checklist
 *   3. regression_risk    — risk score + signals
 *   4. analyze_impact     — call-graph blast footprint (AffectedSymbolsResult)
 *   5. semantic_duplicates — duplicate patterns touching the symbol
 *   6. query_project_memory — rationale lines from prior project memory
 *
 * Plus, drawn from US-003:
 *   - blast_radius from `compositeScore(symbol).blastRadius`
 *
 * The `action_recommendation` is a deterministic rule table (no LLM) that
 * reads the 6 fields above and emits one of:
 *   "HOLD — high regression risk and high blast radius"
 *   "REVIEW — high blast radius but stable history"
 *   "INVESTIGATE — risk concentrated in recent change history"
 *   "MONITOR — duplicates present but low risk"
 *   "SAFE — low risk, low blast, no duplicates"
 *   "INSUFFICIENT — project not indexed yet"
 *
 * Reasoning chain propagation (FR-4): each leaf's `reasoning[]` is
 * concatenated via `appendReasoning`, prefixed with a leading fact naming
 * the meta-call. Blackboard write (FR-3) is opt-out via
 * `writeToBlackboard: false`; default is `true`.
 *
 * Failure mode (FR-1 / fail loud, fail typed): a leaf that throws or
 * returns empty materialises as an empty-but-typed field in the payload
 * AND a `Signal` in the envelope. The meta-tool never throws on leaf
 * failure; the caller inspects `signals[]` to see what is missing.
 */

import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { loadGraphAsync } from '../../graph.js';
import { getDataDir } from '../../git.js';
import { type SideEffect } from '../../behavior-graph.js';
import { getAffectedSymbols, getRiskHotspots } from '../../engineering-insights.js';
import { loadSemanticDuplicates, refreshSemanticDuplicatesAsync } from '../duplicates/orchestrator.js';
import { findDuplicatesForTarget } from '../duplicates/signals.js';
import type { SemanticDuplicatePattern } from '../duplicates/types.js';
import { regressionRiskAsync } from '../reflection/engine.js';
import { queryProjectMemory, type ProjectMemorySearchHit } from '../../project-memory.js';
import {
  blastRadius as compositeBlastRadius,
  computeGraphMaxima,
  computeAndPersistCompositeScores,
} from '../composite/persist.js';
import { appendReasoning, inheritReasoning, type ReasoningFact } from '../reasoning/bus.js';
import { appendScratchpad } from '../blackboard/scratchpad.js';
import {
  makeToolResult,
  type ToolResult,
  type Signal,
  type Source,
} from '../signalization/types.js';
import { validateGraphPath } from '../../utils/security.js';
import {
  type AuditSymbolPayload,
  type BlastRadius,
  type DuplicateMatch,
  type MetaToolOptions,
  type RationaleEntry,
  type RiskHotspot,
  type Behavior,
  type ImpactReport,
} from './types.js';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the `audit_symbol` meta-call.
 *
 * Always returns a ToolResult — never throws on leaf failure. A leaf that
 * returned nothing is reflected in:
 *   - the corresponding field of `data` (typed empty value), and
 *   - a `Signal` in `signals[]` with `kind: 'audit_symbol.leaf_missing'`.
 */
export async function auditSymbolAsync(
  projectRoot: string,
  symbol: string,
  opts: MetaToolOptions = {},
): Promise<ToolResult<AuditSymbolPayload>> {
  const root = path.resolve(projectRoot);
  validateGraphPath(root, 'audit_symbol');
  const qdrantUrl = opts.qdrantUrl ?? 'http://localhost:6333';
  const sessionId = opts.sessionId ?? `audit:${symbolSessionHash(symbol)}`;
  const writeToBlackboard = opts.writeToBlackboard !== false;

  const signals: Signal[] = [];
  const sources: Source[] = [
    { kind: 'symbol', ref: symbol },
    { kind: 'tool', ref: 'audit_symbol' },
  ];

  // Leading fact (FR-4): the chain must be self-explanatory.
  const reasoning: ReasoningFact[] = [
    { fact: `audit_symbol called for ${symbol}`, source: 'audit_symbol' },
  ];

  // ── Run all 6 leaves in parallel where the loader allows ──────────────
  // render_behavior and analyze_impact both depend on the graph, so we
  // load it once and pass it forward (no need to await it twice).
  const graphFile = path.join(getDataDir(root), 'graph.json');
  const graphP = loadGraphAsync(graphFile).catch(() => null);
  const behaviorP = readBehaviorAsync(root, symbol, graphP, signals, reasoning);
  const riskP = readRiskAsync(root, symbol, signals, reasoning);
  const impactP = readImpactAsync(root, symbol, signals, reasoning);
  const dupsP = readDuplicatesAsync(root, symbol, signals, reasoning);
  const rationaleP = readRationaleAsync(root, symbol, qdrantUrl, signals, reasoning);
  const regressionP = readRegressionAsync(root, symbol, qdrantUrl, signals, reasoning);

  const [behavior, risk, impact, dups, rationale, regression] = await Promise.all([
    behaviorP,
    riskP,
    impactP,
    dupsP,
    rationaleP,
    regressionP,
  ]);

  // ── blast_radius from US-003 composite scoring ────────────────────────
  const blast = await readBlastRadiusAsync(root, symbol, signals, reasoning);

  // ── deterministic action_recommendation ────────────────────────────────
  const action_recommendation = synthesizeAction({
    behaviorCount: behavior.length,
    risk,
    regressionScore: regression?.score ?? 0,
    blastScore: blast.score,
    duplicateCount: dups.length,
    rationaleCount: rationale.length,
    projectIndexed: (await graphP) !== null,
  });

  const data: AuditSymbolPayload = {
    behavior,
    risk,
    impact,
    dups,
    rationale,
    blast_radius: blast,
    action_recommendation,
    reasoning_chain: reasoning,
  };

  const tier = inferTier({ behavior, risk, regressionScore: regression?.score ?? null, blastScore: blast.score });

  const result = makeToolResult<AuditSymbolPayload>(data, {
    signals,
    sources,
    reasoning,
    confidence_tier: tier,
  });

  // ── Blackboard write (FR-3) ───────────────────────────────────────────
  if (writeToBlackboard) {
    await appendScratchpad(sessionId, {
      ts: new Date().toISOString(),
      tool: 'audit_symbol',
      data: result.data,
      reasoning: result.reasoning.map(f => f.fact),
      confidence_tier: result.confidence_tier,
      sessionId,
    }, { projectRoot: root });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Leaf readers — each isolates one leaf and converts a missing leaf into a
// typed empty value + a Signal. Reasoning chain is appended in order.
// ---------------------------------------------------------------------------

async function readBehaviorAsync(
  root: string,
  symbol: string,
  graphP: Promise<unknown>,
  signals: Signal[],
  reasoning: ReasoningFact[],
): Promise<Behavior> {
  try {
    const graph = await graphP as Awaited<ReturnType<typeof loadGraphAsync>>;
    if (!graph) {
      signals.push({ kind: 'audit_symbol.leaf_missing', payload: { leaf: 'render_behavior' } });
      return [];
    }
    const effects = (graph?.sideEffects?.[symbol] ?? []) as SideEffect[];
    reasoning.push({ fact: `render_behavior: ${effects.length} side effect(s) for ${symbol}`, source: 'render_behavior' });
    return effects;
  } catch (error) {
    signals.push({ kind: 'audit_symbol.leaf_error', payload: { leaf: 'render_behavior', message: (error as Error).message } });
    return [];
  }
}

async function readRiskAsync(
  root: string,
  symbol: string,
  signals: Signal[],
  reasoning: ReasoningFact[],
): Promise<RiskHotspot> {
  try {
    const result = await getRiskHotspots(root, { limit: 25, excludeSinkNodes: false });
    if (!result) {
      signals.push({ kind: 'audit_symbol.leaf_missing', payload: { leaf: 'risk_hotspots' } });
      return null;
    }
    const match = result.symbols.find((s: { symbol: string }) => s.symbol === symbol) ?? null;
    reasoning.push({ fact: match
      ? `risk_hotspots: ${match.symbol} score=${match.score.toFixed(3)} connectivity=${match.connectivity}`
      : `risk_hotspots: ${symbol} not in top-${result.symbols.length}`,
      source: 'risk_hotspots' });
    return match;
  } catch (error) {
    signals.push({ kind: 'audit_symbol.leaf_error', payload: { leaf: 'risk_hotspots', message: (error as Error).message } });
    return null;
  }
}

async function readImpactAsync(
  root: string,
  symbol: string,
  signals: Signal[],
  reasoning: ReasoningFact[],
): Promise<ImpactReport> {
  try {
    const result = await getAffectedSymbols(root, [symbol], { hops: 2, direction: 'both', limit: 15 });
    if (!result) {
      signals.push({ kind: 'audit_symbol.leaf_missing', payload: { leaf: 'analyze_impact' } });
      return emptyImpact(symbol);
    }
    reasoning.push({ fact: `analyze_impact: ${result.entries.length} related symbol(s) within 2 hops of ${symbol}`, source: 'analyze_impact' });
    return result;
  } catch (error) {
    signals.push({ kind: 'audit_symbol.leaf_error', payload: { leaf: 'analyze_impact', message: (error as Error).message } });
    return emptyImpact(symbol);
  }
}

async function readDuplicatesAsync(
  root: string,
  symbol: string,
  signals: Signal[],
  reasoning: ReasoningFact[],
): Promise<DuplicateMatch[]> {
  try {
    const snapshot = (await loadSemanticDuplicates(root)) ?? await refreshSemanticDuplicatesAsync(root, { withEnrichment: true });
    if (!snapshot) {
      signals.push({ kind: 'audit_symbol.leaf_missing', payload: { leaf: 'semantic_duplicates' } });
      return [];
    }
    const patterns = findDuplicatesForTarget(snapshot, symbol);
    reasoning.push({ fact: `semantic_duplicates: ${patterns.length} pattern(s) touch ${symbol}`, source: 'semantic_duplicates' });
    return patterns.map(duplicateToMatch);
  } catch (error) {
    signals.push({ kind: 'audit_symbol.leaf_error', payload: { leaf: 'semantic_duplicates', message: (error as Error).message } });
    return [];
  }
}

async function readRationaleAsync(
  root: string,
  symbol: string,
  qdrantUrl: string,
  signals: Signal[],
  reasoning: ReasoningFact[],
): Promise<RationaleEntry[]> {
  try {
    const hits = await queryProjectMemory(root, symbol, qdrantUrl, 5);
    reasoning.push({ fact: `query_project_memory: ${hits.length} rationale hit(s) for ${symbol}`, source: 'query_project_memory' });
    return hits.map(rationaleFromHit);
  } catch (error) {
    signals.push({ kind: 'audit_symbol.leaf_error', payload: { leaf: 'query_project_memory', message: (error as Error).message } });
    return [];
  }
}

async function readRegressionAsync(
  root: string,
  symbol: string,
  qdrantUrl: string,
  signals: Signal[],
  reasoning: ReasoningFact[],
): Promise<Awaited<ReturnType<typeof regressionRiskAsync>> | null> {
  try {
    const report = await regressionRiskAsync(root, symbol);
    reasoning.push({ fact: `regression_risk: ${symbol} score=${report.score.toFixed(3)} level=${report.level}`, source: 'regression_risk' });
    void qdrantUrl; // regressionRiskAsync reads from .code-intelligence, no qdrant needed
    return report;
  } catch (error) {
    signals.push({ kind: 'audit_symbol.leaf_error', payload: { leaf: 'regression_risk', message: (error as Error).message } });
    return null;
  }
}

async function readBlastRadiusAsync(
  root: string,
  symbol: string,
  signals: Signal[],
  reasoning: ReasoningFact[],
): Promise<BlastRadius> {
  try {
    const graph = await loadGraphAsync(path.join(getDataDir(root), 'graph.json'));
    if (!graph) {
      reasoning.push({ fact: 'blast_radius: graph not loaded; score=0', source: 'composite' });
      signals.push({ kind: 'audit_symbol.leaf_missing', payload: { leaf: 'blast_radius' } });
      return {
        score: 0,
        breakdown: emptyBlastBreakdown(true),
      };
    }
    // Maxima are computed from the graph alone — composite scores are
    // produced by a separate scorer and not required for `blastRadius`.
    const maxima = computeGraphMaxima(graph, null);
    const result = compositeBlastRadius(symbol, { graph, memory: null, maxima });
    reasoning.push({ fact: `blast_radius: ${symbol} score=${result.score.toFixed(3)} inbound=${result.breakdown.inbound} outbound=${result.breakdown.outbound}`, source: 'composite' });
    return { score: result.score, breakdown: result.breakdown };
  } catch (error) {
    signals.push({ kind: 'audit_symbol.leaf_error', payload: { leaf: 'blast_radius', message: (error as Error).message } });
    return { score: 0, breakdown: emptyBlastBreakdown(true) };
  }
}

// ---------------------------------------------------------------------------
// Synthesis helpers — deterministic, no LLM
// ---------------------------------------------------------------------------

/**
 * `action_recommendation` rule table.
 *
 * The order of checks encodes the precedence: a symbol that is both high
 * risk and high blast radius is held first; a symbol that is low risk but
 * has duplicates is monitored; a symbol that is low everything is safe.
 * The threshold set (0.6 risk / 0.5 blast) is intentionally conservative
 * — symbols landing in the boundary band still get a useful recommendation.
 */
function synthesizeAction(input: {
  behaviorCount: number;
  risk: RiskHotspot;
  regressionScore: number;
  blastScore: number;
  duplicateCount: number;
  rationaleCount: number;
  projectIndexed: boolean;
}): string {
  if (!input.projectIndexed) {
    return 'INSUFFICIENT — project not indexed yet (run index_project)';
  }
  if (input.regressionScore >= 0.6 && input.blastScore >= 0.5) {
    return `HOLD — high regression risk (${input.regressionScore.toFixed(2)}) and high blast radius (${input.blastScore.toFixed(2)})`;
  }
  if (input.blastScore >= 0.5 && input.regressionScore < 0.6) {
    return `REVIEW — high blast radius (${input.blastScore.toFixed(2)}) but stable history`;
  }
  if (input.rationaleCount > 0 && input.regressionScore >= 0.4) {
    return `INVESTIGATE — ${input.rationaleCount} rationale line(s) and elevated risk (${input.regressionScore.toFixed(2)})`;
  }
  if (input.duplicateCount > 0) {
    return `MONITOR — ${input.duplicateCount} duplicate pattern(s) present; low regression risk (${input.regressionScore.toFixed(2)})`;
  }
  if (input.behaviorCount > 0 && input.regressionScore < 0.4) {
    return `SAFE — ${input.behaviorCount} side effect(s); low risk (${input.regressionScore.toFixed(2)}) and low blast`;
  }
  return `SAFE — low risk (${input.regressionScore.toFixed(2)}), low blast (${input.blastScore.toFixed(2)}), no duplicates`;
}

function inferTier(input: { behavior: Behavior; risk: RiskHotspot; regressionScore: number | null; blastScore: number }): ToolResult['confidence_tier'] {
  if (input.regressionScore == null && input.risk == null) return 'AMBIGUOUS';
  if (input.behavior.length === 0 && input.risk == null) return 'AMBIGUOUS';
  if (input.regressionScore != null && input.regressionScore < 0.5) return 'INFERRED';
  return 'EXTRACTED';
}

// ---------------------------------------------------------------------------
// Type converters
// ---------------------------------------------------------------------------

function duplicateToMatch(pattern: SemanticDuplicatePattern): DuplicateMatch {
  return {
    id: pattern.id,
    title: pattern.title,
    category: pattern.category,
    severity: pattern.severity,
    source: pattern.source,
    files: pattern.affectedFiles ?? pattern.locations.map(loc => loc.file),
    description: pattern.description,
    ...(pattern.recommendation ? { recommendation: pattern.recommendation } : {}),
  };
}

function rationaleFromHit(hit: ProjectMemorySearchHit): RationaleEntry {
  const entry = hit.entry;
  return {
    id: entry.id,
    text: entry.summary,
    score: hit.score,
    topics: entry.topics ?? [],
  };
}

function emptyImpact(symbol: string): ImpactReport {
  return {
    seeds: [symbol],
    missingSeeds: [],
    entries: [],
    totalDiscovered: 0,
  };
}

function emptyBlastBreakdown(missing: boolean) {
  return {
    inbound: 0,
    outbound: 0,
    totalDegree: 0,
    connectivity: 0,
    inboundNormalized: 0,
    outboundNormalized: 0,
    totalDegreeNormalized: 0,
    connectivityNormalized: 0,
    symbolMissingFromGraph: missing,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Deterministic 8-char hash for the per-symbol session id.
 *
 * Uses SHA-1 of the symbol (truncated to 8 hex chars). Stable for a given
 * symbol across calls, so a caller can resume the same session.
 */
function symbolSessionHash(symbol: string): string {
  return crypto.createHash('sha1').update(symbol).digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------------------
// Re-exports for the test surface
// ---------------------------------------------------------------------------

export {
  synthesizeAction,
  inferTier,
  duplicateToMatch,
  rationaleFromHit,
  symbolSessionHash,
};

// Re-export the orchestrator helper so tests / callers that want to pre-warm
// composite scores can do so without importing the persist module directly.
export { computeAndPersistCompositeScores };
