#!/usr/bin/env bun
/**
 * scripts/smoke-plan-refactor.ts — Sprint 3 US-004 smoke (FR-7 + acceptance).
 *
 * Runs `plan_refactor` against the project root and asserts at least 1
 * intervention is ranked. Exits non-zero on failure.
 *
 * Usage:
 *   bun scripts/smoke-plan-refactor.ts [projectRoot] [baseRef] [headRef]
 *
 * Defaults:
 *   projectRoot = process.cwd() (the code-intelligence repo)
 *   baseRef     = 'HEAD~5'
 *   headRef     = 'HEAD'
 */
import * as path from 'node:path';
import { planRefactorAsync } from '../src/cognition/audit/plan-refactor.js';

async function main(): Promise<void> {
  const projectRoot = path.resolve(process.argv[2] ?? process.cwd());
  const baseRef = process.argv[3] ?? 'HEAD~5';
  const headRef = process.argv[4] ?? 'HEAD';
  const topN = 5;

  // eslint-disable-next-line no-console
  console.log(`[smoke] plan_refactor projectRoot=${projectRoot} baseRef=${baseRef} headRef=${headRef} topN=${topN}`);
  const result = await planRefactorAsync({
    projectRoot,
    baseRef,
    headRef,
    topN,
    writeToBlackboard: false,
  });
  const data = result.data;

  // eslint-disable-next-line no-console
  console.log(`  totalChangedSymbols: ${data.totalChangedSymbols}`);
  // eslint-disable-next-line no-console
  console.log(`  interventions: ${data.interventions.length}`);
  // eslint-disable-next-line no-console
  console.log(`  blast radius: low=${data.blastRadiusDistribution.low} medium=${data.blastRadiusDistribution.medium} high=${data.blastRadiusDistribution.high}`);
  // eslint-disable-next-line no-console
  console.log(`  reversibility: ${(data.reversibilityRatio * 100).toFixed(0)}%`);
  // eslint-disable-next-line no-console
  console.log(`  signals: ${result.signals.length} reasoning: ${result.reasoning.length} tier: ${result.confidence_tier}`);
  // eslint-disable-next-line no-console
  console.log(`  summary: ${data.summary}`);

  for (const intervention of data.interventions) {
    // eslint-disable-next-line no-console
    console.log(`    - ${intervention.symbol} conf=${intervention.confidence.toFixed(3)} blast=${intervention.blast_radius.toFixed(3)} reversible=${intervention.reversible}`);
  }

  if (data.interventions.length >= 1) {
    // eslint-disable-next-line no-console
    console.log(`PLAN OK: ${data.interventions.length} interventions ranked`);
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.error(`PLAN FAIL: 0 interventions ranked (summary: ${data.summary})`);
  process.exit(1);
}

main().catch(error => {
  // eslint-disable-next-line no-console
  console.error(`[smoke] crash:`, error);
  process.exit(2);
});
