/**
 * reasoning/bus — pure functions for propagating `why[]` between calls.
 *
 * The reasoning chain is the propagating rationale across a session: every
 * ToolResult carries `reasoning: ReasoningFact[]`; meta-tools MUST chain via
 * `inheritReasoning` (PRD FR-4).
 *
 * Both functions are pure — no I/O, no shared state, deterministic.
 */

/** A reasoning fact — a `why[]` line carried in a ToolResult envelope. */
export interface ReasoningFact {
  fact: string;
  source?: string;
}

/**
 * Take ownership of facts produced by a prior call.
 *
 * Accepts either `ReasoningFact[]` or plain `string[]` (treated as `{ fact }`).
 * Returns a new array — does not mutate the input. Entries with no `source`
 * stay source-less (the field is omitted from the object, not set to undefined).
 */
export function inheritReasoning(prevFacts: readonly (ReasoningFact | string)[]): ReasoningFact[] {
  if (!prevFacts || prevFacts.length === 0) return [];
  const out: ReasoningFact[] = [];
  for (const f of prevFacts) {
    if (typeof f === 'string') {
      out.push({ fact: f });
    } else {
      const entry: ReasoningFact = { fact: f.fact };
      if (f.source !== undefined) entry.source = f.source;
      out.push(entry);
    }
  }
  return out;
}

/**
 * Append a single fact to an existing chain, deduplicating adjacent identical
 * facts. Returns a new array — does not mutate the input.
 *
 * "Adjacent identical" means the last entry's `fact` equals the new fact's
 * `fact`. This is the cheap dedupe that prevents a long chain from filling
 * with the same fact re-emitted by every call.
 *
 * Empty / whitespace-only facts are ignored.
 */
export function appendReasoning(prev: readonly (ReasoningFact | string)[], fact: ReasoningFact | string): ReasoningFact[] {
  const chain = inheritReasoning(prev);
  const next: ReasoningFact = typeof fact === 'string' ? { fact } : { fact: fact.fact, source: fact.source };
  if (!next.fact || !next.fact.trim()) return chain;
  const last = chain[chain.length - 1];
  if (last && last.fact === next.fact && (last.source ?? '') === (next.source ?? '')) {
    return chain;
  }
  chain.push(next);
  return chain;
}