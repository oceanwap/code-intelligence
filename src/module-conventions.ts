/**
 * module-conventions.ts
 *
 * Per-module style guide extractor: tells an agent "how does this module do
 * things?" before it writes new code for that module.
 *
 * Analyses the indexed call graph and code chunks to surface:
 *   - Dominant function naming prefix patterns (get*, build*, load*, *Async …)
 *   - Async convention (all-async, mixed, sync-dominant)
 *   - Error handling style (throw vs null-return vs result-object)
 *   - Return type patterns (typed interfaces, primitives, void)
 *   - Export style (named vs default)
 */

import * as path from 'path';
import { loadGraphAsync } from './graph.js';
import { getDataDir } from './git.js';
import { moduleFromFile } from './utils/module-path.js';
import { queryProject } from './indexer-run.js';

export interface ModuleConventions {
  module: string;
  symbolCount: number;
  fileCount: number;
  /** Most common function-name prefix(es), e.g. ["build", "load"] */
  dominantPrefixes: string[];
  /** Whether async is the dominant style */
  asyncConvention: 'all-async' | 'mostly-async' | 'mixed' | 'mostly-sync' | 'unknown';
  /** Observed error handling pattern */
  errorHandling: 'throws' | 'null-return' | 'result-object' | 'mixed' | 'unknown';
  /** Whether exports are primarily named */
  exportStyle: 'named' | 'default' | 'mixed' | 'unknown';
  /** Example symbol names from the module */
  exampleSymbols: string[];
  /** Plain-language conventions summary for the agent */
  summary: string;
}

// ── Naming analysis ───────────────────────────────────────────────────────────

const PREFIX_LIST = [
  'get', 'set', 'build', 'load', 'fetch', 'create', 'make', 'find',
  'update', 'delete', 'remove', 'handle', 'parse', 'render', 'format',
  'validate', 'check', 'sync', 'refresh', 'compute', 'derive', 'resolve',
  'assemble', 'extract', 'detect',
];

function extractPrefix(name: string): string | null {
  for (const p of PREFIX_LIST) {
    if (name.startsWith(p) && name.length > p.length) {
      const next = name[p.length];
      if (next && next === next.toUpperCase()) return p;
    }
  }
  return null;
}

function topPrefixes(symbols: string[], minCount = 2): string[] {
  const counts = new Map<string, number>();
  for (const s of symbols) {
    const p = extractPrefix(s);
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([p]) => p);
}

function asyncConvention(symbols: string[]): ModuleConventions['asyncConvention'] {
  if (symbols.length === 0) return 'unknown';
  const asyncCount = symbols.filter(s => s.endsWith('Async')).length;
  const ratio = asyncCount / symbols.length;
  if (ratio >= 0.85) return 'all-async';
  if (ratio >= 0.55) return 'mostly-async';
  if (ratio >= 0.25) return 'mixed';
  if (ratio > 0)     return 'mostly-sync';
  return 'mostly-sync';
}

// ── Code pattern analysis (from indexed code text) ───────────────────────────

function detectErrorHandling(codeSnippets: string[]): ModuleConventions['errorHandling'] {
  let throwCount  = 0;
  let nullCount   = 0;
  let resultCount = 0;

  for (const snippet of codeSnippets) {
    if (/\bthrow\s+new\b/.test(snippet))                   throwCount++;
    if (/\breturn\s+null\b|\breturn\s+undefined\b/.test(snippet)) nullCount++;
    if (/\{\s*ok\s*:\s*(true|false)|\{\s*error\s*:/.test(snippet)) resultCount++;
  }

  const total = throwCount + nullCount + resultCount;
  if (total === 0) return 'unknown';

  const dominant = Math.max(throwCount, nullCount, resultCount);
  if (dominant / total < 0.6) return 'mixed';
  if (throwCount === dominant)  return 'throws';
  if (nullCount  === dominant)  return 'null-return';
  return 'result-object';
}

function detectExportStyle(codeSnippets: string[]): ModuleConventions['exportStyle'] {
  let namedCount   = 0;
  let defaultCount = 0;
  for (const snippet of codeSnippets) {
    namedCount   += (snippet.match(/\bexport\s+(?!default\b)/g) ?? []).length;
    defaultCount += (snippet.match(/\bexport\s+default\b/g) ?? []).length;
  }
  if (namedCount === 0 && defaultCount === 0) return 'unknown';
  if (defaultCount === 0) return 'named';
  if (namedCount   === 0) return 'default';
  return namedCount > defaultCount * 2 ? 'named' : 'mixed';
}

function buildSummary(c: ModuleConventions): string {
  const parts: string[] = [];

  if (c.dominantPrefixes.length > 0) {
    parts.push(`Function naming: ${c.dominantPrefixes.map(p => `${p}*()`).join(', ')} dominant`);
  }

  const asyncStr: Record<ModuleConventions['asyncConvention'], string> = {
    'all-async':    'all functions are async',
    'mostly-async': 'async-first (>55%)',
    'mixed':        'async and sync are both common',
    'mostly-sync':  'mostly synchronous',
    'unknown':      'async style unknown',
  };
  parts.push(`Async: ${asyncStr[c.asyncConvention]}`);

  const errStr: Record<ModuleConventions['errorHandling'], string> = {
    'throws':        'errors are thrown (new Error)',
    'null-return':   'errors return null/undefined',
    'result-object': 'errors use result objects { ok, error }',
    'mixed':         'mixed error handling',
    'unknown':       'error handling style unclear',
  };
  parts.push(`Errors: ${errStr[c.errorHandling]}`);

  const expStr: Record<ModuleConventions['exportStyle'], string> = {
    'named':   'named exports only',
    'default': 'default exports',
    'mixed':   'mixed named/default',
    'unknown': 'export style unclear',
  };
  parts.push(`Exports: ${expStr[c.exportStyle]}`);

  return parts.join(' | ');
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function getModuleConventions(
  projectRoot: string,
  moduleName: string,
  qdrantUrl = 'http://localhost:6333',
): Promise<ModuleConventions | null> {
  const root = path.resolve(projectRoot);
  const graphPath = path.join(getDataDir(root), 'graph.json');
  const graph = await loadGraphAsync(graphPath);
  if (!graph) return null;

  // 1. Find all symbols/files belonging to the requested module.
  const moduleSymbols: string[] = [];
  const moduleFiles = new Set<string>();

  for (const [symbol, file] of Object.entries(graph.symbolFile)) {
    if (moduleFromFile(file) === moduleName) {
      moduleSymbols.push(symbol);
      moduleFiles.add(file);
    }
  }

  if (moduleSymbols.length === 0) return null;

  // 2. Fetch representative code snippets via semantic search.
  //    Use the module name itself as the query to get its most representative chunks.
  const searchResults = await queryProject(root, moduleName, qdrantUrl);
  const moduleSnippets = searchResults
    .filter(r => moduleFromFile(r.file) === moduleName)
    .slice(0, 12)
    .map(r => r.code ?? '');

  // 3. Analyse patterns.
  const prefixes      = topPrefixes(moduleSymbols);
  const asyncConv     = asyncConvention(moduleSymbols);
  const errorHandling = detectErrorHandling(moduleSnippets);
  const exportStyle   = detectExportStyle(moduleSnippets);

  const exampleSymbols = [...moduleSymbols]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 8);

  const conventions: ModuleConventions = {
    module: moduleName,
    symbolCount: moduleSymbols.length,
    fileCount: moduleFiles.size,
    dominantPrefixes: prefixes,
    asyncConvention: asyncConv,
    errorHandling,
    exportStyle,
    exampleSymbols,
    summary: '',
  };
  conventions.summary = buildSummary(conventions);

  return conventions;
}

export function renderModuleConventions(conventions: ModuleConventions): string {
  return [
    `## Module conventions: ${conventions.module}`,
    '',
    `Symbols: ${conventions.symbolCount}  |  Files: ${conventions.fileCount}`,
    '',
    `**Summary:** ${conventions.summary}`,
    '',
    conventions.dominantPrefixes.length > 0
      ? `**Dominant prefixes:** ${conventions.dominantPrefixes.map(p => `\`${p}*()\``).join(', ')}`
      : '**Dominant prefixes:** none detected',
    `**Async convention:** ${conventions.asyncConvention}`,
    `**Error handling:** ${conventions.errorHandling}`,
    `**Export style:** ${conventions.exportStyle}`,
    '',
    conventions.exampleSymbols.length > 0
      ? `**Example symbols:** ${conventions.exampleSymbols.map(s => `\`${s}\``).join(', ')}`
      : '',
  ].filter(l => l !== undefined).join('\n');
}
