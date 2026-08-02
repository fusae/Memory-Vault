import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashBearerToken, loadPrincipalCredentials, resolvePrincipal } from '../src/mcp-principal.js';
import { addHttpPrincipal } from '../src/cli-commands.js';

const PRINCIPAL_FILE = './data/test-mcp-principals.json';

afterEach(() => {
  if (fs.existsSync(PRINCIPAL_FILE)) fs.unlinkSync(PRINCIPAL_FILE);
});

describe('MCP Principal credentials', () => {
  it('loads a protected hash-only credential file and resolves bearer identity', () => {
    fs.mkdirSync('./data', { recursive: true });
    fs.writeFileSync(PRINCIPAL_FILE, JSON.stringify({
      principals: [{
        token_sha256: hashBearerToken('manager-secret'),
        id: 'hospital-a-lead',
        role: 'manager',
        tenant_id: 'agency',
        projects: ['hospital-a'],
        spaces: ['hospital-a-copy'],
      }],
    }));
    fs.chmodSync(PRINCIPAL_FILE, 0o600);

    const credentials = loadPrincipalCredentials(PRINCIPAL_FILE);
    expect(resolvePrincipal('Bearer manager-secret', credentials)).toEqual({
      id: 'hospital-a-lead',
      role: 'manager',
      tenant_id: 'agency',
      projects: ['hospital-a'],
      spaces: ['hospital-a-copy'],
    });
    expect(resolvePrincipal('Bearer wrong-secret', credentials)).toBeNull();
    expect(fs.readFileSync(PRINCIPAL_FILE, 'utf8')).not.toContain('manager-secret');
  });

  it.runIf(process.platform !== 'win32')('rejects a credential file readable by other users', () => {
    fs.mkdirSync('./data', { recursive: true });
    fs.writeFileSync(PRINCIPAL_FILE, JSON.stringify({ principals: [] }));
    fs.chmodSync(PRINCIPAL_FILE, 0o644);
    expect(() => loadPrincipalCredentials(PRINCIPAL_FILE)).toThrow('must not be accessible');
  });

  it('creates an atomic hash-only Principal file and rejects duplicate identities', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const created = addHttpPrincipal({
      file: PRINCIPAL_FILE,
      id: 'hospital-a-writer',
      role: 'writer',
      tenant: 'agency',
      projects: 'hospital-a,hospital-a',
      spaces: 'hospital-a-copy',
    });

    expect(created.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(fs.readFileSync(PRINCIPAL_FILE, 'utf8')).not.toContain(created.token!);
    expect(resolvePrincipal(`Bearer ${created.token}`, loadPrincipalCredentials(PRINCIPAL_FILE))).toMatchObject({
      id: 'hospital-a-writer',
      role: 'writer',
      projects: ['hospital-a'],
    });
    if (process.platform !== 'win32') {
      expect(fs.statSync(PRINCIPAL_FILE).mode & 0o777).toBe(0o600);
    }
    expect(() => addHttpPrincipal({
      file: PRINCIPAL_FILE,
      id: 'hospital-a-writer',
      role: 'writer',
      tenant: 'agency',
      projects: 'hospital-a',
      spaces: 'hospital-a-copy',
    })).toThrow('Principal already exists');
    logSpy.mockRestore();
  });

  it('hashes an existing AgentTeams token from an environment variable', () => {
    process.env.TEST_AGENTTEAMS_GATEWAY_KEY = 'agentteams-consumer-secret';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const created = addHttpPrincipal({
      file: PRINCIPAL_FILE,
      id: 'hospital-a-reviewer',
      role: 'reviewer',
      tenant: 'agency',
      projects: 'hospital-a',
      spaces: 'hospital-a-copy',
      tokenEnv: 'TEST_AGENTTEAMS_GATEWAY_KEY',
    });

    expect(created.token).toBeUndefined();
    expect(resolvePrincipal('Bearer agentteams-consumer-secret', loadPrincipalCredentials(PRINCIPAL_FILE))).toMatchObject({
      id: 'hospital-a-reviewer',
      role: 'reviewer',
    });
    expect(logSpy.mock.calls.flat().join('\n')).not.toContain('agentteams-consumer-secret');
    delete process.env.TEST_AGENTTEAMS_GATEWAY_KEY;
    logSpy.mockRestore();
  });
});
