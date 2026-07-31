import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { getDatabase } from './db.js';
import { upsertTeamMemoryFromRemote } from './space-sync.js';

function authorized(c: { req: { header: (name: string) => string | undefined } }, token: string): boolean {
  return c.req.header('authorization') === `Bearer ${token}`;
}

function memoryRows(spaceId: string, since?: string): Record<string, unknown>[] {
  const db = getDatabase();
  const params: unknown[] = [spaceId];
  let sql = `
    SELECT * FROM memories
    WHERE scope = 'team'
      AND space_id = ?
  `;
  if (since?.trim()) {
    sql += ' AND updated_at > ?';
    params.push(since.trim());
  }
  sql += ' ORDER BY updated_at ASC';
  return db.prepare(sql).all(...params).map(row => {
    const memory = row as Record<string, unknown>;
    if (typeof memory.tags === 'string') {
      try {
        memory.tags = JSON.parse(memory.tags);
      } catch {
        memory.tags = [];
      }
    }
    memory.is_encrypted = !!memory.is_encrypted;
    return memory;
  });
}

export function createSpaceServerApp(token: string, allowedSpaceId?: string): Hono {
  const app = new Hono();

  app.use('/space/:id/*', async (c, next) => {
    if (!authorized(c, token)) return c.json({ error: 'unauthorized' }, 401);
    const spaceId = c.req.param('id');
    if (allowedSpaceId && allowedSpaceId !== spaceId) return c.json({ error: 'not_found' }, 404);
    await next();
  });

  app.get('/space/:id/health', c => {
    return c.json({ ok: true, space_id: c.req.param('id') });
  });

  app.get('/space/:id/memories', c => {
    return c.json({ memories: memoryRows(c.req.param('id'), c.req.query('since')) });
  });

  app.post('/space/:id/memories', async c => {
    const body = await c.req.json().catch(() => null) as { memory?: Record<string, unknown>; memories?: Record<string, unknown>[] } | null;
    const payload = body?.memories ?? (body?.memory ? [body.memory] : []);
    let upserted = 0;
    for (const memory of payload) {
      if (upsertTeamMemoryFromRemote(c.req.param('id'), memory)) upserted++;
    }
    return c.json({ ok: true, upserted });
  });

  return app;
}

export function startSpaceServer(opts: { port: number; token: string; space?: string; onReady?: () => void }) {
  const app = createSpaceServerApp(opts.token, opts.space);
  return serve({ fetch: app.fetch, port: opts.port }, opts.onReady);
}
