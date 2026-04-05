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
code-intel memory-query "what changed in caching recently" --dir .
```

Project-memory entries are built locally from recent git history plus markdown/text docs. For supported languages, changed hunks are mapped to impacted symbols so history is stored as semantic impact instead of raw line diffs. Document memory is section-based, so README/docs/ADR-style files become searchable project facts. The initial implementation indexes the most recent 150 commits per branch.

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
| `feature_map`     | Show documented features and architecture facts from offline document memory.         |
| `recent_changes`  | Show recent semantic changes from offline project memory.                             |
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
| `<project>/.code-intelligence/<branch>/project-memory.json` | Offline semantic project memory derived from git history |
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
