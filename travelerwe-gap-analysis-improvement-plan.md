# Code-Intelligence Improvement Plan — Travelerwe Nightly Gap-Analysis Synthesis

**Date:** 2026-06-22  
**Source:** 32 nightly gap-analysis reports (`2026-05-14.md` through `2026-06-21.md`) in `/Users/oceanwap/Documents/travelerwe-nightly-scans/gap-analysis/`  
**Analyzed project:** `traveler-we` monorepo (branches: `itinerary-module-structure`, `main`, `module_time_slots`, `bug-fixes`, `versioned-relations-attachment`, `step-validation`)  
**CI system:** code-intelligence MCP server (localhost:3737) + Qdrant vector store (localhost:6333)

---

## Executive Summary

The 32 reports show a code-intelligence system that is **structurally capable when healthy** but chronically **operationally fragile**, with a small set of recurring real gaps and one major **reverse gap** where CI outperforms the nightly scan's broken proven tool.

### Headline numbers

| Metric | Observation |
|--------|-------------|
| **Effective coverage** | 0–21% overlap with proven findings when semantic tools are down; ~5–20% when they are up. Churn overlap has been effectively **0% measurable** since `risk_hotspots` broke around 2026-05-17. |
| **Operational uptime** | Qdrant was unavailable on **2026-05-15, 05-16, 05-21, 05-22, 05-23, 06-03, 06-06, 06-12, 06-13, 06-14, 06-19** — 11 of 32 days (34%). On those days only 4 of 15 CI tools work. |
| **Top CI code bug** | `risk_hotspots` returns `"{} is not iterable"` on **2026-05-17, 05-19, 05-20, 05-31, 06-01, 06-02, 06-04, 06-05, 06-10, 06-11, 06-15, 06-16, 06-17, 06-18, 06-19, 06-20, 06-21** — roughly **17 of 32 reports** (the exact count varies because Qdrant outages mask it). |
| **Security gap** | CI has **zero CVE awareness**. Proven count grew from 60 total (2 critical) on 2026-05-14 to **145 total (3 critical, 77 high, 56 moderate, 9 low)** on 2026-06-21. The `handlebars`, `angular-expressions`, and `vitest` critical CVEs are 25+ days stale. |
| **Entity circular-dep gap** | TypeORM decorators (`@ManyToOne('Contact')`, etc.) are **invisible to CI's import graph**. Counts reported across files range from 50 relations/87 files (2026-06-14) to 212 relations/87 files (2026-06-01). This is the single largest structural blind spot. |
| **Reverse gap** | CI's `constraint_violations` consistently finds **~20 circular dependency cycles** (1 `admin ↔ database`, ~19 in `admin-ui` around `api.ts`, `context`, `utils`, `pages/leads`, `hooks`, `EditPage.tsx`, `features/admin-resources`). The nightly scan reports "0 violations" because `depcruiser` is a **placeholder package** — confirmed every day from 2026-05-31 onward. |
| **Index/memory instability** | File count oscillated `478 → 985 → 543 → 797 → 543 → 611 → 797 → 543 → 604 → 605 → 642`. Project memory was **wiped to 0** on the 2026-05-16 branch switch and later **eroded** `343 → 332 → 330` (2026-06-16 to 06-19). |
| **Top-churn files unindexed** | By 2026-06-21, `get_file_chunks` / `get_symbols` fail for **3 of the top 5 churn files**: `itineraries.resource.ts` (#1, 68 changes), `MatrixCollectionEditorField.tsx` (#2, 67 changes), `generic-crud.service.ts` (#4, 45 changes). `admin-resource-config.ts` (#3, 52 changes) was also reported missing earlier. |

### What is actually working

- `constraint_violations` reliably detects import-graph circular deps in `admin-ui` and `admin ↔ database` when Qdrant is up.
- `recent_bugs` and `regression_hotspots` provide a useful bug-history signal (e.g., 7/10 recent bugs touched `MatrixCollectionEditorField.tsx` on 2026-06-19).
- `coupling_report` and `architecture_overview` give a stable structural topology when the index is healthy.

---

## Recurring Gaps, Trends, and Noise

### 1. Recurring / real gaps

| Gap | First seen | Frequency | Severity |
|-----|------------|-----------|----------|
| TypeORM decorator relations invisible to dependency graph | 2026-05-14 | Every day | Critical |
| CVE scanning absent — zero security memory | 2026-05-14 | Every day | Critical |
| `risk_hotspots` `"{} is not iterable"` | 2026-05-17 | ~17/32 reports | Critical |
| Qdrant outages / absent backend | 2026-05-15 | 11/32 days | Critical |
| Cross-package `dependency_path` intermittent | 2026-05-16 | Recurrent | High |
| `packages/types` and `packages/shared` not fully indexed | 2026-06-13 | Confirmed on 06-13/14 | High |
| Top-churn files not chunked/symbol-indexed | 2026-06-18 | Worsening to 3/5 top files | High |
| Project memory erosion / wipe on reindex | 2026-05-16 | Multiple events | High |
| Collection hash mismatches (`code-c06cf91b` missing, etc.) | 2026-05-31 | 2026-05-31, 06-01, 06-08, 06-10, 06-16 | High |
| `hotspot_analysis` churn=0 after reindex/branch switch | 2026-05-17 | After every fresh index | Medium |
| Dead code / unused exports — no CI equivalent | 2026-05-14 | Every day | Medium |
| Lint / cognitive complexity — no CI equivalent | 2026-05-21 | Every day | Medium |
| Outdated dependency tracking absent | 2026-05-14 | Every day | Medium |
| Copy-paste detection absent | 2026-05-31 | Every day | Low |

### 2. CI/tool bugs that persist (with day counts)

| Bug | Reports affected | Notes |
|-----|------------------|-------|
| `risk_hotspots` `"{} is not iterable"` | ~17 reports from 2026-05-17 onward | Persists through Qdrant recoveries and reindexes. Risk index slice is corrupt. |
| Qdrant unavailable | 11 reports | No binary / no Docker / no Homebrew. Blocks 11 of 15 tools. |
| Collection hash mismatch | 5+ reports | `query_project`, `get_file_chunks`, `get_symbols`, `analyze_impact`, `expand_graph` reference stale collection hashes. |
| `get_symbols` returns "None found" for churn leaders | 2026-06-18 onward | GenericCrudService, ResourceEditPage, admin-resource-config.ts, itineraries.resource.ts, MatrixCollectionEditorField. |
| `get_file_chunks` "No chunks found" for churn leaders | 2026-06-18 onward | generic-crud.service.ts, MatrixCollectionEditorField.tsx, itineraries.resource.ts. |
| `hotspot_analysis` churn=0 | After every reindex/branch switch | Churn data is not carried across index rebuilds. |
| Memory count yo-yo / silent loss | 2026-05-16, 06-18, 06-19, 06-20 | 308→0 wipe; 343→332→330 erosion; no alerts. |

### 3. Capability gaps: out-of-scope vs fixable

| Domain | Proven tool | CI status | Fixable? | Rationale |
|--------|-------------|-----------|----------|-----------|
| **CVE scanning** | `pnpm audit` | No equivalent | **Fixable (ingestion)** | CI can store audit JSON in project memory; no need to reimplement OSV. |
| **Dead code / unused exports** | `knip` | No equivalent | **Fixable (ingestion or graph usage)** | Either ingest knip output or compute zero-inbound symbols from the existing import graph. |
| **TypeORM entity cycles** | `depcruiser`/`madge` | Partial (UI only) | **Fixable (indexing)** | Add decorator-aware synthetic edges to the call/dependency graph. |
| **Outdated packages** | `pnpm outdated` | No equivalent | **Fixable (ingestion)** | Ingest outdated JSON into memory. |
| **Lint / complexity** | `eslint`/`biome`/`oxlint` | No equivalent | **Fixable (ingestion)** | Ingest lint JSON output as synthetic bug/memory entries. |
| **Phantom deps** | `depcheck`/`knip` | No equivalent | **Fixable (ingestion)** | Ingest depcheck output; requires package.json cross-reference. |
| **Type errors** | `tsc` | Weak signal only | **Fixable (ingestion)** | Feed `tsc --noEmit` errors into memory to improve precision. |
| **Copy-paste / clones** | `jscpd` | No equivalent | **Out-of-scope by design** | CI is structural; content similarity is a different domain. Ingestion into memory is possible but low priority. |

### 4. Trends

| Trend | Evidence |
|-------|----------|
| **Memory erosion** | 343 → 332 → 330 entries between 2026-06-16 and 2026-06-19 with no explicit reindex. |
| **CVE count growth** | 60 total (2 critical) on 2026-05-14 → 145 total (3 critical, 77 high) on 2026-06-21. |
| **Dead code growth** | 219 unused files (2026-05-20) → 276 unused files (2026-06-21). |
| **Clone count growth** | 608 clones (2026-06-04) → 1,168 clones (2026-06-21). |
| **Type-error volatility** | 0 → 383 (test-only on `module_time_slots`) → 50 → 0 → 20 → 8 → 0. CI's "right neighborhood, wrong precision" pattern is consistent but never precise. |
| **Index instability** | File count swings of ±22–47% without corresponding code changes; collection hash mismatches recur after branch switches. |
| **Top-churn indexing gap expansion** | From 1 unindexed file (MatrixCollectionEditorField) on 2026-06-20 to 3 of top 5 on 2026-06-21. |

### 5. Reverse gaps (CI outperformed the nightly scan)

| Domain | CI finding | Proven tool claim | Why proven tool was wrong |
|--------|------------|-------------------|---------------------------|
| Circular dependencies | ~20 cycles in `admin-ui` + `admin ↔ database` | "0 violations" | `dependency-cruiser` package is a placeholder binary. It returns `"This is a placeholder published to prevent dependency confusion. It does not contain any usable code."` |

**Recommendation:** Treat CI's `constraint_violations` as the authoritative circular-dep signal until the nightly scan installs a real `dependency-cruiser`.

### 6. False positives / noise

| Noise source | Why it is noise | Example |
|--------------|-----------------|---------|
| `unstable_modules` top entries all have `instability = 1.00` and `inbound = 0` | These are UI leaf components / sink nodes. High outbound fan-out with no dependents is expected, not actionable instability. | `MediaSelector.tsx`, `mdx-editor`, `IslandTopBar.tsx`, `Table.tsx`, `ListPage.tsx` |
| `hotspot_analysis` rankings when `churn = 0` | Rankings become pure connectivity artifacts. | `DateInput.tsx` and `IslandTopBar.tsx` ranked #1/#2 while `generic-crud.service.ts` (50+ changes) is absent. |
| `query_project` for dead code returns highly-connected live symbols | Semantic search is connectivity-biased; it cannot determine "unused." | `GenericAdminCrudService` methods returned for "unused exports" queries. |
| `risk_hotspots` connectivity skew (when it worked) | Composite score weights connectivity over churn. | `place-intelligence.service.ts` (4 changes, 279 connections) ranked #1; `document-templates.service.ts` (1 change, 266 connections) ranked #3. |

---

## Prioritized Improvement Plan

### P0 — Stop the Bleed (Infrastructure & Data Loss)

These items must be resolved before the gap-analysis itself can be trusted.

#### P0.1 Harden Qdrant availability and add health to `index_status`

- **What to change:**
  1. Add a Qdrant health check to `index_status` output (e.g., `qdrant: healthy | degraded | unavailable`).
  2. Run Qdrant under Docker Compose or a systemd unit with auto-restart; pin the version.
  3. Make semantic tools fail with a specific `"Qdrant backend unavailable at <url>"` message instead of the generic `"Unable to connect"` error.
- **Likely files/tools:** `src/mcp-server.ts` (tool handlers), `src/index_status.ts`, Qdrant startup scripts / `docker-compose.yml`.
- **Success criteria:** Zero days in the next 14 days where >2 tools are unavailable due to Qdrant; `index_status` reports Qdrant health on every call.

#### P0.2 Fix `risk_hotspots` `"{} is not iterable"` bug

- **What to change:**
  1. Debug the risk index slice population code; the iterator receives `{}` instead of an array/map.
  2. Add defensive null/empty checks before iteration.
  3. Regenerate the risk index slice after fixing; verify against `main` branch.
- **Likely files/tools:** `src/risk_hotspots.ts` or equivalent risk-index builder, `src/mcp-server.ts`.
- **Success criteria:** `risk_hotspots` returns a ranked list for 7 consecutive days without the error; top-10 overlap with git-churn top-10 is ≥20% after connectivity-skew fix (see P2.2).

#### P0.3 Eliminate project-memory erosion and reindex wipes

- **What to change:**
  1. Persist memory in a durable store keyed by **project root**, not by branch or collection hash.
  2. Before any `index_project`, snapshot memory; after reindex, replay non-duplicate entries.
  3. Add an alert when memory count drops >1% day-over-day without an explicit purge.
- **Likely files/tools:** `src/project-memory.ts`, `src/index_project.ts`, memory persistence layer.
- **Success criteria:** No unplanned memory drops >1% over 14 days; memory survives branch switches and reindexes.

#### P0.4 Stabilize Qdrant collection resolution

- **What to change:**
  1. Make `query_project`, `get_file_chunks`, `get_symbols`, `analyze_impact`, and `expand_graph` resolve the active collection from Qdrant at call time (or use a stable alias), instead of caching a hash that becomes stale.
  2. Clean up orphaned collections (`code-d9d4f61d`, `memory-c06cf91b`, etc.).
- **Likely files/tools:** Qdrant client wrapper (`src/embedder.ts` or `src/qdrant-client.ts`), semantic tool handlers.
- **Success criteria:** Zero collection-mismatch errors for 14 consecutive days.

---

### P1 — Close the Biggest Real Gaps

#### P1.1 Add TypeORM decorator-aware dependency edges

- **What to change:**
  1. In the indexer, detect `@Entity()` classes and parse `@ManyToOne('X')`, `@OneToMany('X')`, `@ManyToMany('X')`, `@OneToOne('X')` decorators.
  2. Resolve string identifiers (`'Contact'`, `'Itinerary'`, etc.) to the corresponding entity file path (e.g., `packages/admin/src/database/entities/contact.entity.ts`).
  3. Inject synthetic "entity-relation" edges into the call graph and feed them into `constraint_violations`.
- **Likely files/tools:** TypeScript parser / indexer (`src/indexer/typescript-parser.ts` or `src/indexer/dependency-graph.ts`), `constraint_violations` tool.
- **Success criteria:** `dependency_path(entities → database)` returns non-zero weight; `constraint_violations` detects entity-level cycles; coverage of proven circular deps rises from ~0% to ≥80%.

#### P1.2 Ingest CVE data into project memory

- **What to change:**
  1. Run `pnpm audit --json` during every index build and nightly scan.
  2. Store each advisory as a memory entry with fields: `package`, `cve`, `ghsa`, `severity`, `title`, `fixedIn`, `paths`.
  3. Re-ingest after every reindex (memory wipe protection from P0.3).
- **Likely files/tools:** `src/memory-ingestion.ts`, `src/project-memory.ts`, nightly scan orchestrator.
- **Success criteria:** `query_project_memory("handlebars CVE")` returns the GHSA entry; ≥80% of `pnpm audit` findings are queryable; critical CVEs appear in `recent_bugs`-style memory queries.

#### P1.3 Fix chunking/symbol indexing for top-churn files

- **What to change:**
  1. Investigate why `itineraries.resource.ts`, `MatrixCollectionEditorField.tsx`, `generic-crud.service.ts`, and `admin-resource-config.ts` return `"No chunks found"` / `"None of the requested symbols found"`.
  2. Check for file-size limits, TS parsing errors, parser exclusion patterns, or branch-scope issues.
  3. Force-include `*.resource.ts`, large TSX components, and `packages/types/src/**/*.ts` in the index.
- **Likely files/tools:** `src/indexer/chunker.ts`, `src/indexer/symbol-indexer.ts`, `src/index_project.ts`.
- **Success criteria:** All top-10 churn files return chunks and symbols; `analyze_impact` works for `GenericCrudService` and `ResourceEditPage`.

#### P1.4 Replace the `depcruiser` placeholder in the nightly scan

- **What to change:**
  1. In the Travelerwe repo, run `pnpm add -D dependency-cruiser` and add a `.dependency-cruiser.js` config.
  2. Use CI's ~20 detected cycles as the seed rule set.
  3. Run per-package to avoid OOM; compare against CI's `constraint_violations`.
- **Likely files/tools:** Travelerwe `package.json`, `.dependency-cruiser.js`, nightly scan pipeline.
- **Success criteria:** `npx depcruise --version` returns a real version; nightly scan either validates CI's cycles or finds additional ones.

---

### P2 — Add Missing Capabilities & Improve Signals

#### P2.1 Add dead-code / unused-export detection

- **What to change:**
  1. **Short-term:** Ingest `knip --reporter json` output into project memory so CI can answer dead-code queries.
  2. **Medium-term:** Build a symbol-level usage analyzer using the existing import graph; surface zero-inbound exports and files.
- **Likely files/tools:** `src/memory-ingestion.ts`, new `src/dead-code-analyzer.ts`.
- **Success criteria:** CI reports unused files/exports with ≥70% overlap with `knip`; `query_project("unused exports in generic-crud.service.ts")` no longer returns live methods.

#### P2.2 Separate churn from connectivity in hotspot ranking

- **What to change:**
  1. Add a `sortBy: 'churn' | 'connectivity' | 'risk'` parameter to `risk_hotspots`.
  2. Fix `hotspot_analysis` so churn data is **decoupled from the code index** and persists across reindexes / branch switches.
  3. Filter `unstable_modules` to `inbound > 0` before returning top entries.
- **Likely files/tools:** `src/risk_hotspots.ts`, `src/hotspot_analysis.ts`, `src/unstable_modules.ts`, git-history provider.
- **Success criteria:** `hotspot_analysis` shows non-zero churn values; git-churn top-10 overlap with CI churn ranking ≥30%; no sink-node false positives in `unstable_modules` top 10.

#### P2.3 Stabilize cross-package `dependency_path`

- **What to change:**
  1. Fix the intermittent resolution failures between `admin` and `admin-ui` (both directions should consistently return weights).
  2. Ensure workspace package imports (`@travelerwe/types`, `@travelerwe/shared`, `@travelerwe/admin`) are traversed by the module resolver.
  3. Include `packages/types` and `packages/shared` in the indexed scope.
- **Likely files/tools:** `src/dependency_path.ts`, module resolver, `src/index_project.ts`.
- **Success criteria:** `dependency_path(admin → admin-ui)` and `dependency_path(admin-ui → admin)` return stable non-zero weights for 14 consecutive days; `dependency_path(admin → types)` and `dependency_path(admin-ui → types)` also resolve.

#### P2.4 Add lint / cognitive-complexity awareness

- **What to change:**
  1. Run `eslint --format json`, `biome check --json`, and `oxlint --json` in the nightly pipeline.
  2. Store violations as memory entries tagged by rule, file, line, severity.
- **Likely files/tools:** `src/memory-ingestion.ts`, nightly scan pipeline.
- **Success criteria:** `query_project_memory("nested ternary ItineraryKindCard")` returns the `sonarjs/no-nested-conditional` violation; top 10 cognitive-complexity warnings are queryable.

#### P2.5 Add outdated-dependency tracking

- **What to change:**
  1. Run `pnpm outdated --json` and ingest results into memory.
  2. Store current, wanted, latest versions and whether the outdated package has a CVE.
- **Likely files/tools:** `src/memory-ingestion.ts`.
- **Success criteria:** `query_project_memory("outdated packages turbo typescript oxlint")` returns version deltas for all 6 tracked packages.

---

### P3 — Long-Term Tool Parity & Process

#### P3.1 Copy-paste / clone detection (ingestion only)

- **What to change:** Ingest `jscpd --reporters json` output into memory; do not attempt structural clone detection.
- **Likely files/tools:** `src/memory-ingestion.ts`.
- **Success criteria:** `query_project("clone group MdxCardGrid MdxCollectionRoll")` surfaces the jscpd clone group.

#### P3.2 Precise type-error signal

- **What to change:** Run `tsc --noEmit --pretty false` and feed errors into memory as synthetic bug entries with file, line, error code (TS2339, TS2741, etc.), and message.
- **Likely files/tools:** `src/memory-ingestion.ts`.
- **Success criteria:** `query_project("type error missing error prop BlogForm.tsx")` returns the exact TS2741/TS2339 location instead of just the right neighborhood.

#### P3.3 Per-package architecture zones

- **What to change:** Split the monolithic "application" zone in `architecture_overview` into `packages/admin`, `packages/admin-ui`, `packages/travelerwe.com`, `packages/types`, `packages/shared`.
- **Likely files/tools:** `src/architecture_overview.ts`.
- **Success criteria:** `architecture_overview` reports separate zones and can flag cross-package architectural violations.

---

## Recommended Gap-Analysis Cadence / Process Change

The current **daily unconditional** gap analysis is generating too much noise because the infrastructure is not stable enough. Switch to a **gated, branch-pinned, triggered model**:

1. **Pre-flight health gate** (automated, before every run):
   - Qdrant `healthz` passes.
   - `index_status` branch matches the target branch (`main` for nightly).
   - Collection hash matches the active Qdrant collection.
   - Memory count is within 1% of the previous run.
   - At least **12 of 15 tools** respond successfully to a probe.
   - If any gate fails, emit a **degraded-mode report** and skip detailed gap measurement; do not produce a full "0% coverage" report.

2. **Pin nightly analysis to `main`.**
   - Feature-branch analyses (`bug-fixes`, `step-validation`, etc.) should be **triggered manually** or on merge-request events, not run nightly by default.
   - This eliminates the churn=0 problem caused by branch switches and the 10–20% index size swings that look like instability.

3. **Auto-reingest external tool outputs after every reindex.**
   - After `index_project`, automatically run and ingest:
     - `pnpm audit --json`
     - `pnpm outdated --json`
     - `knip --reporter json`
     - `eslint/biome/oxlint` JSON
     - Recent git log / bug metadata
   - This closes the "memory has zero CVE data" gap and prevents wipe-induced data loss.

4. **Reduce frequency until P0/P1 stabilize.**
   - Run **weekly** full gap analyses until `risk_hotspots`, Qdrant availability, collection hashes, and memory durability are green for 2 consecutive weeks.
   - Resume **daily** only after a 14-day green streak.

5. **Track a small dashboard of leading indicators.**
   - CI tools operational (target: 15/15).
   - Qdrant uptime (target: 100%).
   - `risk_hotspots` error rate (target: 0%).
   - Memory count drift (target: ≤1%).
   - CVE memory entries (target: ≥80% of `pnpm audit`).
   - Top-10 churn file index coverage (target: 10/10).
   - Circular-dep coverage (target: ≥80% of real cycles after TypeORM fix).

---

## Quick-Win Verification Checklist

After implementing the P0/P1 items, verify with these exact commands/queries:

```bash
# Qdrant health
curl http://localhost:6333/healthz

# Tool health
code-intelligence index_status   # should show qdrant: healthy, branch: main

# risk_hotspots works
code-intelligence risk_hotspots --limit 10

# CVE memory exists
code-intelligence query_project_memory "handlebars CVE GHSA-2w6w-674q-4c4q"

# TypeORM edges exist
code-intelligence dependency_path --from entities --to database

# Top churn files are indexed
code-intelligence get_file_chunks --file packages/admin/src/admin/resources/itineraries/itineraries.resource.ts
code-intelligence get_symbols --symbol GenericCrudService

# Cross-package paths stable
code-intelligence dependency_path --from admin/src/admin --to admin-ui/src/features/admin-resources
code-intelligence dependency_path --from admin-ui/src --to admin/src/admin
```

---

*Plan generated from 32 nightly reports spanning 2026-05-14 to 2026-06-21. Priority ordering is based on frequency of failure, impact on coverage measurement, and feasibility of fix.*
