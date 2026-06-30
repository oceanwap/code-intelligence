#!/usr/bin/env bun
/**
 * scripts/smoke-audit-symbol.ts — Sprint 3 US-004 smoke (FR-7 + acceptance).
 *
 * Runs `audit_symbol` against the project root and asserts all 8 fields
 * are populated. Exits non-zero on failure.
 *
 * Usage:
 *   bun scripts/smoke-audit-symbol.ts [projectRoot] [symbol]
 *
 * Defaults:
 *   projectRoot = process.cwd() (the code-intelligence repo)
 *   symbol      = 'renderBehaviorChecklist' (any indexed symbol)
 */
import * as path from 'node:path';
import { auditSymbolAsync } from '../src/cognition/audit/audit-symbol.js';

async function main(): Promise<void> {
  const projectRoot = path.resolve(process.argv[2] ?? process.cwd());
  const symbol = process.argv[3] ?? 'renderBehaviorChecklist';

  // eslint-disable-next-line no-console
  console.log(`[smoke] audit_symbol projectRoot=${projectRoot} symbol=${symbol}`);
  const result = await auditSymbolAsync(projectRoot, symbol, { writeToBlackboard: false });
  const data = result.data;

  const fields: Array<{ key: keyof typeof data; label: string; ok: boolean }> = [
    { key: 'behavior', label: 'behavior', ok: Array.isArray(data.behavior) },
    { key: 'risk', label: 'risk', ok: data.risk === null || typeof data.risk === 'object' },
    { key: 'impact', label: 'impact', ok: data.impact !== null && typeof data.impact === 'object' },
    { key: 'dups', label: 'dups', ok: Array.isArray(data.dups) },
    { key: 'rationale', label: 'rationale', ok: Array.isArray(data.rationale) },
    { key: 'blast_radius', label: 'blast_radius', ok: !!data.blast_radius && typeof data.blast_radius.score === 'number' },
    { key: 'action_recommendation', label: 'action_recommendation', ok: typeof data.action_recommendation === 'string' && data.action_recommendation.length > 0 },
    { key: 'reasoning_chain', label: 'reasoning_chain', ok: Array.isArray(data.reasoning_chain) && data.reasoning_chain.length > 0 },
  ];

  const populated = fields.filter(f => f.ok).length;
  const missing = fields.filter(f => !f.ok).map(f => f.label);

  for (const f of fields) {
    // eslint-disable-next-line no-console
    console.log(`  ${f.ok ? 'OK ' : 'MISS'} ${f.label}`);
  }
  // eslint-disable-next-line no-console
  console.log(`[smoke] signals=${result.signals.length} sources=${result.sources.length} reasoning=${result.reasoning.length} tier=${result.confidence_tier}`);
  // eslint-disable-next-line no-console
  console.log(`[smoke] action=${data.action_recommendation}`);

  if (populated === fields.length) {
    // eslint-disable-next-line no-console
    console.log(`AUDIT OK: 8/8 fields populated`);
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.error(`AUDIT FAIL: ${populated}/${fields.length} fields populated; missing: ${missing.join(', ')}`);
  process.exit(1);
}

main().catch(error => {
  // eslint-disable-next-line no-console
  console.error(`[smoke] crash:`, error);
  process.exit(2);
});
