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

describe('Memory events', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(TEST_DB);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(TEST_AGENTS)) fs.unlinkSync(TEST_AGENTS);
  });

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
    await store.write({ content: 'Sync event memory', type: 'project', project: 'sync-project' });
    await refreshAgentsMd(store, {
      project_key: 'sync-project',
      agents_md_path: TEST_AGENTS,
      registered_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const row = getDatabase().prepare("SELECT * FROM events WHERE event_type = 'sync'").get() as { project_key: string; source_tool: string; detail: string };
    expect(row.project_key).toBe('sync-project');
    expect(row.source_tool).toBe('sync-agents-md');
    expect(row.detail).toBe('test-events-AGENTS.md');
  });
});
