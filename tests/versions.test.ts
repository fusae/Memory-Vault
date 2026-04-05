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

const TEST_DB = './data/test-versions.db';

describe('Version History', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(TEST_DB);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('should save old content to version history on update', async () => {
    const result = await store.write({ content: 'original content', type: 'preference' });
    const memory = result.memory;
    await store.update({ id: memory.id, content: 'updated content', reason: 'user corrected' });

    const versions = store.getVersions(memory.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].content).toBe('original content');
    expect(versions[0].reason).toBe('user corrected');
    expect(versions[0].memory_id).toBe(memory.id);
  });

  it('should not create version entry when content is unchanged', async () => {
    const result = await store.write({ content: 'same content', type: 'preference' });
    const memory = result.memory;
    await store.update({ id: memory.id, tags: ['new-tag'] });

    const versions = store.getVersions(memory.id);
    expect(versions).toHaveLength(0);
  });

  it('should accumulate multiple versions', async () => {
    const result = await store.write({ content: 'v1', type: 'preference' });
    const memory = result.memory;
    await store.update({ id: memory.id, content: 'v2', reason: 'first update' });
    await store.update({ id: memory.id, content: 'v3', reason: 'second update' });

    const versions = store.getVersions(memory.id);
    expect(versions).toHaveLength(2);
    expect(versions[0].content).toBe('v1');
    expect(versions[1].content).toBe('v2');
  });

  it('should use default reason when none provided', async () => {
    const result = await store.write({ content: 'original', type: 'preference' });
    const memory = result.memory;
    await store.update({ id: memory.id, content: 'changed' });

    const versions = store.getVersions(memory.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].reason).toBe('updated');
  });

  it('should return empty array for memory with no versions', async () => {
    const result = await store.write({ content: 'no changes', type: 'identity' });
    const versions = store.getVersions(result.memory.id);
    expect(versions).toHaveLength(0);
  });
});
