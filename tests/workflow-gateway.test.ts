import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../src/db.js';
import { AgentEventStore } from '../src/event-store.js';
import { MemoryStore } from '../src/memory-store.js';
import { MemoryWorker } from '../src/memory-worker.js';
import { PolicyStore } from '../src/policy-store.js';
import { WorkflowGateway } from '../src/workflow-gateway.js';

vi.mock('../src/embedding.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
}));

const TEST_DB = './data/test-workflow-gateway.db';

describe('WorkflowGateway', () => {
  let memories: MemoryStore;
  let policies: PolicyStore;
  let gateway: WorkflowGateway;
  let approvedPolicyRef: string;

  beforeEach(async () => {
    memories = new MemoryStore(TEST_DB);
    memories.joinSpace('hospital-a-copy', 'Hospital A Copy');
    memories.joinSpace('hospital-b-copy', 'Hospital B Copy');
    await memories.write({
      tenant_id: 'agency',
      content: 'Hospital A prefers restrained, factual copy.',
      type: 'preference',
      project: 'hospital-a',
      scope: 'team',
      space_id: 'hospital-a-copy',
    });
    await memories.write({
      tenant_id: 'agency',
      content: 'Hospital B prefers playful copy and must not leak.',
      type: 'preference',
      project: 'hospital-a',
      scope: 'team',
      space_id: 'hospital-b-copy',
    });
    policies = new PolicyStore();
    const policy = policies.create({
      tenant_id: 'agency',
      project: 'hospital-a',
      space_id: 'hospital-a-copy',
      title: 'Medical advertising claims',
      content: 'Do not use absolute efficacy claims.',
      tool_boundaries: ['cms.publish'],
    });
    approvedPolicyRef = policies.approve(policy.policy_ref, 'compliance-owner').policy_ref;
    const events = new AgentEventStore();
    const worker = new MemoryWorker(events, memories);
    gateway = new WorkflowGateway(events, memories, policies, worker);
  });

  afterEach(() => {
    closeDatabase();
    for (const suffix of ['', '-shm', '-wal']) {
      if (fs.existsSync(`${TEST_DB}${suffix}`)) fs.unlinkSync(`${TEST_DB}${suffix}`);
    }
  });

  it('enforces recall, independent review, human approval, and durable experience writeback', async () => {
    const started = await gateway.start({
      task_id: 'hospital-a-copy-001',
      trace_id: 'trace-copy-001',
      tenant_id: 'agency',
      project: 'hospital-a',
      space_id: 'hospital-a-copy',
      request: 'Write a World Heart Day clinic announcement.',
      manager_id: 'manager',
      writer_id: 'hospital-a-writer',
    });

    expect(started.run.status).toBe('writing');
    expect(started.writer_context).toContain('Hospital A prefers restrained, factual copy.');
    expect(started.writer_context).toContain(approvedPolicyRef);
    expect(started.writer_context).toContain('|版本:1|置信度:0.80|');
    expect(started.writer_context).not.toContain('Hospital B prefers playful copy');
    const restartedEvents = new AgentEventStore();
    const restartedGateway = new WorkflowGateway(restartedEvents, memories, policies, new MemoryWorker(restartedEvents, memories));
    const replayedStart = await restartedGateway.start({
      task_id: 'hospital-a-copy-001',
      trace_id: 'ignored-on-replay',
      tenant_id: 'agency',
      project: 'hospital-a',
      space_id: 'hospital-a-copy',
      request: 'Write a World Heart Day clinic announcement.',
      manager_id: 'manager',
      writer_id: 'hospital-a-writer',
    });
    expect(replayedStart.run.id).toBe(started.run.id);
    expect(replayedStart.writer_context).toContain('Hospital A prefers restrained, factual copy.');
    expect(() => gateway.submitReview({
      task_id: started.run.task_id,
      tenant_id: 'agency',
      actor_id: 'hospital-a-reviewer',
      decision: 'approved',
      findings: 'premature',
      policy_refs: [approvedPolicyRef],
    })).toThrow('expected reviewing');

    await expect(gateway.submitDraft({
      task_id: started.run.task_id,
      tenant_id: 'agency',
      actor_id: 'intruder',
      reviewer_id: 'hospital-a-reviewer',
      draft: 'Unauthorized draft',
    })).rejects.toThrow('assigned writer');

    await expect(gateway.recallForTrigger({
      task_id: started.run.task_id,
      tenant_id: 'agency',
      actor_id: 'hospital-a-writer',
      trigger: 'failure_retry',
    })).rejects.toThrow('positive integer attempt');
    await expect(gateway.recallForTrigger({
      task_id: started.run.task_id,
      tenant_id: 'agency',
      actor_id: 'intruder',
      trigger: 'failure_retry',
      attempt: 1,
    })).rejects.toThrow('active writer');
    const retryRecall = await gateway.recallForTrigger({
      task_id: started.run.task_id,
      tenant_id: 'agency',
      actor_id: 'hospital-a-writer',
      trigger: 'failure_retry',
      attempt: 1,
    });
    expect(retryRecall.context).toContain('Hospital A prefers restrained, factual copy.');
    await expect(gateway.recallForTrigger({
      task_id: started.run.task_id,
      tenant_id: 'agency',
      actor_id: 'hospital-a-writer',
      trigger: 'tool_boundary',
      tool_name: 'email.send',
    })).rejects.toThrow('No approved Policy');
    const boundaryRecall = await gateway.recallForTrigger({
      task_id: started.run.task_id,
      tenant_id: 'agency',
      actor_id: 'hospital-a-writer',
      trigger: 'tool_boundary',
      tool_name: 'cms.publish',
    });
    expect(boundaryRecall.required_policy_refs).toEqual([approvedPolicyRef]);

    const drafted = await gateway.submitDraft({
      task_id: started.run.task_id,
      tenant_id: 'agency',
      actor_id: 'hospital-a-writer',
      reviewer_id: 'hospital-a-reviewer',
      draft: 'Hospital A will hold a World Heart Day public clinic. Details are subject to confirmation.',
    });
    expect(drafted.run.status).toBe('reviewing');
    expect(drafted.required_policy_refs).toContain(approvedPolicyRef);
    const replayedDraft = await restartedGateway.submitDraft({
      task_id: started.run.task_id,
      tenant_id: 'agency',
      actor_id: 'hospital-a-writer',
      reviewer_id: 'hospital-a-reviewer',
      draft: 'Hospital A will hold a World Heart Day public clinic. Details are subject to confirmation.',
    });
    expect(replayedDraft.run.artifact_revision).toBe(1);
    expect(() => gateway.submitReview({
      task_id: started.run.task_id,
      tenant_id: 'agency',
      actor_id: 'hospital-a-reviewer',
      decision: 'approved',
      findings: 'No absolute claims.',
      policy_refs: [],
    })).toThrow('every required policy_ref');

    const reviewed = gateway.submitReview({
      task_id: started.run.task_id,
      tenant_id: 'agency',
      actor_id: 'hospital-a-reviewer',
      decision: 'approved',
      findings: 'No absolute claims; event details remain marked for confirmation.',
      policy_refs: drafted.required_policy_refs,
    });
    expect(reviewed.status).toBe('awaiting_human_approval');
    expect(restartedGateway.submitReview({
      task_id: started.run.task_id,
      tenant_id: 'agency',
      actor_id: 'hospital-a-reviewer',
      decision: 'approved',
      findings: 'No absolute claims; event details remain marked for confirmation.',
      policy_refs: drafted.required_policy_refs,
    }).status).toBe('awaiting_human_approval');

    const completed = await gateway.humanDecide({
      task_id: started.run.task_id,
      tenant_id: 'agency',
      reviewer: 'hospital-a-owner',
      decision: 'approve',
      reason: 'Client owner approved revision 1.',
      experience: {
        content: 'For Hospital A event copy, leave unconfirmed time and location as explicit confirmation items.',
        type: 'episode',
        confidence: 0.95,
      },
    });

    expect(completed.run).toMatchObject({ status: 'completed', artifact_revision: 1, human_reviewer: 'hospital-a-owner' });
    expect(completed.memory_ref).toMatch(/@1$/);
    const replayedCompletion = await restartedGateway.humanDecide({
      task_id: started.run.task_id,
      tenant_id: 'agency',
      reviewer: 'hospital-a-owner',
      decision: 'approve',
      reason: 'Client owner approved revision 1.',
      experience: {
        content: 'For Hospital A event copy, leave unconfirmed time and location as explicit confirmation items.',
        type: 'episode',
        confidence: 0.95,
      },
    });
    expect(replayedCompletion.memory_ref).toBe(completed.memory_ref);
    await expect(restartedGateway.humanDecide({
      task_id: started.run.task_id,
      tenant_id: 'agency',
      reviewer: 'hospital-a-owner',
      decision: 'approve',
      reason: 'Client owner approved revision 1.',
    })).rejects.toThrow('expected awaiting_human_approval');
    expect(memories.list(undefined, 'hospital-a').some(memory => memory.memory_ref === completed.memory_ref)).toBe(true);
    expect((getDatabase().prepare('SELECT COUNT(*) AS count FROM workflow_artifacts WHERE workflow_id = ?').get(started.run.id) as { count: number }).count).toBe(1);
    expect((getDatabase().prepare("SELECT COUNT(*) AS count FROM agent_events WHERE task_id = ? AND event_type = 'memory_candidate'").get(started.run.task_id) as { count: number }).count).toBe(1);
    const eventTypes = (getDatabase().prepare('SELECT event_type FROM agent_events WHERE task_id = ? ORDER BY created_at, rowid').all(started.run.task_id) as { event_type: string }[])
      .map(row => row.event_type);
    expect(eventTypes).toContain('task_started');
    expect(eventTypes).toContain('task_handoff');
    expect(eventTypes).toContain('task_completed');
    expect(eventTypes).toContain('memory_candidate');
    expect((getDatabase().prepare("SELECT COUNT(*) AS count FROM event_outbox WHERE status != 'completed'").get() as { count: number }).count).toBe(0);
  });

  it('rolls back a rejected artifact and prevents later human publication', async () => {
    const started = await gateway.start({
      task_id: 'hospital-a-copy-002',
      tenant_id: 'agency',
      project: 'hospital-a',
      space_id: 'hospital-a-copy',
      request: 'Write a clinic promotion.',
      writer_id: 'writer',
    });
    const drafted = await gateway.submitDraft({
      task_id: started.run.task_id,
      tenant_id: 'agency',
      actor_id: 'writer',
      reviewer_id: 'reviewer',
      draft: 'This treatment is guaranteed to cure every patient.',
    });
    const rejected = gateway.submitReview({
      task_id: started.run.task_id,
      tenant_id: 'agency',
      actor_id: 'reviewer',
      decision: 'rejected',
      findings: 'Absolute efficacy claim violates policy.',
      policy_refs: drafted.required_policy_refs,
    });

    expect(rejected.status).toBe('rejected');
    await expect(gateway.humanDecide({
      task_id: started.run.task_id,
      tenant_id: 'agency',
      reviewer: 'owner',
      decision: 'approve',
    })).rejects.toThrow('expected awaiting_human_approval');
    const failed = getDatabase().prepare("SELECT payload FROM agent_events WHERE task_id = ? AND event_type = 'task_failed'").get(started.run.task_id) as { payload: string };
    expect(JSON.parse(failed.payload)).toMatchObject({ rollback_to_revision: 0 });
  });
});
