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

const TEST_DB = './data/test-confidence.db';

describe('Confidence auto-upgrade', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(TEST_DB);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('should create pending_review when new confidence is lower than existing', async () => {
    await store.write({ content: 'User prefers tabs', type: 'preference', confidence: 0.9 });
    const result = await store.write({ content: 'User prefers tabs', type: 'preference', confidence: 0.5 });
    expect(result.conflict_action).toBe('created_pending_review');
  });

  it('should increment confirmation_count on pending_review conflicts', async () => {
    // Create initial high-confidence memory
    await store.write({ content: 'User prefers tabs over spaces', type: 'preference', confidence: 0.9 });
    // Create a lower-confidence conflicting memory (becomes pending_review)
    const pending = await store.write({ content: 'User prefers tabs over spaces', type: 'preference', confidence: 0.5 });
    expect(pending.conflict_action).toBe('created_pending_review');
    const pendingId = pending.memory.id;

    // Write again — should hit the pending_review memory and increment count
    const r2 = await store.write({ content: 'User prefers tabs over spaces', type: 'preference', confidence: 0.5 });
    expect(r2.conflicting_memory_id).toBe(pendingId);
    const m2 = store.get(pendingId)!;
    expect(m2.confirmation_count).toBe(1);
    expect(m2.status).toBe('pending_review');
  });

  it('should auto-promote to active after 3 confirmations', async () => {
    await store.write({ content: 'User likes dark mode', type: 'preference', confidence: 0.9 });
    const pending = await store.write({ content: 'User likes dark mode', type: 'preference', confidence: 0.5 });
    const pendingId = pending.memory.id;

    // Confirm 3 times (the pending_review memory already exists with count=0)
    await store.write({ content: 'User likes dark mode', type: 'preference', confidence: 0.5 });
    await store.write({ content: 'User likes dark mode', type: 'preference', confidence: 0.5 });
    const r3 = await store.write({ content: 'User likes dark mode', type: 'preference', confidence: 0.5 });

    const promoted = store.get(pendingId)!;
    expect(promoted.status).toBe('active');
    expect(promoted.confidence).toBe(0.8);
    expect(promoted.confirmation_count).toBe(3);
    expect(r3.conflict_action).toBe('updated_existing');
  });

  it('should not affect active memories with confirmation_count logic', async () => {
    const r1 = await store.write({ content: 'User uses VS Code', type: 'preference', confidence: 0.8 });
    expect(r1.memory.status).toBe('active');

    // Writing the same thing with equal or higher confidence should update, not use confirmation flow
    const r2 = await store.write({ content: 'User uses VS Code', type: 'preference', confidence: 0.9 });
    expect(r2.conflict_action).toBe('updated_existing');
    const updated = store.get(r2.memory.id)!;
    expect(updated.status).toBe('active');
  });
});
