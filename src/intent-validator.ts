/**
 * intent-validator.ts
 *
 * "Does this proposed change belong in this project?"
 *
 * Scores a plain-language description of a proposed change against three
 * evidence sources that are already maintained by the indexer:
 *   1. Documented feature intent (feature map)
 *   2. Active git topic clusters (project status)
 *   3. Evidence-backed architecture/purpose claims (project intent snapshot)
 *
 * Produces an alignment score and a plain-language verdict so agents can
 * decide whether to proceed or flag the change as potential scope creep.
 */

import * as path from 'path';
import { getFeatureMapAsync, getProjectStatusAsync } from './project-memory.js';
import { buildProjectIntentSnapshot } from './project-intent.js';

export type IntentAlignment = 'HIGH' | 'MEDIUM' | 'LOW';

export interface IntentValidationResult {
  description: string;
  alignmentScore: number;          // 0–1 composite
  alignment: IntentAlignment;
  featureOverlapScore: number;
  topicOverlapScore: number;
  claimOverlapScore: number;
  matchedFeatures: string[];       // feature titles that overlap
  matchedTopics: string[];         // active topics that overlap
  matchedClaims: string[];         // claim statements that overlap
  verdict: string;                 // plain-language verdict for the agent
}

// ── Token helpers ──────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'and', 'or', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'from', 'that', 'this', 'it', 'is', 'are', 'was', 'be', 'as',
  'by', 'new', 'add', 'create', 'build', 'implement', 'make', 'feature',
  'function', 'module', 'system', 'code', 'data', 'type',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length >= 3 && !STOP_WORDS.has(t)),
  );
}

function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Scoring ────────────────────────────────────────────────────────────────────

function scoreFeatures(
  descTokens: Set<string>,
  features: Array<{ title: string; summary: string }>,
): { score: number; matched: string[] } {
  const matched: string[] = [];
  let best = 0;
  for (const f of features) {
    const fTokens = tokenize(`${f.title} ${f.summary}`);
    const overlap = jaccardOverlap(descTokens, fTokens);
    if (overlap > 0.08) matched.push(f.title);
    if (overlap > best) best = overlap;
  }
  return { score: Math.min(1, best * 4), matched: matched.slice(0, 4) };
}

function scoreTopics(
  descTokens: Set<string>,
  activeTopics: Array<{ topic: string; count: number }>,
): { score: number; matched: string[] } {
  const matched: string[] = [];
  let hitWeight = 0;
  let totalWeight = activeTopics.reduce((s, t) => s + t.count, 0) || 1;
  for (const t of activeTopics) {
    const topicTokens = tokenize(t.topic);
    const overlap = jaccardOverlap(descTokens, topicTokens);
    if (overlap > 0) {
      hitWeight += t.count * overlap;
      matched.push(t.topic);
    }
  }
  return { score: Math.min(1, (hitWeight / totalWeight) * 8), matched: matched.slice(0, 5) };
}

function scoreClaims(
  descTokens: Set<string>,
  claims: Array<{ statement: string; confidence: number }>,
): { score: number; matched: string[] } {
  const matched: string[] = [];
  let weightedSum = 0;
  let weightTotal = 0;
  for (const c of claims) {
    const cTokens = tokenize(c.statement);
    const overlap = jaccardOverlap(descTokens, cTokens);
    weightedSum += overlap * c.confidence;
    weightTotal += c.confidence;
    if (overlap > 0.06) matched.push(c.statement.slice(0, 80));
  }
  const score = weightTotal > 0 ? Math.min(1, (weightedSum / weightTotal) * 6) : 0;
  return { score, matched: matched.slice(0, 3) };
}

function alignmentLabel(score: number): IntentAlignment {
  if (score >= 0.55) return 'HIGH';
  if (score >= 0.30) return 'MEDIUM';
  return 'LOW';
}

function buildVerdict(
  description: string,
  alignment: IntentAlignment,
  score: number,
  matchedFeatures: string[],
  matchedTopics: string[],
): string {
  const scoreStr = score.toFixed(2);
  if (alignment === 'HIGH') {
    const context = matchedFeatures.length > 0
      ? `fits documented features: ${matchedFeatures.slice(0, 2).join(', ')}`
      : matchedTopics.length > 0
        ? `aligns with active topics: ${matchedTopics.slice(0, 2).join(', ')}`
        : 'aligns with documented project intent';
    return `HIGH ALIGNMENT (${scoreStr}): "${description}" — ${context}. Proceed.`;
  }
  if (alignment === 'MEDIUM') {
    return `MEDIUM ALIGNMENT (${scoreStr}): "${description}" — partial overlap with project intent. ` +
      `Verify this fits the project scope before proceeding.`;
  }
  return `LOW ALIGNMENT (${scoreStr}): "${description}" — little overlap with documented features ` +
    `(${matchedFeatures.join(', ') || 'none'}), active topics (${matchedTopics.join(', ') || 'none'}), ` +
    `or stated project intent. Confirm this is intentional scope expansion.`;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function validateIntent(
  projectRoot: string,
  description: string,
): Promise<IntentValidationResult> {
  const root = path.resolve(projectRoot);

  const [featureMap, status, snapshot] = await Promise.all([
    getFeatureMapAsync(root),
    getProjectStatusAsync(root),
    buildProjectIntentSnapshot(root),
  ]);

  const descTokens = tokenize(description);

  // Feature score.
  const features = featureMap?.documentedFeatures ?? [];
  const featureResult = scoreFeatures(descTokens, features);

  // Topic score.
  const topics = status?.activeTopics ?? [];
  const topicResult = scoreTopics(descTokens, topics);

  // Claim score.
  const claims = (snapshot?.claims ?? []).filter(c =>
    c.category === 'purpose' || c.category === 'architecture' || c.category === 'patterns',
  );
  const claimResult = scoreClaims(descTokens, claims);

  // Weighted composite: features 40%, topics 35%, claims 25%.
  const composite = featureResult.score * 0.40
    + topicResult.score  * 0.35
    + claimResult.score  * 0.25;

  const alignment = alignmentLabel(composite);

  return {
    description,
    alignmentScore: Number(composite.toFixed(3)),
    alignment,
    featureOverlapScore: Number(featureResult.score.toFixed(3)),
    topicOverlapScore:   Number(topicResult.score.toFixed(3)),
    claimOverlapScore:   Number(claimResult.score.toFixed(3)),
    matchedFeatures: featureResult.matched,
    matchedTopics:   topicResult.matched,
    matchedClaims:   claimResult.matched,
    verdict: buildVerdict(description, alignment, composite, featureResult.matched, topicResult.matched),
  };
}

export function renderIntentValidation(result: IntentValidationResult): string {
  return [
    `Description: ${result.description}`,
    '',
    `## Verdict`,
    result.verdict,
    '',
    `## Scores`,
    `Composite alignment: ${result.alignmentScore.toFixed(3)} (${result.alignment})`,
    `  Feature overlap:   ${result.featureOverlapScore.toFixed(3)}`,
    `  Topic overlap:     ${result.topicOverlapScore.toFixed(3)}`,
    `  Claim overlap:     ${result.claimOverlapScore.toFixed(3)}`,
    '',
    result.matchedFeatures.length > 0
      ? `Matched features: ${result.matchedFeatures.join('; ')}`
      : 'Matched features: none',
    result.matchedTopics.length > 0
      ? `Matched topics: ${result.matchedTopics.join(', ')}`
      : 'Matched topics: none',
    result.matchedClaims.length > 0
      ? `Matched claims:\n${result.matchedClaims.map(c => `  - ${c}`).join('\n')}`
      : 'Matched claims: none',
  ].join('\n');
}
