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

  db.exec("UPDATE memories SET scope = 'personal', space_id = NULL WHERE scope NOT IN ('personal','team') OR scope IS NULL OR (scope = 'personal' AND space_id IS NOT NULL)");

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
