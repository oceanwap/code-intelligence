/**
 * One-shot smoke script — exercises the `session_scratchpad` MCP tool handler
 * logic end-to-end via the public scratchpad API (read/append/clear).
 *
 * This is the same code path the MCP tool handler uses internally.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  appendScratchpad,
  clearScratchpad,
  readScratchpad,
} from '../src/cognition/blackboard/scratchpad.js';

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cog-smoke-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, env: process.env });
  execFileSync('git', ['config', 'user.name', 'Smoke'], { cwd: dir, env: process.env });
  execFileSync('git', ['config', 'user.email', 'smoke@x.test'], { cwd: dir, env: process.env });
  fs.writeFileSync(path.join(dir, '.keep'), 'x');
  execFileSync('git', ['add', '.keep'], { cwd: dir, env: process.env });
  execFileSync('git', ['commit', '-m', 'init', '-q'], { cwd: dir, env: process.env });

  const sessionId = 'smoke-session';
  await clearScratchpad(sessionId, { projectRoot: dir });
  await appendScratchpad(sessionId, {
    ts: new Date().toISOString(),
    tool: 'render_behavior',
    data: { symbol: 'Foo.bar', effects: [] },
    reasoning: ['called via withSignals'],
    confidence_tier: 'EXTRACTED',
  }, { projectRoot: dir });

  const read = await readScratchpad(sessionId, { projectRoot: dir });
  console.log(JSON.stringify(read, null, 2));

  if (read.length !== 1 || read[0]?.tool !== 'render_behavior') {
    throw new Error('smoke: read returned unexpected content');
  }
  console.log(`SMOKE OK: session_scratchpad returned ${read.length} entry, tool=${read[0]?.tool}`);
  await clearScratchpad(sessionId, { projectRoot: dir });
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });