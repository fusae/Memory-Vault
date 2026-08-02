import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { getDatabase } from './db.js';
import { upsertTeamMemoryFromRemote } from './space-sync.js';
import { resolveSpacePrincipal, roleAllows, type SpacePrincipal } from './space-access.js';
import type { SpaceInvitation } from './space-crypto.js';

function decodeCursor(cursor: string | undefined): { updatedAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { updatedAt?: unknown; id?: unknown };
    return typeof parsed.updatedAt === 'string' && typeof parsed.id === 'string'
      ? { updatedAt: parsed.updatedAt, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt, id }), 'utf8').toString('base64url');
}

function memoryRows(spaceId: string, since?: string, cursorValue?: string): { memories: Record<string, unknown>[]; next_cursor: string | null } {
  const db = getDatabase();
  const params: unknown[] = [spaceId];
  const cursor = decodeCursor(cursorValue);
  let sql = `
    SELECT * FROM memories
    WHERE scope = 'team'
      AND space_id = ?
  `;
  if (cursor) {
    sql += ' AND (updated_at > ? OR (updated_at = ? AND id > ?))';
    params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  } else if (since?.trim()) {
    sql += ' AND updated_at > ?';
    params.push(since.trim());
  }
  sql += ' ORDER BY updated_at ASC, id ASC LIMIT 500';
  const rows = db.prepare(sql).all(...params).map(row => {
    const memory = row as Record<string, unknown>;
    if (!memory.is_encrypted && typeof memory.tags === 'string') {
      try {
        memory.tags = JSON.parse(memory.tags);
      } catch {
        memory.tags = [];
      }
    }
    memory.is_encrypted = !!memory.is_encrypted;
    return memory;
  });
  const last = rows.at(-1);
  return {
    memories: rows,
    next_cursor: last && typeof last.updated_at === 'string' && typeof last.id === 'string'
      ? encodeCursor(last.updated_at, last.id)
      : cursorValue ?? null,
  };
}

export function createSpaceServerApp(token: string, allowedSpaceId?: string): Hono<{ Variables: { principal: SpacePrincipal } }> {
  const app = new Hono<{ Variables: { principal: SpacePrincipal } }>();

  app.use('/space/:id/*', async (c, next) => {
    const spaceId = c.req.param('id');
    if (allowedSpaceId && allowedSpaceId !== spaceId) return c.json({ error: 'not_found' }, 404);
    const principal = resolveSpacePrincipal(spaceId, c.req.header('authorization'), token);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    c.set('principal', principal);
    await next();
  });

  app.get('/space/:id/health', c => {
    const space = getDatabase().prepare('SELECT encryption_required, key_version FROM spaces WHERE space_id = ?').get(c.req.param('id')) as { encryption_required: number; key_version: number } | undefined;
    return c.json({ ok: true, space_id: c.req.param('id'), encryption_required: !!space?.encryption_required, key_version: space?.key_version ?? 0 });
  });

  app.get('/space/:id/memories', c => {
    return c.json(memoryRows(c.req.param('id'), c.req.query('since'), c.req.query('cursor')));
  });

  app.post('/space/:id/memories', async c => {
    if (!roleAllows(c.get('principal').role, 'writer')) return c.json({ error: 'forbidden' }, 403);
    const body = await c.req.json().catch(() => null) as { memory?: Record<string, unknown>; memories?: Record<string, unknown>[] } | null;
    const payload = body?.memories ?? (body?.memory ? [body.memory] : []);
    const space = getDatabase().prepare('SELECT encryption_required, key_version FROM spaces WHERE space_id = ?').get(c.req.param('id')) as { encryption_required: number; key_version: number } | undefined;
    if (space?.encryption_required && payload.some(memory => memory.encryption_scheme !== 'space' || memory.key_version !== space.key_version)) {
      return c.json({ error: 'stale_or_unencrypted_space_payload', key_version: space.key_version }, 409);
    }
    let upserted = 0;
    for (const memory of payload) {
      if (await upsertTeamMemoryFromRemote(c.req.param('id'), memory)) upserted++;
    }
    return c.json({ ok: true, upserted });
  });

  app.get('/space/:id/invitation', c => {
    const spaceId = c.req.param('id');
    const principal = c.get('principal');
    const memberId = c.req.query('member_id') || principal.member_id;
    if (!principal.bootstrap && principal.role !== 'owner' && memberId !== principal.member_id) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const db = getDatabase();
    const space = db.prepare('SELECT name, key_version FROM spaces WHERE space_id = ? AND encryption_required = 1').get(spaceId) as { name: string; key_version: number } | undefined;
    const owner = db.prepare("SELECT * FROM space_members WHERE space_id = ? AND role = 'owner' AND status = 'active'").get(spaceId);
    const member = db.prepare("SELECT * FROM space_members WHERE space_id = ? AND member_id = ? AND status = 'active'").get(spaceId, memberId);
    const envelope = space ? db.prepare(`
      SELECT * FROM space_key_envelopes WHERE space_id = ? AND key_version = ? AND member_id = ?
    `).get(spaceId, space.key_version, memberId) : undefined;
    if (!space || !owner || !member || !envelope) return c.json({ error: 'not_found' }, 404);
    const invitation: SpaceInvitation = {
      version: 1,
      space_id: spaceId,
      space_name: space.name,
      key_version: space.key_version,
      owner: owner as SpaceInvitation['owner'],
      member: member as SpaceInvitation['member'],
      envelope: envelope as SpaceInvitation['envelope'],
    };
    return c.json(invitation);
  });

  app.get('/space/:id/members', c => {
    if (!roleAllows(c.get('principal').role, 'owner')) return c.json({ error: 'forbidden' }, 403);
    return c.json(getDatabase().prepare(`
      SELECT space_id, member_id, role, status, created_at, updated_at
      FROM space_members WHERE space_id = ? ORDER BY created_at, member_id
    `).all(c.req.param('id')));
  });

  return app;
}

export function startSpaceServer(opts: { port: number; token: string; space?: string; onReady?: () => void }) {
  const app = createSpaceServerApp(opts.token, opts.space);
  return serve({ fetch: app.fetch, port: opts.port }, opts.onReady);
}
