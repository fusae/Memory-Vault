import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { closeDatabase } from '../src/db.js';
import fs from 'node:fs';

// For conflict detection tests, we need embeddings that produce small distances
// for similar content. We use a deterministic hash approach.
vi.mock('../src/embedding.js', () => ({
  getEmbedding: vi.fn().mockImplementation(async (text: string) => {
    const vec = new Array(768).fill(0);
    for (let i = 0; i < text.length && i < 768; i++) {
      vec[i] = text.charCodeAt(i) / 255;
    }
    return vec;
  }),
}));

const TEST_DB = './data/test-conflict.db';

describe('Conflict Detection', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(TEST_DB);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('should return conflict_action "created" for unique memories', async () => {
    const result = await store.write({ content: 'I prefer TypeScript', type: 'preference' });
    expect(result.conflict_action).toBe('created');
    expect(result.conflicting_memory_id).toBeUndefined();
  });

  it('should detect conflict with very similar content of same type', async () => {
    // Write nearly identical content — same text should have distance ~0
    const r1 = await store.write({
      content: 'User prefers dark mode',
      type: 'preference',
      confidence: 0.7,
    });

    // Write exact same content — distance will be 0
    const r2 = await store.write({
      content: 'User prefers dark mode',
      type: 'preference',
      confidence: 0.9,
    });

    // Higher confidence should update existing
    expect(r2.conflict_action).toBe('updated_existing');
    expect(r2.conflicting_memory_id).toBe(r1.memory.id);

    // Verify the original was updated
    const updated = store.get(r1.memory.id);
    expect(updated?.content).toBe('User prefers dark mode');

    // Version history should exist
    const versions = store.getVersions(r1.memory.id);
    expect(versions.length).toBeGreaterThanOrEqual(1);
  });

  it('should create pending_review when new confidence is lower', async () => {
    await store.write({
      content: 'User prefers dark mode',
      type: 'preference',
      confidence: 0.9,
    });

    const r2 = await store.write({
      content: 'User prefers dark mode',
      type: 'preference',
      confidence: 0.5,
    });

    expect(r2.conflict_action).toBe('created_pending_review');
    expect(r2.memory.status).toBe('pending_review');
  });

  it('should not conflict across different types', async () => {
    await store.write({
      content: 'TypeScript project setup',
      type: 'project',
    });

    const r2 = await store.write({
      content: 'TypeScript project setup',
      type: 'episode',
    });

    // Different types should not conflict
    expect(r2.conflict_action).toBe('created');
  });
});
