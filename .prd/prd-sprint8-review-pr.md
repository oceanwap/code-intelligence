# PRD: Sprint 8 — review_pr combo + intelligence-layer hardening

## 1. Overview

Single highest-frequency agent workflow (PR review) plus 4 architectural quick wins identified by the intelligence-layer review (Sprint 7 close). `review_pr` fuses 6 leaf signals into one merge-decision call so agents stop manually chaining. Quick wins close scoring/cap/discriminator gaps surfaced by the architect review.

## 2. Goals

G-1. Reduce "is this PR safe?" workflow from 6-12 leaf calls to 1 review_pr call.
G-2. Block/Review/Pass aggregate decision in ≤2x slowest leaf wall time.
G-3. F5 cap drift closed across the meta-tool family (audit_symbol/plan_refactor/collaborate/intents/runner).
G-4. Composite score lookups 5-10x faster on repeated calls (per-process mtime memo).
G-5. isToolResult discriminator rejects malformed envelopes (zero false positives).
G-6. F6 resolver skips non-ref args (5kB query_project payloads at O(args-with-refs) instead of O(args)).

## 3. Quality Gates

- `bunx tsc --noEmit` — exit 0
- `npm run build` — swc compiles cleanly
- `bun test ./test/<story>.test.ts` — targeted suite 100% pass
- `bun test ./test/leaf-backward-compat.test.ts` — 14/14 (added spot-check)
- `bun test ./test/*.test.ts` — full suite exit 0; the 1 PRD-tolerated flake (`semantic-duplicates.test.ts:125`) remains pre-existing
- `bun run typecheck` — exit 0
- `bun scripts/smoke-review-pr.ts` — exits 0 with terminal string `REVIEW OK: <decision> (<counts>)`

## 4. User Stories

### US-001 — review_pr combo (~600 LOC)

**Description:** As an agent, I want one call that fuses git_semantic_change_graph + per-symbol audit_symbol + semantic_duplicates(touched files) + architecture_drift + constraint_violations + composite scoring, with a deterministic per-symbol rule table and aggregate Block/Review/Pass verdict, so I can answer "is this PR safe?" in a single ToolResult<T> round-trip.

**Acceptance Criteria:**

- [ ] `src/cognition/audit/review-pr.ts` implements `reviewPrAsync(projectRoot, baseRef, headRef, opts?) → Promise<ToolResult<ReviewPrPayload>>`.
- [ ] `src/cognition/audit/types.ts` extended with `ReviewPrPayload`, `ReviewPerSymbol`, `ReviewAggregate`, `ReviewVerdict` ('HOLD' | 'REVIEW' | 'PASS') and `MergeDecision` ('PASS' | 'REVIEW' | 'BLOCK').
- [ ] Per-symbol rule table (9 cases, deterministic, no LLM):
  - HOLD = regression_score ≥0.8 OR constraint_violations_at_symbol ≥1
  - REVIEW = regression_score ≥0.5 OR blast_radius ≥0.7 OR duplicate_matches ≥2
  - PASS = otherwise
- [ ] Aggregate rule:
  - BLOCK = any per-symbol HOLD
  - REVIEW = any per-symbol REVIEW OR top_blast_radius ≥0.7
  - PASS = all per-symbol PASS and top_blast_radius <0.7
- [ ] Wall-time ≤2× slowest leaf wall time (use parallel Promise.all + hoists mirroring plan_refactor:148-156).
- [ ] `src/cognition/intents/registry.ts` adds `review` intent with one DAG node.
- [ ] `src/mcp-server.ts` registers `review_pr` zod-input MCP tool. Input: `{ projectRoot, baseRef, headRef, topN?, writeToBlackboard?, sessionId?, qdrantUrl? }`. Output: `ToolResult<ReviewPrPayload>` JSON.
- [ ] `test/review-pr.test.ts` ≥20 tests covering: envelope shape (8 fields populated), per-symbol rule table (all 9 cases), aggregate rule (3 cases), wall-time target on fixture, intent DAG run.
- [ ] `scripts/smoke-review-pr.ts` end-to-end smoke exits with `REVIEW OK: <decision> (<hold>,<review>,<pass>)`.
- [ ] `test/leaf-backward-compat.test.ts` adds `'Sprint 8: review_pr tool is registered (additive)'` spot-check mirroring the run_intent pattern. Update `current.size` expected constant accordingly.

### US-002 — Quick wins block (~150 LOC, ride alongside US-001 in same commit)

**Description:** As a maintainer, I want 4 small architectural hardening fixes applied alongside review_pr so the PR is a complete hardening pass without scope drift.

**Acceptance Criteria:**

- [ ] **B1 — F5 cap propagation:** `INHERITED_FACTS_CAP=20` enforced in audit_symbol, plan_refactor, collaborate, intents/runner (in addition to trace_workflow). Surface `inheritedFactsCap` field in every meta-tool payload that reads the scratchpad.
- [ ] **B2 — Composite memoization:** `loadCompositeScoresAsMap` gains a module-level mtime-keyed cache; invalidated on file change; per-process thread-safe (Bun single-threaded so simple Map is sufficient).
- [ ] **B3 — Strict isToolResult:** `signalization/builder.ts:isToolResult` requires confidence_tier ∈ CONFIDENCE_TIERS (no unknown strings) + `Array.isArray` for signals / reasoning / sources. Negative tests cover malformed envelopes.
- [ ] **B4 — F6 resolver gate:** `resolveArgsInternal` pre-checks `$ref`/`$concat`/`$const` keys before recursing, so 5kB query_project.question strings are not walked char-by-char. Test pins byte-equal output for a 5kB payload with zero refs.

## 5. Functional Requirements

- **FR-1.** `review_pr` returns `ToolResult<ReviewPrPayload>` with all 8 fields (data, signals, reasoning, sources, confidence_tier) per FR-1.
- **FR-2.** `review` intent declared in registry with DAG of one node per FR-8 (no runtime registration).
- **FR-3.** `review_pr` and `review` intent write to scratchpad by default per FR-3 (opt-out via writeToBlackboard:false).
- **FR-4.** Reasoning chain propagates per FR-4; per-leaf facts appended in call order with leading fact `review_pr called for <baseRef>..<headRef>`.
- **FR-7.** `review_pr` registered as single zod-input MCP tool entry in src/mcp-server.ts.
- **FR-11.** Zero prior leaves touched. run_intent's `$baseRef`/`$headRef` extension requires the executor to thread opts into resolveArgs — verify byte-equal resolved args for literal-only intents.
- **NG-1.** No replacement of existing leaves. `plan_refactor` stays; `review_pr` is additive.
- **NG-4.** Heuristic-only verdict synthesis. No LLM in either per-symbol or aggregate rule.
- **OQ-1.** No Ollama/collaborate LLM path added.

## 6. Non-Goals

- No auto-pilot mode on review_pr — calling agent decides.
- No `blast_radius(symbol)` leaf (already in composite scoring).
- No per-leaf confidence in payload (surface via signals[]: audit_symbol.leaf_confidence instead).
- No replace_release_prep_intent — release_prep stays as separate DAG.
- No realtime scratchpad collaboration (NG-8).
- No new embeddings model — BGE-small stays.

## 7. Technical Considerations

### Storage
No new files. Uses existing `.code-intelligence/<branch>/` layout. `composite-scores.json` regen via existing Q3 wiring.

### Concurrency
`review_pr` runs in parallel via `Promise.all` like `plan_refactor`. Reads from shared graph/memory caches — no new races.

### Resolver gate (B4)
Pre-scan args for `$ref`/`$concat`/`$const` keys before descent. Only objects containing those keys are recursed into. Arrays of strings (e.g., questions) skip recursion at top level.

### Composite memo (B2)
Module-level `Map<{ projectRoot, branch, mtime }, Map<string, CompositeScore>>`. Cache invalidated on mtime change. Single-process-safe via Bun's single-thread.

### Backward compat
- All prior 69 tools + 6 named Sprint-6/7 spot-checks stay byte-equal.
- `current.size` constant in leaf-backward-compat updates from 69 to 70 with the new `review_pr` registration.
- run_intent's executor changes are scoped: literal-only intents produce byte-equal resolved args.

### Risk hotspots
- `src/mcp-server.ts` (98.3th %ile churn per AGENTS.md): touched for review_pr registration. FR-11 binding test required.
- `src/cognition/intents/registry.ts`: touched for review intent DAG. Backward-compat binding on literal-only intents.
- `src/cognition/audit/types.ts`: extended with new types. No existing types removed.
- `test/leaf-backward-compat.test.ts`: spot-check added + constant updated.

## 8. Success Metrics

- SM-1. FR-11 binding test asserts 25 baseline leaves still byte-equal after this PR. current.size === 70 with new spot-check.
- SM-2. review_pr smoke on a representative fixture exits with `REVIEW OK: <decision> (<counts>)` and a non-empty perSymbol list.
- SM-3. review_pr wall time on fixture ≤2x slowest leaf wall time measured via existing benchmark.
- SM-4. Full suite stays at 692 pass + 1 PRD-tolerated flake (was 636 + 1 in Sprint 6 close, was 585 + 1 in Sprint 5 close).
- SM-5. B4 test pin: a 5kB string literal in args + zero refs produces identical args before/after the gate.
- SM-6. B2 test pin: 2nd `loadCompositeScoresAsMap` call within same mtime returns same Map instance (===).

## 9. Open Questions

1. Should review_pr be the canonical "merge gate" recommendation? Currently `plan_refactor` and `release-prep` are nearby but do distinct things. Recommendation: review_pr is additive; do not deprecate either.
2. Top-N cutoff on per-symbol audit_symbol calls inside review_pr. Default = 10 to keep wall-time budget. Configurable via inputSchema.
3. Cross-output recall in review_pr? Recommendation: opt-in via env (matches Sprint 6 cross-output pattern) to avoid FR-11 break.
4. B2 cache invalidation: should it also bust on graph.json changes (graph reload path)? Recommendation: yes, listen to graph mtime alongside composite-scores mtime.

## 10. Traceability Anchors

- G-1..G-6: goals
- FR-1, FR-2, FR-3, FR-4, FR-7, FR-11: functional requirements
- NG-1, NG-4, NG-8, OQ-1: non-goals
- SM-1..SM-6: success metrics
- OQ-1..OQ-4: open questions (above plus PRD OQ-1 default for collaborate LLM)
- US-001 (review_pr) + US-002 (B1-B4 quick wins)
- Prior contracts: PRD-cognition-layer FR-1/3/4/7/11, US-005 F5 cap, US-006 F7 backlog

## 11. Handoff Plan

| Item | Owner | Notes |
|---|---|---|
| US-001 review_pr | Engineer | Heuristic verdict synthesis, parallel leaf fan-out, FR-11 binding test |
| US-002 B1 cap propagation | Engineer | Small per-file edits, inherit via shared constant |
| US-002 B2 composite memo | Engineer | Module-level Map; tests verify cache hit/miss on mtime |
| US-002 B3 strict isToolResult | Engineer | Add CONFIDENCE_TIERS guard + Array.isArray checks |
| US-002 B4 resolver gate | Engineer | Pre-check $ref/$concat/$const keys before recursion |
| US-001 review_pr smoke | Engineer + QA | script exit code + terminal string |
| Backward-compat binding | QA | 25 baseline leaves + 70 total + review_pr spot-check |
| Resolution-rule QA | QA | All 9 per-symbol + 3 aggregate cases against fixture |