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
import { indexProject, queryProject } from './indexer-run.js';
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
import { serializeQueryProjectResponse } from './output-format.js';
import { buildProjectIntentSnapshot, renderProjectIntentSnapshot } from './project-intent.js';
import { MissingCodeIndexError } from './retriever.js';

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
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (question: string, opts: { dir: string; format: 'text' | 'json'; mode: 'default' | 'architecture'; qdrant: string }) => {
    const root = path.resolve(opts.dir);
    const mode = opts.mode === 'architecture' ? 'architecture' : 'default';
    let results: RetrievedChunk[];
    try {
      results = await queryProject(root, question, opts.qdrant, mode);
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
      console.log(JSON.stringify(serializeQueryProjectResponse(question, results, memoryFreshness), null, 2));
      return;
    }

    console.log(`Project memory refreshed: ${memoryFreshness.memoryRefreshedAt ?? 'unknown'}`);
    if (memoryFreshness.reasons.length > 0) {
      console.log(`Project memory freshness: re-index recommended (${memoryFreshness.reasons.join('; ')})`);
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

program.parse();
