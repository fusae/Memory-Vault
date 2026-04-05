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

const TEST_DB = './data/test-dream.db';

describe('Dream / Health Stats', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(TEST_DB);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  describe('getHealthStats', () => {
    it('should return zero stats for empty store', () => {
      const stats = store.getHealthStats();
      expect(stats.total).toBe(0);
      expect(stats.pendingReviewCount).toBe(0);
      expect(stats.lowConfidenceCount).toBe(0);
      expect(stats.staleEpisodesCount).toBe(0);
      expect(stats.oldestMemory).toBeNull();
      expect(stats.newestMemory).toBeNull();
    });

    it('should return correct counts by type and status', async () => {
      await store.write({ content: 'User is a developer', type: 'identity' });
      await store.write({ content: 'Prefers dark mode', type: 'preference' });
      await store.write({ content: 'Project uses React', type: 'project' });

      const stats = store.getHealthStats();
      expect(stats.total).toBe(3);
      expect(stats.byType.identity).toBe(1);
      expect(stats.byType.preference).toBe(1);
      expect(stats.byType.project).toBe(1);
      expect(stats.byStatus.active).toBe(3);
    });

    it('should count low confidence memories', async () => {
      await store.write({ content: 'Maybe uses vim', type: 'preference', confidence: 0.3 });
      await store.write({ content: 'Definitely uses TypeScript', type: 'preference', confidence: 0.9 });

      const stats = store.getHealthStats();
      expect(stats.lowConfidenceCount).toBe(1);
    });

    it('should count pending review', async () => {
      // Create a memory, then manually set one to pending_review via update
      const r = await store.write({ content: 'Prefers tabs', type: 'preference', confidence: 0.9 });
      // Create a second memory with very different content (won't conflict)
      const r2 = await store.write({ content: 'ZZZZZ completely different text to avoid conflict detection', type: 'preference', confidence: 0.5 });
      // Manually set status to pending_review
      await store.update({ id: r2.memory.id, status: 'pending_review' });

      const stats = store.getHealthStats();
      expect(stats.pendingReviewCount).toBe(1);
    });
  });

  describe('autoOrganize', () => {
    it('should archive very low confidence unconfirmed memories', async () => {
      await store.write({ content: 'Uncertain memory', type: 'preference', confidence: 0.2 });
      await store.write({ content: 'Certain memory', type: 'preference', confidence: 0.9 });

      const result = store.autoOrganize();
      expect(result.archivedCount).toBe(1);

      const all = store.list();
      expect(all).toHaveLength(1);
      expect(all[0].content).toBe('Certain memory');
    });

    it('should not modify data when all memories are healthy', async () => {
      await store.write({ content: 'Good memory', type: 'identity', confidence: 0.8 });

      const result = store.autoOrganize();
      expect(result.expiredCount).toBe(0);
      expect(result.archivedCount).toBe(0);
    });
  });

  describe('list with options', () => {
    it('should list all statuses when includeAll is true', async () => {
      await store.write({ content: 'Active memory', type: 'identity' });
      const r = await store.write({ content: 'To forget', type: 'episode' });
      store.forget(r.memory.id, 'test');

      const active = store.list();
      expect(active).toHaveLength(1);

      const all = store.list(undefined, undefined, { includeAll: true });
      expect(all).toHaveLength(2);
    });

    it('should filter by specific status', async () => {
      await store.write({ content: 'Active memory', type: 'identity' });
      const r = await store.write({ content: 'To archive', type: 'episode' });
      store.forget(r.memory.id, 'test');

      const archived = store.list(undefined, undefined, { status: 'archived' });
      expect(archived).toHaveLength(1);
      expect(archived[0].status).toBe('archived');
    });
  });
});

describe('MCP memory_dream tool', () => {
  it('should be registered', async () => {
    const mod = await import('../src/index.js');
    const server = mod.server as any;
    const tools = server._registeredTools;
    expect('memory_dream' in tools).toBe(true);
  });
});
