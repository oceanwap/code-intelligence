/**
 * test/intents.test.ts — US-006 P4 intent registry + runner.
 *
 * Covers (PRD US-006 acceptance criteria):
 *   1. Registry has exactly 5 intents (audit, onboard, refactor, debug, release-prep).
 *   2. Each intent is a pure data record (name, description, dag, post).
 *   3. Each intent's dag has at least one step.
 *   4. hasIntent / tryGetIntent return expected values for known + unknown names.
 *   5. getIntent throws on unknown name.
 *   6. listIntents returns the 5 names in deterministic order.
 *   7. runIntentAsync returns a ToolResult<RunIntentPayload>.
 *   8. runIntentAsync unknown name → typed empty result + signal.
 *   9. runIntentAsync executes the DAG in order via the tool registry.
 *  10. runIntentAsync applies overrides to DAG step args.
 *  11. runIntentAsync handles tool errors (ok=false, signal added).
 *  12. runIntentAsync handles missing tools (ok=false, signal added).
 *  13. Synthesis is non-empty and includes the post lines.
 *  14. Reasoning chain starts with the leading 'run_intent called' fact.
 *  15. Blackboard write is opt-out via writeToBlackboard=false.
 *  16. Blackboard read inherits prior facts (FR-4).
 *  17. Confidence tier: all-ok → EXTRACTED, mixed → INFERRED, all-err → AMBIGUOUS.
 *  18. Session ID default is `run-intent:<name>:<sha1_12>`.
 *  19. Per-intent DAG includes the canonical tools (spot checks).
 *  20. runIntentAsync output is structurally a ToolResult<T>.
 *  21. runIntentAsync never throws on bad input.
 *  22. hasIntent is type-narrowing (TypeScript only).
 *  23. registered intents' DAG names are non-empty strings.
 *  24. registered intents' post lines are non-empty.
 *  25. registered intents' descriptions are non-empty.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import test, { type TestContext } from 'node:test';

import {
  getIntent,
  hasIntent,
  listIntents,
  tryGetIntent,
  getRegistry,
  type RegisteredIntentName,
  type IntentRecord,
} from '../src/cognition/intents/registry.js';
import {
  runIntentAsync,
  type RunIntentPayload,
} from '../src/cognition/intents/runner.js';
import type { ToolRegistry, ToolStep, CollaborateExecutedStep } from '../src/cognition/audit/collaborate.js';
import type { ToolResult } from '../src/cognition/signalization/types.js';
import {
  appendScratchpad,
  readScratchpad,
  clearScratchpad,
  scratchpadPath,
} from '../src/cognition/blackboard/scratchpad.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectRoot(t: TestContext): string {
  const base = path.resolve(process.cwd(), '.cog-intent-tmp');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'intent-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function initGit(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: process.env });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, env: process.env });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, env: process.env });
  fs.writeFileSync(path.join(dir, '.keep'), 'placeholder');
  execFileSync('git', ['add', '.keep'], { cwd: dir, env: process.env });
  execFileSync('git', ['commit', '-m', 'init', '-q'], { cwd: dir, env: process.env });
}

function makeFakeRegistry(opts: {
  throwsOn?: Set<string>;
} = {}): ToolRegistry & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    has(name: string): boolean {
      return true;
    },
    async call(name: string, args: Record<string, unknown>): Promise<unknown> {
      calls.push({ name, args });
      if (opts.throwsOn?.has(name)) {
        throw new Error(`fake:${name}: thrown for test`);
      }
      // F6 (Sprint 6b): return a ToolResult-shaped envelope so downstream
      // `$ref` resolution can walk `data.*` against the prior step's
      // payload. Previously this returned a bare `{ name, args, ok, summary }`
      // object, which `asResolvedPrior` wrapped as `{ data: <bare> }`
      // and the `$ref` resolver failed on `prev.data.topIntervention.symbol`.
      return {
        data: {
          symbol: 'Foo.bar',
          topIntervention: { symbol: 'Bar.baz', blast_radius: 0.4 },
          symbols: ['Bar.baz'],
          ok: true,
          summary: `result-of-${name}`,
        },
        reasoning: [{ fact: `${name} ran`, source: name }],
        signals: [],
        sources: [],
        confidence_tier: 'EXTRACTED',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Registry shape — 5 intents
// ---------------------------------------------------------------------------

test('intents: registry contains exactly 5 intents', () => {
  const names = listIntents();
  assert.deepEqual(names, ['audit', 'debug', 'onboard', 'refactor', 'release-prep'].sort());
});

test('intents: each intent is a pure data record (name, description, dag, post)', () => {
  for (const name of listIntents()) {
    const rec = getIntent(name);
    assert.equal(rec.name, name);
    assert.equal(typeof rec.description, 'string');
    assert.ok(rec.description.length > 0);
    assert.ok(Array.isArray(rec.dag));
    assert.ok(Array.isArray(rec.post));
  }
});

test('intents: each intent dag has at least one step', () => {
  for (const name of listIntents()) {
    const rec = getIntent(name);
    assert.ok(rec.dag.length > 0, `${name} has empty DAG`);
  }
});

// ---------------------------------------------------------------------------
// 2. hasIntent / tryGetIntent
// ---------------------------------------------------------------------------

test('intents: hasIntent returns true for known names', () => {
  for (const name of listIntents()) {
    assert.ok(hasIntent(name));
  }
});

test('intents: hasIntent returns false for unknown names', () => {
  assert.equal(hasIntent('unknown'), false);
  assert.equal(hasIntent('audit2'), false);
  assert.equal(hasIntent(''), false);
});

test('intents: tryGetIntent returns the record for known names', () => {
  const rec = tryGetIntent('audit');
  assert.ok(rec);
  assert.equal(rec?.name, 'audit');
});

test('intents: tryGetIntent returns null for unknown names', () => {
  assert.equal(tryGetIntent('unknown'), null);
});

// ---------------------------------------------------------------------------
// 3. getIntent throws on unknown
// ---------------------------------------------------------------------------

test('intents: getIntent throws on unknown name', () => {
  assert.throws(() => getIntent('nope' as RegisteredIntentName), /unknown intent/);
});

// ---------------------------------------------------------------------------
// 4. listIntents deterministic order
// ---------------------------------------------------------------------------

test('intents: listIntents returns names in sorted (deterministic) order', () => {
  const a = listIntents();
  const b = listIntents();
  assert.deepEqual(a, b);
  // Sorted ascending
  for (let i = 1; i < a.length; i++) {
    assert.ok((a[i - 1] ?? '') < (a[i] ?? ''), `out of order at ${i}`);
  }
});

// ---------------------------------------------------------------------------
// 5. getRegistry snapshot
// ---------------------------------------------------------------------------

test('intents: getRegistry returns a snapshot keyed by name', () => {
  const reg = getRegistry();
  for (const name of listIntents()) {
    assert.ok(reg[name]);
    assert.equal(reg[name]?.name, name);
  }
});

// ---------------------------------------------------------------------------
// 6-8. runIntentAsync happy paths
// ---------------------------------------------------------------------------

test('runIntentAsync: returns a ToolResult<RunIntentPayload>', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg = makeFakeRegistry();
  const result = await runIntentAsync({
    projectRoot: root,
    intent: 'audit',
    toolRegistry: reg,
    writeToBlackboard: false,
  });
  assert.ok('data' in result);
  assert.ok('signals' in result);
  assert.ok('reasoning' in result);
  assert.ok('sources' in result);
  assert.ok('confidence_tier' in result);
  const data: RunIntentPayload = result.data;
  assert.equal(data.intent, 'audit');
  assert.ok(Array.isArray(data.dag));
  assert.ok(Array.isArray(data.executed));
  assert.equal(typeof data.synthesis, 'string');
  assert.ok(Array.isArray(data.reasoning_chain));
});

test('runIntentAsync: unknown name → typed empty result + intents.unknown signal', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg = makeFakeRegistry();
  // Cast to bypass TS check; the runner accepts any string and refuses it.
  const result = await runIntentAsync({
    projectRoot: root,
    intent: 'nope' as unknown as RegisteredIntentName,
    toolRegistry: reg,
    writeToBlackboard: false,
  });
  assert.equal(result.data.intent, 'nope');
  assert.equal(result.data.dag.length, 0);
  assert.equal(result.data.executed.length, 0);
  assert.match(result.data.synthesis, /Unknown intent/);
  assert.ok(result.signals.some((s) => s.kind === 'intents.unknown'));
  assert.equal(result.confidence_tier, 'AMBIGUOUS');
});

test('runIntentAsync: executes DAG in order', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg = makeFakeRegistry();
  await runIntentAsync({
    projectRoot: root,
    intent: 'audit',
    toolRegistry: reg,
    writeToBlackboard: false,
  });
  const names = reg.calls.map((c) => c.name);
  // Audit DAG order: audit_symbol, trace_workflow
  assert.deepEqual(names, ['audit_symbol', 'trace_workflow']);
});

// ---------------------------------------------------------------------------
// 9. Overrides
// ---------------------------------------------------------------------------

test('runIntentAsync: applies overrides to DAG step args', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg = makeFakeRegistry();
  await runIntentAsync({
    projectRoot: root,
    intent: 'audit',
    toolRegistry: reg,
    overrides: {
      trace_workflow: { hops: 3 },
    },
    writeToBlackboard: false,
  });
  const traceCall = reg.calls.find((c) => c.name === 'trace_workflow');
  assert.equal(traceCall?.args['hops'], 3);
});

// ---------------------------------------------------------------------------
// 10-11. Tool errors + missing tools
// ---------------------------------------------------------------------------

test('runIntentAsync: tool throws → captured, ok=false, signal added', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg = makeFakeRegistry({ throwsOn: new Set(['audit_symbol']) });
  const result = await runIntentAsync({
    projectRoot: root,
    intent: 'audit',
    toolRegistry: reg,
    writeToBlackboard: false,
  });
  const failed = result.data.executed.find((e) => e.name === 'audit_symbol');
  assert.equal(failed?.ok, false);
  assert.match(failed?.summary ?? '', /thrown for test/);
  assert.ok(result.signals.some((s) => s.kind === 'intents.tool_error'));
});

test('runIntentAsync: missing tool → ok=false + intents.tool_missing signal', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg: ToolRegistry = {
    has: () => false,
    async call() { throw new Error('not called'); },
  };
  const result = await runIntentAsync({
    projectRoot: root,
    intent: 'audit',
    toolRegistry: reg,
    writeToBlackboard: false,
  });
  assert.ok(result.data.executed.every((e) => e.ok === false));
  assert.ok(result.signals.some((s) => s.kind === 'intents.tool_missing'));
});

// ---------------------------------------------------------------------------
// 12. Synthesis
// ---------------------------------------------------------------------------

test('runIntentAsync: synthesis is non-empty and includes post lines', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg = makeFakeRegistry();
  const result = await runIntentAsync({
    projectRoot: root,
    intent: 'audit',
    toolRegistry: reg,
    writeToBlackboard: false,
  });
  assert.ok(result.data.synthesis.length > 0);
  // Post lines should appear in the synthesis
  const rec = getIntent('audit');
  for (const post of rec.post) {
    assert.ok(result.data.synthesis.includes(post), `synthesis missing post line: ${post}`);
  }
});

// ---------------------------------------------------------------------------
// 13. Reasoning chain leading fact
// ---------------------------------------------------------------------------

test('runIntentAsync: reasoning chain starts with the leading "run_intent called" fact', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg = makeFakeRegistry();
  const result = await runIntentAsync({
    projectRoot: root,
    intent: 'audit',
    toolRegistry: reg,
    writeToBlackboard: false,
  });
  const first = result.data.reasoning_chain.find((f) => f.source === 'run_intent');
  assert.ok(first);
  assert.ok(first?.fact.includes('run_intent called for audit'));
});

// ---------------------------------------------------------------------------
// 14. Blackboard write
// ---------------------------------------------------------------------------

test('runIntentAsync: writeToBlackboard=true appends to per-session scratchpad', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const sessionId = `run-intent:audit:${crypto.createHash('sha1').update(`audit|${root}`).digest('hex').slice(0, 12)}`;
  await clearScratchpad(sessionId, { projectRoot: root });
  await runIntentAsync({
    projectRoot: root,
    intent: 'audit',
    toolRegistry: makeFakeRegistry(),
    sessionId,
    writeToBlackboard: true,
  });
  const entries = await readScratchpad(sessionId, { projectRoot: root });
  // F2 (Sprint 6b): per-step ToolResult evidence is appended alongside
  // the outer synthesis entry. Audit intent has 2 steps
  // (audit_symbol + trace_workflow), so we expect 1 outer + 2 per-step = 3.
  assert.equal(entries.length, 3);
  // The LAST entry is the outer synthesis (per F2 convention: per-step
  // entries are appended at execution time, outer synthesis written last
  // after the loop). First entry is the first step.
  assert.equal(entries[0]?.tool, 'audit_symbol');
  assert.equal(entries[1]?.tool, 'trace_workflow');
  assert.equal(entries[2]?.tool, 'run_intent');
});

test('runIntentAsync: writeToBlackboard=false does NOT write', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const sessionId = `run-intent:audit:${crypto.createHash('sha1').update(`audit|${root}`).digest('hex').slice(0, 12)}`;
  await clearScratchpad(sessionId, { projectRoot: root });
  await runIntentAsync({
    projectRoot: root,
    intent: 'audit',
    toolRegistry: makeFakeRegistry(),
    sessionId,
    writeToBlackboard: false,
  });
  const file = scratchpadPath(sessionId, { projectRoot: root });
  assert.equal(fs.existsSync(file), false);
});

// ---------------------------------------------------------------------------
// 15. Blackboard read
// ---------------------------------------------------------------------------

test('runIntentAsync: inherits prior facts from the scratchpad (FR-4)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const sessionId = `run-intent:audit:${crypto.createHash('sha1').update(`audit|${root}`).digest('hex').slice(0, 12)}`;
  await clearScratchpad(sessionId, { projectRoot: root });
  await appendScratchpad(sessionId, {
    ts: new Date().toISOString(),
    tool: 'audit_symbol',
    data: { x: 1 },
    reasoning: ['inherited-1', 'inherited-2'],
    sessionId,
  }, { projectRoot: root });
  const result = await runIntentAsync({
    projectRoot: root,
    intent: 'audit',
    toolRegistry: makeFakeRegistry(),
    sessionId,
    writeToBlackboard: false,
  });
  const facts = result.data.reasoning_chain.map((f) => f.fact);
  assert.ok(facts.includes('inherited-1'));
  assert.ok(facts.includes('inherited-2'));
});

// ---------------------------------------------------------------------------
// 16. Confidence tier
// ---------------------------------------------------------------------------

test('runIntentAsync: all-ok → EXTRACTED tier', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result = await runIntentAsync({
    projectRoot: root,
    intent: 'audit',
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: false,
  });
  assert.equal(result.confidence_tier, 'EXTRACTED');
});

test('runIntentAsync: mixed (ok+err) → INFERRED tier', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg = makeFakeRegistry({ throwsOn: new Set(['audit_symbol']) });
  const result = await runIntentAsync({
    projectRoot: root,
    intent: 'audit',
    toolRegistry: reg,
    writeToBlackboard: false,
  });
  assert.equal(result.confidence_tier, 'INFERRED');
});

test('runIntentAsync: all-err (no tool registered) → AMBIGUOUS tier', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg: ToolRegistry = {
    has: () => false,
    async call() { throw new Error('not called'); },
  };
  const result = await runIntentAsync({
    projectRoot: root,
    intent: 'audit',
    toolRegistry: reg,
    writeToBlackboard: false,
  });
  assert.equal(result.confidence_tier, 'AMBIGUOUS');
});

// ---------------------------------------------------------------------------
// 17. Per-intent DAG spot checks
// ---------------------------------------------------------------------------

test('intents: audit DAG includes audit_symbol + trace_workflow', () => {
  const dag = getIntent('audit').dag;
  const names = dag.map((s) => s.name);
  assert.ok(names.includes('audit_symbol'));
  assert.ok(names.includes('trace_workflow'));
});

test('intents: onboard DAG includes project_status + feature_map + repo_map', () => {
  const dag = getIntent('onboard').dag;
  const names = dag.map((s) => s.name);
  assert.ok(names.includes('project_status'));
  assert.ok(names.includes('feature_map'));
  assert.ok(names.includes('repo_map'));
});

test('intents: refactor DAG includes plan_refactor + analyze_impact + regression_risk', () => {
  const dag = getIntent('refactor').dag;
  const names = dag.map((s) => s.name);
  assert.ok(names.includes('plan_refactor'));
  assert.ok(names.includes('analyze_impact'));
  assert.ok(names.includes('regression_risk'));
});

test('intents: debug DAG includes get_symbol + render_behavior + query_project_memory', () => {
  const dag = getIntent('debug').dag;
  const names = dag.map((s) => s.name);
  assert.ok(names.includes('get_symbol'));
  assert.ok(names.includes('render_behavior'));
  assert.ok(names.includes('query_project_memory'));
});

test('intents: release-prep DAG includes plan_refactor + architecture_drift', () => {
  const dag = getIntent('release-prep').dag;
  const names = dag.map((s) => s.name);
  assert.ok(names.includes('plan_refactor'));
  assert.ok(names.includes('architecture_drift'));
});

// ---------------------------------------------------------------------------
// 18. Per-intent execute order spot check
// ---------------------------------------------------------------------------

test('runIntentAsync: debug executes in order: get_symbol, regression_risk, render_behavior, query_project_memory', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg = makeFakeRegistry();
  await runIntentAsync({
    projectRoot: root,
    intent: 'debug',
    toolRegistry: reg,
    writeToBlackboard: false,
  });
  const names = reg.calls.map((c) => c.name);
  assert.deepEqual(names, ['get_symbol', 'regression_risk', 'render_behavior', 'query_project_memory']);
});

// ---------------------------------------------------------------------------
// 19. ToolResult<T> type
// ---------------------------------------------------------------------------

test('runIntentAsync: return type is structurally ToolResult<RunIntentPayload>', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result: ToolResult<RunIntentPayload> = await runIntentAsync({
    projectRoot: root,
    intent: 'onboard',
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: false,
  });
  assert.equal(typeof result, 'object');
  assert.equal(result.data.intent, 'onboard');
});

// ---------------------------------------------------------------------------
// 20-21. Never throws
// ---------------------------------------------------------------------------

test('runIntentAsync: never throws on bad input (intents)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  // Multiple bad inputs in a row
  for (const intent of ['nope', 'AUDIT', 'audit2', '123' as unknown as RegisteredIntentName]) {
    const result = await runIntentAsync({
      projectRoot: root,
      intent: intent as unknown as RegisteredIntentName,
      toolRegistry: makeFakeRegistry(),
      writeToBlackboard: false,
    });
    assert.ok('data' in result);
  }
});

// ---------------------------------------------------------------------------
// 22-25. Internal helpers + invariants
// ---------------------------------------------------------------------------

test('intents: registered intent DAG names are non-empty strings', () => {
  for (const name of listIntents()) {
    const rec = getIntent(name);
    for (const step of rec.dag) {
      assert.equal(typeof step.name, 'string');
      assert.ok(step.name.length > 0, `${name} has empty step name`);
    }
  }
});

test('intents: registered intent post lines are non-empty', () => {
  for (const name of listIntents()) {
    const rec = getIntent(name);
    for (const post of rec.post) {
      assert.equal(typeof post, 'string');
      assert.ok(post.length > 0, `${name} has empty post line`);
    }
  }
});

test('intents: registered intent descriptions are non-empty', () => {
  for (const name of listIntents()) {
    const rec = getIntent(name);
    assert.ok(rec.description.length > 0);
  }
});

test('intents: registry returns a deep-cloned record (mutating it does not affect the registry)', () => {
  const a = getIntent('audit');
  a.dag.push({ name: 'mutation-marker', args: {}, rationale: 'should not appear' });
  const b = getIntent('audit');
  assert.ok(!b.dag.some((s) => s.name === 'mutation-marker'));
});

// ---------------------------------------------------------------------------
// Integration: end-to-end execute
// ---------------------------------------------------------------------------

test('runIntentAsync: end-to-end onboard intent dispatches 3 calls + writes synthesis', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg = makeFakeRegistry();
  const result = await runIntentAsync({
    projectRoot: root,
    intent: 'onboard',
    toolRegistry: reg,
    writeToBlackboard: false,
  });
  assert.equal(result.data.intent, 'onboard');
  assert.equal(reg.calls.length, 3);
  assert.ok(result.data.executed.every((e) => e.ok));
  assert.match(result.data.synthesis, /Intent: onboard/);
});

// ---------------------------------------------------------------------------
// Coverage of all 5 intents
// ---------------------------------------------------------------------------

test('runIntentAsync: every registered intent executes successfully end-to-end', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  for (const intent of listIntents()) {
    const reg = makeFakeRegistry();
    const result = await runIntentAsync({
      projectRoot: root,
      intent,
      toolRegistry: reg,
      writeToBlackboard: false,
    });
    assert.equal(result.data.intent, intent);
    assert.equal(result.confidence_tier, 'EXTRACTED');
    assert.ok(result.data.executed.every((e) => e.ok));
  }
});

// ---------------------------------------------------------------------------
// Sources include the intent name
// ---------------------------------------------------------------------------

test('runIntentAsync: sources include the intent name as external ref', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result = await runIntentAsync({
    projectRoot: root,
    intent: 'refactor',
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: false,
  });
  const externalSources = result.sources.filter((s) => s.kind === 'external');
  assert.ok(externalSources.length > 0);
  assert.ok(externalSources.some((s) => (s.ref ?? '').includes('refactor')));
});
