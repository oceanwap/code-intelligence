import * as path from 'path';
import { getAffectedSymbols } from './engineering-insights.js';
import { loadGraph, type GraphData } from './graph.js';
import { getDataDir } from './git.js';
import { queryProject, type RetrievedChunk } from './indexer-run.js';
import {
  getFeatureMap,
  getWhyChanged,
  listRecentChanges,
  queryProjectMemory,
  renderEntrySource,
  type ChangeMemoryEntry,
  type ProjectMemorySearchHit,
} from './project-memory.js';
import { getRiskHotspots } from './engineering-insights.js';

export interface FeatureCodeAnchor {
  symbol: string;
  file: string;
  type: string;
  score: number;
  semanticScore: number;
  signals: string[];
}

export interface FeatureBrief {
  feature: string;
  topic: string | null;
  seedSymbols: string[];
  knowledgeHits: ProjectMemorySearchHit[];
  docs: Array<{ title: string; source: string; summary: string }>;
  codeAnchors: FeatureCodeAnchor[];
  recentChanges: ChangeMemoryEntry[];
  whyChanged: ReturnType<typeof getWhyChanged>;
  hotspots: ReturnType<typeof getRiskHotspots>;
  impact: ReturnType<typeof getAffectedSymbols>;
}

const STOP_WORDS = new Set([
  'the', 'and', 'with', 'from', 'that', 'this', 'have', 'into', 'after', 'before',
  'when', 'while', 'over', 'under', 'then', 'than', 'your', 'their', 'feature',
  'features', 'system', 'project', 'code', 'module', 'service', 'flow', 'logic',
  'what', 'does', 'work', 'works', 'about', 'area', 'where', 'how', 'using', 'use',
]);

function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && token.length <= 24 && !STOP_WORDS.has(token));
}

function addScore(target: Map<string, number>, values: string[], weight: number): void {
  for (const value of values) {
    target.set(value, (target.get(value) ?? 0) + weight);
  }
}

function graphNeighbors(graph: GraphData, symbol: string): string[] {
  return [...new Set([
    ...(graph.symbols[symbol] ?? []),
    ...(graph.callers[symbol] ?? []),
    ...(graph.implementations[symbol] ?? []),
    ...(graph.implementedFrom[symbol] ?? []),
    ...(graph.supertypes[symbol] ?? []),
    ...(graph.subtypes[symbol] ?? []),
  ])];
}

function graphConnectivity(graph: GraphData | null, symbol: string): number {
  if (!graph) return 0;
  return graphNeighbors(graph, symbol).length;
}

function buildKnowledgeSupport(knowledgeHits: ProjectMemorySearchHit[]): Map<string, number> {
  const scores = new Map<string, number>();

  knowledgeHits.forEach((hit, index) => {
    const weight = Math.max(1, 6 - index);
    for (const symbol of hit.entry.symbols ?? []) {
      scores.set(symbol, (scores.get(symbol) ?? 0) + weight * Math.max(1, hit.score * 6));
    }
  });

  return scores;
}

function buildHotspotSupport(hotspots: ReturnType<typeof getRiskHotspots>): Map<string, number> {
  const scores = new Map<string, number>();
  for (const entry of hotspots?.symbols ?? []) {
    scores.set(entry.symbol, entry.fixCount * 2 + entry.changeCount + entry.score * 0.1);
  }
  return scores;
}

function featureOverlap(featureTokens: Set<string>, value: string): number {
  return tokenize(value).filter(token => featureTokens.has(token)).length;
}

export function chooseFeatureTopic(
  feature: string,
  knowledgeHits: ProjectMemorySearchHit[],
  codeHits: RetrievedChunk[]
): string | null {
  const scores = new Map<string, number>();
  addScore(scores, tokenize(feature), 6);

  knowledgeHits.forEach((hit, index) => {
    const weight = Math.max(1, 6 - index);
    addScore(scores, hit.entry.topics ?? [], weight * 3);
    addScore(scores, tokenize(hit.entry.title), weight * 2);
    addScore(scores, (hit.entry.symbols ?? []).flatMap(symbol => tokenize(symbol)), weight * 2);
    addScore(scores, (hit.entry.files ?? []).flatMap(file => tokenize(file)), weight);
  });

  codeHits.forEach((hit, index) => {
    const semantic = hit.semanticScore ?? hit.score;
    const weight = semantic > 0 ? Math.max(1, Math.round(semantic * 5)) : Math.max(1, 3 - index);
    addScore(scores, tokenize(hit.symbol), weight * 2);
    addScore(scores, tokenize(hit.file), weight);
  });

  const [topic] = [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0] ?? [];

  return topic ?? null;
}

export function chooseFeatureSeeds(
  knowledgeHits: ProjectMemorySearchHit[],
  codeHits: Array<Pick<RetrievedChunk, 'symbol' | 'score' | 'type' | 'semanticScore'>>,
  limit = 4
): string[] {
  const scores = new Map<string, number>();

  knowledgeHits.forEach((hit, index) => {
    const weight = Math.max(1, 6 - index);
    for (const symbol of hit.entry.symbols) {
      scores.set(symbol, (scores.get(symbol) ?? 0) + weight * 4);
    }
  });

  codeHits
    .filter(hit => hit.type !== 'file' && !hit.symbol.includes('/'))
    .forEach((hit, index) => {
      const semantic = hit.semanticScore ?? hit.score;
      const weight = semantic > 0 ? Math.max(1, Math.round(semantic * 8)) : Math.max(1, 3 - index);
      scores.set(hit.symbol, (scores.get(hit.symbol) ?? 0) + weight * 3);
    });

  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([symbol]) => symbol);
}

export function rankFeatureAnchors(
  feature: string,
  topic: string | null,
  knowledgeHits: ProjectMemorySearchHit[],
  codeHits: RetrievedChunk[],
  opts?: {
    graph?: GraphData | null;
    hotspots?: ReturnType<typeof getRiskHotspots>;
    limit?: number;
  }
): FeatureCodeAnchor[] {
  const graph = opts?.graph ?? null;
  const hotspotSupport = buildHotspotSupport(opts?.hotspots ?? null);
  const knowledgeSupport = buildKnowledgeSupport(knowledgeHits);
  const featureTokens = new Set(tokenize(`${feature} ${topic ?? ''}`));
  const seen = new Set<string>();
  const anchors: FeatureCodeAnchor[] = [];

  for (const hit of codeHits) {
    if (hit.type === 'file') continue;
    if (seen.has(hit.symbol)) continue;
    seen.add(hit.symbol);

    const semanticValue = Math.max(0, hit.semanticScore ?? hit.score);
    const semanticScore = semanticValue * 10;
    const directKnowledge = knowledgeSupport.get(hit.symbol) ?? 0;
    const directHotspot = hotspotSupport.get(hit.symbol) ?? 0;
    const overlapScore = featureOverlap(featureTokens, `${hit.symbol} ${hit.file}`) * 2.5;
    const topicMatch = topic && tokenize(`${hit.symbol} ${hit.file}`).includes(topic) ? 3 : 0;
    const connectivity = graphConnectivity(graph, hit.symbol);
    const connectivityScore = Math.min(4, connectivity * 0.6);
    const neighborKnowledge = graph
      ? graphNeighbors(graph, hit.symbol)
          .reduce((total, neighbor) => total + (knowledgeSupport.get(neighbor) ?? 0), 0)
      : 0;
    const neighborScore = Math.min(4, neighborKnowledge * 0.15);

    const signals: string[] = [];
    if (semanticScore > 0) signals.push(`semantic ${hit.score.toFixed(3)}`);
    if (overlapScore > 0) signals.push('feature token match');
    if (topicMatch > 0) signals.push(`topic match: ${topic}`);
    if (directKnowledge > 0) signals.push('supported by project memory');
    if (neighborScore > 0) signals.push('connected to relevant symbols');
    if (directHotspot > 0) signals.push('appears in feature hotspots');
    if (connectivityScore > 0) signals.push(`graph connectivity ${connectivity}`);

    anchors.push({
      symbol: hit.symbol,
      file: hit.file,
      type: hit.type,
      score: semanticScore + overlapScore + topicMatch + directKnowledge + neighborScore + directHotspot + connectivityScore,
      semanticScore: semanticValue,
      signals,
    });
  }

  return anchors
    .sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol))
    .slice(0, opts?.limit ?? 6);
}

function dedupeAnchors(hits: RetrievedChunk[], limit: number): FeatureCodeAnchor[] {
  return rankFeatureAnchors('', null, [], hits, { limit });
}

function selectFeatureDocs(
  feature: string,
  topic: string | null,
  knowledgeHits: ProjectMemorySearchHit[],
  featureMap: ReturnType<typeof getFeatureMap>
): Array<{ title: string; source: string; summary: string }> {
  const featureTokens = new Set(tokenize(feature));
  const docs = new Map<string, { title: string; source: string; summary: string; score: number }>();

  if (featureMap) {
    for (const doc of featureMap.documentedFeatures) {
      const matchesToken = tokenize(`${doc.title} ${doc.summary} ${doc.path}`).some(token => featureTokens.has(token));
      const matchesTopic = topic ? doc.topics.some(item => item.includes(topic)) : false;
      if (!matchesToken && !matchesTopic) continue;
      docs.set(doc.id, {
        title: doc.title,
        source: renderEntrySource(doc),
        summary: doc.summary,
        score: matchesTopic ? 8 : 6,
      });
    }
  }

  for (const hit of knowledgeHits) {
    if (hit.entry.kind !== 'document') continue;
    const score = hit.score * 10;
    const existing = docs.get(hit.entry.id);
    if (!existing || score > existing.score) {
      docs.set(hit.entry.id, {
        title: hit.entry.title,
        source: renderEntrySource(hit.entry),
        summary: hit.entry.summary,
        score,
      });
    }
  }

  return [...docs.values()]
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, 3)
    .map(({ score: _score, ...doc }) => doc);
}

export async function buildFeatureBrief(
  projectRoot: string,
  feature: string,
  qdrantUrl = 'http://localhost:6333',
  opts?: { memoryLimit?: number; codeLimit?: number; impactLimit?: number }
): Promise<FeatureBrief> {
  const root = path.resolve(projectRoot);
  const memoryLimit = opts?.memoryLimit ?? 5;
  const codeLimit = opts?.codeLimit ?? 6;
  const impactLimit = opts?.impactLimit ?? 6;

  const [knowledgeHits, codeHits] = await Promise.all([
    queryProjectMemory(root, feature, qdrantUrl, memoryLimit),
    queryProject(root, feature, qdrantUrl),
  ]);

  const topic = chooseFeatureTopic(feature, knowledgeHits, codeHits);
  const graph = loadGraph(path.join(getDataDir(root), 'graph.json'));
  const hotspots = getRiskHotspots(root, {
    limit: 3,
    topic: topic ?? undefined,
  });
  const codeAnchors = rankFeatureAnchors(feature, topic, knowledgeHits, codeHits, {
    graph,
    hotspots,
    limit: codeLimit,
  });
  const seedSymbols = chooseFeatureSeeds(knowledgeHits, codeAnchors, 4);
  const featureMap = getFeatureMap(root);
  const docs = selectFeatureDocs(feature, topic, knowledgeHits, featureMap);
  const recentChanges = listRecentChanges(root, {
    limit: 4,
    topic: topic ?? undefined,
  });
  const whyChanged = seedSymbols.length > 0
    ? getWhyChanged(root, { target: seedSymbols[0], mode: 'symbol', topic: topic ?? undefined, limit: 3 })
    : null;
  const impact = seedSymbols.length > 0
    ? getAffectedSymbols(root, seedSymbols.slice(0, 2), { hops: 2, direction: 'both', limit: impactLimit })
    : null;

  return {
    feature,
    topic,
    seedSymbols,
    knowledgeHits,
    docs,
    codeAnchors,
    recentChanges,
    whyChanged,
    hotspots,
    impact,
  };
}

export function renderFeatureBrief(brief: FeatureBrief): string {
  const sections = [
    `Feature: ${brief.feature}`,
    brief.topic ? `Likely topic: ${brief.topic}` : '',
    brief.seedSymbols.length > 0 ? `Primary anchors: ${brief.seedSymbols.join(', ')}` : '',
  ].filter(Boolean);

  if (brief.docs.length > 0) {
    sections.push([
      '## What It Is',
      brief.docs.map(doc => [
        `### ${doc.title}`,
        `Source: ${doc.source}`,
        `Summary: ${doc.summary}`,
      ].join('\n')).join('\n\n---\n\n'),
    ].join('\n\n'));
  } else if (brief.knowledgeHits.length > 0) {
    sections.push([
      '## What It Is',
      brief.knowledgeHits.slice(0, 2).map(hit => {
        const entry = hit.entry;
        return [
          `### ${entry.title}`,
          `Source: ${renderEntrySource(entry)}`,
          `Summary: ${entry.summary}`,
          entry.topics.length > 0 ? `Topics: ${entry.topics.join(', ')}` : '',
        ].filter(Boolean).join('\n');
      }).join('\n\n---\n\n'),
    ].join('\n\n'));
  }

  if (brief.codeAnchors.length > 0) {
    sections.push([
      '## Main Code Anchors',
      brief.codeAnchors.map(anchor => [
        `### ${anchor.symbol}`,
        `File: ${anchor.file}`,
        `Type: ${anchor.type}`,
        `Hybrid score: ${anchor.score.toFixed(2)}`,
        anchor.semanticScore > 0 ? `Semantic score: ${anchor.semanticScore.toFixed(3)}` : '',
        anchor.signals.length > 0 ? `Signals: ${anchor.signals.join('; ')}` : '',
      ].filter(Boolean).join('\n')).join('\n\n---\n\n'),
    ].join('\n\n'));
  }

  if (brief.whyChanged && brief.whyChanged.matches.length > 0) {
    sections.push([
      '## Recent Rationale',
      brief.whyChanged.matches.map(match => {
        const entry = match.entry;
        return [
          `### ${entry.title} (${entry.sha.slice(0, 8)})`,
          `Type: ${entry.changeType}`,
          `When: ${entry.timestamp}`,
          match.matchedSymbols.length > 0 ? `Matched symbols: ${match.matchedSymbols.join(', ')}` : '',
          `Summary: ${entry.summary}`,
          entry.topics.length > 0 ? `Topics: ${entry.topics.join(', ')}` : '',
        ].filter(Boolean).join('\n');
      }).join('\n\n---\n\n'),
    ].join('\n\n'));
  } else if (brief.recentChanges.length > 0) {
    sections.push([
      '## Recent Changes',
      brief.recentChanges.map(entry => [
        `### ${entry.title} (${entry.sha.slice(0, 8)})`,
        `Type: ${entry.changeType}`,
        `When: ${entry.timestamp}`,
        `Summary: ${entry.summary}`,
      ].join('\n')).join('\n\n---\n\n'),
    ].join('\n\n'));
  }

  if (brief.hotspots && (brief.hotspots.symbols.length > 0 || brief.hotspots.files.length > 0)) {
    sections.push([
      '## Risk Hotspots',
      [
        ...brief.hotspots.symbols.slice(0, 3).map(entry => `- Symbol: ${entry.symbol} (${entry.changeCount} changes, ${entry.fixCount} fixes, score ${entry.score.toFixed(1)})`),
        ...brief.hotspots.files.slice(0, 2).map(entry => `- File: ${entry.file} (${entry.changeCount} changes, ${entry.fixCount} fixes, score ${entry.score.toFixed(1)})`),
      ].join('\n'),
    ].join('\n\n'));
  }

  if (brief.impact && brief.impact.entries.length > 0) {
    sections.push([
      '## Likely Neighbors',
      brief.impact.entries.slice(0, 5).map(entry => `- ${entry.symbol}${entry.file ? ` — ${entry.file}` : ''} (${entry.distance} hop${entry.distance === 1 ? '' : 's'})`).join('\n'),
    ].join('\n\n'));
  }

  if (brief.seedSymbols.length > 0) {
    sections.push(`Recommended next call: get_symbols on ${brief.seedSymbols.slice(0, 3).join(', ')} or expand_graph on ${brief.seedSymbols.slice(0, 2).join(', ')} for code-level detail.`);
  }

  return sections.join('\n\n');
}