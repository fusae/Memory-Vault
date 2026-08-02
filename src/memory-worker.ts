import type { MemoryStore } from './memory-store.js';
import { AgentEventStore } from './event-store.js';
import type { AgentEvent, CreateMemoryInput } from './types.js';

export type MemoryExtractor = (event: AgentEvent) => Promise<CreateMemoryInput | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const structuredCandidateExtractor: MemoryExtractor = async event => {
  if (event.event_type !== 'memory_candidate') return null;
  const candidate = isRecord(event.payload.memory) ? event.payload.memory : event.payload;
  if (typeof candidate.content !== 'string' || typeof candidate.type !== 'string') {
    throw new Error('memory_candidate requires content and type');
  }
  if (!['identity', 'preference', 'project', 'episode', 'rule'].includes(candidate.type)) {
    throw new Error(`invalid memory type: ${candidate.type}`);
  }
  return candidate as unknown as CreateMemoryInput;
};

function governCandidate(candidate: CreateMemoryInput, event: AgentEvent): CreateMemoryInput {
  const sensitivity = candidate.sensitivity ?? (event.redaction_count > 0 ? 'sensitive' : 'normal');
  const confidence = candidate.confidence ?? 0.8;
  if (sensitivity === 'restricted' && (candidate.scope ?? event.scope) === 'team') {
    throw new Error('restricted memory cannot be published to a team space');
  }
  const reasons: string[] = [];
  if (confidence < 0.5) reasons.push('low confidence');
  if (sensitivity !== 'normal') reasons.push(`${sensitivity} content`);
  return {
    ...candidate,
    sensitivity,
    confidence,
    review_required: candidate.review_required || reasons.length > 0,
    review_reason: candidate.review_reason ?? (reasons.join('; ') || undefined),
  };
}

export class MemoryWorker {
  constructor(
    private readonly events: AgentEventStore,
    private readonly memories: MemoryStore,
    private readonly extractor: MemoryExtractor = structuredCandidateExtractor,
  ) {}

  async processBatch(limit = 10): Promise<{ processed: number; failed: number; deadLettered: number }> {
    this.events.requeueStale();
    const claimed = this.events.claimBatch(limit);
    let processed = 0;
    let failed = 0;
    let deadLettered = 0;

    for (const item of claimed) {
      try {
        const extracted = await this.extractor(item.event);
        const candidate = extracted ? governCandidate(extracted, item.event) : null;
        if (candidate) {
          await this.memories.write({
            ...candidate,
            tenant_id: item.event.tenant_id,
            project: candidate.project ?? item.event.project ?? undefined,
            scope: candidate.scope ?? item.event.scope,
            space_id: candidate.space_id ?? item.event.space_id ?? undefined,
            source_event_id: item.event.id,
            source_conversation_id: candidate.source_conversation_id ?? item.event.task_id ?? undefined,
          });
        }
        this.events.complete(item.outbox.id);
        processed++;
      } catch (error) {
        const status = this.events.fail(item.outbox.id, error);
        if (status === 'dead_letter') deadLettered++;
        else failed++;
      }
    }

    return { processed, failed, deadLettered };
  }
}
