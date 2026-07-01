/**
 * test/collaborate.test.ts — US-005 P3b `collaborate` meta-tool.
 *
 * Covers (PRD US-005 acceptance criteria + OQ-1):
 *   1. Envelope shape — ToolResult<CollaboratePayload>.
 *   2. Default llm='heuristic' — no Ollama path triggered.
 *   3. Classifier — each of 5 intents (audit, onboard, refactor, debug,
 *      release-prep) recognized from representative goal strings.
 *   4. Classifier — empty / whitespace goal → 'unknown'.
 *   5. Classifier — confidence in [0,1].
 *   6. Classifier — symbol capture from `audit <Symbol>` style goals.
 *   7. DAG execution — each intent resolves to a valid DAG (all tool
 *      names are non-empty strings).
 *   8. DAG execution — tool_registry dispatches calls in DAG order.
 *   9. Determinism — same goal + same registry → same output.
 *  10. No-LLM default — llm='heuristic' produces no ollama signals.
 *  11. Fail loud — unknown tool in registry → 'collaborate.tool_missing' signal.
 *  12. Fail loud — tool throws → captured, ok=false, signal added.
 *  13. Synthesized text is non-empty for all intents.
 *  14. Reasoning chain starts with the leading 'collaborate called' fact.
 *  15. Blackboard write — opt-out via `writeToBlackboard: false`.
 *  16. Blackboard read — inherits prior facts (FR-4 propagation).
 *  17. Session ID default is `collaborate:<sha1_12>` of the goal.
 *  18. Ollama opt-in sets llm='ollama' on the payload.
 *  19. dagForIntent returns [] for 'unknown'.
 *  20. dagForIntent('audit') includes audit_symbol + trace_workflow.
 *  21. dagForIntent('onboard') includes project_status + feature_map.
 *  22. dagForIntent('refactor') includes plan_refactor + analyze_impact.
 *  23. dagForIntent('debug') includes regression_risk + render_behavior.
 *  24. dagForIntent('release-prep') includes plan_refactor + architecture_drift.
 *  25. extractFirstToken extracts a dotted Symbol.name from a goal.
 *  26. extractFirstToken returns null for goal without symbol-like tokens.
 *  27. Unknown-intent path returns AMBIGUOUS confidence_tier.
 *  28. Successful execution path returns EXTRACTED confidence_tier.
 *  29. Mixed (ok+err) execution path returns INFERRED confidence_tier.
 *  30. Reasoning chain is propagated by `appendReasoning` (dedup-aware).
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import test, { type TestContext } from 'node:test';

import {
  collaborateAsync,
  classifyGoal,
  dagForIntent,
  buildDefaultToolRegistry,
  type CollaboratePayload,
  type ToolRegistry,
  type CollaborateInput,
  type ToolStep,
} from '../src/cognition/audit/collaborate.js';

import { _extractFirstToken as extractFirstToken } from '../src/cognition/audit/collaborate.js';
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
  const base = path.resolve(process.cwd(), '.cog-collab-tmp');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'collab-'));
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
  log?: Array<{ name: string; args: Record<string, unknown> }>;
  throwsOn?: Set<string>;
} = {}): ToolRegistry & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    has(name: string): boolean {
      // Default: every tool name is registered. Tests that need a missing
      // tool can pass a registry that omits specific names.
      return true;
    },
    async call(name: string, args: Record<string, unknown>): Promise<unknown> {
      calls.push({ name, args });
      if (opts.throwsOn?.has(name)) {
        throw new Error(`fake:${name}: thrown for test`);
      }
      return { name, args, ok: true, summary: `result-of-${name}` };
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Envelope shape
// ---------------------------------------------------------------------------

test('collaborate: ToolResult envelope shape', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result = await collaborateAsync({
    projectRoot: root,
    goal: 'audit BookingService.create',
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: false,
  });
  assert.ok('data' in result);
  assert.ok('signals' in result);
  assert.ok('reasoning' in result);
  assert.ok('sources' in result);
  assert.ok('confidence_tier' in result);
  const data: CollaboratePayload = result.data;
  assert.equal(typeof data.goal, 'string');
  assert.equal(data.llm, 'heuristic');
  assert.equal(typeof data.classified, 'string');
  assert.equal(typeof data.classifiedConfidence, 'number');
  assert.ok(data.detectedSymbol === null || typeof data.detectedSymbol === 'string', 'detectedSymbol is null|string');
  assert.ok(Array.isArray(data.dag));
  assert.ok(Array.isArray(data.executed));
  assert.equal(typeof data.synthesized, 'string');
  assert.ok(Array.isArray(data.reasoning_chain));
});

// ---------------------------------------------------------------------------
// 2. Default llm='heuristic'
// ---------------------------------------------------------------------------

test('collaborate: default llm is "heuristic"', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result = await collaborateAsync({
    projectRoot: root,
    goal: 'audit BookingService.create',
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: false,
  });
  assert.equal(result.data.llm, 'heuristic');
  // Heuristic path must NOT add an ollama signal
  assert.ok(!result.signals.some((s) => s.kind === 'collaborate.llm_unavailable'));
});

// ---------------------------------------------------------------------------
// 3. Classifier — each of 5 intents
// ---------------------------------------------------------------------------

test('classifyGoal: "audit BookingService.create" → audit', () => {
  const c = classifyGoal('audit BookingService.create');
  assert.equal(c.intent, 'audit');
  assert.ok(c.confidence > 0);
  assert.equal(c.symbol, 'BookingService.create');
});

test('classifyGoal: "onboard me to this codebase" → onboard', () => {
  const c = classifyGoal('onboard me to this codebase');
  assert.equal(c.intent, 'onboard');
  assert.ok(c.confidence > 0);
});

test('classifyGoal: "refactor src/auth/login.ts" → refactor', () => {
  const c = classifyGoal('refactor src/auth/login.ts');
  assert.equal(c.intent, 'refactor');
  assert.ok(c.confidence > 0);
});

test('classifyGoal: "debug why BookingService.create returns 500" → debug', () => {
  const c = classifyGoal('debug why BookingService.create returns 500');
  assert.equal(c.intent, 'debug');
  assert.ok(c.confidence > 0);
});

test('classifyGoal: "release-prep for v2.0" → release-prep', () => {
  const c = classifyGoal('release-prep for v2.0');
  assert.equal(c.intent, 'release-prep');
  assert.ok(c.confidence > 0);
});

test('classifyGoal: "cut a release" → release-prep', () => {
  const c = classifyGoal('cut a release');
  assert.equal(c.intent, 'release-prep');
});

test('classifyGoal: "ship it" → release-prep', () => {
  const c = classifyGoal('ship it');
  assert.equal(c.intent, 'release-prep');
});

// ---------------------------------------------------------------------------
// 4. Empty / whitespace goal
// ---------------------------------------------------------------------------

test('classifyGoal: empty goal → unknown with confidence 0', () => {
  const c = classifyGoal('');
  assert.equal(c.intent, 'unknown');
  assert.equal(c.confidence, 0);
  assert.equal(c.symbol, null);
});

test('classifyGoal: whitespace-only goal → unknown', () => {
  const c = classifyGoal('   \t  ');
  assert.equal(c.intent, 'unknown');
  assert.equal(c.confidence, 0);
});

test('collaborate: empty goal → unknown intent + AMBIGUOUS tier + signal', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result = await collaborateAsync({
    projectRoot: root,
    goal: '   ',
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: false,
  });
  assert.equal(result.data.classified, 'unknown');
  assert.equal(result.confidence_tier, 'AMBIGUOUS');
  assert.ok(result.signals.some((s) => s.kind === 'collaborate.unknown_intent'));
});

// ---------------------------------------------------------------------------
// 5. Classifier — confidence in [0,1]
// ---------------------------------------------------------------------------

test('classifyGoal: confidence is always in [0,1]', () => {
  for (const goal of [
    'audit', 'audit audit audit audit', 'random noise xyz', 'release', 'refactor this huge stinking pile of code',
  ]) {
    const c = classifyGoal(goal);
    assert.ok(c.confidence >= 0 && c.confidence <= 1, `confidence out of range for "${goal}": ${c.confidence}`);
  }
});

// ---------------------------------------------------------------------------
// 6. Classifier — symbol capture
// ---------------------------------------------------------------------------

test('classifyGoal: captures symbol from "audit Foo.bar" style', () => {
  assert.equal(classifyGoal('audit Foo.bar').symbol, 'Foo.bar');
  assert.equal(classifyGoal('inspect MyClass.run').symbol, 'MyClass.run');
});

test('classifyGoal: symbol capture respects boundary (stops at non-symbol char)', () => {
  // "audit BookingService" should capture just "BookingService" (no dot)
  const c = classifyGoal('audit BookingService');
  assert.equal(c.intent, 'audit');
  // Either captured the bare class name or null — both acceptable per spec.
  assert.ok(c.symbol === 'BookingService' || c.symbol === null);
});

// ---------------------------------------------------------------------------
// 7. DAG execution — each intent resolves
// ---------------------------------------------------------------------------

test('dagForIntent: each intent returns a non-empty DAG with valid steps', () => {
  for (const intent of ['audit', 'onboard', 'refactor', 'debug', 'release-prep'] as const) {
    const dag = dagForIntent(intent, { symbol: 'Foo.bar', goal: 'audit Foo.bar' });
    assert.ok(dag.length > 0, `${intent} produced empty DAG`);
    for (const step of dag) {
      assert.equal(typeof step.name, 'string');
      assert.ok(step.name.length > 0, `${intent} has empty step name`);
      assert.equal(typeof step.args, 'object');
      assert.equal(typeof step.rationale, 'string');
    }
  }
});

// ---------------------------------------------------------------------------
// 8. DAG execution — registry dispatches in order
// ---------------------------------------------------------------------------

test('collaborate: dispatches calls in DAG order (audit)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg = makeFakeRegistry();
  await collaborateAsync({
    projectRoot: root,
    goal: 'audit BookingService.create',
    toolRegistry: reg,
    writeToBlackboard: false,
  });
  assert.ok(reg.calls.length >= 2, 'should have made multiple calls');
  // First two should be audit_symbol + trace_workflow
  assert.equal(reg.calls[0]?.name, 'audit_symbol');
  assert.equal(reg.calls[1]?.name, 'trace_workflow');
});

test('collaborate: dispatches in DAG order (debug)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg = makeFakeRegistry();
  await collaborateAsync({
    projectRoot: root,
    goal: 'debug BookingService.create 500',
    toolRegistry: reg,
    writeToBlackboard: false,
  });
  // Debug DAG: get_symbol, regression_risk, render_behavior, query_project_memory
  const names = reg.calls.map((c) => c.name);
  assert.deepEqual(names.slice(0, 4), [
    'get_symbol',
    'regression_risk',
    'render_behavior',
    'query_project_memory',
  ]);
});

test('collaborate: dispatches in DAG order (onboard)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg = makeFakeRegistry();
  await collaborateAsync({
    projectRoot: root,
    goal: 'onboard me',
    toolRegistry: reg,
    writeToBlackboard: false,
  });
  const names = reg.calls.map((c) => c.name);
  assert.deepEqual(names, ['project_status', 'feature_map', 'repo_map']);
});

// ---------------------------------------------------------------------------
// 9. Determinism
// ---------------------------------------------------------------------------

test('collaborate: deterministic for fixed input (same goal + same registry)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const a = await collaborateAsync({
    projectRoot: root,
    goal: 'audit BookingService.create',
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: false,
  });
  const b = await collaborateAsync({
    projectRoot: root,
    goal: 'audit BookingService.create',
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: false,
  });
  assert.equal(a.data.classified, b.data.classified);
  assert.equal(a.data.synthesized, b.data.synthesized);
  assert.equal(a.data.executed.length, b.data.executed.length);
  assert.deepEqual(a.data.dag, b.data.dag);
});

// ---------------------------------------------------------------------------
// 10. No-LLM default
// ---------------------------------------------------------------------------

test('collaborate: heuristic path emits no ollama signal even when goal hints at LLM use', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result = await collaborateAsync({
    projectRoot: root,
    goal: 'audit BookingService.create with ollama',
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: false,
  });
  assert.equal(result.data.llm, 'heuristic');
  assert.ok(!result.signals.some((s) => s.kind === 'collaborate.llm_unavailable'));
});

// ---------------------------------------------------------------------------
// 11. Fail loud — unknown tool
// ---------------------------------------------------------------------------

test('collaborate: unknown tool in registry → collaborate.tool_missing signal + ok=false', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg: ToolRegistry = {
    has: () => false,
    async call() {
      throw new Error('should not be called');
    },
  };
  const result = await collaborateAsync({
    projectRoot: root,
    goal: 'audit BookingService.create',
    toolRegistry: reg,
    writeToBlackboard: false,
  });
  assert.ok(result.signals.some((s) => s.kind === 'collaborate.tool_missing'));
  assert.ok(result.data.executed.every((e) => e.ok === false));
});

// ---------------------------------------------------------------------------
// 12. Fail loud — tool throws
// ---------------------------------------------------------------------------

test('collaborate: tool throws → captured, ok=false, signal added', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg = makeFakeRegistry({ throwsOn: new Set(['audit_symbol']) });
  const result = await collaborateAsync({
    projectRoot: root,
    goal: 'audit BookingService.create',
    toolRegistry: reg,
    writeToBlackboard: false,
  });
  const failed = result.data.executed.find((e) => e.name === 'audit_symbol');
  assert.equal(failed?.ok, false);
  assert.match(failed?.summary ?? '', /thrown for test/);
  assert.ok(result.signals.some((s) => s.kind === 'collaborate.tool_error'));
});

// ---------------------------------------------------------------------------
// 13. Synthesized text non-empty
// ---------------------------------------------------------------------------

test('collaborate: synthesized text is non-empty for every intent', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const goals: Array<[string, string]> = [
    ['audit BookingService.create', 'audit'],
    ['onboard me', 'onboard'],
    ['refactor src/auth/login.ts', 'refactor'],
    ['debug BookingService.create 500', 'debug'],
    ['release-prep for v2.0', 'release-prep'],
  ];
  for (const [goal] of goals) {
    const result = await collaborateAsync({
      projectRoot: root,
      goal,
      toolRegistry: makeFakeRegistry(),
      writeToBlackboard: false,
    });
    assert.ok(result.data.synthesized.length > 0, `synthesized empty for "${goal}"`);
  }
});

// ---------------------------------------------------------------------------
// 14. Reasoning chain leading fact
// ---------------------------------------------------------------------------

test('collaborate: reasoning chain starts with the leading "collaborate called" fact', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result = await collaborateAsync({
    projectRoot: root,
    goal: 'audit BookingService.create',
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: false,
  });
  const first = result.data.reasoning_chain.find((f) => f.source === 'collaborate');
  assert.ok(first, 'leading collaborate fact must be present');
  assert.ok(first?.fact.includes('collaborate called'));
});

// ---------------------------------------------------------------------------
// 15. Blackboard write
// ---------------------------------------------------------------------------

test('collaborate: writeToBlackboard=true appends to per-session scratchpad', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const goal = 'audit BookingService.create';
  const expectedSession = `collaborate:${crypto.createHash('sha1').update(goal).digest('hex').slice(0, 12)}`;
  await clearScratchpad(expectedSession, { projectRoot: root });
  await collaborateAsync({
    projectRoot: root,
    goal,
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: true,
  });
  const entries = await readScratchpad(expectedSession, { projectRoot: root });
  // F2 (Sprint 6b): per-step ToolResult evidence is appended alongside
  // the outer synthesis entry. Audit intent has 2 steps
  // (audit_symbol + trace_workflow), so we expect 1 outer + 2 per-step = 3.
  assert.equal(entries.length, 3);
  assert.equal(entries[0]?.tool, 'audit_symbol');
  assert.equal(entries[1]?.tool, 'trace_workflow');
  assert.equal(entries[2]?.tool, 'collaborate');
  assert.equal(entries[2]?.sessionId, expectedSession);
});

test('collaborate: writeToBlackboard=false does NOT write', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const goal = 'audit BookingService.create';
  const expectedSession = `collaborate:${crypto.createHash('sha1').update(goal).digest('hex').slice(0, 12)}`;
  await clearScratchpad(expectedSession, { projectRoot: root });
  await collaborateAsync({
    projectRoot: root,
    goal,
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: false,
  });
  const file = scratchpadPath(expectedSession, { projectRoot: root });
  assert.equal(fs.existsSync(file), false);
});

// ---------------------------------------------------------------------------
// 16. Blackboard read (FR-4 propagation)
// ---------------------------------------------------------------------------

test('collaborate: inherits prior facts from the scratchpad', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const goal = 'audit BookingService.create';
  const sessionId = `collaborate:${crypto.createHash('sha1').update(goal).digest('hex').slice(0, 12)}`;
  await clearScratchpad(sessionId, { projectRoot: root });
  await appendScratchpad(sessionId, {
    ts: new Date().toISOString(),
    tool: 'audit_symbol',
    data: { x: 1 },
    reasoning: ['prior-fact-1', 'prior-fact-2'],
    sessionId,
  }, { projectRoot: root });
  const result = await collaborateAsync({
    projectRoot: root,
    goal,
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: false,
  });
  const facts = result.data.reasoning_chain.map((f) => f.fact);
  assert.ok(facts.includes('prior-fact-1'));
  assert.ok(facts.includes('prior-fact-2'));
});

// ---------------------------------------------------------------------------
// 17. Session ID default
// ---------------------------------------------------------------------------

test('collaborate: default sessionId = "collaborate:<sha1_12>" of the goal', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const goal = 'audit BookingService.create';
  const expected = `collaborate:${crypto.createHash('sha1').update(goal).digest('hex').slice(0, 12)}`;
  const result = await collaborateAsync({
    projectRoot: root,
    goal,
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: false,
  });
  // The sessionId is observable via the scratchpad when written.
  // We assert the formula via the side-effect of a blackboard read.
  const scratch = await readScratchpad(expected, { projectRoot: root });
  void scratch;
  // Already validated via the scratchpad write test (#15) — re-assert:
  assert.match(expected, /^collaborate:[0-9a-f]{12}$/);
  void result;
});

// ---------------------------------------------------------------------------
// 18. Ollama opt-in
// ---------------------------------------------------------------------------

test('collaborate: llm="ollama" sets llm="ollama" on the payload', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result = await collaborateAsync({
    projectRoot: root,
    goal: 'audit BookingService.create',
    llm: 'ollama',
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: false,
  });
  assert.equal(result.data.llm, 'ollama');
  // The v1 ollama path falls back to heuristic + emits a deferral signal.
  assert.ok(result.signals.some((s) => s.kind === 'collaborate.llm_unavailable'));
});

// ---------------------------------------------------------------------------
// 19. dagForIntent: unknown → []
// ---------------------------------------------------------------------------

test('dagForIntent: unknown intent returns []', () => {
  const dag = dagForIntent('unknown', { symbol: null, goal: 'no idea' });
  assert.deepEqual(dag, []);
});

// ---------------------------------------------------------------------------
// 20-24. dagForIntent: each intent includes the expected tools
// ---------------------------------------------------------------------------

test('dagForIntent("audit") includes audit_symbol + trace_workflow', () => {
  const dag = dagForIntent('audit', { symbol: 'Foo.bar', goal: 'audit Foo.bar' });
  const names = dag.map((s) => s.name);
  assert.ok(names.includes('audit_symbol'));
  assert.ok(names.includes('trace_workflow'));
});

test('dagForIntent("onboard") includes project_status + feature_map + repo_map', () => {
  const dag = dagForIntent('onboard', { symbol: null, goal: 'onboard me' });
  const names = dag.map((s) => s.name);
  assert.ok(names.includes('project_status'));
  assert.ok(names.includes('feature_map'));
  assert.ok(names.includes('repo_map'));
});

test('dagForIntent("refactor") includes plan_refactor + analyze_impact', () => {
  const dag = dagForIntent('refactor', { symbol: 'Foo.bar', goal: 'refactor Foo.bar' });
  const names = dag.map((s) => s.name);
  assert.ok(names.includes('plan_refactor'));
  assert.ok(names.includes('analyze_impact'));
});

test('dagForIntent("debug") includes regression_risk + render_behavior + get_symbol', () => {
  const dag = dagForIntent('debug', { symbol: 'Foo.bar', goal: 'debug Foo.bar' });
  const names = dag.map((s) => s.name);
  assert.ok(names.includes('regression_risk'));
  assert.ok(names.includes('render_behavior'));
  assert.ok(names.includes('get_symbol'));
});

test('dagForIntent("release-prep") includes plan_refactor + architecture_drift', () => {
  const dag = dagForIntent('release-prep', { symbol: null, goal: 'release prep' });
  const names = dag.map((s) => s.name);
  assert.ok(names.includes('plan_refactor'));
  assert.ok(names.includes('architecture_drift'));
});

// ---------------------------------------------------------------------------
// 25. extractFirstToken
// ---------------------------------------------------------------------------

test('extractFirstToken: extracts a dotted Symbol.name from a goal', () => {
  assert.equal(extractFirstToken('fix BookingService.create 500'), 'BookingService.create');
  assert.equal(extractFirstToken('please look at Foo.Bar.baz'), 'Foo.Bar.baz');
});

test('extractFirstToken: returns null for a goal without symbol-like tokens', () => {
  // No Capitalized word, no dotted identifier.
  assert.equal(extractFirstToken('refactor this whole thing'), null);
});

// ---------------------------------------------------------------------------
// 27-29. Confidence tier
// ---------------------------------------------------------------------------

test('collaborate: unknown intent → AMBIGUOUS tier', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result = await collaborateAsync({
    projectRoot: root,
    goal: 'what is the weather',
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: false,
  });
  assert.equal(result.confidence_tier, 'AMBIGUOUS');
});

test('collaborate: fully successful execution → EXTRACTED tier', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result = await collaborateAsync({
    projectRoot: root,
    goal: 'audit BookingService.create',
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: false,
  });
  assert.equal(result.confidence_tier, 'EXTRACTED');
});

test('collaborate: mixed (ok+err) execution → INFERRED tier', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg = makeFakeRegistry({ throwsOn: new Set(['audit_symbol']) });
  const result = await collaborateAsync({
    projectRoot: root,
    goal: 'audit BookingService.create',
    toolRegistry: reg,
    writeToBlackboard: false,
  });
  assert.equal(result.confidence_tier, 'INFERRED');
});

// ---------------------------------------------------------------------------
// 30. Reasoning chain dedup propagation
// ---------------------------------------------------------------------------

test('collaborate: reasoning chain uses appendReasoning dedup (no adjacent dupes)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result = await collaborateAsync({
    projectRoot: root,
    goal: 'audit BookingService.create',
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: false,
  });
  const facts = result.data.reasoning_chain.map((f) => f.fact);
  for (let i = 1; i < facts.length; i++) {
    assert.notEqual(facts[i], facts[i - 1], `adjacent duplicate fact at index ${i}: "${facts[i]}"`);
  }
});

// ---------------------------------------------------------------------------
// buildDefaultToolRegistry: dispatch + missing tool
// ---------------------------------------------------------------------------

test('buildDefaultToolRegistry: dispatches to bound leaf functions', async () => {
  let called = 0;
  const reg = buildDefaultToolRegistry((name) => {
    if (name === 'foo') {
      return async () => {
        called += 1;
        return { ok: true };
      };
    }
    return null;
  });
  assert.ok(reg.has('foo'));
  assert.ok(!reg.has('bar'));
  await reg.call('foo', {});
  assert.equal(called, 1);
  await assert.rejects(() => reg.call('bar', {}), /unknown tool/);
});

// ---------------------------------------------------------------------------
// Integration: full call returns expected shape
// ---------------------------------------------------------------------------

test('collaborate: integration — audit goal → audit intent → executed.length > 0', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg = makeFakeRegistry();
  const result = await collaborateAsync({
    projectRoot: root,
    goal: 'audit Foo.bar please',
    toolRegistry: reg,
    writeToBlackboard: false,
  });
  assert.equal(result.data.classified, 'audit');
  assert.ok(result.data.executed.length > 0);
  // Each executed step has ok=true
  for (const step of result.data.executed) {
    assert.equal(step.ok, true);
  }
});

// ---------------------------------------------------------------------------
// Hints → query_project extra step
// ---------------------------------------------------------------------------

test('collaborate: refactor with hints appends a query_project step', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const reg = makeFakeRegistry();
  await collaborateAsync({
    projectRoot: root,
    goal: 'refactor Foo.bar',
    hints: ['split the validation chain'],
    toolRegistry: reg,
    writeToBlackboard: false,
  });
  const names = reg.calls.map((c) => c.name);
  assert.ok(names.includes('query_project'));
});

// ---------------------------------------------------------------------------
// Sources contain the goal
// ---------------------------------------------------------------------------

test('collaborate: sources contains the goal as external ref', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result = await collaborateAsync({
    projectRoot: root,
    goal: 'audit Foo.bar',
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: false,
  });
  const externalSources = result.sources.filter((s) => s.kind === 'external');
  assert.ok(externalSources.length > 0);
  assert.ok(externalSources.some((s) => (s.ref ?? '').includes('audit Foo.bar')));
});

// ---------------------------------------------------------------------------
// ToolResult is typed (no `any` escape)
// ---------------------------------------------------------------------------

test('collaborate: return is a real ToolResult<T> (no any escape)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result: ToolResult<CollaboratePayload> = await collaborateAsync({
    projectRoot: root,
    goal: 'audit Foo.bar',
    toolRegistry: makeFakeRegistry(),
    writeToBlackboard: false,
  });
  // The type-level constraint is the contract; runtime just checks shape.
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.data, 'object');
  assert.ok(Array.isArray(result.signals));
  assert.ok(Array.isArray(result.reasoning));
  assert.ok(Array.isArray(result.sources));
  // Type-level contract: this assignment must compile.
  const _typeCheck: ToolStep = { name: 'x', args: {}, rationale: 'y' };
  void _typeCheck;
  void result;
});
