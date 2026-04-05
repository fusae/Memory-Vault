import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { MemoryStore } from './memory-store.js';
import type { MemoryType, MemoryStatus } from './types.js';

export function dashboardApi(store: MemoryStore): Hono {
  const api = new Hono();
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
