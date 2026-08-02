import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { closeDatabase, getDatabase } from '../src/db.js';
import { AgentEventStore } from '../src/event-store.js';
import { MemoryStore } from '../src/memory-store.js';
import { MemoryWorker } from '../src/memory-worker.js';

vi.mock('../src/embedding.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
}));

const TEST_DB = './data/test-event-pipeline.db';

describe('reliable agent event pipeline', () => {
  let memories: MemoryStore;
  let events: AgentEventStore;

  beforeEach(() => {
    memories = new MemoryStore(TEST_DB);
    events = new AgentEventStore();
  });

  afterEach(() => {
    closeDatabase();
    for (const suffix of ['', '-shm', '-wal']) {
      if (fs.existsSync(`${TEST_DB}${suffix}`)) fs.unlinkSync(`${TEST_DB}${suffix}`);
    }
  });

  it('enqueues the same event exactly once by idempotency key', () => {
    const input = {
      idempotency_key: 'task-1:message-1',
      event_type: 'message' as const,
      payload: { text: 'client feedback' },
      task_id: 'task-1',
    };
    const first = events.enqueue(input);
    const second = events.enqueue(input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);
    expect((getDatabase().prepare('SELECT COUNT(*) AS count FROM agent_events').get() as { count: number }).count).toBe(1);
    expect((getDatabase().prepare('SELECT COUNT(*) AS count FROM event_outbox').get() as { count: number }).count).toBe(1);
  });

  it('isolates identical idempotency keys between tenants', () => {
    const tenantA = events.enqueue({
      idempotency_key: 'shared-business-key',
      tenant_id: 'agency-a',
      event_type: 'message',
      payload: { text: 'tenant A' },
    });
    const tenantB = events.enqueue({
      idempotency_key: 'shared-business-key',
      tenant_id: 'agency-b',
      event_type: 'message',
      payload: { text: 'tenant B' },
    });
    const replayA = events.enqueue({
      idempotency_key: 'shared-business-key',
      tenant_id: 'agency-a',
      event_type: 'message',
      payload: { text: 'must not replace tenant A' },
    });

    expect(tenantA.created).toBe(true);
    expect(tenantB.created).toBe(true);
    expect(tenantA.event.id).not.toBe(tenantB.event.id);
    expect(replayA).toMatchObject({ created: false, event: { id: tenantA.event.id, tenant_id: 'agency-a' } });
    expect(replayA.event.payload).toEqual({ text: 'tenant A' });
    expect(tenantA.event.idempotency_key).toBe('shared-business-key');
  });

  it('requires a space for team events', () => {
    expect(() => events.enqueue({
      idempotency_key: 'bad-team-event',
      event_type: 'message',
      payload: {},
      scope: 'team',
    })).toThrow('space_id is required');
  });

  it('redacts secrets before immutable events are persisted', () => {
    const queued = events.enqueue({
      idempotency_key: 'secret-event',
      event_type: 'tool_result',
      payload: {
        authorization: 'Bearer visible-secret-token',
        nested: { api_key: 'sk-1234567890abcdefghij' },
        text: 'command accidentally printed ghp_123456789012345678901234567890',
      },
    });

    expect(queued.event.redaction_count).toBe(3);
    expect(JSON.stringify(queued.event.payload)).not.toContain('visible-secret-token');
    expect(JSON.stringify(queued.event.payload)).not.toContain('sk-1234567890');
    expect(JSON.stringify(queued.event.payload)).not.toContain('ghp_1234567890');
  });

  it('turns a structured candidate into a scoped durable memory', async () => {
    const queued = events.enqueue({
      idempotency_key: 'hospital-a:feedback-1',
      tenant_id: 'agency',
      event_type: 'memory_candidate',
      payload: { memory: { content: 'Hospital A prefers restrained copy', type: 'preference', confidence: 0.95 } },
      project: 'hospital-a',
      scope: 'team',
      space_id: 'hospital-a-copy',
      task_id: 'copy-task-1',
      trace_id: 'trace-1',
      actor_id: 'writer-agent',
    });

    const result = await new MemoryWorker(events, memories).processBatch();
    const memory = memories.list(undefined, 'hospital-a')[0];

    expect(result).toEqual({ processed: 1, failed: 0, deadLettered: 0 });
    expect(memory).toMatchObject({
      tenant_id: 'agency',
      project: 'hospital-a',
      scope: 'team',
      space_id: 'hospital-a-copy',
      source_event_id: queued.event.id,
      source_conversation_id: 'copy-task-1',
    });
    expect(events.getOutbox(queued.event.id)?.status).toBe('completed');
  });

  it('routes low-confidence and sensitive memories to review without blocking the worker', async () => {
    events.enqueue({
      idempotency_key: 'hospital-a:sensitive-candidate',
      event_type: 'memory_candidate',
      payload: { memory: { content: 'Hospital A may prefer a private contact workflow', type: 'preference', confidence: 0.4, sensitivity: 'sensitive' } },
      project: 'hospital-a',
    });

    expect(await new MemoryWorker(events, memories).processBatch()).toEqual({ processed: 1, failed: 0, deadLettered: 0 });
    const pending = memories.list(undefined, 'hospital-a', { status: 'pending_review' });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      sensitivity: 'sensitive',
      review_reason: 'low confidence; sensitive content',
    });
    expect(memories.list(undefined, 'hospital-a')).toHaveLength(0);

    const approved = memories.review(pending[0].id, 'approve', 'hospital-a-owner', 'confirmed with client');
    expect(approved).toMatchObject({ status: 'active', reviewed_by: 'hospital-a-owner' });
    expect(memories.list(undefined, 'hospital-a')).toHaveLength(1);
  });

  it('dead-letters restricted team memories instead of sharing them', async () => {
    const queued = events.enqueue({
      idempotency_key: 'hospital-a:restricted-candidate',
      event_type: 'memory_candidate',
      payload: { memory: { content: 'Restricted patient detail', type: 'episode', sensitivity: 'restricted' } },
      project: 'hospital-a',
      scope: 'team',
      space_id: 'hospital-a-copy',
      max_attempts: 1,
    });

    expect(await new MemoryWorker(events, memories).processBatch()).toEqual({ processed: 0, failed: 0, deadLettered: 1 });
    expect(events.getOutbox(queued.event.id)?.status).toBe('dead_letter');
    expect(memories.list(undefined, 'hospital-a', { includeAll: true })).toHaveLength(0);
  });

  it('retries failures and moves exhausted work to dead letter', async () => {
    const queued = events.enqueue({
      idempotency_key: 'hospital-a:broken-extraction',
      event_type: 'message',
      payload: { text: 'unparseable' },
      max_attempts: 2,
    });
    const worker = new MemoryWorker(events, memories, async () => {
      throw new Error('extractor unavailable');
    });

    expect(await worker.processBatch()).toEqual({ processed: 0, failed: 1, deadLettered: 0 });
    getDatabase().prepare("UPDATE event_outbox SET available_at = '1970-01-01T00:00:00.000Z' WHERE event_id = ?").run(queued.event.id);
    expect(await worker.processBatch()).toEqual({ processed: 0, failed: 0, deadLettered: 1 });
    expect(events.getOutbox(queued.event.id)).toMatchObject({ status: 'dead_letter', attempts: 2 });
  });

  it('deduplicates a candidate replayed after the memory was written', async () => {
    const queued = events.enqueue({
      idempotency_key: 'hospital-a:candidate-replay',
      event_type: 'memory_candidate',
      payload: { content: 'Use the hospital full legal name', type: 'rule' },
      project: 'hospital-a',
    });
    await memories.write({
      content: 'Use the hospital full legal name',
      type: 'rule',
      project: 'hospital-a',
      source_event_id: queued.event.id,
    });

    const result = await new MemoryWorker(events, memories).processBatch();

    expect(result.processed).toBe(1);
    expect(memories.list(undefined, 'hospital-a')).toHaveLength(1);
    expect(events.getOutbox(queued.event.id)?.status).toBe('completed');
  });
});
