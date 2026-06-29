/**
 * Pipeline contract validation (US-002 / P1-2).
 *
 * Each pipeline stage (`indexer → graph → snapshot → embeddings`) has a zod
 * schema. Calling `validateStage(...)` parses the value and throws a typed
 * `PipelineContractError` carrying the failed field path on mismatch.
 */

import { z, type ZodTypeAny } from 'zod';
import type { CodeChunk } from './indexer.js';
import type { GraphData } from './graph.js';

export class PipelineContractError extends Error {
  public readonly stage: string;
  public readonly schema: string;
  public readonly path: string;
  public readonly code: string;
  public readonly cause: unknown;

  constructor(stage: string, schema: string, path: string, code: string, message: string, cause: unknown) {
    super(`[${stage}] pipeline contract violation (${schema}) at ${path}: ${message}`);
    this.name = 'PipelineContractError';
    this.stage = stage;
    this.schema = schema;
    this.path = path;
    this.code = code;
    this.cause = cause;
  }
}

function formatPath(p: (string | number)[]): string {
  if (p.length === 0) return '<root>';
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const seg = p[i];
    if (typeof seg === 'number') {
      out += `[${seg}]`;
    } else if (i === 0) {
      out += seg;
    } else {
      out += `.${seg}`;
    }
  }
  return out;
}

function throwForIssues(stage: string, schema: string, issues: { path: (string | number)[]; code: string; message: string }[], cause: unknown): never {
  const first = issues[0]!;
  throw new PipelineContractError(
    stage,
    schema,
    formatPath(first.path),
    first.code,
    first.message,
    cause
  );
}

export function validateStage<T>(
  stage: string,
  schemaName: string,
  value: T,
  schema: ZodTypeAny
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throwForIssues(stage, schemaName, result.error.issues as { path: (string | number)[]; code: string; message: string }[], result.error);
  }
  return result.data as T;
}

// ─── Re-exports for tests ──────────────────────────────────────────────────────
export type { CodeChunk };
export type { GraphData };

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const CodeChunkSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  symbol: z.string().min(1),
  type: z.enum(['function', 'class', 'method', 'file']),
  code: z.string(),
  imports: z.array(z.string()),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).refine(c => c.lineEnd >= c.lineStart, {
  message: 'lineEnd must be >= lineStart',
  path: ['lineEnd'],
});

export const IndexerOutputSchema = z.array(CodeChunkSchema);

const GraphCallSiteSchema = z.object({
  symbol: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
});

const SideEffectSchema = z.object({
  kind: z.string(),
  target: z.string(),
  callSite: z.object({ file: z.string(), line: z.number().int().positive() }),
  confidence: z.number().min(0).max(1),
  evidence: z.string(),
});

export const GraphDataSchema = z.object({
  symbols: z.record(z.string(), z.array(z.string())),
  callers: z.record(z.string(), z.array(z.string())),
  files: z.record(z.string(), z.array(z.string())),
  symbolFile: z.record(z.string(), z.string()),
  supertypes: z.record(z.string(), z.array(z.string())).optional(),
  subtypes: z.record(z.string(), z.array(z.string())).optional(),
  implementations: z.record(z.string(), z.array(z.string())).optional(),
  implementedFrom: z.record(z.string(), z.array(z.string())).optional(),
  entityRelations: z.record(z.string(), z.array(z.string())).optional(),
  resolvedImports: z.record(z.string(), z.array(z.string())).optional(),
  sideEffects: z.record(z.string(), z.array(SideEffectSchema)).optional(),
  callSites: z.record(z.string(), z.array(GraphCallSiteSchema)).optional(),
  calledBySites: z.record(z.string(), z.array(GraphCallSiteSchema)).optional(),
});

export const GraphOutputSchema = GraphDataSchema;

export const SnapshotOutputSchema = z.object({
  generatedAt: z.string(),
  totalSymbols: z.number().int().nonnegative(),
}).passthrough();

export const QdrantPointSchema = z.object({
  id: z.union([z.string(), z.number()]),
  vector: z.array(z.number()).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const EmbeddingsOutputSchema = z.union([
  z.array(QdrantPointSchema),
  z.object({ points: z.array(QdrantPointSchema), collection: z.string().optional() }).passthrough(),
]);

// ─── Stage validators (typed) ─────────────────────────────────────────────────

export function validateIndexerOutput(chunks: CodeChunk[]): CodeChunk[] {
  return validateStage('indexer', 'CodeChunk[]', chunks, IndexerOutputSchema);
}

export function validateGraphOutput(graph: GraphData): GraphData {
  return validateStage('graph', 'GraphData', graph, GraphDataSchema);
}

export function validateSnapshotOutput(snapshot: unknown): unknown {
  return validateStage('snapshot', 'Snapshot', snapshot, SnapshotOutputSchema);
}

export function validateEmbeddingsOutput(points: unknown): unknown {
  return validateStage('embeddings', 'QdrantPoints', points, EmbeddingsOutputSchema);
}

// ─── Snapshot writer helper (US-002 / P1-2) ────────────────────────────────────

/**
 * Write a snapshot JSON file with pipeline-contract validation. Replaces the
 * bare `Bun.write(snapshotFile, JSON.stringify(snapshot))` pattern across the
 * cognition writers so a malformed snapshot fails fast with a typed error
 * instead of silently corrupting downstream consumers.
 */
export async function saveValidatedSnapshotAsync(
  snapshotName: string,
  snapshot: unknown,
  outPath: string
): Promise<void> {
  validateSnapshotOutput(snapshot);
  await Bun.write(outPath, JSON.stringify(snapshot, null, 2));
}

/**
 * Read a snapshot JSON file with pipeline-contract validation. Used by
 * snapshot loaders so a corrupted snapshot on disk fails loudly on load
 * rather than producing silent nulls downstream.
 */
export async function loadValidatedSnapshotAsync<T = unknown>(
  snapshotName: string,
  inPath: string
): Promise<T | null> {
  const file = Bun.file(inPath);
  if (!(await file.exists())) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return null;
  }
  validateSnapshotOutput(parsed);
  return parsed as T;
}