import { describe, it, expect, afterEach } from 'vitest';
import { createDatabase, closeDatabase } from '../src/db.js';
import fs from 'node:fs';

const TEST_DB = './data/test-db.db';

afterEach(() => {
  closeDatabase();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

describe('createDatabase', () => {
  it('should create database with memories table', () => {
    const db = createDatabase(TEST_DB);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"
    ).get() as { name: string } | undefined;
    expect(tables?.name).toBe('memories');
  });

  it('should create vec_memories virtual table', () => {
    const db = createDatabase(TEST_DB);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_memories'"
    ).get() as { name: string } | undefined;
    expect(tables?.name).toBe('vec_memories');
  });

  it('should load sqlite-vec extension', () => {
    const db = createDatabase(TEST_DB);
    const result = db.prepare('SELECT vec_version() as version').get() as { version: string };
    expect(result.version).toBeTruthy();
  });
});
