[PRD]
# PRD: Cognition Layer + Superpowered Combo Tools

| Field | Value |
|---|---|
| **PRD ID** | `prd-cognition-layer` |
| **Status** | Draft v1 |
| **Owner** | Product |
| **Repo** | `code-intelligence` (branch `main`) |
| **Target LOC** | ~4850 across 4 sprints |
| **Sprints** | 4 |
| **Sprint 1** | P0 + P1 |
| **Sprint 2** | P2 |
| **Sprint 3** | P3a (`audit_symbol` + `plan_refactor`) |
| **Sprint 4** | P3b (`trace_workflow` + `collaborate`) + P4 |

## 1. Introduction/Overview

### Problem

Today's `code-intelligence` exposes ~25 leaf MCP tools (`render_behavior`, `get_symbol`, `regression_risk`, `semantic_duplicates`, etc.) backed by a TS/JS/PHP parser pipeline producing `graph.json`, Qdrant vectors, and per-branch cognition snapshots. Agents must chain these leaves by hand: no shared scratchpad, no signal propagation, no fused multi-tool answer, no goal-shaped entry point. A typical "audit this symbol" or "plan this refactor" workflow burns many LLM round-trips re-marshalling tool outputs and rediscovering context the leaves already knew.

### Solution

Add three layers on top of the existing leaves. **Leaves stay callable directly and gain signalization — they are never replaced.**

- **Layer 2 — Intelligence layer.** A `ToolResult<T>` signalization envelope, per-session blackboard scratchpad, and a reasoning bus that propagates `why[]` between calls. Pure plumbing; no new user-facing tools yet.
- **Layer 3 — Superpowered combo tools.** Four new tools (`audit_symbol`, `plan_refactor`, `trace_workflow`, `collaborate`) that fuse multiple leaves into one fused answer. Plus `session_status` in Layer 4 (read-only inspector).
- **Layer 4 — Goal/intent API.** Pre-declared workflows (`audit`, `onboard`, `refactor`, `debug`, `release-prep`) plus a recommendation loop that suggests the next tool after each call.

### Architecture (target)

```
Layer 4  │ Goal/Intent API     │ intents.ts — pre-declared workflows
─────────┼─────────────────────┼──────────────────────────────────
Layer 3  │ Superpowered tools  │ audit_symbol, plan_refactor,
         │  (combo + fused)    │ trace_workflow, collaborate, ...
─────────┼─────────────────────┼──────────────────────────────────
Layer 2  │ Intelligence layer  │ signalization, blackboard,
         │  (cognition glue)   │ composite scoring, reasoning bus,
         │                     │ cross-output embeddings
─────────┼─────────────────────┼──────────────────────────────────
Layer 1  │ Leaf tools          │ 25+ individual tools — UNCHANGED
         │  (your existing)    │ render_behavior, get_symbol,
         │                     │ regression_risk, ...
─────────┼─────────────────────┼──────────────────────────────────
Layer 0  │ Storage             │ graph.json │ qdrant │ snapshots
```

### Hard constraint

**Leaves stay.** We lift them up (signalize, score, fuse) but never replace them. Any PR that breaks an existing leaf's input/output shape fails the backward-compat test (FR-11).

## 2. Goals (measurable)

- **G-1.** Reduce LLM round-trips for typical agent workflows (`audit`, `refactor`, `debug`) by 5-10x.
- **G-2.** Reduce per-decision prompt tokens by 30-50% (fused payloads + signalization trim the raw output a model has to re-read).
- **G-3.** Improve recall on cross-cutting queries (e.g. "risky code that writes to booking") via cross-output embeddings that include `tool` and `target` fields.
- **G-4.** Every existing leaf tool that ranks results (`query_project`, `risk_hotspots`, `semantic_duplicates`) gains `blast_radius` ranking at zero new tool-surface cost.
- **G-5.** Every multi-step agent task gains provenance via a per-session blackboard + a propagated `reasoning_chain[]` carried by every meta-tool answer.
- **G-6.** Ship ~4850 LOC across 4 sprints with zero breaking change to the public MCP tool surface (backward-compat test required for every PR touching `src/mcp-server.ts`).

## 3. Quality Gates

These commands must pass for every user story:

- `bunx tsc --noEmit` — type checking across root
- `npm run build` — swc compiles cleanly (62 files baseline)
- `bun test ./test/<story>.test.ts` — targeted test file passes
- `bun test ./test/*.test.ts` — full suite passes (baseline 132/133; 1 pre-existing flake in `semantic-duplicates.test.ts:117` tolerated)
- `bun run typecheck` — repo typecheck alias

For tool-surface stories, additionally:

- New MCP tool smoke call against an `audit_symbol('BookingService.create')` style fixture
- Existing tool call surface unchanged (backward-compat test asserts every prior leaf's input/output shape)

## 4. User Stories

User stories are sized to one sprint each. No story contains quality-gate commands in its criteria (those are section-applied per the Quality Gates section above).

### US-001: Phase 0 — Cognition foundation (Sprint 1, ~510 LOC)

**Description:** As an MCP tool author, I want a uniform `ToolResult<T>` envelope with signals/reasoning/sources/confidence_tier, a per-session blackboard scratchpad, and a reasoning bus, so that leaf tools can be lifted into a meta-tool pipeline without bespoke plumbing.

**Acceptance Criteria:**

- [ ] `src/cognition/signalization/types.ts` exports `ToolResult<T> = { data, signals, reasoning, sources, confidence_tier }` with a documented `confidence_tier` enum (`EXTRACTED | INFERRED | AMBIGUOUS`).
- [ ] `src/cognition/signalization/builder.ts` exports `withSignals(toolFn)` that wraps a leaf function and returns a `ToolResult<T>`.
- [ ] `src/cognition/blackboard/scratchpad.ts` implements read/write to `.code-intelligence/<branch>/scratchpad/<sessionId>.json` as a JSON append-log, fsync per write.
- [ ] `src/cognition/reasoning/bus.ts` exports `inheritReasoning(prevFacts)` and `appendReasoning(prev, fact)`.
- [ ] `src/mcp-server.ts` adds pre/post hooks around every tool call: pre loads scratchpad, post appends `ToolResult` to it.
- [ ] Public MCP tool surface unchanged: existing 25 leaves still return their native shapes when called directly (the envelope is opt-in via internal call path).
- [ ] New test file `test/cognition-foundation.test.ts` covers: envelope round-trip, scratchpad append-read, reasoning inheritance, and a hook smoke test against a stub tool.

### US-002: Phase 1 — Lift leaves with 8 individual upgrades (Sprint 1, ~960 LOC)

**Description:** As an MCP user, I want the existing 25 leaf tools to be faster, safer, and richer, so I can rely on them for more workflows before the superpowered tools even exist.

**Acceptance Criteria:**

- [ ] **P1-1** SHA256 content-hash cache (`index_symbol_content_hash`) in the indexer: re-indexing a file whose hash matches the prior run skips parsing. Adds a `content_hash` field on `SymbolRecord`. (~80 LOC)
- [ ] **P1-2** zod schema validation between pipeline stages (`indexer → graph → snapshots → embeddings`). Invalid stages throw a typed `PipelineContractError` with the failed field path. (~200 LOC)
- [ ] **P1-3** `code-intelligence hook install` registers a post-commit git hook that triggers an incremental index on the affected paths. (~50 LOC)
- [ ] **P1-4** `code-intelligence watch [--paths ...]` runs chokidar in the background, debounces, and reindexes on change. Survives process restart via a pidfile. (~120 LOC)
- [ ] **P1-5** Confidence label enrichment: every leaf that emits "side effects" (writes/IO/calls into external systems) tags them `EXTRACTED | INFERRED | AMBIGUOUS` and surfaces in `get_symbol` / `render_behavior` output. (~30 LOC)
- [ ] **P1-6** Graph export CLI: `code-intelligence export graph --format html|svg|graphml`. HTML uses vis.js, opens in browser. (~150 LOC)
- [ ] **P1-7** Louvain community detection over the entity+symbol graph, persisted into `communities.json` per branch and surfaced via a new leaf `list_communities(symbol?)`. (~250 LOC)
- [ ] **P1-8** Security helpers `safeFetch(url)`, `sanitizeLabel(s)`, `validateGraphPath(p)` used by every CLI/MCP path that touches filesystem or network. (~80 LOC)
- [ ] All eight upgrades have targeted test files; full suite stays at 132/133 (1 pre-existing flake tolerated, no new flakes).
- [ ] Backward-compat test confirms all 25 prior leaves' input/output shape is byte-identical to the pre-Sprint-1 baseline.

### US-003: Phase 2 — Composite scoring + cross-output index (Sprint 2, ~430 LOC)

**Description:** As an agent, I want every ranked leaf to consider `blast_radius`, `intent_alignment`, and `change_risk` so I get higher-signal answers, and I want tool outputs to be semantically searchable by what they were about and which tool produced them.

**Acceptance Criteria:**

- [ ] `src/cognition/composite/scoring.ts` exports `blastRadius(symbol)`, `intentAlignment(symbol, goal)`, `changeRisk(symbol)`. Each returns a `[0,1]` score with a typed feature breakdown.
- [ ] `src/cognition/composite/persist.ts` writes `composite-scores.json` per branch keyed by symbol.
- [ ] `query_project`, `risk_hotspots`, `semantic_duplicates` consume `blastRadius` in their ranking (free upgrade, no new tool surface).
- [ ] `src/cognition/composite/cross-output-index.ts` reindexes prior tool outputs into Qdrant with payload fields `tool`, `target`, `session_id`, `ts`. Existing query APIs gain an opt-in `?crossOutput=true` flag.
- [ ] New test file `test/composite-scoring.test.ts`: scores are deterministic for a fixed graph; ranking changes are explained by the scoring breakdown.
- [ ] No regression in `test/semantic-duplicates.test.ts:117` (pre-existing flake stays pre-existing; we do not chase it in this story).

### US-004: Phase 3a — `audit_symbol` + `plan_refactor` (Sprint 3, ~950 LOC)

**Description:** As an agent, I want one call that fuses behavior, risk, impact, duplicates, and rationale for a single symbol, and one call that ranks interventions across a branch diff.

**Acceptance Criteria:**

- [ ] `audit_symbol(symbol: string, opts?: { writeToBlackboard?: boolean })` returns `ToolResult<{ behavior, risk, impact, dups, rationale, blast_radius, action_recommendation, reasoning_chain[] }>`. Defaults to `writeToBlackboard: true`. (~450 LOC)
- [ ] `audit_symbol` calls `get_symbol + render_behavior + regression_risk + analyze_impact + semantic_duplicates + query_project_memory` and returns within 2x the slowest leaf's wall time on a fixed fixture.
- [ ] `plan_refactor(baseRef: string, headRef: string | branchDiff: string)` returns a ranked intervention plan; each step carries `confidence`, `reversible`, `blast_radius`, and `why[]`. (~500 LOC)
- [ ] `plan_refactor` calls `git_semantic_change_graph + regression_risk (per changed symbol) + render_behavior (per changed symbol) + semantic_duplicates (on changed files) + architecture_drift`.
- [ ] Both tools read blackboard + reasoning chain; their `ToolResult` envelope is the same shape as US-001.
- [ ] New test files: `test/audit-symbol.test.ts`, `test/plan-refactor.test.ts`. Smoke call: `audit_symbol('BookingService.create')` against a fixture produces a non-empty fused result with all 8 fields populated.

### US-005: Phase 3b — `trace_workflow` + `collaborate` (Sprint 4, ~950 LOC)

**Description:** As an agent, I want a narrative trace of a symbol's runtime path and a goal-shaped entry point that classifies intent and orchestrates a tool DAG.

**Acceptance Criteria:**

- [ ] `trace_workflow(symbol: string, opts?: { hops?: 2|3 })` returns a numbered narrative plus a Mermaid `sequenceDiagram` block. Calls `expand_graph` (2-3 hops) + `render_behavior` per callee + a sequence miner. (~400 LOC)
- [ ] `collaborate(goal: string, opts?: { hints?: string[], llm?: 'heuristic' | 'ollama' })` classifies the goal, picks a tool DAG from a registered set, executes it, and returns a synthesis. Defaults to `llm: 'heuristic'`. (~550 LOC)
- [ ] `collaborate` recognizes at minimum: `audit <symbol>`, `onboard`, `refactor <area>`, `debug <symptom>`, `release-prep`.
- [ ] New test files: `test/trace-workflow.test.ts`, `test/collaborate.test.ts`. Mermaid output is parseable by a Mermaid grammar fixture; `collaborate` produces a stable DAG for a fixed goal string.
- [ ] Backward-compat test still passes: every prior leaf's shape unchanged.

### US-006: Phase 4 — Goal/intent API + recommendation loop + `session_status` (Sprint 4, ~1050 LOC)

**Description:** As an agent platform, I want pre-declared goals the agent can call by name, a recommendation hook that suggests the next tool after each call, and a read-only inspector for any session.

**Acceptance Criteria:**

- [ ] `src/cognition/intents/registry.ts` registers: `audit`, `onboard`, `refactor`, `debug`, `release-prep`. Each intent = `{ description, dag: ToolStep[], post: string[] }`. (~200 LOC)
- [ ] `src/cognition/intents/runner.ts` runs an intent: validates inputs, executes the DAG, writes a synthesis to blackboard. (~250 LOC)
- [ ] `src/cognition/recommend/cooccur.ts` builds a tool co-occurrence matrix from prior sessions; v1 ships heuristic fallback (top-N most-called leaves after the current one). (~300 LOC)
- [ ] `src/mcp-server.ts` post-call hook appends a `recommended_next: string[]` to every `ToolResult` envelope (v1 = heuristic; v2 = learned). (~100 LOC)
- [ ] `session_status(sessionId: string)` returns a read-only view of blackboard + reasoning chain + composite scores touched. (~200 LOC)
- [ ] New test file `test/intents-and-recommend.test.ts`: each registered intent resolves to a valid DAG; `session_status` round-trips; `recommended_next` is non-empty for the 10 most common tools.

## 5. Functional Requirements

- **FR-1.** `ToolResult<T>` envelope (`data, signals, reasoning, sources, confidence_tier`) MUST be the only shape meta-tools (Layer 3) return. Leaves may return their native shape; meta-tools MUST wrap.
- **FR-2.** Every leaf tool in Layer 1 MUST remain callable with its current name, parameter list, and return shape. Any wrapper behavior MUST be opt-in or internal.
- **FR-3.** Blackboard scratchpad path: `.code-intelligence/<branch>/scratchpad/<sessionId>.json`, JSON append-log, fsync per write, no in-process cache required to survive a crash.
- **FR-4.** Reasoning chain MUST propagate: every `ToolResult` carries `reasoning[]`; `inheritReasoning(prevFacts)` MUST be the only legal way to chain.
- **FR-5.** Composite scoring persists to `.code-intelligence/<branch>/composite-scores.json` per branch, keyed by symbol, regenerated on every indexed branch change.
- **FR-6.** Cross-output index MUST add `tool`, `target`, `session_id`, `ts` to every Qdrant point reindexed from a prior tool output. Existing query paths MUST NOT change without an opt-in flag.
- **FR-7.** `audit_symbol`, `plan_refactor`, `trace_workflow`, `collaborate` MUST each be a single MCP tool entry in `src/mcp-server.ts` with a zod input schema and a `ToolResult<T>` output.
- **FR-8.** The intent registry MUST ship with `audit`, `onboard`, `refactor`, `debug`, `release-prep` pre-declared. Adding a new intent = code change to `registry.ts`; no runtime registration.
- **FR-9.** `session_status(sessionId)` MUST be read-only and MUST refuse to mutate the scratchpad.
- **FR-10.** Security helpers (`safeFetch`, `sanitizeLabel`, `validateGraphPath`) MUST be the only entry points the codebase uses for network fetches, free-form labels, and graph-derived file paths.
- **FR-11.** Every PR that touches `src/mcp-server.ts` MUST include a backward-compat test asserting that the prior 25 leaves' input/output shape is byte-identical to the pre-change baseline.

### Derived requirements (call out for downstream traceability)

- **DR-1.** zod input schema for every new MCP tool (US-004, US-005) — implied by `FR-7`, spelled out so the engineer/QA trace can find it.
- **DR-2.** Filesystem permission/scope: process must be able to write `.code-intelligence/<branch>/scratchpad/` and `composite-scores.json`, and `validateGraphPath` MUST refuse any path outside the repo root.
- **DR-3.** `composite-scores.json` schema validation (zod) matching the structure in `scoring.ts` — implied by the P1-2 schema-validation rule.
- **DR-4.** A CHANGELOG entry for any leaf that gains an opt-in envelope flag — no silent flag additions.
- **DR-5.** `collaborate` registry of recognized goals lives in code (no remote config) — implied by `FR-8`.

## 6. Non-Goals (Out of Scope)

- **NG-1.** Replacing any existing leaf tool. They stay callable and get smarter via signals.
- **NG-2.** Multimodal ingest (PDFs, images, screenshots, design files).
- **NG-3.** New language parsers (Go, Rust, Java, Python, Ruby). Current scope stays TS/JS/PHP.
- **NG-4.** Auto-pilot agent mode with no human in the loop. Superpowered tools synthesize; the calling agent decides.
- **NG-5.** Cross-session memory share. Scratchpads are per-session; composite scores are per-branch; nothing crosses both.
- **NG-6.** Changing the Qdrant schema for the existing code-embedding collection. Cross-output index lives in a separate collection.
- **NG-7.** Distributed / multi-tenant mode. Single-process MCP server, single local Qdrant.
- **NG-8.** Real-time collaborative editing of the blackboard. Single-writer per session.
- **NG-9.** Pre-existing flake in `semantic-duplicates.test.ts:117`. Acknowledged, not chased in this PRD.

## 7. Technical Considerations

### Design rules (binding)

- Leaves stay callable directly. Superpowered tools fuse leaf signals — they do not bypass them.
- Superpowered tools READ blackboard + reasoning chain. They emit `ToolResult` envelope. No silent signal loss.
- Signals flow forward: tool `A.result.signals` feed tool `B`'s input.
- Reasoning chain propagates: every meta-tool answer carries accumulated `why[]` from leaves it called.
- Blackboard is per-session-scoped, JSON append-log at `.code-intelligence/<branch>/scratchpad/<sessionId>.json`.
- Composite scoring persists to `composite-scores.json` per branch; existing tool rankings consume it for free.

### Storage layout (new artifacts)

```
.code-intelligence/<branch>/
├── graph.json              # existing
├── attention.json          # existing — UNCHANGED
├── snapshot.json           # existing
├── composite-scores.json   # NEW (P2) — blast_radius, intent_alignment, change_risk per symbol
├── communities.json        # NEW (P1-7) — Louvain communities per symbol
└── scratchpad/             # NEW (P0)
    └── <sessionId>.json    # append-log
```

### LOC budget (binding)

| Sprint | Phase | LOC | Notes |
|---|---|---|---|
| 1 | P0 + P1 | ~1470 | foundation + 8 leaf upgrades in parallel |
| 2 | P2 | ~430 | composite scoring, free upgrades to 6 leaves |
| 3 | P3 partial | ~950 | `audit_symbol` + `plan_refactor` |
| 4 | P3 remainder + P4 | ~1700 | `trace_workflow` + `collaborate` + intents + recommend + `session_status` |
| **Total** |  | **~4850** | across 4 sprints |

### Files / modules (target list)

- `src/cognition/signalization/{types.ts, builder.ts}` — P0
- `src/cognition/blackboard/scratchpad.ts` — P0
- `src/cognition/reasoning/bus.ts` — P0
- `src/cognition/composite/{scoring.ts, persist.ts, cross-output-index.ts}` — P2
- `src/cognition/intents/{registry.ts, runner.ts}` — P4
- `src/cognition/recommend/cooccur.ts` — P4
- `src/cognition/communities.ts` — P1-7 (Louvain)
- `src/mcp-server.ts` — add hooks (P0, P4) and 4 new tool entries (P3a, P3b); read-only `session_status` (P4)
- `src/indexer.ts` — content-hash cache, schema validation (P1-1, P1-2)
- `bin/code-intel.js` (CLI) — `hook install`, `watch`, `export graph` subcommands (P1-3, P1-4, P1-6)
- `src/utils/security.ts` — `safeFetch`, `sanitizeLabel`, `validateGraphPath` (P1-8)

### Backward compatibility

- `src/mcp-server.ts` is a hotspot (98.3th percentile churn per AGENTS.md). Every PR touching it MUST include the backward-compat test (FR-11).
- The `ToolResult` envelope is opt-in for leaves; meta-tools emit it by default.
- Composite scoring writes a NEW file; existing `attention.json` is not modified.

### Risk hotspots (preflight call-out)

- `src/mcp-server.ts` (98.3th %ile churn) — US-001, US-004, US-005, US-006 all touch it.
- `src/project-memory.ts` (96.6th %ile churn) — US-001, US-006 may touch.
- `src/git.ts` (94.8th %ile churn) — US-004, US-006 touch via `plan_refactor` / `collaborate`.
- `src/indexer.ts` (medium-high churn) — US-002, US-003.
- `src/engineering-insights.ts` (91.4th %ile churn) — US-003 may touch via composite scoring.

### Sequencing rationale

- P0 must land first: blackboard + envelope are pre-requisites for every meta-tool.
- P1 is independent of P2/P3 and runs in parallel within Sprint 1.
- P2 changes ranking behavior of 6 existing leaves, so it ships after P0 (envelope) but before P3 (meta-tools that read rankings).
- P3a ships before P3b so the planning tool is available when `collaborate` picks a DAG.
- P4 depends on P3a existing (intent `audit` resolves to `audit_symbol`).

## 8. Success Metrics

- **SM-1.** Public MCP tool surface is a strict superset of the pre-PRD baseline (zero leaves removed, zero leaves changed in shape). Verified by the backward-compat test on every PR.
- **SM-2.** `audit_symbol` smoke call on a representative symbol returns within 2x the slowest leaf's wall time and includes all 8 fused fields (`behavior, risk, impact, dups, rationale, blast_radius, action_recommendation, reasoning_chain[]`).
- **SM-3.** Round-trip reduction: a typical "audit this symbol" workflow drops from N leaf calls to 1 meta-tool call. Measured by counting tool invocations on a fixed scenario.
- **SM-4.** Token reduction: payload size of one `audit_symbol` call vs the raw concatenation of its leaves ≤ 50% (target ceiling; goal is 30-50%).
- **SM-5.** Test suite stays at 132/133 across all PRs in the plan; the one pre-existing flake in `semantic-duplicates.test.ts:117` is not chased in this PRD.
- **SM-6.** Composite scores improve ranking quality: the top-3 results of `query_project("find risky booking writers")` after Phase 2 include at least one symbol that was NOT in the top-3 before Phase 2 (measured on a fixed test fixture).
- **SM-7.** Cross-output recall: the cross-cutting query in G-3 returns ≥ 1 result on the fixture that the un-augmented leaf ranking misses.

## 9. Open Questions

1. **LLM vs heuristic for `collaborate` intent classification.** Heuristic is cheaper + deterministic; Ollama (`qwen2.5:3b`) catches fuzzy goals but adds latency.
   **Recommendation:** ship heuristic as default, opt-in `llm: 'ollama'` flag; v2 swap once we have session data.
2. **Where does `blast_radius` live — `attention.json` or `composite-scores.json`?** Separation avoids touching `attention.json`'s existing schema but forces two reads for ranking.
   **Recommendation:** new `composite-scores.json`; keep `attention.json` untouched.
3. **Cross-output embedding cost.** Reindexing tool outputs roughly doubles Qdrant storage.
   **Recommendation:** TTL of 7 days, per-commit reindex (not per-query), with a `--no-cross-output` flag to disable.
4. **Cold start for `recommended_next`.** Ship heuristics for v1 (top-N most-called leaves), learn from sessions for v2 once we have N≥100 sessions of co-occurrence data.
5. **`audit_symbol` writes to blackboard by default?** **Recommendation:** yes, `writeToBlackboard: true` default; explicit `false` opt-out. The reasoning chain is what makes the next tool call cheap, so opt-out should be rare.

---

## Traceability Notes (for downstream final-output mapping)

- **Anchor IDs.** `G-1..G-6` (goals), `FR-1..FR-11` (functional requirements), `DR-1..DR-5` (derived requirements), `NG-1..NG-9` (non-goals), `SM-1..SM-7` (success metrics), `OQ-1..OQ-5` (open questions), `P0` / `P1-1..P1-8` / `P2` / `P3a` / `P3b` / `P4` (phase anchors), `US-001..US-006` (user stories).
- **Expected files.** PRD anchors map to:
  - `src/mcp-server.ts` → FR-1, FR-7, FR-11; US-001, US-004, US-005, US-006.
  - `src/cognition/signalization/*` → FR-1, FR-4; US-001.
  - `src/cognition/blackboard/scratchpad.ts` → FR-3; US-001.
  - `src/cognition/reasoning/bus.ts` → FR-4; US-001.
  - `src/cognition/composite/*` → FR-5, FR-6; US-003.
  - `src/cognition/intents/*` → FR-8; US-006.
  - `src/cognition/recommend/cooccur.ts` → US-006.
  - `src/utils/security.ts` → FR-10; US-002 (P1-8).
  - `src/indexer.ts` → P1-1, P1-2; US-002.
  - `bin/code-intel.js` → P1-3, P1-4, P1-6; US-002.
  - `src/cognition/communities.ts` → P1-7; US-002.
- **Change-by-Change PRD Trace requirement.** Every PR in the plan MUST end with a `Change-by-Change PRD Trace` table mapping its commits to the relevant `FR-x`, `P0..P4`, and test-file IDs.
- **Out of scope / cleanup.** Any refactor of leaf tools not listed here (e.g. restructuring `attention.json`, porting to a different MCP SDK version) MUST be labeled `Out of scope / cleanup` in the final task output, not presented as PRD-driven.
- **Handoff.** After this PRD lands, the next step is `Engineer` for US-001 (P0 foundation). `UX Designer` gets involved at US-002 (P1-3 hook UX, P1-4 watch UX, P1-6 graph export UX). `Architect` gets involved at US-001 (P0 storage layout) and US-003 (P2 composite scoring shape). `QA` gets involved at US-002 (first test plan) and gates every subsequent story. `Senior QA` is only required if QA flags residual risk.
[/PRD]
