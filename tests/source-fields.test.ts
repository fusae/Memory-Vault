import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { closeDatabase } from '../src/db.js';
import fs from 'node:fs';

vi.mock('../src/embedding.js', () => ({
  getEmbedding: vi.fn().mockImplementation(async (text: string) => {
    const vec = new Array(768).fill(0);
    for (let i = 0; i < text.length && i < 768; i++) {
      vec[i] = text.charCodeAt(i) / 255;
    }
    return vec;
  }),
}));

const TEST_DB = './data/test-source.db';

describe('Source fields', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(TEST_DB);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('should store source_conversation_id when writing', async () => {
    const result = await store.write({
      content: 'User prefers TypeScript',
      type: 'preference',
      source_tool: 'claude-code',
      source_conversation_id: 'conv-123-abc',
    });
    const memory = store.get(result.memory.id);
    expect(memory?.source_conversation_id).toBe('conv-123-abc');
    expect(memory?.source_tool).toBe('claude-code');
  });

  it('should include source_conversation_id in export', async () => {
    await store.write({
      content: 'Test memory',
      type: 'identity',
      source_conversation_id: 'conv-456',
    });
    const exported = store.export();
    expect(exported[0].source_conversation_id).toBe('conv-456');
  });

  it('should update source_conversation_id', async () => {
    const result = await store.write({ content: 'Test', type: 'identity' });
    await store.update({
      id: result.memory.id,
      source_conversation_id: 'conv-789',
    });
    const updated = store.get(result.memory.id);
    expect(updated?.source_conversation_id).toBe('conv-789');
  });

  it('should store confirmation_count as 0 by default', async () => {
    const result = await store.write({ content: 'Test memory', type: 'identity' });
    const memory = store.get(result.memory.id);
    expect(memory?.confirmation_count).toBe(0);
  });
});
