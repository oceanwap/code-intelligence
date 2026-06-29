/**
 * One-shot generator for the FR-11 baseline fixture.
 *
 * Parses `src/mcp-server.ts`, extracts every `server.registerTool('name', { ... })`
 * registration block, and writes `test/fixtures/leaf-baseline-snapshot.json`.
 *
 * Captured metadata per leaf:
 *   - line:           source line of the registration call
 *   - description:    exact `description:` string from the config (truncated)
 *   - inputKeys:      sorted keys of the `inputSchema` object
 *   - outputShape:    detected output shape from handler body (currently `mcp_text`)
 *   - handlerParams:  sorted list of destructured parameter names in the handler
 *
 * This is meant to be run ONCE at baseline (commit 0c104caa) and committed;
 * the backward-compat test then re-runs the same parser against the live file
 * and asserts the metadata for the 25 baseline leaves is byte-identical.
 *
 * Usage: bun run scripts/gen-leaf-baseline.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const MCP_SERVER = path.resolve('src/mcp-server.ts');
const FIXTURE_OUT = path.resolve('test/fixtures/leaf-baseline-snapshot.json');

interface LeafMeta {
  name: string;
  line: number;
  description: string;
  inputKeys: string[];
  handlerParams: string[];
  outputShape: 'mcp_text' | 'unknown';
}

function parseLeaves(source: string): LeafMeta[] {
  const leaves: LeafMeta[] = [];
  const lines = source.split('\n');

  // Find every `server.registerTool(` call. Match the name (first string arg),
  // then walk forward to find the matching close of the call to extract the
  // config object and the handler signature.
  const callRe = /server\.registerTool\(\s*$/;
  let i = 0;
  while (i < lines.length) {
    if (callRe.test(lines[i] ?? '')) {
      // Next line should be the name string literal.
      const nameLineIdx = i + 1;
      const nameLine = (lines[nameLineIdx] ?? '').trim();
      const nameMatch = /^'([a-z_0-9]+)',\s*$/.exec(nameLine);
      if (!nameMatch) {
        i++;
        continue;
      }
      const name = nameMatch[1]!;
      const line = i + 1; // 1-indexed

      // Walk forward to find the config object (the { ... } block). We track
      // brace depth to find the matching close.
      let depth = 0;
      let started = false;
      let j = nameLineIdx + 1;
      let configEnd = -1;
      for (; j < lines.length; j++) {
        const ln = lines[j] ?? '';
        for (const ch of ln) {
          if (ch === '{') { depth++; started = true; }
          else if (ch === '}') { depth--; if (started && depth === 0) { configEnd = j; break; } }
        }
        if (configEnd !== -1) break;
      }
      if (configEnd === -1) { i++; continue; }

      const configLines = lines.slice(nameLineIdx + 1, configEnd + 1).join('\n');
      const description = extractDescription(configLines);
      const inputKeys = extractInputKeys(configLines);

      // Find the handler `async ({ ... }) =>` destructured params. Search a
      // reasonable window after configEnd.
      const handlerWindow = lines.slice(configEnd + 1, Math.min(lines.length, configEnd + 20)).join('\n');
      const handlerParams = extractHandlerParams(handlerWindow);
      const outputShape = detectOutputShape(handlerWindow);

      leaves.push({ name, line, description, inputKeys, handlerParams, outputShape });
      i = configEnd + 1;
    } else {
      i++;
    }
  }
  return leaves;
}

function extractDescription(configLines: string): string {
  const m = /description:\s*'((?:\\'|[^'])*)'/.exec(configLines);
  if (!m) return '';
  // Un-escape common sequences.
  return m[1]!.replace(/\\'/g, "'").replace(/\\n/g, ' ');
}

function extractInputKeys(configLines: string): string[] {
  const keys: string[] = [];
  const re = /^\s{8}([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(configLines)) !== null) {
    const k = m[1]!;
    if (k === 'description' || k === 'inputSchema') continue;
    keys.push(k);
  }
  return [...new Set(keys)].sort();
}

function extractHandlerParams(handlerWindow: string): string[] {
  // Match `async ({ ... }) =>` or `async function ({ ... })`
  const m = /async\s*\(\{([^}]*)\}\)/.exec(handlerWindow);
  if (!m) return [];
  const params = m[1]!.split(',').map(s => s.trim().split(/[:=]/)[0]!.trim()).filter(Boolean);
  return [...new Set(params)].sort();
}

function detectOutputShape(handlerWindow: string): 'mcp_text' | 'unknown' {
  // Heuristic: if the handler returns `{ content: [{ type: 'text', text: ... }] }`
  // we record `mcp_text`. This is the canonical MCP result shape used by every
  // leaf in this codebase (verified by visual inspection at baseline).
  if (/content:\s*\[\s*\{\s*type:\s*'text'/.test(handlerWindow)) return 'mcp_text';
  return 'unknown';
}

function main(): void {
  const source = fs.readFileSync(MCP_SERVER, 'utf8');
  const leaves = parseLeaves(source);
  if (leaves.length === 0) {
    throw new Error(`No leaves parsed from ${MCP_SERVER}`);
  }

  const BASELINE_LEAVES = [
    'render_behavior',
    'get_symbol',
    'get_symbols',
    'list_symbols',
    'find_references',
    'find_implementations',
    'expand_graph',
    'query_project',
    'query_project_memory',
    'git_semantic_change_graph',
    'index_status',
    'index_project',
    'regression_risk',
    'regression_hotspots',
    'risk_hotspots',
    'hotspot_analysis',
    'semantic_duplicates',
    'attention_overview',
    'architecture_overview',
    'architecture_drift',
    'constraint_violations',
    'coupling_report',
    'dependency_path',
    'recent_changes',
    'recent_bugs',
  ];

  const leafMap = new Map(leaves.map(l => [l.name, l]));
  const baseline: Record<string, unknown> = {};
  for (const name of BASELINE_LEAVES) {
    const meta = leafMap.get(name);
    if (!meta) {
      throw new Error(`Baseline leaf "${name}" not found in ${MCP_SERVER}`);
    }
    baseline[name] = meta;
  }

  const fixture = {
    schemaVersion: 1,
    baselineCommit: '0c104caa',
    generatedAt: new Date().toISOString(),
    description: 'FR-11 baseline: inputSchema + description + handler params for the 25 pre-US-001 leaves. Captured by scripts/gen-leaf-baseline.ts against src/mcp-server.ts. The `line` field is informational only — tests assert the other fields.',
    baselineLeaves: BASELINE_LEAVES,
    leaves: baseline,
  };

  fs.mkdirSync(path.dirname(FIXTURE_OUT), { recursive: true });
  fs.writeFileSync(FIXTURE_OUT, JSON.stringify(fixture, null, 2) + '\n');

  console.log(`Wrote ${FIXTURE_OUT}`);
  console.log(`Parsed ${leaves.length} leaves; baseline covers ${BASELINE_LEAVES.length}.`);
}

main();