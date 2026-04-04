import { MemoryStore } from './memory-store.js';
import type { MemoryType } from './types.js';

const DB_PATH = process.env.MEMORY_DB_PATH ?? './data/memory.db';

let _store: MemoryStore | null = null;
function getStore(): MemoryStore {
  if (!_store) _store = new MemoryStore(DB_PATH);
  return _store;
}

export async function addMemory(content: string, opts: { type: string; tags?: string; project?: string; confidence?: string }) {
  const store = getStore();
  const memory = await store.write({
    content,
    type: opts.type as MemoryType,
    tags: opts.tags ? opts.tags.split(',').map(t => t.trim()) : undefined,
    project: opts.project,
    confidence: opts.confidence ? parseFloat(opts.confidence) : undefined,
    source_tool: 'cli',
  });
  console.log(`✓ Memory created: ${memory.id}`);
  console.log(`  Type: ${memory.type}`);
  console.log(`  Content: ${memory.content}`);
  if (memory.tags.length) console.log(`  Tags: ${memory.tags.join(', ')}`);
}

export async function searchMemories(query: string, opts: { type?: string; project?: string; limit?: string }) {
  const store = getStore();
  const results = await store.search({
    query,
    type: opts.type as MemoryType | undefined,
    project: opts.project,
    limit: opts.limit ? parseInt(opts.limit, 10) : 10,
  });

  if (results.length === 0) {
    console.log('No memories found.');
    return;
  }

  for (const r of results) {
    console.log(`[${r.id}] (${r.type}) ${r.content}`);
    if (r.tags.length) console.log(`  Tags: ${r.tags.join(', ')}`);
    console.log(`  Distance: ${r.distance.toFixed(4)}`);
    console.log('');
  }
}

export function listMemories(opts: { type?: string; project?: string }) {
  const store = getStore();
  const memories = store.list(opts.type, opts.project);

  if (memories.length === 0) {
    console.log('No memories found.');
    return;
  }

  for (const m of memories) {
    console.log(`[${m.id}] (${m.type}) ${m.content}`);
    if (m.tags.length) console.log(`  Tags: ${m.tags.join(', ')}`);
    if (m.project) console.log(`  Project: ${m.project}`);
    console.log(`  Updated: ${m.updated_at}`);
    console.log('');
  }
  console.log(`Total: ${memories.length} memories`);
}

export function getMemory(id: string) {
  const store = getStore();
  const memory = store.get(id);
  if (!memory) {
    console.error(`Memory not found: ${id}`);
    process.exit(1);
  }
  console.log(JSON.stringify(memory, null, 2));
}

export function deleteMemory(id: string) {
  const store = getStore();
  const existing = store.get(id);
  if (!existing) {
    console.error(`Memory not found: ${id}`);
    process.exit(1);
  }
  store.delete(id);
  console.log(`✓ Memory deleted: ${id}`);
}

export function exportMemories(opts: { format?: string }) {
  const store = getStore();
  if (opts.format === 'markdown') {
    console.log(store.exportMarkdown());
  } else {
    const all = store.export();
    console.log(JSON.stringify(all, null, 2));
  }
}
