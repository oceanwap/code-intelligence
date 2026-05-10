# code-intelligence

A local, **privacy-first** code intelligence system. Indexes your codebase using AST parsing, stores embeddings in a local [Qdrant](https://qdrant.tech) vector database, and exposes search + graph tools over an MCP server that VS Code Copilot can use as an agent tool.

No cloud APIs, no API keys. Everything runs on your machine.

---

## What It Does

- **AST-aware indexing** — extracts functions, classes, and methods as individual chunks (TypeScript/JavaScript via ts-morph, PHP via php-parser)
- **Semantic search** — embeds code locally using [BGE-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) (~33 MB, ~384-dim vectors)
- **Call graph** — builds outbound + inbound call edges across all symbols so retrieval can follow dependencies
- **Differential indexing** — only re-embeds files that changed since the last run (manifest + mtime tracking)
- **Plain-file indexing** — also indexes `.json`, `.yaml`, `.md`, `Dockerfile`, etc. as whole-file chunks
- **Offline project memory** — derives semantic change memory from local git history and semantic fact memory from README/docs/notes without external AI APIs
- **Offline bug memory** — synthesizes evidence-backed bug memory from local fix history, including extracted symptoms, failing-test hints, and error signatures when they appear in commit text
- **MCP server** — exposes tools that VS Code Copilot agent can call to explore any indexed project

---

## Requirements

- **Node.js** ≥ 20
- **Qdrant** running locally on port 6333

### Start Qdrant (Docker)

```bash
docker run -d -p 6333:6333 qdrant/qdrant
```

---

## Setup

```bash
# 1. Clone and install
git clone https://github.com/your-username/code-intelligence.git
cd code-intelligence
npm install

# 2. Install the CLI globally
npm link
# → `code-intel` is now available system-wide

# 3. Start the MCP HTTP server (keep this running)
npm start
# → Listening on http://localhost:3737/mcp
```

The embedding model (~33 MB) is downloaded automatically on first use to `~/.cache/code-intelligence/models/` and reused across all projects.

---

## CLI Usage

### Index a project

```bash
code-intel index /path/to/your/project
# or from inside the project:
code-intel index .

# exhaustive mode (explicit):
code-intel index . --full-index

# force complete rebuild (slowest):
code-intel index . --from-scratch --full-index
```

Output:

```
Scanning /path/to/project...
  Embedding   [█████████████████████████] 100%  1274/1274
  Storing     [█████████████████████████] 100%  312/312
  5810 chunks extracted
  2245 symbols, 1274 files in graph
Indexing complete.
```

Re-running only re-embeds changed files. First run takes longer (model load + full embed).

### Index modes

- `fast` (default): global pre-scan scores all indexable files cheaply, then deep parsing/embedding focuses on high-signal candidates.
- `full` (`--full-index`): indexes all eligible files/chunks.

Use `fast` for agent workflows and frequent incremental updates. Use `full` for deep audits, migration work, or when long-tail docs/tests are required.

### Throttle local indexing workload

If your machine cannot process large repositories quickly, cap indexing scope:

```bash
# Hard cap fast-mode chunk embeddings per run (default: 3500, valid 500..50000)
CODE_INTEL_FAST_MAX_CHUNKS=2000 code-intel index .

# Limit git commits ingested into project-memory embeddings (default: 150, valid 20..1000)
CODE_INTEL_MEMORY_MAX_COMMITS=60 code-intel index .
```

These are especially useful for first-run indexing on laptops and older CPUs.

### Recommended indexing workflow

1. Start with `code-intel index .` (fast default).
2. Use query tools (`query_project`, `get_symbol`, `get_file_chunks`) for normal agent loops.
3. Re-run fast index after major edits or branch switches.
4. Run `--full-index` periodically (or before release hardening) to refresh long-tail context.
5. Use `--from-scratch` only when recovering from stale/corrupt index state.

### Benchmark runtime and stage timings

```bash
# fair benchmark mode (default): uses from-scratch runs to avoid cache bias
bun run bench:runtime -- --runs 3

# full-index benchmark run
bun run bench:runtime -- --mode full --runs 3

# disable fairness if you want warm-cache throughput behavior
bun run bench:runtime -- --no-fair --runs 3
```

`index` output includes stage timing breakdown (`pre-scanning`, `parsing`, `building-graph`, `cleaning`, `embedding+storing`, etc.) so bottlenecks are visible without external profilers.

### Bun embedding bottleneck investigation

If Bun is slower on your machine, focus on `embedding+storing` stage:

```bash
CODE_INTEL_EMBED_DEBUG=1 bun run dev index .
```

This prints embed diagnostics: uncached chunk counts, selected batch size, and sub-step timings.
Use those numbers to tune candidate thresholds and re-check with `bench:runtime`.

### Query a project

```bash
code-intel query "how does authentication work" --dir /path/to/project
code-intel query "where is the database connection configured" --dir .
```

### Custom Qdrant URL

```bash
code-intel index . --qdrant http://localhost:6333
code-intel query "..." --dir . --qdrant http://localhost:6333
```

### Project status and history

```bash
code-intel status --dir .
code-intel features --dir .
code-intel changes --dir . --limit 10
code-intel changes --dir . --type fix --topic auth
code-intel bugs --dir . --limit 10 --topic auth
code-intel bug-brief AuthService.login --dir . --mode symbol
code-intel memory-query "what changed in caching recently" --dir .
```

Project-memory entries are built locally from recent git history plus markdown/text docs. For supported languages, changed hunks are mapped to impacted symbols so history is stored as semantic impact instead of raw line diffs. Document memory is section-based, so README/docs/ADR-style files become searchable project facts. Bug memory is the first structured failure layer on top of that: fix commits become bug entries only when the commit text yields concrete evidence such as symptoms, failing-test names, or explicit error signatures, so agents can ask what broke recently without falling back to vague fix history. The initial implementation indexes the most recent 150 commits per branch.

---

## MCP Server

The MCP server exposes code-intelligence tools for both code memory and project memory.

### Start the server

```bash
npm start
# or in the background:
npm start &
```

Runs on `http://localhost:3737/mcp`.

### Available MCP Tools

| Tool              | Description                                                                          |
| ----------------- | ------------------------------------------------------------------------------------ |
| `index_project`   | Parse and index a codebase. Runs differential update — only re-embeds changed files. |
| `index_status`    | Check if a project is indexed and show stats (chunks, symbols, call graph edges).    |
| `project_status`  | Show an engineer-style status snapshot: branch, latest change, active topics, fixes. |
| `architecture_overview` | Show module boundaries, coupling, instability, and architecture zones.        |
| `dependency_path` | Find a module-level dependency path between two architecture modules.           |
| `coupling_report` | Rank heavily-coupled modules and strongest dependency edges.                    |
| `unstable_modules` | List high-instability modules (outbound-heavy dependency profiles).           |
| `attention_overview` | Show attention snapshot derived from structure, temporal, failure, behavior, and freshness signals. |
| `attention_score` | Return attention breakdown for a specific symbol or module. |
| `active_zones` | Show currently active architecture zones by attention concentration. |
| `hotspots` | Return top attention-priority modules for immediate engineering focus. |
| `regression_hotspots` | Show historically failure-prone hotspot areas. |
| `embedding_priority` | Return selective semantic enrichment queue based on attention tiers. |
| `reflect_change` | Generate/fetch reflection entry for latest or specific indexed change.           |
| `regression_risk` | Estimate regression risk for a target symbol/file/module.                      |
| `similar_failures` | Retrieve similar historical bug-memory entries for a target area.             |
| `failure_clusters` | Cluster failures by dependency patterns, architecture weakness, and instability. |
| `root_cause_history` | Retrieve causal failure history (symptoms, root causes, triggers, prevention). |
| `historical_regressions` | List likely recurrent regressions, optionally scoped to a target area. |
| `validate_architecture` | Run architecture constraint validation and summarize violations by severity. |
| `constraint_violations` | Retrieve detailed architecture constraint violations with optional severity filter. |
| `boundary_analysis` | Inspect boundary pressure (inbound/outbound, instability, coupling) per module. |
| `architecture_drift` | Track module-level drift in instability, coupling, and risk over time. |
| `hotspot_analysis` | Rank temporal architecture hotspots by churn, bugs, instability, and coupling. |
| `instability_timeline` | Show module instability timeline points across indexed snapshots. |
| `memory_health` | Report memory governance health (stale entries, contradictions, confidence). |
| `contradiction_report` | List memory entries that conflict with architecture/failure evidence. |
| `stale_memory` | List decayed or low-confidence memory entries requiring revalidation. |
| `cognition_gate` | Run a single pre-generation cognition gate across structure, attention, architecture, risk, failures, constraints, evolution, and memory health. |
| `prepare_task_execution` | Unified kickoff endpoint: combines preflight change risk, task-scoped context assembly, and optional test impact in one call. |
| `generate_project_brief` | Generate a compact project briefing from current cognition snapshots and project memory. |
| `cognition_diff` | Return a compact cognition-state summary for the current branch (risk counters, hotspots, indexed freshness). |
| `compare_branch_cognition` | Compare cognition snapshots between current branch and a target branch to highlight deltas. |
| `git_semantic_change_graph` | Git-focused semantic change graph for working tree/commit/range: changed symbols (added/deleted/modified), before/after usage + semantic caller deltas, and compact risk signals. |
| `feature_map`     | Show documented features and architecture facts from offline document memory.         |
| `recent_changes`  | Show recent semantic changes from offline project memory.                             |
| `recent_bugs`     | Show recent bug-memory entries synthesized from local fix history.                    |
| `bug_brief`       | Show recent bug history for an exact symbol or file target.                           |
| `query_project_memory` | Semantic search over local git-derived project memory.                          |
| `query_project`   | Semantic search with natural language. Returns code + file + call graph context.     |
| `get_symbol`      | Look up a specific symbol by name — returns source, callers, and callees.            |
| `list_symbols`    | List all symbols grouped by file. Supports file path filter.                         |
| `get_file_chunks` | Get all indexed chunks (functions, classes, methods) from a specific file.           |

### VS Code Integration

The MCP server is registered globally in VS Code `settings.json`:

```json
"mcp": {
  "servers": {
    "code-intelligence": {
      "type": "sse",
      "url": "http://localhost:3737/mcp"
    }
  }
}
```

With the server running, VS Code Copilot agent can call these tools automatically when you ask questions about any indexed project.

### Example: prepare_task_execution

Use `prepare_task_execution` when you want one kickoff call before editing. It bundles:

- working-tree preflight risk
- task-scoped code and memory context
- optional likely test impact for a symbol or file target

Set `"format": "signals"` when you want compact decision signals (counts, risk flags, dominant modules, top risky files, likely test counts) instead of full detailed payloads.

Example payload:

```json
{
  "projectRoot": "/path/to/project",
  "task": "fix authentication session expiry bug",
  "target": "AuthService.refreshSession",
  "limit": 10,
  "format": "json"
}
```

Typical response shape:

```json
{
  "task": "fix authentication session expiry bug",
  "generatedAt": "2026-05-10T12:34:56.000Z",
  "preflight": {
    "generatedAt": "2026-05-10T12:34:55.000Z",
    "totalChangedFiles": 3,
    "highRiskFiles": 1,
    "entries": [
      {
        "path": "src/auth/service.ts",
        "status": "M",
        "module": "src/auth",
        "attentionTier": "CRITICAL",
        "attentionScore": 0.913,
        "regressionRisk": 0.82,
        "regressionLevel": "high",
        "violations": ["[high] auth-boundary"],
        "relatedBugCount": 2,
        "recentChangeCount": 4
      }
    ]
  },
  "context": {
    "task": "fix authentication session expiry bug",
    "topModules": [
      { "module": "src/auth", "tier": "CRITICAL", "score": 0.913 }
    ],
    "semanticCode": [
      { "file": "src/auth/service.ts", "symbol": "AuthService.refreshSession", "score": 0.941 }
    ],
    "constraints": [],
    "recentChanges": [],
    "relatedBugs": [],
    "memoryHits": []
  },
  "testImpact": {
    "target": "AuthService.refreshSession",
    "tests": [
      {
        "file": "test/auth-service.test.ts",
        "score": 6,
        "reasons": ["contains exact target token"],
        "matchedSymbols": ["AuthService.refreshSession"]
      }
    ]
  }
}
```

**Recommended agent workflow:**

1. `index_project` — index your project (once; re-run after large changes)
2. `index_status` — confirm it's ready
3. `query_project` — semantic search
4. `get_symbol` / `get_file_chunks` — drill into specific code

---

## Language Support

| Language           | Functions | Classes | Methods | Call Graph |
| ------------------ | --------- | ------- | ------- | ---------- |
| TypeScript / TSX   | ✅        | ✅      | ✅      | ✅         |
| JavaScript / JSX   | ✅        | ✅      | ✅      | ✅         |
| PHP                | ✅        | ✅      | ✅      | ✅         |
| JSON / YAML / TOML | —         | —       | —       | whole-file |
| Markdown / MDX     | —         | —       | —       | whole-file |
| Dockerfile / shell | —         | —       | —       | whole-file |

---

## Storage Layout

| Location                                     | Contents                                                    |
| -------------------------------------------- | ----------------------------------------------------------- |
| `~/.cache/code-intelligence/models/`         | BGE embedding model (shared, downloaded once)               |
| `<project>/.code-intelligence/<branch>/manifest.json` | File mtimes + chunk IDs (differential indexing state) |
| `<project>/.code-intelligence/<branch>/cache.json`    | Embedding vector cache (avoid re-embedding unchanged files) |
| `<project>/.code-intelligence/<branch>/graph.json`    | Call graph: symbols → callees, callers, file locations |
| `<project>/.code-intelligence/<branch>/structure.json` | Structural truth snapshot: module graph, dependencies, zones, cycles, symbol ownership |
| `<project>/.code-intelligence/<branch>/attention.json` | Attention snapshot: module/symbol scores, tiers, active zones |
| `<project>/.code-intelligence/<branch>/architecture.json` | Architecture cognition snapshot: modules, dependencies, coupling, instability, zones |
| `<project>/.code-intelligence/<branch>/reflection.json` | Reflection entries for indexed changes, risk, and historical similarity |
| `<project>/.code-intelligence/<branch>/failure-intelligence.json` | Failure cognition snapshot: root causes, triggers, clusters, and recurrence links |
| `<project>/.code-intelligence/<branch>/constraints.json` | Constraint validation snapshot: rules and detected architecture violations |
| `<project>/.code-intelligence/<branch>/evolution.json` | Temporal cognition snapshot: module trends, architecture drift, and hotspots |
| `<project>/.code-intelligence/<branch>/memory-governance.json` | Memory governance snapshot: confidence, decay, contradictions, and health metrics |
| `<project>/.code-intelligence/<branch>/project-memory.json` | Offline semantic project memory derived from git history |
| `<project>/.code-intelligence/cognition-config.json` | Optional cognition thresholds and tuning config for failure, constraints, evolution, governance |
| `<project>/.code-intelligence/<branch>/project-memory-cache.json` | Embedding cache for project-memory entries |
| Qdrant collection `code-<hash>`              | Vector embeddings + payloads, one collection per project    |
| Qdrant collection `memory-<hash>`            | Semantic embeddings for project-memory entries              |

Add `.code-intelligence` to your project's `.gitignore`.

---

## Development

```bash
# Run tests
npm test

# Type-check
npm run typecheck

# Run CLI without installing
npx tsx src/cli.ts index .
npx tsx src/cli.ts query "..." --dir .

# Run MCP server in stdio mode (for debugging)
npm run mcp

# Run MCP server in HTTP mode
npm start
```

---

## License

MIT — see [LICENSE](LICENSE).
