import type { SupabaseClient } from '@supabase/supabase-js';
import { getDatabase } from './db.js';
import type { MemoryStore } from './memory-store.js';
import type { MemoryEntry } from './types.js';

export interface SyncResult {
  pushed: number;
  pulled: number;
  errors: string[];
}

export interface SyncStatus {
  localOnly: number;
  modified: number;
  synced: number;
  lastSync: string | null;
}

export class SyncService {
  private store: MemoryStore;
  private supabase: SupabaseClient;
  private userId: string;

  constructor(store: MemoryStore, supabase: SupabaseClient, userId: string) {
    this.store = store;
    this.supabase = supabase;
    this.userId = userId;
  }

  getStatus(): SyncStatus {
    const db = getDatabase();
    const localOnly = (db.prepare("SELECT COUNT(*) as count FROM memories WHERE sync_status = 'local_only'").get() as { count: number }).count;
    const modified = (db.prepare("SELECT COUNT(*) as count FROM memories WHERE sync_status = 'modified'").get() as { count: number }).count;
    const synced = (db.prepare("SELECT COUNT(*) as count FROM memories WHERE sync_status = 'synced'").get() as { count: number }).count;
    const lastRow = db.prepare("SELECT MAX(last_synced_at) as last_sync FROM memories WHERE last_synced_at IS NOT NULL").get() as { last_sync: string | null };

    return { localOnly, modified, synced, lastSync: lastRow.last_sync };
  }

  async push(): Promise<SyncResult> {
    const db = getDatabase();
    const now = new Date().toISOString();
    const errors: string[] = [];
    let pushed = 0;

    // Get memories that need pushing
    const toPush = db.prepare(
      "SELECT * FROM memories WHERE sync_status IN ('local_only', 'modified')"
    ).all() as MemoryEntry[];

    for (const m of toPush) {
      try {
        const record = {
          local_id: m.id,
          user_id: this.userId,
          type: m.type,
          content: m.content, // Already encrypted if E2EE is enabled
          tags: typeof m.tags === 'string' ? m.tags : JSON.stringify(m.tags),
          project: m.project,
          confidence: m.confidence,
          confirmation_count: m.confirmation_count,
          source_tool: m.source_tool,
          source_excerpt: m.source_excerpt,
          source_conversation_id: m.source_conversation_id,
          status: m.status,
          is_encrypted: m.is_encrypted,
          expires_at: m.expires_at,
          created_at: m.created_at,
          updated_at: m.updated_at,
        };

        if (m.remote_id) {
          // Update existing remote record
          const { error } = await this.supabase
            .from('memories')
            .update(record)
            .eq('id', m.remote_id);
          if (error) throw error;
        } else {
          // Insert new remote record
          const { data, error } = await this.supabase
            .from('memories')
            .insert(record)
            .select('id')
            .single();
          if (error) throw error;
          // Save remote_id locally
          db.prepare('UPDATE memories SET remote_id = ? WHERE id = ?').run(data.id, m.id);
        }

        db.prepare("UPDATE memories SET sync_status = 'synced', last_synced_at = ? WHERE id = ?").run(now, m.id);
        pushed++;
      } catch (e: unknown) {
        errors.push(`Push ${m.id}: ${(e as Error).message}`);
      }
    }

    // Handle soft-deleted memories
    const toDelete = db.prepare(
      "SELECT * FROM memories WHERE sync_status = 'deleted' AND remote_id IS NOT NULL"
    ).all() as MemoryEntry[];

    for (const m of toDelete) {
      try {
        const { error } = await this.supabase
          .from('memories')
          .delete()
          .eq('id', m.remote_id);
        if (error) throw error;

        db.prepare("UPDATE memories SET sync_status = 'synced', last_synced_at = ? WHERE id = ?").run(now, m.id);
        pushed++;
      } catch (e: unknown) {
        errors.push(`Delete ${m.id}: ${(e as Error).message}`);
      }
    }

    return { pushed, pulled: 0, errors };
  }

  async pull(): Promise<SyncResult> {
    const db = getDatabase();
    const now = new Date().toISOString();
    const errors: string[] = [];
    let pulled = 0;

    // Get last sync time
    const status = this.getStatus();
    const since = status.lastSync ?? '1970-01-01T00:00:00.000Z';

    try {
      const { data, error } = await this.supabase
        .from('memories')
        .select('*')
        .eq('user_id', this.userId)
        .gt('updated_at', since)
        .order('updated_at', { ascending: true });

      if (error) throw error;
      if (!data) return { pushed: 0, pulled: 0, errors };

      for (const remote of data) {
        // Check if we already have this remote record
        const existing = db.prepare('SELECT * FROM memories WHERE remote_id = ?').get(remote.id) as MemoryEntry | undefined;

        if (existing) {
          // Conflict resolution: last-write-wins
          if (remote.updated_at > existing.updated_at) {
            db.prepare(`
              UPDATE memories SET content = ?, tags = ?, type = ?, project = ?, confidence = ?,
                status = ?, is_encrypted = ?, expires_at = ?, updated_at = ?,
                sync_status = 'synced', last_synced_at = ?
              WHERE remote_id = ?
            `).run(
              remote.content, remote.tags, remote.type, remote.project, remote.confidence,
              remote.status, remote.is_encrypted ? 1 : 0, remote.expires_at, remote.updated_at,
              now, remote.id
            );
            pulled++;
          }
        } else {
          // Check if we have it by local_id
          const byLocalId = remote.local_id
            ? db.prepare('SELECT id FROM memories WHERE id = ?').get(remote.local_id) as { id: string } | undefined
            : undefined;

          if (byLocalId) {
            db.prepare("UPDATE memories SET remote_id = ?, sync_status = 'synced', last_synced_at = ? WHERE id = ?")
              .run(remote.id, now, byLocalId.id);
          } else {
            // New memory from cloud — insert locally
            const localId = remote.local_id ?? remote.id;
            db.prepare(`
              INSERT OR IGNORE INTO memories (id, type, content, tags, project, confidence, confirmation_count,
                source_tool, source_excerpt, source_conversation_id, is_encrypted, status,
                sync_status, remote_id, last_synced_at, expires_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?, ?, ?, ?)
            `).run(
              localId, remote.type, remote.content, remote.tags, remote.project,
              remote.confidence, remote.confirmation_count ?? 0,
              remote.source_tool, remote.source_excerpt, remote.source_conversation_id,
              remote.is_encrypted ? 1 : 0, remote.status,
              remote.id, now, remote.expires_at, remote.created_at, remote.updated_at
            );
            pulled++;
          }
        }
      }
    } catch (e: unknown) {
      errors.push(`Pull: ${(e as Error).message}`);
    }

    return { pushed: 0, pulled, errors };
  }

  async sync(): Promise<SyncResult> {
    const pushResult = await this.push();
    const pullResult = await this.pull();

    return {
      pushed: pushResult.pushed,
      pulled: pullResult.pulled,
      errors: [...pushResult.errors, ...pullResult.errors],
    };
  }
}
