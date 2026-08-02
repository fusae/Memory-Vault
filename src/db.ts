import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import type { MemoryEvent, MemoryEventType } from './types.js';

const EMBEDDING_DIMENSIONS = 768; // nomic-embed-text via Ollama

let _db: Database.Database | null = null;

export function createDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  sqliteVec.load(db);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('identity','preference','project','episode','rule')),
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      project TEXT,
      confidence REAL NOT NULL DEFAULT 0.8,
      source_tool TEXT,
      source_excerpt TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','pending_review')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories
    USING vec0(embedding float[${EMBEDDING_DIMENSIONS}])
  `);

  // Migrations: add columns if missing
  const columns = db.pragma('table_info(memories)') as { name: string }[];
  if (!columns.some(c => c.name === 'expires_at')) {
    db.exec('ALTER TABLE memories ADD COLUMN expires_at TEXT');
  }
  if (!columns.some(c => c.name === 'confirmation_count')) {
    db.exec('ALTER TABLE memories ADD COLUMN confirmation_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.some(c => c.name === 'source_conversation_id')) {
    db.exec('ALTER TABLE memories ADD COLUMN source_conversation_id TEXT');
  }
  if (!columns.some(c => c.name === 'is_encrypted')) {
    db.exec('ALTER TABLE memories ADD COLUMN is_encrypted INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.some(c => c.name === 'user_id')) {
    db.exec('ALTER TABLE memories ADD COLUMN user_id TEXT');
  }
  if (!columns.some(c => c.name === 'sync_status')) {
    db.exec("ALTER TABLE memories ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'local_only'");
  }
  if (!columns.some(c => c.name === 'remote_id')) {
    db.exec('ALTER TABLE memories ADD COLUMN remote_id TEXT');
  }
  if (!columns.some(c => c.name === 'last_synced_at')) {
    db.exec('ALTER TABLE memories ADD COLUMN last_synced_at TEXT');
  }
  if (!columns.some(c => c.name === 'scope')) {
    db.exec("ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'personal'");
  }
  if (!columns.some(c => c.name === 'space_id')) {
    db.exec('ALTER TABLE memories ADD COLUMN space_id TEXT');
  }
  if (!columns.some(c => c.name === 'tenant_id')) {
    db.exec("ALTER TABLE memories ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local'");
  }
  if (!columns.some(c => c.name === 'source_event_id')) {
    db.exec('ALTER TABLE memories ADD COLUMN source_event_id TEXT');
  }
  if (!columns.some(c => c.name === 'revision')) {
    db.exec('ALTER TABLE memories ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
  }
  if (!columns.some(c => c.name === 'recall_count')) {
    db.exec('ALTER TABLE memories ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.some(c => c.name === 'correction_count')) {
    db.exec('ALTER TABLE memories ADD COLUMN correction_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.some(c => c.name === 'last_recalled_at')) {
    db.exec('ALTER TABLE memories ADD COLUMN last_recalled_at TEXT');
  }
  if (!columns.some(c => c.name === 'sensitivity')) {
    db.exec("ALTER TABLE memories ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal'");
  }
  if (!columns.some(c => c.name === 'review_reason')) {
    db.exec('ALTER TABLE memories ADD COLUMN review_reason TEXT');
  }
  if (!columns.some(c => c.name === 'reviewed_by')) {
    db.exec('ALTER TABLE memories ADD COLUMN reviewed_by TEXT');
  }
  if (!columns.some(c => c.name === 'reviewed_at')) {
    db.exec('ALTER TABLE memories ADD COLUMN reviewed_at TEXT');
  }
  if (!columns.some(c => c.name === 'encryption_scheme')) {
    db.exec("ALTER TABLE memories ADD COLUMN encryption_scheme TEXT NOT NULL DEFAULT 'none'");
    db.exec("UPDATE memories SET encryption_scheme = 'vault' WHERE is_encrypted = 1");
  }
  if (!columns.some(c => c.name === 'key_version')) {
    db.exec('ALTER TABLE memories ADD COLUMN key_version INTEGER');
  }

  db.exec("UPDATE memories SET scope = 'personal', space_id = NULL WHERE scope NOT IN ('personal','team') OR scope IS NULL OR (scope = 'personal' AND space_id IS NOT NULL)");
  db.exec("UPDATE memories SET tenant_id = 'local' WHERE tenant_id IS NULL OR tenant_id = ''");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_source_event ON memories(source_event_id) WHERE source_event_id IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_boundary ON memories(tenant_id, project, scope, space_id, status)');

  // Create memory_versions table for version history
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_versions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      project_key TEXT PRIMARY KEY,
      agents_md_path TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS spaces (
      space_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      remote_url TEXT,
      remote_token TEXT,
      last_pulled_at TEXT
    )
  `);

  const spaceColumns = db.pragma('table_info(spaces)') as { name: string }[];
  if (!spaceColumns.some(c => c.name === 'remote_url')) {
    db.exec('ALTER TABLE spaces ADD COLUMN remote_url TEXT');
  }
  if (!spaceColumns.some(c => c.name === 'remote_token')) {
    db.exec('ALTER TABLE spaces ADD COLUMN remote_token TEXT');
  }
  if (!spaceColumns.some(c => c.name === 'last_pulled_at')) {
    db.exec('ALTER TABLE spaces ADD COLUMN last_pulled_at TEXT');
  }
  if (!spaceColumns.some(c => c.name === 'pull_cursor')) {
    db.exec('ALTER TABLE spaces ADD COLUMN pull_cursor TEXT');
  }
  if (!spaceColumns.some(c => c.name === 'encryption_required')) {
    db.exec('ALTER TABLE spaces ADD COLUMN encryption_required INTEGER NOT NULL DEFAULT 0');
  }
  if (!spaceColumns.some(c => c.name === 'local_member_id')) {
    db.exec('ALTER TABLE spaces ADD COLUMN local_member_id TEXT');
  }
  if (!spaceColumns.some(c => c.name === 'key_version')) {
    db.exec('ALTER TABLE spaces ADD COLUMN key_version INTEGER NOT NULL DEFAULT 0');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS space_members (
      space_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      encryption_public_key TEXT NOT NULL,
      signing_public_key TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','member')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(space_id, member_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS space_key_envelopes (
      space_id TEXT NOT NULL,
      key_version INTEGER NOT NULL,
      member_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      ephemeral_public_key TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(space_id, key_version, member_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS space_access_tokens (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('reader','writer','owner')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
      created_at TEXT NOT NULL,
      revoked_at TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_space_access ON space_access_tokens(space_id, member_id, status)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL CHECK(event_type IN ('write','recall','sync')),
      project_key TEXT,
      source_tool TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      event_type TEXT NOT NULL CHECK(event_type IN (
        'task_started','task_handoff','message','tool_call','tool_result',
        'task_completed','task_failed','feedback','memory_candidate'
      )),
      payload TEXT NOT NULL,
      project TEXT,
      scope TEXT NOT NULL DEFAULT 'personal' CHECK(scope IN ('personal','team')),
      space_id TEXT,
      task_id TEXT,
      trace_id TEXT,
      actor_id TEXT,
      redaction_count INTEGER NOT NULL DEFAULT 0,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK((scope = 'personal' AND space_id IS NULL) OR (scope = 'team' AND space_id IS NOT NULL))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS event_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE REFERENCES agent_events(id) ON DELETE CASCADE,
      topic TEXT NOT NULL DEFAULT 'memory.extract',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','retry','completed','dead_letter')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      available_at TEXT NOT NULL,
      locked_at TEXT,
      processed_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_event_outbox_due ON event_outbox(status, available_at, id)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      project TEXT NOT NULL,
      space_id TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_boundaries TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','retired')),
      revision INTEGER NOT NULL DEFAULT 1,
      source TEXT,
      approved_by TEXT,
      approved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const policyColumns = db.pragma('table_info(policies)') as { name: string }[];
  if (!policyColumns.some(c => c.name === 'tool_boundaries')) {
    db.exec("ALTER TABLE policies ADD COLUMN tool_boundaries TEXT NOT NULL DEFAULT '[]'");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_policies_boundary ON policies(tenant_id, project, space_id, status)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_versions (
      id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      tool_boundaries TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);
  const policyVersionColumns = db.pragma('table_info(policy_versions)') as { name: string }[];
  if (!policyVersionColumns.some(c => c.name === 'tool_boundaries')) {
    db.exec("ALTER TABLE policy_versions ADD COLUMN tool_boundaries TEXT NOT NULL DEFAULT '[]'");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      project TEXT NOT NULL,
      space_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'started','writing','reviewing','awaiting_human_approval','completed','rejected','failed'
      )),
      request TEXT NOT NULL,
      draft TEXT,
      review_json TEXT,
      context_refs TEXT NOT NULL DEFAULT '[]',
      required_policy_refs TEXT NOT NULL DEFAULT '[]',
      artifact_revision INTEGER NOT NULL DEFAULT 0,
      writer_id TEXT,
      reviewer_id TEXT,
      human_reviewer TEXT,
      decision_reason TEXT,
      decision_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(tenant_id, task_id)
    )
  `);
  const workflowColumns = db.pragma('table_info(workflow_runs)') as { name: string }[];
  if (!workflowColumns.some(column => column.name === 'decision_hash')) {
    db.exec('ALTER TABLE workflow_runs ADD COLUMN decision_hash TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(tenant_id, project, space_id, status, updated_at)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_artifacts (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      content TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(workflow_id, revision)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sweep_state (
      source TEXT PRIMARY KEY,
      watermark TEXT NOT NULL
    )
  `);

  // Migration: add is_encrypted to memory_versions
  const versionColumns = db.pragma('table_info(memory_versions)') as { name: string }[];
  if (!versionColumns.some(c => c.name === 'is_encrypted')) {
    db.exec('ALTER TABLE memory_versions ADD COLUMN is_encrypted INTEGER NOT NULL DEFAULT 0');
  }
  if (!versionColumns.some(c => c.name === 'revision')) {
    db.exec('ALTER TABLE memory_versions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
  }
  if (!versionColumns.some(c => c.name === 'encryption_scheme')) {
    db.exec("ALTER TABLE memory_versions ADD COLUMN encryption_scheme TEXT NOT NULL DEFAULT 'none'");
    db.exec("UPDATE memory_versions SET encryption_scheme = 'vault' WHERE is_encrypted = 1");
  }
  if (!versionColumns.some(c => c.name === 'space_id')) {
    db.exec('ALTER TABLE memory_versions ADD COLUMN space_id TEXT');
  }
  if (!versionColumns.some(c => c.name === 'key_version')) {
    db.exec('ALTER TABLE memory_versions ADD COLUMN key_version INTEGER');
  }

  _db = db;
  return db;
}

export function getSweepWatermark(source: string): string | null {
  const row = getDatabase().prepare('SELECT watermark FROM sweep_state WHERE source = ?').get(source) as { watermark: string } | undefined;
  return row?.watermark ?? null;
}

export function setSweepWatermark(source: string, watermark: string): void {
  getDatabase().prepare(`
    INSERT INTO sweep_state (source, watermark)
    VALUES (?, ?)
    ON CONFLICT(source) DO UPDATE SET watermark = excluded.watermark
  `).run(source, watermark);
}

export function recordEvent(input: {
  event_type: MemoryEventType;
  project_key?: string | null;
  source_tool?: string | null;
  detail?: string | null;
}): void {
  try {
    getDatabase().prepare(`
      INSERT INTO events (event_type, project_key, source_tool, detail, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      input.event_type,
      input.project_key ?? null,
      input.source_tool ?? null,
      input.detail ?? null,
      new Date().toISOString()
    );
  } catch { /* silent instrumentation */ }
}

export function listEvents(limit = 50): MemoryEvent[] {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : 50;
  return getDatabase().prepare(`
    SELECT * FROM events ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(safeLimit) as MemoryEvent[];
}

export function getDatabase(): Database.Database {
  if (!_db) throw new Error('Database not initialized. Call createDatabase() first.');
  return _db;
}

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
