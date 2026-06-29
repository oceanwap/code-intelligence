import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateStage,
  validateIndexerOutput,
  validateGraphOutput,
  validateSnapshotOutput,
  validateEmbeddingsOutput,
  PipelineContractError,
  IndexerOutputSchema,
  GraphDataSchema,
  EmbeddingsOutputSchema,
  type CodeChunk,
} from '../src/pipeline-contract.js';

function makeChunk(overrides: Partial<CodeChunk> = {}): CodeChunk {
  return {
    id: 'abc123',
    file: 'src/x.ts',
    symbol: 'foo',
    type: 'function',
    code: 'export function foo() {}',
    imports: [],
    lineStart: 1,
    lineEnd: 2,
    content_hash: 'a'.repeat(64),
    ...overrides,
  };
}

function makeGraph(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbols: { foo: ['bar'] },
    callers: { bar: ['foo'] },
    files: { 'src/x.ts': ['./y'] },
    symbolFile: { foo: 'src/x.ts' },
    supertypes: {},
    subtypes: {},
    implementations: {},
    implementedFrom: {},
    entityRelations: {},
    resolvedImports: {},
    ...overrides,
  };
}

test('validateStage passes valid input', () => {
  const ok = [makeChunk()];
  const result = validateStage('indexer', 'CodeChunk[]', ok, IndexerOutputSchema);
  assert.deepEqual(result, ok);
});

test('validateStage throws PipelineContractError with .path on bad input', () => {
  const bad = [makeChunk({ id: '' })];
  try {
    validateStage('indexer', 'CodeChunk[]', bad, IndexerOutputSchema);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof PipelineContractError);
    assert.equal((err as PipelineContractError).stage, 'indexer');
    assert.equal((err as PipelineContractError).schema, 'CodeChunk[]');
    assert.equal((err as PipelineContractError).path, '[0].id');
    assert.ok((err as PipelineContractError).code.length > 0);
  }
});

test('validateIndexerOutput: positive (good chunk array)', () => {
  const chunks = [makeChunk()];
  const result = validateIndexerOutput(chunks);
  assert.equal(result.length, 1);
});

test('validateIndexerOutput: negative (lineEnd < lineStart)', () => {
  const chunks = [makeChunk({ lineStart: 5, lineEnd: 1 })];
  try {
    validateIndexerOutput(chunks);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof PipelineContractError);
    assert.equal((err as PipelineContractError).stage, 'indexer');
  }
});

test('validateIndexerOutput: negative (invalid type)', () => {
  const chunks = [makeChunk({ type: 'macro' as CodeChunk['type'] })];
  assert.throws(() => validateIndexerOutput(chunks), PipelineContractError);
});

test('validateIndexerOutput: negative (bad content_hash format)', () => {
  const chunks = [makeChunk({ content_hash: 'not-a-hash' })];
  try {
    validateIndexerOutput(chunks);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof PipelineContractError);
    assert.equal((err as PipelineContractError).path, '[0].content_hash');
  }
});

test('validateGraphOutput: positive (minimal valid graph)', () => {
  const graph = makeGraph();
  const result = validateGraphOutput(graph as never);
  assert.equal((result as { symbols: Record<string, string[]> }).symbols.foo[0], 'bar');
});

test('validateGraphOutput: negative (missing required field)', () => {
  const graph = { symbols: {} };
  try {
    validateGraphOutput(graph as never);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof PipelineContractError);
    assert.equal((err as PipelineContractError).stage, 'graph');
    assert.ok((err as PipelineContractError).path.length > 0);
  }
});

test('validateGraphOutput: negative (side effect with bad confidence)', () => {
  const graph = makeGraph({
    sideEffects: { foo: [{ kind: 'db.write', target: 'X', callSite: { file: 'x.ts', line: 1 }, confidence: 2.5, evidence: 'foo()' }] },
  });
  assert.throws(() => validateGraphOutput(graph as never), PipelineContractError);
});

test('validateSnapshotOutput: positive', () => {
  validateSnapshotOutput({ generatedAt: '2025-01-01T00:00:00Z', totalSymbols: 10, anything: 'goes' });
});

test('validateSnapshotOutput: negative (bad generatedAt)', () => {
  try {
    validateSnapshotOutput({ generatedAt: 123, totalSymbols: 0 });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof PipelineContractError);
    assert.equal((err as PipelineContractError).stage, 'snapshot');
    assert.equal((err as PipelineContractError).path, 'generatedAt');
  }
});

test('validateSnapshotOutput: negative (negative totalSymbols)', () => {
  assert.throws(
    () => validateSnapshotOutput({ generatedAt: 'now', totalSymbols: -1 }),
    (err: unknown) => err instanceof PipelineContractError && err.path === 'totalSymbols'
  );
});

test('validateEmbeddingsOutput: positive (array of points)', () => {
  const points = [
    { id: 'a', vector: [0.1, 0.2], payload: { file: 'x.ts' } },
    { id: 'b' },
  ];
  const result = validateEmbeddingsOutput(points);
  assert.equal((result as unknown[]).length, 2);
});

test('validateEmbeddingsOutput: positive (wrapped form)', () => {
  const wrapped = { points: [{ id: 'a', vector: [0.1] }], collection: 'code' };
  validateEmbeddingsOutput(wrapped);
});

test('validateEmbeddingsOutput: negative (id not string/number)', () => {
  assert.throws(
    () => validateEmbeddingsOutput([{ id: { not: 'ok' } }]),
    PipelineContractError
  );
});

test('PipelineContractError surfaces stage/schema/path/code in message', () => {
  try {
    validateStage('indexer', 'CodeChunk[]', null, IndexerOutputSchema);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof PipelineContractError);
    assert.match(err.message, /\[indexer\]/);
    assert.match(err.message, /CodeChunk\[\]/);
  }
});

test('GraphDataSchema rejects missing required fields', () => {
  const partial = { symbols: {} };
  const result = GraphDataSchema.safeParse(partial);
  assert.equal(result.success, false);
});

test('EmbeddingsOutputSchema rejects non-array non-object', () => {
  const result = EmbeddingsOutputSchema.safeParse('not a points payload');
  assert.equal(result.success, false);
});

test('PipelineContractError cause carries the original zod error', () => {
  try {
    validateStage('embeddings', 'QdrantPoints', [{ id: 42, vector: 'oops' }], EmbeddingsOutputSchema);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof PipelineContractError);
    assert.ok((err as PipelineContractError).cause !== undefined);
  }
});