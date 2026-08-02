#!/usr/bin/env node
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeDatabase, getDatabase } from './db.js';
import { AgentEventStore } from './event-store.js';
import { MemoryStore } from './memory-store.js';
import { MemoryWorker } from './memory-worker.js';
import { PolicyStore } from './policy-store.js';
import { SpaceKeyService } from './space-crypto.js';
import { WorkflowGateway } from './workflow-gateway.js';
import { getMemoryDbPath } from './path-utils.js';

export async function runHospitalADemo(input: {
  dbPath: string;
  taskId?: string;
  identity?: ReturnType<typeof SpaceKeyService.generateIdentity>;
}): Promise<Record<string, unknown>> {
  const dbPath = getMemoryDbPath(input.dbPath);
  const identity = input.identity ?? SpaceKeyService.generateIdentity('hospital-a-demo-owner');
  const spaceKeys = new SpaceKeyService(identity);
  const memories = new MemoryStore(dbPath, undefined, spaceKeys);
  if (!memories.listSpaces().some(space => space.space_id === 'hospital-a-copy')) {
    spaceKeys.createSpace('hospital-a-copy', 'Hospital A Copy');
  }
  const existingPreference = memories.listJoinedTeamMemories('hospital-a', 'agency', 'hospital-a-copy')
    .find(memory => memory.content.includes('克制、准确'));
  const preference = existingPreference ?? (await memories.write({
    tenant_id: 'agency',
    content: '医院 A 偏好克制、准确的文案，不使用夸张承诺。',
    type: 'preference',
    project: 'hospital-a',
    scope: 'team',
    space_id: 'hospital-a-copy',
    confidence: 0.98,
    source_tool: 'hospital-demo-seed',
  })).memory;

  const policies = new PolicyStore();
  let policy = policies.list({ tenant_id: 'agency', project: 'hospital-a', space_id: 'hospital-a-copy', status: 'approved' })[0];
  if (!policy) {
    const draft = policies.create({
      tenant_id: 'agency',
      project: 'hospital-a',
      space_id: 'hospital-a-copy',
      title: '医疗宣传合规规则',
      content: '不得使用保证治愈、疗效第一等绝对化医疗宣传表述；未确认的时间和地点必须标记待确认。',
      tool_boundaries: ['hospital-copy.render'],
      source: 'hospital-a-compliance-owner',
    });
    policy = policies.approve(draft.policy_ref, 'hospital-a-compliance-owner');
  } else if (!policy.tool_boundaries.includes('hospital-copy.render')) {
    const revised = policies.update(policy.policy_ref, {
      tool_boundaries: [...policy.tool_boundaries, 'hospital-copy.render'],
      reason: 'add governed copy-render tool boundary',
    });
    policy = policies.approve(revised.policy_ref, 'hospital-a-compliance-owner');
  }

  const events = new AgentEventStore();
  const worker = new MemoryWorker(events, memories);
  const gateway = new WorkflowGateway(events, memories, policies, worker);
  const taskId = input.taskId ?? `hospital-a-${randomUUID().slice(0, 8)}`;
  const started = await gateway.start({
    task_id: taskId,
    tenant_id: 'agency',
    project: 'hospital-a',
    space_id: 'hospital-a-copy',
    request: '原负责人缺席，请接手世界心脏日义诊活动公众号文案。',
    manager_id: 'hospital-a-lead',
    writer_id: 'hospital-a-writer',
  });
  const boundaryRecall = await gateway.recallForTrigger({
    task_id: taskId,
    tenant_id: 'agency',
    actor_id: 'hospital-a-writer',
    trigger: 'tool_boundary',
    tool_name: 'hospital-copy.render',
  });
  const drafted = await gateway.submitDraft({
    task_id: taskId,
    tenant_id: 'agency',
    actor_id: 'hospital-a-writer',
    reviewer_id: 'hospital-a-reviewer',
    draft: '标题：世界心脏日，医院 A 与您一起关注心脏健康\n正文：医院 A 将开展公益义诊，提供健康咨询。活动时间与地点：待客户确认。',
  });
  gateway.submitReview({
    task_id: taskId,
    tenant_id: 'agency',
    actor_id: 'hospital-a-reviewer',
    decision: 'approved',
    findings: '未使用绝对化疗效表述，未确认信息已明确标记。',
    policy_refs: drafted.required_policy_refs,
  });
  const completed = await gateway.humanDecide({
    task_id: taskId,
    tenant_id: 'agency',
    reviewer: 'hospital-a-owner',
    decision: 'approve',
    reason: '客户负责人确认可发布。',
    experience: {
      content: '医院 A 活动文案中的时间和地点若未确认，必须显式列为待确认项。',
      type: 'episode',
      confidence: 0.96,
      tags: ['hospital-a', 'copywriting', 'handoff'],
    },
  });

  const db = getDatabase();
  const eventCount = (db.prepare('SELECT COUNT(*) AS count FROM agent_events WHERE task_id = ?').get(taskId) as { count: number }).count;
  const outbox = db.prepare(`
    SELECT status, COUNT(*) AS count FROM event_outbox o
    INNER JOIN agent_events e ON e.id = o.event_id WHERE e.task_id = ? GROUP BY status
  `).all(taskId) as { status: string; count: number }[];
  const rawRows = db.prepare("SELECT content FROM memories WHERE scope = 'team' AND space_id = 'hospital-a-copy'").all() as { content: string }[];
  return {
    scenario: '医院 A 原负责人缺席后的多 Agent 文案交接',
    task_id: taskId,
    trace_id: completed.run.trace_id,
    status: completed.run.status,
    artifact_revision: completed.run.artifact_revision,
    memory_refs: [preference.memory_ref, completed.memory_ref].filter(Boolean),
    policy_refs: drafted.required_policy_refs,
    tool_boundary_policy_refs: boundaryRecall.required_policy_refs,
    context_refs: completed.run.context_refs,
    agent_events: eventCount,
    outbox: Object.fromEntries(outbox.map(row => [row.status, row.count])),
    e2ee: {
      scheme: 'space',
      key_version: spaceKeys.currentVersion('hospital-a-copy'),
      plaintext_found_in_database: rawRows.some(row => row.content.includes('医院 A')),
    },
    draft: completed.run.draft,
    review: completed.run.review,
    human_reviewer: completed.run.human_reviewer,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    const result = await runHospitalADemo({ dbPath: getMemoryDbPath() });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    closeDatabase();
  }
}
