import { randomUUID } from 'node:crypto';
import { getDatabase } from './db.js';
import type {
  AgentEvent,
  AgentEventInput,
  ClaimedAgentEvent,
  MemoryScope,
  OutboxEntry,
} from './types.js';

type AgentEventRow = Omit<AgentEvent, 'payload'> & { payload: string };

const SECRET_KEY = /(password|passphrase|secret|token|api[_-]?key|authorization|cookie)/i;
const SECRET_VALUE = /\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g;
const BEARER_VALUE = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const IDEMPOTENCY_SEPARATOR = '\u001f';

export function redactEventPayload(payload: Record<string, unknown>): { payload: Record<string, unknown>; redactionCount: number } {
  let redactionCount = 0;
  const visit = (value: unknown, key?: string): unknown => {
    if (key && SECRET_KEY.test(key) && value !== null && value !== undefined) {
      redactionCount++;
      return '[REDACTED]';
    }
    if (Array.isArray(value)) return value.map(item => visit(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, visit(child, childKey)]));
    }
    if (typeof value === 'string') {
      let next = value.replace(SECRET_VALUE, () => {
        redactionCount++;
        return '[REDACTED]';
      });
      next = next.replace(BEARER_VALUE, (_match, prefix: string) => {
        redactionCount++;
        return `${prefix}[REDACTED]`;
      });
      return next;
    }
    return value;
  };
  return { payload: visit(payload) as Record<string, unknown>, redactionCount };
}

function parseEvent(row: AgentEventRow): AgentEvent {
  const prefix = `${row.tenant_id}${IDEMPOTENCY_SEPARATOR}`;
  return {
    ...row,
    idempotency_key: row.idempotency_key.startsWith(prefix) ? row.idempotency_key.slice(prefix.length) : row.idempotency_key,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
}

function normalizeBoundary(input: AgentEventInput): { tenantId: string; scope: MemoryScope; spaceId: string | null } {
  const tenantId = input.tenant_id?.trim() || 'local';
  const scope = input.scope ?? 'personal';
  const spaceId = input.space_id?.trim() || null;
  if (scope === 'team' && !spaceId) throw new Error('space_id is required for team events');
  if (scope === 'personal' && spaceId) throw new Error('space_id is not allowed for personal events');
  return { tenantId, scope, spaceId };
}

export class AgentEventStore {
  enqueue(input: AgentEventInput): { event: AgentEvent; outbox: OutboxEntry; created: boolean } {
    const requestedIdempotencyKey = input.idempotency_key.trim();
    if (!requestedIdempotencyKey) throw new Error('idempotency_key is required');
    const boundary = normalizeBoundary(input);
    const db = getDatabase();
    const now = new Date().toISOString();
    const eventId = randomUUID();
    const maxAttempts = Math.max(1, Math.min(Math.floor(input.max_attempts ?? 5), 100));
    const sanitized = redactEventPayload(input.payload);

    const insert = db.transaction(() => {
      const legacy = db.prepare('SELECT id FROM agent_events WHERE tenant_id = ? AND idempotency_key = ?')
        .get(boundary.tenantId, requestedIdempotencyKey) as { id: string } | undefined;
      const idempotencyKey = legacy
        ? requestedIdempotencyKey
        : `${boundary.tenantId}${IDEMPOTENCY_SEPARATOR}${requestedIdempotencyKey}`;
      const result = db.prepare(`
        INSERT OR IGNORE INTO agent_events (
          id, idempotency_key, tenant_id, event_type, payload, project, scope,
          space_id, task_id, trace_id, actor_id, redaction_count, occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        idempotencyKey,
        boundary.tenantId,
        input.event_type,
        JSON.stringify(sanitized.payload),
        input.project?.trim() || null,
        boundary.scope,
        boundary.spaceId,
        input.task_id?.trim() || null,
        input.trace_id?.trim() || null,
        input.actor_id?.trim() || null,
        sanitized.redactionCount,
        input.occurred_at ?? now,
        now,
      );

      const created = result.changes === 1;
      const row = db.prepare('SELECT * FROM agent_events WHERE idempotency_key = ?').get(idempotencyKey) as AgentEventRow;
      if (created) {
        db.prepare(`
          INSERT INTO event_outbox (event_id, max_attempts, available_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(row.id, maxAttempts, now, now, now);
      }
      const outbox = db.prepare('SELECT * FROM event_outbox WHERE event_id = ?').get(row.id) as OutboxEntry;
      return { event: parseEvent(row), outbox, created };
    });

    return insert();
  }

  claimBatch(limit = 10, now = new Date()): ClaimedAgentEvent[] {
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 100));
    const nowIso = now.toISOString();
    const db = getDatabase();
    return db.transaction(() => {
      const due = db.prepare(`
        SELECT id FROM event_outbox
        WHERE status IN ('pending','retry') AND available_at <= ?
        ORDER BY id ASC LIMIT ?
      `).all(nowIso, safeLimit) as { id: number }[];

      const claimed: ClaimedAgentEvent[] = [];
      for (const item of due) {
        db.prepare(`
          UPDATE event_outbox
          SET status = 'processing', attempts = attempts + 1, locked_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('pending','retry')
        `).run(nowIso, nowIso, item.id);
        const row = db.prepare(`
          SELECT
            e.id AS e_id, e.idempotency_key, e.tenant_id, e.event_type, e.payload,
            e.project, e.scope, e.space_id, e.task_id, e.trace_id, e.actor_id,
            e.redaction_count,
            e.occurred_at, e.created_at AS e_created_at,
            o.id AS o_id, o.event_id, o.topic, o.status, o.attempts, o.max_attempts,
            o.available_at, o.locked_at, o.processed_at, o.last_error,
            o.created_at AS o_created_at, o.updated_at AS o_updated_at
          FROM event_outbox o
          INNER JOIN agent_events e ON e.id = o.event_id
          WHERE o.id = ?
        `).get(item.id) as Record<string, unknown>;
        claimed.push({
          event: parseEvent({
            id: row.e_id as string,
            idempotency_key: row.idempotency_key as string,
            tenant_id: row.tenant_id as string,
            event_type: row.event_type as AgentEvent['event_type'],
            payload: row.payload as string,
            project: row.project as string | null,
            scope: row.scope as MemoryScope,
            space_id: row.space_id as string | null,
            task_id: row.task_id as string | null,
            trace_id: row.trace_id as string | null,
            actor_id: row.actor_id as string | null,
            redaction_count: row.redaction_count as number,
            occurred_at: row.occurred_at as string,
            created_at: row.e_created_at as string,
          }),
          outbox: {
            id: row.o_id as number,
            event_id: row.event_id as string,
            topic: row.topic as string,
            status: row.status as OutboxEntry['status'],
            attempts: row.attempts as number,
            max_attempts: row.max_attempts as number,
            available_at: row.available_at as string,
            locked_at: row.locked_at as string | null,
            processed_at: row.processed_at as string | null,
            last_error: row.last_error as string | null,
            created_at: row.o_created_at as string,
            updated_at: row.o_updated_at as string,
          },
        });
      }
      return claimed;
    })();
  }

  complete(outboxId: number, now = new Date()): void {
    const nowIso = now.toISOString();
    getDatabase().prepare(`
      UPDATE event_outbox
      SET status = 'completed', processed_at = ?, locked_at = NULL, last_error = NULL, updated_at = ?
      WHERE id = ? AND status = 'processing'
    `).run(nowIso, nowIso, outboxId);
  }

  fail(outboxId: number, error: unknown, now = new Date()): 'retry' | 'dead_letter' {
    const db = getDatabase();
    const row = db.prepare('SELECT attempts, max_attempts FROM event_outbox WHERE id = ?').get(outboxId) as { attempts: number; max_attempts: number } | undefined;
    if (!row) throw new Error(`Outbox entry not found: ${outboxId}`);
    const dead = row.attempts >= row.max_attempts;
    const delayMs = Math.min(60_000, 1_000 * (2 ** Math.max(0, row.attempts - 1)));
    const nowIso = now.toISOString();
    const availableAt = new Date(now.getTime() + delayMs).toISOString();
    db.prepare(`
      UPDATE event_outbox
      SET status = ?, available_at = ?, locked_at = NULL, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(dead ? 'dead_letter' : 'retry', availableAt, String(error instanceof Error ? error.message : error).slice(0, 2000), nowIso, outboxId);
    return dead ? 'dead_letter' : 'retry';
  }

  requeueStale(staleAfterMs = 60_000, now = new Date()): number {
    const cutoff = new Date(now.getTime() - Math.max(1, staleAfterMs)).toISOString();
    const nowIso = now.toISOString();
    return getDatabase().prepare(`
      UPDATE event_outbox
      SET status = 'retry', available_at = ?, locked_at = NULL,
          last_error = COALESCE(last_error, 'worker lease expired'), updated_at = ?
      WHERE status = 'processing' AND locked_at < ?
    `).run(nowIso, nowIso, cutoff).changes;
  }

  getOutbox(eventId: string): OutboxEntry | null {
    const row = getDatabase().prepare('SELECT * FROM event_outbox WHERE event_id = ?').get(eventId) as OutboxEntry | undefined;
    return row ?? null;
  }
}
