#!/usr/bin/env bun
/**
 * scripts/smoke-collaborate.ts — Sprint 4 US-005 smoke (FR-7 + AC).
 *
 * Runs `collaborate` against a representative goal string and asserts:
 *   - intent classified
 *   - DAG executed
 *   - synthesized text non-empty
 *   - prints the required 'COLLAB OK: ...' line for CI grep
 *
 * Usage:
 *   bun scripts/smoke-collaborate.ts [projectRoot] [goal]
 */
import * as path from 'node:path';
import { collaborateAsync, buildDefaultToolRegistry } from '../src/cognition/audit/collaborate.js';

async function main(): Promise<void> {
  const projectRoot = path.resolve(process.argv[2] ?? process.cwd());
  const goal = process.argv[3] ?? 'audit renderBehaviorChecklist';

  // eslint-disable-next-line no-console
  console.log(`[smoke] collaborate projectRoot=${projectRoot} goal="${goal}"`);

  // Build a no-LLM registry whose leaves return stub data — the smoke
  // only checks that the meta-tool classified, picked a DAG, and ran it.
  // We bound every leaf to a stub closure that returns a tiny object.
  const stubLeaf = async () => ({ ok: true });
  const stubRegistry = buildDefaultToolRegistry((name) => {
    if ([
      'audit_symbol', 'plan_refactor', 'trace_workflow', 'render_behavior',
      'get_symbol', 'regression_risk', 'analyze_impact', 'project_status',
      'feature_map', 'repo_map', 'query_project', 'query_project_memory',
      'architecture_drift',
    ].includes(name)) {
      return stubLeaf;
    }
    return null;
  });

  const result = await collaborateAsync({
    projectRoot,
    goal,
    toolRegistry: stubRegistry,
    writeToBlackboard: false,
  });
  const data = result.data;

  // eslint-disable-next-line no-console
  console.log(`  OK  classified=${data.classified} confidence=${data.classifiedConfidence.toFixed(2)} llm=${data.llm}`);
  // eslint-disable-next-line no-console
  console.log(`  OK  dag=${data.dag.length} step(s) executed=${data.executed.length} step(s)`);
  // eslint-disable-next-line no-console
  console.log(`  OK  synthesized=${data.synthesized.length} char(s) tier=${result.confidence_tier}`);

  if (data.classified !== 'unknown' && data.executed.length > 0 && data.synthesized.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`COLLAB OK: classified='${data.classified}' executed=${data.executed.length} steps`);
    process.exit(0);
  } else {
    // eslint-disable-next-line no-console
    console.error(`COLLAB FAIL: classified=${data.classified} executed=${data.executed.length} steps`);
    process.exit(1);
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`[smoke] crash:`, error);
  process.exit(2);
});
