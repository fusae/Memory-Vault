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

type ReplaceManagedBlockResult =
  | { skipped: false; content: string }
  | { skipped: true; reason: 'skipped_malformed' };

function markerPositions(existing: string, marker: string): number[] {
  const positions: number[] = [];
  let offset = 0;
  while (offset <= existing.length) {
    const pos = existing.indexOf(marker, offset);
    if (pos < 0) break;
    positions.push(pos);
    offset = pos + marker.length;
  }
  return positions;
}

function replaceManagedBlock(existing: string, block: string): ReplaceManagedBlockResult {
  const begins = markerPositions(existing, BEGIN_MARKER);
  const ends = markerPositions(existing, END_MARKER);

  if (begins.length === 1 && ends.length === 1 && begins[0] < ends[0]) {
    return {
      skipped: false,
      content: existing.slice(0, begins[0]) + block + existing.slice(ends[0] + END_MARKER.length),
    };
  }

  if (begins.length > 0 || ends.length > 0) {
    return { skipped: true, reason: 'skipped_malformed' };
  }

  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : existing.length > 0 ? '\n' : '';
  return { skipped: false, content: existing + separator + block };
}

export async function refreshAgentsMd(
  store: MemoryStore,
  registration: ProjectRegistration,
  opts: { redact?: boolean } = {}
): Promise<void> {
  const filePath = path.resolve(registration.agents_md_path);
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  const initialCheck = replaceManagedBlock(existing, '');
  if (initialCheck.skipped) {
    recordEvent({
      event_type: 'sync',
      project_key: registration.project_key,
      source_tool: 'sync-agents-md',
      detail: `${path.basename(filePath)} ${initialCheck.reason}`,
    });
    return;
  }

  const output = await buildRecallContext(store, { project: registration.project_key, format: 'context', sourceTool: 'sync-agents-md' });
  const context = opts.redact ? redactContext(output) : output;
  const block = `${BEGIN_MARKER}\n${context}\n${END_MARKER}`;
  const next = replaceManagedBlock(existing, block);
  if (next.skipped) {
    recordEvent({
      event_type: 'sync',
      project_key: registration.project_key,
      source_tool: 'sync-agents-md',
      detail: `${path.basename(filePath)} ${next.reason}`,
    });
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next.content, 'utf-8');

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
