import { randomUUID } from 'node:crypto';
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createDatabase, getDatabase, recordEvent } from './db.js';
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
  MemoryScope,
  SpaceEntry,
} from './types.js';
import { scheduleAgentsMdRefresh } from './agents-md.js';
import { scheduleTeamMemoryPush } from './space-sync.js';
import { configureSpaceKeyService } from './space-sync.js';
import type { SpaceKeyService } from './space-crypto.js';
import type { EncryptionScheme } from './types.js';

const CONFLICT_DISTANCE_THRESHOLD = 0.3;

function normalizeScope(scope: string | undefined, spaceId: string | undefined): { scope: MemoryScope; space_id: string | null } {
  if (scope === 'team' && spaceId?.trim()) return { scope: 'team', space_id: spaceId.trim() };
  return { scope: 'personal', space_id: null };
}

export class MemoryStore {
  private crypto?: CryptoService;
  private spaceKeys?: SpaceKeyService;
  private dbPath: string;

  constructor(dbPath: string, crypto?: CryptoService, spaceKeys?: SpaceKeyService) {
    createDatabase(dbPath);
    this.crypto = crypto;
    this.spaceKeys = spaceKeys;
    if (spaceKeys) configureSpaceKeyService(spaceKeys);
    this.dbPath = dbPath;
  }

  private getLogPath(): string {
    const logDir = join(dirname(this.dbPath), 'logs');
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    return join(logDir, 'consolidate.log');
  }

  private logConsolidation(mergeIds: string[], memories: MemoryEntry[], intoContent: string, success: boolean, error?: string): void {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      action: 'consolidate',
      success,
      merge_ids: mergeIds,
      memories: memories.map(m => ({
        id: m.id,
        type: m.type,
        content: m.content,
        confidence: m.confidence,
      })),
      merged_content: intoContent,
      error: error || null,
    };

    try {
      const logPath = this.getLogPath();
      appendFileSync(logPath, JSON.stringify(logEntry) + '\n', 'utf-8');
    } catch (err) {
      // Log failure shouldn't break the operation
      console.error('Failed to write consolidation log:', err);
    }
  }

  private encryptionFor(scope: MemoryScope, spaceId: string | null): { scheme: EncryptionScheme; keyVersion: number | null } {
    if (scope === 'team' && spaceId) {
      const space = getDatabase().prepare('SELECT encryption_required, key_version FROM spaces WHERE space_id = ?').get(spaceId) as { encryption_required: number; key_version: number } | undefined;
      if (space?.encryption_required) {
        if (!this.spaceKeys?.hasKey(spaceId, space.key_version)) throw new Error(`Missing space key for ${spaceId}@${space.key_version}`);
        return { scheme: 'space', keyVersion: space.key_version };
      }
    }
    return this.crypto ? { scheme: 'vault', keyVersion: null } : { scheme: 'none', keyVersion: null };
  }

  private encryptField(value: string, scheme: EncryptionScheme, spaceId?: string | null): string {
    if (scheme === 'none') return value;
    if (scheme === 'space') {
      if (!spaceId || !this.spaceKeys) throw new Error('Space encryption key is unavailable');
      return this.spaceKeys.encrypt(spaceId, value).ciphertext;
    }
    if (!this.crypto) throw new Error('Vault encryption key is unavailable');
    return this.crypto.encrypt(value);
  }

  private decryptField(value: string, isEncrypted: boolean | number, scheme?: EncryptionScheme, spaceId?: string | null): string {
    if (!isEncrypted) return value;
    const resolvedScheme = scheme ?? 'vault';
    if (resolvedScheme === 'space') {
      if (!spaceId || !this.spaceKeys) throw new Error(`Missing space key for ${spaceId ?? 'unknown space'}`);
      return this.spaceKeys.decrypt(spaceId, value);
    }
    if (!this.crypto) throw new Error('Encrypted memory store detected. Set MEMORYVAULT_PASSPHRASE before reading memories.');
    return this.crypto.decrypt(value);
  }

  private decryptRow<T extends { id: string; revision?: number; content: string; tags: string | string[]; source_excerpt?: string | null; is_encrypted?: boolean | number; encryption_scheme?: EncryptionScheme; space_id?: string | null }>(row: T): T {
    const encrypted = !!(row.is_encrypted);
    const scheme = row.encryption_scheme ?? (encrypted ? 'vault' : 'none');
    return {
      ...row,
      content: this.decryptField(row.content, encrypted, scheme, row.space_id),
      tags: typeof row.tags === 'string'
        ? JSON.parse(this.decryptField(row.tags, encrypted, scheme, row.space_id))
        : row.tags,
      source_excerpt: row.source_excerpt ? this.decryptField(row.source_excerpt, encrypted, scheme, row.space_id) : row.source_excerpt,
      is_encrypted: !!row.is_encrypted,
      encryption_scheme: scheme,
      memory_ref: `${row.id}@${row.revision ?? 1}`,
    };
  }

  private afterWrite(memory: MemoryEntry, sourceCwd?: string): MemoryEntry {
    recordEvent({
      event_type: 'write',
      project_key: memory.project ?? null,
      source_tool: memory.source_tool ?? null,
      detail: memory.content.slice(0, 160),
    });
    scheduleAgentsMdRefresh(this, memory.project, sourceCwd);
    scheduleTeamMemoryPush(memory);
    return memory;
  }

  async write(input: CreateMemoryInput): Promise<WriteMemoryResult> {
    const db = getDatabase();
    const tenantId = input.tenant_id?.trim() || 'local';
    if (input.source_event_id) {
      const existing = db.prepare('SELECT id FROM memories WHERE source_event_id = ?').get(input.source_event_id) as { id: string } | undefined;
      if (existing) return { memory: this.get(existing.id)!, conflict_action: 'deduplicated' };
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const tagsJson = JSON.stringify(input.tags ?? []);
    const normalizedScope = normalizeScope(input.scope, input.space_id);
    const encryption = this.encryptionFor(normalizedScope.scope, normalizedScope.space_id);
    const confidence = input.confidence ?? 0.8;
    const sensitivity = input.sensitivity ?? 'normal';
    const requiresReview = !!input.review_required || confidence < 0.5 || sensitivity !== 'normal';
    const reviewReason = input.review_reason?.trim()
      || (confidence < 0.5 ? 'low confidence' : sensitivity !== 'normal' ? `${sensitivity} content` : requiresReview ? 'review requested' : null);
    if (sensitivity === 'restricted' && normalizedScope.scope === 'team') {
      throw new Error('restricted memory cannot be published to a team space');
    }

    // Embedding uses plaintext (before encryption) to enable semantic search
    const embedding = await getEmbedding(input.content);

    // Encrypt sensitive fields for storage
    const isEncrypted = encryption.scheme !== 'none';
    const storedContent = this.encryptField(input.content, encryption.scheme, normalizedScope.space_id);
    const storedTags = this.encryptField(tagsJson, encryption.scheme, normalizedScope.space_id);
    const storedExcerpt = input.source_excerpt ? this.encryptField(input.source_excerpt, encryption.scheme, normalizedScope.space_id) : null;
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
          WHERE embedding MATCH ? AND k = 50
        ) sub
        INNER JOIN memories m ON m.rowid = sub.rowid
        WHERE m.status IN ('active', 'pending_review')
          AND m.type = ?
          AND m.tenant_id = ?
          AND m.project IS ?
          AND m.scope = ?
          AND m.space_id IS ?
          AND (m.expires_at IS NULL OR m.expires_at > ?)
      `;
      const similar = db.prepare(conflictSql).all(
        vecBuffer,
        input.type,
        tenantId,
        input.project ?? null,
        normalizedScope.scope,
        normalizedScope.space_id,
        now,
      ) as (MemoryEntry & { distance: number; tags: string })[];

      const conflict = similar
        .filter(s => s.distance < CONFLICT_DISTANCE_THRESHOLD)
        .sort((a, b) => {
          if (a.status !== b.status) return a.status === 'pending_review' ? -1 : 1;
          return a.distance - b.distance;
        })[0];

      if (conflict) {
        const newConfidence = confidence;

        // Case 1: Conflicting memory is pending_review — increment confirmation_count
        if (conflict.status === 'pending_review') {
          const newCount = (conflict.confirmation_count ?? 0) + 1;
          const autoPromote = newCount >= 3 && conflict.sensitivity === 'normal' && !requiresReview;

          db.prepare(`
            UPDATE memories SET confirmation_count = ?, status = ?, confidence = ?, source_event_id = COALESCE(?, source_event_id), revision = revision + 1, updated_at = ? WHERE id = ?
          `).run(
            newCount,
            autoPromote ? 'active' : 'pending_review',
            autoPromote ? 0.8 : conflict.confidence,
            input.source_event_id ?? null,
            now,
            conflict.id
          );

          return {
            memory: this.afterWrite(this.get(conflict.id)!, input.source_cwd),
            conflict_action: autoPromote ? 'updated_existing' : 'created_pending_review',
            conflicting_memory_id: conflict.id,
          };
        }

        // Case 2: Conflicting memory is active, new confidence >= existing — update
        if (!requiresReview && newConfidence >= conflict.confidence) {
          const versionId = randomUUID();
          db.prepare(`
            INSERT INTO memory_versions (id, memory_id, content, reason, created_at, is_encrypted, revision, encryption_scheme, space_id, key_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(versionId, conflict.id, conflict.content, 'conflict: superseded by newer memory', now, conflict.is_encrypted ? 1 : 0, conflict.revision, conflict.encryption_scheme ?? (conflict.is_encrypted ? 'vault' : 'none'), conflict.space_id ?? null, conflict.key_version ?? null);

          db.prepare('UPDATE memories SET content = ?, tags = ?, confidence = ?, is_encrypted = ?, encryption_scheme = ?, key_version = ?, source_event_id = COALESCE(?, source_event_id), revision = revision + 1, sync_status = CASE WHEN sync_status = \'synced\' THEN \'modified\' ELSE sync_status END, updated_at = ? WHERE id = ?')
            .run(storedContent, storedTags, newConfidence, isEncrypted ? 1 : 0, encryption.scheme, encryption.keyVersion, input.source_event_id ?? null, now, conflict.id);

          // Re-embed the updated memory
          const conflictRow = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(conflict.id) as { rowid: number | bigint };
          db.prepare('DELETE FROM vec_memories WHERE rowid = ?').run(Number(conflictRow.rowid));
          db.prepare('INSERT INTO vec_memories (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)').run(Number(conflictRow.rowid), vecBuffer);

          return {
            memory: this.afterWrite(this.get(conflict.id)!, input.source_cwd),
            conflict_action: 'updated_existing',
            conflicting_memory_id: conflict.id,
          };
        }

        // Case 3: Conflicting memory is active, new confidence < existing — create pending_review
        db.prepare(`
          INSERT INTO memories (id, tenant_id, type, content, tags, project, confidence, confirmation_count, source_tool, source_excerpt, source_conversation_id, source_event_id, is_encrypted, encryption_scheme, key_version, status, sensitivity, review_reason, expires_at, scope, space_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?, ?)
        `).run(id, tenantId, input.type, storedContent, storedTags, input.project ?? null,
               newConfidence, input.source_tool ?? null,
               storedExcerpt, input.source_conversation_id ?? null, input.source_event_id ?? null,
               isEncrypted ? 1 : 0, encryption.scheme, encryption.keyVersion, sensitivity, reviewReason, input.expires_at ?? null, normalizedScope.scope, normalizedScope.space_id, now, now);

        const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number | bigint };
        db.prepare('INSERT INTO vec_memories (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)').run(Number(row.rowid), vecBuffer);

        return {
          memory: this.afterWrite(this.get(id)!, input.source_cwd),
          conflict_action: 'created_pending_review',
          conflicting_memory_id: conflict.id,
        };
      }
    }

    // No conflict: normal insert
    db.prepare(`
      INSERT INTO memories (id, tenant_id, type, content, tags, project, confidence, confirmation_count, source_tool, source_excerpt, source_conversation_id, source_event_id, is_encrypted, encryption_scheme, key_version, status, sensitivity, review_reason, expires_at, scope, space_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, tenantId, input.type, storedContent, storedTags, input.project ?? null,
           confidence, input.source_tool ?? null,
           storedExcerpt, input.source_conversation_id ?? null, input.source_event_id ?? null,
           isEncrypted ? 1 : 0, encryption.scheme, encryption.keyVersion, requiresReview ? 'pending_review' : 'active', sensitivity, reviewReason,
           input.expires_at ?? null, normalizedScope.scope, normalizedScope.space_id, now, now);

    const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number | bigint };
    db.prepare('INSERT INTO vec_memories (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)').run(Number(row.rowid), vecBuffer);

    return {
      memory: this.afterWrite(this.get(id)!, input.source_cwd),
      conflict_action: requiresReview ? 'created_pending_review' : 'created',
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
    const hasFilters = !!(input.type || input.project || input.scope || input.space_id || input.tenant_id);
    const k = hasFilters ? limit * 3 : limit;

    let sql = `
      SELECT m.*, sub.distance
      FROM (
        SELECT rowid, distance FROM vec_memories
        WHERE embedding MATCH ? AND k = ${k}
      ) sub
      INNER JOIN memories m ON m.rowid = sub.rowid
      WHERE m.status = 'active'
        AND m.tenant_id = ?
        AND (m.expires_at IS NULL OR m.expires_at > ?)
    `;
    const params: unknown[] = [vecBuffer, input.tenant_id?.trim() || 'local', new Date().toISOString()];

    if (input.type) {
      sql += ' AND m.type = ?';
      params.push(input.type);
    }
    if (input.project) {
      sql += ' AND m.project = ?';
      params.push(input.project);
    }
    if (input.scope) {
      sql += ' AND m.scope = ?';
      params.push(input.scope);
    }
    if (input.space_id) {
      sql += ' AND m.space_id = ?';
      params.push(input.space_id);
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
        AND m.tenant_id = ?
        AND (m.expires_at IS NULL OR m.expires_at > ?)
        AND (${likeClauses.join(' OR ')})
    `;
    const params: unknown[] = [input.tenant_id?.trim() || 'local', new Date().toISOString(), ...likeParams];

    if (input.type) {
      sql += ' AND m.type = ?';
      params.push(input.type);
    }
    if (input.project) {
      sql += ' AND m.project = ?';
      params.push(input.project);
    }
    if (input.scope) {
      sql += ' AND m.scope = ?';
      params.push(input.scope);
    }
    if (input.space_id) {
      sql += ' AND m.space_id = ?';
      params.push(input.space_id);
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
    const encryption = this.encryptionFor(existing.scope, existing.space_id ?? null);
    const rekeySpace = encryption.scheme === 'space' && encryption.keyVersion !== (existing.key_version ?? null);

    // Save old content to version history if content is changing
    if (input.content !== undefined && input.content !== existing.content) {
      const versionId = randomUUID();
      // Store the old content encrypted (re-read raw from DB to preserve encryption)
      const rawRow = db.prepare('SELECT content, is_encrypted, encryption_scheme, space_id, key_version FROM memories WHERE id = ?').get(input.id) as { content: string; is_encrypted: number; encryption_scheme: EncryptionScheme; space_id: string | null; key_version: number | null };
      db.prepare(`
        INSERT INTO memory_versions (id, memory_id, content, reason, created_at, is_encrypted, revision, encryption_scheme, space_id, key_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(versionId, input.id, rawRow.content, input.reason ?? 'updated', now, rawRow.is_encrypted, existing.revision, rawRow.encryption_scheme, rawRow.space_id, rawRow.key_version);
    }

    const isEncrypted = encryption.scheme !== 'none';
    const updates: string[] = ['updated_at = ?', 'revision = revision + 1'];
    const params: unknown[] = [now];

    // Mark as modified for sync
    updates.push("sync_status = CASE WHEN sync_status = 'synced' THEN 'modified' ELSE sync_status END");

    if (input.content !== undefined || rekeySpace) {
      updates.push('content = ?');
      params.push(this.encryptField(input.content ?? existing.content, encryption.scheme, existing.space_id));
      updates.push('is_encrypted = ?');
      params.push(isEncrypted ? 1 : 0);
      updates.push('encryption_scheme = ?');
      params.push(encryption.scheme);
      updates.push('key_version = ?');
      params.push(encryption.keyVersion);
    }
    if (input.type !== undefined) {
      updates.push('type = ?');
      params.push(input.type);
    }
    if (input.tags !== undefined || rekeySpace) {
      updates.push('tags = ?');
      params.push(this.encryptField(JSON.stringify(input.tags ?? existing.tags), encryption.scheme, existing.space_id));
    }
    if (rekeySpace) {
      updates.push('source_excerpt = ?');
      params.push(existing.source_excerpt ? this.encryptField(existing.source_excerpt, encryption.scheme, existing.space_id) : null);
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

    return this.afterWrite(this.get(input.id)!);
  }

  async correct(memoryRef: string, content: string, reason = 'explicit correction'): Promise<MemoryEntry> {
    const match = /^(.+)@(\d+)$/.exec(memoryRef.trim());
    if (!match) throw new Error('memory_ref must use the format <id>@<revision>');
    const memory = this.get(match[1]);
    if (!memory) throw new Error(`Memory not found: ${match[1]}`);
    const expectedRevision = Number(match[2]);
    if (memory.revision !== expectedRevision) {
      throw new Error(`Stale memory_ref: expected ${memory.memory_ref}, received ${memoryRef}`);
    }
    const corrected = await this.update({ id: memory.id, content, reason });
    getDatabase().prepare('UPDATE memories SET correction_count = correction_count + 1 WHERE id = ?').run(memory.id);
    return this.get(corrected.id)!;
  }

  review(id: string, decision: 'approve' | 'reject', reviewer: string, reason?: string): MemoryEntry {
    const existing = this.get(id);
    if (!existing) throw new Error(`Memory not found: ${id}`);
    if (existing.status !== 'pending_review') throw new Error(`Memory is not pending review: ${id}`);
    const db = getDatabase();
    const now = new Date().toISOString();
    const raw = db.prepare('SELECT content, is_encrypted, encryption_scheme, space_id, key_version FROM memories WHERE id = ?').get(id) as { content: string; is_encrypted: number; encryption_scheme: EncryptionScheme; space_id: string | null; key_version: number | null };
    db.prepare(`
      INSERT INTO memory_versions (id, memory_id, content, reason, created_at, is_encrypted, revision, encryption_scheme, space_id, key_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), id, raw.content, `review ${decision}: ${reason ?? ''}`.trim(), now, raw.is_encrypted, existing.revision, raw.encryption_scheme, raw.space_id, raw.key_version);
    db.prepare(`
      UPDATE memories
      SET status = ?, reviewed_by = ?, reviewed_at = ?, review_reason = ?, revision = revision + 1,
          sync_status = CASE WHEN sync_status = 'synced' THEN 'modified' ELSE sync_status END,
          updated_at = ?
      WHERE id = ?
    `).run(decision === 'approve' ? 'active' : 'archived', reviewer.trim() || 'unknown', now, reason ?? null, now, id);
    return this.afterWrite(this.get(id)!);
  }

  markRecalled(memoryRefs: string[]): void {
    const ids = [...new Set(memoryRefs.map(ref => /^(.+)@(\d+)$/.exec(ref)?.[1]).filter((id): id is string => !!id))];
    if (ids.length === 0) return;
    const db = getDatabase();
    const now = new Date().toISOString();
    db.transaction(() => {
      const update = db.prepare('UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?');
      for (const id of ids) update.run(now, id);
    })();
  }

  getVersions(memoryId: string): MemoryVersion[] {
    const db = getDatabase();
    const rows = db.prepare(
      'SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY created_at'
    ).all(memoryId) as (MemoryVersion & { is_encrypted?: number; encryption_scheme?: EncryptionScheme; space_id?: string | null })[];
    return rows.map(row => ({
      ...row,
      content: this.decryptField(row.content, row.is_encrypted ?? 0, row.encryption_scheme, row.space_id),
      memory_ref: `${row.memory_id}@${row.revision ?? 1}`,
    }));
  }

  forget(id: string, reason?: string): void {
    const db = getDatabase();
    const existing = this.get(id);
    if (!existing) throw new Error(`Memory not found: ${id}`);

    const now = new Date().toISOString();
    const versionId = randomUUID();

    // Save current state to version history (raw encrypted content from DB)
    const rawRow = db.prepare('SELECT content, is_encrypted, encryption_scheme, space_id, key_version FROM memories WHERE id = ?').get(id) as { content: string; is_encrypted: number; encryption_scheme: EncryptionScheme; space_id: string | null; key_version: number | null };
    db.prepare(`
      INSERT INTO memory_versions (id, memory_id, content, reason, created_at, is_encrypted, revision, encryption_scheme, space_id, key_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(versionId, id, rawRow.content, reason ?? 'forgotten', now, rawRow.is_encrypted, existing.revision, rawRow.encryption_scheme, rawRow.space_id, rawRow.key_version);

    // Archive the memory
    db.prepare("UPDATE memories SET status = 'archived', revision = revision + 1, sync_status = CASE WHEN sync_status = 'synced' THEN 'modified' ELSE sync_status END, updated_at = ? WHERE id = ?").run(now, id);
    this.afterWrite(this.get(id)!);
  }

  async consolidate(mergeIds: string[], intoContent: string): Promise<MemoryEntry> {
    if (mergeIds.length < 2) throw new Error('Consolidate requires at least 2 memories');

    // Verify all memories exist
    const memories = mergeIds.map(id => {
      const m = this.get(id);
      if (!m) throw new Error(`Memory not found: ${id}`);
      return m;
    });

    // Check confidence threshold - only merge high-confidence memories
    const lowConfidence = memories.filter(m => m.confidence < 0.8);
    if (lowConfidence.length > 0) {
      const error = `Cannot consolidate: ${lowConfidence.length} memory(ies) have confidence < 0.8. ` +
        `Low confidence IDs: ${lowConfidence.map(m => m.id).join(', ')}`;
      this.logConsolidation(mergeIds, memories, intoContent, false, error);
      throw new Error(error);
    }

    try {
      // Create the merged memory using the first memory's type
      const result = await this.write({
        tenant_id: memories[0].tenant_id,
        content: intoContent,
        type: memories[0].type,
        tags: [...new Set(memories.flatMap(m => m.tags))],
        project: memories[0].project,
        scope: memories[0].scope,
        space_id: memories[0].space_id,
      });

      // Archive all original memories
      for (const m of memories) {
        this.forget(m.id, 'consolidated');
      }

      // Log successful consolidation
      this.logConsolidation(mergeIds, memories, intoContent, true);

      return result.memory;
    } catch (err: unknown) {
      const error = err as Error;
      this.logConsolidation(mergeIds, memories, intoContent, false, error.message);
      throw err;
    }
  }

  delete(id: string): void {
    const db = getDatabase();
    const row = db.prepare('SELECT rowid, sync_status, remote_id, scope, space_id FROM memories WHERE id = ?').get(id) as { rowid: number | bigint; sync_status: string; remote_id: string | null; scope: MemoryScope; space_id: string | null } | undefined;
    if (row) {
      // Always remove the vector
      db.prepare('DELETE FROM vec_memories WHERE rowid = ?').run(Number(row.rowid));

      if (row.remote_id || (row.scope === 'team' && row.space_id)) {
        // Has been synced to cloud — mark as deleted so push() can propagate
        const now = new Date().toISOString();
        db.prepare("UPDATE memories SET sync_status = 'deleted', status = 'archived', revision = revision + 1, updated_at = ? WHERE id = ?").run(now, id);
        const memory = this.get(id);
        if (memory) scheduleTeamMemoryPush(memory);
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

  listProjectMemories(project: string, tenantId = 'local'): MemoryEntry[] {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT * FROM memories
      WHERE status = 'active'
        AND (expires_at IS NULL OR expires_at > ?)
        AND project = ?
        AND tenant_id = ?
        AND scope = 'personal'
      ORDER BY updated_at DESC
    `).all(new Date().toISOString(), project, tenantId) as (MemoryEntry & { tags: string })[];
    return rows.map(row => this.decryptRow(row));
  }

  listGlobalPersonalMemories(tenantId = 'local'): MemoryEntry[] {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT * FROM memories
      WHERE status = 'active'
        AND (expires_at IS NULL OR expires_at > ?)
        AND project IS NULL
        AND tenant_id = ?
        AND scope = 'personal'
      ORDER BY updated_at DESC
    `).all(new Date().toISOString(), tenantId) as (MemoryEntry & { tags: string })[];
    return rows.map(row => this.decryptRow(row));
  }

  listJoinedTeamMemories(project?: string, tenantId = 'local', spaceId?: string): MemoryEntry[] {
    const db = getDatabase();
    const params: unknown[] = [new Date().toISOString(), tenantId];
    let sql = `
      SELECT m.* FROM memories m
      INNER JOIN spaces s ON s.space_id = m.space_id
      WHERE m.status = 'active'
        AND (m.expires_at IS NULL OR m.expires_at > ?)
        AND m.tenant_id = ?
        AND m.scope = 'team'
    `;
    if (project) {
      sql += ' AND m.project = ?';
      params.push(project);
    }
    if (spaceId) {
      sql += ' AND m.space_id = ?';
      params.push(spaceId);
    }
    sql += ' ORDER BY m.updated_at DESC';
    const rows = db.prepare(sql).all(...params) as (MemoryEntry & { tags: string })[];
    return rows.map(row => this.decryptRow(row));
  }

  joinSpace(spaceId: string, name?: string, remoteUrl?: string, remoteToken?: string): SpaceEntry {
    const db = getDatabase();
    const now = new Date().toISOString();
    const trimmedSpaceId = spaceId.trim();
    const trimmedName = name?.trim() || trimmedSpaceId;
    const trimmedUrl = remoteUrl?.trim() || null;
    const trimmedToken = remoteToken?.trim() || null;
    db.prepare(`
      INSERT INTO spaces (space_id, name, joined_at, remote_url, remote_token, local_member_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(space_id) DO UPDATE SET
        name = excluded.name,
        remote_url = COALESCE(excluded.remote_url, spaces.remote_url),
        remote_token = COALESCE(excluded.remote_token, spaces.remote_token),
        local_member_id = COALESCE(excluded.local_member_id, spaces.local_member_id)
    `).run(trimmedSpaceId, trimmedName, now, trimmedUrl, trimmedToken, this.spaceKeys?.identity.member_id ?? null);
    return db.prepare('SELECT * FROM spaces WHERE space_id = ?').get(trimmedSpaceId) as SpaceEntry;
  }

  listSpaces(): SpaceEntry[] {
    const db = getDatabase();
    return db.prepare('SELECT * FROM spaces ORDER BY joined_at DESC').all() as SpaceEntry[];
  }

  promoteToTeam(id: string, spaceId: string): MemoryEntry {
    const existing = this.get(id);
    if (!existing) throw new Error(`Memory not found: ${id}`);

    const now = new Date().toISOString();
    const encryption = this.encryptionFor('team', spaceId);
    const raw = getDatabase().prepare('SELECT content, is_encrypted, encryption_scheme, space_id, key_version FROM memories WHERE id = ?').get(id) as { content: string; is_encrypted: number; encryption_scheme: EncryptionScheme; space_id: string | null; key_version: number | null };
    getDatabase().prepare(`
      INSERT INTO memory_versions (id, memory_id, content, reason, created_at, is_encrypted, revision, encryption_scheme, space_id, key_version)
      VALUES (?, ?, ?, 'promoted to team space', ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), id, raw.content, now, raw.is_encrypted, existing.revision, raw.encryption_scheme, raw.space_id, raw.key_version);
    const content = this.encryptField(existing.content, encryption.scheme, spaceId);
    const tags = this.encryptField(JSON.stringify(existing.tags), encryption.scheme, spaceId);
    const sourceExcerpt = existing.source_excerpt ? this.encryptField(existing.source_excerpt, encryption.scheme, spaceId) : null;
    getDatabase().prepare(`
      UPDATE memories
      SET scope = 'team',
          space_id = ?,
          content = ?,
          tags = ?,
          source_excerpt = ?,
          is_encrypted = ?,
          encryption_scheme = ?,
          key_version = ?,
          revision = revision + 1,
          sync_status = CASE WHEN sync_status = 'synced' THEN 'modified' ELSE sync_status END,
          updated_at = ?
      WHERE id = ?
    `).run(spaceId, content, tags, sourceExcerpt, encryption.scheme === 'none' ? 0 : 1, encryption.scheme, encryption.keyVersion, now, id);
    const memory = this.get(id)!;
    scheduleTeamMemoryPush(memory);
    return memory;
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
    const lowConfidenceCount = (db.prepare("SELECT COUNT(*) as count FROM memories WHERE confidence < 0.5 AND status != 'archived'").get() as { count: number }).count;

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

  async findDuplicateClusters(type?: string, similarityThreshold: number = 18.0): Promise<MemoryEntry[][]> {
    const db = getDatabase();
    const vecCount = (db.prepare('SELECT COUNT(*) as count FROM vec_memories').get() as { count: number }).count;
    if (vecCount === 0) return [];

    const memories = this.list(type);
    if (memories.length < 2) return [];

    const clusters: MemoryEntry[][] = [];
    const processed = new Set<string>();

    for (const memory of memories) {
      if (processed.has(memory.id)) continue;

      // Find similar memories using vector search
      const embedding = await getEmbedding(memory.content);
      const vecBuffer = Buffer.from(new Float32Array(embedding).buffer);

      const sql = `
        SELECT m.*, sub.distance
        FROM (
          SELECT rowid, distance FROM vec_memories
          WHERE embedding MATCH ? AND k = 10
        ) sub
        INNER JOIN memories m ON m.rowid = sub.rowid
        WHERE m.status = 'active'
          AND m.id != ?
          AND m.type = ?
      `;
      const similar = db.prepare(sql).all(vecBuffer, memory.id, memory.type) as (MemoryEntry & { distance: number; tags: string })[];

      const duplicates = similar
        .filter(s => s.distance < similarityThreshold)
        .map(s => this.decryptRow(s));

      if (duplicates.length > 0) {
        const cluster = [memory, ...duplicates];
        clusters.push(cluster);
        cluster.forEach(m => processed.add(m.id));
      }
    }

    return clusters;
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
