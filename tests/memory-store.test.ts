import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { closeDatabase } from '../src/db.js';
import fs from 'node:fs';

// Mock embedding: 返回基于内容 hash 的伪向量，使不同内容产生不同向量
vi.mock('../src/embedding.js', () => ({
  getEmbedding: vi.fn().mockImplementation(async (text: string) => {
    const vec = new Array(1536).fill(0);
    for (let i = 0; i < text.length && i < 1536; i++) {
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
      const memory = await store.write({
        content: 'User prefers TypeScript over JavaScript',
        type: 'preference',
        tags: ['language', 'typescript'],
      });
      expect(memory.id).toBeTruthy();
      expect(memory.content).toBe('User prefers TypeScript over JavaScript');
      expect(memory.type).toBe('preference');
      expect(memory.tags).toEqual(['language', 'typescript']);
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
      const found = store.get(created.id);
      expect(found?.content).toBe('test memory');
    });

    it('should return null for non-existent id', () => {
      expect(store.get('non-existent')).toBeNull();
    });
  });

  describe('update', () => {
    it('should update memory content and re-embed', async () => {
      const created = await store.write({ content: 'old content', type: 'preference' });
      const updated = await store.update({ id: created.id, content: 'new content' });
      expect(updated.content).toBe('new content');
      expect(updated.updated_at).not.toBe(created.updated_at);
    });
  });

  describe('delete', () => {
    it('should remove a memory', async () => {
      const created = await store.write({ content: 'to delete', type: 'episode' });
      store.delete(created.id);
      expect(store.get(created.id)).toBeNull();
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
});
