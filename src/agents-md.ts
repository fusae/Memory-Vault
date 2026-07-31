import fs from 'node:fs';
import path from 'node:path';
import { getDatabase, recordEvent } from './db.js';
import { deriveProjectKey } from './project-key.js';
import { buildRecallContext } from './recall.js';
import type { MemoryStore } from './memory-store.js';

const BEGIN_MARKER = '<!-- memory-vault:begin -->';
const END_MARKER = '<!-- memory-vault:end -->';
const SENSITIVE_RE = /\b(key|token|password|secret)\b/i;

export interface ProjectRegistration {
  project_key: string;
  agents_md_path: string;
  registered_at: string;
  updated_at: string;
}

export function getProjectRegistration(projectKey: string): ProjectRegistration | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM projects WHERE project_key = ?').get(projectKey) as ProjectRegistration | undefined;
  return row ?? null;
}

export function registerProject(projectKey: string, agentsMdPath: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO projects (project_key, agents_md_path, registered_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_key) DO UPDATE SET
      agents_md_path = excluded.agents_md_path,
      updated_at = excluded.updated_at
  `).run(projectKey, path.resolve(agentsMdPath), now, now);
}

export function listProjectRegistrations(): ProjectRegistration[] {
  const db = getDatabase();
  return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRegistration[];
}

function redactContext(output: string): string {
  return output
    .split('\n')
    .filter(line => !line.startsWith('- ') || !SENSITIVE_RE.test(line))
    .join('\n')
    .trimEnd();
}

function replaceManagedBlock(existing: string, block: string): string {
  const begin = existing.indexOf(BEGIN_MARKER);
  const end = existing.indexOf(END_MARKER, begin + BEGIN_MARKER.length);
  if (begin >= 0 && end >= 0) {
    return existing.slice(0, begin) + block + existing.slice(end + END_MARKER.length);
  }
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : existing.length > 0 ? '\n' : '';
  return existing + separator + block;
}

export async function refreshAgentsMd(
  store: MemoryStore,
  registration: ProjectRegistration,
  opts: { redact?: boolean } = {}
): Promise<void> {
  const output = await buildRecallContext(store, { project: registration.project_key, format: 'context', sourceTool: 'sync-agents-md' });
  const context = opts.redact ? redactContext(output) : output;
  const block = `${BEGIN_MARKER}\n${context}\n${END_MARKER}`;
  const filePath = path.resolve(registration.agents_md_path);
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  const next = replaceManagedBlock(existing, block);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next, 'utf-8');

  const now = new Date().toISOString();
  getDatabase().prepare('UPDATE projects SET updated_at = ? WHERE project_key = ?').run(now, registration.project_key);
  recordEvent({
    event_type: 'sync',
    project_key: registration.project_key,
    source_tool: 'sync-agents-md',
    detail: path.basename(filePath),
  });
}

export async function syncAgentsMd(
  store: MemoryStore,
  opts: { cwd?: string; all?: boolean; redact?: boolean }
): Promise<void> {
  try {
    const registrations = opts.all
      ? listProjectRegistrations()
      : [getProjectRegistration(deriveProjectKey(opts.cwd ?? process.cwd()))].filter((r): r is ProjectRegistration => !!r);

    for (const registration of registrations) {
      try {
        await refreshAgentsMd(store, registration, { redact: opts.redact });
      } catch { /* silent degradation */ }
    }
  } catch { /* silent degradation */ }
}

export function scheduleAgentsMdRefresh(store: MemoryStore, project?: string, sourceCwd?: string): void {
  if (!project) return;
  const run = async () => {
    try {
      let registration = getProjectRegistration(project);
      if (!registration && sourceCwd) {
        registerProject(project, path.join(sourceCwd, 'AGENTS.md'));
        registration = getProjectRegistration(project);
      }
      if (registration) await refreshAgentsMd(store, registration);
    } catch { /* silent degradation */ }
  };
  setImmediate(() => { void run(); });
}
