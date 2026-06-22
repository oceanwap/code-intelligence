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

async function ingestPnpmAudit(projectRoot: string): Promise<ToolRunResult & { entries?: DocumentMemoryEntry[] }> {
  const result = await runJsonTool(projectRoot, 'pnpm', ['audit', '--json']);
  if (!result.output || typeof result.output !== 'object') {
    return result;
  }

  const data = result.output as Record<string, unknown>;
  const advisories = (data.advisories ?? {}) as Record<string, unknown>;
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;

  const findings: string[] = [];
  let critical = 0;
  let high = 0;
  let moderate = 0;
  let low = 0;

  for (const [id, advisory] of Object.entries(advisories)) {
    const adv = advisory as Record<string, unknown>;
    const severity = String(adv.severity ?? 'unknown');
    const title = String(adv.title ?? id);
    const moduleName = String(adv.module_name ?? '?');
    const overview = String(adv.overview ?? '').slice(0, 200);
    const patchedVersions = String(adv.patched_versions ?? 'unknown');
    const recommendation = String(adv.recommendation ?? '').slice(0, 200);

    switch (severity) {
      case 'critical': critical++; break;
      case 'high': high++; break;
      case 'moderate': moderate++; break;
      case 'low': low++; break;
    }

    findings.push(`- [${severity.toUpperCase()}] ${moduleName}: ${title} (patched: ${patchedVersions})`);
    if (overview) findings.push(`  ${overview}`);
    if (recommendation) findings.push(`  ${recommendation}`);
  }

  const vulnerabilitiesMeta = metadata.vulnerabilities as Record<string, unknown> | undefined;
  const totalVulnerabilities = Number(vulnerabilitiesMeta?.total ?? findings.length);
  if (findings.length === 0 && totalVulnerabilities === 0) {
    return { output: result.output, entries: [] };
  }

  const summary = `pnpm audit found ${totalVulnerabilities} vulnerabilities (critical ${critical}, high ${high}, moderate ${moderate}, low ${low}).`;
  const body = [summary, '', ...findings.slice(0, 200)].join('\n');
  const entry = buildScanEntry(
    projectRoot,
    'pnpm-audit',
    `Security audit: ${totalVulnerabilities} vulnerabilities`,
    body,
    summary,
    ['security', 'cve', 'vulnerability', 'audit', 'pnpm'],
    ['package.json']
  );

  return { output: result.output, entries: [entry] };
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

  const findings: string[] = [];
  for (const [name, info] of packages) {
    const pkg = info as Record<string, unknown>;
    const current = String(pkg.current ?? '?');
    const latest = String(pkg.latest ?? '?');
    const wanted = String(pkg.wanted ?? latest);
    findings.push(`- ${name}: ${current} → latest ${latest}${wanted !== latest ? ` (wanted ${wanted})` : ''}`);
  }

  const summary = `${packages.length} outdated package(s) tracked by pnpm outdated.`;
  const entry = buildScanEntry(
    projectRoot,
    'pnpm-outdated',
    `Outdated packages: ${packages.length}`,
    [summary, '', ...findings.slice(0, 200)].join('\n'),
    summary,
    ['dependencies', 'outdated', 'versions', 'pnpm'],
    ['package.json']
  );

  return { output: result.output, entries: [entry] };
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

  const byFile = new Map<string, LintFinding[]>();
  for (const finding of findings) {
    const file = finding.file ?? 'unknown';
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push(finding);
  }

  const lines: string[] = [];
  for (const [file, fileFindings] of byFile) {
    lines.push(`- ${file}`);
    for (const finding of fileFindings.slice(0, 20)) {
      lines.push(`  ${finding.severity?.toUpperCase() ?? 'WARN'}:${finding.line ?? '?'} ${finding.rule} — ${finding.message}`);
    }
  }

  const summary = `${command} reported ${findings.length} lint/complexity finding(s) across ${byFile.size} file(s).`;
  const entry = buildScanEntry(
    projectRoot,
    `${command}-lint`,
    `Lint/complexity report: ${findings.length} findings`,
    [summary, '', ...lines.slice(0, 300)].join('\n'),
    summary,
    ['lint', 'complexity', command, 'code-quality'],
    [...byFile.keys()].slice(0, 20)
  );

  return { output: result.output, entries: [entry] };
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

  return { entries, warnings };
}
