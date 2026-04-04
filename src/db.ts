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
