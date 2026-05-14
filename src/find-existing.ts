/**
 * find-existing.ts
 *
 * Pre-write duplicate detection: given a plain-language description of what an
 * AI agent is about to implement, searches the indexed codebase for existing
 * symbols that already cover the same concern.
 *
 * Designed to be called as the FIRST step in any code-generation workflow so
 * that agents know whether to extend existing code or create something new.
 */

import * as path from 'path';
import { queryProject } from './indexer-run.js';
import { loadGraphAsync } from './graph.js';
import { getDataDir } from './git.js';
import { rerankByAttentionAsync } from './cognition/attention/engine.js';

// ── Score thresholds ──────────────────────────────────────────────────────────
// Calibrated so that genuinely similar code surfaces above 0.68 while
// tangentially related utilities stay below it.
// Exported so callers (e.g. agent-ops.ts) can reuse the same values without
// duplicating the constants.
export const THRESHOLD_DUPLICATE = 0.82;
export const THRESHOLD_PARTIAL   = 0.68;

export type ExistingMatchTier = 'LIKELY_DUPLICATE' | 'PARTIAL_MATCH';
export type FindExistingVerdict = 'MATCH_FOUND' | 'PARTIAL_MATCH' | 'SAFE_TO_CREATE';

export interface ExistingMatch {
  symbol: string;
  file: string;
  similarityScore: number;
  /** Number of callers in the call graph — higher = more widely used. */
  usageCount: number;
  tier: ExistingMatchTier;
  /** Plain-language recommendation for the agent. */
  recommendation: string;
}

export interface FindExistingResult {
  /** Top-level verdict an agent can act on immediately. */
  verdict: FindExistingVerdict;
  matches: ExistingMatch[];
  /** Human-readable summary of the verdict and top matches. */
  summary: string;
  description: string;
}

function tierOf(score: number): ExistingMatchTier | null {
  if (score >= THRESHOLD_DUPLICATE) return 'LIKELY_DUPLICATE';
  if (score >= THRESHOLD_PARTIAL)   return 'PARTIAL_MATCH';
  return null;
}

function recommendation(tier: ExistingMatchTier, symbol: string, file: string, usageCount: number): string {
  if (tier === 'LIKELY_DUPLICATE') {
    return usageCount > 3
      ? `Extend or reuse \`${symbol}\` (${file}) — it is used in ${usageCount} places and covers this concern closely.`
      : `Consider reusing \`${symbol}\` (${file}) before creating a new implementation.`;
  }
  return `\`${symbol}\` (${file}) partially overlaps — review it first to avoid duplicating logic.`;
}

function buildSummary(verdict: FindExistingVerdict, matches: ExistingMatch[]): string {
  if (verdict === 'SAFE_TO_CREATE') {
    return 'No sufficiently similar code found. Safe to create a new implementation.';
  }
  const top = matches[0];
  if (verdict === 'MATCH_FOUND') {
    return `MATCH FOUND: \`${top.symbol}\` (${top.file}, similarity ${top.similarityScore.toFixed(2)}, ${top.usageCount} callers). ${top.recommendation}`;
  }
  return `PARTIAL MATCH: ${matches.length} partially overlapping symbol(s) found. Review before writing new code. Top: \`${top.symbol}\` (${top.file}, similarity ${top.similarityScore.toFixed(2)}).`;
}

export async function findExisting(
  projectRoot: string,
  description: string,
  qdrantUrl = 'http://localhost:6333',
  limit = 6,
): Promise<FindExistingResult> {
  const root = path.resolve(projectRoot);
  const dataDir = getDataDir(root);
  const graphPath = path.join(dataDir, 'graph.json');

  // 1. Semantic search ranked by attention signal.
  let results = await queryProject(root, description, qdrantUrl);
  results = await rerankByAttentionAsync(root, results);

  // 2. Load the call graph for usage-count enrichment.
  const graph = await loadGraphAsync(graphPath);

  // 3. Classify each result into a tier.
  const matches: ExistingMatch[] = [];
  for (const result of results.slice(0, limit * 3)) {
    const tier = tierOf(result.score);
    if (!tier) continue;

    const usageCount = graph ? (graph.callers[result.symbol]?.length ?? 0) : 0;
    matches.push({
      symbol: result.symbol,
      file: result.file,
      similarityScore: Number(result.score.toFixed(3)),
      usageCount,
      tier,
      recommendation: recommendation(tier, result.symbol, result.file, usageCount),
    });

    if (matches.length >= limit) break;
  }

  // 4. Derive top-level verdict.
  const hasDuplicate = matches.some(m => m.tier === 'LIKELY_DUPLICATE');
  const hasPartial   = matches.some(m => m.tier === 'PARTIAL_MATCH');
  const verdict: FindExistingVerdict = hasDuplicate
    ? 'MATCH_FOUND'
    : hasPartial
      ? 'PARTIAL_MATCH'
      : 'SAFE_TO_CREATE';

  return {
    verdict,
    matches,
    summary: buildSummary(verdict, matches),
    description,
  };
}

export function renderFindExisting(result: FindExistingResult): string {
  const lines: string[] = [
    `Description: ${result.description}`,
    `Verdict: ${result.verdict}`,
    ``,
    result.summary,
  ];

  if (result.matches.length > 0) {
    lines.push('', '## Existing matches');
    for (const match of result.matches) {
      lines.push(
        '',
        `### ${match.symbol} [${match.tier}]`,
        `File: ${match.file}`,
        `Similarity: ${match.similarityScore.toFixed(3)}`,
        `Usage count (callers): ${match.usageCount}`,
        `Recommendation: ${match.recommendation}`,
      );
    }
  }

  return lines.join('\n');
}
