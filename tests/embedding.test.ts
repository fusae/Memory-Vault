import { describe, it, expect, vi } from 'vitest';
import { getEmbedding } from '../src/embedding.js';

// Mock OpenAI to avoid real API calls in tests
vi.mock('openai', () => {
  return {
    default: class {
      embeddings = {
        create: vi.fn().mockResolvedValue({
          data: [{ embedding: new Array(1536).fill(0.1) }],
        }),
      };
    },
  };
});

describe('getEmbedding', () => {
  it('should return a 1536-dimension float array', async () => {
    const result = await getEmbedding('hello world');
    expect(result).toHaveLength(1536);
    expect(typeof result[0]).toBe('number');
  });

  it('should throw on empty input', async () => {
    await expect(getEmbedding('')).rejects.toThrow();
  });
});
