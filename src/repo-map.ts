/**
 * Repo map: aider-style compact codebase representation.
 *
 * Generates a token-efficient overview of the codebase showing file→symbol→signature
 * hierarchy. Uses PageRank-style ranking on the call graph to surface the most
 * important symbols, and optionally focuses on symbols most relevant to a set of seeds.
 */
import { Project, SyntaxKind, Node } from 'ts-morph';
import * as path from 'path';
import * as fs from 'node:fs/promises';
import { loadGraphAsync, type GraphData } from './graph.js';
import { getDataDir } from './git.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RepoMapSymbol {
  name: string;
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'variable' | 'export';
  signature: string;
  line: number;
  rank: number;
}

export interface RepoMapEntry {
  file: string;
  symbols: RepoMapSymbol[];
  fileRank: number;
}

export interface RepoMapOptions {
  /**
   * Seed symbols or file paths to focus the map on.
   * When provided, symbols are ranked by relevance to the seeds.
   */
  seeds?: string[];
  /**
   * Maximum number of lines in the output (default: 1000).
   * Symbols are dropped (lowest rank first) until the limit is met.
   */
  maxLines?: number;
  /**
   * Number of PageRank iterations (default: 20).
   */
  rankIterations?: number;
  /**
   * Whether to include methods inside classes (default: true).
   */
  includeMethods?: boolean;
}

export interface RepoMapResult {
  entries: RepoMapEntry[];
  totalFiles: number;
  totalSymbols: number;
  renderedLines: number;
}

// ─── Signature extraction ─────────────────────────────────────────────────────

const tsProject = new Project({
  skipAddingFilesFromTsConfig: true,
  useInMemoryFileSystem: true,
  compilerOptions: { allowJs: true },
});

const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const SRC_EXTS = new Set([...TS_EXTS, '.py', '.go', '.java', '.rb', '.php', '.cs', '.cpp', '.c', '.rs']);

function collapseType(typeText: string): string {
  return typeText.replace(/\s+/g, ' ').trim();
}

// ─── Import graph resolution ───────────────────────────────────────────────────

const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
const INDEX_FILES = RESOLVE_EXTS.map(e => `/index${e}`);

function resolveImportSpecifier(
  fromFile: string,
  specifier: string,
  knownFiles: Set<string>,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const dir = path.posix.dirname(fromFile);
  const resolved = path.posix.normalize(path.posix.join(dir, specifier));
  if (knownFiles.has(resolved)) return resolved;
  for (const ext of RESOLVE_EXTS) {
    const candidate = resolved + ext;
    if (knownFiles.has(candidate)) return candidate;
  }
  for (const idx of INDEX_FILES) {
    const candidate = resolved + idx;
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

function buildFileImportGraph(graph: GraphData): Map<string, string[]> {
  const knownFiles = new Set(Object.keys(graph.files));
  const fileImports = new Map<string, string[]>();
  for (const filePath of Object.keys(graph.files)) {
    const resolved: string[] = [];
    // Prefer pre-resolved cross-package/workspace imports from the graph.
    const preResolved = graph.resolvedImports?.[filePath];
    if (preResolved) {
      for (const target of preResolved) {
        if (target !== filePath) resolved.push(target);
      }
    } else {
      for (const spec of graph.files[filePath] ?? []) {
        const target = resolveImportSpecifier(filePath, spec, knownFiles);
        if (target && target !== filePath) resolved.push(target);
      }
    }
    if (resolved.length > 0) fileImports.set(filePath, resolved);
  }
  return fileImports;
}

function bfsFileRelevance(
  seedFiles: Set<string>,
  importGraph: Map<string, string[]>,
): Map<string, number> {
  const relevance = new Map<string, number>();
  const queue: Array<{ file: string; depth: number }> = [];
  const visited = new Set<string>();

  for (const seed of seedFiles) {
    queue.push({ file: seed, depth: 0 });
  }

  for (let i = 0; i < queue.length; i++) {
    const { file, depth } = queue[i];
    if (visited.has(file)) continue;
    visited.add(file);
    relevance.set(file, 1 / (1 + depth));

    for (const imported of importGraph.get(file) ?? []) {
      if (!visited.has(imported)) {
        queue.push({ file: imported, depth: depth + 1 });
      }
    }
  }

  return relevance;
}

function extractTsSymbols(filePath: string, source: string, includeMethods: boolean): RepoMapSymbol[] {
  const symbols: RepoMapSymbol[] = [];
  let sf;
  try {
    sf = tsProject.createSourceFile(filePath, source, { overwrite: true });
  } catch {
    return symbols;
  }

  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    const params = fn.getParameters().map(p => {
      const name = collapseType(p.getName());
      const type = collapseType(p.getTypeNode()?.getText() ?? '');
      return type ? `${name}: ${type}` : name;
    }).join(', ');
    const ret = collapseType(fn.getReturnTypeNode()?.getText() ?? '');
    const asyncKw = fn.isAsync() ? 'async ' : '';
    symbols.push({
      name,
      kind: 'function',
      signature: `${asyncKw}function ${name}(${params})${ret ? `: ${ret}` : ''}`,
      line: fn.getStartLineNumber(),
      rank: 0,
    });
  }

  for (const cls of sf.getClasses()) {
    const name = cls.getName();
    if (!name) continue;
    const ext = collapseType(cls.getExtends()?.getExpression().getText() ?? '');
    const impls = cls.getImplements().map(i => collapseType(i.getExpression().getText())).join(', ');
    let sig = `class ${name}`;
    if (ext) sig += ` extends ${ext}`;
    if (impls) sig += ` implements ${impls}`;
    symbols.push({ name, kind: 'class', signature: sig, line: cls.getStartLineNumber(), rank: 0 });

    if (includeMethods) {
      for (const method of cls.getMethods()) {
        const mname = method.getName();
        const params = method.getParameters().map(p => {
          const name = collapseType(p.getName());
          const type = collapseType(p.getTypeNode()?.getText() ?? '');
          return type ? `${name}: ${type}` : name;
        }).join(', ');
        const ret = collapseType(method.getReturnTypeNode()?.getText() ?? '');
        const mods: string[] = [];
        if (method.isStatic()) mods.push('static');
        if (method.isAsync()) mods.push('async');
        if (method.hasModifier(SyntaxKind.PrivateKeyword)) mods.push('private');
        else if (method.hasModifier(SyntaxKind.ProtectedKeyword)) mods.push('protected');
        const modStr = mods.length ? mods.join(' ') + ' ' : '';
        symbols.push({
          name: `${name}.${mname}`,
          kind: 'method',
          signature: `  ${modStr}${mname}(${params})${ret ? `: ${ret}` : ''}`,
          line: method.getStartLineNumber(),
          rank: 0,
        });
      }
    }
  }

  for (const iface of sf.getInterfaces()) {
    const name = iface.getName();
    const ext = iface.getExtends().map(e => collapseType(e.getExpression().getText())).join(', ');
    let sig = `interface ${name}`;
    if (ext) sig += ` extends ${ext}`;
    symbols.push({ name, kind: 'interface', signature: sig, line: iface.getStartLineNumber(), rank: 0 });
  }

  for (const td of sf.getTypeAliases()) {
    const name = td.getName();
    const typeText = collapseType(td.getTypeNode()?.getText() ?? '');
    const preview = typeText.length > 80 ? typeText.slice(0, 77) + '...' : typeText;
    symbols.push({ name, kind: 'type', signature: `type ${name} = ${preview}`, line: td.getStartLineNumber(), rank: 0 });
  }

  // Top-level arrow functions and variable declarations exported
  for (const vd of sf.getVariableDeclarations()) {
    const name = vd.getName();
    if (!name) continue;
    const init = vd.getInitializer();
    if (
      init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
      && symbols.some(s => s.name === name)
    ) continue;
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      const fn = init as import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression;
      const params = fn.getParameters().map(p => {
        const name = collapseType(p.getName());
        const type = collapseType(p.getTypeNode()?.getText() ?? '');
        return type ? `${name}: ${type}` : name;
      }).join(', ');
      const ret = collapseType(fn.getReturnTypeNode()?.getText() ?? '');
      const asyncKw = fn.isAsync() ? 'async ' : '';
      symbols.push({
        name,
        kind: 'function',
        signature: `${asyncKw}const ${name} = (${params})${ret ? `: ${ret}` : ''} =>`,
        line: vd.getStartLineNumber(),
        rank: 0,
      });
    }
  }

  try { tsProject.removeSourceFile(sf); } catch { /* ignore */ }
  return symbols;
}

async function extractPlainSymbols(filePath: string, source?: string): Promise<RepoMapSymbol[]> {
  const ext = path.extname(filePath).toLowerCase();
  if (!SRC_EXTS.has(ext)) return [];

  if (!source) {
    try {
      source = await fs.readFile(filePath, 'utf8');
    } catch {
      return [];
    }
  }

  // For non-TS files, extract via simple regex patterns
  const symbols: RepoMapSymbol[] = [];
  const lines = source.split('\n');

  const patterns: Array<{ regex: RegExp; kind: RepoMapSymbol['kind'] }> = [
    { regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/, kind: 'function' },
    { regex: /^(?:export\s+)?class\s+(\w+)/, kind: 'class' },
    { regex: /^(?:export\s+)?interface\s+(\w+)/, kind: 'interface' },
    { regex: /^(?:export\s+)?type\s+(\w+)\s*=/, kind: 'type' },
    { regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/, kind: 'function' },
    // Python
    { regex: /^def\s+(\w+)\s*\(/, kind: 'function' },
    { regex: /^class\s+(\w+)/, kind: 'class' },
    // Go
    { regex: /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/, kind: 'function' },
    // Java/C#
    { regex: /^\s*(?:public|private|protected|static|abstract|override).*(?:void|int|string|bool|String|boolean)\s+(\w+)\s*\(/, kind: 'function' },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { regex, kind } of patterns) {
      const m = regex.exec(line);
      if (m?.[1] && !symbols.some(s => s.name === m[1])) {
        symbols.push({
          name: m[1],
          kind,
          signature: line.trim().slice(0, 120),
          line: i + 1,
          rank: 0,
        });
        break;
      }
    }
  }

  return symbols;
}

async function extractFileSymbols(
  filePath: string,
  includeMethods: boolean,
): Promise<RepoMapSymbol[]> {
  const ext = path.extname(filePath).toLowerCase();
  if (!SRC_EXTS.has(ext)) return [];

  let source: string;
  try {
    source = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  if (TS_EXTS.has(ext)) {
    return extractTsSymbols(filePath, source, includeMethods);
  }
  return extractPlainSymbols(filePath, source);
}

// ─── PageRank ──────────────────────────────────────────────────────────────────

function computePageRank(
  graph: GraphData,
  seeds: string[],
  iterations: number,
): Map<string, number> {
  const allSymbols = Object.keys(graph.symbols);
  if (allSymbols.length === 0) return new Map();

  const n = allSymbols.length;
  const symIndex = new Map<string, number>(allSymbols.map((s, i) => [s, i]));
  const ranks = new Float64Array(n).fill(1 / n);
  const damping = 0.85;

  // Boost seed symbols and their neighbours
  const seedSet = new Set(seeds);
  if (seedSet.size > 0) {
    const boostTotal = Math.min(seedSet.size * 2, n);
    const boost = 1 / boostTotal;
    for (const seed of seedSet) {
      const idx = symIndex.get(seed);
      if (idx !== undefined) ranks[idx] = boost;
      // also boost direct callees and callers of seed
      for (const callee of graph.symbols[seed] ?? []) {
        const ci = symIndex.get(callee);
        if (ci !== undefined) ranks[ci] = Math.max(ranks[ci], boost * 0.5);
      }
      for (const caller of graph.callers?.[seed] ?? []) {
        const ci = symIndex.get(caller);
        if (ci !== undefined) ranks[ci] = Math.max(ranks[ci], boost * 0.5);
      }
    }
  }

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Float64Array(n).fill((1 - damping) / n);
    for (const [sym, idx] of symIndex) {
      const callees = graph.symbols[sym] ?? [];
      if (callees.length === 0) continue;
      const share = (damping * ranks[idx]) / callees.length;
      for (const callee of callees) {
        const ci = symIndex.get(callee);
        if (ci !== undefined) next[ci] += share;
      }
    }
    ranks.set(next);
  }

  const result = new Map<string, number>();
  for (const [sym, idx] of symIndex) {
    result.set(sym, ranks[idx]);
  }
  return result;
}

// ─── Core repo-map builder ────────────────────────────────────────────────────

export async function buildRepoMap(
  projectRoot: string,
  options: RepoMapOptions = {},
): Promise<RepoMapResult> {
  const {
    seeds = [],
    maxLines = 1000,
    rankIterations = 20,
    includeMethods = true,
  } = options;

  const graphPath = path.join(getDataDir(projectRoot), 'graph.json');
  const graph = await loadGraphAsync(graphPath);

  // Resolve seeds: symbol names and their containing files
  const resolvedSeedSymbols: string[] = [];
  const seedFiles = new Set<string>();
  for (const seed of seeds) {
    const isFilePath = seed.includes('/') || SRC_EXTS.has(path.extname(seed).toLowerCase());
    if (isFilePath) {
      const rel = path.isAbsolute(seed) ? path.relative(projectRoot, seed) : seed;
      seedFiles.add(rel);
      for (const [sym, filePath] of Object.entries(graph?.symbolFile ?? {})) {
        if (filePath === rel || filePath.startsWith(rel)) resolvedSeedSymbols.push(sym);
      }
    } else {
      resolvedSeedSymbols.push(seed);
      const symFile = graph?.symbolFile?.[seed];
      if (symFile) seedFiles.add(symFile);
    }
  }

  // Compute per-symbol PageRank for within-file ordering
  const rankMap = graph
    ? computePageRank(graph, resolvedSeedSymbols, rankIterations)
    : new Map<string, number>();

  // Build per-file symbol lists
  const fileSymbolMap = new Map<string, Map<string, number>>();
  if (graph) {
    for (const [sym, filePath] of Object.entries(graph.symbolFile)) {
      if (!fileSymbolMap.has(filePath)) fileSymbolMap.set(filePath, new Map());
      fileSymbolMap.get(filePath)!.set(sym, rankMap.get(sym) ?? 0);
    }
    for (const filePath of Object.keys(graph.files)) {
      if (!fileSymbolMap.has(filePath)) fileSymbolMap.set(filePath, new Map());
    }
  }

  // BFS from seed files through the import graph for relevance scoring
  const hasSeeds = seedFiles.size > 0;
  let fileRelevance: Map<string, number>;
  let candidateFiles: string[];

  if (hasSeeds && graph) {
    const importGraph = buildFileImportGraph(graph);
    fileRelevance = bfsFileRelevance(seedFiles, importGraph);
    candidateFiles = [...fileSymbolMap.keys()].filter(f => fileRelevance.has(f));
    for (const seed of seedFiles) {
      if (!candidateFiles.includes(seed) && fileSymbolMap.has(seed)) {
        candidateFiles.push(seed);
        fileRelevance.set(seed, 1);
      }
    }
  } else {
    fileRelevance = new Map();
    candidateFiles = [...fileSymbolMap.keys()];
    for (const f of candidateFiles) fileRelevance.set(f, 0);
  }

  // Compute file-level rank from top-5 symbol PageRanks
  const fileRanks = new Map<string, number>();
  for (const filePath of candidateFiles) {
    const syms = fileSymbolMap.get(filePath);
    if (!syms) { fileRanks.set(filePath, 0); continue; }
    const sorted = [...syms.values()].sort((a, b) => b - a);
    const top5 = sorted.slice(0, 5);
    fileRanks.set(filePath, top5.length > 0 ? top5.reduce((a, b) => a + b, 0) / top5.length : 0);
  }

  // Sort files: BFS relevance (desc), then symbol PageRank (desc), then alphabetically
  const sortedFiles = candidateFiles.sort((a, b) => {
    const relDiff = (fileRelevance.get(b) ?? 0) - (fileRelevance.get(a) ?? 0);
    if (relDiff !== 0) return relDiff;
    const rankDiff = (fileRanks.get(b) ?? 0) - (fileRanks.get(a) ?? 0);
    if (rankDiff !== 0) return rankDiff;
    return a.localeCompare(b);
  });

  // Extract symbol signatures from source files
  const entries: RepoMapEntry[] = [];

  for (const relFile of sortedFiles) {
    const absFile = path.join(projectRoot, relFile);
    const rawSymbols = await extractFileSymbols(absFile, includeMethods);
    if (rawSymbols.length === 0) continue;

    const symRankMap = fileSymbolMap.get(relFile) ?? new Map<string, number>();

    const ranked: RepoMapSymbol[] = rawSymbols.map(sym => {
      const rank = symRankMap.get(sym.name)
        ?? (sym.name.includes('.') ? symRankMap.get(sym.name.split('.').pop()!) : undefined)
        ?? 0;
      return { ...sym, rank };
    });

    ranked.sort((a, b) => b.rank - a.rank || a.line - b.line);

    const fileRank = fileRanks.get(relFile) ?? 0;
    entries.push({ file: relFile, symbols: ranked, fileRank });
  }

  const trimmed = trimToMaxLines(entries, maxLines);

  const trimmedSymbols = trimmed.reduce((sum, e) => sum + e.symbols.length, 0);

  return {
    entries: trimmed,
    totalFiles: trimmed.length,
    totalSymbols: trimmedSymbols,
    renderedLines: trimmed.reduce((sum, e) => sum + 1 + e.symbols.length, 0),
  };
}

function trimToMaxLines(entries: RepoMapEntry[], maxLines: number): RepoMapEntry[] {
  // Count lines: 1 header line + 1 per symbol
  let lineCount = 0;
  const result: RepoMapEntry[] = [];

  for (const entry of entries) {
    if (lineCount >= maxLines) break;
    const remaining = maxLines - lineCount - 1; // -1 for the file header
    if (remaining <= 0) break;
    const syms = entry.symbols.slice(0, remaining);
    result.push({ ...entry, symbols: syms });
    lineCount += 1 + syms.length;
  }

  return result;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

export function renderRepoMap(result: RepoMapResult, projectRoot?: string): string {
  if (result.entries.length === 0) {
    return 'No indexed files found. Run `code-intel index .` first.';
  }

  const lines: string[] = [];
  lines.push(`Repo map: ${result.totalFiles} files, ${result.totalSymbols} symbols`);
  lines.push('');

  for (const entry of result.entries) {
    lines.push(entry.file + ':');
    for (const sym of entry.symbols) {
      lines.push(`\t${sym.signature}`);
    }
  }

  return lines.join('\n');
}
