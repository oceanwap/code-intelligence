#!/usr/bin/env node
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
  getFeatureMap,
  getBugBrief,
  listRecentChanges,
  listRecentBugs,
  getWhyChanged,
  queryProjectMemory,
  renderBugBrief,
  renderFeatureMap,
  renderMemoryQueryResults,
  renderProjectStatus,
  renderRecentBugs,
  renderRecentChanges,
  renderWhyChanged,
  syncProjectMemory,
  getProjectStatus,
} from './project-memory.js';
import { serializeQueryProjectResponse } from './output-format.js';

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
    `Ranking: hybrid ${result.score.toFixed(3)} | semantic ${(result.semanticScore ?? 0).toFixed(3)}`,
  ];

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
  .action(async (dir: string, opts: { qdrant: string }) => {
    const root = path.resolve(dir);

    console.log(`Scanning ${root}...`);
    const result = await indexProject(root, opts.qdrant, (stage, done, total) => {
      if (stage === 'loading-model') {
        process.stdout.write('  Loading model  ...\r');
      } else {
        drawBar(stage === 'embedding' ? 'Embedding' : 'Storing', done, total);
      }
    });

    console.log(`  ${result.chunks} chunks extracted`);
    console.log(`  ${result.symbols} symbols, ${result.files} files in graph`);
    if (result.staleRemoved > 0) console.log(`  Removing ${result.staleRemoved} stale chunk(s)...`);
    if (result.orphansRemoved > 0) console.log(`  Removed ${result.orphansRemoved} orphaned chunk(s) from Qdrant...`);
    console.log(`  ${result.memoryEntries} project-memory entr${result.memoryEntries === 1 ? 'y' : 'ies'} indexed`);
    if (result.newMemoryEntries > 0) console.log(`  Added ${result.newMemoryEntries} new project-memory entr${result.newMemoryEntries === 1 ? 'y' : 'ies'}...`);
    if (result.staleMemoryRemoved > 0) console.log(`  Removed ${result.staleMemoryRemoved} stale project-memory entr${result.staleMemoryRemoved === 1 ? 'y' : 'ies'}...`);
    console.log('Indexing complete.');
  });

// query "<question>" --dir <project-root>
program
  .command('query <question>')
  .description('Retrieve relevant code for a natural language question')
  .option('--dir <path>', 'Project root directory', '.')
  .option('--format <format>', 'Output format: text|json', 'text')
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (question: string, opts: { dir: string; format: 'text' | 'json'; qdrant: string }) => {
    const results = await queryProject(path.resolve(opts.dir), question, opts.qdrant);
    if (!results.length) {
      console.log('No results found.');
      return;
    }

    if (opts.format === 'json') {
      console.log(JSON.stringify(serializeQueryProjectResponse(question, results), null, 2));
      return;
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
    const status = getProjectStatus(root);
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
    const entries = listRecentChanges(root, {
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
    const entries = listRecentBugs(root, {
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
    const featureMap = getFeatureMap(root);
    if (!featureMap) {
      console.log('No project memory found. Run `code-intel index .` first.');
      return;
    }

    console.log(renderFeatureMap(featureMap));
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
    const result = getAffectedSymbols(root, symbols, {
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
    const result = getRiskHotspots(root, {
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
    const result = getWhyChanged(root, {
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
    const result = getBugBrief(root, {
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
