import { queryProjectPage } from './indexer-run.js';

export interface SmartQueryOptions {
  model?: string;
  ollamaUrl?: string;
  pageSize?: number;
  qdrantUrl?: string;
  mode?: 'default' | 'architecture';
  semanticThreshold?: number;
}

export interface SmartQueryResult {
  answer: string;
}

interface OllamaStreamChunk {
  response?: string;
  done?: boolean;
  error?: string;
}

async function* readNdjsonStream(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<OllamaStreamChunk, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: true });
    }
    if (done) {
      buffer += decoder.decode();
      if (buffer.trim()) {
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          yield JSON.parse(line) as OllamaStreamChunk;
        }
      }
      break;
    }
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      yield JSON.parse(line) as OllamaStreamChunk;
    }
  }
}

async function buildQueryPrompt(
  projectRoot: string,
  question: string,
  options: SmartQueryOptions
): Promise<string> {
  const {
    qdrantUrl = 'http://localhost:6333',
    pageSize = 4,
    mode = 'default',
    semanticThreshold = 0.5,
  } = options;

  const clampedPageSize = Math.min(8, Math.max(1, pageSize));

  const response = await queryProjectPage(projectRoot, question, qdrantUrl, {
    mode,
    semanticThreshold,
    page: 1,
    pageSize: clampedPageSize,
  });

  const results = response.results;

  if (!results.length) {
    throw new NoRelevantCodeError();
  }

  const contextParts = results.map(r => {
    const lines = r.lineStart && r.lineEnd ? ` (lines ${r.lineStart}-${r.lineEnd})` : '';
    return `File: ${r.file}${lines}\nSymbol: ${r.symbol} (${r.type})\n\n\`\`\`\n${r.code}\n\`\`\`\n`;
  });

  return `You are a code intelligence assistant. Answer the user's question about the codebase using ONLY the provided code context. Be concise and accurate.\n\nQuestion: ${question}\n\nCode Context:\n\n${contextParts.join('\n---\n\n')}\n\nAnswer:`;
}

export class NoRelevantCodeError extends Error {
  constructor() {
    super('No relevant code found for this question.');
  }
}

export async function* smartQueryStream(
  projectRoot: string,
  question: string,
  options: SmartQueryOptions = {}
): AsyncGenerator<string, void, unknown> {
  const {
    model = 'qwen2.5:3b',
    ollamaUrl = 'http://localhost:11434',
  } = options;

  const prompt = await buildQueryPrompt(projectRoot, question, options);

  let res: Response;
  try {
    res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: true,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to connect to Ollama at ${ollamaUrl}: ${message}`);
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => 'Unknown error');
    throw new Error(`Ollama request failed (${res.status}): ${errorText}`);
  }

  if (!res.body) {
    throw new Error('Ollama returned an empty response body.');
  }

  const reader = res.body.getReader();
  try {
    for await (const chunk of readNdjsonStream(reader)) {
      if (chunk.error) {
        throw new Error(`Ollama error: ${chunk.error}`);
      }
      if (chunk.response) {
        yield chunk.response;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function smartQueryAsync(
  projectRoot: string,
  question: string,
  options: SmartQueryOptions = {}
): Promise<SmartQueryResult> {
  const tokens: string[] = [];
  try {
    for await (const token of smartQueryStream(projectRoot, question, options)) {
      tokens.push(token);
    }
  } catch (error) {
    if (error instanceof NoRelevantCodeError) {
      return { answer: error.message };
    }
    throw error;
  }
  return { answer: tokens.join('') };
}
