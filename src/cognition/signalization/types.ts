/**
 * ToolResult<T> — the signalization envelope.
 *
 * This is the ONLY shape that meta-tools (Layer 3 / Layer 4) emit. Existing leaf
 * tools in Layer 1 keep their native return shapes; meta-tools wrap their leaves
 * with `withSignals` (see ./builder.ts) to produce a ToolResult.
 *
 * Envelope shape (PRD FR-1):
 *   data             — the leaf's native payload, untouched
 *   signals          — typed hints for downstream fusion (sort/rank/gate)
 *   reasoning        — accumulated `why[]` facts propagated via reasoning/bus
 *   sources          — graph symbols, file paths, or external systems touched
 *   confidence_tier  — extracted vs inferred vs ambiguous label
 *
 * confidence_tier enum (PRD FR-1 / P1-5):
 *   EXTRACTED  — directly parsed from source (>= 0.80 confidence)
 *   INFERRED   — derived by analysis but not literal in source (>= 0.50)
 *   AMBIGUOUS  — low confidence (< 0.50); needs human review
 *
 * The default for leaves that did NOT run through `withSignals` is `EXTRACTED`
 * because the leaf's native output is taken at face value. `withSignals` may
 * demote the tier if the wrapper detected heuristic inference (e.g. pattern
 * matching, type guessing, confidence < 0.8).
 */

/** Confidence tier for a leaf's output. */
export const CONFIDENCE_TIERS = ['EXTRACTED', 'INFERRED', 'AMBIGUOUS'] as const;
export type ConfidenceTier = (typeof CONFIDENCE_TIERS)[number];

/**
 * Convert a numeric confidence (0..1) to a tier label using the PRD thresholds.
 * >=0.80 EXTRACTED, >=0.50 INFERRED, else AMBIGUOUS. Out-of-range values are
 * clamped before classification.
 */
export function confidenceToTier(confidence: number | undefined | null): ConfidenceTier {
  if (confidence == null || Number.isNaN(confidence)) return 'EXTRACTED';
  const c = Math.max(0, Math.min(1, confidence));
  if (c >= 0.8) return 'EXTRACTED';
  if (c >= 0.5) return 'INFERRED';
  return 'AMBIGUOUS';
}

/** A signal — a typed hint surfaced by a leaf for downstream fusion. */
export interface Signal {
  kind: string;
  payload?: Record<string, unknown>;
}

/** A reasoning fact — a `why[]` line in the propagated reasoning chain. */
export interface ReasoningFact {
  fact: string;
  source?: string;
}

/** A source — a graph symbol, file path, or external system touched. */
export interface Source {
  kind: 'symbol' | 'file' | 'external' | 'tool';
  ref: string;
}

/** The signalization envelope. Generic over the leaf's native payload. */
export interface ToolResult<T = unknown> {
  data: T;
  signals: Signal[];
  reasoning: ReasoningFact[];
  sources: Source[];
  confidence_tier: ConfidenceTier;
}

/** Helper to build a ToolResult with sensible defaults. */
export function makeToolResult<T>(data: T, opts?: {
  signals?: Signal[];
  reasoning?: ReasoningFact[];
  sources?: Source[];
  confidence_tier?: ConfidenceTier;
}): ToolResult<T> {
  return {
    data,
    signals: opts?.signals ?? [],
    reasoning: opts?.reasoning ?? [],
    sources: opts?.sources ?? [],
    confidence_tier: opts?.confidence_tier ?? 'EXTRACTED',
  };
}