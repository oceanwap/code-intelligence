/**
 * composite/scoring — P2 composite scoring functions (PRD US-003 / FR-5).
 *
 * Three pure functions, each returning a `[0,1]` score plus a typed feature
 * breakdown:
 *
 *   blastRadius(symbol, ctx)         — graph blast footprint
 *   intentAlignment(symbol, goal, ctx) — goal-vs-symbol alignment
 *   changeRisk(symbol, ctx)         — historical change risk
 *
 * Every function is pure (no I/O) and deterministic for a fixed input — the
 * same `ctx` always produces the same score. Persistence lives in
 * `./persist.ts`; cross-output reindexing lives in `./cross-output-index.ts`.
 *
 * Why "composite" rather than "scoring" alone: each function is a weighted
 * blend of graph + project-memory signals. The blend weights are baked in
 * (see WEIGHT_BLAST_RADIUS / WEIGHT_INTENT / WEIGHT_RISK) and chosen so that
 * one symbol with all-max features lands at exactly 1.0 — never above, never
 * negative. The breakdowns are typed so downstream ranking code can explain
 * "why was this ranked up" without re-reading the source.
 *
 * Design rule (PRD NG-1 / FR-2): scoring is **internal**. Existing leaves
 * consume it via their existing rank path; nothing about the public MCP
 * surface changes.
 */

import type { GraphData } from '../../graph.js';
import type { ProjectMemoryEntry } from '../../project-memory.js';

// ---------------------------------------------------------------------------
// Context — what scoring needs to know
// ---------------------------------------------------------------------------

/**
 * Minimal slice of project memory that scoring needs.
 *
 * We deliberately do NOT import the full ProjectMemoryEntry type here so the
 * scoring module stays free of side-effect-prone imports. Callers build a
 * MemoryStats snapshot before invoking the scorers; the snapshot is what
 * gets persisted alongside the score.
 */
export interface MemoryStats {
  changeCount: number;
  fixCount: number;
  /** Symbols the memory entry references (used for goal-token overlap). */
  symbolHits: number;
  /** Files the memory entry references (used for file-token overlap). */
  fileHits: number;
  /** Distinct topics tagged across the memory entries (for goal alignment). */
  topics: string[];
}

export interface ScoringContext {
  /** Indexed graph. Optional — scoring degrades gracefully if missing. */
  graph: GraphData | null;
  /** Per-symbol memory stats, keyed by symbol name. Optional. */
  memory: Map<string, MemoryStats> | null;
  /**
   * Optional graph-wide maxima used to normalize scores into [0,1]. If not
   * provided, we compute them lazily from the graph on first call. Callers
   * that score many symbols in a batch SHOULD precompute once and reuse.
   */
  maxima?: GraphMaxima;
  /**
   * Optional goal text. Required for `intentAlignment`. Other scorers ignore
   * it. Whitespace-normalized at scoring time.
   */
  goal?: string;
}

/**
 * Pre-computed graph-wide maxima used by the scorers to normalize raw
 * counts into [0,1]. Computing this on every call is wasteful when scoring
 * a batch.
 */
export interface GraphMaxima {
  maxInbound: number;
  maxOutbound: number;
  maxTotalDegree: number;
  maxChangeCount: number;
  maxFixCount: number;
  maxConnectivity: number;
}

/**
 * Compute graph-wide maxima from a graph + memory snapshot. Use this once
 * per batch, then pass to individual `blastRadius` / `changeRisk` calls.
 *
 * Out-of-range inputs (NaN, Infinity, undefined) are coerced to 0 so the
 * resulting score is always a finite number in [0,1].
 */
export function computeGraphMaxima(
  graph: GraphData | null,
  memory: Map<string, MemoryStats> | null
): GraphMaxima {
  let maxInbound = 0;
  let maxOutbound = 0;
  let maxTotalDegree = 0;
  let maxChangeCount = 0;
  let maxFixCount = 0;
  let maxConnectivity = 0;

  if (graph) {
    for (const symbol of Object.keys(graph.symbols ?? {})) {
      const inbound = (graph.callers?.[symbol] ?? []).length;
      const outbound = (graph.symbols?.[symbol] ?? []).length;
      const totalDegree = inbound + outbound;
      const connectivity = new Set([
        ...(graph.symbols?.[symbol] ?? []),
        ...(graph.callers?.[symbol] ?? []),
        ...(graph.implementations?.[symbol] ?? []),
        ...(graph.implementedFrom?.[symbol] ?? []),
        ...(graph.supertypes?.[symbol] ?? []),
        ...(graph.subtypes?.[symbol] ?? []),
      ]).size;
      if (inbound > maxInbound) maxInbound = inbound;
      if (outbound > maxOutbound) maxOutbound = outbound;
      if (totalDegree > maxTotalDegree) maxTotalDegree = totalDegree;
      if (connectivity > maxConnectivity) maxConnectivity = connectivity;
    }
  }

  if (memory) {
    for (const stats of memory.values()) {
      if (stats.changeCount > maxChangeCount) maxChangeCount = stats.changeCount;
      if (stats.fixCount > maxFixCount) maxFixCount = stats.fixCount;
    }
  }

  return {
    maxInbound: safeNonNegative(maxInbound),
    maxOutbound: safeNonNegative(maxOutbound),
    maxTotalDegree: safeNonNegative(maxTotalDegree),
    maxChangeCount: safeNonNegative(maxChangeCount),
    maxFixCount: safeNonNegative(maxFixCount),
    maxConnectivity: safeNonNegative(maxConnectivity),
  };
}

// ---------------------------------------------------------------------------
// Per-function scoring types + breakdowns
// ---------------------------------------------------------------------------

export interface BlastRadiusBreakdown {
  inbound: number;
  outbound: number;
  totalDegree: number;
  connectivity: number;
  inboundNormalized: number;
  outboundNormalized: number;
  totalDegreeNormalized: number;
  connectivityNormalized: number;
  /** Symbols not present in the graph. */
  symbolMissingFromGraph: boolean;
}

export interface IntentAlignmentBreakdown {
  goalTokenCount: number;
  directSymbolOverlap: number;
  fileOverlap: number;
  neighborSymbolSupport: number;
  topicOverlap: number;
  memorySymbolHits: number;
  directSymbolOverlapNormalized: number;
  fileOverlapNormalized: number;
  neighborSymbolSupportNormalized: number;
  topicOverlapNormalized: number;
  /** Goal was empty / whitespace-only — score collapses to 0 with this flag set. */
  goalEmpty: boolean;
}

export interface ChangeRiskBreakdown {
  changeCount: number;
  fixCount: number;
  connectivity: number;
  instability: number;
  changeCountNormalized: number;
  fixCountNormalized: number;
  connectivityNormalized: number;
  instabilityNormalized: number;
  /** No project memory data for this symbol — risk signal collapses. */
  memoryMissing: boolean;
}

export interface CompositeScore {
  symbol: string;
  blastRadius: number;
  intentAlignment: number;
  changeRisk: number;
  /** Weighted blend used for ranking. Always in [0,1]. */
  overall: number;
  blastRadiusBreakdown: BlastRadiusBreakdown;
  intentAlignmentBreakdown: IntentAlignmentBreakdown;
  changeRiskBreakdown: ChangeRiskBreakdown;
  /** ISO timestamp captured at score time. Stable for a fixed graph. */
  computedAt: string;
}

// ---------------------------------------------------------------------------
// Per-scorer exports
// ---------------------------------------------------------------------------

const WEIGHT_BLAST_INBOUND = 0.45;
const WEIGHT_BLAST_OUTBOUND = 0.20;
const WEIGHT_BLAST_TOTAL = 0.20;
const WEIGHT_BLAST_CONNECTIVITY = 0.15;

const WEIGHT_INTENT_SYMBOL = 0.45;
const WEIGHT_INTENT_FILE = 0.15;
const WEIGHT_INTENT_NEIGHBOR = 0.25;
const WEIGHT_INTENT_TOPIC = 0.15;

const WEIGHT_RISK_CHANGES = 0.30;
const WEIGHT_RISK_FIXES = 0.35;
const WEIGHT_RISK_CONNECTIVITY = 0.15;
const WEIGHT_RISK_INSTABILITY = 0.20;

const BLEND_BLAST = 0.45;
const BLEND_INTENT = 0.30;
const BLEND_RISK = 0.25;

/**
 * blastRadius — graph blast footprint of a symbol in [0,1].
 *
 * Features (each normalized by the graph-wide maximum):
 *   - inbound          — distinct callers (weight 0.45)
 *   - outbound         — distinct callees (weight 0.20)
 *   - totalDegree      — inbound + outbound (weight 0.20)
 *   - connectivity     — unique neighbors across all relations (0.15)
 *
 * A symbol with zero neighbors in any direction returns 0; a symbol at
 * every maximum simultaneously returns exactly 1.0. Missing graph → score 0
 * with `symbolMissingFromGraph = true`.
 */
export function blastRadius(symbol: string, ctx: ScoringContext): { score: number; breakdown: BlastRadiusBreakdown } {
  const maxima = ctx.maxima ?? computeGraphMaxima(ctx.graph, ctx.memory);

  const graph = ctx.graph;
  if (!graph) {
    return {
      score: 0,
      breakdown: emptyBlastBreakdown(true),
    };
  }

  const inbound = (graph.callers?.[symbol] ?? []).length;
  const outbound = (graph.symbols?.[symbol] ?? []).length;
  const totalDegree = inbound + outbound;
  const connectivity = new Set([
    ...(graph.symbols?.[symbol] ?? []),
    ...(graph.callers?.[symbol] ?? []),
    ...(graph.implementations?.[symbol] ?? []),
    ...(graph.implementedFrom?.[symbol] ?? []),
    ...(graph.supertypes?.[symbol] ?? []),
    ...(graph.subtypes?.[symbol] ?? []),
  ]).size;

  const symbolMissingFromGraph = !(symbol in (graph.symbolFile ?? {}));

  const inboundNormalized = normalize(inbound, maxima.maxInbound);
  const outboundNormalized = normalize(outbound, maxima.maxOutbound);
  const totalDegreeNormalized = normalize(totalDegree, maxima.maxTotalDegree);
  const connectivityNormalized = normalize(connectivity, maxima.maxConnectivity);

  const score = clamp01(
    inboundNormalized * WEIGHT_BLAST_INBOUND
      + outboundNormalized * WEIGHT_BLAST_OUTBOUND
      + totalDegreeNormalized * WEIGHT_BLAST_TOTAL
      + connectivityNormalized * WEIGHT_BLAST_CONNECTIVITY
  );

  return {
    score,
    breakdown: {
      inbound,
      outbound,
      totalDegree,
      connectivity,
      inboundNormalized,
      outboundNormalized,
      totalDegreeNormalized,
      connectivityNormalized,
      symbolMissingFromGraph,
    },
  };
}

/**
 * intentAlignment — how well `symbol` matches a free-form `goal`, in [0,1].
 *
 * Features (each normalized to [0,1] within its own scale):
 *   - directSymbolOverlap — count of goal tokens that appear in the symbol (weight 0.45)
 *   - fileOverlap         — count of goal tokens that appear in the symbol's file (0.15)
 *   - neighborSymbolSupport — sum of project-memory hits for graph neighbors (0.25)
 *   - topicOverlap        — count of goal tokens that appear in memory topics (0.15)
 *
 * Empty / whitespace-only goal collapses the score to 0 and sets
 * `goalEmpty = true`. Caller passes the goal either via `ctx.goal` or as the
 * second positional argument (the argument wins).
 */
export function intentAlignment(
  symbol: string,
  goal: string | undefined,
  ctx: ScoringContext
): { score: number; breakdown: IntentAlignmentBreakdown } {
  const effectiveGoal = (goal ?? ctx.goal ?? '').trim().toLowerCase();
  const goalTokens = tokenizeGoal(effectiveGoal);

  if (goalTokens.size === 0) {
    return {
      score: 0,
      breakdown: {
        goalTokenCount: 0,
        directSymbolOverlap: 0,
        fileOverlap: 0,
        neighborSymbolSupport: 0,
        topicOverlap: 0,
        memorySymbolHits: 0,
        directSymbolOverlapNormalized: 0,
        fileOverlapNormalized: 0,
        neighborSymbolSupportNormalized: 0,
        topicOverlapNormalized: 0,
        goalEmpty: true,
      },
    };
  }

  const graph = ctx.graph;
  const memory = ctx.memory;
  const file = graph?.symbolFile?.[symbol] ?? '';
  const neighbors = graph ? graphNeighbors(graph, symbol) : [];

  const directSymbolOverlap = countOverlap(goalTokens, symbol);
  const fileOverlap = countOverlap(goalTokens, file);
  const memoryStats = memory?.get(symbol);
  const neighborSymbolSupport = neighbors.reduce(
    (total, neighbor) => total + (memory?.get(neighbor)?.symbolHits ?? 0),
    0
  );
  const topicOverlap = memoryStats
    ? memoryStats.topics.reduce((total, topic) => total + countOverlap(goalTokens, topic), 0)
    : 0;
  const memorySymbolHits = memoryStats?.symbolHits ?? 0;

  // Normalization: cap raw counts so a single feature cannot dominate.
  const directSymbolOverlapNormalized = clamp01(directSymbolOverlap / Math.max(1, goalTokens.size));
  const fileOverlapNormalized = clamp01(fileOverlap / Math.max(1, goalTokens.size));
  const neighborSymbolSupportNormalized = clamp01(neighborSymbolSupport / 10);
  const topicOverlapNormalized = clamp01(topicOverlap / Math.max(1, goalTokens.size * 2));

  const score = clamp01(
    directSymbolOverlapNormalized * WEIGHT_INTENT_SYMBOL
      + fileOverlapNormalized * WEIGHT_INTENT_FILE
      + neighborSymbolSupportNormalized * WEIGHT_INTENT_NEIGHBOR
      + topicOverlapNormalized * WEIGHT_INTENT_TOPIC
  );

  return {
    score,
    breakdown: {
      goalTokenCount: goalTokens.size,
      directSymbolOverlap,
      fileOverlap,
      neighborSymbolSupport,
      topicOverlap,
      memorySymbolHits,
      directSymbolOverlapNormalized,
      fileOverlapNormalized,
      neighborSymbolSupportNormalized,
      topicOverlapNormalized,
      goalEmpty: false,
    },
  };
}

/**
 * changeRisk — how risky it is to change `symbol`, in [0,1].
 *
 * Features:
 *   - changeCount  — total changes touching the symbol (weight 0.30)
 *   - fixCount     — fix commits touching the symbol (weight 0.35) — highest weight because fixes correlate with bugs
 *   - connectivity — neighbor count (0.15) — fan-out amplifies the blast
 *   - instability  — outbound / totalDegree, normalized (0.20) — volatile edges raise risk
 *
 * No graph → score 0 with `memoryMissing = true`. No memory for the symbol
 * but graph present → score reflects graph features only (`memoryMissing = true`).
 */
export function changeRisk(symbol: string, ctx: ScoringContext): { score: number; breakdown: ChangeRiskBreakdown } {
  const maxima = ctx.maxima ?? computeGraphMaxima(ctx.graph, ctx.memory);
  const graph = ctx.graph;
  const memory = ctx.memory;
  const stats = memory?.get(symbol);

  if (!graph) {
    return {
      score: 0,
      breakdown: emptyRiskBreakdown(true),
    };
  }

  const changeCount = stats?.changeCount ?? 0;
  const fixCount = stats?.fixCount ?? 0;
  const inbound = (graph.callers?.[symbol] ?? []).length;
  const outbound = (graph.symbols?.[symbol] ?? []).length;
  const totalDegree = inbound + outbound;
  const connectivity = new Set([
    ...(graph.symbols?.[symbol] ?? []),
    ...(graph.callers?.[symbol] ?? []),
    ...(graph.implementations?.[symbol] ?? []),
    ...(graph.implementedFrom?.[symbol] ?? []),
    ...(graph.supertypes?.[symbol] ?? []),
    ...(graph.subtypes?.[symbol] ?? []),
  ]).size;
  const instability = totalDegree > 0 ? outbound / totalDegree : 0;

  const changeCountNormalized = normalize(changeCount, maxima.maxChangeCount);
  const fixCountNormalized = normalize(fixCount, maxima.maxFixCount);
  const connectivityNormalized = normalize(connectivity, maxima.maxConnectivity);
  const instabilityNormalized = clamp01(instability);

  const score = clamp01(
    changeCountNormalized * WEIGHT_RISK_CHANGES
      + fixCountNormalized * WEIGHT_RISK_FIXES
      + connectivityNormalized * WEIGHT_RISK_CONNECTIVITY
      + instabilityNormalized * WEIGHT_RISK_INSTABILITY
  );

  return {
    score,
    breakdown: {
      changeCount,
      fixCount,
      connectivity,
      instability,
      changeCountNormalized,
      fixCountNormalized,
      connectivityNormalized,
      instabilityNormalized,
      memoryMissing: stats == null,
    },
  };
}

/**
 * compositeScore — compute all three scorers for one symbol and combine.
 *
 * The blended `overall` uses fixed weights:
 *   overall = 0.45 * blastRadius + 0.30 * intentAlignment + 0.25 * changeRisk
 *
 * These weights prioritize blast radius (what the agent is asking about) and
 * intent alignment (how well it matches the goal) while still surfacing risk.
 */
export function compositeScore(symbol: string, ctx: ScoringContext, opts?: { goal?: string }): CompositeScore {
  const goal = opts?.goal ?? ctx.goal;
  const blast = blastRadius(symbol, ctx);
  const intent = intentAlignment(symbol, goal, ctx);
  const risk = changeRisk(symbol, ctx);

  const overall = clamp01(
    blast.score * BLEND_BLAST
      + intent.score * BLEND_INTENT
      + risk.score * BLEND_RISK
  );

  return {
    symbol,
    blastRadius: blast.score,
    intentAlignment: intent.score,
    changeRisk: risk.score,
    overall,
    blastRadiusBreakdown: blast.breakdown,
    intentAlignmentBreakdown: intent.breakdown,
    changeRiskBreakdown: risk.breakdown,
    computedAt: '1970-01-01T00:00:00.000Z', // overwritten by caller for stability
  };
}

/**
 * rankSymbolsByComposite — convenience ranking helper used by the 3 leaves.
 *
 * Returns the input symbols sorted descending by `overall`. Ties broken by
 * symbol name (locale-compare) for determinism — same input → same output.
 *
 * Symbols missing from the composite map are sorted to the bottom with
 * score 0; they do NOT crash the ranker.
 */
export function rankSymbolsByComposite(
  symbols: Iterable<string>,
  scores: Map<string, CompositeScore>
): string[] {
  const arr = [...symbols];
  arr.sort((left, right) => {
    const ls = scores.get(left)?.overall ?? 0;
    const rs = scores.get(right)?.overall ?? 0;
    if (ls !== rs) return rs - ls;
    return left.localeCompare(right);
  });
  return arr;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'how', 'what', 'where', 'does', 'get', 'set', 'use', 'for',
  'with', 'from', 'and', 'that', 'this', 'are', 'was', 'not', 'but', 'file',
  'code', 'function', 'class', 'method', 'feature', 'features', 'service',
  'system', 'logic', 'module', 'modules', 'works', 'work', 'about', 'using',
  'into', 'to', 'of', 'on', 'in', 'is', 'it', 'be', 'as', 'at', 'or', 'by',
]);

function tokenizeGoal(goal: string): Set<string> {
  if (!goal) return new Set();
  const out = new Set<string>();
  for (const raw of goal.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || raw.length > 24) continue;
    if (STOP_WORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function countOverlap(tokens: Set<string>, value: string | null | undefined): number {
  if (!value || tokens.size === 0) return 0;
  const lower = value.toLowerCase();
  let n = 0;
  for (const t of tokens) if (lower.includes(t)) n++;
  return n;
}

function graphNeighbors(graph: GraphData, symbol: string): string[] {
  const set = new Set<string>();
  for (const arr of [
    graph.symbols?.[symbol] ?? [],
    graph.callers?.[symbol] ?? [],
    graph.implementations?.[symbol] ?? [],
    graph.implementedFrom?.[symbol] ?? [],
    graph.supertypes?.[symbol] ?? [],
    graph.subtypes?.[symbol] ?? [],
  ]) {
    for (const s of arr) set.add(s);
  }
  return [...set];
}

function normalize(raw: number, max: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (!Number.isFinite(max) || max <= 0) return 0;
  return clamp01(raw / max);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function safeNonNegative(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function emptyBlastBreakdown(missing: boolean): BlastRadiusBreakdown {
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

function emptyRiskBreakdown(missing: boolean): ChangeRiskBreakdown {
  return {
    changeCount: 0,
    fixCount: 0,
    connectivity: 0,
    instability: 0,
    changeCountNormalized: 0,
    fixCountNormalized: 0,
    connectivityNormalized: 0,
    instabilityNormalized: 0,
    memoryMissing: missing,
  };
}