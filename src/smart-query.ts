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

export async function smartQueryAsync(
  projectRoot: string,
  question: string,
  options: SmartQueryOptions = {}
): Promise<SmartQueryResult> {
  const {
    model = 'qwen2.5:3b',
    ollamaUrl = 'http://localhost:11434',
    pageSize = 4,
    qdrantUrl = 'http://localhost:6333',
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
    return { answer: 'No relevant code found for this question.' };
  }

  const contextParts = results.map(r => {
    const lines = r.lineStart && r.lineEnd ? ` (lines ${r.lineStart}-${r.lineEnd})` : '';
    return `File: ${r.file}${lines}\nSymbol: ${r.symbol} (${r.type})\n\n\`\`\`\n${r.code}\n\`\`\`\n`;
  });

  const prompt = `You are a code intelligence assistant. Answer the user's question about the codebase using ONLY the provided code context. Be concise and accurate.\n\nQuestion: ${question}\n\nCode Context:\n\n${contextParts.join('\n---\n\n')}\n\nAnswer:`;

  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => 'Unknown error');
      throw new Error(`Ollama request failed (${res.status}): ${errorText}`);
    }

    const data = (await res.json()) as { response?: string; error?: string };

    if (data.error) {
      throw new Error(`Ollama error: ${data.error}`);
    }

    return { answer: data.response ?? 'No response from model.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to connect to Ollama at ${ollamaUrl}: ${message}`);
  }
}
