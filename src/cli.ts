#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'path';
import { indexProject, queryProject } from './indexer-run.js';

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

program.parse();
