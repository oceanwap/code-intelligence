import * as path from 'path';
import { getDataDir } from '../../git.js';
import {
  type DuplicateLocation,
  type DuplicateSeverity,
  type DuplicateSource,
  type ExternalToolResult,
  type SemanticDuplicatePattern,
} from './types.js';
import { moduleFromFile } from '../../utils/module-path.js';

function toolBinary(tool: DuplicateSource): string {
  switch (tool) {
    case 'ast-grep':
      return 'sg';
    case 'semgrep':
      return 'semgrep';
    case 'madge':
      return 'madge';
    case 'codeql':
      return 'codeql';
    default:
      return tool;
  }
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(['which', cmd], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    const exit = await proc.exited;
    return exit === 0;
  } catch {
    return false;
  }
}

async function resolveBinary(projectRoot: string, binary: string): Promise<string | null> {
  if (await commandExists(binary)) return binary;
  const local = path.join(projectRoot, 'node_modules', '.bin', binary);
  if (await Bun.file(local).exists()) return local;
  return null;
}

async function runTool(
  projectRoot: string,
  tool: DuplicateSource,
  args: string[]
): Promise<ExternalToolResult> {
  const binaryName = toolBinary(tool);
  const binary = await resolveBinary(projectRoot, binaryName);
  const command = [binaryName, ...args];

  if (!binary) {
    return {
      tool,
      command,
      exitCode: -1,
      stdout: '',
      stderr: `${binaryName} is not installed or not in PATH`,
      patterns: [],
    };
  }

  const proc = Bun.spawn([binary, ...args], {
    cwd: projectRoot,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { tool, command, exitCode, stdout, stderr, patterns: [] };
}

function severityFromString(value?: string): DuplicateSeverity {
  const lowered = (value ?? 'medium').toLowerCase();
  if (lowered === 'error' || lowered === 'high' || lowered === 'critical') return 'high';
  if (lowered === 'warning' || lowered === 'medium') return 'medium';
  return 'low';
}

function location(projectRoot: string, file: string, line: number, symbol?: string): DuplicateLocation {
  const relFile = path.relative(projectRoot, file).replace(/\\/g, '/');
  return {
    file: relFile,
    line: Math.max(1, line),
    column: 1,
    symbol: symbol ?? '<unknown>',
    module: moduleFromFile(relFile),
  };
}

function patternId(tool: DuplicateSource, ruleId: string, index: number): string {
  return `${tool}:${ruleId}:${index}`;
}

function parseAstGreps(stdout: string, projectRoot: string): SemanticDuplicatePattern[] {
  let rows: unknown[] = [];
  try {
    rows = JSON.parse(stdout) as unknown[];
  } catch {
    return [];
  }

  const byRule = new Map<string, DuplicateLocation[]>();
  const messages = new Map<string, string>();
  const severities = new Map<string, DuplicateSeverity>();

  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const ruleId = String(r['ruleId'] ?? r['id'] ?? 'unknown');
    const file = String(r['file'] ?? '');
    const range = r['range'] as Record<string, unknown> | undefined;
    const start = range?.['start'] as Record<string, unknown> | undefined;
    const line = Number(start?.['line'] ?? 1);
    const message = String(r['message'] ?? r['text'] ?? '');
    const severity = severityFromString(String(r['severity'] ?? 'medium'));

    if (!file) continue;
    const loc = location(projectRoot, file, line);
    const list = byRule.get(ruleId) ?? [];
    list.push(loc);
    byRule.set(ruleId, list);
    if (!messages.has(ruleId)) messages.set(ruleId, message);
    if (!severities.has(ruleId)) severities.set(ruleId, severity);
  }

  const patterns: SemanticDuplicatePattern[] = [];
  let index = 0;
  for (const [ruleId, locations] of byRule.entries()) {
    if (locations.length < 2) continue;
    const sev = severities.get(ruleId) ?? 'medium';
    patterns.push({
      id: patternId('ast-grep', ruleId, index),
      category: 'ast-grep-match',
      title: `ast-grep rule "${ruleId}" matched ${locations.length} times`,
      description: messages.get(ruleId) || `Pattern matched by ast-grep rule ${ruleId}.`,
      severity: sev,
      source: 'ast-grep',
      ruleId,
      locations,
      meta: { occurrenceCount: locations.length },
    });
    index += 1;
  }
  return patterns;
}

function parseSemgrep(stdout: string, projectRoot: string): SemanticDuplicatePattern[] {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return [];
  }

  const results = parsed['results'] as unknown[] | undefined;
  if (!Array.isArray(results)) return [];

  const byRule = new Map<string, { locations: DuplicateLocation[]; message: string; severity: DuplicateSeverity }>();

  for (const row of results) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const checkId = String(r['check_id'] ?? 'unknown');
    const file = String(r['path'] ?? '');
    const start = (r['start'] as Record<string, unknown> | undefined) ?? {};
    const line = Number(start['line'] ?? 1);
    const extra = (r['extra'] as Record<string, unknown> | undefined) ?? {};
    const message = String(extra['message'] ?? '');
    const severity = severityFromString(String(extra['severity'] ?? 'medium'));

    if (!file) continue;
    const loc = location(projectRoot, file, line);
    const existing = byRule.get(checkId) ?? { locations: [], message, severity };
    existing.locations.push(loc);
    if (!existing.message) existing.message = message;
    byRule.set(checkId, existing);
  }

  const patterns: SemanticDuplicatePattern[] = [];
  let index = 0;
  for (const [ruleId, data] of byRule.entries()) {
    if (data.locations.length < 1) continue; // semgrep rules can be single-shot anti-patterns
    patterns.push({
      id: patternId('semgrep', ruleId, index),
      category: 'semgrep-match',
      title: `semgrep rule "${ruleId}" matched ${data.locations.length} time(s)`,
      description: data.message || `Pattern matched by semgrep rule ${ruleId}.`,
      severity: data.severity,
      source: 'semgrep',
      ruleId,
      locations: data.locations,
      meta: { occurrenceCount: data.locations.length },
    });
    index += 1;
  }
  return patterns;
}

function parseMadge(stdout: string, projectRoot: string): SemanticDuplicatePattern[] {
  let cycles: string[][] = [];
  try {
    cycles = JSON.parse(stdout) as string[][];
  } catch {
    return [];
  }
  if (!Array.isArray(cycles)) return [];

  return cycles
    .filter(cycle => cycle.length >= 2)
    .map((cycle, index) => {
      const locations = cycle.map(file => {
        const rel = path.relative(projectRoot, file).replace(/\\/g, '/');
        return {
          file: rel,
          line: 1,
          column: 1,
          symbol: '<module>',
          module: moduleFromFile(rel),
        };
      });
      return {
        id: patternId('madge', 'circular-dependency', index),
        category: 'circular-dependency',
        title: `Circular dependency (${cycle.length} modules)`,
        description: `Madge detected a circular dependency: ${cycle.join(' -> ')}`,
        severity: 'high' as DuplicateSeverity,
        source: 'madge',
        ruleId: 'circular-dependency',
        locations,
        meta: { cycle },
      };
    });
}

export async function runAstGrepAsync(
  projectRoot: string,
  rulePath?: string,
  target?: string
): Promise<ExternalToolResult> {
  const args = ['scan', '--json'];
  if (rulePath) args.push('--config', rulePath);
  if (target) args.push(target);
  const result = await runTool(projectRoot, 'ast-grep', args);
  if (result.exitCode === 0 || result.exitCode === 1) {
    // ast-grep exits 1 when matches are found.
    result.patterns = parseAstGreps(result.stdout, projectRoot);
  }
  return result;
}

export async function runSemgrepAsync(
  projectRoot: string,
  config?: string,
  target?: string
): Promise<ExternalToolResult> {
  const args = ['--json', '--quiet'];
  if (config) args.push('--config', config);
  else args.push('--config', 'auto');
  args.push(target ?? '.');
  const result = await runTool(projectRoot, 'semgrep', args);
  if (result.exitCode === 0 || result.exitCode === 1) {
    result.patterns = parseSemgrep(result.stdout, projectRoot);
  }
  return result;
}

export async function runMadgeAsync(
  projectRoot: string,
  target?: string
): Promise<ExternalToolResult> {
  const args = ['--circular', '--json'];
  if (target) args.push(target);
  const result = await runTool(projectRoot, 'madge', args);
  if (result.exitCode === 0) {
    result.patterns = parseMadge(result.stdout, projectRoot);
  }
  return result;
}

export async function runCodeQLAsync(
  _projectRoot: string,
  _queryPack?: string
): Promise<ExternalToolResult> {
  // CodeQL requires a database and is too heavy for a generic wrapper.
  // Provide a clear "not implemented" result so callers can surface guidance.
  return {
    tool: 'codeql',
    command: ['codeql', 'database', 'analyze', '<database>', '<queries>'],
    exitCode: -2,
    stdout: '',
    stderr:
      'CodeQL is not wrapped generically. Create a CodeQL database first ' +
      '(codeql database create), then run codeql database analyze and feed ' +
      'the SARIF output into code-intel manually.',
    patterns: [],
  };
}
