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
  created_at: string;
  updated_at: string;
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
}
