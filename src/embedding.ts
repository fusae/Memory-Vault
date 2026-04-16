const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const MODEL = 'nomic-embed-text';

export class OllamaUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      `Ollama embedding service not available, please run: ollama pull ${MODEL}\n` +
      `Ensure Ollama is running at ${OLLAMA_BASE_URL}`
    );
    this.name = 'OllamaUnavailableError';
    if (cause) this.cause = cause;
  }
}

export async function getEmbedding(text: string): Promise<number[]> {
  if (!text.trim()) throw new Error('Cannot embed empty text');

  let response: Response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: text }),
    });
  } catch (err: unknown) {
    throw new OllamaUnavailableError(err);
  }

  if (!response.ok) {
    throw new OllamaUnavailableError(
      new Error(`HTTP ${response.status} ${response.statusText}`)
    );
  }

  const data = (await response.json()) as { embedding: number[] };
  return data.embedding;
}
