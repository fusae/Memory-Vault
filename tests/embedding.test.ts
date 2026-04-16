import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getEmbedding, OllamaUnavailableError } from '../src/embedding.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('getEmbedding', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should return a 768-dimension float array', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: new Array(768).fill(0.1) }),
    });

    const result = await getEmbedding('hello world');
    expect(result).toHaveLength(768);
    expect(typeof result[0]).toBe('number');
  });

  it('should throw on empty input', async () => {
    await expect(getEmbedding('')).rejects.toThrow();
  });

  it('should throw OllamaUnavailableError on HTTP error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(getEmbedding('test')).rejects.toThrow(OllamaUnavailableError);
    await expect(getEmbedding('test')).rejects.toThrow('Ollama embedding service not available');
  });

  it('should throw OllamaUnavailableError on connection failure', async () => {
    mockFetch.mockRejectedValue(new Error('fetch failed'));

    await expect(getEmbedding('test')).rejects.toThrow(OllamaUnavailableError);
    await expect(getEmbedding('test')).rejects.toThrow('ollama pull nomic-embed-text');
  });
});
