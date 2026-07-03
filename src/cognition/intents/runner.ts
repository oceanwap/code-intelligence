/**
 * intents/runner — PRD US-006 P4 intent runner.
 *
 * `runIntentAsync` validates inputs, executes the intent's DAG against
 * a tool registry, writes a synthesis to the blackboard, and returns a
 * `ToolResult`-shaped payload.
 *
 * The runner is intentionally thin: it does NOT classify intent. The
 * caller (the MCP `run_intent` tool, or `collaborate`) supplies the
 * intent name. The runner's job is execution + blackboard write +
 * synthesis. This is the cleaner separation: registry is declarative,
 * runner is executable, classification lives in `collaborate`.
 *
 * Failure mode (FR-1 / fail-loud, fail-typed):
 *   - unknown intent name → typed empty result + `intents.unknown` signal
 *   - DAG step tool missing → ok=false step + `intents.tool_missing` signal
 *   - tool throws → ok=false step + `intents.tool_error` signal
 *   The runner NEVER throws on bad input.
 *
 * Sprint 8 B1 (US-002): inherit the F5 inherited-facts cap from
 * `INHERITED_FACTS_CAP` so reasoning chains stay bounded.
 *
 * Sprint 8 US-001 (FR-11 backward-compat): thread `opts` into the
 * `resolveArgs` call so `$baseRef` / `$headRef` placeholders inside an
 * intent DAG resolve against caller-supplied options. Literal-only
 * intents (the 5 pre-existing intents) do NOT touch opts and stay
 * byte-equal to the pre-Sprint-8 implementation.
 */

import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { validateGraphPath } from '../../utils/security.js';
import {
  makeToolResult,
  type ToolResult,
  type Signal,
  type Source,
  type ReasoningFact,
} from '../signalization/types.js';
import { inheritReasoning, appendReasoning } from '../reasoning/bus.js';
import { appendScratchpad, readScratchpad } from '../blackboard/scratchpad.js';
import {
  type ToolStep,
  type ToolRegistry,
  type CollaborateExecutedStep,
  resolveArgs,
  CollaborateArgResolutionError,
  asResolvedPrior,
  type ResolvedPriorStep,
} from '../audit/collaborate.js';
import { getIntent, hasIntent, type RegisteredIntentName } from './registry.js';
import { INHERITED_FACTS_CAP } from '../audit/inherited-facts-cap.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunIntentInput {
  projectRoot: string;
  /** Name of the intent to run. Must be a registered intent (FR-8). */
  intent: RegisteredIntentName;
  /** Per-step parameter overrides. Keys are tool names; values merge into the DAG step `args`. */
  overrides?: Record<string, Record<string, unknown>>;
  /**
   * Caller-supplied options threaded into `$ref: '$key'` placeholders.
   *
   * Used by the Sprint 8 `review` intent: the DAG carries
   * `{ $ref: '$baseRef' }` / `{ $ref: '$headRef' }` references that
   * resolve against this object at run-time. For the 5 pre-existing
   * intents (audit / onboard / refactor / debug / release-prep), this
   * argument is `undefined` and resolveArgs returns byte-equal args
   * (FR-11 backward-compat).
   */
  opts?: Record<string, unknown>;
  /** Override the tool registry (testing). */
  toolRegistry: ToolRegistry;
  writeToBlackboard?: boolean;
  sessionId?: string;
  qdrantUrl?: string;
}

export interface RunIntentPayload {
  intent: RegisteredIntentName;
  /** The DAG that was executed (after overrides were applied). */
  dag: ToolStep[];
  /** Per-step execution record (in execution order). */
  executed: CollaborateExecutedStep[];
  /** Human synthesis of the result (intent.post + a one-line status). */
  synthesis: string;
  /** Reasoning chain (FR-4). */
  reasoning_chain: ReasoningFact[];
  /**
   * B1: surfaced in the payload so callers can reason about the
   * deterministic upper bound on inherited facts. Always equals
   * `INHERITED_FACTS_CAP` (mirrors `trace_workflow.inheritedFactsCap`).
   */
  inheritedFactsCap: number;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run a registered intent. Always returns a ToolResult; never throws on
 * unknown intent or missing tools.
 */
export async function runIntentAsync(
  input: RunIntentInput,
): Promise<ToolResult<RunIntentPayload>> {
  const projectRoot = path.resolve(input.projectRoot);
  validateGraphPath(projectRoot, 'run_intent');
  const writeToBlackboard = input.writeToBlackboard !== false;
  const sessionId = input.sessionId ?? `run-intent:${input.intent}:${sessionHash(`${input.intent}|${projectRoot}`)}`;
  void input.qdrantUrl;

  const signals: Signal[] = [];
  const sources: Source[] = [
    { kind: 'tool', ref: 'run_intent' },
    { kind: 'external', ref: `intent: ${input.intent}` },
  ];
  const reasoning: ReasoningFact[] = [];

  // Inherit prior facts (FR-4), capped (B1 F5).
  const prior = await readScratchpad(sessionId, { projectRoot });
  const recentPrior = prior.slice(-INHERITED_FACTS_CAP);
  const priorFacts: (string | ReasoningFact)[] = [];
  for (const entry of recentPrior) {
    if (Array.isArray(entry.reasoning)) {
      for (const f of entry.reasoning) {
        if (typeof f === 'string' && f.trim()) priorFacts.push(f);
      }
    }
  }
  reasoning.push(...inheritReasoning(priorFacts));

  // Leading fact.
  pushReasoning(reasoning, { fact: `run_intent called for ${input.intent} inheritedFactsCap=${INHERITED_FACTS_CAP}`, source: 'run_intent' });

  // Resolve the intent.
  if (!hasIntent(input.intent)) {
    signals.push({ kind: 'intents.unknown', payload: { name: input.intent } });
    pushReasoning(reasoning, { fact: `unknown intent "${input.intent}"`, source: 'run_intent' });
    return finalize({
      intent: input.intent,
      dag: [],
      executed: [],
      synthesis: `Unknown intent "${input.intent}". Registered intents: audit, onboard, refactor, debug, release-prep, review.`,
      reasoning_chain: reasoning,
      inheritedFactsCap: INHERITED_FACTS_CAP,
    }, signals, sources, sessionId, projectRoot, writeToBlackboard, 'AMBIGUOUS');
  }

  const record = getIntent(input.intent);
  const dag = applyOverrides(record.dag, input.overrides);
  pushReasoning(reasoning, {
    fact: `intent "${input.intent}" resolved (${dag.length} step(s))`,
    source: 'run_intent',
  });

  // Execute DAG.
  const executed: CollaborateExecutedStep[] = [];
  // F6 — collect prior step ToolResult envelopes for $ref resolution.
  // F2 — at the same time, per-step evidence flows to the same
  // sessionId via appendScratchpad, mirroring collaborate.ts.
  const priorResults: ResolvedPriorStep[] = [];
  for (const step of dag) {
    const stepFacts: ReasoningFact[] = [];
    pushReasoning(stepFacts, { fact: `${step.name} (${step.rationale})`, source: 'run_intent.dag' });
    if (!input.toolRegistry.has(step.name)) {
      pushReasoning(stepFacts, { fact: `tool "${step.name}" not registered; step skipped`, source: 'run_intent.dag' });
      signals.push({ kind: 'intents.tool_missing', payload: { tool: step.name } });
      executed.push({
        name: step.name,
        args: step.args,
        rationale: step.rationale,
        ok: false,
        summary: `tool "${step.name}" not registered`,
        reasoning: stepFacts,
      });
      continue;
    }

    // F6: resolve $ref / $concat / $const in step.args against the
    // immediately prior step's ToolResult envelope. Sprint 8 US-001:
    // `$ref: '$key'` placeholders in the DAG args are resolved against
    // the caller's `input.opts` object. Literal-only intents (audit,
    // onboard, debug, release-prep) pass `input.opts ?? undefined` so
    // the resolver byte-equals the pre-Sprint-8 implementation.
    let resolvedArgs: Record<string, unknown>;
    try {
      resolvedArgs = resolveArgs(step.args, priorResults, input.opts);
    } catch (err) {
      if (err instanceof CollaborateArgResolutionError) {
        const message = `arg resolution failed at ${err.path}: ${err.message}`;
        pushReasoning(stepFacts, { fact: message, source: 'run_intent.dag' });
        signals.push({
          kind: 'intents.arg_resolution_error',
          payload: { tool: step.name, path: err.path, message: err.message },
        });
        executed.push({
          name: step.name,
          args: step.args,
          rationale: step.rationale,
          ok: false,
          summary: `arg resolution error: ${err.path}`,
          reasoning: stepFacts,
        });
        continue;
      }
      throw err;
    }

    try {
      const result = await input.toolRegistry.call(step.name, { ...resolvedArgs, projectRoot });
      const summary = summarizeLeafResult(result);
      pushReasoning(stepFacts, { fact: `${step.name} returned ${summary}`, source: step.name });

      // F6 — capture envelope for next step's $ref resolution.
      const envelope = asResolvedPrior(result);
      priorResults.push(envelope);

      // F2 — per-step reasoning (from the leaf's ToolResult if any,
      // else the executor's local stepFacts) feeds the outer scratchpad.
      const perStepReasoning: ReasoningFact[] = envelope.reasoning && envelope.reasoning.length > 0
        ? envelope.reasoning.map((r) => ({ fact: r.fact ?? '', source: r.source ?? step.name }))
            .filter((r) => r.fact.length > 0)
        : stepFacts;

      executed.push({
        name: step.name,
        args: resolvedArgs,
        rationale: step.rationale,
        ok: true,
        summary,
        reasoning: stepFacts,
      });

      if (writeToBlackboard) {
        await appendScratchpad(sessionId, {
          ts: new Date().toISOString(),
          tool: step.name,
          data: {
            kind: 'run_intent.step',
            step: step.name,
            intent: input.intent,
            args: resolvedArgs,
            summary,
          },
          reasoning: perStepReasoning.map((f) => f.fact),
          confidence_tier: envelope.confidence_tier ?? 'EXTRACTED',
          sessionId,
        }, { projectRoot });
      }
    } catch (error) {
      const message = (error as Error).message;
      pushReasoning(stepFacts, { fact: `${step.name} threw: ${message}`, source: step.name });
      signals.push({ kind: 'intents.tool_error', payload: { tool: step.name, message } });
      executed.push({
        name: step.name,
        args: resolvedArgs,
        rationale: step.rationale,
        ok: false,
        summary: `error: ${message}`,
        reasoning: stepFacts,
      });
      // A failed step still occupies a slot in priorResults so the next
      // step's $ref (if any) resolves against its (empty) envelope.
      priorResults.push({});
    }
    for (const f of stepFacts) pushReasoning(reasoning, f);
  }

  // Synthesis: post lines + a one-line status.
  const synthesis = buildSynthesis(record, executed);
  pushReasoning(reasoning, { fact: `synthesis produced ${synthesis.length} char(s)`, source: 'run_intent' });

  const tier = executed.length === 0
    ? 'AMBIGUOUS'
    : executed.every((e) => e.ok)
      ? 'EXTRACTED'
      : executed.some((e) => e.ok)
        ? 'INFERRED'
        : 'AMBIGUOUS';

  return finalize({
    intent: input.intent,
    dag,
    executed,
    synthesis,
    reasoning_chain: reasoning,
    inheritedFactsCap: INHERITED_FACTS_CAP,
  }, signals, sources, sessionId, projectRoot, writeToBlackboard, tier);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyOverrides(
  dag: ToolStep[],
  overrides?: Record<string, Record<string, unknown>>,
): ToolStep[] {
  if (!overrides) return dag;
  return dag.map((step) => {
    const override = overrides[step.name];
    if (!override) return step;
    return { ...step, args: { ...step.args, ...override } };
  });
}

function buildSynthesis(
  record: { name: RegisteredIntentName; post: string[]; description: string },
  executed: CollaborateExecutedStep[],
): string {
  const okCount = executed.filter((e) => e.ok).length;
  const lines: string[] = [];
  lines.push(`Intent: ${record.name} — ${record.description}`);
  lines.push(`Status: ${okCount}/${executed.length} step(s) succeeded.`);
  for (const step of executed) {
    const status = step.ok ? 'OK ' : 'ERR';
    lines.push(`  [${status}] ${step.name}: ${step.summary}`);
  }
  lines.push('');
  lines.push('Recommended next steps:');
  for (const post of record.post) {
    lines.push(`  - ${post}`);
  }
  return lines.join('\n');
}

function summarizeLeafResult(result: unknown): string {
  if (result == null) return 'null';
  if (typeof result === 'string') return truncate(result, 80);
  if (typeof result === 'number' || typeof result === 'boolean') return String(result);
  if (Array.isArray(result)) return `array(len=${result.length})`;
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r['summary'] === 'string') return truncate(r['summary'], 80);
    if (r['data'] != null && typeof r['data'] === 'object') {
      const d = r['data'] as Record<string, unknown>;
      return `tool_result{keys=${Object.keys(d).slice(0, 4).join(',')}}`;
    }
    return `object{keys=${Object.keys(r).slice(0, 4).join(',')}}`;
  }
  return truncate(String(result), 80);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

function sessionHash(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 12);
}

/** In-place variant of `appendReasoning`; see audit/collaborate.ts for the rationale. */
function pushReasoning(chain: ReasoningFact[], fact: ReasoningFact | string): void {
  const next = appendReasoning(chain, fact);
  chain.length = 0;
  chain.push(...next);
}

async function finalize(
  data: RunIntentPayload,
  signals: Signal[],
  sources: Source[],
  sessionId: string,
  projectRoot: string,
  writeToBlackboard: boolean,
  tier: ToolResult['confidence_tier'],
): Promise<ToolResult<RunIntentPayload>> {
  const result = makeToolResult<RunIntentPayload>(data, {
    signals,
    sources,
    reasoning: data.reasoning_chain,
    confidence_tier: tier,
  });
  if (writeToBlackboard) {
    await appendScratchpad(sessionId, {
      ts: new Date().toISOString(),
      tool: 'run_intent',
      data: result.data,
      reasoning: result.reasoning.map((f) => f.fact),
      confidence_tier: result.confidence_tier,
      sessionId,
    }, { projectRoot });
  }
  return result;
}
