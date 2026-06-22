import * as crypto from 'crypto';
import * as path from 'path';
import type { DocumentMemoryEntry } from './document-memory.js';

export interface ExternalScanIngestionResult {
  entries: DocumentMemoryEntry[];
  warnings: string[];
}

interface ToolRunResult {
  output: unknown;
  warning?: string;
}

async function runJsonTool(
  projectRoot: string,
  command: string,
  args: string[],
  env?: Record<string, string>
): Promise<ToolRunResult> {
  try {
    const proc = Bun.spawn([command, ...args], {
      cwd: projectRoot,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...env },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0 && stdout.trim().length === 0) {
      return { output: null, warning: `${command} exited ${exitCode}: ${stderr.trim() || 'unknown error'}` };
    }
    try {
      return { output: JSON.parse(stdout) as unknown };
    } catch {
      return { output: null, warning: `${command} output was not valid JSON` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { output: null, warning: `${command} failed: ${message}` };
  }
}

async function runTextTool(
  projectRoot: string,
  command: string,
  args: string[],
  env?: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number; warning?: string }> {
  try {
    const proc = Bun.spawn([command, ...args], {
      cwd: projectRoot,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...env },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: '', stderr: '', exitCode: 1, warning: `${command} failed: ${message}` };
  }
}

function idForScan(projectRoot: string, scanType: string, contentSeed: string): string {
  const hash = crypto.createHash('sha256').update(`${scanType}\n${contentSeed}`).digest('hex').slice(0, 16);
  return `scan:${scanType}:${hash}`;
}

function buildScanEntry(
  projectRoot: string,
  scanType: string,
  title: string,
  body: string,
  summary: string,
  topics: string[],
  files: string[],
  docType: DocumentMemoryEntry['docType'] = 'operations'
): DocumentMemoryEntry {
  return {
    id: idForScan(projectRoot, scanType, title + body),
    kind: 'document',
    timestamp: new Date().toISOString(),
    title,
    body,
    summary,
    changeType: 'docs',
    topics,
    files,
    symbols: [],
    impacts: [],
    path: scanType,
    docType,
    section: scanType,
    sourceMtimeMs: Date.now(),
  };
}

function fileExistsAsync(absPath: string): Promise<boolean> {
  return Bun.file(absPath).exists();
}

function truncate(value: unknown, maxLength: number): string {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

async function ingestPnpmAudit(projectRoot: string): Promise<ToolRunResult & { entries?: DocumentMemoryEntry[] }> {
  const result = await runJsonTool(projectRoot, 'pnpm', ['audit', '--json']);
  if (!result.output || typeof result.output !== 'object') {
    return result;
  }

  const data = result.output as Record<string, unknown>;
  const advisories = (data.advisories ?? {}) as Record<string, unknown>;

  const entries: DocumentMemoryEntry[] = [];
  for (const [id, advisory] of Object.entries(advisories)) {
    const adv = advisory as Record<string, unknown>;
    const severity = String(adv.severity ?? 'unknown');
    const title = String(adv.title ?? id);
    const moduleName = String(adv.module_name ?? '?');
    const overview = truncate(adv.overview, 240);
    const patchedVersions = String(adv.patched_versions ?? 'unknown');
    const vulnerableVersions = String(adv.vulnerable_versions ?? 'unknown');
    const ghsa = Array.isArray(adv.github_advisory_id)
      ? adv.github_advisory_id.join(', ')
      : String(adv.github_advisory_id ?? '');
    const cves = Array.isArray(adv.cves) ? (adv.cves as string[]).join(', ') : String(adv.cves ?? '');
    const paths = Array.isArray(adv.findings)
      ? (adv.findings as Array<{ paths?: string[] }>).flatMap(f => f.paths ?? []).slice(0, 5)
      : [];

    const tags = ['security', 'cve', 'vulnerability', 'audit', 'pnpm', moduleName, severity];
    if (ghsa) tags.push(ghsa);
    if (cves) tags.push(...cves.split(', '));

    const bodyLines = [
      `Package: ${moduleName}`,
      `Severity: ${severity}`,
      ghsa ? `GHSA: ${ghsa}` : '',
      cves ? `CVEs: ${cves}` : '',
      `Vulnerable: ${vulnerableVersions}`,
      `Patched: ${patchedVersions}`,
      overview ? `Overview: ${overview}` : '',
      paths.length > 0 ? `Paths: ${paths.join(', ')}` : '',
    ].filter(Boolean);

    entries.push(buildScanEntry(
      projectRoot,
      'pnpm-audit',
      `[${severity.toUpperCase()}] ${moduleName}: ${title}`,
      bodyLines.join('\n'),
      `Security advisory for ${moduleName} (${severity}).`,
      [...new Set(tags)],
      paths.length > 0 ? paths : ['package.json'],
    ));
  }

  return { output: result.output, entries };
}

async function ingestPnpmOutdated(projectRoot: string): Promise<ToolRunResult & { entries?: DocumentMemoryEntry[] }> {
  const result = await runJsonTool(projectRoot, 'pnpm', ['outdated', '--json']);
  if (!result.output || typeof result.output !== 'object') {
    return result;
  }

  const data = result.output as Record<string, unknown>;
  const packages = Object.entries(data).filter(([key]) => key !== 'error');
  if (packages.length === 0) {
    return { output: result.output, entries: [] };
  }

  const entries: DocumentMemoryEntry[] = [];
  for (const [name, info] of packages) {
    const pkg = info as Record<string, unknown>;
    const current = String(pkg.current ?? '?');
    const latest = String(pkg.latest ?? '?');
    const wanted = String(pkg.wanted ?? latest);
    const body = [
      `Package: ${name}`,
      `Current: ${current}`,
      `Wanted: ${wanted}`,
      `Latest: ${latest}`,
    ].join('\n');

    entries.push(buildScanEntry(
      projectRoot,
      'pnpm-outdated',
      `Outdated package: ${name}`,
      body,
      `${name} is at ${current}; latest is ${latest}.`,
      ['dependencies', 'outdated', 'versions', 'pnpm', name],
      ['package.json'],
    ));
  }

  return { output: result.output, entries };
}

async function ingestKnip(projectRoot: string): Promise<ToolRunResult & { entries?: DocumentMemoryEntry[] }> {
  const result = await runJsonTool(projectRoot, 'knip', ['--reporter', 'json']);
  if (!result.output || typeof result.output !== 'object') {
    return result;
  }

  const data = result.output as Record<string, unknown>;
  const files = (data.files ?? []) as string[];
  const dependencies = (data.dependencies ?? []) as string[];
  const devDependencies = (data.devDependencies ?? []) as string[];
  const optionalPeerDependencies = (data.optionalPeerDependencies ?? []) as string[];
  const unlisted = (data.unlisted ?? []) as string[];
  const exports = (data.exports ?? []) as Array<{ name: string; file?: string }>;
  const types = (data.types ?? []) as Array<{ name: string; file?: string }>;
  const enumMembers = (data.enumMembers ?? []) as Array<{ name: string; file?: string }>;

  const lines: string[] = [];
  if (files.length > 0) lines.push(`Unused files: ${files.length}`, ...files.slice(0, 50).map(f => `  - ${f}`));
  if (exports.length > 0) lines.push(`Unused exports: ${exports.length}`, ...exports.slice(0, 50).map(e => `  - ${e.name}${e.file ? ` (${e.file})` : ''}`));
  if (types.length > 0) lines.push(`Unused types: ${types.length}`, ...types.slice(0, 50).map(e => `  - ${e.name}${e.file ? ` (${e.file})` : ''}`));
  if (dependencies.length > 0) lines.push(`Unused dependencies: ${dependencies.length}`, ...dependencies.slice(0, 50).map(d => `  - ${d}`));
  if (devDependencies.length > 0) lines.push(`Unused dev dependencies: ${devDependencies.length}`, ...devDependencies.slice(0, 50).map(d => `  - ${d}`));
  if (enumMembers.length > 0) lines.push(`Unused enum members: ${enumMembers.length}`, ...enumMembers.slice(0, 50).map(e => `  - ${e.name}${e.file ? ` (${e.file})` : ''}`));
  if (unlisted.length > 0) lines.push(`Unlisted dependencies: ${unlisted.length}`, ...unlisted.slice(0, 50).map(d => `  - ${d}`));
  if (optionalPeerDependencies.length > 0) lines.push(`Optional peer dependencies: ${optionalPeerDependencies.length}`, ...optionalPeerDependencies.slice(0, 50).map(d => `  - ${d}`));

  if (lines.length === 0) {
    return { output: result.output, entries: [] };
  }

  const summary = `knip found ${files.length} unused files, ${exports.length + types.length} unused exports/types, ${dependencies.length + devDependencies.length} unused deps.`;
  const entry = buildScanEntry(
    projectRoot,
    'knip',
    `Dead code report: ${files.length} files, ${exports.length + types.length} exports/types`,
    [summary, '', ...lines.slice(0, 300)].join('\n'),
    summary,
    ['dead-code', 'unused', 'knip', 'exports', 'dependencies'],
    ['knip.json', 'package.json']
  );

  return { output: result.output, entries: [entry] };
}

type LintFinding = { file?: string; line?: number; rule?: string; message?: string; severity?: string };

async function ingestLintJson(projectRoot: string, command: string, args: string[]): Promise<ToolRunResult & { entries?: DocumentMemoryEntry[] }> {
  const result = await runJsonTool(projectRoot, command, args);
  if (!result.output || typeof result.output !== 'object') {
    return result;
  }

  const data = result.output as Record<string, unknown>;
  const findings: LintFinding[] = [];

  // ESLint flat JSON format
  if (Array.isArray(data)) {
    for (const fileResult of data) {
      const filePath = String(fileResult.filePath ?? '');
      for (const msg of (fileResult.messages ?? []) as Array<Record<string, unknown>>) {
        findings.push({
          file: filePath,
          line: Number(msg.line ?? 0),
          rule: String(msg.ruleId ?? 'unknown'),
          message: String(msg.message ?? ''),
          severity: msg.fatal || msg.severity === 2 ? 'error' : msg.severity === 1 ? 'warning' : 'info',
        });
      }
    }
  }

  // Biome JSON format
  if (Array.isArray(data.diagnostics)) {
    for (const diag of data.diagnostics as Array<Record<string, unknown>>) {
      const location = (diag.location ?? {}) as Record<string, unknown>;
      const sourceSpan = (location.sourceSpan ?? {}) as Record<string, unknown>;
      const start = sourceSpan.start as Record<string, unknown> | undefined;
      findings.push({
        file: String(location.path ?? ''),
        line: Number(start?.line ?? 0),
        rule: String(diag.category ?? diag.code ?? 'unknown'),
        message: String(diag.description ?? diag.title ?? ''),
        severity: String(diag.severity ?? 'warning'),
      });
    }
  }

  // oxlint JSON format
  if (Array.isArray(data.rules)) {
    for (const rule of data.rules as Array<Record<string, unknown>>) {
      for (const violation of (rule.violations ?? []) as Array<Record<string, unknown>>) {
        findings.push({
          file: String(violation.file ?? ''),
          line: Number(violation.line ?? 0),
          rule: String(rule.name ?? 'unknown'),
          message: String(violation.message ?? ''),
          severity: String(rule.severity ?? 'warning'),
        });
      }
    }
  }

  if (findings.length === 0) {
    return { output: result.output, entries: [] };
  }

  const entries: DocumentMemoryEntry[] = [];
  for (const finding of findings.slice(0, 200)) {
    const file = finding.file ?? 'unknown';
    const rule = finding.rule ?? 'unknown';
    const line = finding.line ?? 0;
    const message = finding.message ?? '';
    entries.push(buildScanEntry(
      projectRoot,
      `${command}-lint`,
      `${rule} at ${file}:${line}`,
      `${finding.severity?.toUpperCase() ?? 'WARN'}:${line} ${rule} — ${message}`,
      `${rule}: ${message}`,
      ['lint', 'complexity', command, rule, ...(file !== 'unknown' ? [file] : [])],
      file !== 'unknown' ? [file] : [],
    ));
  }

  return { output: result.output, entries };
}

interface TscError {
  file: string;
  line: number;
  code: string;
  message: string;
}

async function ingestTscErrors(projectRoot: string): Promise<{ entries: DocumentMemoryEntry[]; warning?: string }> {
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  if (!(await fileExistsAsync(tsconfigPath))) {
    return { entries: [], warning: 'tsconfig.json not found; skipping tsc error ingestion' };
  }

  const { stdout, exitCode, warning } = await runTextTool(projectRoot, 'bunx', ['tsc', '--noEmit', '--pretty', 'false', '--noErrorTruncation']);
  if (warning) {
    return { entries: [], warning };
  }

  const errors: TscError[] = [];
  // Parse lines like: src/foo.ts(12,34): error TS2339: Property 'x' does not exist on type 'Y'.
  const pattern = /^(.+)\((\d+),\d+\):\s*error\s+(TS\d+):\s*(.+)$/;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    const match = pattern.exec(line);
    if (!match) continue;
    const [, filePath, lineNo, code, message] = match;
    errors.push({ file: filePath, line: Number(lineNo), code, message: message.trim() });
  }

  // tsc exits 0 when there are no errors, 2 when there are errors.
  if (exitCode === 0 && errors.length === 0) {
    return { entries: [] };
  }

  const entries: DocumentMemoryEntry[] = [];
  for (const error of errors.slice(0, 200)) {
    entries.push(buildScanEntry(
      projectRoot,
      'tsc-error',
      `${error.code} at ${error.file}:${error.line}`,
      `${error.code}: ${error.message}`,
      `TypeScript error ${error.code}: ${error.message}`,
      ['type-error', error.code, error.file],
      [error.file],
      'note',
    ));
  }

  return { entries };
}

interface JscpdClone {
  format: string;
  lines: number;
  tokens: number;
  files: Array<{ path: string; start: number; end: number; line?: number; lines?: number }>;
}

async function ingestJscpdClones(projectRoot: string): Promise<{ entries: DocumentMemoryEntry[]; warning?: string }> {
  const result = await runJsonTool(projectRoot, 'bunx', ['jscpd', '--reporters', 'json', '.']);
  if (!result.output || typeof result.output !== 'object') {
    return { entries: [], warning: result.warning ?? 'jscpd produced no JSON output' };
  }

  const data = result.output as Record<string, unknown>;
  const duplicates = (data.duplicates ?? []) as JscpdClone[];
  if (duplicates.length === 0) {
    return { entries: [] };
  }

  const entries: DocumentMemoryEntry[] = [];
  for (const duplicate of duplicates.slice(0, 100)) {
    const files = duplicate.files.map(f => f.path);
    const lines = duplicate.files.map(f => `${f.path}:${f.start ?? f.line ?? 0}`);
    const contentSeed = files.join(':') + duplicate.lines;
    entries.push({
      id: idForScan(projectRoot, 'jscpd-clone', contentSeed),
      kind: 'document',
      timestamp: new Date().toISOString(),
      title: `Copy-paste: ${duplicate.lines} lines across ${files.length} files`,
      body: `Clone group of ${duplicate.lines} lines / ${duplicate.tokens} tokens:\n${lines.join('\n')}`,
      summary: `Duplicate code block of ${duplicate.lines} lines in ${files.join(', ')}.`,
      changeType: 'docs',
      topics: ['clone', 'duplication', 'jscpd', ...files.map(f => path.basename(f, path.extname(f)))],
      files,
      symbols: [],
      impacts: [],
      path: 'jscpd-clone',
      docType: 'note',
      section: 'jscpd-clone',
      sourceMtimeMs: Date.now(),
    });
  }

  return { entries };
}

export async function ingestExternalScanDataAsync(projectRoot: string): Promise<ExternalScanIngestionResult> {
  const root = path.resolve(projectRoot);
  const entries: DocumentMemoryEntry[] = [];
  const warnings: string[] = [];

  const audit = await ingestPnpmAudit(root);
  if (audit.entries) entries.push(...audit.entries);
  if (audit.warning) warnings.push(audit.warning);

  const outdated = await ingestPnpmOutdated(root);
  if (outdated.entries) entries.push(...outdated.entries);
  if (outdated.warning) warnings.push(outdated.warning);

  const knip = await ingestKnip(root);
  if (knip.entries) entries.push(...knip.entries);
  if (knip.warning) warnings.push(knip.warning);

  // Try common lint tools; stop at the first one that produces results.
  const lintTools: Array<[string, string[]]> = [
    ['oxlint', ['--format', 'json', '.']],
    ['biome', ['check', '--reporter=json', '.']],
    ['eslint', ['--format', 'json', '.']],
  ];
  for (const [command, args] of lintTools) {
    const lint = await ingestLintJson(root, command, args);
    if (lint.entries && lint.entries.length > 0) {
      entries.push(...lint.entries);
      break;
    }
    if (lint.warning) warnings.push(`${command}: ${lint.warning}`);
  }

  const tsc = await ingestTscErrors(root);
  if (tsc.entries.length > 0) entries.push(...tsc.entries);
  if (tsc.warning) warnings.push(tsc.warning);

  const clones = await ingestJscpdClones(root);
  if (clones.entries.length > 0) entries.push(...clones.entries);
  if (clones.warning) warnings.push(clones.warning);

  return { entries, warnings };
}
