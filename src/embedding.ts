import OpenAI from 'openai';

const MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

export async function getEmbedding(text: string): Promise<number[]> {
  if (!text.trim()) throw new Error('Cannot embed empty text');

  const response = await getClient().embeddings.create({
    model: MODEL,
    input: text,
    dimensions: DIMENSIONS,
  });

  return response.data[0].embedding;
}
