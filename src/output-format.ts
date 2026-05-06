import type { AffectedSymbolsResult, RiskHotspotsResult } from './engineering-insights.js';
import type { FeatureBrief } from './feature-knowledge.js';
import type { RetrievedChunk } from './retriever.js';
import {
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

export function serializeQueryResult(result: RetrievedChunk): QueryResultJson {
  return {
    file: result.file,
    symbol: result.symbol,
    type: result.type,
    code: result.code,
    ranking: {
      hybridScore: result.score,
      semanticScore: result.semanticScore ?? 0,
      signals: result.rankingSignals ?? [],
      breakdown: result.scoreBreakdown ?? emptyBreakdown(),
    },
  };
}

export function serializeQueryProjectResponse(
  question: string,
  results: RetrievedChunk[]
): QueryProjectResponseJson {
  return {
    question,
    resultCount: results.length,
    results: results.map(serializeQueryResult),
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