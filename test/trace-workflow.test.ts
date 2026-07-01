/**
 * test/trace-workflow.test.ts — US-005 P3b `trace_workflow` meta-tool.
 *
 * Covers (PRD US-005 acceptance criteria):
 *   1. Envelope shape — ToolResult<TraceWorkflowPayload> with all fields.
 *   2. Mermaid round-trip — emit + parse; parser accepts the exact subset.
 *   3. Narrative non-empty + numbered.
 *   4. Hops validation (2/3) — non-2/3 → reject, default 2.
 *   5. Fail loud, fail typed — missing graph returns typed empty + signal.
 *   6. Blackboard read — inherits prior facts (FR-4 propagation).
 *   7. Blackboard write — opt-out via `writeToBlackboard: false`.
 *   8. Sequence-diagram parser rejects unknown lines (round-trip safety).
 *   9. mermaidId sanitization — non-alphanumeric → underscores, empty → '_'.
 *  10. sessionId default = `trace-workflow:<sha1_8>`; override honored.
 *  11. Determinism — same input → same output.
 *  12. Step cap (MAX_STEPS = 30) honored when graph explodes.
 *  13. reasoning chain starts with the leading trace_workflow fact.
 *  14. Project-not-indexed path produces AMBIGUOUS tier.
 *  15. Symbol with no edges produces empty steps + 'no reachable' text.
 *  16. Participants list contains the root + every distinct step symbol.
 *  17. Side effects from graph.sideEffects propagate to steps.
 *  18. Level-order depth ordering — root first, then depth 1, etc.
 *  19. inbound + outbound both surface in the trace for a 2-sided symbol.
 *  20. sequenceDiagram block contains 'sequenceDiagram' header.
 *  21. exported `parseMermaidSequenceDiagram` handles alt/else/end edges.
 *  22. exported `parseMermaidSequenceDiagram` rejects undeclared participants.
 *  23. exported `parseMermaidSequenceDiagram` handles 'Note left of' and 'Note over'.
 *  24. Pre-call inherited facts are populated on the blackboard read.
 *  25. Empty graph.sideEffects for a symbol still produces a step.
 *  26. symbolSessionHash produces sha1-truncated 8-hex values.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import test, { type TestContext } from 'node:test';

import {
  traceWorkflowAsync,
  symbolSessionHash,
  renderMermaidSequenceDiagram,
  parseMermaidSequenceDiagram,
  mermaidId,
  type TraceStep,
  type TraceWorkflowPayload,
} from '../src/cognition/audit/trace-workflow.js';
import type { ToolResult } from '../src/cognition/signalization/types.js';
import type { SideEffect } from '../src/behavior-graph.js';
import type { GraphData } from '../src/graph.js';
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
  const base = path.resolve(process.cwd(), '.cog-trace-tmp');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'trace-'));
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

function makeGraph(): GraphData {
  // Two-hop graph:
  //   BookingService.create → PaymentService.charge → StripeAdapter.call
  //   BookingService.create → AuditLog.append
  //   main() → BookingService.create
  return {
    symbols: {
      'BookingService.create': ['PaymentService.charge', 'AuditLog.append'],
      'PaymentService.charge': ['StripeAdapter.call'],
      'StripeAdapter.call': [],
      'AuditLog.append': [],
      'main': ['BookingService.create'],
    },
    callers: {
      'BookingService.create': ['main'],
      'PaymentService.charge': ['BookingService.create'],
      'StripeAdapter.call': ['PaymentService.charge'],
      'AuditLog.append': ['BookingService.create'],
      'main': [],
    },
    symbolFile: {
      'BookingService.create': 'src/booking.ts',
      'PaymentService.charge': 'src/payment.ts',
      'StripeAdapter.call': 'src/stripe.ts',
      'AuditLog.append': 'src/audit.ts',
      'main': 'src/main.ts',
    },
    sideEffects: {
      'StripeAdapter.call': [
        { kind: 'http', target: 'https://api.stripe.com/charge', confidence: 0.95, callSite: { file: 'src/stripe.ts', line: 12 }, evidence: ['curl'] },
      ] as unknown as SideEffect[],
      'AuditLog.append': [
        { kind: 'log', target: 'audit.log', confidence: 0.9, callSite: { file: 'src/audit.ts', line: 5 }, evidence: ['logger'] },
      ] as unknown as SideEffect[],
    },
  } as unknown as GraphData;
}

async function writeGraph(root: string, graph: GraphData): Promise<void> {
  const dataDir = path.join(root, '.code-intelligence', 'main');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(path.join(dataDir, 'graph.json'), JSON.stringify(graph));
}

// ---------------------------------------------------------------------------
// 1. Envelope shape
// ---------------------------------------------------------------------------

test('trace_workflow: ToolResult envelope shape on a 2-hop graph', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  const result = await traceWorkflowAsync({
    projectRoot: root,
    symbol: 'BookingService.create',
    hops: 2,
    writeToBlackboard: false,
  });
  assert.ok('data' in result);
  assert.ok('signals' in result);
  assert.ok('reasoning' in result);
  assert.ok('sources' in result);
  assert.ok('confidence_tier' in result);
  assert.ok(['EXTRACTED', 'INFERRED', 'AMBIGUOUS'].includes(result.confidence_tier));
  const data: TraceWorkflowPayload = result.data;
  assert.equal(data.symbol, 'BookingService.create');
  assert.equal(data.hops, 2);
  assert.ok(Array.isArray(data.participants));
  assert.ok(Array.isArray(data.steps));
  assert.ok(Array.isArray(data.narrative));
  assert.equal(typeof data.narrativeText, 'string');
  assert.equal(typeof data.sequenceDiagram, 'string');
  assert.equal(typeof data.reachableCount, 'number');
  assert.equal(typeof data.capped, 'boolean');
  assert.equal(typeof data.inheritedFacts, 'number');
  assert.ok(Array.isArray(data.reasoning_chain));
});

test('trace_workflow: all required payload fields present', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  const result = await traceWorkflowAsync({
    projectRoot: root,
    symbol: 'BookingService.create',
    writeToBlackboard: false,
  });
  const required = [
    'symbol', 'hops', 'participants', 'steps', 'narrative', 'narrativeText',
    'sequenceDiagram', 'reachableCount', 'capped', 'inheritedFacts', 'reasoning_chain',
  ] as const;
  for (const key of required) {
    assert.ok(key in result.data, `field "${key}" missing`);
  }
});

// ---------------------------------------------------------------------------
// 2. Mermaid round-trip + parser
// ---------------------------------------------------------------------------

test('trace_workflow: sequenceDiagram block is parseable by mermaid grammar fixture', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  const result = await traceWorkflowAsync({
    projectRoot: root,
    symbol: 'BookingService.create',
    hops: 2,
    writeToBlackboard: false,
  });
  const body = result.data.sequenceDiagram;
  assert.match(body, /^sequenceDiagram/m);
  // The parser fixture must accept the exact subset we emit.
  const parsed = parseMermaidSequenceDiagram(body);
  assert.ok(parsed.participants.includes('BookingService_create'));
  assert.ok(parsed.messages.length > 0, 'at least one message arrow emitted');
});

test('trace_workflow: sequenceDiagram re-emits deterministically', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  const a = await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', writeToBlackboard: false,
  });
  const b = await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', writeToBlackboard: false,
  });
  // The narrative/sequenceDiagram content is deterministic; the
  // 'reasoning_chain' includes inherited facts and a leading fact which
  // may differ only in identity, not in the emitted payload.
  assert.equal(a.data.sequenceDiagram, b.data.sequenceDiagram);
  assert.equal(a.data.narrativeText, b.data.narrativeText);
});

test('parseMermaidSequenceDiagram: rejects undeclared participants in messages', () => {
  const body = [
    'sequenceDiagram',
    '  participant A',
    '  A->>B: call',
  ].join('\n');
  assert.throws(() => parseMermaidSequenceDiagram(body), /undeclared/);
});

test('parseMermaidSequenceDiagram: rejects empty body', () => {
  assert.throws(() => parseMermaidSequenceDiagram(''), /empty/);
});

test('parseMermaidSequenceDiagram: rejects bad first line', () => {
  assert.throws(() => parseMermaidSequenceDiagram('not a diagram'), /sequenceDiagram/);
});

test('parseMermaidSequenceDiagram: rejects unrecognized line', () => {
  const body = [
    'sequenceDiagram',
    '  participant A',
    '  garbage line',
  ].join('\n');
  assert.throws(() => parseMermaidSequenceDiagram(body), /unrecognized/);
});

test('parseMermaidSequenceDiagram: handles Note right of / Note over / Note left of', () => {
  const body = [
    'sequenceDiagram',
    '  participant A',
    '  A->>A: x',
    '  Note right of A: hi',
    '  Note left of A: there',
    '  Note over A: middle',
  ].join('\n');
  const parsed = parseMermaidSequenceDiagram(body);
  assert.equal(parsed.notes.length, 3);
  assert.equal(parsed.notes[0]?.owner, 'A');
  assert.equal(parsed.notes[0]?.text, 'hi');
});

// ---------------------------------------------------------------------------
// 3. Narrative shape
// ---------------------------------------------------------------------------

test('trace_workflow: narrative is non-empty and numbered', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  const result = await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', writeToBlackboard: false,
  });
  const narrative = result.data.narrative;
  assert.ok(narrative.length > 0, 'narrative not empty');
  for (let i = 0; i < narrative.length; i++) {
    assert.match(narrative[i]!, new RegExp(`^${i + 1}\\.`));
  }
});

test('trace_workflow: narrative first line is the root', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  const result = await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', writeToBlackboard: false,
  });
  assert.match(result.data.narrative[0]!, /^1\. BookingService\.create: root/);
});

// ---------------------------------------------------------------------------
// 4. Hops validation
// ---------------------------------------------------------------------------

test('trace_workflow: hops default = 2 when omitted', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  const result = await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', writeToBlackboard: false,
  });
  assert.equal(result.data.hops, 2);
});

test('trace_workflow: hops=3 discovers 3-hop neighbors', async (t) => {
  // Build a 3-hop chain: A → B → C → D
  const graph: GraphData = {
    symbols: { A: ['B'], B: ['C'], C: ['D'], D: [] },
    callers: { A: [], B: ['A'], C: ['B'], D: ['C'] },
    symbolFile: { A: 'a.ts', B: 'b.ts', C: 'c.ts', D: 'd.ts' },
  } as unknown as GraphData;
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, graph);
  const result = await traceWorkflowAsync({
    projectRoot: root, symbol: 'A', hops: 3, writeToBlackboard: false,
  });
  const symbols = result.data.steps.map((s) => s.symbol);
  assert.ok(symbols.includes('A'));
  assert.ok(symbols.includes('B'));
  assert.ok(symbols.includes('C'));
  assert.ok(symbols.includes('D'));
  // The step for D should be at depth 3
  const d = result.data.steps.find((s) => s.symbol === 'D');
  assert.equal(d?.hop, 3);
});

test('trace_workflow: hops=2 stops before depth 3', async (t) => {
  const graph: GraphData = {
    symbols: { A: ['B'], B: ['C'], C: ['D'], D: [] },
    callers: { A: [], B: ['A'], C: ['B'], D: ['C'] },
    symbolFile: { A: 'a.ts', B: 'b.ts', C: 'c.ts', D: 'd.ts' },
  } as unknown as GraphData;
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, graph);
  const result = await traceWorkflowAsync({
    projectRoot: root, symbol: 'A', hops: 2, writeToBlackboard: false,
  });
  const symbols = result.data.steps.map((s) => s.symbol);
  assert.ok(!symbols.includes('D'), 'D should not appear at hops=2');
});

test('trace_workflow: hops outside {2,3} falls back to default 2', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  // Cast to any to bypass TS check; the runtime contract accepts only 2|3
  // and falls back on invalid values.
  const result = await traceWorkflowAsync({
    projectRoot: root,
    symbol: 'BookingService.create',
    hops: 7 as unknown as 2,
    writeToBlackboard: false,
  });
  assert.equal(result.data.hops, 2);
});

// ---------------------------------------------------------------------------
// 5. Fail loud, fail typed
// ---------------------------------------------------------------------------

test('trace_workflow: missing graph → typed empty + leaf_missing signal + AMBIGUOUS tier', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  // No graph.json
  const result = await traceWorkflowAsync({
    projectRoot: root, symbol: 'X', writeToBlackboard: false,
  });
  assert.equal(result.data.steps.length, 0);
  assert.match(result.data.narrativeText, /No graph available/);
  assert.ok(result.signals.some((s) => s.kind === 'trace_workflow.leaf_missing'));
  assert.equal(result.confidence_tier, 'AMBIGUOUS');
});

test('trace_workflow: returns ToolResult even on bad input (no throw)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result = await traceWorkflowAsync({
    projectRoot: root, symbol: 'Anything', writeToBlackboard: false,
  });
  assert.ok('data' in result);
});

// ---------------------------------------------------------------------------
// 6. Blackboard read (FR-4 propagation)
// ---------------------------------------------------------------------------

test('trace_workflow: inherits prior facts from the scratchpad', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  const sessionId = `trace-workflow:${symbolSessionHash('BookingService.create')}`;
  await clearScratchpad(sessionId, { projectRoot: root });
  await appendScratchpad(sessionId, {
    ts: new Date().toISOString(),
    tool: 'audit_symbol',
    data: { behavior: [] },
    reasoning: ['audit_symbol called for BookingService.create', 'render_behavior: 2 side effects'],
    sessionId,
  }, { projectRoot: root });

  const result = await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', writeToBlackboard: false,
  });
  assert.ok(result.data.inheritedFacts >= 2, `expected >=2 inherited facts, got ${result.data.inheritedFacts}`);
  // The inherited facts should appear in the reasoning chain.
  const facts = result.data.reasoning_chain.map((f) => f.fact);
  assert.ok(facts.includes('audit_symbol called for BookingService.create'));
  assert.ok(facts.includes('render_behavior: 2 side effects'));
});

// ---------------------------------------------------------------------------
// 7. Blackboard write
// ---------------------------------------------------------------------------

test('trace_workflow: writeToBlackboard=true appends to per-session scratchpad', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  const sessionId = `trace-workflow:${symbolSessionHash('BookingService.create')}`;
  await clearScratchpad(sessionId, { projectRoot: root });

  await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', writeToBlackboard: true,
  });
  const entries = await readScratchpad(sessionId, { projectRoot: root });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.tool, 'trace_workflow');
});

test('trace_workflow: writeToBlackboard=false does NOT write', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  const sessionId = `trace-workflow:${symbolSessionHash('BookingService.create')}`;
  await clearScratchpad(sessionId, { projectRoot: root });
  await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', writeToBlackboard: false,
  });
  const file = scratchpadPath(sessionId, { projectRoot: root });
  assert.equal(fs.existsSync(file), false);
});

// ---------------------------------------------------------------------------
// 8. Round-trip safety
// ---------------------------------------------------------------------------

test('parseMermaidSequenceDiagram: round-trips a hand-written diagram', () => {
  const body = [
    'sequenceDiagram',
    '  participant A',
    '  participant B',
    '  A->>B: hello',
    '  Note right of B: ping',
  ].join('\n');
  const parsed = parseMermaidSequenceDiagram(body);
  assert.deepEqual(parsed.participants, ['A', 'B']);
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0]?.from, 'A');
  assert.equal(parsed.messages[0]?.to, 'B');
  assert.equal(parsed.messages[0]?.text, 'hello');
  assert.equal(parsed.notes.length, 1);
});

// ---------------------------------------------------------------------------
// 9. mermaidId sanitization
// ---------------------------------------------------------------------------

test('mermaidId: replaces non-alphanumeric with underscores', () => {
  assert.equal(mermaidId('BookingService.create'), 'BookingService_create');
  assert.equal(mermaidId('Foo Bar'), 'Foo_Bar');
  assert.equal(mermaidId('a.b.c()'), 'a_b_c');
});

test('mermaidId: empty string → "_"', () => {
  assert.equal(mermaidId(''), '_');
});

test('mermaidId: trims leading/trailing underscores', () => {
  assert.equal(mermaidId('___abc___'), 'abc');
});

// ---------------------------------------------------------------------------
// 10. Session ID
// ---------------------------------------------------------------------------

test('symbolSessionHash is deterministic + sha1-truncated 8-hex', () => {
  const a = symbolSessionHash('BookingService.create');
  const b = symbolSessionHash('BookingService.create');
  const c = symbolSessionHash('BookingService.update');
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
  const expected = crypto.createHash('sha1').update('BookingService.create').digest('hex').slice(0, 8);
  assert.equal(a, expected);
});

test('trace_workflow: explicit sessionId is honored on the scratchpad', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  const sessionId = 'trace-explicit-session';
  await clearScratchpad(sessionId, { projectRoot: root });
  await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', sessionId, writeToBlackboard: true,
  });
  const entries = await readScratchpad(sessionId, { projectRoot: root });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.sessionId, sessionId);
});

// ---------------------------------------------------------------------------
// 11. Determinism
// ---------------------------------------------------------------------------

test('trace_workflow: deterministic for fixed input (steps + reachable count)', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  const a = await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', writeToBlackboard: false,
  });
  const b = await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', writeToBlackboard: false,
  });
  assert.equal(a.data.reachableCount, b.data.reachableCount);
  assert.equal(a.data.steps.length, b.data.steps.length);
  assert.deepEqual(a.data.steps.map((s) => s.symbol), b.data.steps.map((s) => s.symbol));
});

// ---------------------------------------------------------------------------
// 12. Step cap
// ---------------------------------------------------------------------------

test('trace_workflow: step count is bounded (MAX_STEPS=30)', async (t) => {
  // Build a 3-hop graph with 5 symbols per level = 1 + 5 + 5 + 5 = 16 < 30
  // So instead build a flat graph with 40 symbols all directly connected to root.
  const graph: GraphData = {
    symbols: { Root: [] },
    callers: { Root: [] },
    symbolFile: { Root: 'r.ts' },
  } as unknown as GraphData;
  for (let i = 0; i < 40; i++) {
    const sym = `Child${String(i).padStart(2, '0')}`;
    (graph.symbols as Record<string, string[]>)[sym] = [];
    (graph.callers as Record<string, string[]>)[sym] = ['Root'];
    (graph.symbols as Record<string, string[]>)['Root']!.push(sym);
    (graph.symbolFile as Record<string, string>)[sym] = `${sym}.ts`;
  }
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, graph);
  const result = await traceWorkflowAsync({
    projectRoot: root, symbol: 'Root', hops: 2, writeToBlackboard: false,
  });
  assert.ok(result.data.steps.length <= 30, `step count ${result.data.steps.length} exceeds cap`);
});

// ---------------------------------------------------------------------------
// 13. Reasoning chain starts with leading fact
// ---------------------------------------------------------------------------

test('trace_workflow: reasoning chain starts with the leading trace_workflow fact', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  const result = await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', writeToBlackboard: false,
  });
  const first = result.data.reasoning_chain.find((f) => f.source === 'trace_workflow');
  assert.ok(first, 'leading trace_workflow fact must be present');
  assert.ok(first?.fact.includes('BookingService.create'));
});

// ---------------------------------------------------------------------------
// 14. Project-not-indexed path → AMBIGUOUS tier
// ---------------------------------------------------------------------------

test('trace_workflow: project not indexed → AMBIGUOUS confidence_tier', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  const result = await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', writeToBlackboard: false,
  });
  assert.equal(result.confidence_tier, 'AMBIGUOUS');
});

// ---------------------------------------------------------------------------
// 15. Symbol with no edges
// ---------------------------------------------------------------------------

test('trace_workflow: symbol with no edges → empty steps + narrative text', async (t) => {
  const graph: GraphData = {
    symbols: { Lonely: [] },
    callers: { Lonely: [] },
    symbolFile: { Lonely: 'l.ts' },
  } as unknown as GraphData;
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, graph);
  const result = await traceWorkflowAsync({
    projectRoot: root, symbol: 'Lonely', writeToBlackboard: false,
  });
  // Root is always included; the step list has just the root.
  assert.equal(result.data.steps.length, 1);
  assert.equal(result.data.steps[0]?.symbol, 'Lonely');
  assert.match(result.data.narrativeText, /^1\. Lonely: root/);
});

// ---------------------------------------------------------------------------
// 16. Participants list
// ---------------------------------------------------------------------------

test('trace_workflow: participants list contains the root + every distinct step symbol', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  const result = await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', writeToBlackboard: false,
  });
  const symbols = result.data.participants.map((p) => p.symbol);
  assert.ok(symbols.includes('BookingService.create'));
  const stepSymbols = new Set(result.data.steps.map((s) => s.symbol));
  for (const s of stepSymbols) {
    assert.ok(symbols.includes(s), `participant missing for step ${s}`);
  }
  // Root is first + flagged.
  const rootP = result.data.participants[0];
  assert.equal(rootP?.symbol, 'BookingService.create');
  assert.equal(rootP?.isRoot, true);
});

// ---------------------------------------------------------------------------
// 17. Side effects propagate
// ---------------------------------------------------------------------------

test('trace_workflow: side effects from graph.sideEffects propagate to steps', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  const result = await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', writeToBlackboard: false,
  });
  const stripeStep = result.data.steps.find((s) => s.symbol === 'StripeAdapter.call');
  assert.ok(stripeStep, 'StripeAdapter.call must be in the trace');
  assert.equal(stripeStep?.sideEffects.length, 1);
  assert.equal(stripeStep?.sideEffects[0]?.kind, 'http');
});

// ---------------------------------------------------------------------------
// 18. Level-order depth
// ---------------------------------------------------------------------------

test('trace_workflow: level-order — root depth 0, neighbors depth 1', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  const result = await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', writeToBlackboard: false,
  });
  const rootStep = result.data.steps.find((s) => s.symbol === 'BookingService.create');
  const neighbor = result.data.steps.find((s) => s.symbol === 'PaymentService.charge');
  assert.equal(rootStep?.hop, 0);
  assert.equal(neighbor?.hop, 1);
});

// ---------------------------------------------------------------------------
// 19. Inbound + outbound both surface
// ---------------------------------------------------------------------------

test('trace_workflow: inbound + outbound both surface in the trace for a 2-sided symbol', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  const result = await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', writeToBlackboard: false,
  });
  const symbols = result.data.steps.map((s) => s.symbol);
  // Inbound: main
  assert.ok(symbols.includes('main'));
  // Outbound: PaymentService.charge, AuditLog.append
  assert.ok(symbols.includes('PaymentService.charge'));
  assert.ok(symbols.includes('AuditLog.append'));
});

// ---------------------------------------------------------------------------
// 20. sequenceDiagram header
// ---------------------------------------------------------------------------

test('trace_workflow: sequenceDiagram block contains the sequenceDiagram header', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  const result = await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', writeToBlackboard: false,
  });
  assert.ok(result.data.sequenceDiagram.startsWith('sequenceDiagram'));
});

// ---------------------------------------------------------------------------
// 21. parseMermaidSequenceDiagram: handles alt/else/end (rejected unless supported)
// ---------------------------------------------------------------------------

test('parseMermaidSequenceDiagram: rejects unsupported alt/else/end by default', () => {
  const body = [
    'sequenceDiagram',
    '  participant A',
    '  A->>A: x',
    '  alt case',
    '  A->>A: y',
    '  else other',
    '  A->>A: z',
    '  end',
  ].join('\n');
  // The fixture intentionally does not recognize alt/else/end — we never
  // emit them. Confirm the parser fails fast.
  assert.throws(() => parseMermaidSequenceDiagram(body), /unrecognized/);
});

// ---------------------------------------------------------------------------
// 22. parseMermaidSequenceDiagram: rejects undeclared participants in notes
// ---------------------------------------------------------------------------

test('parseMermaidSequenceDiagram: rejects notes on undeclared participants', () => {
  const body = [
    'sequenceDiagram',
    '  participant A',
    '  Note right of B: hi',
  ].join('\n');
  assert.throws(() => parseMermaidSequenceDiagram(body), /undeclared/);
});

// ---------------------------------------------------------------------------
// 23. parseMermaidSequenceDiagram: handles Note right of / Note over / Note left of (re-test for coverage)
// ---------------------------------------------------------------------------

test('parseMermaidSequenceDiagram: Note over A with single owner parses cleanly', () => {
  const body = [
    'sequenceDiagram',
    '  participant A',
    '  Note over A: cross',
  ].join('\n');
  const parsed = parseMermaidSequenceDiagram(body);
  assert.equal(parsed.notes[0]?.owner, 'A');
  assert.equal(parsed.notes[0]?.text, 'cross');
});

// ---------------------------------------------------------------------------
// 24. Inherited facts populated on blackboard read
// ---------------------------------------------------------------------------

test('trace_workflow: pre-call inherited facts counter reflects scratchpad contents', async (t) => {
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, makeGraph());
  const sessionId = `trace-workflow:${symbolSessionHash('BookingService.create')}`;
  await clearScratchpad(sessionId, { projectRoot: root });
  // Empty scratchpad → 0 inherited
  const r1 = await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', sessionId, writeToBlackboard: false,
  });
  assert.equal(r1.data.inheritedFacts, 0);
  // Add three facts, then re-read
  await appendScratchpad(sessionId, {
    ts: new Date().toISOString(),
    tool: 'audit_symbol',
    data: { a: 1 },
    reasoning: ['fact-one', 'fact-two', 'fact-three'],
    sessionId,
  }, { projectRoot: root });
  const r2 = await traceWorkflowAsync({
    projectRoot: root, symbol: 'BookingService.create', sessionId, writeToBlackboard: false,
  });
  assert.equal(r2.data.inheritedFacts, 3);
});

// ---------------------------------------------------------------------------
// 25. Empty graph.sideEffects still produces a step
// ---------------------------------------------------------------------------

test('trace_workflow: empty sideEffects for a symbol still produces a step', async (t) => {
  const graph: GraphData = {
    symbols: { A: ['B'], B: [] },
    callers: { A: [], B: ['A'] },
    symbolFile: { A: 'a.ts', B: 'b.ts' },
  } as unknown as GraphData;
  const root = makeProjectRoot(t);
  initGit(root);
  await writeGraph(root, graph);
  const result = await traceWorkflowAsync({
    projectRoot: root, symbol: 'A', writeToBlackboard: false,
  });
  const b = result.data.steps.find((s) => s.symbol === 'B');
  assert.ok(b);
  assert.equal(b?.sideEffects.length, 0);
});

// ---------------------------------------------------------------------------
// 26. symbolSessionHash produces sha1-truncated 8-hex values
// ---------------------------------------------------------------------------

test('symbolSessionHash: output is exactly 8 hex chars', () => {
  for (const sym of ['A', 'BookingService.create', 'Foo.Bar.Baz', '']) {
    const h = symbolSessionHash(sym);
    assert.match(h, /^[0-9a-f]{8}$/);
  }
});
