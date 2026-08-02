import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { closeDatabase, createDatabase, getDatabase } from '../src/db.js';
import { MemoryStore } from '../src/memory-store.js';
import { startSpaceServer } from '../src/space-server.js';
import { pushTeamMemory, retryPendingTeamMemoryPushes, upsertTeamMemoryFromRemote } from '../src/space-sync.js';
import { buildRecallContext } from '../src/recall.js';
import { PolicyStore } from '../src/policy-store.js';
import { SpaceKeyService } from '../src/space-crypto.js';
import { issueSpaceAccessToken, revokeMemberAccess } from '../src/space-access.js';

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

  it('enforces member-scoped reader, writer, and owner permissions', async () => {
    const ownerIdentity = SpaceKeyService.generateIdentity('owner');
    const readerIdentity = SpaceKeyService.generateIdentity('reader');
    const writerIdentity = SpaceKeyService.generateIdentity('writer');
    const keys = new SpaceKeyService(ownerIdentity);
    keys.createSpace('space-a', 'Alpha');
    keys.addMember('space-a', readerIdentity);
    keys.addMember('space-a', writerIdentity);
    const readerToken = issueSpaceAccessToken({ space_id: 'space-a', member_id: 'reader', role: 'reader', issuer_id: 'owner' });
    const writerToken = issueSpaceAccessToken({ space_id: 'space-a', member_id: 'writer', role: 'writer', issuer_id: 'owner' });
    const encryptedContent = keys.encrypt('space-a', 'member-scoped memory');
    const encryptedTags = keys.encrypt('space-a', '[]');
    const payload = {
      id: 'rbac-memory',
      type: 'rule',
      content: encryptedContent.ciphertext,
      tags: encryptedTags.ciphertext,
      is_encrypted: true,
      encryption_scheme: 'space',
      key_version: encryptedContent.key_version,
      updated_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const url = await startTestServer('bootstrap-secret');

    const readerWrite = await fetch(`${url}/space/space-a/memories`, {
      method: 'POST',
      headers: { authorization: `Bearer ${readerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ memory: payload }),
    });
    expect(readerWrite.status).toBe(403);

    const writerWrite = await fetch(`${url}/space/space-a/memories`, {
      method: 'POST',
      headers: { authorization: `Bearer ${writerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ memory: payload }),
    });
    expect(writerWrite.status).toBe(200);
    expect((await writerWrite.json() as { upserted: number }).upserted).toBe(1);
    expect((await fetch(`${url}/space/space-a/memories`, {
      headers: { authorization: `Bearer ${readerToken}` },
    })).status).toBe(200);
    expect((await fetch(`${url}/space/space-a/members`, {
      headers: { authorization: `Bearer ${writerToken}` },
    })).status).toBe(403);
    expect((await fetch(`${url}/space/space-a/members`, {
      headers: { authorization: 'Bearer bootstrap-secret' },
    })).status).toBe(200);

    revokeMemberAccess('space-a', 'reader');
    expect((await fetch(`${url}/space/space-a/health`, {
      headers: { authorization: `Bearer ${readerToken}` },
    })).status).toBe(401);
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

  it('returns a stable server cursor for incremental pulls', async () => {
    const url = await startTestServer();
    insertTeamMemory('cursor-a', 'first', '2026-01-03T00:00:00.000Z');
    insertTeamMemory('cursor-b', 'second', '2026-01-03T00:00:00.000Z');

    const first = await fetch(`${url}/space/space-a/memories`, {
      headers: { authorization: 'Bearer secret' },
    }).then(response => response.json()) as { memories: { id: string }[]; next_cursor: string };
    const second = await fetch(`${url}/space/space-a/memories?cursor=${encodeURIComponent(first.next_cursor)}`, {
      headers: { authorization: 'Bearer secret' },
    }).then(response => response.json()) as { memories: { id: string }[] };

    expect(first.memories.map(memory => memory.id)).toEqual(['cursor-a', 'cursor-b']);
    expect(first.next_cursor).toBeTruthy();
    expect(second.memories).toEqual([]);
  });

  it('creates and refreshes vectors for remote team memories', async () => {
    await upsertTeamMemoryFromRemote('space-a', {
      id: 'remote-vector',
      type: 'rule',
      content: 'Hospital A uses its full legal name',
      tags: [],
      project: 'hospital-a',
      status: 'active',
      updated_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect((getDatabase().prepare('SELECT COUNT(*) AS count FROM vec_memories').get() as { count: number }).count).toBe(1);

    await upsertTeamMemoryFromRemote('space-a', {
      id: 'remote-vector',
      type: 'rule',
      content: 'Hospital A uses the approved full legal name',
      tags: [],
      project: 'hospital-a',
      status: 'active',
      updated_at: '2026-01-02T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect((getDatabase().prepare('SELECT COUNT(*) AS count FROM vec_memories').get() as { count: number }).count).toBe(1);

    await upsertTeamMemoryFromRemote('space-a', {
      id: 'remote-vector',
      type: 'rule',
      content: 'Hospital A uses the approved full legal name',
      tags: [],
      project: 'hospital-a',
      status: 'archived',
      updated_at: '2026-01-03T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect((getDatabase().prepare('SELECT COUNT(*) AS count FROM vec_memories').get() as { count: number }).count).toBe(0);
  });

  it('preserves encrypted tags as ciphertext during remote upsert', async () => {
    await upsertTeamMemoryFromRemote('space-a', {
      id: 'encrypted-memory',
      type: 'preference',
      content: 'cipher-content',
      tags: 'cipher-tags',
      is_encrypted: true,
      status: 'active',
      updated_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const row = getDatabase().prepare('SELECT tags FROM memories WHERE id = ?').get('encrypted-memory') as { tags: string };
    expect(row.tags).toBe('cipher-tags');
  });

  it('falls back to local cache when remote is unreachable during recall', async () => {
    const store = new MemoryStore(TEST_DB);
    store.joinSpace('space-a', 'Alpha', 'http://127.0.0.1:9', 'secret');
    await store.write({ content: 'cached team memory', type: 'rule', project: 'p', scope: 'team', space_id: 'space-a' });

    const started = Date.now();
    const output = await buildRecallContext(store, { project: 'p', spaceId: 'space-a', format: 'context' });

    expect(output).toContain('cached team memory');
    expect(Date.now() - started).toBeLessThan(1800);
  });

  it('does not recall team memories from another project', async () => {
    const store = new MemoryStore(TEST_DB);
    store.joinSpace('space-a', 'Alpha');
    await store.write({ content: 'Hospital A prefers restrained copy', type: 'preference', project: 'hospital-a', scope: 'team', space_id: 'space-a' });
    await store.write({ content: 'Hospital B prefers playful copy', type: 'preference', project: 'hospital-b', scope: 'team', space_id: 'space-a' });

    const output = await buildRecallContext(store, { project: 'hospital-a', spaceId: 'space-a', format: 'context' });

    expect(output).toContain('Hospital A prefers restrained copy');
    expect(output).toContain('memory_ref:');
    expect(output).not.toContain('Hospital B prefers playful copy');
    const recalled = store.list(undefined, 'hospital-a').find(memory => memory.content === 'Hospital A prefers restrained copy');
    expect(recalled?.recall_count).toBe(1);
    expect(recalled?.last_recalled_at).toBeTruthy();
  });

  it('isolates recall to the requested team space', async () => {
    const store = new MemoryStore(TEST_DB);
    store.joinSpace('space-a', 'Alpha');
    store.joinSpace('space-b', 'Beta');
    await store.write({ content: 'Alpha team preference', type: 'preference', project: 'hospital-a', scope: 'team', space_id: 'space-a' });
    await store.write({ content: 'Beta team secret', type: 'preference', project: 'hospital-a', scope: 'team', space_id: 'space-b' });

    const output = await buildRecallContext(store, { project: 'hospital-a', spaceId: 'space-a', format: 'context' });

    expect(output).toContain('Alpha team preference');
    expect(output).not.toContain('Beta team secret');
  });

  it('injects approved project policies but never drafts', async () => {
    const store = new MemoryStore(TEST_DB);
    const policies = new PolicyStore();
    const approvedDraft = policies.create({ project: 'hospital-a', title: 'Medical claims', content: 'Do not use absolute efficacy claims.' });
    policies.approve(approvedDraft.policy_ref, 'compliance-owner');
    policies.create({ project: 'hospital-a', title: 'Unreviewed rule', content: 'This must stay hidden.' });

    const output = await buildRecallContext(store, { project: 'hospital-a', format: 'context' });

    expect(output).toContain('## 强制规则(已审批)');
    expect(output).toContain('policy_ref:');
    expect(output).toContain('Do not use absolute efficacy claims.');
    expect(output).not.toContain('This must stay hidden.');
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

  it('retries modified and deleted team memories as tombstones', async () => {
    const url = await startTestServer();
    const store = new MemoryStore(TEST_DB);
    store.joinSpace('space-a', 'Alpha', url, 'secret');
    const created = await store.write({ content: 'original team rule', type: 'rule', project: 'hospital-a', scope: 'team', space_id: 'space-a' });
    await pushTeamMemory(created.memory.id);

    await store.update({ id: created.memory.id, content: 'updated team rule' });
    expect((getDatabase().prepare('SELECT sync_status FROM memories WHERE id = ?').get(created.memory.id) as { sync_status: string }).sync_status).toBe('modified');
    await retryPendingTeamMemoryPushes();
    expect((getDatabase().prepare('SELECT sync_status FROM memories WHERE id = ?').get(created.memory.id) as { sync_status: string }).sync_status).toBe('synced');

    store.delete(created.memory.id);
    expect((getDatabase().prepare('SELECT sync_status FROM memories WHERE id = ?').get(created.memory.id) as { sync_status: string }).sync_status).toBe('deleted');
    await retryPendingTeamMemoryPushes();
    expect(getDatabase().prepare('SELECT status, sync_status FROM memories WHERE id = ?').get(created.memory.id)).toMatchObject({
      status: 'archived',
      sync_status: 'synced',
    });
  });
});
