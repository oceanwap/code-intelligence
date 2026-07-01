/**
 * composite/persist — FR-5 persistence of composite scores.
 *
 * Storage layout (PRD FR-5):
 *   .code-intelligence/<branch>/composite-scores.json
 *
 * The file is a JSON object with the shape:
 *   {
 *     "lastRegeneratedAt": "<ISO 8601 timestamp>",
 *     "scores": { "<symbol>": CompositeScore, ... }
 *   }
 *
 * `scores` is keyed by symbol name. Each entry is a CompositeScore with
 * typed breakdown fields. `lastRegeneratedAt` is the wall-clock time of the
 * last successful `computeAndPersistCompositeScores` call — present so dev
 * tools and tests can spot staleness (the previous format was just the bare
 * scores map; that legacy unwrapped shape is still readable via
 * `loadCompositeScores`, see FR-11 back-compat below).
 *
 * Writes are atomic via a temp-file rename so a partial write cannot
 * corrupt the existing scores.
 *
 * No in-process cache: every `load` re-reads from disk. Memory cost is
 * bounded by graph size (one entry per indexed symbol) — fine for the
 * fixture sizes targeted in this PRD.
 *
 * Lifecycle (PRD FR-5):
 *   - scores are regenerated on indexed branch change
 *   - the indexer pipeline (`src/indexer-run.ts`) calls
 *     `computeAndPersistCompositeScores` after the 8 cognition stages
 *     complete, so every reindex refreshes both the scores and the
 *     `lastRegeneratedAt` timestamp.
 *
 * FR-11 back-compat: a file written by an older version of this module
 * (legacy unwrapped format `{ "<symbol>": CompositeScore, ... }`) is read
 * transparently — `loadCompositeScores` returns the object as the scores
 * map. Callers do not need to know which format is on disk.
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
 *
 * FR-11 back-compat: reads both the wrapped format
 * (`{ lastRegeneratedAt, scores }`) and the legacy unwrapped format
 * (`{ "<symbol>": CompositeScore, ... }`). The detection rule is "does
 * the top-level object have a `scores` sub-object whose values look like
 * CompositeScore entries?" — if yes, return `parsed.scores`; if no, treat
 * the whole parsed object as the scores map. The legacy detector is
 * intentionally permissive: any object that does NOT match the wrapped
 * shape is assumed to be legacy.
 */
export async function loadCompositeScores(opts?: CompositeScoresOptions): Promise<Record<string, CompositeScore>> {
  const file = compositeScoresPath(opts);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const obj = parsed as Record<string, unknown>;
    if (isWrappedCompositeScoresPayload(obj)) {
      const scores = obj['scores'];
      if (!scores || typeof scores !== 'object') return {};
      return scores as Record<string, CompositeScore>;
    }
    return obj as Record<string, CompositeScore>;
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
 *
 * Writes the wrapped `{ lastRegeneratedAt, scores }` shape — see the module
 * header for the rationale. `lastRegeneratedAt` is set to the current wall
 * clock at the moment of the write, so dev / QA can spot a stale file.
 * Callers can override the timestamp via `opts.lastRegeneratedAt` for
 * deterministic test output (the byte-equal test in
 * `test/composite-scoring.test.ts` relies on this).
 */
export async function saveCompositeScores(
  scores: Record<string, CompositeScore>,
  opts?: CompositeScoresOptions & { lastRegeneratedAt?: string }
): Promise<void> {
  const file = compositeScoresPath(opts);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const payload = {
    lastRegeneratedAt: opts?.lastRegeneratedAt ?? new Date().toISOString(),
    scores: sortKeysForDeterminism(scores),
  };
  const serialized = JSON.stringify(payload, null, 2);
  await fs.writeFile(tmp, serialized, 'utf8');
  await fs.rename(tmp, file);
}

/**
 * Detect the wrapped `{ lastRegeneratedAt, scores }` payload shape.
 *
 * The wrapped payload has:
 *   - a string-valued `lastRegeneratedAt`
 *   - an object-valued `scores`
 *
 * Both must be present; otherwise the file is treated as legacy unwrapped.
 * Internal helper — not exported.
 */
function isWrappedCompositeScoresPayload(obj: Record<string, unknown>): boolean {
  return typeof obj['lastRegeneratedAt'] === 'string' && typeof obj['scores'] === 'object' && obj['scores'] !== null;
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
 *   - an optional `lastRegeneratedAt` ISO timestamp to pin the on-disk
 *     file's regeneration marker (default: now()). Tests use this for
 *     deterministic byte-equal output.
 *
 * Returns the new scores map so callers don't have to re-read it.
 */
export async function computeAndPersistCompositeScores(
  graph: GraphData | null,
  entries: ProjectMemoryEntry[],
  opts?: CompositeScoresOptions & { goal?: string; computedAt?: string; lastRegeneratedAt?: string }
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