/**
 * test/scratchpad-cross-process-worker.mjs — child-process worker for the
 * F3 cross-process regression test (scratchpad-cross-process.test.ts).
 *
 * Reads PROJECT_ROOT, SESSION_ID, MARKER from the environment, writes
 * 10 × >4 KB appends to the given scratchpad sessionId in the given
 * project root, then prints JSON `{marker, count}` to stdout.
 *
 * Run via:
 *   PROJECT_ROOT=… SESSION_ID=… MARKER=… bun scratchpad-cross-process-worker.mjs
 *
 * The cross-process advisory lock lives in scratchpad.ts, so this worker
 * uses the same module the parent test imports. The worker exits with
 * status 0 on success and prints any error to stderr.
 */

import {
  appendScratchpad,
} from '../src/cognition/blackboard/scratchpad.ts';

const root = process.env.PROJECT_ROOT;
const sessionId = process.env.SESSION_ID;
const marker = process.env.MARKER ?? 'UNKNOWN';

if (!root || !sessionId) {
  console.error('PROJECT_ROOT and SESSION_ID are required env vars');
  process.exit(2);
}

const N = 10;
const filler = 'x'.repeat(5_000);

try {
  for (let i = 0; i < N; i++) {
    await appendScratchpad(sessionId, {
      ts: new Date().toISOString(),
      tool: 'cross-process-test',
      data: {
        marker,
        i,
        filler,
        codeVector: Buffer.from(filler).toString('base64'),
      },
    }, { projectRoot: root });
  }
  // Report what we wrote (not what we read back — the other child may
  // also have written to the same sessionId). The parent test is the
  // single source of truth for the total count.
  process.stdout.write(JSON.stringify({ marker, wrote: N }) + '\n');
} catch (error) {
  console.error(`worker ${marker} failed:`, error && error.message ? error.message : String(error));
  process.exit(1);
}