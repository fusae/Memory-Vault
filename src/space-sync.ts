import { getDatabase, recordEvent } from './db.js';
import type { MemoryEntry, SpaceEntry } from './types.js';

const PULL_INTERVAL_MS = 30_000;
const REMOTE_TIMEOUT_MS = 1_500;

type StoredMemoryRow = Omit<MemoryEntry, 'tags' | 'is_encrypted'> & {
  tags: string;
  is_encrypted: number;
};

function withAbortTimeout(ms: number): AbortController {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller;
}

function normalizeRemoteUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function parseTags(tags: string | string[] | undefined): string {
  if (Array.isArray(tags)) return JSON.stringify(tags);
  if (!tags) return '[]';
  try {
    const parsed = JSON.parse(tags);
    return JSON.stringify(Array.isArray(parsed) ? parsed : []);
  } catch {
    return '[]';
  }
}

function toWireMemory(row: StoredMemoryRow): Record<string, unknown> {
  return {
    ...row,
    tags: parseTags(row.tags),
    is_encrypted: !!row.is_encrypted,
  };
}

export function listRemoteSpaces(): SpaceEntry[] {
  return getDatabase().prepare(`
    SELECT * FROM spaces
    WHERE remote_url IS NOT NULL AND remote_url <> ''
      AND remote_token IS NOT NULL AND remote_token <> ''
    ORDER BY joined_at DESC
  `).all() as SpaceEntry[];
}

export async function pushTeamMemory(memoryId: string): Promise<boolean> {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT * FROM memories
    WHERE id = ? AND scope = 'team' AND space_id IS NOT NULL
  `).get(memoryId) as StoredMemoryRow | undefined;
  if (!row?.space_id) return false;

  const space = db.prepare('SELECT * FROM spaces WHERE space_id = ?').get(row.space_id) as SpaceEntry | undefined;
  if (!space?.remote_url || !space.remote_token) return false;

  try {
    const controller = withAbortTimeout(REMOTE_TIMEOUT_MS);
    const response = await fetch(`${normalizeRemoteUrl(space.remote_url)}/space/${encodeURIComponent(row.space_id)}/memories`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${space.remote_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ memory: toWireMemory(row) }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`push failed: ${response.status}`);
    db.prepare("UPDATE memories SET sync_status = 'synced', last_synced_at = ? WHERE id = ?")
      .run(new Date().toISOString(), row.id);
    recordEvent({ event_type: 'sync', source_tool: 'space-sync', detail: `pushed ${row.id}` });
    return true;
  } catch {
    db.prepare("UPDATE memories SET sync_status = 'pending' WHERE id = ? AND scope = 'team'").run(row.id);
    return false;
  }
}

export function scheduleTeamMemoryPush(memory: MemoryEntry): void {
  if (memory.scope !== 'team' || !memory.space_id) return;
  const space = getDatabase().prepare('SELECT remote_url FROM spaces WHERE space_id = ?').get(memory.space_id) as { remote_url?: string | null } | undefined;
  if (!space?.remote_url) return;
  setImmediate(() => {
    void pushTeamMemory(memory.id).catch(() => {});
  });
}

export async function retryPendingTeamMemoryPushes(spaceId?: string): Promise<void> {
  const db = getDatabase();
  let sql = `
    SELECT m.id FROM memories m
    INNER JOIN spaces s ON s.space_id = m.space_id
    WHERE m.scope = 'team'
      AND m.sync_status = 'pending'
      AND s.remote_url IS NOT NULL AND s.remote_url <> ''
      AND s.remote_token IS NOT NULL AND s.remote_token <> ''
  `;
  const params: unknown[] = [];
  if (spaceId) {
    sql += ' AND m.space_id = ?';
    params.push(spaceId);
  }
  sql += ' ORDER BY m.updated_at ASC LIMIT 50';

  const rows = db.prepare(sql).all(...params) as { id: string }[];
  for (const row of rows) {
    await pushTeamMemory(row.id);
  }
}

export function upsertTeamMemoryFromRemote(spaceId: string, input: Record<string, unknown>): boolean {
  const db = getDatabase();
  const id = typeof input.id === 'string' ? input.id : '';
  const updatedAt = typeof input.updated_at === 'string' ? input.updated_at : '';
  if (!id || !updatedAt) return false;

  const existing = db.prepare('SELECT updated_at FROM memories WHERE id = ?').get(id) as { updated_at: string } | undefined;
  if (existing && existing.updated_at >= updatedAt) return false;

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO memories (
      id, type, content, tags, project, confidence, confirmation_count, source_tool,
      source_excerpt, source_conversation_id, is_encrypted, status, expires_at,
      user_id, sync_status, remote_id, last_synced_at, scope, space_id, created_at, updated_at
    )
    VALUES (
      @id, @type, @content, @tags, @project, @confidence, @confirmation_count, @source_tool,
      @source_excerpt, @source_conversation_id, @is_encrypted, @status, @expires_at,
      @user_id, 'synced', @remote_id, @last_synced_at, 'team', @space_id, @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      content = excluded.content,
      tags = excluded.tags,
      project = excluded.project,
      confidence = excluded.confidence,
      confirmation_count = excluded.confirmation_count,
      source_tool = excluded.source_tool,
      source_excerpt = excluded.source_excerpt,
      source_conversation_id = excluded.source_conversation_id,
      is_encrypted = excluded.is_encrypted,
      status = excluded.status,
      expires_at = excluded.expires_at,
      user_id = excluded.user_id,
      sync_status = 'synced',
      remote_id = excluded.remote_id,
      last_synced_at = excluded.last_synced_at,
      scope = 'team',
      space_id = excluded.space_id,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `).run({
    id,
    type: input.type,
    content: input.content,
    tags: parseTags(input.tags as string | string[] | undefined),
    project: input.project ?? null,
    confidence: typeof input.confidence === 'number' ? input.confidence : 0.8,
    confirmation_count: typeof input.confirmation_count === 'number' ? input.confirmation_count : 0,
    source_tool: input.source_tool ?? null,
    source_excerpt: input.source_excerpt ?? null,
    source_conversation_id: input.source_conversation_id ?? null,
    is_encrypted: input.is_encrypted ? 1 : 0,
    status: input.status ?? 'active',
    expires_at: input.expires_at ?? null,
    user_id: input.user_id ?? null,
    remote_id: input.remote_id ?? id,
    last_synced_at: now,
    space_id: spaceId,
    created_at: input.created_at ?? updatedAt,
    updated_at: updatedAt,
  });
  return true;
}

export async function pullSpaceMemories(space: SpaceEntry): Promise<boolean> {
  if (!space.remote_url || !space.remote_token) return false;
  try {
    await retryPendingTeamMemoryPushes(space.space_id);
    const since = space.last_pulled_at ? `?since=${encodeURIComponent(space.last_pulled_at)}` : '';
    const controller = withAbortTimeout(REMOTE_TIMEOUT_MS);
    const response = await fetch(`${normalizeRemoteUrl(space.remote_url)}/space/${encodeURIComponent(space.space_id)}/memories${since}`, {
      headers: { authorization: `Bearer ${space.remote_token}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`pull failed: ${response.status}`);
    const body = await response.json() as { memories?: Record<string, unknown>[] };
    for (const memory of body.memories ?? []) {
      upsertTeamMemoryFromRemote(space.space_id, memory);
    }
    getDatabase().prepare('UPDATE spaces SET last_pulled_at = ? WHERE space_id = ?')
      .run(new Date().toISOString(), space.space_id);
    recordEvent({ event_type: 'sync', source_tool: 'space-sync', detail: `pulled ${space.space_id}` });
    return true;
  } catch {
    return false;
  }
}

export async function pullDueRemoteSpaces(): Promise<void> {
  const now = Date.now();
  const spaces = listRemoteSpaces().filter(space => {
    if (!space.last_pulled_at) return true;
    const lastPulled = new Date(space.last_pulled_at).getTime();
    return !Number.isFinite(lastPulled) || now - lastPulled > PULL_INTERVAL_MS;
  });
  for (const space of spaces) {
    await pullSpaceMemories(space);
  }
}
