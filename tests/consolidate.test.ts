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

const TEST_DB = './data/test-consolidate.db';

describe('Forget', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(TEST_DB);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('should archive a memory with reason', async () => {
    const result = await store.write({ content: 'to forget', type: 'episode' });
    store.forget(result.memory.id, 'no longer relevant');

    const memory = store.get(result.memory.id);
    expect(memory?.status).toBe('archived');

    const versions = store.getVersions(result.memory.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].reason).toBe('no longer relevant');
  });

  it('should use default reason when none provided', async () => {
    const result = await store.write({ content: 'forget me', type: 'preference' });
    store.forget(result.memory.id);

    const versions = store.getVersions(result.memory.id);
    expect(versions[0].reason).toBe('forgotten');
  });

  it('should hide forgotten memories from list', async () => {
    const r1 = await store.write({ content: 'keep me', type: 'preference' });
    const r2 = await store.write({ content: 'forget me', type: 'preference' });
    store.forget(r2.memory.id);

    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(r1.memory.id);
  });

  it('should throw for non-existent memory', () => {
    expect(() => store.forget('non-existent')).toThrow('Memory not found');
  });
});

describe('Consolidate', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(TEST_DB);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('should merge multiple memories into one', async () => {
    const r1 = await store.write({ content: 'likes TypeScript', type: 'preference', tags: ['lang'] });
    const r2 = await store.write({ content: 'prefers strict mode', type: 'preference', tags: ['ts'] });

    const merged = await store.consolidate(
      [r1.memory.id, r2.memory.id],
      'Prefers TypeScript with strict mode enabled'
    );

    expect(merged.content).toBe('Prefers TypeScript with strict mode enabled');
    expect(merged.type).toBe('preference');
    expect(merged.status).toBe('active');
  });

  it('should archive original memories with reason', async () => {
    const r1 = await store.write({ content: 'memory A', type: 'preference' });
    const r2 = await store.write({ content: 'memory B', type: 'preference' });

    await store.consolidate([r1.memory.id, r2.memory.id], 'merged content');

    const m1 = store.get(r1.memory.id);
    const m2 = store.get(r2.memory.id);
    expect(m1?.status).toBe('archived');
    expect(m2?.status).toBe('archived');

    const v1 = store.getVersions(r1.memory.id);
    expect(v1.some(v => v.reason === 'consolidated')).toBe(true);
  });

  it('should use the type of the first memory', async () => {
    const r1 = await store.write({ content: 'project info', type: 'project' });
    const r2 = await store.write({ content: 'more project info', type: 'project' });

    const merged = await store.consolidate([r1.memory.id, r2.memory.id], 'combined');
    expect(merged.type).toBe('project');
  });

  it('should throw if fewer than 2 memories provided', async () => {
    const r1 = await store.write({ content: 'alone', type: 'preference' });
    await expect(store.consolidate([r1.memory.id], 'merged')).rejects.toThrow('at least 2');
  });

  it('should throw for non-existent memory id', async () => {
    const r1 = await store.write({ content: 'exists', type: 'preference' });
    await expect(store.consolidate([r1.memory.id, 'non-existent'], 'merged')).rejects.toThrow('not found');
  });
});
