/**
 * withSignals — Higher-Order Function that wraps a leaf so its native output
 * becomes a ToolResult<T> envelope.
 *
 * This is OPT-IN. Existing leaf tools in `src/mcp-server.ts` that registered
 * before this module existed keep returning their native shapes. New tools may
 * wrap themselves with `withSignals(toolFn)` (or, when registered as MCP tools,
 * via `wrapLeaf(name, fn)` in `src/mcp-server.ts`) to opt into the envelope.
 *
 * Design rules (PRD FR-1, FR-2, P0):
 *   - `withSignals` returns a NEW function. It does NOT mutate the leaf.
 *   - The wrapper synchronously executes the leaf and returns a ToolResult.
 *   - If the leaf returns a string, number, or plain object that is already a
 *     ToolResult, it is passed through. Otherwise the leaf's return value
 *     becomes `data` unchanged.
 *   - Reasoning facts passed in are inherited; the leaf's `fact` (if any) is
 *     appended via `appendReasoning` from the bus. The wrapper also accepts
 *     `prevReasoning` so it can be chained in a session.
 *   - Confidence is derived from the leaf's optional `confidence` field on
 *     the returned payload, falling back to EXTRACTED.
 */

import {
  confidenceToTier,
  makeToolResult,
  type ConfidenceTier,
  type ReasoningFact,
  type Signal,
  type Source,
  type ToolResult,
} from './types.js';

export interface WithSignalsOptions {
  /** Initial signals to attach to the envelope. */
  signals?: Signal[];
  /** Initial reasoning facts (e.g. inherited from a prior call). */
  prevReasoning?: ReasoningFact[];
  /** Initial sources (e.g. files/symbols the caller already touched). */
  prevSources?: Source[];
  /** Override confidence tier; when omitted, derived from data.confidence. */
  confidence_tier?: ConfidenceTier;
  /** Name of the leaf — used as default `source` for reasoning facts. */
  name?: string;
}

/** Detect whether a value is already a ToolResult envelope. */
export function isToolResult(value: unknown): value is ToolResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    'data' in v &&
    'signals' in v &&
    'reasoning' in v &&
    'sources' in v &&
    'confidence_tier' in v
  );
}

/** Detect whether a payload field looks like a confidence float. */
function readConfidence(data: unknown): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const v = data as Record<string, unknown>;
  if (typeof v['confidence'] === 'number') return v['confidence'];
  if (typeof v['score'] === 'number') return v['score'];
  return undefined;
}

/**
 * Wrap a leaf function so it returns a `ToolResult<T>` envelope.
 *
 * The leaf may return:
 *   - a ToolResult already (pass-through with merged defaults),
 *   - a plain payload with optional `confidence` field,
 *   - any other native shape (string, array, plain object).
 */
export function withSignals<TArgs extends unknown[], T>(
  toolFn: (...args: TArgs) => T | Promise<T>,
  opts: WithSignalsOptions = {},
): (...args: TArgs) => Promise<ToolResult<T>> {
  return async (...args: TArgs): Promise<ToolResult<T>> => {
    const raw = await toolFn(...args);

    if (isToolResult(raw)) {
      // Pass-through: leaf already produced an envelope. Merge with defaults.
      const incoming = raw as ToolResult<T>;
      return {
        ...incoming,
        signals: incoming.signals ?? opts.signals ?? [],
        reasoning: incoming.reasoning ?? opts.prevReasoning ?? [],
        sources: incoming.sources ?? opts.prevSources ?? [],
        confidence_tier: incoming.confidence_tier ?? opts.confidence_tier ?? 'EXTRACTED',
      };
    }

    const confidence = readConfidence(raw);
    const tier = opts.confidence_tier ?? confidenceToTier(confidence);

    return makeToolResult<T>(raw, {
      signals: opts.signals ?? [],
      reasoning: opts.prevReasoning ?? [],
      sources: opts.prevSources ?? [],
      confidence_tier: tier,
    });
  };
}