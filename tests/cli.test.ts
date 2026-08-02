import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase } from '../src/db.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const TEST_TRANSCRIPT = './data/test-transcript.jsonl';
const TEST_CWD = path.join(os.tmpdir(), `memory-vault-cli-project-${process.pid}`);

function lastCreatedId(logSpy: { mock: { calls: unknown[][] } }): string {
  const call = [...logSpy.mock.calls].reverse().find(([value]) => {
    return typeof value === 'string' && value.startsWith('✓ Memory created: ');
  });
  return ((call?.[0] as string) ?? '').replace('✓ Memory created: ', '');
}

describe('CLI commands', () => {
  beforeEach(() => {
    process.env.MEMORY_DB_PATH = TEST_DB;
    fs.rmSync(TEST_CWD, { recursive: true, force: true });
    fs.mkdirSync(TEST_CWD, { recursive: true });
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(TEST_TRANSCRIPT)) fs.unlinkSync(TEST_TRANSCRIPT);
    fs.rmSync(TEST_CWD, { recursive: true, force: true });
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

  it('should extract memories from Claude Code transcript jsonl', async () => {
    const { extractMemories } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    fs.writeFileSync(
      TEST_TRANSCRIPT,
      [
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: 'I prefer concise technical writing.',
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'internal' },
              { type: 'text', text: 'Understood. I will keep responses concise.' },
              { type: 'tool_use', name: 'memory_write', input: {} },
            ],
          },
        }),
      ].join('\n')
    );

    await extractMemories({ file: TEST_TRANSCRIPT });

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('User: I prefer concise technical writing.');
    expect(output).toContain('Assistant: Understood. I will keep responses concise.');
    expect(output).not.toContain('thinking');
    expect(output).not.toContain('tool_use');

    logSpy.mockRestore();
  });

  it('should include fixed project key in extraction prompt', async () => {
    const { extractMemories } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    fs.writeFileSync(
      TEST_TRANSCRIPT,
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: 'This repo uses pnpm.',
        },
      })
    );

    await extractMemories({ file: TEST_TRANSCRIPT, projectKey: 'github.com/fusae/memory-vault' });

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('project field must use this exact value: github.com/fusae/memory-vault');
    expect(output).not.toContain('Project name if related to a specific project');

    logSpy.mockRestore();
  });

  it('should dry-run project migration without updating memories', async () => {
    const { addMemory, migrateProjects, listMemories } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await addMemory('project migration dry run', { type: 'project', project: 'Memory Vault' });
    logSpy.mockClear();

    migrateProjects({ map: 'Memory Vault=github.com/fusae/memory-vault', dryRun: true });
    expect(logSpy).toHaveBeenCalledWith(
      'Would update 1 memories from "Memory Vault" to "github.com/fusae/memory-vault".'
    );

    logSpy.mockClear();
    listMemories({ project: 'Memory Vault' });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('project migration dry run'));

    logSpy.mockRestore();
  });

  it('should migrate memory projects', async () => {
    const { addMemory, migrateProjects, listMemories } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await addMemory('project migration update', { type: 'project', project: 'Memory Vault' });
    logSpy.mockClear();

    migrateProjects({ map: 'Memory Vault=github.com/fusae/memory-vault' });
    expect(logSpy).toHaveBeenCalledWith(
      'Updated 1 memories from "Memory Vault" to "github.com/fusae/memory-vault".'
    );

    logSpy.mockClear();
    listMemories({ project: 'github.com/fusae/memory-vault' });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('project migration update'));

    logSpy.mockRestore();
  });

  it('should promote a memory to team scope and mark synced rows modified', async () => {
    const { addMemory, promoteMemory } = await import('../src/cli-commands.js');
    const { getDatabase } = await import('../src/db.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await addMemory('personal memory to promote', { type: 'project' });
    const id = lastCreatedId(logSpy);
    getDatabase().prepare("UPDATE memories SET sync_status = 'synced' WHERE id = ?").run(id);

    promoteMemory(id, { space: 'team-space' });

    const row = getDatabase().prepare('SELECT scope, space_id, sync_status FROM memories WHERE id = ?').get(id) as { scope: string; space_id: string; sync_status: string };
    expect(row.scope).toBe('team');
    expect(row.space_id).toBe('team-space');
    expect(row.sync_status).toBe('modified');

    logSpy.mockRestore();
  });

  it('should join and list spaces', async () => {
    const { joinSpace, listSpaces } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    joinSpace('space-a', { name: 'Alpha Team' });
    expect(logSpy).toHaveBeenCalledWith('✓ Space joined: space-a');

    logSpy.mockClear();
    listSpaces();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[space-a] Alpha Team'));

    logSpy.mockRestore();
  });

  it('should expand tilde in MEMORY_DB_PATH', async () => {
    const { getMemoryDbPath } = await import('../src/path-utils.js');

    expect(getMemoryDbPath('~/.memoryvault/memory.db')).toBe(
      path.join(os.homedir(), '.memoryvault', 'memory.db')
    );
  });

  it('should recall only memories for the derived project key', async () => {
    const { addMemory, recallMemories } = await import('../src/cli-commands.js');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const project = path.resolve(TEST_CWD);

    await addMemory('memory for current project', { type: 'project', project });
    await addMemory('memory for another project', { type: 'rule', project: 'other-project' });

    const output = await recallMemories({ cwd: TEST_CWD, format: 'context' });

    expect(output).toContain('memory for current project');
    expect(output).not.toContain('memory for another project');
    expect(writeSpy).toHaveBeenCalledWith(output);

    logSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('should merge team, project, and global personal memories in recall context', async () => {
    const { addMemory, joinSpace, recallMemories } = await import('../src/cli-commands.js');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const project = path.resolve(TEST_CWD);

    joinSpace('space-a', { name: 'Alpha Team' });
    await addMemory('team shared recall memory', { type: 'rule', project, scope: 'team', spaceId: 'space-a' });
    await addMemory('project scoped recall memory', { type: 'project', project });
    await addMemory('global personal recall memory', { type: 'preference' });
    await addMemory('unjoined team recall memory', { type: 'episode', scope: 'team', spaceId: 'space-b' });

    const output = await recallMemories({ cwd: TEST_CWD, format: 'context', budget: '120' });

    expect(output).toContain('[团队记忆|来源:');
    expect(output).toContain('|版本:1|置信度:');
    expect(output).toMatch(/\|memory_ref:[0-9a-f-]+@1\]/);
    expect(output).toContain('team shared recall memory');
    expect(output).toContain('project scoped recall memory');
    expect(output).toContain('global personal recall memory');
    expect(output).not.toContain('unjoined team recall memory');

    logSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('should roll unused recall budget into non-empty layers', async () => {
    const { addMemory, recallMemories } = await import('../src/cli-commands.js');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const project = path.resolve(TEST_CWD);

    await addMemory('project rollover memory one', { type: 'project', project });
    await addMemory('project rollover memory two', { type: 'rule', project });

    const output = await recallMemories({ cwd: TEST_CWD, format: 'context', budget: '70' });

    expect(output).toContain('project rollover memory one');
    expect(output).toContain('project rollover memory two');

    logSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('should sort recall memories by importance with time decay when there is no query', async () => {
    const { addMemory, recallMemories } = await import('../src/cli-commands.js');
    const { getDatabase } = await import('../src/db.js');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const project = path.resolve(TEST_CWD);

    await addMemory('old high confidence memory', { type: 'project', project, confidence: '1' });
    const oldId = lastCreatedId(logSpy);
    await addMemory('new lower confidence memory', { type: 'rule', project, confidence: '0.6' });
    const newId = lastCreatedId(logSpy);

    const db = getDatabase();
    db.prepare('UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString(), new Date().toISOString(), oldId);
    db.prepare('UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), new Date().toISOString(), newId);

    const output = await recallMemories({ cwd: TEST_CWD, format: 'context' });

    expect(output.indexOf('new lower confidence memory')).toBeLessThan(output.indexOf('old high confidence memory'));

    logSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('should silently fall back to created_at desc when recall semantic search fails', async () => {
    const { getEmbedding } = await import('../src/embedding.js');
    const { addMemory, recallMemories } = await import('../src/cli-commands.js');
    const { getDatabase } = await import('../src/db.js');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const project = path.resolve(TEST_CWD);

    await addMemory('older fallback memory', { type: 'project', project });
    const olderId = lastCreatedId(logSpy);
    await addMemory('newer fallback memory', { type: 'rule', project });
    const newerId = lastCreatedId(logSpy);

    const db = getDatabase();
    db.prepare('UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', olderId);
    db.prepare('UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?')
      .run('2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', newerId);
    vi.mocked(getEmbedding).mockRejectedValueOnce(new Error('Ollama unavailable'));

    const output = await recallMemories({ cwd: TEST_CWD, format: 'context', query: 'fallback' });

    expect(output.indexOf('newer fallback memory')).toBeLessThan(output.indexOf('older fallback memory'));

    logSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('should truncate recall output by budget', async () => {
    const { addMemory, recallMemories } = await import('../src/cli-commands.js');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const project = path.resolve(TEST_CWD);

    await addMemory('this is a long memory that should be truncated by a small token budget', { type: 'project', project });

    const output = await recallMemories({ cwd: TEST_CWD, format: 'context', budget: '10' });

    expect(output.length).toBeLessThanOrEqual(40);

    logSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('should output an empty string for empty recall results', async () => {
    const { recallMemories } = await import('../src/cli-commands.js');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const output = await recallMemories({ cwd: TEST_CWD, format: 'context' });

    expect(output).toBe('');
    expect(writeSpy).toHaveBeenCalledWith('');

    writeSpy.mockRestore();
  });

  it('should create AGENTS.md managed block from recall context', async () => {
    const { addMemory, syncAgentsMdCommand } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const project = path.resolve(TEST_CWD);
    const agentsPath = path.join(TEST_CWD, 'AGENTS.md');

    await addMemory('agents md create memory', { type: 'project', project });
    await syncAgentsMdCommand({ cwd: TEST_CWD });

    const output = fs.readFileSync(agentsPath, 'utf-8');
    expect(output).toContain('<!-- memory-vault:begin -->');
    expect(output).toContain('agents md create memory');
    expect(output).toContain('<!-- memory-vault:end -->');

    logSpy.mockRestore();
  });

  it('should include team memory prefix in AGENTS.md managed block', async () => {
    const { addMemory, joinSpace, syncAgentsMdCommand } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const agentsPath = path.join(TEST_CWD, 'AGENTS.md');
    const project = path.resolve(TEST_CWD);

    joinSpace('agents-space', { name: 'Agents Team' });
    await addMemory('agents md team memory', { type: 'rule', project, scope: 'team', spaceId: 'agents-space' });
    await syncAgentsMdCommand({ cwd: TEST_CWD });

    const output = fs.readFileSync(agentsPath, 'utf-8');
    expect(output).toContain('[团队记忆|来源:');
    expect(output).toContain('agents md team memory');

    logSpy.mockRestore();
  });

  it('should fully rewrite managed block without changing outside content', async () => {
    const { addMemory, syncAgentsMdCommand } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const project = path.resolve(TEST_CWD);
    const agentsPath = path.join(TEST_CWD, 'AGENTS.md');
    const before = 'user before\n';
    const after = '\nuser after';
    fs.writeFileSync(
      agentsPath,
      `${before}<!-- memory-vault:begin -->\nold managed content\n<!-- memory-vault:end -->${after}`,
      'utf-8'
    );

    await addMemory('agents md rewritten memory', { type: 'project', project });
    await syncAgentsMdCommand({ cwd: TEST_CWD });

    const output = fs.readFileSync(agentsPath, 'utf-8');
    expect(output.startsWith(before)).toBe(true);
    expect(output.endsWith(after)).toBe(true);
    expect(output).toContain('agents md rewritten memory');
    expect(output).not.toContain('old managed content');

    logSpy.mockRestore();
  });

  it('should register project and redact sensitive memory lines', async () => {
    const { addMemory, syncAgentsMdCommand } = await import('../src/cli-commands.js');
    const { getDatabase } = await import('../src/db.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const project = path.resolve(TEST_CWD);
    const agentsPath = path.join(TEST_CWD, 'AGENTS.md');

    await addMemory('safe agents memory', { type: 'project', project });
    await addMemory('api token should not be injected', { type: 'rule', project });
    await syncAgentsMdCommand({ cwd: TEST_CWD, redact: true });

    const row = getDatabase().prepare('SELECT * FROM projects WHERE project_key = ?').get(project) as { agents_md_path: string };
    const output = fs.readFileSync(agentsPath, 'utf-8');
    expect(row.agents_md_path).toBe(agentsPath);
    expect(output).toContain('safe agents memory');
    expect(output).not.toContain('api token should not be injected');

    logSpy.mockRestore();
  });

  it('should auto-register and refresh after writes with source cwd', async () => {
    const { MemoryStore } = await import('../src/memory-store.js');
    const { getDatabase } = await import('../src/db.js');
    const store = new MemoryStore(TEST_DB);
    const project = path.resolve(TEST_CWD);
    const agentsPath = path.join(TEST_CWD, 'AGENTS.md');

    await store.write({ content: 'auto registered memory', type: 'project', project, source_cwd: TEST_CWD });
    await new Promise(resolve => setTimeout(resolve, 50));

    const row = getDatabase().prepare('SELECT * FROM projects WHERE project_key = ?').get(project) as { agents_md_path: string };
    expect(row.agents_md_path).toBe(agentsPath);
    expect(fs.readFileSync(agentsPath, 'utf-8')).toContain('auto registered memory');
  });

  it('should silently ignore sync errors', async () => {
    const { syncAgentsMdCommand } = await import('../src/cli-commands.js');

    await expect(syncAgentsMdCommand({ cwd: '\0bad' })).resolves.toBeUndefined();
  });
});
