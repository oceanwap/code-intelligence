/**
 * intents/registry — PRD US-006 FR-8 pre-declared intent registry.
 *
 * The intent registry ships with five pre-declared intents:
 *   - audit         → audit_symbol (US-004)
 *   - onboard       → project_status + feature_map + repo_map
 *   - refactor      → plan_refactor + analyze_impact + regression_risk
 *   - debug         → get_symbol + regression_risk + render_behavior + query_project_memory
 *   - release-prep  → plan_refactor + architecture_drift + regression_risk
 *
 * Adding a new intent = code change to `registry.ts` (no runtime
 * registration, FR-8). Each intent is a pure data record; the runner
 * (`./runner.ts`) interprets the DAG and dispatches calls.
 *
 * Why a registry + runner split:
 *   - The registry is **declarative**: pure data, easy to inspect, easy
 *     to lint, easy to enumerate. Tests can call `listIntents()` to
 *     assert coverage.
 *   - The runner is **executable**: it owns the dispatch loop, the
 *     blackboard write, and the synthesis. Tests can call `runIntentAsync`
 *     against a mock tool registry.
 */

import type { ToolStep } from '../audit/collaborate.js';

export type RegisteredIntentName =
  | 'audit'
  | 'onboard'
  | 'refactor'
  | 'debug'
  | 'release-prep';

export interface IntentRecord {
  name: RegisteredIntentName;
  description: string;
  /** DAG of tool calls the runner executes in order. */
  dag: ToolStep[];
  /** Post-execution synthesis lines (deterministic, no LLM). */
  post: string[];
}

// ---------------------------------------------------------------------------
// Pre-declared intents (FR-8 / OQ-5)
// ---------------------------------------------------------------------------

const AUDIT: IntentRecord = {
  name: 'audit',
  description: 'Fuse behavior + risk + impact + duplicates + blast radius + a workflow trace for a single symbol.',
  dag: [
    {
      name: 'audit_symbol',
      args: {},
      rationale: 'fuse behavior + risk + impact + duplicates + blast radius',
    },
    {
      name: 'trace_workflow',
      args: { hops: 2 },
      rationale: 'render a numbered narrative + Mermaid sequence diagram',
    },
  ],
  post: [
    'Open the top regression_risk call site and add a regression test before changing the audited symbol.',
    'Compare blast_radius against the audit_symbol action_recommendation; HOLD means do not change.',
  ],
};

const ONBOARD: IntentRecord = {
  name: 'onboard',
  description: 'High-level orientation: project status, feature map, and a repo map ranked by call-graph PageRank.',
  dag: [
    { name: 'project_status', args: {}, rationale: 'what is indexed right now' },
    { name: 'feature_map', args: {}, rationale: 'lay out the feature surface' },
    { name: 'repo_map', args: {}, rationale: 'aider-style file→symbol overview' },
  ],
  post: [
    'Pick a top-3 symbol from repo_map and call audit_symbol on it.',
    'Read the architecture-drift summary in project_status before editing anything.',
  ],
};

const REFACTOR: IntentRecord = {
  name: 'refactor',
  description: 'Plan interventions for the current branch diff and rank them by confidence, blast radius, reversibility.',
  dag: [
    {
      name: 'plan_refactor',
      args: { baseRef: 'main', headRef: 'HEAD' },
      rationale: 'rank intervention steps across the branch diff',
    },
    {
      name: 'analyze_impact',
      args: {},
      rationale: 'measure call-graph blast radius for the refactor target',
    },
    {
      name: 'regression_risk',
      args: {},
      rationale: 'surface recent regression history',
    },
  ],
  post: [
    'Re-run plan_refactor after applying interventions to verify reversibility.',
    'Add a regression test for each non-reversible intervention before merging.',
  ],
};

const DEBUG: IntentRecord = {
  name: 'debug',
  description: 'Investigate a symptom: get the symbol, score its regression risk, list its side effects, search project memory.',
  dag: [
    { name: 'get_symbol', args: {}, rationale: 'get the indexed signature + neighbors' },
    { name: 'regression_risk', args: {}, rationale: 'score recent regression history' },
    { name: 'render_behavior', args: { format: 'json' }, rationale: 'enumerate side effects' },
    { name: 'query_project_memory', args: {}, rationale: 'search for prior fixes matching the symptom' },
  ],
  post: [
    'Open the top regression_risk call site and add a regression test for the symptom.',
    'If render_behavior shows a side effect, check the corresponding adapter.',
  ],
};

const RELEASE_PREP: IntentRecord = {
  name: 'release-prep',
  description: 'Pre-release checklist: intervention plan, architecture-drift signals, and global regression-risk ranking.',
  dag: [
    {
      name: 'plan_refactor',
      args: { baseRef: 'main', headRef: 'HEAD' },
      rationale: 'intervention plan for the current branch diff',
    },
    {
      name: 'architecture_drift',
      args: { limit: 5 },
      rationale: 'surface architecture-drift signals',
    },
    {
      name: 'regression_risk',
      args: {},
      rationale: 'global regression-risk ranking to find newly-elevated symbols',
    },
  ],
  post: [
    'Review architecture_drift records before tagging the release.',
    'If plan_refactor returns HOLD recommendations, defer the release.',
  ],
};

const REGISTRY: Record<RegisteredIntentName, IntentRecord> = {
  audit: AUDIT,
  onboard: ONBOARD,
  refactor: REFACTOR,
  debug: DEBUG,
  'release-prep': RELEASE_PREP,
};

// ---------------------------------------------------------------------------
// Public read-only accessors
// ---------------------------------------------------------------------------

/** Return the registered intent record by name. Throws on unknown. */
export function getIntent(name: RegisteredIntentName): IntentRecord {
  const rec = REGISTRY[name];
  if (!rec) {
    throw new Error(`intents: unknown intent "${name}"`);
  }
  return cloneIntent(rec);
}

/** Return a defensive copy of an intent record. The registry is read-only
 *  at runtime; callers can mutate the returned record without affecting
 *  the canonical registry. */
function cloneIntent(rec: IntentRecord): IntentRecord {
  return {
    name: rec.name,
    description: rec.description,
    dag: rec.dag.map((s) => ({ ...s, args: { ...s.args } })),
    post: [...rec.post],
  };
}

/** Return true when the name is a registered intent. */
export function hasIntent(name: string): name is RegisteredIntentName {
  return name in REGISTRY;
}

/** Return every registered intent name in deterministic order. */
export function listIntents(): RegisteredIntentName[] {
  return Object.keys(REGISTRY).sort() as RegisteredIntentName[];
}

/** Return the full registry snapshot. */
export function getRegistry(): Record<RegisteredIntentName, IntentRecord> {
  return REGISTRY;
}

/** Return the registered intent record by name. Returns null on unknown. */
export function tryGetIntent(name: string): IntentRecord | null {
  if (!hasIntent(name)) return null;
  return cloneIntent(REGISTRY[name]);
}
