export type MemoryType = 'identity' | 'preference' | 'project' | 'episode' | 'rule';
export type MemoryStatus = 'active' | 'archived' | 'pending_review';
export type SyncStatus = 'local_only' | 'synced' | 'modified' | 'deleted' | 'pending';
export type MemoryEventType = 'write' | 'recall' | 'sync';
export type MemoryScope = 'personal' | 'team';
export type AgentEventType =
  | 'task_started'
  | 'task_handoff'
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'task_completed'
  | 'task_failed'
  | 'feedback'
  | 'memory_candidate';
export type OutboxStatus = 'pending' | 'processing' | 'retry' | 'completed' | 'dead_letter';
export type PolicyStatus = 'draft' | 'approved' | 'retired';
export type MemorySensitivity = 'normal' | 'sensitive' | 'restricted';
export type EncryptionScheme = 'none' | 'vault' | 'space';
export type WorkflowStatus = 'started' | 'writing' | 'reviewing' | 'awaiting_human_approval' | 'completed' | 'rejected' | 'failed';
export type SpaceAccessRole = 'reader' | 'writer' | 'owner';

export interface MemoryEntry {
  id: string;
  memory_ref: string;
  revision: number;
  tenant_id: string;
  type: MemoryType;
  content: string;
  tags: string[];
  project?: string;
  confidence: number;
  confirmation_count: number;
  recall_count: number;
  correction_count: number;
  sensitivity: MemorySensitivity;
  review_reason?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  source_tool?: string;
  source_excerpt?: string;
  source_conversation_id?: string;
  status: MemoryStatus;
  is_encrypted: boolean;
  encryption_scheme?: EncryptionScheme;
  key_version?: number | null;
  user_id?: string;
  sync_status: SyncStatus;
  scope: MemoryScope;
  space_id?: string;
  remote_id?: string;
  last_synced_at?: string;
  expires_at?: string;
  created_at: string;
  updated_at: string;
  source_event_id?: string;
  last_recalled_at?: string;
}

export interface MemoryVersion {
  id: string;
  memory_id: string;
  memory_ref: string;
  revision: number;
  content: string;
  reason: string;
  created_at: string;
}

export interface WriteMemoryResult {
  memory: MemoryEntry;
  conflict_action: 'created' | 'updated_existing' | 'created_pending_review' | 'deduplicated';
  conflicting_memory_id?: string;
}

export interface MemorySearchResult extends MemoryEntry {
  distance: number;
}

export interface CreateMemoryInput {
  tenant_id?: string;
  content: string;
  type: MemoryType;
  tags?: string[];
  project?: string;
  confidence?: number;
  source_tool?: string;
  source_excerpt?: string;
  source_conversation_id?: string;
  source_cwd?: string;
  expires_at?: string;
  scope?: MemoryScope | string;
  space_id?: string;
  source_event_id?: string;
  sensitivity?: MemorySensitivity;
  review_required?: boolean;
  review_reason?: string;
}

export interface SearchMemoryInput {
  query: string;
  tenant_id?: string;
  type?: MemoryType;
  project?: string;
  limit?: number;
  scope?: MemoryScope;
  space_id?: string;
}

export interface AgentEventInput {
  idempotency_key: string;
  tenant_id?: string;
  event_type: AgentEventType;
  payload: Record<string, unknown>;
  project?: string;
  scope?: MemoryScope;
  space_id?: string;
  task_id?: string;
  trace_id?: string;
  actor_id?: string;
  occurred_at?: string;
  max_attempts?: number;
}

export interface AgentEvent {
  id: string;
  idempotency_key: string;
  tenant_id: string;
  event_type: AgentEventType;
  payload: Record<string, unknown>;
  project?: string | null;
  scope: MemoryScope;
  space_id?: string | null;
  task_id?: string | null;
  trace_id?: string | null;
  actor_id?: string | null;
  redaction_count: number;
  occurred_at: string;
  created_at: string;
}

export interface OutboxEntry {
  id: number;
  event_id: string;
  topic: string;
  status: OutboxStatus;
  attempts: number;
  max_attempts: number;
  available_at: string;
  locked_at?: string | null;
  processed_at?: string | null;
  last_error?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClaimedAgentEvent {
  event: AgentEvent;
  outbox: OutboxEntry;
}

export interface PolicyEntry {
  id: string;
  policy_ref: string;
  tenant_id: string;
  project: string;
  space_id?: string | null;
  title: string;
  content: string;
  tool_boundaries: string[];
  status: PolicyStatus;
  revision: number;
  source?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatePolicyInput {
  tenant_id?: string;
  project: string;
  space_id?: string;
  title: string;
  content: string;
  tool_boundaries?: string[];
  source?: string;
}

export interface WorkflowRun {
  id: string;
  task_id: string;
  trace_id: string;
  tenant_id: string;
  project: string;
  space_id: string;
  status: WorkflowStatus;
  request: string;
  draft?: string | null;
  review?: { decision: 'approved' | 'rejected'; findings: string; policy_refs: string[] } | null;
  context_refs: string[];
  required_policy_refs: string[];
  artifact_revision: number;
  writer_id?: string | null;
  reviewer_id?: string | null;
  human_reviewer?: string | null;
  decision_reason?: string | null;
  decision_hash?: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpdateMemoryInput {
  id: string;
  content?: string;
  type?: MemoryType;
  tags?: string[];
  project?: string;
  confidence?: number;
  status?: MemoryStatus;
  reason?: string;
  expires_at?: string;
  source_conversation_id?: string;
}

export interface SpaceEntry {
  space_id: string;
  name: string;
  joined_at: string;
  remote_url?: string | null;
  remote_token?: string | null;
  last_pulled_at?: string | null;
  pull_cursor?: string | null;
  encryption_required?: boolean | number;
  local_member_id?: string | null;
  key_version?: number;
}

export interface SpaceIdentity {
  member_id: string;
  encryption_public_key: string;
  encryption_private_key: string;
  signing_public_key: string;
  signing_private_key: string;
}

export interface SpaceMember {
  space_id: string;
  member_id: string;
  encryption_public_key: string;
  signing_public_key: string;
  role: 'owner' | 'member';
  status: 'active' | 'revoked';
  created_at: string;
  updated_at: string;
}

export interface SpaceKeyEnvelope {
  space_id: string;
  key_version: number;
  member_id: string;
  sender_id: string;
  ephemeral_public_key: string;
  ciphertext: string;
  signature: string;
  created_at: string;
}

export interface MemoryEvent {
  id: number;
  event_type: MemoryEventType;
  project_key?: string | null;
  source_tool?: string | null;
  detail?: string | null;
  created_at: string;
}
