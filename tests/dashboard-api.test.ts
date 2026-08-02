import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { MemoryStore } from '../src/memory-store.js';
import { dashboardApi } from '../src/dashboard-api.js';
import { closeDatabase } from '../src/db.js';
import fs from 'node:fs';
import { AgentEventStore } from '../src/event-store.js';
import { MemoryWorker } from '../src/memory-worker.js';
import { PolicyStore } from '../src/policy-store.js';
import { WorkflowGateway } from '../src/workflow-gateway.js';

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

  it('GET /api/events returns recent events', async () => {
    await store.write({ content: 'Event memory', type: 'identity', project: 'api-project', source_tool: 'test' });
    const res = await app.request('/api/events?limit=10');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data[0].event_type).toBe('write');
    expect(data[0].project_key).toBe('api-project');
    expect(data[0].source_tool).toBe('test');
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

  it('exposes reliable operations, outbox, and trace events', async () => {
    const events = new AgentEventStore();
    events.enqueue({
      idempotency_key: 'dashboard-task:start',
      event_type: 'task_started',
      payload: { authorization: 'Bearer dashboard-secret' },
      project: 'hospital-a',
      task_id: 'dashboard-task',
      trace_id: 'dashboard-trace',
      actor_id: 'hospital-a-lead',
    });
    await new MemoryWorker(events, store).processBatch();

    const operations = await app.request('/api/operations').then(res => res.json());
    expect(operations).toMatchObject({ agent_events: 1, redactions: 1 });
    expect(operations.outbox.completed).toBe(1);

    const trace = await app.request('/api/agent-events?trace_id=dashboard-trace').then(res => res.json());
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ task_id: 'dashboard-task', actor_id: 'hospital-a-lead', redaction_count: 1 });
    expect(JSON.stringify(trace[0].payload)).not.toContain('dashboard-secret');

    const outbox = await app.request('/api/outbox?status=completed').then(res => res.json());
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ event_type: 'task_started', trace_id: 'dashboard-trace' });
  });

  it('lists policies and supports human review decisions', async () => {
    const policies = new PolicyStore();
    const policy = policies.create({ project: 'hospital-a', title: 'Medical claims', content: 'No absolute efficacy claims.' });
    policies.approve(policy.policy_ref, 'compliance-owner');
    const pending = await store.write({
      content: 'Hospital A private workflow',
      type: 'preference',
      project: 'hospital-a',
      sensitivity: 'sensitive',
    });

    const policyRows = await app.request('/api/policies?project=hospital-a&status=approved').then(res => res.json());
    expect(policyRows).toHaveLength(1);
    expect(policyRows[0].policy_ref).toContain('@2');

    const response = await app.request(`/api/memories/${pending.memory.id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', reviewer: 'client-owner', reason: 'confirmed' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'active', reviewed_by: 'client-owner' });
  });

  it('lists workflows awaiting human approval and publishes through the governed decision endpoint', async () => {
    store.joinSpace('hospital-a-copy', 'Hospital A Copy');
    const policies = new PolicyStore();
    const draftPolicy = policies.create({
      project: 'hospital-a',
      space_id: 'hospital-a-copy',
      title: 'Medical claims',
      content: 'No absolute efficacy claims.',
    });
    const policyRef = policies.approve(draftPolicy.policy_ref, 'compliance-owner').policy_ref;
    const events = new AgentEventStore();
    const worker = new MemoryWorker(events, store);
    const gateway = new WorkflowGateway(events, store, policies, worker);
    await gateway.start({
      task_id: 'dashboard-workflow',
      project: 'hospital-a',
      space_id: 'hospital-a-copy',
      request: 'Write a clinic announcement.',
      writer_id: 'writer',
    });
    await gateway.submitDraft({
      task_id: 'dashboard-workflow',
      actor_id: 'writer',
      reviewer_id: 'reviewer',
      draft: 'Hospital A clinic announcement.',
    });
    gateway.submitReview({
      task_id: 'dashboard-workflow',
      actor_id: 'reviewer',
      decision: 'approved',
      findings: 'Policy satisfied.',
      policy_refs: [policyRef],
    });

    const pending = await app.request('/api/workflows?status=awaiting_human_approval').then(res => res.json());
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ task_id: 'dashboard-workflow', status: 'awaiting_human_approval' });

    const response = await app.request('/api/workflows/dashboard-workflow/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewer: 'hospital-owner', decision: 'approve', reason: 'approved for publishing' }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).run).toMatchObject({ status: 'completed', human_reviewer: 'hospital-owner' });
    const operations = await app.request('/api/operations').then(res => res.json());
    expect(operations.pending_workflow_approval).toBe(0);
  });
});
