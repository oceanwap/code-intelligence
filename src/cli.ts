#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'path';
import { indexProject, queryProject } from './indexer-run.js';
import {
  getFeatureMap,
  listRecentChanges,
  queryProjectMemory,
  renderFeatureMap,
  renderMemoryQueryResults,
  renderProjectStatus,
  renderRecentChanges,
  syncProjectMemory,
  getProjectStatus,
} from './project-memory.js';

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
  .option('--qdrant <url>', 'Qdrant URL', 'http://localhost:6333')
  .action(async (question: string, opts: { dir: string; qdrant: string }) => {
    const results = await queryProject(path.resolve(opts.dir), question, opts.qdrant);
    if (!results.length) {
      console.log('No results found.');
      return;
    }

    for (const r of results) {
      const label = r.score > 0 ? `score: ${r.score.toFixed(3)}` : 'related';
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`File:   ${r.file}`);
      console.log(`Symbol: ${r.symbol} (${r.type})  [${label}]`);
      console.log('─'.repeat(60));
      console.log(r.code);
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

program.parse();
