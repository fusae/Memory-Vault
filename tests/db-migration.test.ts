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

  it('should create events table', () => {
    const db = createDatabase(TEST_DB);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it('should create reliable agent event and outbox tables', () => {
    const db = createDatabase(TEST_DB);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_events','event_outbox') ORDER BY name"
    ).all() as { name: string }[];
    expect(tables.map(row => row.name)).toEqual(['agent_events', 'event_outbox']);
  });

  it('should create policy and policy version tables', () => {
    const db = createDatabase(TEST_DB);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('policies','policy_versions') ORDER BY name"
    ).all() as { name: string }[];
    expect(tables.map(row => row.name)).toEqual(['policies', 'policy_versions']);
    const policyColumns = db.pragma('table_info(policies)') as { name: string }[];
    const versionColumns = db.pragma('table_info(policy_versions)') as { name: string }[];
    expect(policyColumns.some(column => column.name === 'tool_boundaries')).toBe(true);
    expect(versionColumns.some(column => column.name === 'tool_boundaries')).toBe(true);
  });

  it('should add tenant and source event boundaries to memories', () => {
    const db = createDatabase(TEST_DB);
    const columns = db.pragma('table_info(memories)') as { name: string }[];
    expect(columns.some(c => c.name === 'tenant_id')).toBe(true);
    expect(columns.some(c => c.name === 'source_event_id')).toBe(true);
    expect(columns.some(c => c.name === 'revision')).toBe(true);
    expect(columns.some(c => c.name === 'sensitivity')).toBe(true);
    expect(columns.some(c => c.name === 'review_reason')).toBe(true);
  });

  it('should create sweep_state table', () => {
    const db = createDatabase(TEST_DB);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sweep_state'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it('should add scope columns with personal defaults', () => {
    const db = createDatabase(TEST_DB);
    const columns = db.pragma('table_info(memories)') as { name: string }[];
    expect(columns.some(c => c.name === 'scope')).toBe(true);
    expect(columns.some(c => c.name === 'space_id')).toBe(true);

    db.prepare(`
      INSERT INTO memories (id, type, content, tags, created_at, updated_at)
      VALUES ('m1', 'preference', 'old memory', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run();
    const row = db.prepare('SELECT scope, space_id FROM memories WHERE id = ?').get('m1') as { scope: string; space_id: string | null };
    expect(row.scope).toBe('personal');
    expect(row.space_id).toBeNull();
  });

  it('should create spaces table', () => {
    const db = createDatabase(TEST_DB);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='spaces'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it('should add remote sync columns to spaces table', () => {
    const db = createDatabase(TEST_DB);
    const columns = db.pragma('table_info(spaces)') as { name: string }[];
    expect(columns.some(c => c.name === 'remote_url')).toBe(true);
    expect(columns.some(c => c.name === 'remote_token')).toBe(true);
    expect(columns.some(c => c.name === 'last_pulled_at')).toBe(true);
    expect(columns.some(c => c.name === 'pull_cursor')).toBe(true);
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
