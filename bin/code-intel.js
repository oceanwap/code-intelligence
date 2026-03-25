#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const dir = dirname(fileURLToPath(import.meta.url));
const tsx = resolve(dir, '../node_modules/.bin/tsx');
const cli = resolve(dir, '../src/cli.ts');

const { status } = spawnSync(tsx, [cli, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(status ?? 1);
