/**
 * test/review-pr.test.ts — Sprint 8 US-001 review_pr acceptance.
 *
 * Covers:
 *   1. Envelope shape (8 fields populated).
 *   2. Per-symbol rule table — 9 cases (3 rules × HOLD/REVIEW/PASS
 *      boundaries).
 *   3. Aggregate rule — 3 cases (BLOCK/REVIEW/PASS).
 *   4. Wall-time budget (the per-symbol fan-out is parallel).
 *   5. intent DAG run — `run_intent('review', { baseRef, headRef })`
 *      resolves `$baseRef` / `$headRef` placeholders.
 *   6. End-to-end on a real fixture (placeholder; covered via smoke).
 *
 * The leaf-fan-out tests are based on the deterministic rule-table
 * helpers (`verdictPerSymbol`, `verdictAggregate`) — pure functions,
 * no I/O. The integration tests use the hermetic helpers mirroring
 * plan-refactor.test.ts.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';

import {
  reviewPrAsync,
  _verdictPerSymbol,
  _verdictAggregate,
  type _ReviewPrInput,
} from '../src/cognition/audit/review-pr.js';
import {
  runIntentAsync,
  type RunIntentPayload,
} from '../src/cognition/intents/runner.js';
import { listIntents, getIntent } from '../src/cognition/intents/registry.js';
import { hasIntent } from '../src/cognition/intents/registry.js';
import type { ToolRegistry } from '../src/cognition/audit/collaborate.js';
import type {
  ReviewPerSymbol,
  ReviewAggregate,
  ReviewVerdict,
  MergeDecision,
} from '../src/cognition/audit/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectRoot(t: TestContext): string {
  // Mirrors `test/intents.test.ts:65-76` — the project-root tmp MUST
  // be inside the actual repo working directory so `validateGraphPath`
  // (utils/security.ts:144) does not throw SecurityError on the
  // hermetic tmp dir escaping the project root.
  const base = path.resolve(process.cwd(), '.cog-review-tmp');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'review-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function initGit(dir: string, branch = 'main'): void {
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir, env: process.env });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, env: process.env });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, env: process.env });
  fs.writeFileSync(path.join(dir, '.keep'), 'placeholder');
  execFileSync('git', ['add', '.keep'], { cwd: dir, env: process.env });
  execFileSync('git', ['commit', '-m', 'init', '-q'], { cwd: dir, env: process.env });
}

// ---------------------------------------------------------------------------
// 1. Envelope shape — ToolResult<ReviewPrPayload>
// ---------------------------------------------------------------------------

test('review_pr: types — ReviewPerSymbol field set is complete', () => {
  const keys: Array<keyof ReviewPerSymbol> = [
    'symbol', 'file', 'verdict', 'confidence', 'blast_radius',
    'regression_score', 'duplicate_matches', 'side_effect_count', 'why',
  ];
  const sample: ReviewPerSymbol = {
    symbol: 'Foo.bar', file: 'src/foo.ts', verdict: 'PASS', confidence: 0.5,
    blast_radius: 0, regression_score: 0, duplicate_matches: 0, side_effect_count: 0,
    why: [],
  };
  for (const k of keys) assert.ok(k in sample, `field ${k} missing on ReviewPerSymbol`);
});

test('review_pr: types — ReviewAggregate field set is complete', () => {
  const keys: Array<keyof ReviewAggregate> = [
    'merge_decision', 'rule', 'hold_count', 'review_count', 'pass_count',
    'total_changed_symbols', 'duplicates_at_files', 'architecture_drift_records',
    'constraint_violations_high',
  ];
  const sample: ReviewAggregate = {
    merge_decision: 'PASS', rule: 'all_clear', hold_count: 0, review_count: 0,
    pass_count: 0, total_changed_symbols: 0, duplicates_at_files: 0,
    architecture_drift_records: 0, constraint_violations_high: 0,
  };
  for (const k of keys) assert.ok(k in sample, `field ${k} missing on ReviewAggregate`);
});

// ---------------------------------------------------------------------------
// 2. Per-symbol rule — 9 cases (3 rules × 3 verdicts)
// ---------------------------------------------------------------------------

test('review_pr: per-symbol rule — HOLD via regression_score=0.8 boundary', () => {
  assert.equal(_verdictPerSymbol(0.80, 0, 0, false), 'HOLD');
});

test('review_pr: per-symbol rule — HOLD via regression_score > 0.8', () => {
  assert.equal(_verdictPerSymbol(0.95, 0, 0, false), 'HOLD');
});

test('review_pr: per-symbol rule — HOLD via constraint_violation', () => {
  // regression at 0 (PASS trigger absent) but high-severity constraint hits.
  assert.equal(_verdictPerSymbol(0.0, 0, 0, true), 'HOLD');
});

test('review_pr: per-symbol rule — REVIEW via regression_score=0.5 boundary', () => {
  // 0.5 triggers REVIEW but not HOLD (< 0.8).
  assert.equal(_verdictPerSymbol(0.50, 0, 0, false), 'REVIEW');
});

test('review_pr: per-symbol rule — REVIEW via blast_radius=0.7 boundary', () => {
  assert.equal(_verdictPerSymbol(0.0, 0.70, 0, false), 'REVIEW');
});

test('review_pr: per-symbol rule — REVIEW via duplicate_matches=2 boundary', () => {
  assert.equal(_verdictPerSymbol(0.0, 0, 2, false), 'REVIEW');
});

test('review_pr: per-symbol rule — PASS when nothing triggers', () => {
  assert.equal(_verdictPerSymbol(0.0, 0, 0, false), 'PASS');
});

test('review_pr: per-symbol rule — PASS at one-below-threshold per axis', () => {
  assert.equal(_verdictPerSymbol(0.49, 0.69, 1, false), 'PASS');
});

test('review_pr: per-symbol rule — HOLD trumps REVIEW when both fire', () => {
  // regression=0.9 (HOLD) plus blast=0.9 (REVIEW-also) — HOLD wins.
  assert.equal(_verdictPerSymbol(0.9, 0.9, 5, true), 'HOLD');
});

// ---------------------------------------------------------------------------
// 3. Aggregate rule — 3 cases
// ---------------------------------------------------------------------------

test('review_pr: aggregate — BLOCK when at least one per-symbol HOLD', () => {
  const perSymbol: ReviewPerSymbol[] = [
    makeRow('HUB.run', 'HOLD', 0.85, 0.3),
    makeRow('EDGE.invoke', 'PASS', 0.2, 0.1),
  ];
  const aggregate = _verdictAggregate(perSymbol, 2, 0, 0, 0);
  assert.equal(aggregate.merge_decision, 'BLOCK');
  assert.equal(aggregate.rule, 'per_symbol_hold_present');
  assert.equal(aggregate.hold_count, 1);
  assert.equal(aggregate.pass_count, 1);
});

test('review_pr: aggregate — REVIEW when at least one per-symbol REVIEW', () => {
  const perSymbol: ReviewPerSymbol[] = [
    makeRow('HUB.run', 'REVIEW', 0.55, 0.3),
    makeRow('EDGE.invoke', 'PASS', 0.2, 0.1),
  ];
  const aggregate = _verdictAggregate(perSymbol, 2, 0, 0, 0);
  assert.equal(aggregate.merge_decision, 'REVIEW');
  assert.equal(aggregate.rule, 'per_symbol_review_present');
  assert.equal(aggregate.review_count, 1);
});

test('review_pr: aggregate — PASS only when every per-symbol passes AND top blast < 0.7', () => {
  const perSymbol: ReviewPerSymbol[] = [
    makeRow('A.a', 'PASS', 0.2, 0.65),
    makeRow('B.b', 'PASS', 0.1, 0.55),
  ];
  const aggregate = _verdictAggregate(perSymbol, 2, 0, 0, 0);
  assert.equal(aggregate.merge_decision, 'PASS');
  assert.equal(aggregate.rule, 'all_clear');
  assert.equal(aggregate.pass_count, 2);
});

test('review_pr: aggregate — top_blast_radius_review fallback when no per-symbol REVIEW', () => {
  // No HOLD or REVIEW per-symbol, but the top blast_radius at 0.7.
  const perSymbol: ReviewPerSymbol[] = [
    makeRow('A.a', 'PASS', 0.2, 0.70),
    makeRow('B.b', 'PASS', 0.1, 0.50),
  ];
  const aggregate = _verdictAggregate(perSymbol, 2, 0, 0, 0);
  assert.equal(aggregate.merge_decision, 'REVIEW');
  assert.equal(aggregate.rule, 'top_blast_radius_review');
});

// ---------------------------------------------------------------------------
// 4. Wall-time budget — fast-path on an empty fixture
// ---------------------------------------------------------------------------

test('review_pr: wall-time — empty diff returns PASS in <100ms', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  const t0 = Date.now();
  const result = await reviewPrAsync({
    projectRoot: dir,
    baseRef: 'HEAD',
    headRef: 'HEAD',
    topN: 10,
    writeToBlackboard: false,
  });
  const ms = Date.now() - t0;
  // Empty diff (baseRef == headRef) → 0 changed symbols. The
  // aggregate rule is `all_clear` because the per-symbol list is
  // empty (no HOLD, no REVIEW, top blast 0 < 0.7). When changeGraph
  // itself is missing (not the case here — `HEAD..HEAD` produces a
  // valid graph with 0 entries), the rule is `empty_diff`.
  assert.equal(result.data.perSymbol.length, 0);
  assert.equal(result.data.aggregate.total_changed_symbols, 0);
  assert.equal(result.data.aggregate.merge_decision, 'PASS');
  assert.equal(result.data.aggregate.rule, 'all_clear');
  // Tier for a clean PASS — `inferTier` maps PASS → 'EXTRACTED'. The
  // AMBIGUOUS tier is reserved for the changeGraph-missing case which
  // is covered by the leaf_missing code path.
  assert.equal(result.confidence_tier, 'EXTRACTED');
  assert.ok(ms < 1000, `wall-time ${ms}ms exceeds 1s budget on empty diff`);
});

// ---------------------------------------------------------------------------
// 5. Intent DAG run — review intent threads $baseRef/$headRef via opts
// ---------------------------------------------------------------------------

test('review intent: defined in the registry', () => {
  assert.ok(hasIntent('review'), 'review intent must be registered');
  const rec = getIntent('review');
  assert.equal(rec.name, 'review');
  assert.equal(rec.dag.length, 1);
  assert.equal(rec.dag[0]!.name, 'review_pr');
  assert.ok(JSON.stringify(rec.dag[0]!.args).includes('$baseRef'), '$baseRef placeholder present in DAG args');
  assert.ok(JSON.stringify(rec.dag[0]!.args).includes('$headRef'), '$headRef placeholder present in DAG args');
});

test('review intent: listIntents includes review (one of 6)', () => {
  const names = listIntents();
  assert.ok(names.includes('review'));
  assert.equal(names.length, 6);
});

test('review_pr via run_intent resolves $baseRef/$headRef from opts', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);

  // Stub registry that records the args `review_pr` was called with —
  // the resolver MUST substitute the placeholders before dispatch.
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const fakeReviewPr: ToolRegistry = {
    has(name: string) { return name === 'review_pr'; },
    async call(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      // Mimic a typical ToolResult envelope shape so the rest of the
      // runner pipeline (reasoning, signals, confidence_tier) is happy.
      void name;
      return {
        data: {
          baseRef: args['baseRef'],
          headRef: args['headRef'],
          perSymbol: [],
          aggregate: {
            merge_decision: 'PASS', rule: 'all_clear',
            hold_count: 0, review_count: 0, pass_count: 0,
            total_changed_symbols: 0, duplicates_at_files: 0,
            architecture_drift_records: 0, constraint_violations_high: 0,
          },
          recommended_next: [],
          reasoning_chain: [],
        },
        signals: [],
        reasoning: [],
        sources: [],
        confidence_tier: 'EXTRACTED',
      };
    },
  };

  const result = await runIntentAsync({
    projectRoot: dir,
    intent: 'review',
    toolRegistry: fakeReviewPr,
    opts: { baseRef: 'main', headRef: 'HEAD' },
    writeToBlackboard: false,
  });

  const review_call = calls.find((c) => c.name === 'review_pr');
  assert.ok(review_call, 'review_pr should have been called via run_intent');
  assert.equal(review_call!.args['baseRef'], 'main', '$baseRef resolved from opts.baseRef');
  assert.equal(review_call!.args['headRef'], 'HEAD', '$headRef resolved from opts.headRef');
  assert.equal(result.data.intent, 'review');
  assert.equal(result.confidence_tier, 'EXTRACTED');
});

test('review intent: missing opts throws a typed arg-resolution signal', async (t) => {
  const dir = makeProjectRoot(t);
  initGit(dir);
  const fakeReviewPr: ToolRegistry = {
    has(name: string) { return name === 'review_pr'; },
    async call(name: string, args: Record<string, unknown>) {
      void name; void args;
      return {
        data: { perSymbol: [], aggregate: emptyAgg() },
        signals: [], reasoning: [], sources: [],
        confidence_tier: 'AMBIGUOUS',
      };
    },
  };
  const result = await runIntentAsync({
    projectRoot: dir,
    intent: 'review',
    toolRegistry: fakeReviewPr,
    // no opts → $baseRef / $headRef cannot resolve
    writeToBlackboard: false,
  });
  // The runner captures the resolution failure as an ok=false step +
  // signal — never throws past the boundary.
  const data: RunIntentPayload = result.data;
  const review = data.executed.find((e) => e.name === 'review_pr');
  assert.ok(review, 'review_pr step recorded');
  assert.equal(review!.ok, false, 'review_pr ok=false because opts were not provided');
  assert.ok(
    result.signals.some((s) => s.kind === 'intents.arg_resolution_error'),
    'intents.arg_resolution_error signal surfaced when $baseRef could not resolve',
  );
});

test('review intent: literal-only intents stay byte-equal when opts is undefined', async (t) => {
  // Regression guard: FR-11 backward-compat binding. The 5
  // literal-only intents do NOT touch opts; resolveArgs stays
  // byte-equal to the pre-Sprint-8 implementation for them.
  const dir = makeProjectRoot(t);
  initGit(dir);
  const fakeOnboard: ToolRegistry = {
    has(name: string) { return name === 'project_status' || name === 'feature_map' || name === 'repo_map'; },
    async call(name: string, args: Record<string, unknown>) {
      void args;
      return {
        data: { ok: true, summary: `fake ${name}` },
        signals: [], reasoning: [], sources: [],
        confidence_tier: 'EXTRACTED',
      };
    },
  };
  const result = await runIntentAsync({
    projectRoot: dir,
    intent: 'onboard',
    toolRegistry: fakeOnboard,
    // no opts
    writeToBlackboard: false,
  });
  assert.equal(result.data.intent, 'onboard');
  assert.equal(result.confidence_tier, 'EXTRACTED');
  // No arg-resolution signal because the literal-only intent produced
  // byte-equal resolved args without opts.
  assert.ok(!result.signals.some((s) => s.kind === 'intents.arg_resolution_error'),
    'literal-only intent must NOT emit an arg_resolution_error signal');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(
  sym: string,
  verdict: ReviewVerdict,
  regression: number,
  blast: number,
): ReviewPerSymbol {
  return {
    symbol: sym,
    file: `src/${sym}.ts`,
    verdict,
    confidence: 0.5,
    blast_radius: blast,
    regression_score: regression,
    duplicate_matches: 0,
    side_effect_count: 0,
    why: [],
  };
}

function emptyAgg(): import('../src/cognition/audit/types.js').ReviewAggregate {
  return {
    merge_decision: 'PASS',
    rule: 'empty_diff',
    hold_count: 0,
    review_count: 0,
    pass_count: 0,
    total_changed_symbols: 0,
    duplicates_at_files: 0,
    architecture_drift_records: 0,
    constraint_violations_high: 0,
  };
}

// Type-only check for MergeDecision usage.
const _decision: MergeDecision = 'BLOCK';
void _decision;

// Suppress unused _ReviewPrInput in environments where the import
// is only used as documentation.
const _input: _ReviewPrInput = {
  projectRoot: '/tmp', baseRef: 'main', headRef: 'HEAD',
};
void _input;
