import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { closeDatabase } from '../src/db.js';
import fs from 'node:fs';

// Mock embedding: 返回基于内容 hash 的伪向量，使不同内容产生不同向量
vi.mock('../src/embedding.js', () => ({
  getEmbedding: vi.fn().mockImplementation(async (text: string) => {
    const vec = new Array(768).fill(0);
    for (let i = 0; i < text.length && i < 768; i++) {
      vec[i] = text.charCodeAt(i) / 255;
    }
    return vec;
  }),
}));

const TEST_DB = './data/test-store.db';

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(TEST_DB);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  describe('write', () => {
    it('should create a memory and return it with an id', async () => {
      const result = await store.write({
        content: 'User prefers TypeScript over JavaScript',
        type: 'preference',
        tags: ['language', 'typescript'],
      });
      expect(result.memory.id).toBeTruthy();
      expect(result.memory.content).toBe('User prefers TypeScript over JavaScript');
      expect(result.memory.type).toBe('preference');
      expect(result.memory.tags).toEqual(['language', 'typescript']);
      expect(result.conflict_action).toBe('created');
    });
  });

  describe('search', () => {
    it('should return relevant memories by semantic search', async () => {
      await store.write({ content: 'User prefers TypeScript', type: 'preference' });
      await store.write({ content: 'Project uses Next.js', type: 'project' });

      const results = await store.search({ query: 'TypeScript', limit: 5 });
      expect(results.length).toBe(2);
      expect(results.some(r => r.content.includes('TypeScript'))).toBe(true);
    });

    it('should filter by type', async () => {
      await store.write({ content: 'User prefers TypeScript', type: 'preference' });
      await store.write({ content: 'Project uses TypeScript', type: 'project' });

      const results = await store.search({ query: 'TypeScript', type: 'preference' });
      expect(results.every(r => r.type === 'preference')).toBe(true);
    });
  });

  describe('get', () => {
    it('should retrieve a memory by id', async () => {
      const created = await store.write({ content: 'test memory', type: 'identity' });
      const found = store.get(created.memory.id);
      expect(found?.content).toBe('test memory');
    });

    it('should return null for non-existent id', () => {
      expect(store.get('non-existent')).toBeNull();
    });
  });

  describe('update', () => {
    it('should update memory content and re-embed', async () => {
      const created = await store.write({ content: 'old content', type: 'preference' });
      const updated = await store.update({ id: created.memory.id, content: 'new content' });
      expect(updated.content).toBe('new content');
      expect(updated.updated_at).not.toBe(created.memory.updated_at);
    });
  });

  describe('delete', () => {
    it('should remove a memory', async () => {
      const created = await store.write({ content: 'to delete', type: 'episode' });
      store.delete(created.memory.id);
      expect(store.get(created.memory.id)).toBeNull();
    });
  });

  describe('list', () => {
    it('should list all active memories', async () => {
      await store.write({ content: 'memory 1', type: 'identity' });
      await store.write({ content: 'memory 2', type: 'preference' });
      const all = store.list();
      expect(all).toHaveLength(2);
    });
  });

  describe('exportMarkdown', () => {
    it('should export memories as structured markdown', async () => {
      await store.write({ content: 'Full-stack developer', type: 'identity' });
      await store.write({ content: 'Prefers TypeScript', type: 'preference', tags: ['language'] });
      await store.write({ content: 'ProjectX uses Next.js', type: 'project', project: 'ProjectX' });

      const md = store.exportMarkdown();
      expect(md).toContain('# MemoryVault Export');
      expect(md).toContain('## Identity');
      expect(md).toContain('Full-stack developer');
      expect(md).toContain('## Preference');
      expect(md).toContain('Prefers TypeScript');
      expect(md).toContain('## Project');
      expect(md).toContain('ProjectX uses Next.js');
    });
  });

  describe('expires_at', () => {
    it('should store expires_at when writing', async () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const result = await store.write({
        content: 'temporary note',
        type: 'episode',
        expires_at: future,
      });
      const memory = store.get(result.memory.id);
      expect(memory?.expires_at).toBe(future);
    });

    it('should filter out expired memories from list', async () => {
      const past = new Date(Date.now() - 86400000).toISOString();
      const future = new Date(Date.now() + 86400000).toISOString();

      await store.write({ content: 'expired', type: 'episode', expires_at: past });
      await store.write({ content: 'still valid', type: 'episode', expires_at: future });
      await store.write({ content: 'no expiry', type: 'episode' });

      const all = store.list();
      expect(all).toHaveLength(2);
      expect(all.some(m => m.content === 'expired')).toBe(false);
      expect(all.some(m => m.content === 'still valid')).toBe(true);
      expect(all.some(m => m.content === 'no expiry')).toBe(true);
    });

    it('should filter out expired memories from search', async () => {
      const past = new Date(Date.now() - 86400000).toISOString();

      await store.write({ content: 'expired search target', type: 'episode', expires_at: past });
      await store.write({ content: 'active search target', type: 'episode' });

      const results = await store.search({ query: 'search target' });
      expect(results.every(r => r.content !== 'expired search target')).toBe(true);
    });
  });
});
