import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildExtractionPrompt, EXTRACT_MAX_CHARS } from './cli-commands.js';
import { createDatabase, getSweepWatermark, recordEvent, setSweepWatermark } from './db.js';
import { getMemoryDbPath } from './path-utils.js';
import { deriveProjectKey } from './project-key.js';

const SOURCE = 'codex';

export interface CodexSweepOptions {
  codexHome?: string;
  dryRun?: boolean;
  limit?: string | number;
  executor?: (prompt: string) => boolean;
}

interface SessionFile {
  file: string;
  mtimeMs: number;
  mtimeIso: string;
}

interface ParsedRollout {
  conversation: string;
  cwd?: string;
}

function commandExists(command: string): boolean {
  const result = spawnSync('sh', ['-lc', `command -v ${command} >/dev/null 2>&1`], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

export function runClaudePrompt(prompt: string): boolean {
  if (!commandExists('claude')) return false;

  try {
    const child = spawn('claude', ['-p', prompt, '--mcp-config', path.join(os.homedir(), '.claude', 'mcp.json')], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function parseLimit(value: string | number | undefined): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value ?? '20', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 20;
}

function listRollouts(dir: string, watermark: string | null): SessionFile[] {
  const files: SessionFile[] = [];
  const minTime = watermark ? Date.parse(watermark) : 0;

  function walk(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !/^rollout-.*\.jsonl$/.test(entry.name)) continue;

      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs > minTime) {
          files.push({ file: full, mtimeMs: stat.mtimeMs, mtimeIso: stat.mtime.toISOString() });
        }
      } catch {
        // Ignore files that disappear during sweep.
      }
    }
  }

  walk(dir);
  return files.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .flatMap(block => {
      if (!block || typeof block !== 'object') return [];
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === 'text' && typeof candidate.text === 'string' ? [candidate.text] : [];
    })
    .join('\n')
    .trim();
}

function findCwd(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of ['cwd', 'current_working_directory']) {
    if (typeof obj[key] === 'string' && obj[key].trim()) return obj[key] as string;
  }
  for (const key of ['session', 'metadata', 'meta']) {
    const nested = findCwd(obj[key]);
    if (nested) return nested;
  }
  return undefined;
}

export function parseCodexRollout(file: string): ParsedRollout {
  const messages: string[] = [];
  let cwd: string | undefined;
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return { conversation: '' };
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      cwd ||= findCwd(obj);

      const type = obj.type;
      const message = obj.message && typeof obj.message === 'object' ? obj.message as Record<string, unknown> : undefined;
      const role = (message?.role ?? obj.role) as unknown;
      const content = message?.content ?? obj.content ?? obj.text;
      const text = textFromContent(content);
      if (!text) continue;

      if (type === 'user' || role === 'user') messages.push(`User: ${text}`);
      else if (type === 'assistant' || role === 'assistant') messages.push(`Assistant: ${text}`);
    } catch {
      // Skip malformed rollout lines.
    }
  }

  let conversation = messages.join('\n\n');
  if (conversation.length > EXTRACT_MAX_CHARS) conversation = conversation.slice(-EXTRACT_MAX_CHARS);
  return { conversation, cwd };
}

export async function sweepCodex(opts: CodexSweepOptions = {}): Promise<void> {
  try {
    createDatabase(getMemoryDbPath());
    const codexHome = opts.codexHome ?? path.join(os.homedir(), '.codex');
    const sessionsDir = path.join(codexHome, 'sessions');
    const watermark = getSweepWatermark(SOURCE);
    const files = listRollouts(sessionsDir, watermark).slice(0, parseLimit(opts.limit));

    if (opts.dryRun) {
      for (const item of files) {
        const parsed = parseCodexRollout(item.file);
        const projectKey = parsed.cwd ? deriveProjectKey(parsed.cwd) : '';
        console.log(`${item.file}${projectKey ? `\t${projectKey}` : ''}`);
      }
      return;
    }

    if (files.length === 0) return;

    const executor = opts.executor ?? runClaudePrompt;
    let maxWatermark: string | null = null;
    let processed = 0;

    for (const item of files) {
      const parsed = parseCodexRollout(item.file);
      const projectKey = parsed.cwd ? deriveProjectKey(parsed.cwd) : undefined;
      const prompt = parsed.conversation.trim() ? buildExtractionPrompt(parsed.conversation, projectKey) : '';
      if (prompt && !executor(prompt)) return;
      maxWatermark = item.mtimeIso;
      processed += 1;
    }

    if (maxWatermark) {
      setSweepWatermark(SOURCE, maxWatermark);
      recordEvent({ event_type: 'sync', source_tool: 'codex', detail: 'codex-sweep' });
    }
  } catch {
    // Opportunistic sweeps must never fail the caller.
  }
}
