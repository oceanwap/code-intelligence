/**
 * recommend/cooccur — PRD US-006 P4 recommendation loop.
 *
 * v1 ships a heuristic recommender (PRD OQ-4): "top-N most-called leaves
 * after the current one". v2 (deferred) will learn from session co-occurrence.
 *
 * The recommender reads the scratchpad append-log to build a tool-pair
 * co-occurrence count and ranks the next-tool suggestions by score. When
 * the scratchpad is empty (cold start), it returns a sensible default
 * list so the agent has something to try.
 *
 * Cold start: returns the most popular 4 supercharged tools in a stable
 * order. We deliberately do NOT pretend to know the call graph from
 * cooccurrence — the heuristic is "what does an agent usually do next?"
 * not "what would the static graph suggest?".
 *
 * Determinism: counts are derived deterministically from the scratchpad
 * (sorted entries, sorted counts). The same scratchpad → same output.
 */

import * as path from 'node:path';
import { readScratchpad, type ScratchpadEntry } from '../blackboard/scratchpad.js';
import { validateGraphPath } from '../../utils/security.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A recommended next-tool entry. */
export interface Recommendation {
  tool: string;
  /** Score in [0,1]. Higher = more strongly recommended. */
  score: number;
  /** Number of times this tool was observed to follow `currentTool` in the scratchpad. */
  cooccurrenceCount: number;
}

export interface RecommendOptions {
  /** Override project root (testing). */
  projectRoot?: string;
  /** Maximum number of recommendations to return (default 4). */
  topN?: number;
  /** Restrict the candidate set to this list. */
  candidatePool?: string[];
  /**
   * Restrict the scratchpad scan to a single session. Default: scan all
   * sessions in the project's scratchpad directory. Tests pass a single
   * sessionId for determinism.
   */
  sessionId?: string;
}

const DEFAULT_TOP_N = 4;

/**
 * Curated cold-start list. Order matters: the first entry is the most
 * generally-useful next step. The list is intentionally small and stable
 * (v2 will replace it with a learned order).
 */
const COLD_START_DEFAULT: string[] = [
  'audit_symbol',
  'trace_workflow',
  'plan_refactor',
  'query_project',
];

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build the recommendation list for `currentTool` from the scratchpad
 * co-occurrence history.
 *
 * Algorithm:
 *   1. Scan the scratchpad(s) for entries whose `data.tool` is the
 *      current tool. Collect every tool that came immediately AFTER.
 *   2. Count occurrences; rank descending.
 *   3. Normalize the top score to 1.0 (so scores are comparable).
 *   4. If the scratchpad is empty (cold start), return the curated
 *      default list with score=0.5.
 *   5. Restrict to the candidate pool (when supplied). Pool-supplied
 *      tools that are not in the co-occurrence map are not added.
 *
 * Determinism: counts are derived deterministically. The output is sorted
 * by `(score desc, tool asc)`. Same scratchpad → same list.
 */
export async function recommendNextAsync(
  currentTool: string,
  opts: RecommendOptions = {},
): Promise<Recommendation[]> {
  if (!currentTool || !currentTool.trim()) return [];
  const projectRoot = path.resolve(opts.projectRoot ?? process.cwd());
  validateGraphPath(projectRoot, 'recommend_next');
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const candidatePool = opts.candidatePool;

  // ── 1. Scan scratchpad(s) ──────────────────────────────────────────────
  const counts = new Map<string, number>();
  if (opts.sessionId) {
    const entries = await readScratchpad(opts.sessionId, { projectRoot });
    accumulateAfter(entries, currentTool, counts);
  } else {
    // Multi-session scan: read every <sessionId>.json under scratchpad/.
    const dir = path.join(projectRoot, '.code-intelligence');
    const { readdir } = await import('node:fs/promises');
    let branchDirs: string[] = [];
    try {
      branchDirs = await readdir(dir);
    } catch {
      branchDirs = [];
    }
    for (const branch of branchDirs) {
      const scratchDir = path.join(dir, branch, 'scratchpad');
      let files: string[] = [];
      try {
        files = await readdir(scratchDir);
      } catch {
        files = [];
      }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const sessionId = file.replace(/\.json$/, '');
        const entries = await readScratchpad(sessionId, { projectRoot });
        accumulateAfter(entries, currentTool, counts);
      }
    }
  }

  // ── 2. Rank ────────────────────────────────────────────────────────────
  if (counts.size === 0) {
    // Cold start
    const defaults = candidatePool ? candidatePool.filter((t) => COLD_START_DEFAULT.includes(t)) : COLD_START_DEFAULT;
    return defaults.slice(0, topN).map((tool) => ({
      tool,
      score: 0.5,
      cooccurrenceCount: 0,
    }));
  }

  // Filter to candidate pool
  let entries: Array<[string, number]> = [...counts.entries()];
  if (candidatePool) {
    const pool = new Set(candidatePool);
    entries = entries.filter(([name]) => pool.has(name));
  }

  // Sort: count desc, then tool asc (deterministic)
  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

  // Cap to topN
  const top = entries.slice(0, topN);
  const maxCount = top[0]?.[1] ?? 1;
  return top.map(([tool, count]) => ({
    tool,
    score: maxCount > 0 ? count / maxCount : 0,
    cooccurrenceCount: count,
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * For every consecutive (current, next) pair in `entries` where
 * `current === currentTool`, increment the count for `next.tool`.
 */
function accumulateAfter(
  entries: ScratchpadEntry[],
  currentTool: string,
  counts: Map<string, number>,
): void {
  for (let i = 0; i < entries.length - 1; i++) {
    const cur = entries[i];
    const nxt = entries[i + 1];
    if (!cur || !nxt) continue;
    if (cur.tool === currentTool && nxt.tool) {
      counts.set(nxt.tool, (counts.get(nxt.tool) ?? 0) + 1);
    }
  }
}

/**
 * Get the default cold-start list. Exposed for testing.
 */
export function coldStartDefault(): string[] {
  return [...COLD_START_DEFAULT];
}
