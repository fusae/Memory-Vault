import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { closeDatabase, getDatabase } from '../src/db.js';
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

const TEST_DB = './data/test-synthesize.db';

describe('getRecentMemories', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(TEST_DB);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('should return memories updated since the given date', async () => {
    await store.write({ content: 'Recent memory', type: 'preference' });
    await store.write({ content: 'Another recent', type: 'identity' });

    const since = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    const recent = store.getRecentMemories(since);
    expect(recent).toHaveLength(2);
    expect(recent.some(m => m.content === 'Recent memory')).toBe(true);
    expect(recent.some(m => m.content === 'Another recent')).toBe(true);
  });

  it('should return empty array when no memories are in range', async () => {
    await store.write({ content: 'Old memory', type: 'preference' });

    // Manually backdate the memory
    const db = getDatabase();
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE memories SET updated_at = ?').run(oldDate);

    const since = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    const recent = store.getRecentMemories(since);
    expect(recent).toHaveLength(0);
  });

  it('should exclude archived memories', async () => {
    const r = await store.write({ content: 'To archive', type: 'episode' });
    await store.write({ content: 'Active one', type: 'preference' });
    store.forget(r.memory.id, 'test');

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const recent = store.getRecentMemories(since);
    expect(recent).toHaveLength(1);
    expect(recent[0].content).toBe('Active one');
  });

  it('should include pending_review memories', async () => {
    const r = await store.write({ content: 'Pending memory', type: 'preference' });
    await store.update({ id: r.memory.id, status: 'pending_review' });

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const recent = store.getRecentMemories(since);
    expect(recent).toHaveLength(1);
    expect(recent[0].status).toBe('pending_review');
  });
});

describe('CLI synthesize command', () => {
  beforeEach(() => {
    process.env.MEMORY_DB_PATH = TEST_DB;
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    delete process.env.MEMORY_DB_PATH;
    vi.resetModules();
  });

  it('should run synthesize and print a report', async () => {
    const { addMemory, synthesizeMemories } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await addMemory('User prefers TypeScript', { type: 'preference' });
    await addMemory('User likes dark mode', { type: 'preference' });
    logSpy.mockClear();

    synthesizeMemories({ dryRun: true });

    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('MemoryVault Synthesis Report');
    expect(output).toContain('Recent memories found: 2');
    expect(output).toContain('Dry run mode');

    logSpy.mockRestore();
  });

  it('should report untagged memories', async () => {
    const { addMemory, synthesizeMemories } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await addMemory('No tags here', { type: 'preference' });
    logSpy.mockClear();

    synthesizeMemories({ dryRun: true });

    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('Untagged memories: 1');

    logSpy.mockRestore();
  });

  it('should handle empty store gracefully', async () => {
    const { synthesizeMemories } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    synthesizeMemories({ dryRun: true });

    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('Recent memories found: 0');
    expect(output).toContain('No recent memories to synthesize');

    logSpy.mockRestore();
  });
});
