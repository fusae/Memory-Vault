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

export function formatRecallContext(memories: MemoryEntry[], budget: number): string {
  if (memories.length === 0) return '';

  const maxChars = Math.max(0, budget * 4);
  const lines = [
    '## 项目记忆(来自 memory-vault,本项目历史会话沉淀)',
    ...memories.map(m => `- [来源:${m.source_tool ?? 'unknown'} ${m.created_at.slice(0, 10)}] ${m.content}`),
  ];
  const output = lines.join('\n');
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

function fallbackRecall(store: MemoryStore, project: string, limit: number): MemoryEntry[] {
  return store.list(undefined, project).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}

export async function buildRecallContext(
  store: MemoryStore,
  opts: { project: string; format?: string; limit?: string; budget?: string; query?: string; sourceTool?: string }
): Promise<string> {
  const startedAt = Date.now();
  const limit = parsePositiveInt(opts.limit, 10);
  const budget = parsePositiveInt(opts.budget, 500);
  const query = opts.query?.trim();

  let memories: MemoryEntry[];
  try {
    if (query) {
      const remainingMs = Math.max(1, 2000 - (Date.now() - startedAt));
      const results = await withTimeout(store.search({ query, project: opts.project, limit: Math.max(limit * 4, limit) }), remainingMs);
      if (results.some(r => r.distance < 0)) throw new Error('embedding unavailable');
      memories = sortBySemanticWithDecay(results).slice(0, limit);
    } else {
      memories = sortByImportanceWithDecay(store.list(undefined, opts.project)).slice(0, limit);
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
    detail: query ? `query: ${query}` : `memories: ${memories.length}`,
  });
  return output;
}
