#!/usr/bin/env bun
import { Command } from 'commander';
import * as path from 'path';
import type { RetrievedChunk } from './indexer-run.js';
import {
  getAffectedSymbols,
  getRiskHotspots,
  renderAffectedSymbols,
  renderRiskHotspots,
} from './engineering-insights.js';
import { indexProject, queryProjectPage } from './indexer-run.js';
import {
  getFeatureMapAsync,
  getBugBriefAsync,
  getProjectMemoryFreshnessAsync,
  listRecentChangesAsync,
  listRecentBugsAsync,
  getWhyChangedAsync,
  queryProjectMemory,
  renderBugBrief,
  renderFeatureMap,
  renderMemoryQueryResults,
  renderProjectStatus,
  renderRecentBugs,
  renderRecentChanges,
  renderWhyChanged,
  syncProjectMemory,
  getProjectStatusAsync,
} from './project-memory.js';
import { serializeQueryProjectResponse, serializeFeatureBriefResponse } from './output-format.js';
import { buildProjectIntentSnapshot, renderProjectIntentSnapshot } from './project-intent.js';
import { MissingCodeIndexError } from './retriever.js';
import {
  scrollSymbolPoints,
  groupPointsBySymbol,
  expandGraphBfs,
  makeProjectQdrantClient,
  loadProjectGraph,
  renderSymbolText,
} from './symbol-lookup.js';
import { buildFeatureBrief, renderFeatureBrief } from './feature-knowledge.js';
import { findExisting, renderFindExisting } from './find-existing.js';
import { whereShouldThisLive, renderPlacementOracle } from './placement-oracle.js';
import { validateIntent, renderIntentValidation } from './intent-validator.js';
import { validateGeneratedCode, renderCodeValidation } from './code-validator.js';
import { getModuleConventions, renderModuleConventions } from './module-conventions.js';
import { smartQueryAsync } from './smart-query.js';
import { loadArchitectureAsync, refreshArchitectureAsync } from './cognition/architecture/storage.js';
import { findDependencyPath, topUnstableModules } from './cognition/architecture/analyzer.js';
import {
  attentionOverviewAsync,
  attentionScoreAsync,
  activeZonesAsync,
  embeddingPriorityAsync,
  refreshAttentionAsync,
} from './cognition/attention/engine.js';
import {
  reflectChangeAsync,
  reflectLatestChangeAsync,
  reflectionFailuresForChangeAsync,
  regressionRiskAsync,
  findSimilarFailuresAsync,
} from './cognition/reflection/engine.js';
import {
  failureClustersAsync,
  historicalRegressionsAsync,
  refreshFailureIntelligenceAsync,
  rootCauseHistoryAsync,
} from './cognition/failures/engine.js';
import {
  boundaryAnalysisAsync,
  listConstraintViolationsAsync,
  validateArchitectureAsync,
} from './cognition/constraints/engine.js';
import {
  architectureDriftAsync,
  hotspotAnalysisAsync,
  instabilityTimelineAsync,
  refreshEvolutionAsync,
} from './cognition/evolution/engine.js';
import {
  contradictionReportAsync,
  memoryHealthAsync,
  refreshMemoryGovernanceAsync,
  staleMemoryAsync,
} from './cognition/governance/engine.js';
import {
  generateProjectBrief,
  cognitionDiff,
  compareBranchCognition,
  assembleTaskContext,
  buildPreflightChanges,
  buildTestImpact,
} from './agent-ops.js';
import { buildGitSemanticChangeGraph } from './git-change-graph.js';
import { loadGraphAsync } from './graph.js';
import { getDataDir, getCurrentBranchAsync } from './git.js';
import { getProjectMemoryCountAsync } from './project-memory.js';
import { buildRepoMap, renderRepoMap } from './repo-map.js';
import { loadStructureAsync, refreshStructureAsync } from './cognition/structure/engine.js';

function formatLineRanges(ranges: Array<{ startLine: number; endLine: number }>): string {
  return ranges
    .map(range => range.startLine === range.endLine ? `${range.startLine}` : `${range.startLine}-${range.endLine}`)
    .join(', ');
}

function formatGraphList(label: string, relation: { total: number; symbols: string[] } | undefined): string | null {
  if (!relation || relation.total === 0) return null;
  const suffix = relation.total > relation.symbols.length ? ', ...' : '';
  return `${label}: ${relation.total} (${relation.symbols.join(', ')}${suffix})`;
}

function formatCallSiteList(label: string, relation: { sites: Array<{ symbol: string; file: string; line: number }> } | undefined): string | null {
  if (!relation || relation.sites.length === 0) return null;
  return `${label} places: ${relation.sites.map(site => `${site.symbol} @ ${site.file}:${site.line}`).join('; ')}`;
}

function formatSymbolList(label: string, values: string[] | undefined): string | null {
  if (!values || values.length === 0) return null;
  return `${label}: ${values.join(', ')}`;
}

function drawBar(label: string, done: number, total: number): void {
  const W = 25;
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);
  const filled = Math.round(W * pct / 100);
  const bar = '█'.repeat(filled) + '░'.repeat(W - filled);
  process.stdout.write(`\r  ${label.padEnd(11)} [${bar}] ${String(pct).padStart(3)}%  ${done}/${total}`);
  if (done >= total) process.stdout.write('\n');
}

const program = new Command();
program.name('code-intel').description('Local code intelligence CLI');

function renderQueryChunkText(result: RetrievedChunk): string {
  const lines = [
    `File:   ${result.file}`,
    `Symbol: ${result.symbol} (${result.type})`,
    `Lines:  ${result.lineStart ?? '?'}-${result.lineEnd ?? '?'}`,
    `Ranking: hybrid ${result.score.toFixed(3)} | semantic ${(result.semanticScore ?? 0).toFixed(3)}`,
  ];

  if (result.freshness) {
    lines.push(`Index refreshed: ${result.freshness.indexRefreshedAt ?? 'unknown'}`);
    if (result.freshness.latestChange) {
      lines.push(
        `Latest slice change: ${result.freshness.latestChange.timestamp || 'unknown'} ${result.freshness.latestChange.sha.slice(0, 12)} ${result.freshness.latestChange.title}`
      );
      if (result.freshness.latestChange.changedLines.length > 0) {
        lines.push(`Changed lines in slice: ${formatLineRanges(result.freshness.latestChange.changedLines)}`);
      }
    }
    if (result.freshness.reasons.length > 0) {
      lines.push(`Freshness: re-index recommended (${result.freshness.reasons.join('; ')})`);
    }
  }

  const graphLines = [
    formatGraphList('Calls', result.graphSummary?.calls),
    formatCallSiteList('Call', result.graphSummary?.calls),
    formatGraphList('Used by', result.graphSummary?.usedBy),
    formatCallSiteList('Used by', result.graphSummary?.usedBy),
    formatGraphList('Supertypes', result.graphSummary?.supertypes),
    formatGraphList('Subtypes', result.graphSummary?.subtypes),
    formatGraphList('Implements', result.graphSummary?.implements),
    formatGraphList('Implemented by', result.graphSummary?.implementedBy),
  ].filter((line): line is string => Boolean(line));
  lines.push(...graphLines);

  if ((result.connectionsWithinResults?.total ?? 0) > 0) {
    lines.push(`Connected returned slices: ${result.connectionsWithinResults?.total}`);
    const connectionLines = [
      formatSymbolList('Returned calls', result.connectionsWithinResults?.calls),
      formatSymbolList('Returned used by', result.connectionsWithinResults?.usedBy),
      formatSymbolList('Returned supertypes', result.connectionsWithinResults?.supertypes),
      formatSymbolList('Returned subtypes', result.connectionsWithinResults?.subtypes),
      formatSymbolList('Returned implements', result.connectionsWithinResults?.implements),
      formatSymbolList('Returned implemented by', result.connectionsWithinResults?.implementedBy),
    ].filter((line): line is string => Boolean(line));
    lines.push(...connectionLines);
  }

  if (result.rankingSignals && result.rankingSignals.length > 0) {
    lines.push(`Signals: ${result.rankingSignals.join('; ')}`);
  }

  if (result.scoreBreakdown) {
    lines.push(
      `Breakdown: semantic ${result.scoreBreakdown.semantic.toFixed(2)}, `
      + `symbol overlap ${result.scoreBreakdown.symbolOverlap.toFixed(2)}, `
      + `file overlap ${result.scoreBreakdown.fileOverlap.toFixed(2)}, `
      + `memory ${result.scoreBreakdown.directMemory.toFixed(2)}, `
      + `neighbor support ${result.scoreBreakdown.neighborSupport.toFixed(2)}, `
      + `connectivity ${result.scoreBreakdown.connectivity.toFixed(2)}`
    );
  }

  return [
    `${'─'.repeat(60)}`,
    ...lines,
    '─'.repeat(60),
    result.code,
  ].join('\n');
}

// index <dir> — parse with ts-morph, embed, store in Qdrant
program
  .command('index <dir>')
  .description('Index a codebase directory')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .option('--from-scratch', 'Delete all previous index data and rebuild from zero', false)
  .option('--full-index', 'Index all chunks, including lower-relevance docs/config/plain-file slices (default is fast mode)', false)
  .action(async (dir: string, opts: { qdrant: string; fromScratch: boolean; fullIndex: boolean }) => {
    const root = path.resolve(dir);
    const indexMode = opts.fullIndex ? 'full' : 'fast';

    console.log(`Scanning ${root}...`);
    if (opts.fromScratch) {
      console.log('⚠️  Full reindex mode: will delete all previous data');
    }
    console.log(`Index mode: ${indexMode}`);
    
    const stageLabels: Record<string, string> = {
      'pre-scanning': 'Pre-scanning files',
      'parsing': 'Parsing files',
      'building-graph': 'Building call graph',
      'building-manifest': 'Building manifest',
      'cleaning': 'Cleaning stale data',
      'loading-model': 'Loading embedding model',
      'embedding': 'Embedding code',
      'storing': 'Storing embeddings',
      'syncing-memory': 'Syncing project memory',
      'computing-cognition': 'Computing cognition layers',
    };
    
    let lastStage = '';
    
    const result = await indexProject(root, opts.qdrant, (stage, done, total) => {
      if (stage !== lastStage) {
        if (lastStage) console.log(''); // newline after previous stage
        lastStage = stage;
      }
      
      const label = stageLabels[stage] || stage;
      if (total === 1) {
        // Binary stage (on/off)
        if (done === 0) {
          process.stdout.write(`  ${label}...`);
        }
      } else {
        // Progress with counter
        drawBar(label, done, total);
      }
    }, opts.fromScratch, indexMode);

    console.log(''); // final newline
    console.log(`  ${result.discoveredChunks} chunks discovered`);
    console.log(`  ${result.indexedChunks} chunks indexed (${result.filteredOutChunks} filtered out in ${result.mode} mode)`);
    console.log(`  ${result.symbols} symbols, ${result.files} files in graph`);
    const timingParts = Object.entries(result.stageDurationsMs)
      .map(([stage, ms]) => `${stage}=${ms}ms`)
      .join(', ');
    console.log(`  Timing: total=${result.totalDurationMs}ms`);
    if (timingParts.length > 0) console.log(`  Stage timings: ${timingParts}`);
    if (result.staleRemoved > 0) console.log(`  Removed ${result.staleRemoved} stale chunk(s) from Qdrant`);
    if (result.orphansRemoved > 0) console.log(`  Removed ${result.orphansRemoved} orphaned chunk(s) from Qdrant`);
    console.log(`  ${result.memoryEntries} project-memory entr${result.memoryEntries === 1 ? 'y' : 'ies'} indexed`);
    if (result.newMemoryEntries > 0) console.log(`  Added ${result.newMemoryEntries} new project-memory entr${result.newMemoryEntries === 1 ? 'y' : 'ies'}`);
    if (result.staleMemoryRemoved > 0) console.log(`  Removed ${result.staleMemoryRemoved} stale project-memory entr${result.staleMemoryRemoved === 1 ? 'y' : 'ies'}`);
    console.log('Indexing complete.');
  });

// query "<question>" --dir <project-root>
program
  .command('query <question>')
  .description('Retrieve relevant code for a natural language question')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--format <format>', 'Output format: text|json', 'text')
  .option('--mode <mode>', 'Retrieval mode: default|architecture', 'default')
  .option('--semantic-threshold <value>', 'Semantic score threshold (0..1) to expand caller/callee context from strong matches', '0.5')
  .option('--page <n>', 'Result page number (starts at 1)', '1')
  .option('--page-size <n>', 'Results per page (1..20)', '6')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (question: string, opts: { dir: string; format: 'text' | 'json'; mode: 'default' | 'architecture'; semanticThreshold: string; page: string; pageSize: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    const mode = opts.mode === 'architecture' ? 'architecture' : 'default';
    const parsedThreshold = Number(opts.semanticThreshold);
    const semanticThreshold = Number.isFinite(parsedThreshold) ? Math.max(0, Math.min(1, parsedThreshold)) : 0.5;
    const parsedPage = Number(opts.page);
    const page = Number.isFinite(parsedPage) ? Math.max(1, Math.floor(parsedPage)) : 1;
    const parsedPageSize = Number(opts.pageSize);
    const pageSize = Number.isFinite(parsedPageSize) ? Math.max(1, Math.min(20, Math.floor(parsedPageSize))) : 6;
    let results: RetrievedChunk[];
    let pagination: {
      page: number;
      pageSize: number;
      totalResults: number;
      totalPages: number;
      hasMore: boolean;
      nextPage: number | null;
      symbolIndexByPage: Array<{ page: number; symbols: string[] }>;
      callGraphPreviewLines: string[];
    } | null = null;
    try {
      const response = await queryProjectPage(root, question, opts.qdrant, {
        mode,
        semanticThreshold,
        page,
        pageSize,
      });
      results = response.results;
      pagination = response.pagination;
    } catch (error) {
      if (error instanceof MissingCodeIndexError) {
        console.log('No code index found for this project/branch yet.');
        console.log(`Run this first: code-intel index "${root}" --qdrant "${opts.qdrant}"`);
        return;
      }
      throw error;
    }
    const memoryFreshness = await getProjectMemoryFreshnessAsync(root);
    if (!results.length) {
      console.log('No results found.');
      return;
    }

    if (opts.format === 'json') {
      console.log(JSON.stringify(serializeQueryProjectResponse(question, results, memoryFreshness, pagination ?? undefined), null, 2));
      return;
    }

    console.log(`Project memory refreshed: ${memoryFreshness.memoryRefreshedAt ?? 'unknown'}`);
    if (memoryFreshness.reasons.length > 0) {
      console.log(`Project memory freshness: re-index recommended (${memoryFreshness.reasons.join('; ')})`);
    }
    if (pagination) {
      console.log(`Results page ${pagination.page}/${pagination.totalPages} (page size ${pagination.pageSize}, total ${pagination.totalResults})`);
      if (pagination.hasMore && pagination.nextPage) {
        console.log(`More context available: rerun with --page ${pagination.nextPage} --page-size ${pagination.pageSize}`);
      }
      if (pagination.symbolIndexByPage.length > 0) {
        console.log('Symbols by page:');
        for (const entry of pagination.symbolIndexByPage) {
          console.log(`  Page ${entry.page}: ${entry.symbols.join(', ') || '(none)'}`);
        }
      }
      for (const line of pagination.callGraphPreviewLines) {
        console.log(line);
      }
    }
    if (mode === 'architecture') {
      const snapshot = await buildProjectIntentSnapshot(root);
      if (snapshot) {
        const overviewClaims = snapshot.claims
          .filter(claim => claim.category === 'architecture' || claim.category === 'patterns' || claim.category === 'entrypoints')
          .slice(0, 6)
          .map(claim => `- [${claim.evidenceTier}] ${claim.statement}`);
        if (overviewClaims.length > 0) {
          console.log('\nArchitecture overview:');
          console.log(overviewClaims.join('\n'));
        }
      }
    }

    for (const r of results) {
      console.log(`\n${renderQueryChunkText(r)}`);
    }

    if (pagination) {
      console.log(`\nResults page ${pagination.page}/${pagination.totalPages} (page size ${pagination.pageSize}, total ${pagination.totalResults})`);
      if (pagination.hasMore && pagination.nextPage) {
        console.log(`More context available: rerun with --page ${pagination.nextPage} --page-size ${pagination.pageSize}`);
      }
    }
  });

program
  .command('smart-query <question>')
  .description('Answer a natural language question about the codebase via retrieval + local LLM (Ollama)')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--model <model>', 'Ollama model name', 'qwen2.5:3b')
  .option('--ollama-url <url>', 'Ollama server URL', 'http://localhost:11434')
  .option('--page-size <n>', 'Number of code chunks to retrieve (1..8)', '4')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (question: string, opts: { dir: string; model: string; ollamaUrl: string; pageSize: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    const parsedPageSize = Number(opts.pageSize);
    const pageSize = Number.isFinite(parsedPageSize) ? Math.max(1, Math.min(8, Math.floor(parsedPageSize))) : 4;
    try {
      const { answer } = await smartQueryAsync(root, question, {
        model: opts.model,
        ollamaUrl: opts.ollamaUrl,
        pageSize,
        qdrantUrl: opts.qdrant,
      });
      console.log(answer);
    } catch (error) {
      if (error instanceof MissingCodeIndexError) {
        console.log('No code index found for this project/branch yet.');
        console.log(`Run this first: code-intel index "${root}" --qdrant "${opts.qdrant}"`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    }
  });

program
  .command('status')
  .description('Show engineer-style project status from offline project memory')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    const status = await getProjectStatusAsync(root);
    if (!status) {
      console.log('No project memory found. Run `code-intel index .` first.');
      return;
    }

    console.log(renderProjectStatus(status));
  });

program
  .command('changes')
  .description('Show recent semantic changes from offline project memory')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--limit <n>', 'Number of changes to show', '10')
  .option('--type <type>', 'Optional filter: feature|fix|refactor|docs|test|ops|chore')
  .option('--topic <topic>', 'Optional topic filter')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; limit: string; type?: 'feature' | 'fix' | 'refactor' | 'docs' | 'test' | 'ops' | 'chore'; topic?: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    const entries = await listRecentChangesAsync(root, {
      limit: Number(opts.limit) || 10,
      type: opts.type,
      topic: opts.topic,
    });
    console.log(renderRecentChanges(entries));
  });

program
  .command('bugs')
  .description('Show recent bug-memory entries synthesized from fix history')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--limit <n>', 'Number of bugs to show', '10')
  .option('--topic <topic>', 'Optional topic filter')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; limit: string; topic?: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    const entries = await listRecentBugsAsync(root, {
      limit: Number(opts.limit) || 10,
      topic: opts.topic,
    });
    console.log(renderRecentBugs(entries));
  });

program
  .command('features')
  .description('Show documented project features and architecture facts from offline document memory')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    const featureMap = await getFeatureMapAsync(root);
    if (!featureMap) {
      console.log('No project memory found. Run `code-intel index .` first.');
      return;
    }

    console.log(renderFeatureMap(featureMap));
  });

program
  .command('intent')
  .description('Show structured project-understanding snapshot with evidence tiers and confidence')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .option('--json', 'Emit JSON output')
  .action(async (opts: { dir: string; qdrant: string; json?: boolean }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    const snapshot = await buildProjectIntentSnapshot(root);
    if (!snapshot) {
      console.log('Project not indexed. Run `code-intel index .` first.');
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }

    console.log(renderProjectIntentSnapshot(snapshot));
  });

program
  .command('memory-query <question>')
  .description('Semantic search over offline project memory')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--limit <n>', 'Number of matches to show', '5')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (question: string, opts: { dir: string; limit: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    const results = await queryProjectMemory(root, question, opts.qdrant, Number(opts.limit) || 5);
    console.log(renderMemoryQueryResults(results));
  });

program
  .command('impact <symbols...>')
  .description('Rank likely affected nearby symbols using graph relations and offline project memory')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--hops <n>', 'How many graph hops to follow', '2')
  .option('--direction <dir>', 'Direction: out|in|both', 'both')
  .option('--limit <n>', 'Number of related symbols to show', '15')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (symbols: string[], opts: { dir: string; hops: string; direction: 'out' | 'in' | 'both'; limit: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    const result = await getAffectedSymbols(root, symbols, {
      hops: Number(opts.hops) || 2,
      direction: opts.direction,
      limit: Number(opts.limit) || 15,
    });
    if (!result) {
      console.log('Project not indexed. Run `code-intel index .` first.');
      return;
    }

    console.log(renderAffectedSymbols(result));
  });

program
  .command('hotspots')
  .description('Show risky symbols and files ranked by change frequency, fixes, and graph connectivity')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--limit <n>', 'Number of symbol and file hotspots to show', '10')
  .option('--topic <topic>', 'Optional topic filter')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; limit: string; topic?: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    const result = await getRiskHotspots(root, {
      limit: Number(opts.limit) || 10,
      topic: opts.topic,
    });
    if (!result) {
      console.log('Project not indexed. Run `code-intel index .` first.');
      return;
    }

    console.log(renderRiskHotspots(result));
  });

program
  .command('why-changed <target>')
  .description('Show recent recorded changes for a symbol or file target from offline project memory')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--mode <mode>', 'Match mode: auto|symbol|file', 'auto')
  .option('--topic <topic>', 'Optional topic filter')
  .option('--limit <n>', 'Number of matching changes to show', '10')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (target: string, opts: { dir: string; mode: 'auto' | 'symbol' | 'file'; topic?: string; limit: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    const result = await getWhyChangedAsync(root, {
      target,
      mode: opts.mode,
      topic: opts.topic,
      limit: Number(opts.limit) || 10,
    });
    if (!result) {
      console.log('No project memory found. Run `code-intel index .` first.');
      return;
    }

    console.log(renderWhyChanged(result));
  });

program
  .command('bug-brief <target>')
  .description('Show recent recorded bugs for a symbol or file target from offline bug memory')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--mode <mode>', 'Match mode: auto|symbol|file', 'auto')
  .option('--topic <topic>', 'Optional topic filter')
  .option('--limit <n>', 'Number of matching bug entries to show', '10')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (target: string, opts: { dir: string; mode: 'auto' | 'symbol' | 'file'; topic?: string; limit: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    const result = await getBugBriefAsync(root, {
      target,
      mode: opts.mode,
      topic: opts.topic,
      limit: Number(opts.limit) || 10,
    });
    if (!result) {
      console.log('No project memory found. Run `code-intel index .` first.');
      return;
    }

    console.log(renderBugBrief(result));
  });

// ─── Index status ─────────────────────────────────────────────────────────────

program
  .command('index-status')
  .description('Lightweight readiness check: shows whether the current branch is indexed and key counts')
  .option('--dir <path>', 'Project root directory', '.')
  .action(async (opts: { dir: string }) => {
    const root = path.resolve(opts.dir);
    const branch = await getCurrentBranchAsync(root);
    const dataDir = getDataDir(root);
    const manifestFile = path.join(dataDir, 'manifest.json');
    const graphFile = path.join(dataDir, 'graph.json');

    let manifestRaw: string | null = null;
    try {
      manifestRaw = await Bun.file(manifestFile).text();
    } catch {
      manifestRaw = null;
    }

    if (!manifestRaw) {
      console.log(branch ? `Not indexed on branch "${branch}". Run: code-intel index "${root}"` : `Not indexed. Run: code-intel index "${root}"`);
      return;
    }

    const manifest = JSON.parse(manifestRaw) as { mtimes: Record<string, number>; fileChunks: Record<string, string[]> };
    const fileCount = Object.keys(manifest.fileChunks).length;
    const chunkCount = (Object.values(manifest.fileChunks) as string[][]).reduce((n, ids) => n + ids.length, 0);

    let graph: { symbols: Record<string, string[]>; callers: Record<string, string[]> } | null = null;
    try {
      graph = JSON.parse(await Bun.file(graphFile).text()) as { symbols: Record<string, string[]>; callers: Record<string, string[]> };
    } catch {
      graph = null;
    }
    const symbolCount = graph ? Object.keys(graph.symbols).length : 0;
    const edgeCount = graph ? (Object.values(graph.symbols) as string[][]).reduce((n, arr) => n + arr.length, 0) : 0;

    console.log(`Status:  Indexed`);
    if (branch) console.log(`Branch:  ${branch}`);
    console.log(`Files:   ${fileCount}`);
    console.log(`Chunks:  ${chunkCount}`);
    console.log(`Symbols: ${symbolCount}`);
    console.log(`Call graph edges: ${edgeCount}`);
    console.log(`Project memory entries: ${await getProjectMemoryCountAsync(root)}`);
  });

// ─── Architecture ─────────────────────────────────────────────────────────────

program
  .command('architecture')
  .description('Architecture cognition snapshot: module coupling, instability, and zones')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--refresh', 'Recompute snapshot from latest graph', false)
  .action(async (opts: { dir: string; refresh: boolean }) => {
    const root = path.resolve(opts.dir);
    const snapshot = opts.refresh
      ? await refreshArchitectureAsync(root)
      : (await loadArchitectureAsync(root) ?? await refreshArchitectureAsync(root));
    if (!snapshot) { console.log('Project not indexed. Run `code-intel index .` first.'); return; }

    const topCoupled = Object.entries(snapshot.coupling as Record<string, number>)
      .sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([m, s]) => `  ${m} (${s.toFixed(2)})`);
    const unstable = topUnstableModules(snapshot, 8)
      .map(e => `  ${e.module} (instability ${e.instability.toFixed(2)})`);
    const zones = (snapshot.zones as Array<{ name: string; modules: string[] }>)
      .map(z => `  ${z.name}: ${z.modules.join(', ')}`).join('\n');

    console.log(`Architecture generated: ${snapshot.generatedAt}`);
    console.log(`Modules: ${snapshot.modules.length}  Dependencies: ${snapshot.dependencies.length}`);
    console.log('\nTop Coupled Modules:');
    console.log(topCoupled.join('\n') || '  none');
    console.log('\nUnstable Modules:');
    console.log(unstable.join('\n') || '  none');
    console.log('\nZones:');
    console.log(zones || '  none');
  });

program
  .command('dependency-path <from> <to>')
  .description('Find a module-level dependency path between two modules')
  .option('--dir <path>', 'Project root directory', '.')
  .action(async (from: string, to: string, opts: { dir: string }) => {
    const root = path.resolve(opts.dir);
    const snapshot = await loadArchitectureAsync(root) ?? await refreshArchitectureAsync(root);
    if (!snapshot) { console.log('Project not indexed. Run `code-intel index .` first.'); return; }
    const result = findDependencyPath(snapshot, from, to);
    if (!result) { console.log(`No dependency path found from ${from} to ${to}.`); return; }
    console.log(`Dependency path: ${result.path.join(' -> ')}`);
    console.log(`Total edge weight: ${result.totalWeight.toFixed(2)}`);
  });

program
  .command('coupling')
  .description('Report module coupling scores and heaviest dependency edges')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--limit <n>', 'Max modules and edges to show', '10')
  .action(async (opts: { dir: string; limit: string }) => {
    const root = path.resolve(opts.dir);
    const limit = Number(opts.limit) || 10;
    const snapshot = await loadArchitectureAsync(root) ?? await refreshArchitectureAsync(root);
    if (!snapshot) { console.log('Project not indexed. Run `code-intel index .` first.'); return; }

    const modules = Object.entries(snapshot.coupling as Record<string, number>)
      .sort((a, b) => b[1] - a[1]).slice(0, limit)
      .map(([m, s]) => `  ${m}: ${s.toFixed(2)}`);
    const edges = (snapshot.dependencies as Array<{ from: string; to: string; weight: number; calls: number; imports: number }>)
      .sort((a, b) => b.weight - a.weight).slice(0, limit)
      .map(d => `  ${d.from} -> ${d.to} (weight ${d.weight.toFixed(2)}, calls ${d.calls}, imports ${d.imports})`);

    console.log('Coupling Scores:');
    console.log(modules.join('\n') || '  none');
    console.log('\nHeaviest Dependencies:');
    console.log(edges.join('\n') || '  none');
  });

program
  .command('unstable-modules')
  .description('List modules with highest instability score (outbound / total dependencies)')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--limit <n>', 'Max modules to show', '10')
  .action(async (opts: { dir: string; limit: string }) => {
    const root = path.resolve(opts.dir);
    const snapshot = await loadArchitectureAsync(root) ?? await refreshArchitectureAsync(root);
    if (!snapshot) { console.log('Project not indexed. Run `code-intel index .` first.'); return; }
    const unstable = topUnstableModules(snapshot, Number(opts.limit) || 10)
      .map(item => `  ${item.module}: instability ${item.instability.toFixed(2)} (outbound ${item.outbound}, inbound ${item.inbound})`);
    console.log(unstable.join('\n') || 'No unstable modules found.');
  });

// ─── Symbol exploration ───────────────────────────────────────────────────────

program
  .command('get-symbol <symbol>')
  .description('Precision drilldown for one exact symbol with graph context and source')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (symbol: string, opts: { dir: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    const graph = await loadProjectGraph(root);
    const { client, collection } = await makeProjectQdrantClient(root, opts.qdrant);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { points } = await client.scroll(collection, {
      filter: { must: [{ key: 'symbol', match: { value: symbol } }] } as any,
      with_payload: true, with_vector: false, limit: 10,
    });
    if (points.length === 0) { console.log(`Symbol "${symbol}" not found in index.`); return; }
    for (const p of points) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.log(await renderSymbolText(root, graph, symbol, p as any));
    }
  });

program
  .command('get-symbols <symbols...>')
  .description('Batch drilldown for multiple exact symbols')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (symbols: string[], opts: { dir: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    const graph = await loadProjectGraph(root);
    const { client, collection } = await makeProjectQdrantClient(root, opts.qdrant);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allPoints = await scrollSymbolPoints(client, collection, symbols) as any[];
    if (allPoints.length === 0) { console.log('None of the requested symbols were found in the index.'); return; }
    const bySymbol = groupPointsBySymbol(allPoints);
    const notFound = symbols.filter(s => !bySymbol.has(s));
    for (const [sym, pts] of bySymbol) {
      for (const p of pts) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        console.log(await renderSymbolText(root, graph, sym, p as any));
        console.log('─'.repeat(60));
      }
    }
    if (notFound.length) console.log(`Not found: ${notFound.join(', ')}`);
  });

program
  .command('find-refs <symbol>')
  .description('Find direct graph references (callers + implementations) for a symbol')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--limit <n>', 'Max references to show', '10')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (symbol: string, opts: { dir: string; limit: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    const graph = await loadProjectGraph(root);
    if (!graph) { console.log('Project not indexed. Run `code-intel index .` first.'); return; }
    const callers = graph.callers?.[symbol] ?? [];
    const implementations = graph.implementations?.[symbol] ?? [];
    const total = new Set([...callers, ...implementations]);
    if (total.size === 0) { console.log(`No direct graph references found for "${symbol}".`); return; }
    const limit = Number(opts.limit) || 10;
    const shown = [...total].slice(0, limit);
    const { client, collection } = await makeProjectQdrantClient(root, opts.qdrant);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pointMap = groupPointsBySymbol(await scrollSymbolPoints(client, collection, shown) as any[]);
    console.log(`Direct references for ${symbol} (callers: ${callers.length}, implementations: ${implementations.length})`);
    if (graph.symbolFile[symbol]) console.log(`Declared in: ${graph.symbolFile[symbol]}`);
    if (shown.length < total.size) console.log(`Showing first ${shown.length} of ${total.size} references.`);
    for (const ref of shown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.log(await renderSymbolText(root, graph, ref, pointMap.get(ref)?.[0] as any));
    }
  });

program
  .command('find-impls <symbol>')
  .description('Find implementations of an interface, class, or method')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--limit <n>', 'Max implementations to show', '10')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (symbol: string, opts: { dir: string; limit: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    const graph = await loadProjectGraph(root);
    if (!graph) { console.log('Project not indexed. Run `code-intel index .` first.'); return; }
    const implementations = graph.implementations?.[symbol] ?? [];
    if (implementations.length === 0) { console.log(`No implementations found for "${symbol}".`); return; }
    const shown = implementations.slice(0, Number(opts.limit) || 10);
    const { client, collection } = await makeProjectQdrantClient(root, opts.qdrant);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pointMap = groupPointsBySymbol(await scrollSymbolPoints(client, collection, shown) as any[]);
    console.log(`Implementations of ${symbol}: ${implementations.length} known`);
    for (const impl of shown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.log(await renderSymbolText(root, graph, impl, pointMap.get(impl)?.[0] as any));
    }
  });

program
  .command('expand-graph <seeds...>')
  .description('BFS expand call graph from seed symbols to trace execution paths')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--hops <n>', 'Graph hops to follow', '2')
  .option('--direction <dir>', 'Direction: out|in|both', 'both')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (seeds: string[], opts: { dir: string; hops: string; direction: 'out' | 'in' | 'both'; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    const graph = await loadProjectGraph(root);
    if (!graph) { console.log('Project not indexed. Run `code-intel index .` first.'); return; }
    const { discovered, capped } = expandGraphBfs(graph, seeds, Number(opts.hops) || 2, opts.direction);
    const symbolList = [...discovered].slice(0, 60);
    console.log(`Subgraph: ${discovered.size} symbols reachable from [${seeds.join(', ')}] (${opts.hops}-hop ${opts.direction})${capped ? ' — capped at 60' : ''}`);
    const { client, collection } = await makeProjectQdrantClient(root, opts.qdrant);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allPoints = await scrollSymbolPoints(client, collection, symbolList) as any[];
    const bySymbol = new Map<string, typeof allPoints[0]>();
    for (const p of allPoints) {
      const sym = p.payload?.['symbol'] as string;
      if (!bySymbol.has(sym)) bySymbol.set(sym, p);
    }
    const ordered = [...seeds, ...symbolList.filter(s => !seeds.includes(s))];
    for (const sym of ordered) {
      console.log(await renderSymbolText(root, graph, sym, bySymbol.get(sym)));
    }
  });

program
  .command('list-symbols')
  .description('List indexed symbols grouped by file, optionally filtered by path substring')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--filter <text>', 'Only show symbols from files whose path contains this string')
  .action(async (opts: { dir: string; filter?: string }) => {
    const root = path.resolve(opts.dir);
    const graph = await loadProjectGraph(root);
    if (!graph) { console.log('Project not indexed. Run `code-intel index .` first.'); return; }
    const byFile: Record<string, string[]> = {};
    for (const [sym, filePath] of Object.entries(graph.symbolFile)) {
      if (opts.filter && !filePath.includes(opts.filter)) continue;
      (byFile[filePath] ??= []).push(sym);
    }
    if (Object.keys(byFile).length === 0) {
      console.log(opts.filter ? `No symbols found in files matching "${opts.filter}".` : 'No symbols found.');
      return;
    }
    for (const [file, syms] of Object.entries(byFile).sort()) {
      console.log(`\n${file}`);
      for (const sym of syms.sort()) {
        const out = (graph.symbols[sym] ?? []).length;
        const ins = (graph.callers?.[sym] ?? []).length;
        console.log(`  - ${sym}  (calls ${out}, calledBy ${ins})`);
      }
    }
  });

program
  .command('file-chunks <file>')
  .description('Show all indexed symbols and their graph context for a given file path')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (file: string, opts: { dir: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    const { client, collection } = await makeProjectQdrantClient(root, opts.qdrant);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { points } = await client.scroll(collection, {
      filter: { must: [{ key: 'file', match: { value: file } }] } as any,
      with_payload: true, with_vector: false, limit: 100,
    });
    if (points.length === 0) { console.log(`No chunks found for "${file}". Path must be relative to project root.`); return; }
    const graph = await loadProjectGraph(root);
    for (const p of points) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.log(await renderSymbolText(root, graph, p.payload!['symbol'] as string, p as any));
    }
  });

// ─── Code generation workflow ─────────────────────────────────────────────────

program
  .command('find-existing <description>')
  .description('Search for existing implementations before writing new code (MATCH_FOUND / PARTIAL_MATCH / SAFE_TO_CREATE)')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--limit <n>', 'Max matches to return', '6')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (description: string, opts: { dir: string; limit: string; qdrant: string }) => {
    const result = await findExisting(path.resolve(opts.dir), description, opts.qdrant, Number(opts.limit) || 6);
    console.log(renderFindExisting(result));
  });

program
  .command('placement <description>')
  .description('Recommend the best module for placing new code (use after find-existing returns SAFE_TO_CREATE)')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--top-n <n>', 'Number of module recommendations', '3')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (description: string, opts: { dir: string; topN: string; qdrant: string }) => {
    const result = await whereShouldThisLive(path.resolve(opts.dir), description, opts.qdrant, Number(opts.topN) || 3);
    console.log(renderPlacementOracle(result));
  });

program
  .command('validate-intent <description>')
  .description('Check whether a proposed change aligns with project intent (HIGH / MEDIUM / LOW verdict)')
  .option('--dir <path>', 'Project root directory', '.')
  .action(async (description: string, opts: { dir: string }) => {
    const result = await validateIntent(path.resolve(opts.dir), description);
    console.log(renderIntentValidation(result));
  });

program
  .command('validate-code')
  .description('Post-generation gate: validate generated code for duplicates, constraint violations, and naming')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--code <code>', 'Generated code string to validate')
  .option('--target-file <file>', 'Intended file path (relative to project root)')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; code?: string; targetFile?: string; qdrant: string }) => {
    if (!opts.code) { console.log('Provide generated code via --code <code>'); return; }
    const result = await validateGeneratedCode(path.resolve(opts.dir), opts.code, opts.targetFile, opts.qdrant);
    console.log(renderCodeValidation(result));
  });

program
  .command('module-conventions <module>')
  .description('Show per-module style guide: naming prefixes, async conventions, export patterns')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (moduleName: string, opts: { dir: string; qdrant: string }) => {
    const conventions = await getModuleConventions(path.resolve(opts.dir), moduleName, opts.qdrant);
    if (!conventions) { console.log(`No indexed symbols found for module "${moduleName}".`); return; }
    console.log(renderModuleConventions(conventions));
  });

// ─── Feature brief ────────────────────────────────────────────────────────────

program
  .command('feature-brief <feature>')
  .description('Project-engineer brief for one feature area: docs, code anchors, rationale, hotspots')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--format <format>', 'Output format: text|json', 'text')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (feature: string, opts: { dir: string; format: 'text' | 'json'; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    const graph = await loadProjectGraph(root);
    if (!graph) { console.log('Project not indexed. Run `code-intel index .` first.'); return; }
    await syncProjectMemory(root, opts.qdrant);
    const brief = await buildFeatureBrief(root, feature, opts.qdrant);
    if (opts.format === 'json') {
      console.log(JSON.stringify(serializeFeatureBriefResponse(brief), null, 2));
      return;
    }
    console.log(renderFeatureBrief(brief));
  });

// ─── Attention cognition ──────────────────────────────────────────────────────

program
  .command('attention')
  .description('Attention snapshot: module tiers and composite scores')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--refresh', 'Recompute attention snapshot', false)
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .option('--limit <n>', 'Max modules to show', '10')
  .action(async (opts: { dir: string; refresh: boolean; qdrant: string; limit: string }) => {
    const root = path.resolve(opts.dir);
    if (opts.refresh) await syncProjectMemory(root, opts.qdrant);
    const snapshot = await attentionOverviewAsync(root) ?? await refreshAttentionAsync(root);
    if (!snapshot) { console.log('No attention snapshot. Run `code-intel index .` first.'); return; }
    console.log(`Attention generated: ${snapshot.generatedAt}`);
    console.log(`Modules scored: ${snapshot.modules.length}  Symbols scored: ${snapshot.symbols.length}`);
    console.log('\nTop Attention Modules:');
    snapshot.modules.slice(0, Number(opts.limit) || 10).forEach(m =>
      console.log(`  ${m.module}: ${m.tier} (${m.score.composite.toFixed(3)})`));
  });

program
  .command('attention-score <target>')
  .description('Detailed attention breakdown for a module or symbol')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (target: string, opts: { dir: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    const score = await attentionScoreAsync(root, target);
    if (!score) { console.log(`No attention score found for "${target}".`); return; }
    if ('score' in score) {
      console.log(`Module: ${score.module}`);
      console.log(`Tier: ${score.tier}`);
      const s = score.score;
      console.log(`Structural: ${s.structural.toFixed(3)}  Temporal: ${s.temporal.toFixed(3)}  Behavioral: ${s.behavioral.toFixed(3)}`);
      console.log(`Failure: ${s.failure.toFixed(3)}  Volatility: ${s.volatility.toFixed(3)}  Freshness: ${s.freshness.toFixed(3)}`);
      console.log(`Centrality: ${s.centrality.toFixed(3)}  Confidence: ${s.confidence.toFixed(3)}  Composite: ${s.composite.toFixed(3)}`);
    } else {
      console.log(`Symbol: ${score.symbol}  Module: ${score.module}  Tier: ${score.tier}  Composite: ${score.composite.toFixed(3)}`);
    }
  });

program
  .command('active-zones')
  .description('Active architecture zones ordered by attention concentration')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    const zones = await activeZonesAsync(root);
    if (zones.length === 0) { console.log('No active zones found.'); return; }
    zones.forEach(z => console.log(`${z.zone}: ${z.modules.join(', ')}`));
  });

program
  .command('regression-hotspots')
  .description('Failure-prone hotspots correlated from historical regressions')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--limit <n>', 'Max hotspots to show', '10')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; limit: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    await refreshFailureIntelligenceAsync(root);
    const failures = await historicalRegressionsAsync(root, undefined, Number(opts.limit) || 10);
    if (failures.length === 0) { console.log('No regression hotspots found.'); return; }
    failures.forEach(e => console.log(`${e.timestamp} ${e.title} :: ${e.clusterKeys.join(', ') || 'none'}`));
  });

program
  .command('embedding-priority')
  .description('Selective semantic enrichment queue based on attention tiers')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--limit <n>', 'Max symbols in queue', '30')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; limit: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    const queue = await embeddingPriorityAsync(root, Number(opts.limit) || 30);
    if (queue.length === 0) { console.log('No embedding priority data found.'); return; }
    queue.forEach(item => console.log(`${item.symbol}: tier ${item.tier}, composite ${item.composite.toFixed(3)} (${item.module})`));
  });

// ─── Reflection cognition ─────────────────────────────────────────────────────

program
  .command('reflect-change')
  .description('Reflect on a change: risk level, coupling delta, affected modules, architecture violations')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--change-id <sha>', 'Commit SHA or change id (omit for latest)')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; changeId?: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    const reflection = opts.changeId ? await reflectChangeAsync(root, opts.changeId) : await reflectLatestChangeAsync(root);
    if (!reflection) { console.log('No change found to reflect.'); return; }
    const failureLinks = (await reflectionFailuresForChangeAsync(root, reflection.changeId))
      .map(item => `${item.id} (${item.score.toFixed(2)})`).join(', ');
    console.log(`Change: ${reflection.changeId}`);
    console.log(`Summary: ${reflection.summary}`);
    console.log(`Risk level: ${reflection.riskLevel}`);
    console.log(`Coupling delta: ${reflection.couplingDelta.toFixed(3)}`);
    console.log(`Confidence: ${reflection.confidence.toFixed(3)}`);
    console.log(`Affected modules: ${reflection.affectedModules.join(', ') || 'none'}`);
    console.log(`Architecture violations: ${reflection.architectureViolations.join(', ') || 'none'}`);
    console.log(`Similar failures: ${failureLinks || 'none'}`);
  });

program
  .command('regression-risk <target>')
  .description('Estimate regression risk for a symbol, file, or module')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (target: string, opts: { dir: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    const report = await regressionRiskAsync(root, target);
    console.log(`Target: ${report.target}`);
    console.log(`Risk score: ${report.score.toFixed(3)}  Level: ${report.level}`);
    console.log(`Signals: ${report.signals.join(', ')}`);
    console.log(`Unstable modules: ${report.unstableModules.map(m => `${m.module} (${m.instability.toFixed(2)})`).join(', ') || 'none'}`);
    console.log(`Recent similar failures: ${report.recentFailures.map(f => `${f.id} (${f.score.toFixed(2)})`).join(', ') || 'none'}`);
  });

program
  .command('similar-failures <target>')
  .description('Find historical bug-memory entries similar to a target area')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--limit <n>', 'Max failures to return', '10')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (target: string, opts: { dir: string; limit: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    const failures = await findSimilarFailuresAsync(root, target, Number(opts.limit) || 10);
    if (failures.length === 0) { console.log(`No similar failures found for "${target}".`); return; }
    failures.forEach(e => {
      console.log(`${'─'.repeat(60)}`);
      console.log(`${e.timestamp} ${e.fixedBySha.slice(0, 12)} ${e.title}`);
      console.log(`Summary: ${e.summary}`);
      console.log(`Topics: ${e.topics.join(', ') || 'none'}`);
    });
  });

// ─── Failures cognition ───────────────────────────────────────────────────────

program
  .command('failure-clusters')
  .description('Cluster historical failures by recurring engineering patterns')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--limit <n>', 'Max clusters to return', '8')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; limit: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    await refreshFailureIntelligenceAsync(root);
    const clusters = await failureClustersAsync(root, Number(opts.limit) || 8);
    if (clusters.length === 0) { console.log('No failure clusters available.'); return; }
    clusters.forEach(c => {
      console.log(`${'─'.repeat(60)}`);
      console.log(`${c.label} (${c.key}) — count: ${c.count}`);
      console.log(`Recent: ${c.failures.slice(0, 5).map(f => f.title).join(' | ') || 'none'}`);
    });
  });

program
  .command('root-cause <target>')
  .description('Root cause history for a symbol/file/topic: symptoms, causes, triggers, preventive patterns')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--limit <n>', 'Max entries to return', '10')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (target: string, opts: { dir: string; limit: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    await refreshFailureIntelligenceAsync(root);
    const history = await rootCauseHistoryAsync(root, target, Number(opts.limit) || 10);
    if (history.length === 0) { console.log(`No root-cause history found for "${target}".`); return; }
    history.forEach(e => {
      console.log(`${'─'.repeat(60)}`);
      console.log(`${e.timestamp} ${e.fixedBySha.slice(0, 12)} ${e.title}`);
      console.log(`Root causes: ${e.rootCauses.join(' | ') || 'none'}`);
      console.log(`Symptoms: ${e.symptoms.join(' | ') || 'none'}`);
      console.log(`Preventive patterns: ${e.preventivePatterns.join(' | ') || 'none'}`);
    });
  });

program
  .command('historical-regressions')
  .description('List likely historical regressions, optionally scoped to a target')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--target <target>', 'Optional symbol/file/topic filter')
  .option('--limit <n>', 'Max regressions to return', '10')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; target?: string; limit: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    await refreshFailureIntelligenceAsync(root);
    const regressions = await historicalRegressionsAsync(root, opts.target, Number(opts.limit) || 10);
    if (regressions.length === 0) { console.log(opts.target ? `No historical regressions found for "${opts.target}".` : 'No historical regressions found.'); return; }
    regressions.forEach(e => {
      console.log(`${'─'.repeat(60)}`);
      console.log(`${e.timestamp} ${e.fixedBySha.slice(0, 12)} ${e.title}`);
      console.log(`Root causes: ${e.rootCauses.join(' | ') || 'none'}`);
      console.log(`Cluster keys: ${e.clusterKeys.join(', ') || 'none'}`);
    });
  });

// ─── Constraints cognition ────────────────────────────────────────────────────

program
  .command('validate-architecture')
  .description('Run architecture constraints: circular deps, unstable imports, forbidden coupling')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    const snapshot = await validateArchitectureAsync(root);
    const bySeverity = snapshot.violations.reduce<Record<string, number>>((acc, v) => { acc[v.severity] = (acc[v.severity] ?? 0) + 1; return acc; }, {});
    console.log(`Violations: ${snapshot.violations.length}  (high=${bySeverity['high'] ?? 0}, medium=${bySeverity['medium'] ?? 0}, low=${bySeverity['low'] ?? 0})`);
    snapshot.violations.slice(0, 15).forEach(v => console.log(`  [${v.severity}] ${v.rule}: ${v.details}`));
  });

program
  .command('constraint-violations')
  .description('List architecture constraint violations, optionally filtered by severity')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--severity <level>', 'Filter by severity: low|medium|high')
  .option('--limit <n>', 'Max violations to show', '20')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; severity?: 'low' | 'medium' | 'high'; limit: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    const violations = await listConstraintViolationsAsync(root, { severity: opts.severity, limit: Number(opts.limit) || 20 });
    if (violations.length === 0) { console.log('No matching constraint violations found.'); return; }
    violations.forEach(v => {
      console.log(`[${v.severity}] ${v.rule}`);
      console.log(`  ${v.details}`);
      console.log(`  Modules: ${v.modules.join(' -> ') || 'none'}`);
    });
  });

program
  .command('boundary-analysis')
  .description('Analyze module boundary pressure: inbound/outbound counts, instability, coupling')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--module <module>', 'Optional module filter, e.g. "src/cognition"')
  .action(async (opts: { dir: string; module?: string }) => {
    const root = path.resolve(opts.dir);
    const analysis = await boundaryAnalysisAsync(root, opts.module);
    if (analysis.length === 0) { console.log(opts.module ? `No boundary analysis data for "${opts.module}".` : 'No boundary analysis data found.'); return; }
    analysis.forEach(item =>
      console.log(`${item.module}: inbound ${item.inbound}, outbound ${item.outbound}, instability ${item.instability.toFixed(2)}, coupling ${item.coupling.toFixed(2)}`));
  });

// ─── Evolution cognition ──────────────────────────────────────────────────────

program
  .command('architecture-drift')
  .description('Track architecture drift over time: instability, coupling, risk deltas per module')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--limit <n>', 'Max drift records to show', '10')
  .option('--no-refresh', 'Skip recomputing evolution snapshot')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; limit: string; refresh: boolean; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    if (opts.refresh !== false) await refreshEvolutionAsync(root);
    const drift = await architectureDriftAsync(root, Number(opts.limit) || 10);
    if (drift.length === 0) { console.log('No architecture drift data yet.'); return; }
    drift.forEach(item =>
      console.log(`${item.module}: instability ${item.instabilityDelta >= 0 ? '+' : ''}${item.instabilityDelta.toFixed(3)}, coupling ${item.couplingDelta >= 0 ? '+' : ''}${item.couplingDelta.toFixed(3)}, risk ${item.riskDelta >= 0 ? '+' : ''}${item.riskDelta.toFixed(3)}`));
  });

program
  .command('hotspot-analysis')
  .description('Temporal hotspots ranked by composite risk (instability, coupling, bug recurrence, churn)')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--limit <n>', 'Max hotspots to show', '10')
  .option('--topic <topic>', 'Optional module/topic filter')
  .option('--no-refresh', 'Skip recomputing evolution snapshot')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; limit: string; topic?: string; refresh: boolean; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    if (opts.refresh !== false) await refreshEvolutionAsync(root);
    const hotspots = await hotspotAnalysisAsync(root, Number(opts.limit) || 10, opts.topic);
    if (hotspots.length === 0) { console.log(opts.topic ? `No hotspots found for topic "${opts.topic}".` : 'No hotspots found.'); return; }
    hotspots.forEach(item =>
      console.log(`${item.module}: risk ${item.riskScore.toFixed(3)}, churn ${item.churn}, bugs ${item.bugs}, instability ${item.instability.toFixed(2)}`));
  });

program
  .command('instability-timeline <module>')
  .description('Show instability trend over time for a module')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--points <n>', 'Number of timeline points', '12')
  .option('--no-refresh', 'Skip recomputing evolution snapshot')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (moduleName: string, opts: { dir: string; points: string; refresh: boolean; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    if (opts.refresh !== false) await refreshEvolutionAsync(root);
    const timeline = await instabilityTimelineAsync(root, moduleName, Number(opts.points) || 12);
    if (timeline.length === 0) { console.log(`No instability timeline for module "${moduleName}".`); return; }
    timeline.forEach(pt =>
      console.log(`${pt.at}: instability ${pt.instability.toFixed(3)}, coupling ${pt.coupling.toFixed(3)}, bugs ${pt.bugs}, churn ${pt.churn}, risk ${pt.risk.toFixed(3)}`));
  });

// ─── Governance cognition ─────────────────────────────────────────────────────

program
  .command('memory-health')
  .description('Report governance health of long-lived memory: stale count, contradictions, avg confidence')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--no-refresh', 'Skip recomputing governance snapshot')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; refresh: boolean; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    if (opts.refresh !== false) await refreshMemoryGovernanceAsync(root);
    const health = await memoryHealthAsync(root);
    console.log(`Total entries: ${health.totalEntries}`);
    console.log(`Stale entries: ${health.staleEntries}`);
    console.log(`Contradicted entries: ${health.contradictedEntries}`);
    console.log(`Average confidence: ${health.averageConfidence.toFixed(3)}`);
  });

program
  .command('contradiction-report')
  .description('List memory entries with detected contradictions against architecture/failure evidence')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--limit <n>', 'Max entries to show', '20')
  .option('--no-refresh', 'Skip recomputing governance snapshot')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; limit: string; refresh: boolean; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    if (opts.refresh !== false) await refreshMemoryGovernanceAsync(root);
    const entries = await contradictionReportAsync(root, Number(opts.limit) || 20);
    if (entries.length === 0) { console.log('No memory contradictions detected.'); return; }
    entries.forEach(e => {
      console.log(`${'─'.repeat(60)}`);
      console.log(`${e.id}  kind=${e.kind}, confidence=${e.confidence.toFixed(3)}`);
      console.log(`Contradictions: ${e.contradictions.join(' | ')}`);
    });
  });

program
  .command('stale-memory')
  .description('List stale memory entries for revalidation due to age-related decay or low confidence')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--limit <n>', 'Max entries to show', '20')
  .option('--no-refresh', 'Skip recomputing governance snapshot')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; limit: string; refresh: boolean; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    if (opts.refresh !== false) await refreshMemoryGovernanceAsync(root);
    const entries = await staleMemoryAsync(root, Number(opts.limit) || 20);
    if (entries.length === 0) { console.log('No stale memory entries found.'); return; }
    entries.forEach(e => {
      console.log(`${'─'.repeat(60)}`);
      console.log(`${e.id}  kind=${e.kind}, confidence=${e.confidence.toFixed(3)}, decay=${e.decayScore.toFixed(3)}`);
      console.log(`Last validated: ${e.lastValidatedAt}`);
    });
  });

// ─── Agent ops ────────────────────────────────────────────────────────────────

program
  .command('cognition-gate')
  .description('Pre-generation cognition pass: architecture, risk, failures, constraints, hotspots, memory')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--target <target>', 'Optional symbol/file/module for focused risk and failure lookup')
  .option('--topic <topic>', 'Optional subsystem/topic filter')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; target?: string; topic?: string; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    await syncProjectMemory(root, opts.qdrant);
    const architecture = await refreshArchitectureAsync(root);
    const constraints = await validateArchitectureAsync(root);
    await refreshFailureIntelligenceAsync(root);
    await refreshEvolutionAsync(root);
    await refreshMemoryGovernanceAsync(root);
    const focusedTarget = opts.target ?? opts.topic ?? architecture?.modules[0]?.name ?? 'project';
    const risk = await regressionRiskAsync(root, focusedTarget);
    const hotspots = await hotspotAnalysisAsync(root, 5, opts.topic);
    const drift = await architectureDriftAsync(root, 5);
    const memory = await memoryHealthAsync(root);
    console.log(`Gate target: ${focusedTarget}`);
    console.log(architecture ? `Architecture: ${architecture.modules.length} modules, ${architecture.dependencies.length} dependencies` : 'Architecture: unavailable');
    console.log(`Constraint violations: ${constraints.violations.length}`);
    console.log(`Regression risk: ${risk.score.toFixed(3)} (${risk.level})`);
    console.log(`Risk signals: ${risk.signals.join(', ')}`);
    console.log(`Temporal hotspots: ${hotspots.map(h => `${h.module} (${h.riskScore.toFixed(2)})`).join(', ') || 'none'}`);
    console.log(`Architecture drift: ${drift.map(d => `${d.module} (${d.riskDelta >= 0 ? '+' : ''}${d.riskDelta.toFixed(2)})`).join(', ') || 'none'}`);
    console.log(`Memory health: stale=${memory.staleEntries}, contradicted=${memory.contradictedEntries}, avgConfidence=${memory.averageConfidence.toFixed(3)}`);
  });

program
  .command('cognition-diff')
  .description('Compact cognition-state delta summary for the current branch')
  .option('--dir <path>', 'Project root directory', '.')
  .action(async (opts: { dir: string }) => {
    const diff = await cognitionDiff(path.resolve(opts.dir));
    console.log(`Generated: ${diff.generatedAt}`);
    console.log(`Branch: ${diff.branch ?? 'n/a'}  Indexed at: ${diff.indexedAt ?? 'unknown'}`);
    console.log(`Critical attention modules: ${diff.attentionCritical}`);
    console.log(`Constraint violations: ${diff.constraints}`);
    console.log(`Stale memory entries: ${diff.staleMemory}`);
    console.log(`Top hotspots: ${diff.topHotspots.join(', ') || 'none'}`);
  });

program
  .command('compare-branches <targetBranch>')
  .description('Compare cognition snapshots between current branch and a target branch')
  .option('--dir <path>', 'Project root directory', '.')
  .action(async (targetBranch: string, opts: { dir: string }) => {
    const cmp = await compareBranchCognition(path.resolve(opts.dir), targetBranch);
    if (!cmp.current && !cmp.target) { console.log('No branch-scoped cognition snapshots found.'); return; }
    console.log(`Current: ${cmp.currentBranch ?? 'n/a'}  Target: ${cmp.targetBranch}`);
    console.log(`Current: ${cmp.current ? `modules=${cmp.current.modules}, constraints=${cmp.current.constraints}, criticalAttention=${cmp.current.criticalAttention}, staleMemory=${cmp.current.staleMemory}` : 'no snapshot'}`);
    console.log(`Target:  ${cmp.target ? `modules=${cmp.target.modules}, constraints=${cmp.target.constraints}, criticalAttention=${cmp.target.criticalAttention}, staleMemory=${cmp.target.staleMemory}` : 'no snapshot'}`);
    console.log(`Delta:   modules=${cmp.deltas.modules >= 0 ? '+' : ''}${cmp.deltas.modules}, constraints=${cmp.deltas.constraints >= 0 ? '+' : ''}${cmp.deltas.constraints}, criticalAttention=${cmp.deltas.criticalAttention >= 0 ? '+' : ''}${cmp.deltas.criticalAttention}, staleMemory=${cmp.deltas.staleMemory >= 0 ? '+' : ''}${cmp.deltas.staleMemory}`);
  });

program
  .command('project-brief')
  .description('Generate a compact agent onboarding brief from cognition snapshots and project memory')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (opts: { dir: string; qdrant: string }) => {
    const brief = await generateProjectBrief(path.resolve(opts.dir), opts.qdrant);
    console.log(brief);
  });

program
  .command('task-context <task>')
  .description('One-shot task kickoff: preflight change risk, assembled context, and likely impacted tests')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--target <target>', 'Optional symbol or file for test impact')
  .option('--limit <n>', 'Max tests to return', '20')
  .option('--format <format>', 'Output format: text|json|signals', 'text')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (task: string, opts: { dir: string; target?: string; limit: string; format: 'text' | 'json' | 'signals'; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    const limit = Number(opts.limit) || 20;
    const [preflight, context, testImpact] = await Promise.all([
      buildPreflightChanges(root, opts.qdrant),
      assembleTaskContext(root, task, opts.qdrant, Math.min(20, Math.max(3, limit))),
      opts.target ? buildTestImpact(root, opts.target, limit) : Promise.resolve({ target: opts.target ?? '', tests: [] }),
    ]);
    if (opts.format === 'json' || opts.format === 'signals') {
      const signals = {
        task, generatedAt: new Date().toISOString(),
        changeSignals: { totalChangedFiles: preflight.totalChangedFiles, highRiskFiles: preflight.highRiskFiles },
        contextSignals: { dominantModules: context.topModules.slice(0, 5).map(m => m.module), semanticSnippetCount: context.semanticCode.length },
        testSignals: opts.target ? { target: testImpact.target, likelyTestCount: testImpact.tests.length } : null,
      };
      console.log(JSON.stringify(opts.format === 'signals' ? signals : { signals, preflight, context, testImpact }, null, 2));
      return;
    }
    console.log(`Task: ${task}`);
    console.log(`Changed files: ${preflight.totalChangedFiles}  High risk: ${preflight.highRiskFiles}`);
    console.log(`Dominant modules: ${context.topModules.slice(0, 5).map(m => m.module).join(', ') || 'none'}`);
    preflight.entries.slice(0, 8).forEach(e => console.log(`  ${e.path} [${e.status}] attention=${e.attentionTier} risk=${e.regressionLevel}(${e.regressionRisk.toFixed(3)})`));
    if (opts.target) {
      console.log(`\nTest Impact (${testImpact.target}): ${testImpact.tests.length} likely tests`);
      testImpact.tests.slice(0, 10).forEach(t => console.log(`  ${t.file} (score ${t.score})`));
    }
  });

program
  .command('git-changes')
  .description('Semantic change graph from working tree, commit, or ref range')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--mode <mode>', 'Source mode: working_tree|commit|range', 'working_tree')
  .option('--commit <sha>', 'Required when --mode=commit')
  .option('--base <ref>', 'Required when --mode=range. Example: main')
  .option('--head <ref>', 'Required when --mode=range. Example: HEAD')
  .option('--limit <n>', 'Max changed symbols to return', '80')
  .option('--include-noise', 'Include low-signal noise symbols', false)
  .option('--format <format>', 'Output format: text|json', 'text')
  .action(async (opts: { dir: string; mode: 'working_tree' | 'commit' | 'range'; commit?: string; base?: string; head?: string; limit: string; includeNoise: boolean; format: 'text' | 'json' }) => {
    const root = path.resolve(opts.dir);
    const graph = await loadGraphAsync(path.join(getDataDir(root), 'graph.json'));
    const result = await buildGitSemanticChangeGraph(root, graph, {
      mode: opts.mode, commitSha: opts.commit, baseRef: opts.base, headRef: opts.head,
      limit: Number(opts.limit) || 80, includeNoise: opts.includeNoise,
    });
    if (opts.format === 'json') { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(`Mode: ${result.mode}  Source: ${result.sourceRef}  Target: ${result.targetRef}`);
    console.log(`Changed files: ${result.changedFiles}`);
    console.log(`Signals: added=${result.signals.addedSymbols}, deleted=${result.signals.deletedSymbols}, modified=${result.signals.modifiedSymbols}`);
    console.log('\nTop Files:');
    result.topFiles.forEach(f => console.log(`  ${f.file} [${f.status}] changedSymbols=${f.changedSymbolCount}`));
    console.log('\nChanged Symbols:');
    result.symbols.forEach(s => {
      const refs = `callers=${s.callers.length}, callees=${s.callees.length}`;
      console.log(`  ${s.symbol} (${s.kind}) @ ${s.file} | ${refs}`);
    });
  });

// ─── Repo map ─────────────────────────────────────────────────────────────────

program
  .command('repo-map')
  .description('Generate an aider-style repo map: file→symbol→signature ranked by call-graph PageRank')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--seeds <symbols>', 'Comma-separated seed symbols or file paths to focus the map on')
  .option('--max-lines <n>', 'Maximum output lines (default: 1000)', '1000')
  .option('--no-methods', 'Exclude class methods from the map')
  .action(async (opts: { dir: string; seeds?: string; maxLines: string; methods: boolean }) => {
    const root = path.resolve(opts.dir);
    const seeds = opts.seeds ? opts.seeds.split(',').map(s => s.trim()).filter(Boolean) : [];
    const result = await buildRepoMap(root, {
      seeds,
      maxLines: Number(opts.maxLines) || 1000,
      includeMethods: opts.methods !== false,
    });
    console.log(renderRepoMap(result));
  });

program.parse();
