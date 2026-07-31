import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveProjectKey, normalizeRemote } from '../src/project-key.js';

const tempDirs: string[] = [];
const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
const originalGitConfigSystem = process.env.GIT_CONFIG_SYSTEM;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-vault-project-key-'));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
}

describe('deriveProjectKey', () => {
  beforeEach(() => {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
    if (originalGitConfigSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = originalGitConfigSystem;
  });

  it('normalizes git ssh remotes', () => {
    const dir = makeTempDir();
    git(dir, ['init']);
    git(dir, ['remote', 'add', 'origin', 'git@github.com:fusae/Memory-Vault.git']);

    expect(deriveProjectKey(dir)).toBe('github.com/fusae/memory-vault');
  });

  it('normalizes git https remotes', () => {
    const dir = makeTempDir();
    git(dir, ['init']);
    git(dir, ['remote', 'add', 'origin', 'https://github.com/fusae/Memory-Vault']);

    expect(deriveProjectKey(dir)).toBe('github.com/fusae/memory-vault');
  });

  it('normalizes https remotes without scp-like parsing', () => {
    expect(normalizeRemote('https://github.com/fusae/memory-vault')).toBe('github.com/fusae/memory-vault');
  });

  it('falls back to normalized path when git has no origin remote', () => {
    const dir = makeTempDir();
    git(dir, ['init']);

    expect(deriveProjectKey(`${dir}${path.sep}`)).toBe(path.resolve(dir));
  });

  it('falls back to normalized path outside git repositories', () => {
    const dir = makeTempDir();

    expect(deriveProjectKey(`${dir}${path.sep}`)).toBe(path.resolve(dir));
  });
});
