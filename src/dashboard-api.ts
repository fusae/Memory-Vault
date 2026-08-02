import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { MemoryStore } from './memory-store.js';
import type { MemoryType, WorkflowStatus } from './types.js';
import { getDatabase, listEvents } from './db.js';
import { PolicyStore } from './policy-store.js';
import { AgentEventStore } from './event-store.js';
import { MemoryWorker } from './memory-worker.js';
import { WorkflowGateway } from './workflow-gateway.js';

export function dashboardApi(store: MemoryStore): Hono {
  const api = new Hono();
  const policies = new PolicyStore();
  const agentEvents = new AgentEventStore();
  const workflowGateway = new WorkflowGateway(agentEvents, store, policies, new MemoryWorker(agentEvents, store));
  api.use('/*', cors());

  // List memories with filters
  api.get('/memories', (c) => {
    const type = c.req.query('type') as MemoryType | undefined;
    const project = c.req.query('project');
    const status = c.req.query('status');

    let memories;
    if (status === 'all') {
      memories = store.list(type, project, { includeAll: true });
    } else if (status) {
      memories = store.list(type, project, { status });
    } else {
      memories = store.list(type, project);
    }

    return c.json(memories);
  });

  // Get single memory
  api.get('/memories/:id', (c) => {
    const memory = store.get(c.req.param('id'));
    if (!memory) return c.json({ error: 'Not found' }, 404);
    return c.json(memory);
  });

  // Update memory
  api.put('/memories/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    try {
      const memory = await store.update({ id, ...body });
      return c.json(memory);
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // Delete memory
  api.delete('/memories/:id', (c) => {
    const id = c.req.param('id');
    try {
      store.delete(id);
      return c.json({ ok: true });
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // Forget (soft-delete)
  api.post('/memories/:id/forget', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    try {
      store.forget(id, (body as { reason?: string }).reason);
      const memory = store.get(id);
      return c.json(memory);
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // Version history
  api.get('/memories/:id/versions', (c) => {
    const versions = store.getVersions(c.req.param('id'));
    return c.json(versions);
  });

  // Health stats
  api.get('/health', (c) => {
    return c.json(store.getHealthStats());
  });

  // Recent event stream
  api.get('/events', (c) => {
    const rawLimit = c.req.query('limit');
    const limit = rawLimit ? parseInt(rawLimit, 10) : 50;
    return c.json(listEvents(limit));
  });

  api.get('/agent-events', (c) => {
    const rawLimit = parseInt(c.req.query('limit') ?? '100', 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 100;
    const conditions: string[] = [];
    const params: unknown[] = [];
    for (const field of ['trace_id', 'task_id', 'project', 'event_type'] as const) {
      const value = c.req.query(field);
      if (value) {
        conditions.push(`${field} = ?`);
        params.push(value);
      }
    }
    let sql = 'SELECT * FROM agent_events';
    if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ' ORDER BY occurred_at DESC, id DESC LIMIT ?';
    params.push(limit);
    const rows = getDatabase().prepare(sql).all(...params) as (Record<string, unknown> & { payload: string })[];
    return c.json(rows.map(row => ({ ...row, payload: JSON.parse(row.payload) })));
  });

  api.get('/outbox', (c) => {
    const rawLimit = parseInt(c.req.query('limit') ?? '100', 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 100;
    const status = c.req.query('status');
    const params: unknown[] = [];
    let sql = `
      SELECT o.*, e.event_type, e.task_id, e.trace_id, e.project, e.actor_id
      FROM event_outbox o INNER JOIN agent_events e ON e.id = o.event_id
    `;
    if (status) {
      sql += ' WHERE o.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY o.updated_at DESC, o.id DESC LIMIT ?';
    params.push(limit);
    return c.json(getDatabase().prepare(sql).all(...params));
  });

  api.get('/policies', (c) => {
    const project = c.req.query('project');
    if (!project) return c.json({ error: 'project is required' }, 400);
    const status = c.req.query('status') as 'draft' | 'approved' | 'retired' | undefined;
    return c.json(policies.list({
      tenant_id: c.req.query('tenant_id'),
      project,
      space_id: c.req.query('space_id'),
      status,
    }));
  });

  api.post('/memories/:id/review', async c => {
    const body = await c.req.json() as { decision?: 'approve' | 'reject'; reviewer?: string; reason?: string };
    if (!body.decision || !body.reviewer) return c.json({ error: 'decision and reviewer are required' }, 400);
    try {
      return c.json(store.review(c.req.param('id'), body.decision, body.reviewer, body.reason));
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  api.get('/workflows', c => {
    const status = c.req.query('status') as WorkflowStatus | undefined;
    return c.json(workflowGateway.list({
      tenant_id: c.req.query('tenant_id'),
      project: c.req.query('project'),
      space_id: c.req.query('space_id'),
      status,
    }));
  });

  api.get('/workflows/:taskId', c => {
    const run = workflowGateway.get(c.req.param('taskId'), c.req.query('tenant_id'));
    return run ? c.json(run) : c.json({ error: 'Not found' }, 404);
  });

  api.post('/workflows/:taskId/decision', async c => {
    const body = await c.req.json() as {
      tenant_id?: string;
      reviewer?: string;
      decision?: 'approve' | 'reject';
      reason?: string;
      experience?: { content: string; type?: 'episode'; confidence?: number };
    };
    if (!body.reviewer || !body.decision) return c.json({ error: 'reviewer and decision are required' }, 400);
    try {
      return c.json(await workflowGateway.humanDecide({
        task_id: c.req.param('taskId'),
        tenant_id: body.tenant_id,
        reviewer: body.reviewer,
        decision: body.decision,
        reason: body.reason,
        experience: body.experience,
      }));
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  api.get('/operations', c => {
    const db = getDatabase();
    const outboxRows = db.prepare('SELECT status, COUNT(*) AS count FROM event_outbox GROUP BY status').all() as { status: string; count: number }[];
    const policyRows = db.prepare('SELECT status, COUNT(*) AS count FROM policies GROUP BY status').all() as { status: string; count: number }[];
    const eventStats = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(redaction_count), 0) AS redactions FROM agent_events').get() as { total: number; redactions: number };
    const pendingReview = (db.prepare("SELECT COUNT(*) AS count FROM memories WHERE status = 'pending_review'").get() as { count: number }).count;
    const pendingWorkflowApproval = (db.prepare("SELECT COUNT(*) AS count FROM workflow_runs WHERE status = 'awaiting_human_approval'").get() as { count: number }).count;
    return c.json({
      outbox: Object.fromEntries(outboxRows.map(row => [row.status, row.count])),
      policies: Object.fromEntries(policyRows.map(row => [row.status, row.count])),
      agent_events: eventStats.total,
      redactions: eventStats.redactions,
      pending_review: pendingReview,
      pending_workflow_approval: pendingWorkflowApproval,
    });
  });

  // Export JSON
  api.get('/export', (c) => {
    return c.json(store.export());
  });

  // Export Markdown
  api.get('/export/markdown', (c) => {
    return c.text(store.exportMarkdown());
  });

  // Sync status
  api.get('/sync/status', async (c) => {
    try {
      const { SyncService } = await import('./sync.js');
      const { getSupabaseClient } = await import('./supabase.js');
      const { AuthService } = await import('./auth.js');

      const supabase = getSupabaseClient();
      if (!supabase) return c.json({ configured: false });

      const auth = new AuthService(supabase);
      const session = await auth.getSession();
      if (!session) return c.json({ configured: true, authenticated: false });

      const sync = new SyncService(store, supabase, session.user.id);
      return c.json({
        configured: true,
        authenticated: true,
        email: session.user.email,
        ...sync.getStatus(),
      });
    } catch {
      return c.json({ configured: false });
    }
  });

  // Trigger sync
  api.post('/sync', async (c) => {
    try {
      const { SyncService } = await import('./sync.js');
      const { getSupabaseClient } = await import('./supabase.js');
      const { AuthService } = await import('./auth.js');

      const supabase = getSupabaseClient();
      if (!supabase) return c.json({ error: 'Supabase not configured' }, 400);

      const auth = new AuthService(supabase);
      const session = await auth.getSession();
      if (!session) return c.json({ error: 'Not authenticated' }, 401);

      const sync = new SyncService(store, supabase, session.user.id);
      const result = await sync.sync();
      return c.json(result);
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  return api;
}
