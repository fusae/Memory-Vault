export type MemoryType = 'identity' | 'preference' | 'project' | 'episode' | 'rule';
export type MemoryStatus = 'active' | 'archived' | 'pending_review';

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  tags: string[];
  project?: string;
  confidence: number;
  source_tool?: string;
  source_excerpt?: string;
  status: MemoryStatus;
  expires_at?: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryVersion {
  id: string;
  memory_id: string;
  content: string;
  reason: string;
  created_at: string;
}

export interface WriteMemoryResult {
  memory: MemoryEntry;
  conflict_action: 'created' | 'updated_existing' | 'created_pending_review';
  conflicting_memory_id?: string;
}

export interface MemorySearchResult extends MemoryEntry {
  distance: number;
}

export interface CreateMemoryInput {
  content: string;
  type: MemoryType;
  tags?: string[];
  project?: string;
  confidence?: number;
  source_tool?: string;
  source_excerpt?: string;
  expires_at?: string;
}

export interface SearchMemoryInput {
  query: string;
  type?: MemoryType;
  project?: string;
  limit?: number;
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
}
