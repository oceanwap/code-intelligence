# Technical PRD: Enriched Overview and Risk Hotspots

## Summary

This change enriches the existing overview and hotspot MCP APIs instead of introducing new top-level endpoints. The goal is to make `project_intent_snapshot` and `risk_hotspots` more useful as first-call agent tools by returning deterministic, structured repo intelligence even when no overview-generation model is configured. A second deterministic phase adds ownership and bus-factor analytics using local git blame data.

## Problem

The current server already exposes strong internal signals:

- project intent claims
- architecture and evolution snapshots
- document-derived feature memory
- change and bug history
- graph-based connectivity and impact data

However, the existing responses are optimized for human reading, not for structured agent onboarding and pre-change risk analysis. Compared with tools like Repowise, the main gap is packaging, not raw intelligence.

## Goals

### Overview goals

Extend `project_intent_snapshot` so it returns a deterministic project profile with:

- project title
- markdown overview content (`contentMd`)
- key modules with responsibility hints
- entry points with reasons
- important docs
- git/index health summary
- ownership and bus-factor context for key modules
- freshness information
- the existing evidence-backed claims

### Hotspot goals

Extend `risk_hotspots` so each hotspot includes richer operational context:

- dependents count
- likely test coverage hints
- test gap heuristic
- compact impact surface
- ownership and bus-factor context
- deterministic risk summary

### Non-goals

- no AI-generated prose requirement
- no co-change partner mining yet
- no separate `get_risks(targets[])` endpoint in this phase

## Why extend existing APIs

The current API surface already has the right conceptual homes:

- `project_intent_snapshot` is already the structured overview tool
- `risk_hotspots` is already the global risk-ranking tool

Adding richer fields here keeps the API surface compact and avoids duplicating similar tools with only slightly different semantics.

## API changes

### `project_intent_snapshot`

The JSON payload remains backward compatible and gains these fields:

- `title: string`
- `contentMd: string`
- `keyModules: ProjectOverviewModule[]`
- `entryPoints: ProjectOverviewEntryPoint[]`
- `importantDocs: ProjectOverviewDocument[]`
- `gitHealth: ProjectGitHealth`
- `freshness: ProjectIntentFreshness`

#### `ProjectOverviewModule`

- `name`
- `fileCount`
- `symbolCount`
- `inbound`
- `outbound`
- `instability`
- `coupling`
- `riskScore`
- `zone`
- `responsibilityHint`
- `primaryOwner`
- `ownerPct`
- `recentOwner`
- `contributorCount`
- `busFactor`
- `evidence`

#### `ProjectOverviewEntryPoint`

- `symbol`
- `file`
- `reason`

#### `ProjectOverviewDocument`

- `title`
- `path`
- `docType`
- `summary`

#### `ProjectGitHealth`

- `totalFilesIndexed`
- `indexedChunks`
- `hotspotCount`
- `churnTrend`
- `topChurnModules`
- `activeTopics`

#### `ProjectIntentFreshness`

- `memoryRefreshedAt`
- `indexedHeadSha`
- `currentHeadSha`
- `needsReindex`
- `reasons`
- `dirtyFileCount`
- `dirtyFilesNewerThanMemory`

### `risk_hotspots`

The tool now supports an optional `format` parameter:

- `text` (default)
- `json`

The JSON/text payload gains richer per-hotspot fields.

#### Symbol hotspot additions

- `dependentsCount`
- `likelyTestCallers`
- `impactSurface`
- `primaryOwner`
- `ownerPct`
- `recentOwner`
- `contributorCount`
- `busFactor`
- `testGap`
- `riskSummary`

#### File hotspot additions

- `dependentsCount`
- `nearbyTests`
- `impactSurface`
- `primaryOwner`
- `ownerPct`
- `recentOwner`
- `contributorCount`
- `busFactor`
- `testGap`
- `riskSummary`

## Implementation design

### Overview implementation

Use existing internals and add deterministic assembly in `src/project-intent.ts`:

- graph → entry points, package hints, framework patterns
- architecture snapshot → top modules, coupling, instability, zones
- evolution snapshot → hotspot count, top churn modules, churn trend
- feature map → important docs
- manifest → indexed file and chunk counts
- project memory freshness → freshness section

`contentMd` is generated via templated deterministic synthesis from these signals and does not require a generative model.

Ownership analytics are derived from local git blame results on representative module files. Bus factor is computed as the minimum number of contributors needed to cover 75% of blamed lines.

### Hotspot implementation

Use the existing graph + change-memory ranking and enrich entries in `src/engineering-insights.ts`:

- callers → dependents count
- test-like caller detection → likely test callers
- neighboring callers/callees/implementations → impact surface
- file ownership summaries from git blame → owner/bus-factor metadata
- nearby test heuristics → file-level test gap
- compact deterministic templates → risk summary

## Acceptance criteria

### Overview

- `project_intent_snapshot --format json` returns the new structured fields
- `project_intent_snapshot --format text` renders them in readable sections
- the tool remains useful without any external model configuration

### Hotspots

- `risk_hotspots` returns richer hotspot metadata in text mode
- `risk_hotspots --format json` returns structured enriched hotspot objects
- no existing ranking behavior regresses

## Testing

Add/extend tests for:

- overview snapshot field population
- overview markdown content generation
- enriched hotspot fields
- ownership summary helper behavior
- optional JSON format path for `risk_hotspots` remains type-safe via the underlying result contract

## Future phases

Later enhancements can layer on top without changing the API shape:

1. local-model generated `contentMd`
2. co-change partners
3. target-based risk dossiers
