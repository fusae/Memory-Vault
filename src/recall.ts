import type { MemoryStore } from './memory-store.js';
import type { MemoryEntry, MemorySearchResult } from './types.js';
import { recordEvent } from './db.js';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ageDecay(createdAt: string, now = Date.now()): number {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return 1;
  const ageDays = Math.max(0, (now - created) / (24 * 60 * 60 * 1000));
  return Math.pow(0.5, ageDays / 7);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('recall timeout')), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

type RecallLayer = 'team' | 'project' | 'personal';

function formatMemoryLine(memory: MemoryEntry, layer: RecallLayer): string {
  const source = `${memory.source_tool ?? 'unknown'} ${memory.created_at.slice(0, 10)}`;
  if (layer === 'team') return `- [团队记忆|来源:${source}] ${memory.content}`;
  return `- [来源:${source}] ${memory.content}`;
}

function takeLines(memories: MemoryEntry[], layer: RecallLayer, budgetChars: number): { lines: string[]; unused: number; remaining: MemoryEntry[] } {
  const lines: string[] = [];
  const remaining: MemoryEntry[] = [];
  let used = 0;

  for (const memory of memories) {
    const line = formatMemoryLine(memory, layer);
    const nextUsed = used + line.length + (lines.length > 0 ? 1 : 0);
    if (nextUsed <= budgetChars) {
      lines.push(line);
      used = nextUsed;
    } else {
      remaining.push(memory);
    }
  }

  return { lines, unused: Math.max(0, budgetChars - used), remaining };
}

export function formatRecallContext(layers: { team: MemoryEntry[]; project: MemoryEntry[]; personal: MemoryEntry[] }, budget: number): string {
  if (layers.team.length === 0 && layers.project.length === 0 && layers.personal.length === 0) return '';

  const maxChars = Math.max(0, budget * 4);
  const header = '## 项目记忆(来自 memory-vault,本项目历史会话沉淀)';
  const contentBudget = Math.max(0, maxChars - header.length - 1);
  const allocations: Record<RecallLayer, number> = {
    team: Math.floor(contentBudget * 0.4),
    project: Math.floor(contentBudget * 0.4),
    personal: contentBudget - Math.floor(contentBudget * 0.4) * 2,
  };

  const selected: string[] = [];
  const remainder: Record<RecallLayer, MemoryEntry[]> = { team: [], project: [], personal: [] };
  let carry = 0;
  for (const layer of ['team', 'project', 'personal'] as RecallLayer[]) {
    const taken = takeLines(layers[layer], layer, allocations[layer] + carry);
    selected.push(...taken.lines);
    remainder[layer] = taken.remaining;
    carry = taken.unused;
  }

  for (const layer of ['project', 'team', 'personal'] as RecallLayer[]) {
    if (carry <= 0) break;
    const taken = takeLines(remainder[layer], layer, carry);
    selected.push(...taken.lines);
    carry = taken.unused;
  }

  const output = [header, ...selected].join('\n');
  return output.length > maxChars ? output.slice(0, maxChars) : output;
}

function sortByImportanceWithDecay(memories: MemoryEntry[]): MemoryEntry[] {
  return [...memories].sort((a, b) => {
    const scoreA = a.confidence * ageDecay(a.created_at);
    const scoreB = b.confidence * ageDecay(b.created_at);
    return scoreB - scoreA || b.created_at.localeCompare(a.created_at);
  });
}

function sortBySemanticWithDecay(memories: MemorySearchResult[]): MemorySearchResult[] {
  return [...memories].sort((a, b) => {
    const similarityA = 1 / (1 + Math.max(0, a.distance));
    const similarityB = 1 / (1 + Math.max(0, b.distance));
    const scoreA = similarityA * ageDecay(a.created_at);
    const scoreB = similarityB * ageDecay(b.created_at);
    return scoreB - scoreA || b.created_at.localeCompare(a.created_at);
  });
}

function fallbackRecall(store: MemoryStore, project: string, limit: number): { team: MemoryEntry[]; project: MemoryEntry[]; personal: MemoryEntry[] } {
  return {
    team: store.listJoinedTeamMemories().sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit),
    project: store.listProjectMemories(project).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit),
    personal: store.listGlobalPersonalMemories().sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit),
  };
}

export async function buildRecallContext(
  store: MemoryStore,
  opts: { project: string; format?: string; limit?: string; budget?: string; query?: string; sourceTool?: string }
): Promise<string> {
  const startedAt = Date.now();
  const limit = parsePositiveInt(opts.limit, 10);
  const budget = parsePositiveInt(opts.budget, 500);
  const query = opts.query?.trim();

  let memories: { team: MemoryEntry[]; project: MemoryEntry[]; personal: MemoryEntry[] };
  try {
    if (query) {
      const remainingMs = Math.max(1, 2000 - (Date.now() - startedAt));
      const results = await withTimeout(store.search({ query, limit: Math.max(limit * 8, limit) }), remainingMs);
      if (results.some(r => r.distance < 0)) throw new Error('embedding unavailable');
      const sorted = sortBySemanticWithDecay(results);
      const joinedTeamIds = new Set(store.listJoinedTeamMemories().map(m => m.id));
      memories = {
        team: sorted.filter(m => joinedTeamIds.has(m.id)).slice(0, limit),
        project: sorted.filter(m => m.scope === 'personal' && m.project === opts.project).slice(0, limit),
        personal: sorted.filter(m => m.scope === 'personal' && !m.project).slice(0, limit),
      };
    } else {
      memories = {
        team: sortByImportanceWithDecay(store.listJoinedTeamMemories()).slice(0, limit),
        project: sortByImportanceWithDecay(store.listProjectMemories(opts.project)).slice(0, limit),
        personal: sortByImportanceWithDecay(store.listGlobalPersonalMemories()).slice(0, limit),
      };
    }
  } catch {
    memories = fallbackRecall(store, opts.project, limit);
  }

  const output = opts.format === undefined || opts.format === 'context'
    ? formatRecallContext(memories, budget)
    : '';
  recordEvent({
    event_type: 'recall',
    project_key: opts.project,
    source_tool: opts.sourceTool ?? 'memory-vault',
    detail: query ? `query: ${query}` : `memories: ${memories.team.length + memories.project.length + memories.personal.length}`,
  });
  return output;
}
