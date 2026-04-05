import { randomUUID } from 'node:crypto';
import { createDatabase, getDatabase } from './db.js';
import { getEmbedding } from './embedding.js';
import type {
  MemoryEntry,
  MemorySearchResult,
  CreateMemoryInput,
  SearchMemoryInput,
  UpdateMemoryInput,
  MemoryVersion,
  WriteMemoryResult,
} from './types.js';

export class MemoryStore {
  constructor(dbPath: string) {
    createDatabase(dbPath);
  }

  async write(input: CreateMemoryInput): Promise<WriteMemoryResult> {
    const db = getDatabase();
    const id = randomUUID();
    const now = new Date().toISOString();
    const tags = JSON.stringify(input.tags ?? []);

    const embedding = await getEmbedding(input.content);
    const vecBuffer = Buffer.from(new Float32Array(embedding).buffer);

    db.prepare(`
      INSERT INTO memories (id, type, content, tags, project, confidence, source_tool, source_excerpt, status, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(id, input.type, input.content, tags, input.project ?? null,
           input.confidence ?? 0.8, input.source_tool ?? null,
           input.source_excerpt ?? null, input.expires_at ?? null, now, now);

    // vec_memories 的 rowid 需要是整数，用 memories 表的 rowid
    const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number | bigint };
    db.prepare('INSERT INTO vec_memories (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)').run(Number(row.rowid), vecBuffer);

    return {
      memory: this.get(id)!,
      conflict_action: 'created',
    };
  }

  async search(input: SearchMemoryInput): Promise<MemorySearchResult[]> {
    const db = getDatabase();
    const limit = input.limit ?? 10;

    const queryEmbedding = await getEmbedding(input.query);
    const vecBuffer = Buffer.from(new Float32Array(queryEmbedding).buffer);

    // vec0 KNN 查询要求 k = ? 在 WHERE 子句里，不能用外层 LIMIT 替代
    const hasFilters = !!(input.type || input.project);
    const k = hasFilters ? limit * 3 : limit;

    let sql = `
      SELECT m.*, sub.distance
      FROM (
        SELECT rowid, distance FROM vec_memories
        WHERE embedding MATCH ? AND k = ${k}
      ) sub
      INNER JOIN memories m ON m.rowid = sub.rowid
      WHERE m.status = 'active'
        AND (m.expires_at IS NULL OR m.expires_at > ?)
    `;
    const params: unknown[] = [vecBuffer, new Date().toISOString()];

    if (input.type) {
      sql += ' AND m.type = ?';
      params.push(input.type);
    }
    if (input.project) {
      sql += ' AND m.project = ?';
      params.push(input.project);
    }

    sql += ' ORDER BY sub.distance LIMIT ?';
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as (MemoryEntry & { distance: number; tags: string })[];

    return rows.map(row => ({
      ...row,
      tags: JSON.parse(row.tags as string),
      distance: row.distance,
    }));
  }

  get(id: string): MemoryEntry | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as (MemoryEntry & { tags: string }) | undefined;
    if (!row) return null;
    return { ...row, tags: JSON.parse(row.tags as string) };
  }

  async update(input: UpdateMemoryInput): Promise<MemoryEntry> {
    const db = getDatabase();
    const existing = this.get(input.id);
    if (!existing) throw new Error(`Memory not found: ${input.id}`);

    const now = new Date().toISOString();

    // Save old content to version history if content is changing
    if (input.content !== undefined && input.content !== existing.content) {
      const versionId = randomUUID();
      db.prepare(`
        INSERT INTO memory_versions (id, memory_id, content, reason, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(versionId, input.id, existing.content, input.reason ?? 'updated', now);
    }

    const updates: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (input.content !== undefined) {
      updates.push('content = ?');
      params.push(input.content);
    }
    if (input.type !== undefined) {
      updates.push('type = ?');
      params.push(input.type);
    }
    if (input.tags !== undefined) {
      updates.push('tags = ?');
      params.push(JSON.stringify(input.tags));
    }
    if (input.project !== undefined) {
      updates.push('project = ?');
      params.push(input.project);
    }
    if (input.confidence !== undefined) {
      updates.push('confidence = ?');
      params.push(input.confidence);
    }
    if (input.status !== undefined) {
      updates.push('status = ?');
      params.push(input.status);
    }
    if (input.expires_at !== undefined) {
      updates.push('expires_at = ?');
      params.push(input.expires_at);
    }

    params.push(input.id);
    db.prepare(`UPDATE memories SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    // 如果 content 变了，重新生成向量
    if (input.content !== undefined) {
      const embedding = await getEmbedding(input.content);
      const vecBuffer = Buffer.from(new Float32Array(embedding).buffer);
      const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(input.id) as { rowid: number | bigint };
      db.prepare('DELETE FROM vec_memories WHERE rowid = ?').run(Number(row.rowid));
      db.prepare('INSERT INTO vec_memories (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)').run(Number(row.rowid), vecBuffer);
    }

    return this.get(input.id)!;
  }

  getVersions(memoryId: string): MemoryVersion[] {
    const db = getDatabase();
    return db.prepare(
      'SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY created_at'
    ).all(memoryId) as MemoryVersion[];
  }

  forget(id: string, reason?: string): void {
    const db = getDatabase();
    const existing = this.get(id);
    if (!existing) throw new Error(`Memory not found: ${id}`);

    const now = new Date().toISOString();
    const versionId = randomUUID();

    // Save current state to version history
    db.prepare(`
      INSERT INTO memory_versions (id, memory_id, content, reason, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(versionId, id, existing.content, reason ?? 'forgotten', now);

    // Archive the memory
    db.prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?").run(now, id);
  }

  async consolidate(mergeIds: string[], intoContent: string): Promise<MemoryEntry> {
    if (mergeIds.length < 2) throw new Error('Consolidate requires at least 2 memories');

    // Verify all memories exist
    const memories = mergeIds.map(id => {
      const m = this.get(id);
      if (!m) throw new Error(`Memory not found: ${id}`);
      return m;
    });

    // Create the merged memory using the first memory's type
    const result = await this.write({
      content: intoContent,
      type: memories[0].type,
      tags: [...new Set(memories.flatMap(m => m.tags))],
      project: memories[0].project,
    });

    // Archive all original memories
    for (const m of memories) {
      this.forget(m.id, 'consolidated');
    }

    return result.memory;
  }

  delete(id: string): void {
    const db = getDatabase();
    const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number | bigint } | undefined;
    if (row) {
      db.prepare('DELETE FROM vec_memories WHERE rowid = ?').run(Number(row.rowid));
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    }
  }

  list(type?: string, project?: string): MemoryEntry[] {
    const db = getDatabase();
    let sql = "SELECT * FROM memories WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)";
    const params: unknown[] = [new Date().toISOString()];

    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (project) { sql += ' AND project = ?'; params.push(project); }

    sql += ' ORDER BY updated_at DESC';

    const rows = db.prepare(sql).all(...params) as (MemoryEntry & { tags: string })[];
    return rows.map(row => ({ ...row, tags: JSON.parse(row.tags as string) }));
  }

  export(): MemoryEntry[] {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM memories ORDER BY created_at').all() as (MemoryEntry & { tags: string })[];
    return rows.map(row => ({ ...row, tags: JSON.parse(row.tags as string) }));
  }

  exportMarkdown(): string {
    const all = this.export();
    const grouped: Record<string, MemoryEntry[]> = {};
    for (const m of all) {
      const key = m.type.charAt(0).toUpperCase() + m.type.slice(1);
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(m);
    }
    let md = '# MemoryVault Export\n\n';
    md += `> Exported at ${new Date().toISOString()}\n\n`;
    for (const [type, memories] of Object.entries(grouped)) {
      md += `## ${type}\n\n`;
      for (const m of memories) {
        md += `- ${m.content}`;
        if (m.tags.length) md += ` [${m.tags.join(', ')}]`;
        if (m.project) md += ` (project: ${m.project})`;
        md += '\n';
      }
      md += '\n';
    }
    return md;
  }
}
