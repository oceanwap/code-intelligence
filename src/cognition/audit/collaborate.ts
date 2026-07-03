/**
 * collaborate — US-005 P3b `collaborate` meta-tool.
 *
 * Goal-shaped entry point. Given a natural-language `goal` string, classify
 * the intent (heuristic by default, Ollama opt-in), pick a deterministic
 * tool DAG from a registered set, execute the DAG against existing leaves,
 * and return a synthesis.
 *
 * Hard constraints (PRD US-005 + OQ-1 + DR-5):
 *   - No LLM by default; `llm: 'heuristic'` is the only default.
 *   - Recognized intents (at minimum): `audit <symbol>`, `onboard`,
 *     `refactor <area>`, `debug <symptom>`, `release-prep`.
 *   - DAG references tool NAMES; the runner resolves names against the
 *     supplied tool registry (this lets tests pass mock implementations).
 *   - Deterministic: same goal + same registry + same graph → same output.
 *
 * Failure mode: unknown intent or unknown tool in DAG → returns a typed
 * empty result with a `collaborate.leaf_missing` signal. Never throws on
 * bad intent classification.
 *
 * =====================================================================
 * F2 — per-step blackboard threading (Sprint 6b deferred finding)
 * =====================================================================
 *
 * Per-step ToolResult evidence is threaded to the outer scratchpad via
 * FLAT APPEND at the same sessionId used for the outer synthesis. Each
 * successful step contributes one additional entry whose `reasoning`
 * array carries the step's own reasoning facts (distinct from the
 * outer synthesis's facts). On a subsequent call, `readScratchpad`
 * iteration pulls ALL entries — outer synthesis + per-step — into the
 * `priorFacts` accumulator that `inheritReasoning` consumes. So a
 * second call inherits the first call's per-leaf evidence (audit_symbol
 * facts, trace_workflow facts, …), not only its outer synthesis.
 *
 * The bridge in `mcp-server.ts:buildCollaborateToolRegistry` passes the
 * outer `writeToBlackboard` flag through to each inner leaf call (it is
 * NOT forced to `false`), so each leaf can write its own ToolResult to
 * the outer sessionId. When `writeToBlackboard: false` is supplied at
 * the outer call, neither outer nor per-step writes happen.
 *
 * =====================================================================
 * F6 — DAG $ref dataflow (Sprint 6b deferred finding)
 * =====================================================================
 *
 * Any value in a `ToolStep.args` may be a `RefExpression` instead of a
 * literal. The runner calls `resolveArgs(args, priorSteps)` immediately
 * before dispatch, which substitutes `$ref` against the prior step's
 * `ToolResult` envelope and supports `$concat` for string composition.
 *
 * See `intents/registry.ts` for the `RefExpression` type and the path
 * syntax contract. `resolveArgs` is a pure function exported for test
 * reuse.
 */

import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { validateGraphPath } from '../../utils/security.js';
import {
  makeToolResult,
  type ToolResult,
  type Signal,
  type Source,
} from '../signalization/types.js';
import { inheritReasoning, appendReasoning, type ReasoningFact } from '../reasoning/bus.js';
import { appendScratchpad, readScratchpad } from '../blackboard/scratchpad.js';
import { INHERITED_FACTS_CAP } from './inherited-facts-cap.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Recognized intent name. Stable; surfaces in `data.classified`. */
export type IntentName =
  | 'audit'
  | 'onboard'
  | 'refactor'
  | 'debug'
  | 'release-prep'
  | 'unknown';

/** One step in a tool DAG. `name` resolves via the supplied `ToolRegistry`. */
export interface ToolStep {
  name: string;
  /** Static arguments to pass to the tool. Mutable per-execution if needed.
   *
   *  F6: any value in `args` may be a `RefExpression` (see
   *  `intents/registry.ts`) — the runner resolves these against the
   *  immediately prior step's ToolResult before dispatch. Literal-only
   *  args round-trip byte-equal through the resolver. */
  args: Record<string, unknown>;
  /** Human description of why this step is in the DAG. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// F6 — RefExpression resolution (Sprint 6b deferred finding)
// ---------------------------------------------------------------------------

/** Typed error thrown by `resolveArgs` when a `$ref` cannot be resolved.
 *
 *  Carries the unresolvable `path` so callers (and tests) can surface a
 *  precise diagnostic. The executor's step loop catches this and turns
 *  it into a `collaborate.arg_resolution_error` signal + an `ok: false`
 *  executed-step record — never throws past the boundary. */
export class CollaborateArgResolutionError extends Error {
  readonly path: string;
  readonly stepName?: string;
  constructor(path: string, message: string, stepName?: string) {
    super(message);
    this.name = 'CollaborateArgResolutionError';
    this.path = path;
    this.stepName = stepName;
  }
}

/** A captured `ToolResult` from a prior DAG step, used as the resolution
 *  source for `$ref` expressions. The runner fills this from the value
 *  returned by `toolRegistry.call(step.name, …)`.
 *
 *  Only the fields actually walked by `resolveArgs` are typed here; the
 *  resolver is shape-tolerant via field-name lookups (e.g. `data`,
 *  `signals`, `reasoning`, `confidence_tier`). */
export interface ResolvedPriorStep {
  data?: unknown;
  signals?: ReadonlyArray<{ kind?: string; payload?: unknown }>;
  reasoning?: ReadonlyArray<{ fact?: string; source?: string }>;
  confidence_tier?: string;
}

/** Sentinel returned by the resolver when a `$ref` path walks into a
 *  non-traversable intermediate value (e.g. `null` deeper than the
 *  requested path). Tests assert that null/missing values pass through
 *  without throwing. */
const UNRESOLVED = Symbol('UNRESOLVED');

/** Walk a `prev.<keyPath>` expression against the immediately prior step.
 *
 *  Path syntax (PRD F6 brief):
 *    prev.data.<key>.<key>...     — dot-walks `data`
 *    prev.signals[<n>].<key>      — array index + dot-walk into a signal
 *    prev.reasoning[<n>].<key>    — same for the reasoning chain
 *    prev.confidence_tier         — the envelope's tier string
 *
 *  Returns `UNRESOLVED` if any segment is missing or non-traversable.
 *  The caller (`resolveArgs`) maps `UNRESOLVED` to a
 *  `CollaborateArgResolutionError` only when the missing value is
 *  actually requested as a final answer; for nullable values the result
 *  is `null`/`undefined` and the resolver does not throw. */
function walkRefPath(path: string, prior: ResolvedPriorStep): unknown {
  if (!path.startsWith('prev.')) {
    throw new CollaborateArgResolutionError(path, `ref path must start with "prev." (got "${path}")`);
  }
  const segments = path.slice('prev.'.length).split('.');
  let cursor: unknown = prior;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] ?? '';
    if (cursor == null) return UNRESOLVED;
    if (Array.isArray(cursor)) {
      const idx = Number.parseInt(seg, 10);
      if (!Number.isFinite(idx) || idx < 0 || idx >= cursor.length) return UNRESOLVED;
      cursor = cursor[idx];
      continue;
    }
    if (typeof cursor !== 'object') return UNRESOLVED;
    const obj = cursor as Record<string, unknown>;
    if (!(seg in obj)) return UNRESOLVED;
    cursor = obj[seg];
  }
  return cursor === undefined ? UNRESOLVED : cursor;
}

/** Resolve a single `RefExpression` against `prior` (or `optsRef` for
 *  caller-supplied placeholders). Returns `UNRESOLVED` for `$ref`
 *  whose path cannot be walked; the caller decides whether that should
 *  throw. `$const` returns its value unchanged. `$concat` joins all
 *  segments via `String(seg)`. */
function resolveExpression(
  expr: unknown,
  prior: ResolvedPriorStep | undefined,
  exprPath: string,
  optsRef?: Record<string, unknown>,
): unknown {
  if (expr == null || typeof expr !== 'object') return expr;
  const obj = expr as Record<string, unknown>;
  if (typeof obj['$ref'] === 'string') {
    const refPath = obj['$ref'];
    // Sprint 8: `$ref: '$key'` (leading $) is a caller-supplied opt ref,
    // resolved against the `optsRef` map. Distinct from `prev.*` which
    // walks the immediately-prior-step ToolResult envelope.
    if (refPath.startsWith('$')) {
      if (!optsRef) {
        throw new CollaborateArgResolutionError(
          refPath,
          `no opts passed to resolve ${refPath} (Sprint 8 review-intent opts thread required)`,
          exprPath,
        );
      }
      const key = refPath.slice(1);
      if (!(key in optsRef)) {
        throw new CollaborateArgResolutionError(
          refPath,
          `opt "${key}" not provided to resolveArgs (callers must pass optsRef with ${key})`,
          exprPath,
        );
      }
      return optsRef[key];
    }
    if (!prior) {
      throw new CollaborateArgResolutionError(refPath, `no prior step available to resolve ${refPath}`, exprPath);
    }
    const v = walkRefPath(refPath, prior);
    if (v === UNRESOLVED) {
      throw new CollaborateArgResolutionError(
        refPath,
        `cannot resolve ${refPath} against prior step (path missing or non-traversable)`,
        exprPath,
      );
    }
    return v;
  }
  if (Array.isArray(obj['$concat'])) {
    const parts: unknown[] = obj['$concat'];
    let out = '';
    for (const p of parts) {
      const resolved = resolveExpression(p, prior, exprPath, optsRef);
      out += resolved == null ? '' : String(resolved);
    }
    return out;
  }
  if ('$const' in obj) return obj['$const'];
  // Not a RefExpression — return as-is so nested recursion works.
  return expr;
}

/** Decide whether a plain-object value is a `RefExpression`. Mirrors
 *  `isRefExpression` in `intents/registry.ts`; kept local so the
 *  resolver can be unit-tested without re-importing the registry. */
function isRefExpressionLocal(value: unknown): boolean {
  if (value == null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return typeof obj['$ref'] === 'string'
    || Array.isArray(obj['$concat'])
    || '$const' in obj;
}

/** Resolve every `RefExpression` in `args` against the immediately prior
 *  step's `ToolResult` envelope. Walks nested objects and arrays
 *  recursively; non-expression values are returned byte-equal.
 *
 *  Contract:
 *    - Literal-only args round-trip unchanged.
 *    - `$ref` resolves against `priorSteps[priorSteps.length - 1]`
 *      (the IMMEDIATELY PRIOR step). Earlier steps are NOT directly
 *      addressable; thread state forward through intermediate steps.
 *    - Unresolvable `$ref` throws `CollaborateArgResolutionError` with
 *      the failing path in `.path`.
 *    - `$concat` joins all segments (refs + literals) into a string.
 *    - `$const` returns its inner value verbatim.
 *
 *  Sprint 8 US-001 + FR-11 backward-compat: `optsRef` (optional) lets
 *  the caller thread per-call options (e.g. `baseRef` / `headRef` for
 *  the `review` intent) into the resolver. The dispatcher can pass
 *  `undefined` for literal-only intents and the resolved args stay
 *  byte-equal to the pre-Sprint-8 implementation. Placeholders use
 *  the form `{ $ref: '$key' }` (note the leading `$` distinguishes
 *  them from `prev.*`).
 *
 *  This function is pure; the caller is responsible for mutating a copy
 *  if it wants to retain the original `args` shape. */
export function resolveArgs(
  args: Record<string, unknown>,
  priorSteps: ReadonlyArray<ResolvedPriorStep>,
  optsRef?: Record<string, unknown>,
): Record<string, unknown> {
  const prior = priorSteps.length > 0 ? priorSteps[priorSteps.length - 1] : undefined;
  return resolveArgsInternal(args, prior, '<root>', optsRef) as Record<string, unknown>;
}

function resolveArgsInternal(
  value: unknown,
  prior: ResolvedPriorStep | undefined,
  exprPath: string,
  optsRef?: Record<string, unknown>,
): unknown {
  if (isRefExpressionLocal(value)) {
    return resolveExpression(value, prior, exprPath, optsRef);
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => resolveArgsInternal(v, prior, `${exprPath}[${i}]`, optsRef));
  }
  if (value != null && typeof value === 'object') {
    // B4 (Sprint 8 US-002) F6 resolver gate: when the object contains
    // NO `$ref` / `$concat` / `$const` expressions ANYWHERE within its
    // shape (including any nested object/array values), skip the
    // per-entry walk and return the value byte-equal. This shortcuts
    // the 5 kB `query_project.question` strings Sprint 7 surfaced:
    // args with only primitive values (e.g. `{ question: "<long>" }`)
    // pass through resolveArgs with a single equality check, no walk.
    // `$ref` expressions still walk as before — `isRefExpressionLocal`
    // catches them at the top of the recursion.
    if (!objectContainsRefExpression(value)) {
      return value;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveArgsInternal(v, prior, `${exprPath}.${k}`, optsRef);
    }
    return out;
  }
  return value;
}

/**
 * B4 fast-path detector: walk the shape at most one level deep looking
 * for `$ref` / `$concat` / `$const` keys. Returns true when at least
 * one `$ref`-style expression exists SOMEWHERE inside (so recursion
 * must continue), false otherwise (so the caller can byte-equal
 * short-circuit the walk).
 *
 * One-level walk-through: when a shallow value is itself an object or
 * array, recurse one extra step so nested expressions are caught. This
 * is a *bounded* walk — in the worst case the depth equals the depth
 * of nesting in the user's args, which for the test surface is
 * typically 1-2 (e.g. `{ question: { ... } }`). The 5 kB string case
 * hits this once at the top and returns false; the `{ question: long
 * string }` form hits this once and returns false; no descent happens.
 */
function objectContainsRefExpression(value: object): boolean {
  // Direct $ref-shape check is done in the recursion caller already,
  // but be defensive: if THIS object's keys contain $ref-style keys,
  // we must descend into them.
  for (const key of Object.keys(value)) {
    if (key === '$ref' || key === '$concat' || key === '$const') return true;
  }
  for (const v of Object.values(value)) {
    if (v == null || typeof v !== 'object') continue;
    // Primitives never contain a RefExpression — already filtered out.
    // For nested objects/arrays, recurse one more level so we cover
    // `{ question: { $ref: ... } }` but bail before walking arbitrary
    // deep shapes (the contract: a single-arg-pass is byte-equal when
    // nothing at the surface looks ref-shaped).
    if (objectContainsRefExpression(v)) return true;
  }
  return false;
}

/** Coerce a `toolRegistry.call` return value into the
 *  `ResolvedPriorStep` shape that `resolveArgs` walks. The bridge may
 *  return either a `ToolResult<T>` envelope (preferred — supplies
 *  `data`, `signals`, `reasoning`, `confidence_tier`) or a bare
 *  `data` payload (legacy: the value the leaf would natively return).
 *  Bare payloads are wrapped so the next step's `$ref: prev.data.<x>`
 *  still resolves against them. */
export function asResolvedPrior(result: unknown): ResolvedPriorStep {
  if (result == null || typeof result !== 'object') {
    return { data: result };
  }
  const r = result as Record<string, unknown>;
  const isEnvelope = 'data' in r || 'signals' in r || 'reasoning' in r || 'confidence_tier' in r;
  if (isEnvelope) {
    return {
      data: r['data'],
      signals: Array.isArray(r['signals']) ? (r['signals'] as ResolvedPriorStep['signals']) : [],
      reasoning: Array.isArray(r['reasoning']) ? (r['reasoning'] as ResolvedPriorStep['reasoning']) : [],
      confidence_tier: typeof r['confidence_tier'] === 'string' ? r['confidence_tier'] : undefined,
    };
  }
  // Bare data payload: wrap so `prev.data.<x>` walks against it.
  return { data: result };
}

/** Description of a registered intent. */
export interface IntentSpec {
  name: IntentName;
  description: string;
  /** DAG of tool calls the runner executes in order. */
  dag: ToolStep[];
  /** Post-execution synthesis lines (deterministic). */
  post: string[];
}

/** Result of running an intent DAG. */
export interface CollaborateExecutedStep {
  name: string;
  args: Record<string, unknown>;
  rationale: string;
  ok: boolean;
  /** Result payload (truncated to a string when complex). */
  summary: string;
  /** Per-step reasoning facts. */
  reasoning: ReasoningFact[];
}

/** Payload returned by `collaborate`. */
export interface CollaboratePayload {
  /** The original goal string. */
  goal: string;
  /** Heuristic or LLM used. */
  llm: 'heuristic' | 'ollama';
  /** Detected intent. */
  classified: IntentName;
  /** Confidence of the classification in [0,1]. */
  classifiedConfidence: number;
  /** Recognized symbol from the goal (for `audit <symbol>`). */
  detectedSymbol: string | null;
  /** The DAG that was executed. */
  dag: ToolStep[];
  /** Per-step execution record (in execution order). */
  executed: CollaborateExecutedStep[];
  /** Human synthesis of the result. */
  synthesized: string;
  /** Reasoning chain. */
  reasoning_chain: ReasoningFact[];
}

export interface CollaborateInput {
  projectRoot: string;
  goal: string;
  hints?: string[];
  llm?: 'heuristic' | 'ollama';
  sessionId?: string;
  qdrantUrl?: string;
  writeToBlackboard?: boolean;
  /** Override the tool registry (testing). When omitted, the default is used. */
  toolRegistry?: ToolRegistry;
}

/** A registry mapping a tool name to a callable. Pure async function. */
export interface ToolRegistry {
  has(name: string): boolean;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Intent classification (heuristic, deterministic)
// ---------------------------------------------------------------------------

/**
 * Score an intent against a goal string. Pure, deterministic.
 *
 * Strategy: keyword weight table + symbol extractor. The intent with the
 * highest score wins; ties broken by registration order. Empty / whitespace
 * goals → `unknown`.
 */
const INTENT_PATTERNS: Array<{
  name: IntentName;
  keywords: Array<{ token: string; weight: number }>;
  regex: RegExp[];
  symbolCapture?: RegExp;
}> = [
  {
    name: 'audit',
    keywords: [
      { token: 'audit', weight: 4 },
      { token: 'inspect', weight: 2 },
      { token: 'understand', weight: 1 },
      { token: 'review', weight: 2 },
      { token: 'check', weight: 1 },
    ],
    regex: [/^audit\b/i, /\baudit\s+[`"']?([A-Za-z_$][\w$.]*)[`"']?/i, /\binspect\s+[`"']?([A-Za-z_$][\w$.]*)[`"']?/i],
    symbolCapture: /\b(?:audit|inspect|review|check)\s+[`"']?([A-Za-z_$][\w$.]*)[`"']?/i,
  },
  {
    name: 'onboard',
    keywords: [
      { token: 'onboard', weight: 4 },
      { token: 'onboarding', weight: 3 },
      { token: 'newcomer', weight: 2 },
      { token: 'tour', weight: 2 },
      { token: 'overview', weight: 1 },
    ],
    regex: [/\bonboard(?:ing)?\b/i, /\bnewcomer\b/i, /\btour\b/i],
  },
  {
    name: 'refactor',
    keywords: [
      { token: 'refactor', weight: 4 },
      { token: 'restructure', weight: 3 },
      { token: 'rework', weight: 2 },
      { token: 'improve', weight: 1 },
      { token: 'cleanup', weight: 2 },
    ],
    regex: [/\brefactor\b/i, /\brestructure\b/i, /\bcleanup\b/i, /\brework\b/i],
    symbolCapture: /\b(?:refactor|restructure|rework|cleanup)\s+[`"']?([A-Za-z_$][\w$.]*)[`"']?/i,
  },
  {
    name: 'debug',
    keywords: [
      { token: 'debug', weight: 4 },
      { token: 'fix', weight: 2 },
      { token: 'bug', weight: 3 },
      { token: 'error', weight: 1 },
      { token: 'crash', weight: 2 },
      { token: 'broken', weight: 2 },
    ],
    regex: [/\bdebug\b/i, /\bbug\b/i, /\bbroken\b/i, /\bcrash(?:es|ing|ed)?\b/i, /\btypeerror\b/i, /\b500\b/],
  },
  {
    name: 'release-prep',
    keywords: [
      { token: 'release', weight: 4 },
      { token: 'ship', weight: 2 },
      { token: 'deploy', weight: 2 },
      { token: 'tag', weight: 1 },
      { token: 'changelog', weight: 2 },
    ],
    regex: [/\brelease[\s-]?prep\b/i, /\bship\s+it\b/i, /\bcut\s+a\s+release\b/i, /\bpre[\s-]?release\b/i],
  },
];

export interface Classification {
  intent: IntentName;
  confidence: number;
  symbol: string | null;
}

/** Classify a goal string. Pure, no I/O. */
export function classifyGoal(goal: string): Classification {
  const normalized = (goal ?? '').trim();
  if (!normalized) {
    return { intent: 'unknown', confidence: 0, symbol: null };
  }
  const lower = normalized.toLowerCase();
  const scores: Record<IntentName, number> = {
    audit: 0,
    onboard: 0,
    refactor: 0,
    debug: 0,
    'release-prep': 0,
    unknown: 0,
  };
  let capturedSymbol: string | null = null;

  for (const spec of INTENT_PATTERNS) {
    for (const kw of spec.keywords) {
      // Word-boundary keyword match: avoid partial-word matches
      const re = new RegExp(`\\b${escapeRegExp(kw.token)}\\b`, 'i');
      if (re.test(lower)) {
        scores[spec.name] += kw.weight;
      }
    }
    for (const re of spec.regex) {
      if (re.test(normalized)) {
        scores[spec.name] += 1;
      }
    }
    if (!capturedSymbol && spec.symbolCapture) {
      const m = spec.symbolCapture.exec(normalized);
      if (m && m[1]) capturedSymbol = m[1];
    }
  }

  let best: IntentName = 'unknown';
  let bestScore = 0;
  for (const [name, score] of Object.entries(scores) as Array<[IntentName, number]>) {
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }
  if (bestScore === 0) {
    return { intent: 'unknown', confidence: 0, symbol: null };
  }
  // Normalize confidence into [0,1]. BestScore of 6+ maps to ~1.0.
  const confidence = Math.min(1, bestScore / 6);
  return { intent: best, confidence, symbol: capturedSymbol };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Intent DAGs (deterministic, no LLM)
// ---------------------------------------------------------------------------

/**
 * Build the DAG for an intent. Pure, returns a fresh array each call so
 * the runner can mutate `args` without polluting the registry.
 */
export function dagForIntent(intent: IntentName, ctx: { symbol: string | null; goal: string; hints?: string[] }): ToolStep[] {
  switch (intent) {
    case 'audit':
      return buildAuditDag(ctx.symbol, ctx.goal);
    case 'onboard':
      return buildOnboardDag();
    case 'refactor':
      return buildRefactorDag(ctx.symbol ?? ctx.goal, ctx.hints);
    case 'debug':
      return buildDebugDag(ctx.symbol, ctx.goal);
    case 'release-prep':
      return buildReleasePrepDag();
    case 'unknown':
    default:
      return [];
  }
}

function buildAuditDag(symbol: string | null, goal: string): ToolStep[] {
  const target = symbol ?? extractFirstToken(goal) ?? 'unknown';
  return [
    {
      name: 'audit_symbol',
      args: { symbol: target },
      rationale: 'fuse behavior + risk + impact + duplicates + blast radius for the detected symbol',
    },
    {
      name: 'trace_workflow',
      args: { symbol: target, hops: 2 },
      rationale: 'render a numbered narrative + Mermaid sequence diagram for the audit target',
    },
  ];
}

function buildOnboardDag(): ToolStep[] {
  return [
    {
      name: 'project_status',
      args: {},
      rationale: 'start with the project-state summary so the agent knows what is indexed',
    },
    {
      name: 'feature_map',
      args: {},
      rationale: 'lay out the feature surface at a high level',
    },
    {
      name: 'repo_map',
      args: {},
      rationale: 'aider-style file→symbol overview ranked by call-graph PageRank',
    },
  ];
}

function buildRefactorDag(area: string, hints?: string[]): ToolStep[] {
  return [
    {
      name: 'plan_refactor',
      args: { baseRef: 'main', headRef: 'HEAD' },
      rationale: 'rank intervention steps across the current branch diff',
    },
    {
      name: 'analyze_impact',
      args: { symbol: area },
      rationale: `measure call-graph blast radius of the refactor target "${area}"`,
    },
    {
      name: 'regression_risk',
      args: { symbol: area },
      rationale: 'surface recent regression history for the refactor target',
    },
    ...(hints && hints.length > 0
      ? [
          {
            name: 'query_project',
            args: { question: hints.join(' ') },
            rationale: 'follow caller-supplied hints via semantic code search',
          },
        ]
      : []),
  ];
}

function buildDebugDag(symbol: string | null, goal: string): ToolStep[] {
  const target = symbol ?? extractFirstToken(goal) ?? 'unknown';
  return [
    {
      name: 'get_symbol',
      args: { symbol: target },
      rationale: `get the indexed signature + neighbors of "${target}"`,
    },
    {
      name: 'regression_risk',
      args: { symbol: target },
      rationale: 'score recent regression history',
    },
    {
      name: 'render_behavior',
      args: { symbol: target, format: 'json' },
      rationale: 'enumerate side effects to identify the failure surface',
    },
    {
      name: 'query_project_memory',
      args: { question: goal },
      rationale: 'search project memory for prior fixes matching the symptom',
    },
  ];
}

function buildReleasePrepDag(): ToolStep[] {
  return [
    {
      name: 'plan_refactor',
      args: { baseRef: 'main', headRef: 'HEAD' },
      rationale: 'intervention plan for the current branch diff before release',
    },
    {
      name: 'architecture_drift',
      args: { limit: 5 },
      rationale: 'surface any architecture-drift signals that should block release',
    },
    // FIX F10: replaced the previous `regression_risk` step (which passed
    // the literal symbol `'HOTSPOT'` — a non-existent symbol that scored
    // 0/null and silently masked release-blocking risks) with
    // `risk_hotspots`, which returns the top-N globally elevated
    // symbols. The literal string could never match a real symbol, so
    // the step emitted an empty result and the synthesis missed every
    // elevated-risk call site.
    {
      name: 'risk_hotspots',
      args: { limit: 10, excludeSinkNodes: false },
      rationale: 'top-10 globally elevated regression-risk symbols to block release',
    },
  ];
}

function extractFirstToken(goal: string): string | null {
  // Try multi-segment dotted names first (Foo.Bar.baz) — greedy to capture
  // as many segments as possible.
  const m = /\b([A-Z][A-Za-z0-9_$]*(?:\.[A-Za-z_$][\w$]*)+)\b/.exec(goal);
  if (m && m[1]) return m[1];
  const m2 = /\b([A-Z][A-Za-z0-9_$]{2,})\b/.exec(goal);
  return m2 && m2[1] ? m2[1] : null;
}

// ---------------------------------------------------------------------------
// Default tool registry
// ---------------------------------------------------------------------------

/**
 * Build a tool registry from a small in-process table. Used when the caller
 * does NOT supply its own. The default registry resolves names to leaf
 * imports and dispatches via the MCP-style contract.
 *
 * `getLeaf` is a factory that returns the bound leaf function for a name.
 * If a leaf is missing, the registry refuses the call (returns false from
 * `has`).
 */
export function buildDefaultToolRegistry(getLeaf: (name: string) => unknown | null): ToolRegistry {
  return {
    has(name: string): boolean {
      return getLeaf(name) != null;
    },
    async call(name: string, args: Record<string, unknown>): Promise<unknown> {
      const leaf = getLeaf(name);
      if (leaf == null) {
        throw new Error(`collaborate: unknown tool "${name}"`);
      }
      const fn = leaf as (...a: unknown[]) => Promise<unknown> | unknown;
      return await fn(args);
    },
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run `collaborate`. Classifies the goal, executes the DAG, returns a
 * synthesis. Always returns a ToolResult.
 */
export async function collaborateAsync(
  input: CollaborateInput,
): Promise<ToolResult<CollaboratePayload>> {
  const projectRoot = path.resolve(input.projectRoot);
  validateGraphPath(projectRoot, 'collaborate');
  const goal = (input.goal ?? '').trim();
  const llm = input.llm ?? 'heuristic';
  const writeToBlackboard = input.writeToBlackboard !== false;
  const sessionId = input.sessionId ?? `collaborate:${sessionHash(goal)}`;
  void input.qdrantUrl;
  const toolRegistry = input.toolRegistry ?? buildDefaultToolRegistry(() => null);

  const signals: Signal[] = [];
  const sources: Source[] = [
    { kind: 'tool', ref: 'collaborate' },
    { kind: 'external', ref: `goal: ${goal}` },
  ];
  const reasoning: ReasoningFact[] = [];

  // Inherit prior facts from the scratchpad (FR-4), capped (B1 F5).
  const prior = await readScratchpad(sessionId, { projectRoot });
  const recentPrior = prior.slice(-INHERITED_FACTS_CAP);
  const priorFacts: (string | ReasoningFact)[] = [];
  for (const entry of recentPrior) {
    if (Array.isArray(entry.reasoning)) {
      for (const f of entry.reasoning) {
        if (typeof f === 'string' && f.trim()) {
          priorFacts.push(f);
        }
      }
    }
  }
  reasoning.push(...inheritReasoning(priorFacts));

  // Leading fact.
  pushReasoning(reasoning, { fact: `collaborate called for goal="${shortGoal(goal)}" llm=${llm} inheritedFactsCap=${INHERITED_FACTS_CAP}`, source: 'collaborate' });

  // Classify.
  let classified: IntentName;
  let classifiedConfidence: number;
  let detectedSymbol: string | null;
  if (llm === 'ollama') {
    // OQ-1: heuristic-only for v1. Ollama is opt-in but deferred to v2.
    signals.push({ kind: 'collaborate.llm_unavailable', payload: { llm: 'ollama' } });
    const fallback = classifyGoal(goal);
    classified = fallback.intent;
    classifiedConfidence = fallback.confidence;
    detectedSymbol = fallback.symbol;
  } else {
    const result = classifyGoal(goal);
    classified = result.intent;
    classifiedConfidence = result.confidence;
    detectedSymbol = result.symbol;
  }

  appendReasoning(reasoning, {
    fact: `intent classified as ${classified} (confidence=${classifiedConfidence.toFixed(2)}) symbol=${detectedSymbol ?? 'none'}`,
    source: 'collaborate.classifier',
  });

  if (classified === 'unknown') {
    signals.push({ kind: 'collaborate.unknown_intent', payload: { goal } });
    const empty = emptyPayload(goal, llm, classified, classifiedConfidence, detectedSymbol, reasoning);
    const result = makeToolResult<CollaboratePayload>(empty, {
      signals,
      sources,
      reasoning,
      confidence_tier: 'AMBIGUOUS',
    });
    if (writeToBlackboard) {
      await appendScratchpad(sessionId, {
        ts: new Date().toISOString(),
        tool: 'collaborate',
        data: result.data,
        reasoning: result.reasoning.map(f => f.fact),
        confidence_tier: result.confidence_tier,
        sessionId,
      }, { projectRoot });
    }
    return result;
  }

  // Build DAG.
  const dag = dagForIntent(classified, { symbol: detectedSymbol, goal, hints: input.hints });
  if (dag.length === 0) {
    signals.push({ kind: 'collaborate.empty_dag', payload: { intent: classified } });
  }

  // Execute DAG in order.
  //
  // F6: each step's args may contain RefExpression placeholders that
  // resolve against the IMMEDIATELY PRIOR step's ToolResult envelope.
  // `priorResults` collects each step's resolved envelope as the loop
  // progresses; the resolver sees `priorResults[priorResults.length-1]`.
  //
  // F2: when `writeToBlackboard` is true, each successful step
  // contributes ONE additional scratchpad entry at the OUTER sessionId,
  // carrying the step's own `reasoning` facts (and a small `data`
  // payload identifying the step). Subsequent `readScratchpad`
  // iteration pulls these entries — together with the outer synthesis
  // entry — into `priorFacts`, so `inheritReasoning` on the NEXT call
  // sees per-leaf evidence (audit_symbol, trace_workflow, …), not only
  // the previous outer synthesis. The bridge in
  // `mcp-server.ts:buildCollaborateToolRegistry` passes
  // `writeToBlackboard` through to each inner leaf call so the inner
  // leaf's OWN blackboard write is also allowed.
  const executed: CollaborateExecutedStep[] = [];
  const priorResults: ResolvedPriorStep[] = [];
  for (const step of dag) {
    const stepFacts: ReasoningFact[] = [];
    pushReasoning(stepFacts, { fact: `${step.name} (${step.rationale})`, source: 'collaborate.dag' });
    if (!toolRegistry.has(step.name)) {
      pushReasoning(stepFacts, { fact: `tool "${step.name}" not registered; step skipped`, source: 'collaborate.dag' });
      signals.push({ kind: 'collaborate.tool_missing', payload: { tool: step.name } });
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

    // F6: resolve $ref / $concat / $const in step.args against the prior
    // step's ToolResult. On unresolvable path, capture a typed error
    // signal + ok=false step instead of throwing past the executor
    // boundary.
    let resolvedArgs: Record<string, unknown>;
    try {
      resolvedArgs = resolveArgs(step.args, priorResults);
    } catch (err) {
      if (err instanceof CollaborateArgResolutionError) {
        const message = `arg resolution failed at ${err.path}: ${err.message}`;
        pushReasoning(stepFacts, { fact: message, source: 'collaborate.dag' });
        signals.push({
          kind: 'collaborate.arg_resolution_error',
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
      const result = await toolRegistry.call(step.name, { ...resolvedArgs, projectRoot });
      const summary = summarizeResult(result);
      pushReasoning(stepFacts, { fact: `${step.name} returned ${summary}`, source: step.name });

      // F6 — capture the step's ToolResult-shaped envelope so the NEXT
      // step's $ref can resolve against it. The bridge returns either
      // a `ToolResult<T>` (envelope) or a bare `data` payload; both
      // shapes are accepted.
      const envelope = asResolvedPrior(result);
      priorResults.push(envelope);

      // F2 — extract the step's own reasoning facts (if any) for both
      // the global chain and the per-step blackboard entry. When the
      // inner leaf did not return a ToolResult envelope (legacy bare
      // `data` payload), the step's facts are just the executor's
      // local stepFacts — better than nothing.
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

      // F2 — append per-step evidence to the outer scratchpad. Distinct
      // from the outer-synthesis entry written after the loop: each step
      // gets its own line so subsequent inheritReasoning sees per-leaf
      // facts (not only the outer synthesis). `data` is a small
      // identifier so the entry is self-describing without bloating the
      // log; the per-step reasoning array is the substantive payload.
      if (writeToBlackboard) {
        await appendScratchpad(sessionId, {
          ts: new Date().toISOString(),
          tool: step.name,
          data: {
            kind: 'collaborate.step',
            step: step.name,
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
      signals.push({ kind: 'collaborate.tool_error', payload: { tool: step.name, message } });
      executed.push({
        name: step.name,
        args: resolvedArgs,
        rationale: step.rationale,
        ok: false,
        summary: `error: ${message}`,
        reasoning: stepFacts,
      });
      // A failed step still occupies a slot in priorResults so the next
      // step's $ref (if any) can resolve against its (empty) envelope
      // rather than the EARLIER step's data, which would be a hidden
      // off-by-one. The empty envelope will throw a clean
      // CollaborateArgResolutionError on the next iteration.
      priorResults.push({});
    }
    // Concatenate per-step facts into the global chain.
    for (const f of stepFacts) pushReasoning(reasoning, f);
  }

  const synthesized = synthesize(classified, executed, detectedSymbol);
  pushReasoning(reasoning, { fact: `synthesized ${synthesized.length} char(s) for ${classified}`, source: 'collaborate' });

  const data: CollaboratePayload = {
    goal,
    llm,
    classified,
    classifiedConfidence,
    detectedSymbol,
    dag,
    executed,
    synthesized,
    reasoning_chain: reasoning,
  };

  const tier = executed.every((e) => e.ok) ? 'EXTRACTED' : 'INFERRED';
  const result = makeToolResult<CollaboratePayload>(data, {
    signals,
    sources,
    reasoning,
    confidence_tier: tier,
  });

  if (writeToBlackboard) {
    await appendScratchpad(sessionId, {
      ts: new Date().toISOString(),
      tool: 'collaborate',
      data: result.data,
      reasoning: result.reasoning.map(f => f.fact),
      confidence_tier: result.confidence_tier,
      sessionId,
    }, { projectRoot });
  }

  return result;
}

function summarizeResult(result: unknown): string {
  if (result == null) return 'null';
  if (typeof result === 'string') return truncate(result, 80);
  if (typeof result === 'number' || typeof result === 'boolean') return String(result);
  if (Array.isArray(result)) return `array(len=${result.length})`;
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if ('summary' in r && typeof r['summary'] === 'string') return truncate(r['summary'], 80);
    if ('data' in r && r['data'] != null) {
      const d = r['data'] as Record<string, unknown>;
      if (typeof d === 'object' && d) {
        return `tool_result{keys=${Object.keys(d).slice(0, 4).join(',')}}`;
      }
    }
    return `object{keys=${Object.keys(r).slice(0, 4).join(',')}}`;
  }
  return truncate(String(result), 80);
}

function synthesize(intent: IntentName, executed: CollaborateExecutedStep[], symbol: string | null): string {
  const lines: string[] = [];
  lines.push(`Intent: ${intent}${symbol ? ` (target: ${symbol})` : ''}`);
  if (executed.length === 0) {
    lines.push('No DAG steps were executed.');
    return lines.join('\n');
  }
  const okCount = executed.filter((e) => e.ok).length;
  lines.push(`Executed ${executed.length} step(s); ${okCount} succeeded.`);
  for (const step of executed) {
    const status = step.ok ? 'OK ' : 'ERR';
    lines.push(`  [${status}] ${step.name}: ${step.summary}`);
  }
  // Deterministic next-step suggestion.
  if (intent === 'audit' && okCount > 0) {
    lines.push('Next: consider plan_refactor on the diff to plan the audit-driven changes.');
  } else if (intent === 'onboard' && okCount > 0) {
    lines.push('Next: call audit_symbol on the entrypoint surfaced by repo_map.');
  } else if (intent === 'refactor' && okCount > 0) {
    lines.push('Next: re-run plan_refactor after applying interventions to verify reversibility.');
  } else if (intent === 'debug' && okCount > 0) {
    lines.push('Next: open the top regression_risk call site and add a regression test.');
  } else if (intent === 'release-prep' && okCount > 0) {
    lines.push('Next: review architecture_drift records before tagging the release.');
  }
  return lines.join('\n');
}

function emptyPayload(
  goal: string,
  llm: 'heuristic' | 'ollama',
  classified: IntentName,
  classifiedConfidence: number,
  detectedSymbol: string | null,
  reasoning: ReasoningFact[],
): CollaboratePayload {
  return {
    goal,
    llm,
    classified,
    classifiedConfidence,
    detectedSymbol,
    dag: [],
    executed: [],
    synthesized: 'Unknown intent; pass a goal containing a recognized verb (audit, refactor, debug, onboard, release).',
    reasoning_chain: reasoning,
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

function shortGoal(g: string): string {
  return g.length <= 80 ? g : `${g.slice(0, 77)}...`;
}

/**
 * In-place variant of `appendReasoning`. The bus's `appendReasoning` is
 * pure (returns a new array). For long per-call chains we want to mutate
 * the local array for clarity; this helper applies the same dedup rule
 * in-place.
 */
function pushReasoning(chain: ReasoningFact[], fact: ReasoningFact | string): void {
  const next = appendReasoning(chain, fact);
  chain.length = 0;
  chain.push(...next);
}

function sessionHash(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Re-exports for the test surface
// ---------------------------------------------------------------------------

export { classifyGoal as _classifyGoal, dagForIntent as _dagForIntent, extractFirstToken as _extractFirstToken };
