import { describe, it, expect, afterEach } from 'vitest';
import { createDatabase, closeDatabase } from '../src/db.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const TEST_DB = './data/test-migration.db';

afterEach(() => {
  closeDatabase();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

describe('Database migration', () => {
  it('should create memory_versions table', () => {
    const db = createDatabase(TEST_DB);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_versions'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it('should add expires_at column to memories table', () => {
    const db = createDatabase(TEST_DB);
    const columns = db.pragma('table_info(memories)') as { name: string }[];
    const hasExpiresAt = columns.some(c => c.name === 'expires_at');
    expect(hasExpiresAt).toBe(true);
  });

  it('should handle being called twice without error (idempotent)', () => {
    createDatabase(TEST_DB);
    closeDatabase();
    // Second call should not throw
    const db = createDatabase(TEST_DB);
    const columns = db.pragma('table_info(memories)') as { name: string }[];
    const hasExpiresAt = columns.some(c => c.name === 'expires_at');
    expect(hasExpiresAt).toBe(true);
  });
});
