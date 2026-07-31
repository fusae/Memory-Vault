import { execFileSync } from 'node:child_process';
import path from 'node:path';

function normalizePath(cwd: string): string {
  const resolved = path.resolve(cwd);
  return resolved.length > 1 ? resolved.replace(/[\\/]+$/, '') : resolved;
}

export function normalizeRemote(remote: string): string | null {
  let value = remote.trim();
  if (!value) return null;

  value = value.replace(/\.git$/i, '');

  if (value.includes('://')) {
    try {
      const url = new URL(value);
      const host = url.hostname;
      const pathname = url.pathname.replace(/^\/+/, '');
      if (!host || !pathname) return null;
      return `${host}/${pathname}`.toLowerCase();
    } catch {
      return null;
    }
  }

  const scpLike = value.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (scpLike) return `${scpLike[1]}/${scpLike[2]}`.toLowerCase();

  return null;
}

export function deriveProjectKey(cwd: string): string {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return normalizeRemote(remote) ?? normalizePath(cwd);
  } catch {
    return normalizePath(cwd);
  }
}
