import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { closeDatabase, createDatabase, getDatabase } from '../src/db.js';
import { MemoryStore } from '../src/memory-store.js';
import { startSpaceServer } from '../src/space-server.js';
import { pushTeamMemory, retryPendingTeamMemoryPushes } from '../src/space-sync.js';
import { buildRecallContext } from '../src/recall.js';

vi.mock('../src/embedding.js', () => ({
  getEmbedding: vi.fn().mockImplementation(async (text: string) => {
    const vec = new Array(768).fill(0);
    for (let i = 0; i < text.length && i < 768; i++) {
      vec[i] = text.charCodeAt(i) / 255;
    }
    return vec;
  }),
}));

const TEST_DB = './data/test-space-sync.db';
let server: Server | undefined;

function insertTeamMemory(id: string, content: string, updatedAt: string, spaceId = 'space-a', sourceTool = 'test') {
  getDatabase().prepare(`
    INSERT INTO memories (
      id, type, content, tags, project, confidence, confirmation_count,
      source_tool, is_encrypted, status, sync_status, scope, space_id, created_at, updated_at
    )
    VALUES (?, 'rule', ?, '[]', NULL, 0.8, 0, ?, 0, 'active', 'local_only', 'team', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
  `).run(id, content, sourceTool, spaceId, updatedAt, updatedAt);
}

async function startTestServer(token = 'secret'): Promise<string> {
  await new Promise<void>(resolve => {
    server = startSpaceServer({ port: 0, token, onReady: resolve }) as Server;
  });
  const address = server!.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function stopServer() {
  if (!server) return;
  await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
}

describe('space server and sync', () => {
  beforeEach(() => {
    process.env.MEMORY_DB_PATH = TEST_DB;
    createDatabase(TEST_DB);
  });

  afterEach(async () => {
    await stopServer();
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    delete process.env.MEMORY_DB_PATH;
    vi.resetModules();
  });

  it('rejects missing bearer token with 401', async () => {
    const url = await startTestServer();
    const response = await fetch(`${url}/space/space-a/health`);
    expect(response.status).toBe(401);
  });

  it('upserts pushed memories with last-write-wins and preserves source_tool', async () => {
    const url = await startTestServer();
    const older = '2026-01-01T00:00:00.000Z';
    const newer = '2026-01-02T00:00:00.000Z';

    const first = await fetch(`${url}/space/space-a/memories`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ memory: { id: 'm1', type: 'rule', content: 'new value', tags: [], updated_at: newer, created_at: newer, source_tool: 'remote-cli' } }),
    });
    expect(first.status).toBe(200);

    await fetch(`${url}/space/space-a/memories`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ memory: { id: 'm1', type: 'rule', content: 'old value', tags: [], updated_at: older, created_at: older, source_tool: 'old-cli' } }),
    });

    const row = getDatabase().prepare('SELECT content, source_tool, updated_at FROM memories WHERE id = ?').get('m1') as { content: string; source_tool: string; updated_at: string };
    expect(row.content).toBe('new value');
    expect(row.source_tool).toBe('remote-cli');
    expect(row.updated_at).toBe(newer);
  });

  it('filters incremental pulls by since', async () => {
    const url = await startTestServer();
    insertTeamMemory('old', 'old memory', '2026-01-01T00:00:00.000Z');
    insertTeamMemory('new', 'new memory', '2026-01-03T00:00:00.000Z');

    const response = await fetch(`${url}/space/space-a/memories?since=${encodeURIComponent('2026-01-02T00:00:00.000Z')}`, {
      headers: { authorization: 'Bearer secret' },
    });
    const body = await response.json() as { memories: { id: string }[] };
    expect(body.memories.map(m => m.id)).toEqual(['new']);
  });

  it('falls back to local cache when remote is unreachable during recall', async () => {
    const store = new MemoryStore(TEST_DB);
    store.joinSpace('space-a', 'Alpha', 'http://127.0.0.1:9', 'secret');
    await store.write({ content: 'cached team memory', type: 'rule', scope: 'team', space_id: 'space-a' });

    const started = Date.now();
    const output = await buildRecallContext(store, { project: 'p', format: 'context' });

    expect(output).toContain('cached team memory');
    expect(Date.now() - started).toBeLessThan(1800);
  });

  it('retries pending team memory pushes', async () => {
    const store = new MemoryStore(TEST_DB);
    store.joinSpace('space-a', 'Alpha', 'http://127.0.0.1:9', 'secret');
    await store.write({ content: 'pending team memory', type: 'rule', scope: 'team', space_id: 'space-a' });
    const row = getDatabase().prepare("SELECT id FROM memories WHERE content = 'pending team memory'").get() as { id: string };

    await pushTeamMemory(row.id);
    expect((getDatabase().prepare('SELECT sync_status FROM memories WHERE id = ?').get(row.id) as { sync_status: string }).sync_status).toBe('pending');

    const url = await startTestServer();
    getDatabase().prepare('UPDATE spaces SET remote_url = ? WHERE space_id = ?').run(url, 'space-a');
    await retryPendingTeamMemoryPushes();

    expect((getDatabase().prepare('SELECT sync_status FROM memories WHERE id = ?').get(row.id) as { sync_status: string }).sync_status).toBe('synced');
  });
});
