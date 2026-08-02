import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_DB = './data/test-codex-sweep.db';
let codexHome: string;
let cwd: string;

function writeRollout(name: string, lines: string[], mtime: Date): string {
  const dir = path.join(codexHome, 'sessions', '2026', '08');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join('\n'), 'utf-8');
  fs.utimesSync(file, mtime, mtime);
  return file;
}

describe('Codex sweep', () => {
  beforeEach(() => {
    process.env.MEMORY_DB_PATH = TEST_DB;
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `memory-vault-codex-${process.pid}-`));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), `memory-vault-cwd-${process.pid}-`));
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/db.js');
    closeDatabase();
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    delete process.env.MEMORY_DB_PATH;
    vi.resetModules();
  });

  it('lists candidate rollout files and project keys in dry-run', async () => {
    const { sweepCodex } = await import('../src/codex-sweep.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = writeRollout('rollout-a.jsonl', [
      JSON.stringify({ type: 'session', cwd }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Use pnpm here.' } }),
    ], new Date('2026-08-02T01:00:00.000Z'));

    await sweepCodex({ codexHome, dryRun: true });

    expect(logSpy).toHaveBeenCalledWith(`${file}\t${path.resolve(cwd)}`);
    logSpy.mockRestore();
  });

  it('advances watermark after launching extraction', async () => {
    const { sweepCodex } = await import('../src/codex-sweep.js');
    const prompts: string[] = [];
    writeRollout('rollout-a.jsonl', [
      'not json',
      JSON.stringify({ type: 'session', metadata: { cwd } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'I prefer TypeScript.' } }),
    ], new Date('2026-08-02T01:00:00.000Z'));
    writeRollout('rollout-b.jsonl', [
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] }),
    ], new Date('2026-08-02T02:00:00.000Z'));

    await sweepCodex({
      codexHome,
      executor: prompt => {
        prompts.push(prompt);
        return true;
      },
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('User: I prefer TypeScript.');
    const { getDatabase } = await import('../src/db.js');
    const row = getDatabase().prepare("SELECT watermark FROM sweep_state WHERE source = 'codex'").get() as { watermark: string };
    expect(row.watermark).toBe(new Date('2026-08-02T02:00:00.000Z').toISOString());
  });

  it('keeps watermark when claude execution is unavailable', async () => {
    const { sweepCodex } = await import('../src/codex-sweep.js');
    writeRollout('rollout-a.jsonl', [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Remember this.' } }),
    ], new Date('2026-08-02T01:00:00.000Z'));

    await sweepCodex({ codexHome, executor: () => false });

    const { getDatabase } = await import('../src/db.js');
    const row = getDatabase().prepare("SELECT watermark FROM sweep_state WHERE source = 'codex'").get();
    expect(row).toBeUndefined();
  });

  it('skips malformed lines and handles sessions without cwd', async () => {
    const { parseCodexRollout, sweepCodex } = await import('../src/codex-sweep.js');
    const file = writeRollout('rollout-a.jsonl', [
      '{bad json',
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'No cwd here.' }] } }),
    ], new Date('2026-08-02T01:00:00.000Z'));

    expect(parseCodexRollout(file)).toEqual({ conversation: 'User: No cwd here.', cwd: undefined });
    await expect(sweepCodex({ codexHome, executor: () => true })).resolves.toBeUndefined();
  });
});
