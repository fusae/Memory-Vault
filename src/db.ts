import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';

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

  // Migration: add is_encrypted to memory_versions
  const versionColumns = db.pragma('table_info(memory_versions)') as { name: string }[];
  if (!versionColumns.some(c => c.name === 'is_encrypted')) {
    db.exec('ALTER TABLE memory_versions ADD COLUMN is_encrypted INTEGER NOT NULL DEFAULT 0');
  }

  _db = db;
  return db;
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
