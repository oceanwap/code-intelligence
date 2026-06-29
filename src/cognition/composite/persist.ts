/**
 * composite/persist — FR-5 persistence of composite scores.
 *
 * Storage layout (PRD FR-5):
 *   .code-intelligence/<branch>/composite-scores.json
 *
 * The file is a JSON object keyed by symbol name. Each entry is a
 * CompositeScore with typed breakdown fields. Writes are atomic via a
 * temp-file rename so a partial write cannot corrupt the existing scores.
 *
 * No in-process cache: every `load` re-reads from disk. Memory cost is
 * bounded by graph size (one entry per indexed symbol) — fine for the
 * fixture sizes targeted in this PRD.
 *
 * Lifecycle (PRD FR-5):
 *   - scores are regenerated on indexed branch change
 *   - we DO NOT watch git for changes here; callers regenerate after
 *     indexProject finishes. See `computeAndPersistCompositeScores`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getDataDir } from '../../git.js';
import {
  blastRadius,
  changeRisk,
  computeGraphMaxima,
  compositeScore,
  intentAlignment,
  type CompositeScore,
  type GraphMaxima,
  type MemoryStats,
  type ScoringContext,
} from './scoring.js';
import type { GraphData } from '../../graph.js';
import type { ProjectMemoryEntry } from '../../project-memory.js';

export interface CompositeScoresOptions {
  /** Override the project root (testing only). */
  projectRoot?: string;
}

/**
 * Path to the per-branch composite-scores.json file.
 *
 * Uses `getDataDir(projectRoot)` so branch-scoped layout matches the rest
 * of `.code-intelligence/<branch>/` (graph.json, attention.json, etc).
 */
export function compositeScoresPath(opts?: CompositeScoresOptions): string {
  const root = opts?.projectRoot ?? process.cwd();
  return path.join(getDataDir(root), 'composite-scores.json');
}

/**
 * Load the composite scores map for the active branch.
 *
 * Returns `{}` when the file does not exist or contains malformed JSON —
 * callers can treat the empty object as "not yet computed". Throws only
 * for I/O errors that are not ENOENT (e.g. EACCES).
 */
export async function loadCompositeScores(opts?: CompositeScoresOptions): Promise<Record<string, CompositeScore>> {
  const file = compositeScoresPath(opts);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as Record<string, CompositeScore>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/**
 * Persist composite scores atomically. Writes to `<file>.tmp` then renames.
 *
 * The atomic rename guarantees the existing file (if any) is never observed
 * in a half-written state — critical for the persistence contract per
 * FR-5 ("regenerated on indexed branch change").
 */
export async function saveCompositeScores(
  scores: Record<string, CompositeScore>,
  opts?: CompositeScoresOptions
): Promise<void> {
  const file = compositeScoresPath(opts);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const payload = JSON.stringify(sortKeysForDeterminism(scores), null, 2);
  await fs.writeFile(tmp, payload, 'utf8');
  await fs.rename(tmp, file);
}

/**
 * Return sorted-keys JSON string for stable on-disk output.
 *
 * Object key order in V8 is insertion-order; we sort to guarantee diff
 * stability across regenerations. Same input → byte-identical file.
 */
function sortKeysForDeterminism(scores: Record<string, CompositeScore>): Record<string, CompositeScore> {
  const sorted: Record<string, CompositeScore> = {};
  for (const key of Object.keys(scores).sort()) {
    sorted[key] = scores[key];
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Convenience: build MemoryStats map from ProjectMemoryEntry[]
// ---------------------------------------------------------------------------

/**
 * Build the per-symbol MemoryStats the scorers expect from raw project
 * memory entries.
 *
 * Aggregation rule: count change + bug entries whose `symbols` array
 * contains the target symbol. Document entries are skipped here — they
 * carry rationale, not churn.
 *
 * `topics` are deduplicated across all memory entries for that symbol so the
 * intent alignment scorer can do topic-token overlap.
 */
export function buildMemoryStats(entries: ProjectMemoryEntry[]): Map<string, MemoryStats> {
  const out = new Map<string, MemoryStats>();
  for (const entry of entries) {
    if (entry.kind !== 'change' && entry.kind !== 'bug') continue;
    const isFix = entry.kind === 'bug' || (entry.kind === 'change' && entry.changeType === 'fix');
    const topicSet = new Set<string>();
    for (const t of entry.topics ?? []) topicSet.add(t);
    for (const symbol of entry.symbols ?? []) {
      const existing = out.get(symbol) ?? emptyMemoryStats();
      existing.changeCount += 1;
      if (isFix) existing.fixCount += 1;
      existing.symbolHits += 1;
      const fileCount = entry.files?.length ?? 0;
      existing.fileHits = Math.max(existing.fileHits, fileCount);
      for (const t of topicSet) {
        if (!existing.topics.includes(t)) existing.topics.push(t);
      }
      out.set(symbol, existing);
    }
  }
  return out;
}

function emptyMemoryStats(): MemoryStats {
  return { changeCount: 0, fixCount: 0, symbolHits: 0, fileHits: 0, topics: [] };
}

// ---------------------------------------------------------------------------
// Convenience: build composite scores for every symbol in a graph
// ---------------------------------------------------------------------------

/**
 * Compute composite scores for every symbol in `graph` and persist them.
 *
 * Used after `indexProject` finishes to satisfy FR-5
 * ("regenerated on indexed branch change"). Callers pass:
 *   - the freshly-loaded graph
 *   - the current project memory entries
 *   - an optional goal string used for `intentAlignment`
 *
 * Returns the new scores map so callers don't have to re-read it.
 */
export async function computeAndPersistCompositeScores(
  graph: GraphData | null,
  entries: ProjectMemoryEntry[],
  opts?: CompositeScoresOptions & { goal?: string; computedAt?: string }
): Promise<Record<string, CompositeScore>> {
  const memory = buildMemoryStats(entries);
  const maxima = computeGraphMaxima(graph, memory);
  const computedAt = opts?.computedAt ?? new Date().toISOString();

  const ctx: ScoringContext = {
    graph,
    memory,
    maxima,
    ...(opts?.goal !== undefined ? { goal: opts.goal } : {}),
  };

  const scores: Record<string, CompositeScore> = {};
  const symbols = collectSymbols(graph, memory);
  for (const symbol of symbols) {
    const score = compositeScore(symbol, ctx, { goal: opts?.goal });
    score.computedAt = computedAt;
    scores[symbol] = score;
  }
  await saveCompositeScores(scores, opts);
  return scores;
}

/**
 * Score a single symbol without persisting. Useful for ad-hoc lookups
 * (e.g. `audit_symbol` will call this in Sprint 3, not Sprint 2 — kept
 * here so the public surface is stable).
 */
export function scoreSymbol(
  symbol: string,
  graph: GraphData | null,
  entries: ProjectMemoryEntry[],
  opts?: { goal?: string; maxima?: GraphMaxima }
): CompositeScore {
  const memory = buildMemoryStats(entries);
  const maxima = opts?.maxima ?? computeGraphMaxima(graph, memory);
  const ctx: ScoringContext = {
    graph,
    memory,
    maxima,
    ...(opts?.goal !== undefined ? { goal: opts.goal } : {}),
  };
  const score = compositeScore(symbol, ctx, { goal: opts?.goal });
  score.computedAt = new Date().toISOString();
  return score;
}

function collectSymbols(graph: GraphData | null, memory: Map<string, MemoryStats>): string[] {
  const set = new Set<string>();
  if (graph) {
    for (const s of Object.keys(graph.symbols ?? {})) set.add(s);
    for (const s of Object.keys(graph.callers ?? {})) set.add(s);
    for (const s of Object.keys(graph.symbolFile ?? {})) set.add(s);
  }
  for (const s of memory.keys()) set.add(s);
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// Convenience: lightweight accessor for ranking hot paths
// ---------------------------------------------------------------------------

/**
 * Load composite scores and return a Map keyed by symbol. Hot-path callers
 * (rank hookups in retriever.ts / engineering-insights.ts) prefer a Map
 * for O(1) lookup vs. an object.
 *
 * Missing file → empty Map. Caller falls back to no scoring.
 */
export async function loadCompositeScoresAsMap(opts?: CompositeScoresOptions): Promise<Map<string, CompositeScore>> {
  const obj = await loadCompositeScores(opts);
  return new Map(Object.entries(obj));
}

// Re-export scorer symbols for callers who prefer the persist.ts surface.
export {
  blastRadius,
  intentAlignment,
  changeRisk,
  compositeScore,
  computeGraphMaxima,
  type CompositeScore,
  type ScoringContext,
  type MemoryStats,
  type GraphMaxima,
};