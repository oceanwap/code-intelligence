/**
 * audit/session-status — US-006 P4 read-only `session_status` tool.
 *
 * Returns a read-only view of the per-session blackboard + reasoning chain
 * + composite scores touched. Refuses to mutate the scratchpad (FR-9).
 *
 * Output shape:
 *   - entries:     number of scratchpad entries
 *   - lastUpdated: ISO timestamp of the most recent entry
 *   - toolsUsed:   distinct tool names invoked in the session (sorted asc)
 *   - topSymbols:  distinct symbol names referenced in the session
 *                  (sorted asc, capped at 10)
 *   - reasoning:   flattened reasoning facts (deduped)
 *
 * Read-only contract (FR-9):
 *   - We never call `appendScratchpad` from this module.
 *   - We never call `clearScratchpad` from this module.
 *   - We never call any composite-score write.
 *   - The function is pure w.r.t. the filesystem: only `readScratchpad`.
 *
 * Failure mode (FR-1 / fail-loud, fail-typed):
 *   - missing session (no entries) → returns zeros + a friendly message
 *   - malformed scratchpad line → skipped (handled by readScratchpad)
 */

import * as path from 'node:path';

import { readScratchpad, type ScratchpadEntry } from '../blackboard/scratchpad.js';
import { validateGraphPath } from '../../utils/security.js';
import {
  makeToolResult,
  type ToolResult,
  type Signal,
  type Source,
  type ReasoningFact,
} from '../signalization/types.js';
import { inheritReasoning } from '../reasoning/bus.js';

const MAX_TOP_SYMBOLS = 10;

/**
 * Payload returned by `sessionStatusAsync`.
 */
export interface SessionStatusPayload {
  /** Session id inspected. */
  sessionId: string;
  /** Number of scratchpad entries. */
  entries: number;
  /** ISO timestamp of the most recent entry (or `null` when empty). */
  lastUpdated: string | null;
  /** Distinct tool names invoked, sorted asc. */
  toolsUsed: string[];
  /** Distinct symbol names referenced, sorted asc, capped at 10. */
  topSymbols: string[];
  /** Number of distinct symbols touched (capped indicator). */
  distinctSymbolsCount: number;
  /** True when the session had no entries. */
  empty: boolean;
  /** Most recent scratchpad entry (the head of the append-log). */
  lastEntry: ScratchpadEntry | null;
  /** Reasoning chain. */
  reasoning_chain: ReasoningFact[];
}

export interface SessionStatusInput {
  projectRoot: string;
  sessionId: string;
  qdrantUrl?: string;
}

export async function sessionStatusAsync(
  input: SessionStatusInput,
): Promise<ToolResult<SessionStatusPayload>> {
  const projectRoot = path.resolve(input.projectRoot);
  validateGraphPath(projectRoot, 'session_status');
  const sessionId = input.sessionId;
  void input.qdrantUrl;

  const signals: Signal[] = [];
  const sources: Source[] = [
    { kind: 'tool', ref: 'session_status' },
    { kind: 'external', ref: `session: ${sessionId}` },
  ];
  const reasoning: ReasoningFact[] = [];

  let prior: ScratchpadEntry[] = [];
  try {
    prior = await readScratchpad(sessionId, { projectRoot });
  } catch (error) {
    // Bad input (e.g. empty sessionId) → return typed empty + signal.
    signals.push({ kind: 'session_status.read_failed', payload: { sessionId, message: (error as Error).message } });
    const data: SessionStatusPayload = {
      sessionId,
      entries: 0,
      lastUpdated: null,
      toolsUsed: [],
      topSymbols: [],
      distinctSymbolsCount: 0,
      empty: true,
      lastEntry: null,
      reasoning_chain: [{ fact: `session_status failed to read ${sessionId}: ${(error as Error).message}`, source: 'session_status' }],
    };
    return makeToolResult<SessionStatusPayload>(data, {
      signals,
      sources,
      reasoning: data.reasoning_chain,
      confidence_tier: 'AMBIGUOUS',
    });
  }

  reasoning.push(...inheritReasoning(prior.flatMap((e) => Array.isArray(e.reasoning) ? e.reasoning : [])));
  reasoning.push({ fact: `session_status inspected ${sessionId} (${prior.length} entries)`, source: 'session_status' });

  const toolsUsed = uniqueSorted(prior.map((e) => e.tool).filter((t): t is string => typeof t === 'string'));
  const symbolLike = prior.flatMap((e) => extractSymbolLike(e));
  const distinctSymbols = uniqueSorted(symbolLike);
  const topSymbols = distinctSymbols.slice(0, MAX_TOP_SYMBOLS);

  const lastUpdated = prior.length > 0 ? prior[prior.length - 1]?.ts ?? null : null;
  const lastEntry = prior.length > 0 ? prior[prior.length - 1] ?? null : null;

  if (prior.length === 0) {
    signals.push({ kind: 'session_status.empty', payload: { sessionId } });
  }

  const data: SessionStatusPayload = {
    sessionId,
    entries: prior.length,
    lastUpdated,
    toolsUsed,
    topSymbols,
    distinctSymbolsCount: distinctSymbols.length,
    empty: prior.length === 0,
    lastEntry,
    reasoning_chain: reasoning,
  };

  const tier = prior.length === 0 ? 'AMBIGUOUS' : 'EXTRACTED';
  return makeToolResult<SessionStatusPayload>(data, {
    signals,
    sources,
    reasoning,
    confidence_tier: tier,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueSorted(arr: string[]): string[] {
  return [...new Set(arr)].sort();
}

/**
 * Extract a best-effort symbol-like string from a scratchpad entry. We
 * look for:
 *   - `data.symbol` (audit_symbol / trace_workflow payloads)
 *   - `data.symbols` (the change-graph payload)
 *   - the first Capitalized.dotted token inside any string in the payload
 *
 * Heuristic is intentionally loose — the goal is to surface "what has
 * the agent been looking at?" rather than to fully type-narrow each
 * payload.
 */
function extractSymbolLike(entry: ScratchpadEntry): string[] {
  const out: string[] = [];
  const data = entry.data;
  if (data == null || typeof data !== 'object') return out;
  const obj = data as Record<string, unknown>;
  if (typeof obj['symbol'] === 'string') {
    out.push(obj['symbol']);
  }
  if (Array.isArray(obj['symbols'])) {
    for (const s of obj['symbols']) {
      if (typeof s === 'string') out.push(s);
    }
  }
  if (Array.isArray(obj['changedSymbols'])) {
    for (const s of obj['changedSymbols']) {
      if (typeof s === 'string') out.push(s);
    }
  }
  if (typeof obj['goal'] === 'string') {
    const m = /\b([A-Z][A-Za-z0-9_$]*(?:\.[A-Za-z_$][\w$]*)+)\b/.exec(obj['goal']);
    if (m && m[1]) out.push(m[1]);
  }
  return out;
}
