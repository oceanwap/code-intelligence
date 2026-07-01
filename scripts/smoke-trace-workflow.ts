#!/usr/bin/env bun
/**
 * scripts/smoke-trace-workflow.ts — Sprint 4 US-005 smoke (FR-7 + AC).
 *
 * Runs `trace_workflow` against the project root and asserts:
 *   - all 4 required fields (narrative, sequenceDiagram, hops, reasoning_chain) populated
 *   - Mermaid sequenceDiagram is parseable by the round-trip fixture
 *   - prints the required 'TRACE OK: ...' line for CI grep
 *
 * Usage:
 *   bun scripts/smoke-trace-workflow.ts [projectRoot] [symbol]
 */
import * as path from 'node:path';
import { traceWorkflowAsync, parseMermaidSequenceDiagram } from '../src/cognition/audit/trace-workflow.js';

async function main(): Promise<void> {
  const projectRoot = path.resolve(process.argv[2] ?? process.cwd());
  const symbol = process.argv[3] ?? 'renderBehaviorChecklist';

  // eslint-disable-next-line no-console
  console.log(`[smoke] trace_workflow projectRoot=${projectRoot} symbol=${symbol}`);

  const result = await traceWorkflowAsync({
    projectRoot,
    symbol,
    hops: 2,
    writeToBlackboard: false,
  });
  const data = result.data;

  const required = [
    ['narrative', Array.isArray(data.narrative)],
    ['sequenceDiagram', typeof data.sequenceDiagram === 'string' && data.sequenceDiagram.length > 0],
    ['hops', data.hops === 2 || data.hops === 3],
    ['reasoning_chain', Array.isArray(data.reasoning_chain) && data.reasoning_chain.length > 0],
  ] as const;

  let ok = true;
  for (const [name, present] of required) {
    // eslint-disable-next-line no-console
    console.log(`  ${present ? 'OK ' : 'MISS'} ${name}`);
    if (!present) ok = false;
  }

  // Round-trip the Mermaid block through the parser fixture
  let mermaidLines = 0;
  try {
    const parsed = parseMermaidSequenceDiagram(data.sequenceDiagram);
    mermaidLines = data.sequenceDiagram.split('\n').length;
    // eslint-disable-next-line no-console
    console.log(`  OK  mermaid parsed (participants=${parsed.participants.length} messages=${parsed.messages.length} notes=${parsed.notes.length})`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`  ERR mermaid parse failed: ${(error as Error).message}`);
    ok = false;
  }

  if (ok) {
    // eslint-disable-next-line no-console
    console.log(`TRACE OK: ${data.steps.length} steps; mermaid lines: ${mermaidLines}`);
    process.exit(0);
  } else {
    // eslint-disable-next-line no-console
    console.error(`TRACE FAIL: see above`);
    process.exit(1);
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`[smoke] crash:`, error);
  process.exit(2);
});
