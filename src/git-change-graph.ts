import * as path from 'path';
import * as os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { extractSemanticTouch } from './change-semantic.js';
import { buildGraph, type GraphData } from './graph.js';
import {
  getCommitPatchAsync,
  getRangePatchAsync,
  getWorkingTreePatchAsync,
  querySymbolReferencesAtRevision,
  querySymbolReferencesInWorkingTree,
  readGitFileAsync,
  type GitFilePatch,
} from './git.js';
import { bodySimilarity, computeSignatureDelta, extractSymbolSnapshots, type SymbolSignatureDelta, type SymbolSnapshot } from './symbol-signatures.js';

export type GitSemanticChangeMode = 'working_tree' | 'commit' | 'range';
export type SymbolChangeKind = 'added' | 'deleted' | 'modified';

export interface GitSemanticChangeSymbol {
  symbol: string;
  kind: SymbolChangeKind;
  file: string;
  status: GitFilePatch['status'];
  signatureChanged: boolean;
  signatureDelta?: SymbolSignatureDelta;
  probableRenameFrom?: string;
  probableRenameTo?: string;
  probableMoveFromFile?: string;
  renameConfidence?: number;
  moveConfidence?: number;
  noiseTags: string[];
  isNoise: boolean;
  confidence: 'high' | 'medium' | 'low';
  confidenceScore: number;
  evidence: string[];
  callers: string[];
  callees: string[];
  implementations: string[];
  implementedFrom: string[];
  likelyTestCallers: string[];
  stillReferenced: boolean;
  deletionLikelyFalsePositive?: boolean;
  usageDelta?: {
    beforeReferenceCount: number;
    afterReferenceCount: number;
    delta: number;
    beforeFiles: string[];
    afterFiles: string[];
  };
  callerDelta?: {
    mode: 'semantic' | 'inferred';
    beforeCallers: string[];
    afterCallers: string[];
    addedCallers: string[];
    removedCallers: string[];
  };
}

export interface GitSemanticChangeGraphResult {
  mode: GitSemanticChangeMode;
  sourceRef: string;
  targetRef: string;
  changedFiles: number;
  metadata: {
    graphFreshness: {
      status: 'fresh' | 'stale' | 'missing';
      score: number;
      resolvedRatio: number;
    };
    memoryFreshness: {
      status: 'fresh' | 'stale' | 'missing' | 'not_applicable';
      score: number;
      reason?: string;
    };
    fallbackRatio: number;
    unresolvedSymbolRatio: number;
  };
  signals: {
    addedSymbols: number;
    deletedSymbols: number;
    modifiedSymbols: number;
    signatureChangedSymbols: number;
    probableRenames: number;
    probableMoves: number;
    deletedStillReferenced: number;
    testImpactedSymbols: number;
    usageDeltaComputedSymbols: number;
    callerDeltaComputedSymbols: number;
    semanticCallerDeltaComputedSymbols: number;
    inferredCallerDeltaComputedSymbols: number;
    deletionLikelyFalsePositiveSymbols: number;
    noisySymbols: number;
    filteredNoiseSymbols: number;
  };
  topFiles: Array<{ file: string; status: GitFilePatch['status']; changedSymbolCount: number }>;
  symbols: GitSemanticChangeSymbol[];
}

interface BuildGitSemanticChangeGraphOptions {
  mode: GitSemanticChangeMode;
  commitSha?: string;
  baseRef?: string;
  headRef?: string;
  limit?: number;
  includeNoise?: boolean;
}

interface PatchSourceContext {
  mode: GitSemanticChangeMode;
  sourceRef: string;
  targetRef: string;
  patches: GitFilePatch[];
}

interface RevisionGraphs {
  before: GraphData | null;
  after: GraphData | null;
}

interface ClassifiedSymbolChange {
  symbol: string;
  kind: SymbolChangeKind;
  signatureChanged: boolean;
  signatureDelta?: SymbolSignatureDelta;
  probableRenameFrom?: string;
  probableRenameTo?: string;
  probableMoveFromFile?: string;
  renameConfidence?: number;
  moveConfidence?: number;
  noiseTags: string[];
}

const USAGE_DELTA_SYMBOL_CAP = 25;

function buildFileToSymbolsIndex(graph: GraphData | null): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!graph) return map;
  for (const [symbol, file] of Object.entries(graph.symbolFile ?? {})) {
    if (!file) continue;
    if (!map.has(file)) map.set(file, []);
    map.get(file)!.push(symbol);
  }
  return map;
}

function callersFromFiles(
  filePaths: string[],
  fileToSymbols: Map<string, string[]>,
  symbol: string,
  maxCallers = 40
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const file of filePaths) {
    const symbols = fileToSymbols.get(file) ?? [];
    for (const entry of symbols) {
      if (entry === symbol) continue;
      if (seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
      if (out.length >= maxCallers) return out;
    }
  }
  return out;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function computeRenameConfidence(similarity: number, signatureDelta?: SymbolSignatureDelta): number {
  const paramsDelta = (signatureDelta?.paramsAdded.length ?? 0) + (signatureDelta?.paramsRemoved.length ?? 0);
  const signatureCompatible =
    (signatureDelta?.returnTypeChanged ?? false) === false
    && (signatureDelta?.visibilityChanged ?? false) === false
    && (signatureDelta?.asyncChanged ?? false) === false
    && (signatureDelta?.staticChanged ?? false) === false
    && paramsDelta <= 1;
  const score = 0.55 + similarity * 0.35 + (signatureCompatible ? 0.1 : -0.05);
  return clampScore(score);
}

function computeMoveConfidence(status: GitFilePatch['status'], probableMoveFromFile?: string): number | undefined {
  if (status !== 'R' || !probableMoveFromFile) return undefined;
  return 0.92;
}

function isGeneratedLikePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/dist/')
    || normalized.includes('/build/')
    || normalized.includes('/coverage/')
    || normalized.includes('/node_modules/')
    || normalized.includes('/vendor/')
    || normalized.endsWith('.min.js')
    || normalized.endsWith('.generated.ts')
    || normalized.endsWith('.generated.js')
    || normalized.endsWith('.d.ts');
}

function stripImportLikeLines(source: string): string {
  return source
    .split('\n')
    .filter(line => !/^\s*(import\s|export\s+\*\s+from\s|export\s+\{[^}]*\}\s+from\s)/.test(line))
    .join('\n')
    .trim();
}

function detectFileNoiseTags(patch: GitFilePatch, oldSource: string | null, newSource: string | null): string[] {
  const tags: string[] = [];
  if (isGeneratedLikePath(patch.path) || (patch.oldPath && isGeneratedLikePath(patch.oldPath))) {
    tags.push('generated_like');
  }

  if (oldSource && newSource && oldSource !== newSource) {
    const oldBody = stripImportLikeLines(oldSource);
    const newBody = stripImportLikeLines(newSource);
    if (oldBody === newBody) {
      tags.push('import_only');
    }
  }

  return unique(tags);
}

function toConfidenceLabel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.85) return 'high';
  if (score >= 0.65) return 'medium';
  return 'low';
}

function hasGraphContext(symbol: GitSemanticChangeSymbol, graph: GraphData | null): boolean {
  return Boolean(
    graph?.symbolFile?.[symbol.symbol]
    || symbol.callers.length > 0
    || symbol.callees.length > 0
    || symbol.implementations.length > 0
    || symbol.implementedFrom.length > 0
  );
}

function buildFreshnessMetadata(symbols: GitSemanticChangeSymbol[], graph: GraphData | null): GitSemanticChangeGraphResult['metadata'] {
  const total = symbols.length || 1;
  const resolvedCount = graph
    ? symbols.filter(symbol => hasGraphContext(symbol, graph)).length
    : 0;
  const resolvedRatio = resolvedCount / total;

  const graphFreshness: GitSemanticChangeGraphResult['metadata']['graphFreshness'] =
    !graph
      ? { status: 'missing', score: 0, resolvedRatio: 0 }
      : (resolvedRatio >= 0.7
          ? { status: 'fresh', score: 1, resolvedRatio }
          : { status: 'stale', score: clampScore(Math.max(0.2, resolvedRatio)), resolvedRatio });

  const callerComputed = symbols.filter(symbol => Boolean(symbol.callerDelta)).length;
  const fallbackCount = symbols.filter(symbol => symbol.callerDelta?.mode === 'inferred').length;
  const fallbackRatio = callerComputed > 0 ? fallbackCount / callerComputed : 0;

  const unresolvedCount = symbols.filter(symbol => !hasGraphContext(symbol, graph)).length;
  const unresolvedSymbolRatio = unresolvedCount / total;

  return {
    graphFreshness,
    memoryFreshness: {
      status: 'not_applicable',
      score: 1,
      reason: 'git_semantic_change_graph does not use project/document memory indexes directly.',
    },
    fallbackRatio,
    unresolvedSymbolRatio,
  };
}

function applyFreshnessPenalties(
  symbols: GitSemanticChangeSymbol[],
  graph: GraphData | null,
  metadata: GitSemanticChangeGraphResult['metadata']
): GitSemanticChangeSymbol[] {
  const globalPenalty =
    (metadata.graphFreshness.status !== 'fresh' ? 0.06 : 0)
    + (metadata.fallbackRatio >= 0.5 ? 0.06 : 0)
    + (metadata.unresolvedSymbolRatio >= 0.5 ? 0.06 : 0);

  return symbols.map(symbol => {
    const localPenalty =
      (symbol.callerDelta?.mode === 'inferred' ? 0.04 : 0)
      + (!hasGraphContext(symbol, graph) ? 0.04 : 0);

    const nextScore = clampScore(symbol.confidenceScore - globalPenalty - localPenalty);
    const freshnessEvidence = unique([
      ...(metadata.graphFreshness.status !== 'fresh' ? ['stale_graph_context'] : []),
      ...(metadata.fallbackRatio >= 0.5 ? ['fallback_heavy'] : []),
      ...(metadata.unresolvedSymbolRatio >= 0.5 ? ['unresolved_heavy'] : []),
      ...(symbol.callerDelta?.mode === 'inferred' ? ['fallback_mode_used'] : []),
    ]);

    return {
      ...symbol,
      confidenceScore: nextScore,
      confidence: toConfidenceLabel(nextScore),
      evidence: unique([...symbol.evidence, ...freshnessEvidence]),
    };
  });
}

function isTestPath(filePath: string | undefined): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return /(^|\/)(test|tests)\//.test(normalized) || /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(normalized);
}

function mergeAndSort(entries: GitSemanticChangeSymbol[], limit: number): GitSemanticChangeSymbol[] {
  const merged = new Map<string, GitSemanticChangeSymbol>();

  for (const entry of entries) {
    const key = `${entry.file}::${entry.symbol}::${entry.kind}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...entry,
        callers: unique(entry.callers),
        callees: unique(entry.callees),
        implementations: unique(entry.implementations),
        implementedFrom: unique(entry.implementedFrom),
        likelyTestCallers: unique(entry.likelyTestCallers),
      });
      continue;
    }

    existing.callers = unique([...existing.callers, ...entry.callers]);
    existing.callees = unique([...existing.callees, ...entry.callees]);
    existing.implementations = unique([...existing.implementations, ...entry.implementations]);
    existing.implementedFrom = unique([...existing.implementedFrom, ...entry.implementedFrom]);
    existing.likelyTestCallers = unique([...existing.likelyTestCallers, ...entry.likelyTestCallers]);
    existing.noiseTags = unique([...existing.noiseTags, ...entry.noiseTags]);
    existing.isNoise = existing.noiseTags.length > 0;
    existing.stillReferenced = existing.stillReferenced || entry.stillReferenced;
    existing.signatureChanged = existing.signatureChanged || entry.signatureChanged;
    if (!existing.signatureDelta && entry.signatureDelta) existing.signatureDelta = entry.signatureDelta;
    if (!existing.probableRenameFrom && entry.probableRenameFrom) existing.probableRenameFrom = entry.probableRenameFrom;
    if (!existing.probableRenameTo && entry.probableRenameTo) existing.probableRenameTo = entry.probableRenameTo;
    if (!existing.probableMoveFromFile && entry.probableMoveFromFile) existing.probableMoveFromFile = entry.probableMoveFromFile;
    if ((existing.renameConfidence ?? 0) < (entry.renameConfidence ?? 0)) existing.renameConfidence = entry.renameConfidence;
    if ((existing.moveConfidence ?? 0) < (entry.moveConfidence ?? 0)) existing.moveConfidence = entry.moveConfidence;
    if (existing.confidence === 'low' && entry.confidence !== 'low') existing.confidence = entry.confidence;
  }

  return [...merged.values()]
    .sort((left, right) => {
      const leftScore = left.callers.length + left.likelyTestCallers.length + (left.kind === 'deleted' ? 2 : 0) - (left.isNoise ? 3 : 0);
      const rightScore = right.callers.length + right.likelyTestCallers.length + (right.kind === 'deleted' ? 2 : 0) - (right.isNoise ? 3 : 0);
      return rightScore - leftScore || left.file.localeCompare(right.file) || left.symbol.localeCompare(right.symbol);
    })
    .slice(0, limit);
}

function downgradeLikelySignatureEvolution(symbols: GitSemanticChangeSymbol[]): GitSemanticChangeSymbol[] {
  const pairedAddedOrModified = new Set<string>();
  for (const symbol of symbols) {
    if (symbol.kind === 'added' || symbol.kind === 'modified') {
      pairedAddedOrModified.add(`${symbol.file}::${symbol.symbol}`);
    }
  }

  return symbols.map(symbol => {
    if (symbol.kind !== 'deleted' || !symbol.stillReferenced) return symbol;

    const pairedEvolution = pairedAddedOrModified.has(`${symbol.file}::${symbol.symbol}`);
    const renameLike = Boolean(symbol.probableRenameTo)
      || Boolean(symbol.probableRenameFrom)
      || (typeof symbol.renameConfidence === 'number' && symbol.renameConfidence >= 0.72)
      || symbol.evidence.includes('signature_diff');
    const likelyFalsePositive = pairedEvolution || renameLike;
    if (!likelyFalsePositive) return symbol;

    const confidenceScore = clampScore(Math.max(0.35, symbol.confidenceScore - 0.35));
    return {
      ...symbol,
      deletionLikelyFalsePositive: true,
      confidence: toConfidenceLabel(confidenceScore),
      confidenceScore,
      evidence: unique([...symbol.evidence, 'signature_evolution_suspected']),
    };
  });
}

function symbolScope(symbol: string): string {
  if (symbol.includes('::')) return symbol.slice(0, symbol.lastIndexOf('::'));
  if (symbol.includes('.')) return symbol.slice(0, symbol.lastIndexOf('.'));
  return '<global>';
}

function symbolLeaf(symbol: string): string {
  if (symbol.includes('::')) return symbol.slice(symbol.lastIndexOf('::') + 2);
  if (symbol.includes('.')) return symbol.slice(symbol.lastIndexOf('.') + 1);
  return symbol;
}

async function resolvePatchContext(projectRoot: string, options: BuildGitSemanticChangeGraphOptions): Promise<PatchSourceContext> {
  if (options.mode === 'commit') {
    if (!options.commitSha) {
      throw new Error('commitSha is required when mode=commit.');
    }
    return {
      mode: 'commit',
      sourceRef: `${options.commitSha}^`,
      targetRef: options.commitSha,
      patches: await getCommitPatchAsync(projectRoot, options.commitSha),
    };
  }

  if (options.mode === 'range') {
    if (!options.baseRef || !options.headRef) {
      throw new Error('baseRef and headRef are required when mode=range.');
    }
    return {
      mode: 'range',
      sourceRef: options.baseRef,
      targetRef: options.headRef,
      patches: await getRangePatchAsync(projectRoot, options.baseRef, options.headRef),
    };
  }

  return {
    mode: 'working_tree',
    sourceRef: 'HEAD',
    targetRef: 'WORKTREE',
    patches: await getWorkingTreePatchAsync(projectRoot),
  };
}

async function runGitForRevisionGraph(projectRoot: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', '-C', projectRoot, ...args], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git command failed with exit code ${exitCode}`);
  }
}

async function buildGraphAtRevision(projectRoot: string, revision: string): Promise<GraphData | null> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'code-intel-rev-graph-'));
  try {
    await runGitForRevisionGraph(projectRoot, ['worktree', 'add', '--detach', '--quiet', tempDir, revision]);
    return await buildGraph(tempDir);
  } catch {
    return null;
  } finally {
    try {
      await runGitForRevisionGraph(projectRoot, ['worktree', 'remove', '--force', tempDir]);
    } catch {
      // Best-effort cleanup only.
    }
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

async function resolveRevisionGraphs(
  projectRoot: string,
  graph: GraphData | null,
  context: PatchSourceContext
): Promise<RevisionGraphs> {
  if (context.mode === 'working_tree') {
    const before = await buildGraphAtRevision(projectRoot, 'HEAD');
    return { before, after: graph };
  }

  const [before, after] = await Promise.all([
    buildGraphAtRevision(projectRoot, context.sourceRef),
    buildGraphAtRevision(projectRoot, context.targetRef),
  ]);
  return { before, after };
}

async function readTargetFile(projectRoot: string, patch: GitFilePatch, context: PatchSourceContext): Promise<string | null> {
  if (patch.status === 'D') return null;

  if (context.mode === 'working_tree') {
    try {
      return await Bun.file(path.join(projectRoot, patch.path)).text();
    } catch {
      return null;
    }
  }

  return await readGitFileAsync(projectRoot, context.targetRef, patch.path);
}

async function readSourceFile(projectRoot: string, patch: GitFilePatch, context: PatchSourceContext): Promise<string | null> {
  if (patch.status === 'A') return null;
  const sourcePath = patch.oldPath ?? patch.path;
  return await readGitFileAsync(projectRoot, context.sourceRef, sourcePath);
}

function classifyPatchSymbols(
  patch: GitFilePatch,
  oldSymbols: string[],
  newSymbols: string[],
  oldSnapshots: Map<string, SymbolSnapshot>,
  newSnapshots: Map<string, SymbolSnapshot>,
  fileNoiseTags: string[]
): ClassifiedSymbolChange[] {
  const oldSet = new Set(oldSymbols);
  const newSet = new Set(newSymbols);

  const added: ClassifiedSymbolChange[] = [...newSet]
    .filter(symbol => !oldSet.has(symbol))
    .map(symbol => ({ symbol, kind: 'added' as const, signatureChanged: false, noiseTags: [...fileNoiseTags] }));
  const deleted: ClassifiedSymbolChange[] = [...oldSet]
    .filter(symbol => !newSet.has(symbol))
    .map(symbol => ({ symbol, kind: 'deleted' as const, signatureChanged: false, noiseTags: [...fileNoiseTags] }));
  const modified: ClassifiedSymbolChange[] = [...newSet]
    .filter(symbol => oldSet.has(symbol))
    .map(symbol => {
      const oldSnapshot = oldSnapshots.get(symbol);
      const newSnapshot = newSnapshots.get(symbol);
      const signatureChanged = (oldSnapshot?.signature ?? '') !== (newSnapshot?.signature ?? '');
      const similarity = bodySimilarity(oldSnapshot, newSnapshot);
      const formatOnly = !signatureChanged && similarity >= 0.98;

      return {
        symbol,
        kind: 'modified' as const,
        signatureChanged,
        signatureDelta: computeSignatureDelta(oldSnapshot, newSnapshot),
        probableMoveFromFile: patch.status === 'R' && patch.oldPath && patch.oldPath !== patch.path ? patch.oldPath : undefined,
        moveConfidence: computeMoveConfidence(
          patch.status,
          patch.status === 'R' && patch.oldPath && patch.oldPath !== patch.path ? patch.oldPath : undefined
        ),
        noiseTags: unique([...fileNoiseTags, ...(formatOnly ? ['format_only'] : [])]),
      };
    });

  const unmatchedDeleted = [...deleted];
  for (const add of added) {
    const addScope = symbolScope(add.symbol);
    const addLeaf = symbolLeaf(add.symbol);
    const matchIndex = unmatchedDeleted.findIndex(del => {
      const delScope = symbolScope(del.symbol);
      const delLeaf = symbolLeaf(del.symbol);
      return delScope === addScope && delLeaf !== addLeaf;
    });
    if (matchIndex < 0) continue;
    const del = unmatchedDeleted[matchIndex];
    const similarity = bodySimilarity(oldSnapshots.get(del.symbol), newSnapshots.get(add.symbol));
    if (similarity < 0.72) continue;
    add.probableRenameFrom = del.symbol;
    del.probableRenameTo = add.symbol;
    del.signatureChanged = true;
    add.signatureChanged = true;
    const renameDelta = computeSignatureDelta(oldSnapshots.get(del.symbol), newSnapshots.get(add.symbol));
    del.signatureDelta = renameDelta;
    add.signatureDelta = renameDelta;
    const renameConfidence = computeRenameConfidence(similarity, renameDelta);
    add.renameConfidence = renameConfidence;
    del.renameConfidence = renameConfidence;
    unmatchedDeleted.splice(matchIndex, 1);
  }

  if (added.length + deleted.length + modified.length > 0) {
    return [...added, ...deleted, ...modified];
  }

  if (patch.status === 'A') return newSymbols.map(symbol => ({ symbol, kind: 'added' as const, signatureChanged: false, noiseTags: [...fileNoiseTags] }));
  if (patch.status === 'D') return oldSymbols.map(symbol => ({ symbol, kind: 'deleted' as const, signatureChanged: false, noiseTags: [...fileNoiseTags] }));
  return newSymbols.map(symbol => ({
    symbol,
    kind: 'modified' as const,
    signatureChanged: (oldSnapshots.get(symbol)?.signature ?? '') !== (newSnapshots.get(symbol)?.signature ?? ''),
    signatureDelta: computeSignatureDelta(oldSnapshots.get(symbol), newSnapshots.get(symbol)),
    noiseTags: [...fileNoiseTags],
  }));
}

function buildSymbolImpact(graph: GraphData | null, file: string, status: GitFilePatch['status'], change: ClassifiedSymbolChange): GitSemanticChangeSymbol {
  const symbol = change.symbol;
  const callers = unique(graph?.callers?.[symbol] ?? []);
  const callees = unique(graph?.symbols?.[symbol] ?? []);
  const implementations = unique(graph?.implementations?.[symbol] ?? []);
  const implementedFrom = unique(graph?.implementedFrom?.[symbol] ?? []);

  const likelyTestCallers = callers.filter(caller => isTestPath(graph?.symbolFile?.[caller])).slice(0, 10);
  const stillReferenced = callers.length > 0;
  const confidence: 'high' | 'medium' | 'low' =
    change.kind === 'deleted' && stillReferenced
      ? 'high'
      : (callers.length + callees.length + likelyTestCallers.length > 0 ? 'medium' : 'low');

  const evidence = unique([
    ...(change.signatureChanged ? ['signature_diff'] : []),
    ...(change.probableRenameFrom || change.probableRenameTo ? ['rename_match'] : []),
    ...(typeof change.renameConfidence === 'number' && change.renameConfidence >= 0.85 ? ['rename_similarity_high'] : []),
    ...(typeof change.renameConfidence === 'number' && change.renameConfidence < 0.85 ? ['rename_similarity_medium'] : []),
    ...(change.probableMoveFromFile ? ['move_detected'] : []),
    ...(typeof change.moveConfidence === 'number' ? ['move_confident'] : []),
    ...(change.noiseTags.length > 0 ? [`noise_${change.noiseTags.join('+')}`] : []),
    ...(change.kind === 'deleted' && stillReferenced ? ['deleted_still_referenced'] : []),
    ...(callers.length > 0 ? ['graph_callers_present'] : []),
    ...(callees.length > 0 ? ['graph_callees_present'] : []),
    ...(likelyTestCallers.length > 0 ? ['test_callers_present'] : []),
  ]);

  return {
    symbol,
    kind: change.kind,
    file,
    status,
    signatureChanged: change.signatureChanged,
    signatureDelta: change.signatureDelta,
    probableRenameFrom: change.probableRenameFrom,
    probableRenameTo: change.probableRenameTo,
    probableMoveFromFile: change.probableMoveFromFile,
    renameConfidence: change.renameConfidence,
    moveConfidence: change.moveConfidence,
    noiseTags: unique(change.noiseTags),
    isNoise: change.noiseTags.length > 0,
    confidence,
    confidenceScore: confidence === 'high' ? 0.9 : confidence === 'medium' ? 0.7 : 0.5,
    evidence: evidence.length > 0 ? evidence : ['baseline_change_detected'],
    callers: callers.slice(0, 20),
    callees: callees.slice(0, 20),
    implementations: implementations.slice(0, 20),
    implementedFrom: implementedFrom.slice(0, 20),
    likelyTestCallers,
    stillReferenced: change.kind === 'deleted' ? stillReferenced : false,
  };
}

async function enrichUsageDelta(
  projectRoot: string,
  context: PatchSourceContext,
  symbol: GitSemanticChangeSymbol,
  fileToSymbols: Map<string, string[]>,
  revisionGraphs: RevisionGraphs,
  maxMatches = 40
): Promise<GitSemanticChangeSymbol> {
  const [beforeStats, afterStats] = context.mode === 'working_tree'
    ? await Promise.all([
      querySymbolReferencesAtRevision(projectRoot, 'HEAD', symbol.symbol, maxMatches),
      querySymbolReferencesInWorkingTree(projectRoot, symbol.symbol, maxMatches),
    ])
    : await Promise.all([
      querySymbolReferencesAtRevision(projectRoot, context.sourceRef, symbol.symbol, maxMatches),
      querySymbolReferencesAtRevision(projectRoot, context.targetRef, symbol.symbol, maxMatches),
    ]);

  const afterReferenced = afterStats.count > 0;
  const semanticBeforeCallers = unique(revisionGraphs.before?.callers?.[symbol.symbol] ?? []);
  const semanticAfterCallers = unique(revisionGraphs.after?.callers?.[symbol.symbol] ?? []);
  const callerDeltaMode: 'semantic' | 'inferred' =
    revisionGraphs.before && revisionGraphs.after ? 'semantic' : 'inferred';

  const inferredBeforeCallers = callersFromFiles(beforeStats.files, fileToSymbols, symbol.symbol);
  const inferredAfterCallers = callersFromFiles(afterStats.files, fileToSymbols, symbol.symbol);

  const beforeCallers = callerDeltaMode === 'semantic' ? semanticBeforeCallers : inferredBeforeCallers;
  const afterCallers = callerDeltaMode === 'semantic' ? semanticAfterCallers : inferredAfterCallers;
  const beforeSet = new Set(beforeCallers);
  const afterSet = new Set(afterCallers);
  const addedCallers = afterCallers.filter(caller => !beforeSet.has(caller)).slice(0, 30);
  const removedCallers = beforeCallers.filter(caller => !afterSet.has(caller)).slice(0, 30);

  const baseEvidence = [...symbol.evidence];
  const usageEvidence = [
    'reference_delta_present',
    ...(addedCallers.length > 0 || removedCallers.length > 0 ? ['caller_delta_present'] : []),
    ...(callerDeltaMode === 'semantic' ? ['caller_delta_semantic'] : ['caller_delta_inferred']),
    ...(symbol.kind === 'deleted' && afterReferenced ? ['deleted_still_referenced'] : []),
  ];

  const confidenceScore = Math.max(0, Math.min(1,
    symbol.confidenceScore
      + (Math.abs(afterStats.count - beforeStats.count) > 0 ? 0.05 : 0)
      + ((addedCallers.length + removedCallers.length) > 0 ? 0.05 : 0)
      + ((symbol.kind === 'deleted' && afterReferenced) ? 0.05 : 0)
  ));

  const confidence: 'high' | 'medium' | 'low' =
    confidenceScore >= 0.85 ? 'high' : confidenceScore >= 0.65 ? 'medium' : 'low';

  return {
    ...symbol,
    confidence,
    confidenceScore,
    evidence: unique([...baseEvidence, ...usageEvidence]),
    stillReferenced: symbol.kind === 'deleted' ? afterReferenced : symbol.stillReferenced,
    usageDelta: {
      beforeReferenceCount: beforeStats.count,
      afterReferenceCount: afterStats.count,
      delta: afterStats.count - beforeStats.count,
      beforeFiles: beforeStats.files,
      afterFiles: afterStats.files,
    },
    callerDelta: {
      mode: callerDeltaMode,
      beforeCallers,
      afterCallers,
      addedCallers,
      removedCallers,
    },
  };
}

export async function buildGitSemanticChangeGraph(
  projectRoot: string,
  graph: GraphData | null,
  options: BuildGitSemanticChangeGraphOptions
): Promise<GitSemanticChangeGraphResult> {
  const limit = Math.min(200, Math.max(10, options.limit ?? 80));
  const includeNoise = options.includeNoise ?? false;
  const context = await resolvePatchContext(projectRoot, options);
  const fileToSymbols = buildFileToSymbolsIndex(graph);
  const revisionGraphs = await resolveRevisionGraphs(projectRoot, graph, context);

  const symbolEntries: GitSemanticChangeSymbol[] = [];
  const fileSymbolCount = new Map<string, { status: GitFilePatch['status']; count: number }>();

  for (const patch of context.patches) {
    const [oldSource, newSource] = await Promise.all([
      readSourceFile(projectRoot, patch, context),
      readTargetFile(projectRoot, patch, context),
    ]);

    const oldTouch = extractSemanticTouch(
      { ...patch, path: patch.oldPath ?? patch.path },
      oldSource,
      'old'
    );
    const newTouch = extractSemanticTouch(patch, newSource, 'new');
    const oldSnapshots = extractSymbolSnapshots(patch.oldPath ?? patch.path, oldSource);
    const newSnapshots = extractSymbolSnapshots(patch.path, newSource);
    const fileNoiseTags = detectFileNoiseTags(patch, oldSource, newSource);

    const changes = classifyPatchSymbols(patch, oldTouch.symbols, newTouch.symbols, oldSnapshots, newSnapshots, fileNoiseTags);
    if (changes.length === 0) continue;

    fileSymbolCount.set(patch.path, {
      status: patch.status,
      count: (fileSymbolCount.get(patch.path)?.count ?? 0) + changes.length,
    });

    for (const change of changes) {
      symbolEntries.push(buildSymbolImpact(graph, patch.path, patch.status, change));
    }
  }

  let symbols = mergeAndSort(symbolEntries, limit);
  const noisySymbols = symbols.filter(symbol => symbol.isNoise).length;
  const filteredNoiseSymbols = includeNoise ? 0 : noisySymbols;
  if (!includeNoise) {
    symbols = symbols.filter(symbol => !symbol.isNoise);
  }
  const usageDeltaCap = Math.min(symbols.length, USAGE_DELTA_SYMBOL_CAP);
  if (usageDeltaCap > 0) {
    const enriched = await Promise.all(symbols.slice(0, usageDeltaCap).map(symbol =>
      enrichUsageDelta(projectRoot, context, symbol, fileToSymbols, revisionGraphs)
    ));
    symbols = [...enriched, ...symbols.slice(usageDeltaCap)];
  }

  const metadata = buildFreshnessMetadata(symbols, graph);
  symbols = applyFreshnessPenalties(symbols, graph, metadata);
  symbols = downgradeLikelySignatureEvolution(symbols);

  const addedSymbols = symbols.filter(symbol => symbol.kind === 'added').length;
  const deletedSymbols = symbols.filter(symbol => symbol.kind === 'deleted').length;
  const modifiedSymbols = symbols.filter(symbol => symbol.kind === 'modified').length;
  const signatureChangedSymbols = symbols.filter(symbol => symbol.signatureChanged).length;
  const probableRenames = symbols.filter(symbol => Boolean(symbol.probableRenameFrom || symbol.probableRenameTo)).length;
  const probableMoves = symbols.filter(symbol => Boolean(symbol.probableMoveFromFile)).length;
  const deletedStillReferenced = symbols.filter(symbol => symbol.kind === 'deleted' && symbol.stillReferenced).length;
  const testImpactedSymbols = symbols.filter(symbol => symbol.likelyTestCallers.length > 0).length;
  const usageDeltaComputedSymbols = symbols.filter(symbol => Boolean(symbol.usageDelta)).length;
  const callerDeltaComputedSymbols = symbols.filter(symbol => Boolean(symbol.callerDelta)).length;
  const semanticCallerDeltaComputedSymbols = symbols.filter(symbol => symbol.callerDelta?.mode === 'semantic').length;
  const inferredCallerDeltaComputedSymbols = symbols.filter(symbol => symbol.callerDelta?.mode === 'inferred').length;
  const deletionLikelyFalsePositiveSymbols = symbols.filter(symbol => symbol.deletionLikelyFalsePositive).length;

  const topFiles = [...fileSymbolCount.entries()]
    .map(([file, summary]) => ({ file, status: summary.status, changedSymbolCount: summary.count }))
    .sort((left, right) => right.changedSymbolCount - left.changedSymbolCount || left.file.localeCompare(right.file))
    .slice(0, 20);

  return {
    mode: context.mode,
    sourceRef: context.sourceRef,
    targetRef: context.targetRef,
    changedFiles: context.patches.length,
    metadata,
    signals: {
      addedSymbols,
      deletedSymbols,
      modifiedSymbols,
      signatureChangedSymbols,
      probableRenames,
      probableMoves,
      deletedStillReferenced,
      testImpactedSymbols,
      usageDeltaComputedSymbols,
      callerDeltaComputedSymbols,
      semanticCallerDeltaComputedSymbols,
      inferredCallerDeltaComputedSymbols,
      deletionLikelyFalsePositiveSymbols,
      noisySymbols,
      filteredNoiseSymbols,
    },
    topFiles,
    symbols,
  };
}
