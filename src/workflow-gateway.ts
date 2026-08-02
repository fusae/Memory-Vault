import { createHash, randomUUID } from 'node:crypto';
import { getDatabase } from './db.js';
import type { AgentEventStore } from './event-store.js';
import type { MemoryStore } from './memory-store.js';
import type { MemoryWorker } from './memory-worker.js';
import type { PolicyStore } from './policy-store.js';
import { buildRecallContext } from './recall.js';
import type { MemorySensitivity, MemoryType, WorkflowRun } from './types.js';

type WorkflowRow = Omit<WorkflowRun, 'review' | 'context_refs' | 'required_policy_refs'> & {
  review_json: string | null;
  context_refs: string;
  required_policy_refs: string;
};

function parseRow(row: WorkflowRow): WorkflowRun {
  const { review_json, ...rest } = row;
  return {
    ...rest,
    review: review_json ? JSON.parse(review_json) as WorkflowRun['review'] : null,
    context_refs: JSON.parse(row.context_refs) as string[],
    required_policy_refs: JSON.parse(row.required_policy_refs) as string[],
  };
}

function extractRefs(context: string): string[] {
  return [...context.matchAll(/(?:memory|policy)_ref:([^\]|]+)/g)].map(match => match[1]);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function decisionHash(input: {
  reviewer: string;
  decision: 'approve' | 'reject';
  reason?: string;
  experience?: unknown;
}): string {
  return createHash('sha256').update(JSON.stringify({
    reviewer: input.reviewer.trim(),
    decision: input.decision,
    reason: input.reason?.trim() || null,
    experience: input.experience ?? null,
  })).digest('hex');
}

export class WorkflowGateway {
  constructor(
    private readonly events: AgentEventStore,
    private readonly memories: MemoryStore,
    private readonly policies: PolicyStore,
    private readonly worker: MemoryWorker,
  ) {}

  async start(input: {
    task_id: string;
    request: string;
    tenant_id?: string;
    project: string;
    space_id: string;
    trace_id?: string;
    manager_id?: string;
    writer_id: string;
  }): Promise<{ run: WorkflowRun; manager_context: string; writer_context: string }> {
    const tenantId = input.tenant_id?.trim() || 'local';
    const taskId = input.task_id.trim();
    const project = input.project.trim();
    const spaceId = input.space_id.trim();
    if (!taskId || !project || !spaceId || !input.request.trim() || !input.writer_id.trim()) {
      throw new Error('task_id, request, project, space_id, and writer_id are required');
    }
    if (!this.memories.listSpaces().some(space => space.space_id === spaceId)) {
      throw new Error(`Space is not joined: ${spaceId}`);
    }
    const existing = this.get(taskId, tenantId);
    if (existing && existing.status !== 'started') {
      if (existing.status === 'writing') {
        const managerContext = await this.recall(existing, 'task_start', existing.request, input.manager_id ?? 'manager');
        const writerContext = await this.recall(existing, 'agent_handoff', existing.request, existing.writer_id ?? input.writer_id);
        return { run: this.require(taskId, tenantId), manager_context: managerContext, writer_context: writerContext };
      }
      return { run: existing, manager_context: '', writer_context: '' };
    }

    let id = existing?.id;
    if (!existing) {
      const now = new Date().toISOString();
      const traceId = input.trace_id?.trim() || randomUUID();
      id = randomUUID();
      getDatabase().prepare(`
        INSERT INTO workflow_runs (
          id, task_id, trace_id, tenant_id, project, space_id, status, request,
          writer_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'started', ?, ?, ?, ?)
      `).run(id, taskId, traceId, tenantId, project, spaceId, input.request.trim(), input.writer_id.trim(), now, now);
    }

    try {
      const persisted = this.require(taskId, tenantId);
      const writerId = persisted.writer_id ?? input.writer_id;
      this.record(persisted, 'task_started', 'start', input.manager_id ?? 'manager', {
        request: persisted.request,
      });
      const managerContext = await this.recall(persisted, 'task_start', persisted.request, input.manager_id ?? 'manager');
      this.record(persisted, 'task_handoff', 'writer-handoff', input.manager_id ?? 'manager', {
        from: input.manager_id ?? 'manager', to: writerId,
      });
      const writerContext = await this.recall(persisted, 'agent_handoff', persisted.request, writerId);
      const refs = unique([...extractRefs(managerContext), ...extractRefs(writerContext)]);
      getDatabase().prepare(`
        UPDATE workflow_runs SET status = 'writing', context_refs = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(refs), new Date().toISOString(), id!);
      return { run: this.require(taskId, tenantId), manager_context: managerContext, writer_context: writerContext };
    } catch (error) {
      this.failRun(this.require(taskId, tenantId), error);
      throw error;
    }
  }

  async recallForTrigger(input: {
    task_id: string;
    tenant_id?: string;
    actor_id: string;
    trigger: 'failure_retry' | 'tool_boundary';
    attempt?: number;
    tool_name?: string;
    query?: string;
  }): Promise<{ run: WorkflowRun; context: string; required_policy_refs: string[] }> {
    const run = this.require(input.task_id, input.tenant_id);
    const actorId = input.actor_id.trim();
    const expectedActor = run.status === 'writing'
      ? run.writer_id
      : run.status === 'reviewing'
        ? run.reviewer_id
        : undefined;
    if (!expectedActor) throw new Error(`Workflow ${run.task_id} does not allow runtime recall while ${run.status}`);
    if (actorId !== expectedActor) throw new Error(`Only the active ${run.status === 'writing' ? 'writer' : 'reviewer'} can recall workflow context`);

    let policies = this.policies.list({
      tenant_id: run.tenant_id,
      project: run.project,
      space_id: run.space_id,
      status: 'approved',
    });
    let stage: string;
    if (input.trigger === 'failure_retry') {
      if (!Number.isInteger(input.attempt) || (input.attempt ?? 0) < 1) {
        throw new Error('failure_retry requires a positive integer attempt');
      }
      stage = `recall-failure-retry-${actorId}-${input.attempt}`;
    } else {
      const toolName = input.tool_name?.trim() || '';
      if (!toolName) throw new Error('tool_boundary requires tool_name');
      policies = this.policies.approvedForToolBoundary({
        tenant_id: run.tenant_id,
        project: run.project,
        space_id: run.space_id,
        tool_name: toolName,
      });
      if (policies.length === 0) throw new Error(`No approved Policy requires recall at tool boundary: ${toolName}`);
      stage = `recall-tool-boundary-${actorId}-${toolName}`;
    }

    const context = await buildRecallContext(this.memories, {
      project: run.project,
      tenantId: run.tenant_id,
      spaceId: run.space_id,
      query: input.query?.trim() || run.request,
      trigger: input.trigger,
      sourceTool: `workflow-gateway:${actorId}`,
    });
    const refs = unique([...run.context_refs, ...extractRefs(context)]);
    getDatabase().prepare('UPDATE workflow_runs SET context_refs = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(refs), new Date().toISOString(), run.id);
    const requiredPolicyRefs = unique(policies.map(policy => policy.policy_ref));
    this.record(run, 'tool_call', stage, actorId, {
      trigger: input.trigger,
      attempt: input.attempt,
      tool_name: input.tool_name,
      context_refs: extractRefs(context),
      required_policy_refs: requiredPolicyRefs,
    });
    return { run: this.require(run.task_id, run.tenant_id), context, required_policy_refs: requiredPolicyRefs };
  }

  async submitDraft(input: { task_id: string; tenant_id?: string; actor_id: string; draft: string; reviewer_id: string }): Promise<{
    run: WorkflowRun;
    reviewer_context: string;
    required_policy_refs: string[];
  }> {
    const run = this.require(input.task_id, input.tenant_id);
    if (!input.draft.trim() || !input.actor_id.trim() || !input.reviewer_id.trim()) {
      throw new Error('draft, actor_id, and reviewer_id are required');
    }
    if (input.actor_id !== run.writer_id) throw new Error('Only the assigned writer can submit the draft');
    if (run.status !== 'writing') {
      const replay = run.draft === input.draft.trim() && run.reviewer_id === input.reviewer_id.trim()
        && ['reviewing', 'awaiting_human_approval', 'completed', 'rejected'].includes(run.status);
      if (!replay) this.requireStatus(run, 'writing');
      const reviewerContext = run.status === 'reviewing'
        ? await this.recall(run, 'agent_handoff', run.request, input.reviewer_id)
        : '';
      return { run: this.require(run.task_id, run.tenant_id), reviewer_context: reviewerContext, required_policy_refs: run.required_policy_refs };
    }

    const resumingDraft = run.artifact_revision > 0;
    if (resumingDraft && (run.draft !== input.draft.trim() || run.reviewer_id !== input.reviewer_id.trim())) {
      throw new Error('A different draft is already pending reviewer handoff');
    }
    const revision = resumingDraft ? run.artifact_revision : run.artifact_revision + 1;
    if (!resumingDraft) {
      const now = new Date().toISOString();
      getDatabase().transaction(() => {
        getDatabase().prepare(`
          INSERT INTO workflow_artifacts (id, workflow_id, stage, content, actor_id, revision, created_at)
          VALUES (?, ?, 'draft', ?, ?, ?, ?)
        `).run(randomUUID(), run.id, input.draft.trim(), input.actor_id, revision, now);
        getDatabase().prepare(`
          UPDATE workflow_runs SET draft = ?, artifact_revision = ?, reviewer_id = ?, updated_at = ? WHERE id = ?
        `).run(input.draft.trim(), revision, input.reviewer_id.trim(), now, run.id);
      })();
    }

    this.record(run, 'tool_result', `draft-${revision}`, input.actor_id, { artifact_revision: revision });
    this.record(run, 'task_handoff', 'reviewer-handoff', input.actor_id, { from: input.actor_id, to: input.reviewer_id });
    const reviewerContext = await this.recall(run, 'agent_handoff', run.request, input.reviewer_id);
    const requiredPolicies = unique([
      ...this.policies.list({ tenant_id: run.tenant_id, project: run.project, status: 'approved' }),
      ...this.policies.list({ tenant_id: run.tenant_id, project: run.project, space_id: run.space_id, status: 'approved' }),
    ].map(policy => policy.policy_ref));
    if (requiredPolicies.length === 0) {
      const error = new Error('Managed workflow requires at least one approved policy');
      this.failRun(run, error);
      throw error;
    }
    const refs = unique([...run.context_refs, ...extractRefs(reviewerContext), ...requiredPolicies]);
    getDatabase().prepare(`
      UPDATE workflow_runs
      SET status = 'reviewing', context_refs = ?, required_policy_refs = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(refs), JSON.stringify(requiredPolicies), new Date().toISOString(), run.id);
    return { run: this.require(run.task_id, run.tenant_id), reviewer_context: reviewerContext, required_policy_refs: requiredPolicies };
  }

  submitReview(input: {
    task_id: string;
    tenant_id?: string;
    actor_id: string;
    decision: 'approved' | 'rejected';
    findings: string;
    policy_refs: string[];
  }): WorkflowRun {
    const run = this.require(input.task_id, input.tenant_id);
    const review = { decision: input.decision, findings: input.findings.trim(), policy_refs: unique(input.policy_refs) };
    if (run.status !== 'reviewing') {
      if (JSON.stringify(run.review) !== JSON.stringify(review)) this.requireStatus(run, 'reviewing');
      if (input.actor_id !== run.reviewer_id) throw new Error('Only the assigned reviewer can submit the review');
      this.record(run, 'feedback', `review-${run.artifact_revision}`, input.actor_id, review);
      if (input.decision === 'rejected') {
        this.record(run, 'task_failed', 'review-rejected', input.actor_id, { findings: review.findings, rollback_to_revision: 0 });
      }
      return this.require(run.task_id, run.tenant_id);
    }
    if (input.actor_id !== run.reviewer_id) throw new Error('Only the assigned reviewer can submit the review');
    const currentApproved = new Set([
      ...this.policies.list({ tenant_id: run.tenant_id, project: run.project, status: 'approved' }),
      ...this.policies.list({ tenant_id: run.tenant_id, project: run.project, space_id: run.space_id, status: 'approved' }),
    ].map(policy => policy.policy_ref));
    if (input.policy_refs.some(ref => !currentApproved.has(ref))) {
      throw new Error('Review references a stale, unapproved, or out-of-scope policy');
    }
    if (input.decision === 'approved' && run.required_policy_refs.some(ref => !input.policy_refs.includes(ref))) {
      throw new Error('Approved review must attest every required policy_ref');
    }

    const now = new Date().toISOString();
    const status = input.decision === 'approved' ? 'awaiting_human_approval' : 'rejected';
    getDatabase().prepare(`
      UPDATE workflow_runs SET status = ?, review_json = ?, updated_at = ? WHERE id = ?
    `).run(status, JSON.stringify(review), now, run.id);
    this.record(run, 'feedback', `review-${run.artifact_revision}`, input.actor_id, review);
    if (input.decision === 'rejected') {
      this.record(run, 'task_failed', 'review-rejected', input.actor_id, { findings: review.findings, rollback_to_revision: 0 });
    }
    return this.require(run.task_id, run.tenant_id);
  }

  async humanDecide(input: {
    task_id: string;
    tenant_id?: string;
    reviewer: string;
    decision: 'approve' | 'reject';
    reason?: string;
    experience?: { content: string; type?: MemoryType; confidence?: number; sensitivity?: MemorySensitivity; tags?: string[] };
  }): Promise<{ run: WorkflowRun; memory_ref?: string }> {
    const run = this.require(input.task_id, input.tenant_id);
    if (!input.reviewer.trim()) throw new Error('reviewer is required');
    const requestHash = decisionHash(input);
    const expectedStatus = input.decision === 'approve' ? 'completed' : 'rejected';
    if (run.status !== 'awaiting_human_approval') {
      if (run.status !== expectedStatus || run.human_reviewer !== input.reviewer.trim() || run.decision_hash !== requestHash) {
        this.requireStatus(run, 'awaiting_human_approval');
      }
      this.record(run, 'feedback', 'human-decision', input.reviewer, {
        decision: input.decision, reason: input.reason, artifact_revision: run.artifact_revision,
      });
      if (input.decision === 'reject') {
        this.record(run, 'task_failed', 'human-rejected', input.reviewer, { rollback_to_revision: 0, reason: input.reason });
        return { run: this.require(run.task_id, run.tenant_id) };
      }
      this.record(run, 'task_completed', 'completed', input.reviewer, {
        artifact_revision: run.artifact_revision, context_refs: run.context_refs,
      });
      return { run: this.require(run.task_id, run.tenant_id), memory_ref: await this.persistExperience(run, input) };
    }
    const now = new Date().toISOString();
    const status = input.decision === 'approve' ? 'completed' : 'rejected';
    getDatabase().prepare(`
      UPDATE workflow_runs
      SET status = ?, human_reviewer = ?, decision_reason = ?, decision_hash = ?, updated_at = ? WHERE id = ?
    `).run(status, input.reviewer.trim(), input.reason?.trim() || null, requestHash, now, run.id);
    this.record(run, 'feedback', 'human-decision', input.reviewer, {
      decision: input.decision, reason: input.reason, artifact_revision: run.artifact_revision,
    });
    if (input.decision === 'reject') {
      this.record(run, 'task_failed', 'human-rejected', input.reviewer, { rollback_to_revision: 0, reason: input.reason });
      return { run: this.require(run.task_id, run.tenant_id) };
    }

    this.record(run, 'task_completed', 'completed', input.reviewer, {
      artifact_revision: run.artifact_revision,
      context_refs: run.context_refs,
    });
    const memoryRef = await this.persistExperience(run, input);
    return { run: this.require(run.task_id, run.tenant_id), memory_ref: memoryRef };
  }

  private async persistExperience(run: WorkflowRun, input: {
    reviewer: string;
    experience?: { content: string; type?: MemoryType; confidence?: number; sensitivity?: MemorySensitivity; tags?: string[] };
  }): Promise<string | undefined> {
    let memoryRef: string | undefined;
    if (input.experience?.content.trim()) {
      const candidate = this.events.enqueue({
        idempotency_key: this.eventKey(run, 'experience'),
        tenant_id: run.tenant_id,
        event_type: 'memory_candidate',
        payload: { memory: {
          content: input.experience.content.trim(),
          type: input.experience.type ?? 'episode',
          confidence: input.experience.confidence ?? 0.9,
          sensitivity: input.experience.sensitivity ?? 'normal',
          tags: input.experience.tags ?? ['workflow', run.project],
          source_tool: 'workflow-gateway',
        } },
        project: run.project,
        scope: 'team',
        space_id: run.space_id,
        task_id: run.task_id,
        trace_id: run.trace_id,
        actor_id: input.reviewer,
      });
      await this.worker.processBatch(100);
      const row = getDatabase().prepare('SELECT id, revision FROM memories WHERE source_event_id = ?').get(candidate.event.id) as { id: string; revision: number } | undefined;
      if (row) memoryRef = `${row.id}@${row.revision}`;
    }
    return memoryRef;
  }

  get(taskId: string, tenantId = 'local'): WorkflowRun | null {
    const row = getDatabase().prepare('SELECT * FROM workflow_runs WHERE tenant_id = ? AND task_id = ?')
      .get(tenantId.trim() || 'local', taskId.trim()) as WorkflowRow | undefined;
    return row ? parseRow(row) : null;
  }

  list(input: { tenant_id?: string; project?: string; space_id?: string; status?: WorkflowRun['status'] } = {}): WorkflowRun[] {
    const conditions = ['tenant_id = ?'];
    const params: unknown[] = [input.tenant_id?.trim() || 'local'];
    if (input.project) { conditions.push('project = ?'); params.push(input.project); }
    if (input.space_id) { conditions.push('space_id = ?'); params.push(input.space_id); }
    if (input.status) { conditions.push('status = ?'); params.push(input.status); }
    const rows = getDatabase().prepare(`
      SELECT * FROM workflow_runs WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, id DESC
    `).all(...params) as WorkflowRow[];
    return rows.map(parseRow);
  }

  private require(taskId: string, tenantId = 'local'): WorkflowRun {
    const run = this.get(taskId, tenantId);
    if (!run) throw new Error(`Workflow not found: ${taskId}`);
    return run;
  }

  private requireStatus(run: WorkflowRun, expected: WorkflowRun['status']): void {
    if (run.status !== expected) throw new Error(`Workflow ${run.task_id} is ${run.status}; expected ${expected}`);
  }

  private eventKey(run: WorkflowRun, stage: string): string {
    return `workflow:${run.tenant_id}:${run.task_id}:${stage}`;
  }

  private record(run: WorkflowRun, eventType: Parameters<AgentEventStore['enqueue']>[0]['event_type'], stage: string, actorId: string, payload: Record<string, unknown>): void {
    this.events.enqueue({
      idempotency_key: this.eventKey(run, stage),
      tenant_id: run.tenant_id,
      event_type: eventType,
      payload,
      project: run.project,
      scope: 'team',
      space_id: run.space_id,
      task_id: run.task_id,
      trace_id: run.trace_id,
      actor_id: actorId,
    });
  }

  private async recall(run: WorkflowRun, trigger: 'task_start' | 'agent_handoff', query: string, actorId: string): Promise<string> {
    const context = await buildRecallContext(this.memories, {
      project: run.project,
      tenantId: run.tenant_id,
      spaceId: run.space_id,
      query,
      trigger,
      sourceTool: `workflow-gateway:${actorId}`,
    });
    this.record(run, 'tool_call', `recall-${trigger}-${actorId}`, actorId, { trigger, context_refs: extractRefs(context) });
    return context;
  }

  private failRun(run: WorkflowRun, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    getDatabase().prepare("UPDATE workflow_runs SET status = 'failed', decision_reason = ?, updated_at = ? WHERE id = ?")
      .run(message.slice(0, 2000), new Date().toISOString(), run.id);
    this.record(run, 'task_failed', 'gateway-failed', 'workflow-gateway', { error: message });
  }
}
