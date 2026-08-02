import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';

export type McpPrincipalRole = 'admin' | 'manager' | 'writer' | 'reviewer' | 'human' | 'observer';

export interface McpPrincipal {
  id: string;
  role: McpPrincipalRole;
  tenant_id: string;
  projects: string[];
  spaces: string[];
}

export interface McpPrincipalCredential extends McpPrincipal {
  token_sha256: string;
}

export function hashBearerToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  return [...new Set(value.map(item => (item as string).trim()))];
}

function parseCredential(value: unknown): McpPrincipalCredential {
  if (!value || typeof value !== 'object') throw new Error('principal must be an object');
  const row = value as Record<string, unknown>;
  const roles: McpPrincipalRole[] = ['admin', 'manager', 'writer', 'reviewer', 'human', 'observer'];
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const tenantId = typeof row.tenant_id === 'string' ? row.tenant_id.trim() : '';
  const role = row.role as McpPrincipalRole;
  const tokenHash = typeof row.token_sha256 === 'string' ? row.token_sha256.trim().toLowerCase() : '';
  if (!id || !tenantId || !roles.includes(role)) throw new Error('principal id, role, and tenant_id are required');
  if (!/^[a-f0-9]{64}$/.test(tokenHash)) throw new Error(`principal ${id} has an invalid token_sha256`);
  return {
    id,
    role,
    tenant_id: tenantId,
    projects: stringArray(row.projects, `principal ${id} projects`),
    spaces: stringArray(row.spaces, `principal ${id} spaces`),
    token_sha256: tokenHash,
  };
}

export function loadPrincipalCredentials(filePath: string): McpPrincipalCredential[] {
  const stat = fs.statSync(filePath);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`Principal file must not be accessible by group or others: ${filePath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { principals?: unknown };
  if (!Array.isArray(parsed.principals) || parsed.principals.length === 0) {
    throw new Error('Principal file must contain a non-empty principals array');
  }
  const credentials = parsed.principals.map(parseCredential);
  if (new Set(credentials.map(item => item.id)).size !== credentials.length) {
    throw new Error('Principal ids must be unique');
  }
  if (new Set(credentials.map(item => item.token_sha256)).size !== credentials.length) {
    throw new Error('Principal token_sha256 values must be unique');
  }
  return credentials;
}

export function resolvePrincipal(header: string | undefined, credentials: McpPrincipalCredential[]): McpPrincipal | null {
  if (!header?.startsWith('Bearer ')) return null;
  const presented = Buffer.from(hashBearerToken(header.slice(7)), 'hex');
  for (const credential of credentials) {
    const expected = Buffer.from(credential.token_sha256, 'hex');
    if (presented.length === expected.length && timingSafeEqual(presented, expected)) {
      const { token_sha256: _, ...principal } = credential;
      return principal;
    }
  }
  return null;
}
