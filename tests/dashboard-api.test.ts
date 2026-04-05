import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { MemoryStore } from '../src/memory-store.js';
import { dashboardApi } from '../src/dashboard-api.js';
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

const TEST_DB = './data/test-dashboard.db';

describe('Dashboard API', () => {
  let store: MemoryStore;
  let app: Hono;

  beforeEach(() => {
    store = new MemoryStore(TEST_DB);
    app = new Hono();
    app.route('/api', dashboardApi(store));
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('GET /api/memories returns array', async () => {
    await store.write({ content: 'Test memory', type: 'identity' });
    const res = await app.request('/api/memories');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(1);
  });

  it('GET /api/memories/:id returns 404 for missing', async () => {
    const res = await app.request('/api/memories/non-existent');
    expect(res.status).toBe(404);
  });

  it('GET /api/memories/:id returns memory', async () => {
    const r = await store.write({ content: 'Test', type: 'preference' });
    const res = await app.request(`/api/memories/${r.memory.id}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.content).toBe('Test');
  });

  it('PUT /api/memories/:id updates memory', async () => {
    const r = await store.write({ content: 'Old content', type: 'identity' });
    const res = await app.request(`/api/memories/${r.memory.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'New content', reason: 'test update' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.content).toBe('New content');
  });

  it('DELETE /api/memories/:id removes memory', async () => {
    const r = await store.write({ content: 'To delete', type: 'episode' });
    const res = await app.request(`/api/memories/${r.memory.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(store.get(r.memory.id)).toBeNull();
  });

  it('GET /api/memories?type=preference filters by type', async () => {
    await store.write({ content: 'Identity memory', type: 'identity' });
    await store.write({ content: 'Preference memory', type: 'preference' });
    const res = await app.request('/api/memories?type=preference');
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].type).toBe('preference');
  });

  it('GET /api/memories?status=all includes archived', async () => {
    await store.write({ content: 'Active', type: 'identity' });
    const r = await store.write({ content: 'To archive', type: 'episode' });
    store.forget(r.memory.id, 'test');

    const res = await app.request('/api/memories?status=all');
    const data = await res.json();
    expect(data).toHaveLength(2);
  });

  it('GET /api/health returns stats', async () => {
    await store.write({ content: 'Test', type: 'identity' });
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(1);
    expect(data.byType.identity).toBe(1);
  });

  it('POST /api/memories/:id/forget soft-deletes', async () => {
    const r = await store.write({ content: 'To forget', type: 'episode' });
    const res = await app.request(`/api/memories/${r.memory.id}/forget`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'no longer relevant' }),
    });
    expect(res.status).toBe(200);
    const memory = store.get(r.memory.id);
    expect(memory?.status).toBe('archived');
  });

  it('GET /api/memories/:id/versions returns history', async () => {
    const r = await store.write({ content: 'v1', type: 'identity' });
    await store.update({ id: r.memory.id, content: 'v2', reason: 'update test' });
    const res = await app.request(`/api/memories/${r.memory.id}/versions`);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].content).toBe('v1');
  });
});
