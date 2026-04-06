import os from 'node:os';
import path from 'node:path';

export function expandHomeDir(inputPath: string): string {
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

export function getMemoryDbPath(envPath = process.env.MEMORY_DB_PATH): string {
  return expandHomeDir(envPath ?? path.join(os.homedir(), '.memoryvault', 'memory.db'));
}
