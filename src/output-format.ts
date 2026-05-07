import type { AffectedSymbolsResult, RiskHotspotsResult } from './engineering-insights.js';
import type { FeatureBrief } from './feature-knowledge.js';
import type { RetrievedChunk } from './retriever.js';
import {
  type ProjectMemoryFreshness,
  renderEntrySource,
  type BugMemoryEntry,
  type ChangeMemoryEntry,
  type ProjectMemoryEntry,
  type ProjectMemorySearchHit,
  type WhyChangedResult,
} from './project-memory.js';

export interface QueryResultJson {
  file: string;
  symbol: string;
  type: string;
  code: string;
  location: {
    startLine: number | null;
    endLine: number | null;
  };
  freshness: {
    sliceStartLine: number | null;
    sliceEndLine: number | null;
    indexRefreshedAt: string | null;
    indexedFileMtimeMs: number | null;
    currentFileMtimeMs: number | null;
    latestChange: null | {
      sha: string;
      title: string;
      timestamp: string;
      authorName: string;
      changedLines: Array<{
        startLine: number;
        endLine: number;
      }>;
    };
    needsReindex: boolean;
    reasons: string[];
  };
  graph: {
    calls: { total: number; symbols: string[]; sites: Array<{ symbol: string; file: string; line: number }> };
    usedBy: { total: number; symbols: string[]; sites: Array<{ symbol: string; file: string; line: number }> };
    supertypes: { total: number; symbols: string[] };
    subtypes: { total: number; symbols: string[] };
    implements: { total: number; symbols: string[] };
    implementedBy: { total: number; symbols: string[] };
  };
  connectionsWithinResults: {
    total: number;
    calls: string[];
    usedBy: string[];
    supertypes: string[];
    subtypes: string[];
    implements: string[];
    implementedBy: string[];
  };
  ranking: {
    hybridScore: number;
    semanticScore: number;
    signals: string[];
    breakdown: {
      semantic: number;
      symbolOverlap: number;
      fileOverlap: number;
      directMemory: number;
      neighborSupport: number;
      connectivity: number;
    };
  };
}

export interface QueryProjectResponseJson {
  question: string;
  memory: {
    refreshedAt: string | null;
    indexedHeadSha: string | null;
    currentHeadSha: string | null;
    dirtyFileCount: number;
    dirtyFilesNewerThanMemory: number;
    needsReindex: boolean;
    reasons: string[];
  };
  resultCount: number;
  results: QueryResultJson[];
}

interface MemoryEntryJson {
  id: string;
  kind: ProjectMemoryEntry['kind'];
  title: string;
  summary: string;
  timestamp: string;
  changeType: ProjectMemoryEntry['changeType'];
  topics: string[];
  files: string[];
  symbols: string[];
  source: string;
}

interface ChangeEntryJson extends MemoryEntryJson {
  kind: 'change';
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  impacts: ChangeMemoryEntry['impacts'];
}

interface BugEntryJson extends MemoryEntryJson {
  kind: 'bug';
  fixedBySha: string;
  status: BugMemoryEntry['status'];
  sourceKind: BugMemoryEntry['source'];
  evidenceScore: number;
  symptoms: string[];
  errorSignatures: string[];
  failingTests: string[];
  impacts: BugMemoryEntry['impacts'];
}

interface DocumentEntryJson extends MemoryEntryJson {
  kind: 'document';
  path: string;
  section: string;
  docType: ProjectMemoryEntry extends infer _T ? string : never;
}

export interface FeatureBriefResponseJson {
  feature: string;
  topic: string | null;
  seedSymbols: string[];
  recommendedNextCalls: {
    getSymbols: string[];
    expandGraph: string[];
  };
  docs: Array<{ title: string; source: string; summary: string }>;
  knowledgeHits: Array<{
    score: number;
    entry: ChangeEntryJson | BugEntryJson | DocumentEntryJson;
  }>;
  codeAnchors: Array<{
    symbol: string;
    file: string;
    type: string;
    ranking: {
      hybridScore: number;
      semanticScore: number;
      signals: string[];
    };
  }>;
  recentChanges: ChangeEntryJson[];
  whyChanged: null | {
    target: string;
    mode: WhyChangedResult['mode'];
    totalMatches: number;
    activeTopics: Array<{ topic: string; count: number }>;
    matches: Array<{
      matchedSymbols: string[];
      matchedFiles: string[];
      entry: ChangeEntryJson;
    }>;
  };
  hotspots: null | RiskHotspotsResult;
  impact: null | AffectedSymbolsResult;
}

function emptyBreakdown(): QueryResultJson['ranking']['breakdown'] {
  return {
    semantic: 0,
    symbolOverlap: 0,
    fileOverlap: 0,
    directMemory: 0,
    neighborSupport: 0,
    connectivity: 0,
  };
}

function serializeProjectMemoryEntry(entry: ProjectMemoryEntry): ChangeEntryJson | BugEntryJson | DocumentEntryJson {
  const base = {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    summary: entry.summary,
    timestamp: entry.timestamp,
    changeType: entry.changeType,
    topics: entry.topics,
    files: entry.files,
    symbols: entry.symbols,
    source: renderEntrySource(entry),
  };

  if (entry.kind === 'change') {
    return {
      ...base,
      kind: 'change',
      sha: entry.sha,
      parents: entry.parents,
      authorName: entry.authorName,
      authorEmail: entry.authorEmail,
      impacts: entry.impacts,
    };
  }

  if (entry.kind === 'bug') {
    return {
      ...base,
      kind: 'bug',
      fixedBySha: entry.fixedBySha,
      status: entry.status,
      sourceKind: entry.source,
      evidenceScore: entry.evidenceScore,
      symptoms: entry.symptoms,
      errorSignatures: entry.errorSignatures,
      failingTests: entry.failingTests,
      impacts: entry.impacts,
    };
  }

  return {
    ...base,
    kind: 'document',
    path: entry.path,
    section: entry.section,
    docType: entry.docType,
  };
}

function serializeChangeEntry(entry: ChangeMemoryEntry): ChangeEntryJson {
  return serializeProjectMemoryEntry(entry) as ChangeEntryJson;
}

function serializeKnowledgeHit(hit: ProjectMemorySearchHit): FeatureBriefResponseJson['knowledgeHits'][number] {
  return {
    score: hit.score,
    entry: serializeProjectMemoryEntry(hit.entry),
  };
}

function serializeWhyChanged(result: WhyChangedResult | null): FeatureBriefResponseJson['whyChanged'] {
  if (!result) return null;
  return {
    target: result.target,
    mode: result.mode,
    totalMatches: result.totalMatches,
    activeTopics: result.activeTopics,
    matches: result.matches.map(match => ({
      matchedSymbols: match.matchedSymbols,
      matchedFiles: match.matchedFiles,
      entry: serializeChangeEntry(match.entry),
    })),
  };
}

export function serializeQueryProjectResponse(
  question: string,
  results: RetrievedChunk[],
  freshness?: ProjectMemoryFreshness
): QueryProjectResponseJson {
  return {
    question,
    memory: {
      refreshedAt: freshness?.memoryRefreshedAt ?? null,
      indexedHeadSha: freshness?.indexedHeadSha ?? null,
      currentHeadSha: freshness?.currentHeadSha ?? null,
      dirtyFileCount: freshness?.dirtyFileCount ?? 0,
      dirtyFilesNewerThanMemory: freshness?.dirtyFilesNewerThanMemory ?? 0,
      needsReindex: freshness?.needsReindex ?? false,
      reasons: freshness?.reasons ?? [],
    },
    resultCount: results.length,
    results: results.map(serializeQueryResult),
  };
}

function serializeQueryResult(result: RetrievedChunk): QueryResultJson {
  return {
    file: result.file,
    symbol: result.symbol,
    type: result.type,
    code: result.code,
    location: {
      startLine: result.lineStart ?? null,
      endLine: result.lineEnd ?? null,
    },
    freshness: {
      sliceStartLine: result.freshness?.sliceStartLine ?? result.lineStart ?? null,
      sliceEndLine: result.freshness?.sliceEndLine ?? result.lineEnd ?? null,
      indexRefreshedAt: result.freshness?.indexRefreshedAt ?? null,
      indexedFileMtimeMs: result.freshness?.indexedFileMtimeMs ?? null,
      currentFileMtimeMs: result.freshness?.currentFileMtimeMs ?? null,
      latestChange: result.freshness?.latestChange ?? null,
      needsReindex: result.freshness?.needsReindex ?? false,
      reasons: result.freshness?.reasons ?? [],
    },
    graph: {
      calls: result.graphSummary?.calls ?? { total: 0, symbols: [], sites: [] },
      usedBy: result.graphSummary?.usedBy ?? { total: 0, symbols: [], sites: [] },
      supertypes: result.graphSummary?.supertypes ?? { total: 0, symbols: [] },
      subtypes: result.graphSummary?.subtypes ?? { total: 0, symbols: [] },
      implements: result.graphSummary?.implements ?? { total: 0, symbols: [] },
      implementedBy: result.graphSummary?.implementedBy ?? { total: 0, symbols: [] },
    },
    connectionsWithinResults: {
      total: result.connectionsWithinResults?.total ?? 0,
      calls: result.connectionsWithinResults?.calls ?? [],
      usedBy: result.connectionsWithinResults?.usedBy ?? [],
      supertypes: result.connectionsWithinResults?.supertypes ?? [],
      subtypes: result.connectionsWithinResults?.subtypes ?? [],
      implements: result.connectionsWithinResults?.implements ?? [],
      implementedBy: result.connectionsWithinResults?.implementedBy ?? [],
    },
    ranking: {
      hybridScore: result.score,
      semanticScore: result.semanticScore ?? 0,
      signals: result.rankingSignals ?? [],
      breakdown: result.scoreBreakdown ?? emptyBreakdown(),
    },
  };
}

export function serializeFeatureBriefResponse(brief: FeatureBrief): FeatureBriefResponseJson {
  return {
    feature: brief.feature,
    topic: brief.topic,
    seedSymbols: brief.seedSymbols,
    recommendedNextCalls: {
      getSymbols: brief.seedSymbols.slice(0, 3),
      expandGraph: brief.seedSymbols.slice(0, 2),
    },
    docs: brief.docs,
    knowledgeHits: brief.knowledgeHits.map(serializeKnowledgeHit),
    codeAnchors: brief.codeAnchors.map(anchor => ({
      symbol: anchor.symbol,
      file: anchor.file,
      type: anchor.type,
      ranking: {
        hybridScore: anchor.score,
        semanticScore: anchor.semanticScore,
        signals: anchor.signals,
      },
    })),
    recentChanges: brief.recentChanges.map(serializeChangeEntry),
    whyChanged: serializeWhyChanged(brief.whyChanged),
    hotspots: brief.hotspots,
    impact: brief.impact,
  };
}