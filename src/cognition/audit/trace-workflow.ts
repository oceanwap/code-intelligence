/**
 * trace-workflow — US-005 P3b `trace_workflow` meta-tool.
 *
 * Given a target symbol, build a numbered narrative of the runtime path
 * (inbound callers + outbound callees within 2-3 hops) plus a Mermaid
 * `sequenceDiagram` block that round-trips through the parser fixture.
 *
 * Reuse rules (PRD hard constraints):
 *   - Expand via `expandGraphBfs` (already used by `expand_graph` MCP tool).
 *   - Side effects per symbol come from `graph.sideEffects[symbol]`, the
 *     same source `render_behavior` reads.
 *   - Reasoning chain via `inheritReasoning` / `appendReasoning` (US-001).
 *   - Blackboard write via `appendScratchpad` (FR-3) when opt-in (default on).
 *   - No LLM; deterministic for a fixed graph + scratchpad.
 *
 * Failure mode (FR-1): when the graph is missing, the meta-tool returns a
 * `ToolResult` with a typed empty narrative + an `audit_symbol`-style
 * `trace_workflow.leaf_missing` signal. Never throws on leaf absence.
 */

import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { loadGraphAsync } from '../../graph.js';
import { getDataDir } from '../../git.js';
import { type SideEffect } from '../../behavior-graph.js';
import { expandGraphBfs, type GraphExpansionResult } from '../../symbol-lookup.js';
import {
  makeToolResult,
  type ToolResult,
  type Signal,
  type Source,
  type ReasoningFact,
} from '../signalization/types.js';
import { inheritReasoning } from '../reasoning/bus.js';
import { appendScratchpad, readScratchpad } from '../blackboard/scratchpad.js';
import { validateGraphPath } from '../../utils/security.js';
import type { MetaToolOptions } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Sequence-diagram participant extracted from the trace. */
export interface TraceParticipant {
  /** Symbol name as it appears in the graph. */
  symbol: string;
  /** Display label (sanitized). */
  label: string;
  /** Whether this is the seed symbol. */
  isRoot: boolean;
}

/** One numbered step in the level-order narrative. */
export interface TraceStep {
  /** 1-indexed step number, level-order. */
  index: number;
  /** BFS depth from the root (0 = root). */
  hop: number;
  /** The symbol at this step. */
  symbol: string;
  /** Inbound callers (within `hops`). */
  callers: string[];
  /** Outbound callees (within `hops`). */
  callees: string[];
  /** Side effects recorded for this symbol (from graph.sideEffects). */
  sideEffects: SideEffect[];
  /** Direction relative to the root: 'root' | 'outbound' | 'inbound'. */
  direction: 'root' | 'outbound' | 'inbound';
  /** One-line human summary for the narrative. */
  summary: string;
}

/** Tool result payload for `trace_workflow`. */
export interface TraceWorkflowPayload {
  /** Symbol the trace was computed for. */
  symbol: string;
  /** Number of hops requested (2 or 3). */
  hops: number;
  /** Participants extracted from the trace, in declaration order. */
  participants: TraceParticipant[];
  /** Numbered, level-order trace steps. */
  steps: TraceStep[];
  /** Numbered narrative lines (1. ..., 2. ..., ...). */
  narrative: string[];
  /** Single joined narrative string. Always non-empty when steps>0. */
  narrativeText: string;
  /** Mermaid sequenceDiagram block (between `\`\`\`mermaid` fences). */
  sequenceDiagram: string;
  /** Total reachable symbols after expansion. */
  reachableCount: number;
  /** True when the BFS expansion was capped at 60. */
  capped: boolean;
  /** Pre-call facts inherited from the scratchpad (FR-4). */
  inheritedFacts: number;
  /**
   * FIX F5: maximum number of prior scratchpad entries the meta-tool
   * pulls into its reasoning chain. Surfaced so callers can reason
   * about the deterministic upper bound. The current cap is
   * `INHERITED_FACTS_CAP` (20) at the top of this file.
   */
  inheritedFactsCap: number;
  /** Reasoning chain. */
  reasoning_chain: ReasoningFact[];
}

/** Input shape for `traceWorkflowAsync`. */
export interface TraceWorkflowInput {
  projectRoot: string;
  symbol: string;
  /** 2 or 3 (default 2). */
  hops?: 2 | 3;
  qdrantUrl?: string;
  writeToBlackboard?: boolean;
  sessionId?: string;
}

const DEFAULT_HOPS = 2;
const MAX_STEPS = 30; // narrative + sequence cap
// FIX F5: cap the inherited facts pulled from the scratchpad append-log.
// The previous implementation walked the full log on every call, so a
// long-running session's `inheritedFacts` count grew unbounded and the
// reasoning chain pulled in arbitrarily many prior facts. We keep the
// most recent INHERITED_FACTS_CAP entries — that is the deterministic
// upper bound surfaced to the caller in the payload.
const INHERITED_FACTS_CAP = 20;

/**
 * Run `trace_workflow`.
 *
 * Always returns a ToolResult. Never throws on missing graph; the payload
 * contains typed empty values + a leaf_missing signal in that case.
 */
export async function traceWorkflowAsync(
  input: TraceWorkflowInput,
): Promise<ToolResult<TraceWorkflowPayload>> {
  const projectRoot = path.resolve(input.projectRoot);
  validateGraphPath(projectRoot, 'trace_workflow');
  const symbol = input.symbol;
  // Strict hops validation: only 2 or 3 are accepted (PRD US-005 AC).
  // Anything else falls back to the default (2). FR-1 / fail-loud: we
  // never throw on bad input — we coerce.
  const hops: 2 | 3 = input.hops === 3 ? 3 : input.hops === 2 ? 2 : DEFAULT_HOPS;
  const writeToBlackboard = input.writeToBlackboard !== false;
  const sessionId = input.sessionId ?? `trace-workflow:${symbolSessionHash(symbol)}`;
  const qdrantUrl = input.qdrantUrl ?? 'http://localhost:6333';
  void qdrantUrl;

  const signals: Signal[] = [];
  const sources: Source[] = [
    { kind: 'symbol', ref: symbol },
    { kind: 'tool', ref: 'trace_workflow' },
  ];
  const reasoning: ReasoningFact[] = [];

  // ── Read prior blackboard facts (FR-4) ────────────────────────────────────
  // FIX F5: cap inherited facts at the last INHERITED_FACTS_CAP entries
  // of the append-log. Earlier entries are dropped — the reasoning
  // chain pulls in at most INHERITED_FACTS_CAP facts and the cap is
  // surfaced in the payload via `inheritedFactsCap` so callers can
  // reason about it.
  const priorEntries = await readScratchpad(sessionId, { projectRoot });
  const recentEntries = priorEntries.slice(-INHERITED_FACTS_CAP);
  const priorFacts: ReasoningFact[] = [];
  for (const entry of recentEntries) {
    if (Array.isArray(entry.reasoning)) {
      for (const f of entry.reasoning) {
        if (typeof f === 'string' && f.trim()) priorFacts.push({ fact: f });
      }
    }
  }
  reasoning.push(...inheritReasoning(priorFacts));
  const inheritedFacts = reasoning.length;

  // Leading fact.
  reasoning.push({ fact: `trace_workflow called for ${symbol} hops=${hops}`, source: 'trace_workflow' });

  // ── Load graph (FR-1 fail-loud typed empty) ──────────────────────────────
  const graph = await loadGraphAsync(path.join(getDataDir(projectRoot), 'graph.json')).catch(() => null);
  if (!graph) {
    signals.push({ kind: 'trace_workflow.leaf_missing', payload: { leaf: 'graph' } });
    const empty = emptyPayload(symbol, hops, inheritedFacts, reasoning);
    const result = makeToolResult<TraceWorkflowPayload>(empty, {
      signals,
      sources,
      reasoning,
      confidence_tier: 'AMBIGUOUS',
    });
    if (writeToBlackboard) {
      await appendScratchpad(sessionId, {
        ts: new Date().toISOString(),
        tool: 'trace_workflow',
        data: result.data,
        reasoning: result.reasoning.map(f => f.fact),
        confidence_tier: result.confidence_tier,
        sessionId,
      }, { projectRoot });
    }
    return result;
  }

  // ── BFS expansion (2-3 hops, both directions) ───────────────────────────
  const expansion: GraphExpansionResult = expandGraphBfs(graph, [symbol], hops, 'both');
  const reachable = [...expansion.discovered];
  reasoning.push({
    fact: `expand_graph: ${reachable.length} reachable symbol(s) within ${hops} hops of ${symbol}${expansion.capped ? ' (capped at 60)' : ''}`,
    source: 'expand_graph',
  });

  // ── Build the level-order step list ──────────────────────────────────────
  const steps = buildSteps(graph, symbol, hops, reachable, signals, reasoning);
  const narrative = steps.map((s) => formatNarrativeLine(s));
  const narrativeText = narrative.length > 0
    ? narrative.join('\n')
    : `No reachable symbols within ${hops} hop(s) of ${symbol}.`;

  // ── Build Mermaid sequenceDiagram ────────────────────────────────────────
  const sequenceDiagram = renderMermaidSequenceDiagram(symbol, steps);

  // ── Participants (root first, then declared order) ───────────────────────
  const participants = buildParticipants(symbol, steps);

  const data: TraceWorkflowPayload = {
    symbol,
    hops,
    participants,
    steps,
    narrative,
    narrativeText,
    sequenceDiagram,
    reachableCount: reachable.length,
    capped: expansion.capped,
    inheritedFacts,
    inheritedFactsCap: INHERITED_FACTS_CAP,
    reasoning_chain: reasoning,
  };

  const tier = steps.length === 0 ? 'AMBIGUOUS' : 'EXTRACTED';
  const result = makeToolResult<TraceWorkflowPayload>(data, {
    signals,
    sources,
    reasoning,
    confidence_tier: tier,
  });

  if (writeToBlackboard) {
    await appendScratchpad(sessionId, {
      ts: new Date().toISOString(),
      tool: 'trace_workflow',
      data: result.data,
      reasoning: result.reasoning.map(f => f.fact),
      confidence_tier: result.confidence_tier,
      sessionId,
    }, { projectRoot });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step construction (level-order)
// ---------------------------------------------------------------------------

/**
 * Build level-order trace steps. We cap at `MAX_STEPS` to keep the
 * narrative + Mermaid block bounded.
 */
function buildSteps(
  graph: NonNullable<Awaited<ReturnType<typeof loadGraphAsync>>>,
  root: string,
  hops: number,
  reachable: string[],
  signals: Signal[],
  reasoning: ReasoningFact[],
): TraceStep[] {
  const reachableSet = new Set(reachable);
  // Always include the root even if it has no edges.
  reachableSet.add(root);
  // Level-order BFS to assign hop depth. We treat inbound + outbound equally
  // (root is depth 0, all direct neighbors depth 1, etc).
  const depths = new Map<string, number>();
  depths.set(root, 0);
  let frontier = new Set<string>([root]);
  for (let hop = 1; hop <= hops; hop++) {
    const next = new Set<string>();
    for (const sym of frontier) {
      const out = graph.symbols?.[sym] ?? [];
      const inn = graph.callers?.[sym] ?? [];
      for (const neighbor of [...out, ...inn]) {
        if (!reachableSet.has(neighbor)) continue;
        if (!depths.has(neighbor) || (depths.get(neighbor) ?? 0) > hop) {
          depths.set(neighbor, hop);
          next.add(neighbor);
        }
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }

  // Stable ordering: hop asc, direction (root > outbound > inbound), symbol asc.
  const directionOf = (sym: string): TraceStep['direction'] => {
    if (sym === root) return 'root';
    if ((graph.symbols?.[root] ?? []).includes(sym)) return 'outbound';
    if ((graph.callers?.[root] ?? []).includes(sym)) return 'inbound';
    return 'outbound';
  };
  const ordered = [...reachableSet]
    .filter((s) => depths.has(s))
    .sort((a, b) => {
      const da = depths.get(a) ?? 0;
      const db = depths.get(b) ?? 0;
      if (da !== db) return da - db;
      const order: Record<TraceStep['direction'], number> = { root: 0, outbound: 1, inbound: 2 };
      const dord = order[directionOf(a)] - order[directionOf(b)];
      if (dord !== 0) return dord;
      return a.localeCompare(b);
    })
    .slice(0, MAX_STEPS);

  const steps: TraceStep[] = [];
  let idx = 1;
  for (const sym of ordered) {
    const hop = depths.get(sym) ?? 0;
    const callers = (graph.callers?.[sym] ?? []).filter((c) => reachableSet.has(c));
    const callees = (graph.symbols?.[sym] ?? []).filter((c) => reachableSet.has(c));
    const sideEffects = (graph.sideEffects?.[sym] ?? []) as SideEffect[];
    const direction = directionOf(sym);
    const summary = describeStep(sym, hop, direction, callers, callees, sideEffects);
    const step: TraceStep = {
      index: idx++,
      hop,
      symbol: sym,
      callers,
      callees,
      sideEffects,
      direction,
      summary,
    };
    steps.push(step);

    if (sideEffects.length > 0) {
      reasoning.push({
        fact: `render_behavior: ${sideEffects.length} side effect(s) for ${sym}`,
        source: 'render_behavior',
      });
    }
  }

  if (ordered.length === 0) {
    signals.push({ kind: 'trace_workflow.empty_trace', payload: { symbol: root, hops } });
  }

  return steps;
}

function describeStep(
  symbol: string,
  hop: number,
  direction: TraceStep['direction'],
  callers: string[],
  callees: string[],
  sideEffects: SideEffect[],
): string {
  const parts: string[] = [];
  if (direction === 'root') {
    parts.push('root');
  } else if (direction === 'outbound') {
    parts.push(`outbound (depth ${hop})`);
  } else {
    parts.push(`inbound (depth ${hop})`);
  }
  if (callers.length > 0) parts.push(`callers=[${callers.join(', ')}]`);
  if (callees.length > 0) parts.push(`callees=[${callees.join(', ')}]`);
  if (sideEffects.length > 0) {
    const kinds = [...new Set(sideEffects.map((e) => e.kind))].join(',');
    parts.push(`side-effects=[${kinds}]`);
  }
  return `${symbol}: ${parts.join('; ')}`;
}

function formatNarrativeLine(step: TraceStep): string {
  return `${step.index}. ${step.summary}`;
}

function buildParticipants(root: string, steps: TraceStep[]): TraceParticipant[] {
  const seen = new Set<string>();
  const out: TraceParticipant[] = [];
  // Root first
  out.push({ symbol: root, label: root, isRoot: true });
  seen.add(root);
  for (const step of steps) {
    if (step.symbol === root) continue;
    if (seen.has(step.symbol)) continue;
    seen.add(step.symbol);
    out.push({ symbol: step.symbol, label: step.symbol, isRoot: false });
  }
  return out;
}

function emptyPayload(
  symbol: string,
  hops: number,
  inheritedFacts: number,
  reasoning: ReasoningFact[],
): TraceWorkflowPayload {
  return {
    symbol,
    hops,
    participants: [{ symbol, label: symbol, isRoot: true }],
    steps: [],
    narrative: [],
    narrativeText: `No graph available for ${symbol}; run index_project first.`,
    sequenceDiagram: `sequenceDiagram\n  participant ${symbol}\n  Note over ${symbol}: project not indexed`,
    reachableCount: 0,
    capped: false,
    inheritedFacts,
    inheritedFactsCap: INHERITED_FACTS_CAP,
    reasoning_chain: reasoning,
  };
}

// ---------------------------------------------------------------------------
// Mermaid sequence-diagram emitter
// ---------------------------------------------------------------------------

/**
 * Build a Mermaid `sequenceDiagram` block. The output is a single string
 * containing the diagram body (no surrounding fences). The parser fixture
 * in `test/trace-workflow.test.ts` accepts the exact subset this emitter
 * produces.
 */
export function renderMermaidSequenceDiagram(root: string, steps: TraceStep[]): string {
  if (steps.length === 0) {
    return `sequenceDiagram\n  participant ${mermaidId(root)}\n  Note over ${mermaidId(root)}: no reachable symbols`;
  }
  const lines: string[] = ['sequenceDiagram'];
  lines.push(`  participant ${mermaidId(root)} as ${root}`);

  // Declare each non-root participant
  const declared = new Set<string>([root]);
  for (const step of steps) {
    if (step.symbol === root) continue;
    if (declared.has(step.symbol)) continue;
    declared.add(step.symbol);
    lines.push(`  participant ${mermaidId(step.symbol)} as ${step.symbol}`);
  }

  // Edges: for the root, emit its callees. For each subsequent step, emit
  // a representative edge back toward the root (or a forward callee).
  for (const step of steps) {
    if (step.symbol === root) {
      // Root → its direct callees
      for (const callee of step.callees) {
        if (!declared.has(callee)) continue;
        lines.push(`  ${mermaidId(root)}->>${mermaidId(callee)}: call`);
      }
      // And its direct callers → root
      for (const caller of step.callers) {
        if (!declared.has(caller)) continue;
        lines.push(`  ${mermaidId(caller)}->>${mermaidId(root)}: invoke`);
      }
    } else {
      // For a non-root step, find the first neighbor that is closer to the
      // root (callers first, then callees) and emit an edge to it.
      const bridge =
        step.callers.find((c) => declared.has(c)) ??
        step.callees.find((c) => declared.has(c)) ??
        root;
      const dir = step.callers.includes(bridge) ? '<--' : '->>';
      const verb = step.callers.includes(bridge) ? 'invoke' : 'call';
      lines.push(`  ${mermaidId(bridge)} ${dir} ${mermaidId(step.symbol)}: ${verb}`);
    }
    // Side-effect note for any step with effects.
    if (step.sideEffects.length > 0) {
      const kinds = [...new Set(step.sideEffects.map((e) => e.kind))].slice(0, 3).join(',');
      lines.push(`  Note right of ${mermaidId(step.symbol)}: ${kinds}`);
    }
  }

  return lines.join('\n');
}

/**
 * Map a symbol name to a Mermaid-legal participant identifier. Mermaid
 * disallows spaces, dots, parens, and a few other chars; we replace them
 * with underscores and ensure the result is non-empty.
 */
export function mermaidId(symbol: string): string {
  if (!symbol) return '_';
  const cleaned = symbol.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : '_';
}

// ---------------------------------------------------------------------------
// Mermaid sequence-diagram parser (round-trip fixture, exported for tests)
// ---------------------------------------------------------------------------

export interface MermaidParseResult {
  participants: string[];
  messages: Array<{ from: string; to: string; arrow: string; text: string }>;
  notes: Array<{ owner: string; text: string }>;
}

/**
 * Parse a Mermaid sequence-diagram body. Accepts the exact subset produced
 * by `renderMermaidSequenceDiagram`:
 *   - `sequenceDiagram` header
 *   - `participant A as A` declarations
 *   - `A->>B: text` messages
 *   - `A-->>B: text` messages
 *   - `Note right of A: text` notes
 *
 * Throws on any unrecognized line — that is the round-trip guarantee.
 */
export function parseMermaidSequenceDiagram(body: string): MermaidParseResult {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('Mermaid: empty body');
  if (lines[0] !== 'sequenceDiagram') {
    throw new Error(`Mermaid: expected first line "sequenceDiagram", got "${lines[0]}"`);
  }
  const result: MermaidParseResult = { participants: [], messages: [], notes: [] };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const participant = /^participant\s+(\S+)(?:\s+as\s+(.+))?$/.exec(line);
    if (participant) {
      const id = participant[1]!;
      const label = (participant[2] ?? id).trim();
      if (result.participants.includes(id)) {
        throw new Error(`Mermaid: duplicate participant "${id}"`);
      }
      result.participants.push(id);
      continue;
    }
    const message = /^(\S+)\s*(->>|-->>|->|-->|<--|<-->>)\s*(\S+)\s*:\s*(.*)$/.exec(line);
    if (message) {
      const from = message[1]!;
      const arrow = message[2]!;
      const to = message[3]!;
      const text = message[4] ?? '';
      if (!result.participants.includes(from)) {
        throw new Error(`Mermaid: message from undeclared participant "${from}"`);
      }
      if (!result.participants.includes(to)) {
        throw new Error(`Mermaid: message to undeclared participant "${to}"`);
      }
      result.messages.push({ from, to, arrow, text });
      continue;
    }
    const note = /^Note\s+(right|left|over)\s+(?:of\s+)?([^:]+):\s*(.*)$/.exec(line);
    if (note) {
      const owner = note[2]!.trim();
      const text = note[3] ?? '';
      if (!result.participants.includes(owner)) {
        throw new Error(`Mermaid: note on undeclared participant "${owner}"`);
      }
      result.notes.push({ owner, text });
      continue;
    }
    throw new Error(`Mermaid: unrecognized line "${line}"`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Deterministic 8-char hash for the per-symbol session id. */
export function symbolSessionHash(symbol: string): string {
  return crypto.createHash('sha1').update(symbol).digest('hex').slice(0, 8);
}
