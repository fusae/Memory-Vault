import { randomUUID } from 'node:crypto';
import { createDatabase, getDatabase } from './db.js';
import { getEmbedding, OllamaUnavailableError } from './embedding.js';
import type { CryptoService } from './crypto.js';
import type {
  MemoryEntry,
  MemorySearchResult,
  CreateMemoryInput,
  SearchMemoryInput,
  UpdateMemoryInput,
  MemoryVersion,
  WriteMemoryResult,
} from './types.js';

const CONFLICT_DISTANCE_THRESHOLD = 0.3;

export class MemoryStore {
  private crypto?: CryptoService;

  constructor(dbPath: string, crypto?: CryptoService) {
    createDatabase(dbPath);
    this.crypto = crypto;
  }

  private encryptField(value: string): string {
    return this.crypto ? this.crypto.encrypt(value) : value;
  }

  private decryptField(value: string, isEncrypted: boolean | number): string {
    if (!isEncrypted || !this.crypto) return value;
    return this.crypto.decrypt(value);
  }

  private decryptRow<T extends { content: string; tags: string | string[]; source_excerpt?: string | null; is_encrypted?: boolean | number }>(row: T): T {
    const encrypted = !!(row.is_encrypted);
    return {
      ...row,
      content: this.decryptField(row.content, encrypted),
      tags: typeof row.tags === 'string'
        ? JSON.parse(this.decryptField(row.tags, encrypted))
        : row.tags,
      source_excerpt: row.source_excerpt ? this.decryptField(row.source_excerpt, encrypted) : row.source_excerpt,
      is_encrypted: !!row.is_encrypted,
    };
  }

  async write(input: CreateMemoryInput): Promise<WriteMemoryResult> {
    const db = getDatabase();
    const id = randomUUID();
    const now = new Date().toISOString();
    const tagsJson = JSON.stringify(input.tags ?? []);

    // Embedding uses plaintext (before encryption) to enable semantic search
    const embedding = await getEmbedding(input.content);

    // Encrypt sensitive fields for storage
    const isEncrypted = !!this.crypto;
    const storedContent = this.encryptField(input.content);
    const storedTags = this.encryptField(tagsJson);
    const storedExcerpt = input.source_excerpt ? this.encryptField(input.source_excerpt) : null;
    const vecBuffer = Buffer.from(new Float32Array(embedding).buffer);

    // Only run conflict detection if vec_memories has rows
    // (vec0 MATCH query fails on empty table)
    const vecCount = (db.prepare('SELECT COUNT(*) as count FROM vec_memories').get() as { count: number }).count;

    if (vecCount > 0) {
      // Conflict detection: search for similar active/pending_review memories of the same type
      const conflictSql = `
        SELECT m.*, sub.distance
        FROM (
          SELECT rowid, distance FROM vec_memories
          WHERE embedding MATCH ? AND k = 3
        ) sub
        INNER JOIN memories m ON m.rowid = sub.rowid
        WHERE m.status IN ('active', 'pending_review')
          AND m.type = ?
          AND (m.expires_at IS NULL OR m.expires_at > ?)
      `;
      const similar = db.prepare(conflictSql).all(vecBuffer, input.type, now) as (MemoryEntry & { distance: number; tags: string })[];

      const conflict = similar.find(s => s.distance < CONFLICT_DISTANCE_THRESHOLD);

      if (conflict) {
        const newConfidence = input.confidence ?? 0.8;

        // Case 1: Conflicting memory is pending_review — increment confirmation_count
        if (conflict.status === 'pending_review') {
          const newCount = (conflict.confirmation_count ?? 0) + 1;
          const autoPromote = newCount >= 3;

          db.prepare(`
            UPDATE memories SET confirmation_count = ?, status = ?, confidence = ?, updated_at = ? WHERE id = ?
          `).run(
            newCount,
            autoPromote ? 'active' : 'pending_review',
            autoPromote ? 0.8 : conflict.confidence,
            now,
            conflict.id
          );

          return {
            memory: this.get(conflict.id)!,
            conflict_action: autoPromote ? 'updated_existing' : 'created_pending_review',
            conflicting_memory_id: conflict.id,
          };
        }

        // Case 2: Conflicting memory is active, new confidence >= existing — update
        if (newConfidence >= conflict.confidence) {
          const versionId = randomUUID();
          db.prepare(`
            INSERT INTO memory_versions (id, memory_id, content, reason, created_at, is_encrypted)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(versionId, conflict.id, conflict.content, 'conflict: superseded by newer memory', now, conflict.is_encrypted ? 1 : 0);

          db.prepare('UPDATE memories SET content = ?, tags = ?, confidence = ?, is_encrypted = ?, sync_status = CASE WHEN sync_status = \'synced\' THEN \'modified\' ELSE sync_status END, updated_at = ? WHERE id = ?')
            .run(storedContent, storedTags, newConfidence, isEncrypted ? 1 : 0, now, conflict.id);

          // Re-embed the updated memory
          const conflictRow = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(conflict.id) as { rowid: number | bigint };
          db.prepare('DELETE FROM vec_memories WHERE rowid = ?').run(Number(conflictRow.rowid));
          db.prepare('INSERT INTO vec_memories (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)').run(Number(conflictRow.rowid), vecBuffer);

          return {
            memory: this.get(conflict.id)!,
            conflict_action: 'updated_existing',
            conflicting_memory_id: conflict.id,
          };
        }

        // Case 3: Conflicting memory is active, new confidence < existing — create pending_review
        db.prepare(`
          INSERT INTO memories (id, type, content, tags, project, confidence, confirmation_count, source_tool, source_excerpt, source_conversation_id, is_encrypted, status, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'pending_review', ?, ?, ?)
        `).run(id, input.type, storedContent, storedTags, input.project ?? null,
               newConfidence, input.source_tool ?? null,
               storedExcerpt, input.source_conversation_id ?? null,
               isEncrypted ? 1 : 0, input.expires_at ?? null, now, now);

        const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number | bigint };
        db.prepare('INSERT INTO vec_memories (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)').run(Number(row.rowid), vecBuffer);

        return {
          memory: this.get(id)!,
          conflict_action: 'created_pending_review',
          conflicting_memory_id: conflict.id,
        };
      }
    }

    // No conflict: normal insert
    db.prepare(`
      INSERT INTO memories (id, type, content, tags, project, confidence, confirmation_count, source_tool, source_excerpt, source_conversation_id, is_encrypted, status, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(id, input.type, storedContent, storedTags, input.project ?? null,
           input.confidence ?? 0.8, input.source_tool ?? null,
           storedExcerpt, input.source_conversation_id ?? null,
           isEncrypted ? 1 : 0, input.expires_at ?? null, now, now);

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

    // vec0 MATCH query fails on empty table — return early
    const vecCount = (db.prepare('SELECT COUNT(*) as count FROM vec_memories').get() as { count: number }).count;
    if (vecCount === 0) return [];

    let queryEmbedding: number[];
    try {
      queryEmbedding = await getEmbedding(input.query);
    } catch (err: unknown) {
      if (err instanceof OllamaUnavailableError) {
        // Fallback to keyword search when Ollama is not available
        return this.keywordSearch(input);
      }
      throw err;
    }
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
      ...this.decryptRow(row),
      distance: row.distance,
    }));
  }

  private keywordSearch(input: SearchMemoryInput): MemorySearchResult[] {
    const db = getDatabase();
    const limit = input.limit ?? 10;
    const keywords = input.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (keywords.length === 0) return [];

    // Build LIKE conditions for each keyword against content
    const likeClauses = keywords.map(() => 'LOWER(m.content) LIKE ?');
    const likeParams = keywords.map(k => `%${k}%`);

    let sql = `
      SELECT m.* FROM memories m
      WHERE m.status = 'active'
        AND (m.expires_at IS NULL OR m.expires_at > ?)
        AND (${likeClauses.join(' OR ')})
    `;
    const params: unknown[] = [new Date().toISOString(), ...likeParams];

    if (input.type) {
      sql += ' AND m.type = ?';
      params.push(input.type);
    }
    if (input.project) {
      sql += ' AND m.project = ?';
      params.push(input.project);
    }

    sql += ' ORDER BY m.updated_at DESC LIMIT ?';
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as (MemoryEntry & { tags: string })[];

    return rows.map(row => ({
      ...this.decryptRow(row),
      distance: -1, // indicates keyword fallback, not vector distance
    }));
  }

  get(id: string): MemoryEntry | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as (MemoryEntry & { tags: string }) | undefined;
    if (!row) return null;
    return this.decryptRow(row);
  }

  async update(input: UpdateMemoryInput): Promise<MemoryEntry> {
    const db = getDatabase();
    const existing = this.get(input.id);
    if (!existing) throw new Error(`Memory not found: ${input.id}`);

    const now = new Date().toISOString();

    // Save old content to version history if content is changing
    if (input.content !== undefined && input.content !== existing.content) {
      const versionId = randomUUID();
      // Store the old content encrypted (re-read raw from DB to preserve encryption)
      const rawRow = db.prepare('SELECT content, is_encrypted FROM memories WHERE id = ?').get(input.id) as { content: string; is_encrypted: number };
      db.prepare(`
        INSERT INTO memory_versions (id, memory_id, content, reason, created_at, is_encrypted)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(versionId, input.id, rawRow.content, input.reason ?? 'updated', now, rawRow.is_encrypted);
    }

    const isEncrypted = !!this.crypto;
    const updates: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    // Mark as modified for sync
    updates.push("sync_status = CASE WHEN sync_status = 'synced' THEN 'modified' ELSE sync_status END");

    if (input.content !== undefined) {
      updates.push('content = ?');
      params.push(this.encryptField(input.content));
      updates.push('is_encrypted = ?');
      params.push(isEncrypted ? 1 : 0);
    }
    if (input.type !== undefined) {
      updates.push('type = ?');
      params.push(input.type);
    }
    if (input.tags !== undefined) {
      updates.push('tags = ?');
      params.push(this.encryptField(JSON.stringify(input.tags)));
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
    if (input.source_conversation_id !== undefined) {
      updates.push('source_conversation_id = ?');
      params.push(input.source_conversation_id);
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
    const rows = db.prepare(
      'SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY created_at'
    ).all(memoryId) as (MemoryVersion & { is_encrypted?: number })[];
    return rows.map(row => ({
      ...row,
      content: this.decryptField(row.content, row.is_encrypted ?? 0),
    }));
  }

  forget(id: string, reason?: string): void {
    const db = getDatabase();
    const existing = this.get(id);
    if (!existing) throw new Error(`Memory not found: ${id}`);

    const now = new Date().toISOString();
    const versionId = randomUUID();

    // Save current state to version history (raw encrypted content from DB)
    const rawRow = db.prepare('SELECT content, is_encrypted FROM memories WHERE id = ?').get(id) as { content: string; is_encrypted: number };
    db.prepare(`
      INSERT INTO memory_versions (id, memory_id, content, reason, created_at, is_encrypted)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(versionId, id, rawRow.content, reason ?? 'forgotten', now, rawRow.is_encrypted);

    // Archive the memory
    db.prepare("UPDATE memories SET status = 'archived', sync_status = CASE WHEN sync_status = 'synced' THEN 'modified' ELSE sync_status END, updated_at = ? WHERE id = ?").run(now, id);
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
    const row = db.prepare('SELECT rowid, sync_status, remote_id FROM memories WHERE id = ?').get(id) as { rowid: number | bigint; sync_status: string; remote_id: string | null } | undefined;
    if (row) {
      // Always remove the vector
      db.prepare('DELETE FROM vec_memories WHERE rowid = ?').run(Number(row.rowid));

      if (row.remote_id) {
        // Has been synced to cloud — mark as deleted so push() can propagate
        const now = new Date().toISOString();
        db.prepare("UPDATE memories SET sync_status = 'deleted', status = 'archived', updated_at = ? WHERE id = ?").run(now, id);
      } else {
        // Never synced — safe to physically delete
        db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      }
    }
  }

  list(type?: string, project?: string, options?: { includeAll?: boolean; status?: string }): MemoryEntry[] {
    const db = getDatabase();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.includeAll) {
      // No status/expiry filter — return everything
    } else if (options?.status) {
      conditions.push('status = ?');
      params.push(options.status);
    } else {
      conditions.push("status = 'active'");
      conditions.push('(expires_at IS NULL OR expires_at > ?)');
      params.push(new Date().toISOString());
    }

    if (type) { conditions.push('type = ?'); params.push(type); }
    if (project) { conditions.push('project = ?'); params.push(project); }

    let sql = 'SELECT * FROM memories';
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY updated_at DESC';

    const rows = db.prepare(sql).all(...params) as (MemoryEntry & { tags: string })[];
    return rows.map(row => this.decryptRow(row));
  }

  getHealthStats(): {
    total: number;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
    pendingReviewCount: number;
    lowConfidenceCount: number;
    staleEpisodesCount: number;
    oldestMemory: string | null;
    newestMemory: string | null;
  } {
    const db = getDatabase();

    const total = (db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;

    const typeRows = db.prepare('SELECT type, COUNT(*) as count FROM memories GROUP BY type').all() as { type: string; count: number }[];
    const byType: Record<string, number> = {};
    for (const row of typeRows) byType[row.type] = row.count;

    const statusRows = db.prepare('SELECT status, COUNT(*) as count FROM memories GROUP BY status').all() as { status: string; count: number }[];
    const byStatus: Record<string, number> = {};
    for (const row of statusRows) byStatus[row.status] = row.count;

    const pendingReviewCount = (db.prepare("SELECT COUNT(*) as count FROM memories WHERE status = 'pending_review'").get() as { count: number }).count;
    const lowConfidenceCount = (db.prepare("SELECT COUNT(*) as count FROM memories WHERE confidence < 0.5 AND status = 'active'").get() as { count: number }).count;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const staleEpisodesCount = (db.prepare(
      "SELECT COUNT(*) as count FROM memories WHERE type = 'episode' AND status = 'active' AND expires_at IS NULL AND created_at < ?"
    ).get(thirtyDaysAgo) as { count: number }).count;

    const oldest = db.prepare('SELECT created_at FROM memories ORDER BY created_at ASC LIMIT 1').get() as { created_at: string } | undefined;
    const newest = db.prepare('SELECT created_at FROM memories ORDER BY created_at DESC LIMIT 1').get() as { created_at: string } | undefined;

    return {
      total,
      byType,
      byStatus,
      pendingReviewCount,
      lowConfidenceCount,
      staleEpisodesCount,
      oldestMemory: oldest?.created_at ?? null,
      newestMemory: newest?.created_at ?? null,
    };
  }

  autoOrganize(project?: string): { expiredCount: number; archivedCount: number } {
    const db = getDatabase();
    const now = new Date().toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Set expires_at on old episodes without expiry
    let expireSql = "UPDATE memories SET expires_at = ?, updated_at = ? WHERE type = 'episode' AND status = 'active' AND expires_at IS NULL AND created_at < ?";
    const expireParams: unknown[] = [thirtyDaysFromNow, now, thirtyDaysAgo];
    if (project) { expireSql += ' AND project = ?'; expireParams.push(project); }
    const expireResult = db.prepare(expireSql).run(...expireParams);

    // Archive very low confidence unconfirmed memories
    let archiveSql = "UPDATE memories SET status = 'archived', updated_at = ? WHERE confidence < 0.3 AND confirmation_count = 0 AND status IN ('active', 'pending_review')";
    const archiveParams: unknown[] = [now];
    if (project) { archiveSql += ' AND project = ?'; archiveParams.push(project); }
    const archiveResult = db.prepare(archiveSql).run(...archiveParams);

    return {
      expiredCount: expireResult.changes,
      archivedCount: archiveResult.changes,
    };
  }

  getRecentMemories(since: Date): MemoryEntry[] {
    const db = getDatabase();
    const sinceStr = since.toISOString();
    const rows = db.prepare(
      "SELECT * FROM memories WHERE updated_at >= ? AND status IN ('active', 'pending_review') ORDER BY updated_at DESC"
    ).all(sinceStr) as (MemoryEntry & { tags: string })[];
    return rows.map(row => this.decryptRow(row));
  }

  export(): MemoryEntry[] {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM memories ORDER BY created_at').all() as (MemoryEntry & { tags: string })[];
    return rows.map(row => this.decryptRow(row));
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
