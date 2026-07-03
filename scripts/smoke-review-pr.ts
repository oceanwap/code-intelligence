#!/usr/bin/env bun
/**
 * scripts/smoke-review-pr.ts — Sprint 8 US-001 smoke (FR-7 + acceptance).
 *
 * Runs `review_pr` against the project root and asserts the merge
 * decision is well-formed. Exits 0 with terminal string
 * `REVIEW OK: <decision> (<hold>,<review>,<pass>)` on success.
 *
 * Usage:
 *   bun scripts/smoke-review-pr.ts [projectRoot] [baseRef] [headRef]
 *
 * Defaults:
 *   projectRoot = process.cwd()
 *   baseRef     = 'HEAD~6'
 *   headRef     = 'HEAD'
 */
import * as path from 'node:path';
import { reviewPrAsync } from '../src/cognition/audit/review-pr.js';

async function main(): Promise<void> {
  const projectRoot = path.resolve(process.argv[2] ?? process.cwd());
  const baseRef = process.argv[3] ?? 'HEAD~6';
  const headRef = process.argv[4] ?? 'HEAD';
  const topN = 5;

  const t0 = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[smoke] review_pr projectRoot=${projectRoot} baseRef=${baseRef} headRef=${headRef} topN=${topN}`);
  const result = await reviewPrAsync({
    projectRoot,
    baseRef,
    headRef,
    topN,
    writeToBlackboard: false,
  });
  const wallMs = Date.now() - t0;
  const data = result.data;
  const agg = data.aggregate;

  // eslint-disable-next-line no-console
  console.log(`  totalChangedSymbols: ${agg.total_changed_symbols}`);
  // eslint-disable-next-line no-console
  console.log(`  perSymbol: ${data.perSymbol.length}`);
  // eslint-disable-next-line no-console
  console.log(`  wall-time: ${wallMs}ms`);
  // eslint-disable-next-line no-console
  console.log(`  aggregate: decision=${agg.merge_decision} rule=${agg.rule} hold=${agg.hold_count} review=${agg.review_count} pass=${agg.pass_count}`);
  // eslint-disable-next-line no-console
  console.log(`  drift records: ${agg.architecture_drift_records}; constraint violations (high): ${agg.constraint_violations_high}`);
  // eslint-disable-next-line no-console
  console.log(`  signals: ${result.signals.length} reasoning: ${result.reasoning.length} tier: ${result.confidence_tier}`);

  for (const row of data.perSymbol.slice(0, 5)) {
    // eslint-disable-next-line no-console
    console.log(`    - ${row.symbol} [${row.verdict}] blast=${row.blast_radius.toFixed(3)} regression=${row.regression_score.toFixed(3)} dups=${row.duplicate_matches} sideEffects=${row.side_effect_count}`);
  }

  const counts = `(${agg.hold_count},${agg.review_count},${agg.pass_count})`;
  if (
    agg.total_changed_symbols >= 1
    && data.perSymbol.length >= 1
    && ['PASS', 'REVIEW', 'BLOCK'].includes(agg.merge_decision)
  ) {
    // eslint-disable-next-line no-console
    console.log(`REVIEW OK: ${agg.merge_decision} ${counts}`);
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.error(`REVIEW FAIL: decision=${agg.merge_decision} (counts=${counts}; total=${agg.total_changed_symbols})`);
  process.exit(1);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`[smoke] crash:`, error);
  process.exit(2);
});
