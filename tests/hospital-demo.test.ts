import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase } from '../src/db.js';
import { runHospitalADemo } from '../src/hospital-demo.js';
import { SpaceKeyService } from '../src/space-crypto.js';

vi.mock('../src/embedding.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
}));

const TEST_DB = './data/test-hospital-demo.db';

describe('Hospital A deterministic E2E demo', () => {
  afterEach(() => {
    closeDatabase();
    for (const suffix of ['', '-shm', '-wal']) {
      if (fs.existsSync(`${TEST_DB}${suffix}`)) fs.unlinkSync(`${TEST_DB}${suffix}`);
    }
  });

  it('completes handoff, review, human approval, writeback, audit, and E2EE proof', async () => {
    const result = await runHospitalADemo({
      dbPath: TEST_DB,
      taskId: 'hospital-a-e2e',
      identity: SpaceKeyService.generateIdentity('demo-owner'),
    });

    expect(result).toMatchObject({
      task_id: 'hospital-a-e2e',
      status: 'completed',
      artifact_revision: 1,
      human_reviewer: 'hospital-a-owner',
      e2ee: { scheme: 'space', key_version: 1, plaintext_found_in_database: false },
      outbox: { completed: 12 },
    });
    expect(result.memory_refs).toHaveLength(2);
    expect(result.policy_refs).toHaveLength(1);
    expect(result.agent_events).toBe(12);
    expect(result.tool_boundary_policy_refs).toEqual(result.policy_refs);
  });

  it('expands a tilde database path instead of creating a literal project tilde directory', async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = path.resolve('./data');
    const literalTildeDir = path.resolve('./~');
    try {
      await runHospitalADemo({
        dbPath: '~/.memoryvault/test-hospital-demo.db',
        taskId: 'hospital-a-expanded-path',
        identity: SpaceKeyService.generateIdentity('demo-owner'),
      });
      expect(fs.existsSync(path.join(process.env.HOME, '.memoryvault/test-hospital-demo.db'))).toBe(true);
      expect(fs.existsSync(literalTildeDir)).toBe(false);
    } finally {
      closeDatabase();
      fs.rmSync(path.join(process.env.HOME, '.memoryvault'), { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});
