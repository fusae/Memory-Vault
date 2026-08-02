import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { closeDatabase, getDatabase } from '../src/db.js';
import { buildRecallContext } from '../src/recall.js';
import { refreshAgentsMd } from '../src/agents-md.js';
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

const TEST_DB = './data/test-events.db';
const TEST_AGENTS = './data/test-events-AGENTS.md';
const BEGIN_MARKER = '<!-- memory-vault:begin -->';
const END_MARKER = '<!-- memory-vault:end -->';

describe('Memory events', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(TEST_DB);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(TEST_AGENTS)) fs.unlinkSync(TEST_AGENTS);
    if (fs.existsSync(`${TEST_DB}-shm`)) fs.unlinkSync(`${TEST_DB}-shm`);
    if (fs.existsSync(`${TEST_DB}-wal`)) fs.unlinkSync(`${TEST_DB}-wal`);
  });

  async function seedMemory(project = 'sync-project') {
    await store.write({ content: 'Sync event memory', type: 'project', project });
    await new Promise<void>(resolve => setImmediate(resolve));
  }

  function registration(project = 'sync-project', updatedAt = new Date().toISOString()) {
    return {
      project_key: project,
      agents_md_path: TEST_AGENTS,
      registered_at: updatedAt,
      updated_at: updatedAt,
    };
  }

  it('records write events', async () => {
    await store.write({ content: 'Write event memory', type: 'project', project: 'event-project', source_tool: 'vitest' });
    const row = getDatabase().prepare("SELECT * FROM events WHERE event_type = 'write'").get() as { project_key: string; source_tool: string; detail: string };
    expect(row.project_key).toBe('event-project');
    expect(row.source_tool).toBe('vitest');
    expect(row.detail).toContain('Write event memory');
  });

  it('records recall events', async () => {
    await store.write({ content: 'Recall event memory', type: 'project', project: 'recall-project' });
    await buildRecallContext(store, { project: 'recall-project', sourceTool: 'test-recall' });
    const row = getDatabase().prepare("SELECT * FROM events WHERE event_type = 'recall' ORDER BY id DESC LIMIT 1").get() as { project_key: string; source_tool: string };
    expect(row.project_key).toBe('recall-project');
    expect(row.source_tool).toBe('test-recall');
  });

  it('records sync events', async () => {
    await seedMemory();
    await refreshAgentsMd(store, registration());
    const row = getDatabase().prepare("SELECT * FROM events WHERE event_type = 'sync'").get() as { project_key: string; source_tool: string; detail: string };
    expect(row.project_key).toBe('sync-project');
    expect(row.source_tool).toBe('sync-agents-md');
    expect(row.detail).toBe('test-events-AGENTS.md');
  });

  it('leaves orphan begin content unchanged across repeated syncs', async () => {
    await seedMemory();
    const original = `# 用户内容\n${BEGIN_MARKER}\n残缺区块没有结束标记\n用户后面的内容\n(没有 end 标记)`;
    fs.writeFileSync(TEST_AGENTS, original, 'utf-8');

    await refreshAgentsMd(store, registration());
    await refreshAgentsMd(store, registration());

    expect(fs.readFileSync(TEST_AGENTS, 'utf-8')).toBe(original);
    const rows = getDatabase().prepare("SELECT detail FROM events WHERE event_type = 'sync'").all() as { detail: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.detail.includes('skipped_malformed'))).toBe(true);
  });

  it('leaves orphan end content unchanged and does not update project timestamp', async () => {
    await seedMemory();
    const updatedAt = '2026-01-01T00:00:00.000Z';
    getDatabase().prepare('INSERT INTO projects (project_key, agents_md_path, registered_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('sync-project', TEST_AGENTS, updatedAt, updatedAt);
    const original = `# 用户内容\n${END_MARKER}\n用户后面的内容`;
    fs.writeFileSync(TEST_AGENTS, original, 'utf-8');

    await refreshAgentsMd(store, registration('sync-project', updatedAt));

    expect(fs.readFileSync(TEST_AGENTS, 'utf-8')).toBe(original);
    const project = getDatabase().prepare('SELECT updated_at FROM projects WHERE project_key = ?').get('sync-project') as { updated_at: string };
    expect(project.updated_at).toBe(updatedAt);
    const row = getDatabase().prepare("SELECT detail FROM events WHERE event_type = 'sync' ORDER BY id DESC LIMIT 1").get() as { detail: string };
    expect(row.detail).toContain('skipped_malformed');
  });

  it('leaves double begin content unchanged', async () => {
    await seedMemory();
    const original = `# 用户内容\n${BEGIN_MARKER}\nmanaged\n${BEGIN_MARKER}\n${END_MARKER}\n用户后面的内容`;
    fs.writeFileSync(TEST_AGENTS, original, 'utf-8');

    await refreshAgentsMd(store, registration());

    expect(fs.readFileSync(TEST_AGENTS, 'utf-8')).toBe(original);
    const row = getDatabase().prepare("SELECT detail FROM events WHERE event_type = 'sync' ORDER BY id DESC LIMIT 1").get() as { detail: string };
    expect(row.detail).toContain('skipped_malformed');
  });

  it('leaves end-before-begin content unchanged', async () => {
    await seedMemory();
    const original = `# 用户内容\n${END_MARKER}\n用户中间内容\n${BEGIN_MARKER}\n用户后面的内容`;
    fs.writeFileSync(TEST_AGENTS, original, 'utf-8');

    await refreshAgentsMd(store, registration());

    expect(fs.readFileSync(TEST_AGENTS, 'utf-8')).toBe(original);
    const row = getDatabase().prepare("SELECT detail FROM events WHERE event_type = 'sync' ORDER BY id DESC LIMIT 1").get() as { detail: string };
    expect(row.detail).toContain('skipped_malformed');
  });

  it('still replaces one well-formed managed block', async () => {
    await seedMemory();
    const original = `# 用户内容\n${BEGIN_MARKER}\nold context\n${END_MARKER}\n用户后面的内容`;
    fs.writeFileSync(TEST_AGENTS, original, 'utf-8');

    await refreshAgentsMd(store, registration());

    const next = fs.readFileSync(TEST_AGENTS, 'utf-8');
    expect(next).toContain('# 用户内容');
    expect(next).toContain('Sync event memory');
    expect(next).toContain('用户后面的内容');
    expect(next).not.toContain('old context');
  });
});
