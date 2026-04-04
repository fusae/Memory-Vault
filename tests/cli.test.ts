import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase } from '../src/db.js';
import fs from 'node:fs';

// Mock embedding
vi.mock('../src/embedding.js', () => ({
  getEmbedding: vi.fn().mockImplementation(async (text: string) => {
    const vec = new Array(768).fill(0);
    for (let i = 0; i < text.length && i < 768; i++) {
      vec[i] = text.charCodeAt(i) / 255;
    }
    return vec;
  }),
}));

const TEST_DB = './data/test-cli.db';

describe('CLI commands', () => {
  beforeEach(() => {
    process.env.MEMORY_DB_PATH = TEST_DB;
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    delete process.env.MEMORY_DB_PATH;
    // Clear module cache so the store re-initializes with the new env
    vi.resetModules();
  });

  it('should add and list a memory', async () => {
    const { addMemory, listMemories } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await addMemory('I prefer TypeScript', { type: 'preference' });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Memory created'));

    logSpy.mockClear();
    listMemories({});
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('I prefer TypeScript'));

    logSpy.mockRestore();
  });

  it('should get a memory by id', async () => {
    const { addMemory, getMemory } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await addMemory('test memory for get', { type: 'identity' });

    // Extract the ID from the first log call
    const createCall = logSpy.mock.calls[0][0] as string;
    const id = createCall.replace('✓ Memory created: ', '');

    logSpy.mockClear();
    getMemory(id);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('test memory for get'));

    logSpy.mockRestore();
  });

  it('should delete a memory', async () => {
    const { addMemory, deleteMemory, getMemory } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await addMemory('to delete', { type: 'episode' });
    const createCall = logSpy.mock.calls[0][0] as string;
    const id = createCall.replace('✓ Memory created: ', '');

    deleteMemory(id);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Memory deleted'));

    expect(() => getMemory(id)).toThrow('exit');

    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('should search memories', async () => {
    const { addMemory, searchMemories } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await addMemory('I love functional programming', { type: 'preference' });
    await addMemory('Project uses React', { type: 'project' });
    logSpy.mockClear();

    await searchMemories('functional', {});
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('functional programming'));

    logSpy.mockRestore();
  });

  it('should export as JSON', async () => {
    const { addMemory, exportMemories } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await addMemory('export test', { type: 'identity' });
    logSpy.mockClear();

    exportMemories({});
    const output = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].content).toBe('export test');

    logSpy.mockRestore();
  });

  it('should export as markdown', async () => {
    const { addMemory, exportMemories } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await addMemory('md export test', { type: 'preference' });
    logSpy.mockClear();

    exportMemories({ format: 'markdown' });
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('# MemoryVault Export');
    expect(output).toContain('md export test');

    logSpy.mockRestore();
  });
});
