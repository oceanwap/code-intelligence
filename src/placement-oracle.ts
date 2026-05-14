/**
 * placement-oracle.ts
 *
 * "Where should this live?" — given a plain-language description of a new
 * capability, recommends the best module(s) in the project for placing the new
 * code based on semantic relatedness, architectural stability, coupling, and
 * active constraint rules.
 *
 * Prevents agents from placing code in the wrong layer/module, which is the
 * root cause of most architectural drift.
 */

import * as path from 'path';
import { queryProject } from './indexer-run.js';
import { loadArchitectureAsync } from './cognition/architecture/storage.js';
import { loadAttentionAsync, rerankByAttentionAsync } from './cognition/attention/engine.js';
import { listConstraintViolationsAsync } from './cognition/constraints/engine.js';
import { moduleFromFile } from './utils/module-path.js';
import { getDataDir } from './git.js';

export type PlacementRisk = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ModulePlacementCandidate {
  module: string;
  /** Composite placement score (0–1, higher = better fit). */
  placementScore: number;
  /** Number of semantically related results found in this module. */
  relatedSymbolCount: number;
  /** Architecture instability metric (0 = stable, 1 = highly unstable). */
  instability: number;
  /** Architecture coupling metric. */
  coupling: number;
  /** Constraint violations that would be triggered by adding code here. */
  constraintWarnings: string[];
  placementRisk: PlacementRisk;
  /** Human-readable rationale. */
  rationale: string;
}

export interface PlacementOracleResult {
  description: string;
  recommendations: ModulePlacementCandidate[];
  summary: string;
}

function placementRisk(instability: number, violations: string[]): PlacementRisk {
  if (violations.length > 0 || instability > 0.75) return 'HIGH';
  if (instability > 0.50) return 'MEDIUM';
  return 'LOW';
}

function placementScore(
  semanticWeight: number,
  instability: number,
  coupling: number,
  violations: number,
): number {
  // Weights as designed in the plan:
  // semantic 40%, stability 30%, coupling 20%, constraint penalty 10%
  const stabilityBonus = (1 - instability) * 0.30;
  const couplingBonus  = (1 - Math.min(coupling, 1)) * 0.20;
  const constraintPenalty = Math.min(violations * 0.10, 0.20);
  return Math.max(0, Math.min(1,
    semanticWeight * 0.40 + stabilityBonus + couplingBonus - constraintPenalty,
  ));
}

function buildRationale(candidate: ModulePlacementCandidate): string {
  const parts: string[] = [
    `${candidate.relatedSymbolCount} semantically related symbol(s)`,
    `instability ${candidate.instability.toFixed(2)} (${candidate.instability < 0.4 ? 'stable' : candidate.instability < 0.7 ? 'moderate' : 'high churn'})`,
    `coupling ${candidate.coupling.toFixed(2)}`,
  ];
  if (candidate.constraintWarnings.length > 0) {
    parts.push(`⚠ constraint warnings: ${candidate.constraintWarnings.join('; ')}`);
  }
  const riskLabel = candidate.placementRisk === 'LOW'
    ? '✓ RECOMMENDED'
    : candidate.placementRisk === 'MEDIUM'
      ? '~ ACCEPTABLE (review instability)'
      : '✗ NOT RECOMMENDED (high risk)';
  return `${riskLabel} — ${parts.join(', ')}`;
}

export async function whereShouldThisLive(
  projectRoot: string,
  description: string,
  qdrantUrl = 'http://localhost:6333',
  topN = 3,
): Promise<PlacementOracleResult> {
  const root = path.resolve(projectRoot);

  // 1. Semantic search to find related code, reranked by attention.
  let results = await queryProject(root, description, qdrantUrl);
  results = await rerankByAttentionAsync(root, results);

  // 2. Group results by module and tally semantic weight.
  const moduleWeights = new Map<string, { count: number; scoreSum: number }>();
  for (const result of results.slice(0, 24)) {
    const mod = moduleFromFile(result.file);
    const existing = moduleWeights.get(mod) ?? { count: 0, scoreSum: 0 };
    moduleWeights.set(mod, {
      count: existing.count + 1,
      scoreSum: existing.scoreSum + result.score,
    });
  }

  if (moduleWeights.size === 0) {
    return {
      description,
      recommendations: [],
      summary: 'No indexed code found related to this description. Run index_project first, or broaden the description.',
    };
  }

  // 3. Load architecture and constraints.
  const [architecture, violations, attention] = await Promise.all([
    loadArchitectureAsync(root),
    listConstraintViolationsAsync(root, { limit: 100 }),
    loadAttentionAsync(root),
  ]);

  const instabilityMap = new Map(architecture?.modules.map(m => [m.name, architecture.instability[m.name] ?? 0]) ?? []);
  const couplingMap    = new Map(architecture?.modules.map(m => [m.name, architecture.coupling[m.name]    ?? 0]) ?? []);

  // Pre-build: which violation rules involve each module?
  const violationsByModule = new Map<string, string[]>();
  for (const v of violations) {
    for (const mod of v.modules) {
      const key = mod.split('/')[0] ?? mod;
      const existing = violationsByModule.get(key) ?? [];
      existing.push(`[${v.severity}] ${v.rule}`);
      violationsByModule.set(key, existing);
    }
  }

  // Normalize semantic weights to 0-1.
  const maxScore = Math.max(...[...moduleWeights.values()].map(v => v.scoreSum));

  // 4. Build candidates.
  const candidates: ModulePlacementCandidate[] = [];
  for (const [mod, weight] of moduleWeights.entries()) {
    const semanticWeight = maxScore > 0 ? weight.scoreSum / maxScore : 0;
    const instability    = instabilityMap.get(mod) ?? 0.5;
    const coupling       = couplingMap.get(mod) ?? 0.5;
    const warnings       = violationsByModule.get(mod.split('/')[0] ?? mod) ?? [];

    const score = placementScore(semanticWeight, instability, coupling, warnings.length);
    const risk  = placementRisk(instability, warnings);
    const candidate: ModulePlacementCandidate = {
      module: mod,
      placementScore: Number(score.toFixed(3)),
      relatedSymbolCount: weight.count,
      instability: Number(instability.toFixed(3)),
      coupling: Number(coupling.toFixed(3)),
      constraintWarnings: warnings.slice(0, 3),
      placementRisk: risk,
      rationale: '',
    };
    candidate.rationale = buildRationale(candidate);
    candidates.push(candidate);
  }

  // 5. Sort: best placement score first, then by risk tier.
  const riskOrder: Record<PlacementRisk, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  candidates.sort((a, b) =>
    b.placementScore - a.placementScore ||
    riskOrder[a.placementRisk] - riskOrder[b.placementRisk],
  );

  const top = candidates.slice(0, topN);
  const best = top[0];
  const summary = best
    ? `Top recommendation: \`${best.module}\` (score ${best.placementScore.toFixed(2)}, risk ${best.placementRisk}). ${best.rationale}`
    : 'Could not determine a clear placement recommendation.';

  return { description, recommendations: top, summary };
}

export function renderPlacementOracle(result: PlacementOracleResult): string {
  const lines = [
    `Description: ${result.description}`,
    '',
    result.summary,
  ];

  if (result.recommendations.length > 0) {
    lines.push('', '## Module recommendations');
    for (const [i, rec] of result.recommendations.entries()) {
      lines.push(
        '',
        `### ${i + 1}. ${rec.module}  [risk: ${rec.placementRisk}]`,
        `Placement score: ${rec.placementScore.toFixed(3)}`,
        `Related symbols found: ${rec.relatedSymbolCount}`,
        `Instability: ${rec.instability.toFixed(3)}`,
        `Coupling: ${rec.coupling.toFixed(3)}`,
        rec.constraintWarnings.length > 0
          ? `Constraint warnings: ${rec.constraintWarnings.join('; ')}`
          : 'Constraint warnings: none',
        `Rationale: ${rec.rationale}`,
      );
    }
  }

  return lines.join('\n');
}
