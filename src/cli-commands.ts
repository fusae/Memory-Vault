import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import readline from 'node:readline';
import { CryptoService } from './crypto.js';
import { MemoryStore } from './memory-store.js';
import { AuthService } from './auth.js';
import { getSupabaseClient, createSupabaseClient } from './supabase.js';
import type { MemoryType } from './types.js';
import { getMemoryDbPath } from './path-utils.js';
import { getDatabase } from './db.js';
import { deriveProjectKey } from './project-key.js';
import { buildRecallContext } from './recall.js';
import { registerProject, syncAgentsMd } from './agents-md.js';
import { retryPendingTeamMemoryPushes } from './space-sync.js';
import { startSpaceServer } from './space-server.js';
import { SpaceKeyService, type SpaceInvitation } from './space-crypto.js';
import fs from 'node:fs';
import { issueSpaceAccessToken, revokeMemberAccess } from './space-access.js';
import type { SpaceAccessRole } from './types.js';
import { hashBearerToken, loadPrincipalCredentials, type McpPrincipalCredential, type McpPrincipalRole } from './mcp-principal.js';

const DB_PATH = getMemoryDbPath();
export const EXTRACT_MAX_CHARS = 50000;

let _store: MemoryStore | null = null;
function getStore(): MemoryStore {
  if (!_store) {
    const passphrase = process.env.MEMORYVAULT_PASSPHRASE?.trim();
    const crypto = passphrase ? new CryptoService(passphrase) : undefined;
    const identity = SpaceKeyService.loadIdentity();
    _store = new MemoryStore(DB_PATH, crypto, identity ? new SpaceKeyService(identity) : undefined);
  }
  return _store;
}

export async function addMemory(content: string, opts: { type: string; tags?: string; project?: string; confidence?: string; scope?: string; space?: string; spaceId?: string }) {
  const store = getStore();
  const spaceId = opts.space ?? opts.spaceId;
  const result = await store.write({
    content,
    type: opts.type as MemoryType,
    tags: opts.tags ? opts.tags.split(',').map(t => t.trim()) : undefined,
    project: opts.project,
    confidence: opts.confidence ? parseFloat(opts.confidence) : undefined,
    source_tool: 'cli',
    scope: opts.scope,
    space_id: spaceId,
  });
  const memory = result.memory;
  console.log(`✓ Memory created: ${memory.id}`);
  console.log(`  Type: ${memory.type}`);
  console.log(`  Content: ${memory.content}`);
  if (memory.tags.length) console.log(`  Tags: ${memory.tags.join(', ')}`);
  if (result.conflict_action !== 'created') {
    console.log(`  Conflict: ${result.conflict_action}`);
  }
}

export function promoteMemory(id: string, opts: { space?: string }) {
  if (!opts.space?.trim()) {
    console.error('Missing --space <space_id>');
    process.exit(1);
  }

  const store = getStore();
  const memory = store.promoteToTeam(id, opts.space.trim());
  console.log(`✓ Memory promoted: ${memory.id}`);
  console.log(`  Scope: ${memory.scope}`);
  console.log(`  Space: ${memory.space_id}`);
}

export function joinSpace(spaceId: string, opts: { name?: string; url?: string; token?: string }) {
  const store = getStore();
  const space = store.joinSpace(spaceId, opts.name, opts.url, opts.token);
  console.log(`✓ Space joined: ${space.space_id}`);
  console.log(`  Name: ${space.name}`);
  if (space.remote_url) console.log(`  Remote: ${space.remote_url}`);
}

export function listSpaces() {
  const store = getStore();
  const spaces = store.listSpaces();

  if (spaces.length === 0) {
    console.log('No spaces joined.');
    return;
  }

  for (const space of spaces) {
    console.log(`[${space.space_id}] ${space.name}`);
    if (space.remote_url) console.log(`  Remote: ${space.remote_url}`);
    console.log(`  Joined: ${space.joined_at}`);
    console.log('');
  }
  console.log(`Total: ${spaces.length} spaces`);
}

function requireSpaceKeys(): SpaceKeyService {
  getStore();
  const identity = SpaceKeyService.loadIdentity();
  if (!identity) throw new Error('Space identity is not initialized. Run: memory-vault-cli space identity-init <member_id>');
  return new SpaceKeyService(identity);
}

export function initSpaceIdentity(memberId: string) {
  const destination = SpaceKeyService.identityPath();
  if (fs.existsSync(destination)) throw new Error(`Space identity already exists: ${destination}`);
  const identity = SpaceKeyService.generateIdentity(memberId);
  SpaceKeyService.saveIdentity(identity);
  console.log(JSON.stringify({
    member_id: identity.member_id,
    encryption_public_key: identity.encryption_public_key,
    signing_public_key: identity.signing_public_key,
  }, null, 2));
}

export function exportSpaceIdentity(opts: { output?: string }) {
  const identity = requireSpaceKeys().identity;
  const publicIdentity = {
    member_id: identity.member_id,
    encryption_public_key: identity.encryption_public_key,
    signing_public_key: identity.signing_public_key,
  };
  const output = JSON.stringify(publicIdentity, null, 2);
  if (opts.output) {
    fs.writeFileSync(opts.output, output, { mode: 0o600 });
    console.log(opts.output);
  } else {
    console.log(output);
  }
}

export function initEncryptedSpace(spaceId: string, opts: { name?: string }) {
  const version = requireSpaceKeys().createSpace(spaceId, opts.name);
  console.log(`Encrypted space initialized: ${spaceId}@${version}`);
}

export function inviteSpaceMember(spaceId: string, publicIdentityFile: string, opts: { output?: string }) {
  const member = JSON.parse(fs.readFileSync(publicIdentityFile, 'utf8')) as {
    member_id: string;
    encryption_public_key: string;
    signing_public_key: string;
  };
  const invitation = requireSpaceKeys().addMember(spaceId, member);
  const output = JSON.stringify(invitation, null, 2);
  if (opts.output) {
    fs.writeFileSync(opts.output, output, { mode: 0o600 });
    console.log(opts.output);
  } else {
    console.log(output);
  }
}

export function acceptSpaceInvitation(invitationFile: string) {
  const invitation = JSON.parse(fs.readFileSync(invitationFile, 'utf8')) as SpaceInvitation;
  requireSpaceKeys().acceptInvitation(invitation);
  console.log(`Encrypted space joined: ${invitation.space_id}@${invitation.key_version}`);
}

export function rotateSpaceKey(spaceId: string) {
  console.log(`Space key rotated: ${spaceId}@${requireSpaceKeys().rotate(spaceId)}`);
}

export function revokeSpaceMember(spaceId: string, memberId: string) {
  const version = requireSpaceKeys().revokeMember(spaceId, memberId);
  revokeMemberAccess(spaceId, memberId);
  console.log(`Member revoked; access disabled; space key rotated: ${spaceId}@${version}`);
}

export function issueMemberToken(spaceId: string, memberId: string, opts: { role?: string }) {
  const keys = requireSpaceKeys();
  const role = (opts.role ?? 'writer') as SpaceAccessRole;
  if (!['reader', 'writer', 'owner'].includes(role)) throw new Error('role must be reader, writer, or owner');
  console.log(issueSpaceAccessToken({
    space_id: spaceId,
    member_id: memberId,
    role,
    issuer_id: keys.identity.member_id,
  }));
}

export function addHttpPrincipal(opts: {
  file?: string;
  id?: string;
  role?: string;
  tenant?: string;
  projects?: string;
  spaces?: string;
  tokenEnv?: string;
}): { file: string; token?: string; principal: McpPrincipalCredential } {
  const roles: McpPrincipalRole[] = ['admin', 'manager', 'writer', 'reviewer', 'human', 'observer'];
  const role = opts.role as McpPrincipalRole;
  const id = opts.id?.trim() || '';
  const tenantId = opts.tenant?.trim() || '';
  const projects = opts.projects?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  const spaces = opts.spaces?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  if (!id || !tenantId || !roles.includes(role) || projects.length === 0 || spaces.length === 0) {
    throw new Error('id, valid role, tenant, projects, and spaces are required');
  }

  const file = path.resolve((opts.file ?? path.join(os.homedir(), '.memoryvault', 'http-principals.json')).replace(/^~(?=$|\/)/, os.homedir()));
  const existing = fs.existsSync(file) ? loadPrincipalCredentials(file) : [];
  if (existing.some(item => item.id === id)) throw new Error(`Principal already exists: ${id}`);
  const suppliedToken = opts.tokenEnv ? process.env[opts.tokenEnv]?.trim() : undefined;
  if (opts.tokenEnv && !suppliedToken) throw new Error(`Token environment variable is empty: ${opts.tokenEnv}`);
  const generatedToken = suppliedToken ? undefined : randomBytes(32).toString('base64url');
  const token = suppliedToken ?? generatedToken!;
  const principal: McpPrincipalCredential = {
    token_sha256: hashBearerToken(token),
    id,
    role,
    tenant_id: tenantId,
    projects: [...new Set(projects)],
    spaces: [...new Set(spaces)],
  };

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ principals: [...existing, principal] }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
  console.log(`Principal added: ${id} (${role})`);
  console.log(`Principal file: ${file}`);
  if (generatedToken) console.log(`Bearer token (shown once): ${generatedToken}`);
  return { file, token: generatedToken, principal };
}

export async function searchMemories(query: string, opts: { type?: string; project?: string; limit?: string }) {
  const store = getStore();
  const results = await store.search({
    query,
    type: opts.type as MemoryType | undefined,
    project: opts.project,
    limit: opts.limit ? parseInt(opts.limit, 10) : 10,
  });

  if (results.length === 0) {
    console.log('No memories found.');
    return;
  }

  for (const r of results) {
    console.log(`[${r.id}] (${r.type}) ${r.content}`);
    if (r.tags.length) console.log(`  Tags: ${r.tags.join(', ')}`);
    console.log(`  Distance: ${r.distance.toFixed(4)}`);
    console.log('');
  }
}

export function listMemories(opts: { type?: string; project?: string }) {
  const store = getStore();
  const memories = store.list(opts.type, opts.project);

  if (memories.length === 0) {
    console.log('No memories found.');
    return;
  }

  for (const m of memories) {
    console.log(`[${m.id}] (${m.type}) ${m.content}`);
    if (m.tags.length) console.log(`  Tags: ${m.tags.join(', ')}`);
    if (m.project) console.log(`  Project: ${m.project}`);
    console.log(`  Updated: ${m.updated_at}`);
    console.log('');
  }
  console.log(`Total: ${memories.length} memories`);
}

export async function recallMemories(opts: { cwd?: string; format?: string; limit?: string; budget?: string; query?: string }) {
  try {
    const cwd = opts.cwd ?? process.cwd();
    const project = deriveProjectKey(cwd);
    const store = getStore();
    await retryPendingTeamMemoryPushes();
    const output = await buildRecallContext(store, { project, format: opts.format, limit: opts.limit, budget: opts.budget, query: opts.query, sourceTool: 'cli' });
    process.stdout.write(output);
    return output;
  } catch {
    process.stdout.write('');
    return '';
  }
}

export async function syncAgentsMdCommand(opts: { cwd?: string; all?: boolean; redact?: boolean }) {
  try {
    const store = getStore();
    await retryPendingTeamMemoryPushes();
    if (!opts.all) {
      const cwd = opts.cwd ?? process.cwd();
      registerProject(deriveProjectKey(cwd), path.join(cwd, 'AGENTS.md'));
    }
    await syncAgentsMd(store, opts);
  } catch { /* silent degradation */ }
}

export function serveSpaceCommand(opts: { port?: string; token?: string; space?: string }) {
  const port = opts.port ? parseInt(opts.port, 10) : NaN;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    console.error('Missing or invalid --port <p>');
    process.exit(1);
  }
  if (!opts.token?.trim()) {
    console.error('Missing --token <t>');
    process.exit(1);
  }

  getStore();
  startSpaceServer({
    port,
    token: opts.token.trim(),
    space: opts.space?.trim() || undefined,
    onReady: () => {
      console.log(`MemoryVault space server running at http://localhost:${port}`);
    },
  });
}

export function getMemory(id: string) {
  const store = getStore();
  const memory = store.get(id);
  if (!memory) {
    console.error(`Memory not found: ${id}`);
    process.exit(1);
  }
  console.log(JSON.stringify(memory, null, 2));
}

export function deleteMemory(id: string) {
  const store = getStore();
  const existing = store.get(id);
  if (!existing) {
    console.error(`Memory not found: ${id}`);
    process.exit(1);
  }
  store.delete(id);
  console.log(`✓ Memory deleted: ${id}`);
}

export async function correctMemory(memoryRef: string, content: string, opts: { reason?: string }) {
  const memory = await getStore().correct(memoryRef, content, opts.reason);
  console.log(`✓ Memory corrected: ${memory.memory_ref}`);
  console.log(`  Content: ${memory.content}`);
}

export function exportMemories(opts: { format?: string }) {
  const store = getStore();
  if (opts.format === 'markdown') {
    console.log(store.exportMarkdown());
  } else {
    const all = store.export();
    console.log(JSON.stringify(all, null, 2));
  }
}

export function organizeMemories(opts: { auto?: boolean; project?: string }) {
  const store = getStore();
  const stats = store.getHealthStats();

  console.log('=== MemoryVault Health Report ===\n');
  console.log(`Total memories: ${stats.total}`);
  console.log(`By type: ${Object.entries(stats.byType).map(([k, v]) => `${k}(${v})`).join(', ') || 'none'}`);
  console.log(`By status: ${Object.entries(stats.byStatus).map(([k, v]) => `${k}(${v})`).join(', ') || 'none'}`);
  console.log(`Pending review: ${stats.pendingReviewCount}`);
  console.log(`Low confidence (<0.5): ${stats.lowConfidenceCount}`);
  console.log(`Stale episodes (>30d, no expiry): ${stats.staleEpisodesCount}`);
  if (stats.oldestMemory) console.log(`Oldest: ${stats.oldestMemory}`);
  if (stats.newestMemory) console.log(`Newest: ${stats.newestMemory}`);
  console.log('');

  if (opts.auto) {
    const result = store.autoOrganize(opts.project);
    console.log('=== Auto-Organize Results ===\n');
    console.log(`Set expires_at on ${result.expiredCount} stale episode(s)`);
    console.log(`Archived ${result.archivedCount} very low confidence memory(ies)`);
  } else {
    console.log('Run with --auto to execute safe cleanup actions.');
  }
}

export function synthesizeMemories(opts: { hours?: string; project?: string; dryRun?: boolean }) {
  const store = getStore();
  const hours = opts.hours ? parseInt(opts.hours, 10) : 24;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const recent = store.getRecentMemories(since);

  console.log(`=== MemoryVault Synthesis Report ===\n`);
  console.log(`Time range: last ${hours} hours (since ${since.toISOString()})`);
  console.log(`Recent memories found: ${recent.length}\n`);

  if (recent.length === 0) {
    console.log('No recent memories to synthesize.');
    return;
  }

  // Phase 1: Find memories missing tags
  const untagged = recent.filter(m => m.tags.length === 0);
  if (untagged.length > 0) {
    console.log(`--- Untagged memories: ${untagged.length} ---`);
    for (const m of untagged) {
      console.log(`  [${m.id}] (${m.type}) ${m.content}`);
    }
    console.log('');
  }

  // Phase 2: Find potential duplicates (same type, similar content keywords)
  const duplicateGroups: { ids: string[]; contents: string[] }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < recent.length; i++) {
    if (seen.has(recent[i].id)) continue;
    const group = [recent[i]];
    for (let j = i + 1; j < recent.length; j++) {
      if (seen.has(recent[j].id)) continue;
      if (recent[i].type !== recent[j].type) continue;
      // Simple keyword overlap heuristic
      const words1 = new Set(recent[i].content.toLowerCase().split(/\s+/));
      const words2 = new Set(recent[j].content.toLowerCase().split(/\s+/));
      const overlap = [...words1].filter(w => words2.has(w) && w.length > 3).length;
      const minSize = Math.min(words1.size, words2.size);
      if (minSize > 0 && overlap / minSize > 0.5) {
        group.push(recent[j]);
        seen.add(recent[j].id);
      }
    }
    if (group.length > 1) {
      seen.add(recent[i].id);
      duplicateGroups.push({
        ids: group.map(m => m.id),
        contents: group.map(m => m.content),
      });
    }
  }
  if (duplicateGroups.length > 0) {
    console.log(`--- Potential duplicate groups: ${duplicateGroups.length} ---`);
    for (const g of duplicateGroups) {
      console.log(`  Group (${g.ids.length} memories):`);
      for (let i = 0; i < g.ids.length; i++) {
        console.log(`    [${g.ids[i]}] ${g.contents[i]}`);
      }
    }
    console.log('');
  }

  // Phase 3: Find contradictions (same type, same project, different confidence)
  const byTypeProject = new Map<string, typeof recent>();
  for (const m of recent) {
    const key = `${m.type}:${m.project ?? ''}`;
    if (!byTypeProject.has(key)) byTypeProject.set(key, []);
    byTypeProject.get(key)!.push(m);
  }

  let contradictionCount = 0;
  for (const [, group] of byTypeProject) {
    if (group.length < 2) continue;
    const confidences = group.map(m => m.confidence);
    const maxConf = Math.max(...confidences);
    const minConf = Math.min(...confidences);
    if (maxConf - minConf > 0.3) {
      if (contradictionCount === 0) console.log(`--- Potential contradictions ---`);
      contradictionCount++;
      for (const m of group) {
        console.log(`  [${m.id}] (${m.type}) conf=${m.confidence} — ${m.content}`);
      }
      console.log('');
    }
  }

  // Phase 4: Find low-value memories
  const lowValue = recent.filter(m => m.confidence < 0.5 && m.confirmation_count === 0);
  if (lowValue.length > 0) {
    console.log(`--- Low-value memories (low confidence, unconfirmed): ${lowValue.length} ---`);
    for (const m of lowValue) {
      console.log(`  [${m.id}] (${m.type}) conf=${m.confidence} — ${m.content}`);
    }
    console.log('');
  }

  // Auto-execute safe actions if not dry run
  if (!opts.dryRun) {
    const result = store.autoOrganize(opts.project);
    console.log(`=== Auto-Organize Results ===\n`);
    console.log(`Set expires_at on ${result.expiredCount} stale episode(s)`);
    console.log(`Archived ${result.archivedCount} very low confidence memory(ies)`);
  } else {
    console.log('Dry run mode — no changes made. Remove --dry-run to execute auto-actions.');
  }

  // Summary
  console.log(`\n=== Summary ===`);
  console.log(`Untagged: ${untagged.length}`);
  console.log(`Duplicate groups: ${duplicateGroups.length}`);
  console.log(`Low-value: ${lowValue.length}`);
  console.log(`\nFor deeper analysis (merging duplicates, resolving contradictions),`);
  console.log(`run: memory-vault-cli organize --auto`);
}

function extractTranscriptText(content: unknown): string {
  if (typeof content === 'string') return content;

  if (!Array.isArray(content)) return '';

  return content
    .flatMap(block => {
      if (!block || typeof block !== 'object') return [];

      const candidate = block as { type?: unknown; text?: unknown };
      if (candidate.type !== 'text' || typeof candidate.text !== 'string') return [];

      return [candidate.text];
    })
    .join('\n')
    .trim();
}

export async function extractMemories(opts: { file?: string; transcript?: boolean; projectKey?: string }) {
  let conversation: string;

  if (opts.file) {
    const fs = await import('node:fs');
    const raw = fs.readFileSync(opts.file, 'utf-8');

    if (opts.transcript || opts.file.endsWith('.jsonl')) {
      // Parse JSONL transcript format (Claude Code session transcript)
      const lines = raw.trim().split('\n');
      const messages: string[] = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.isMeta) continue;

          const role = obj.message?.role;
          const content = obj.message?.content ?? obj.content;

          if (obj.type === 'user' && role === 'user') {
            const text = extractTranscriptText(content);
            if (text) messages.push(`User: ${text}`);
          } else if (obj.type === 'assistant' && role === 'assistant') {
            const text = extractTranscriptText(content);
            if (text) messages.push(`Assistant: ${text}`);
          }
        } catch { /* skip malformed lines */ }
      }
      conversation = messages.join('\n\n');
    } else {
      conversation = raw;
    }
  } else {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    conversation = Buffer.concat(chunks).toString('utf-8');
  }

  if (!conversation.trim()) {
    console.error('No conversation content provided. Use --file <path> with a transcript .jsonl file.');
    process.exit(1);
  }

  const prompt = buildExtractionPrompt(conversation, opts.projectKey);

  console.log(prompt);
}

export function buildExtractionPrompt(conversation: string, projectKey?: string): string {
  if (conversation.length > EXTRACT_MAX_CHARS) {
    conversation = conversation.slice(-EXTRACT_MAX_CHARS);
  }

  const projectInstruction = projectKey
    ? `- project: The project field must use this exact value: ${projectKey}`
    : '- project: Project name if related to a specific project';

  return `You are a memory extraction engine. Analyze the following conversation between a user and an AI, and extract information worth remembering long-term.

Extraction rules:
1. Only extract information that has "cross-session value" — ignore one-off questions
2. Focus on user preferences, habits, corrections, and recurring patterns
3. Focus on project-level architecture decisions and tech stack choices
4. Ignore general knowledge (e.g. "React is a frontend framework")
5. If information is uncertain, set lower confidence (0.5-0.6)

For each extracted memory, call the memory_write tool with these parameters:
- type: identity | preference | project | episode | rule
- content: One natural language sentence
- confidence: 0.0-1.0
- tags: Array of relevant tags
${projectInstruction}
- source_cwd: Current working directory if known

If there is nothing worth remembering, say "No memories to extract."

---

Conversation:

${conversation}`;
}

export function migrateProjects(opts: { map?: string; dryRun?: boolean }) {
  if (!opts.map) {
    console.error('Missing --map <old>=<project-key>');
    process.exit(1);
  }

  const separator = opts.map.indexOf('=');
  if (separator <= 0 || separator === opts.map.length - 1) {
    console.error('Invalid --map. Expected <old>=<project-key>.');
    process.exit(1);
  }

  const oldProject = opts.map.slice(0, separator);
  const projectKey = opts.map.slice(separator + 1);
  getStore();
  const db = getDatabase();
  const row = db.prepare('SELECT COUNT(*) as count FROM memories WHERE project = ?').get(oldProject) as { count: number };

  if (opts.dryRun) {
    console.log(`Would update ${row.count} memories from "${oldProject}" to "${projectKey}".`);
    return;
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE memories
    SET project = ?,
        sync_status = CASE WHEN sync_status = 'synced' THEN 'modified' ELSE sync_status END,
        updated_at = ?
    WHERE project = ?
  `).run(projectKey, now, oldProject);
  console.log(`Updated ${row.count} memories from "${oldProject}" to "${projectKey}".`);
}

// ─── Helper: prompt for user input ───
function askInput(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Auth Commands ───
export async function authLogin() {
  const config = AuthService.loadConfig();
  const url = process.env.SUPABASE_URL || config.supabase_url;
  const key = process.env.SUPABASE_ANON_KEY || config.supabase_anon_key;

  if (!url || !key) {
    console.error('Supabase not configured. Run: memory-vault-cli setup');
    process.exit(1);
  }

  const supabase = createSupabaseClient(url, key);
  const auth = new AuthService(supabase);

  const email = await askInput('Email: ');
  if (!email) { console.error('Email required.'); process.exit(1); }

  await auth.sendOtp(email);
  console.log(`Verification code sent to ${email}. Check your inbox.`);

  const token = await askInput('Enter the verification code from email: ');
  const session = await auth.verifyOtp(email, token);
  console.log(`Logged in as ${session.user.email} (${session.user.id})`);
}

export async function authStatus() {
  const config = AuthService.loadConfig();
  const url = process.env.SUPABASE_URL || config.supabase_url;
  const key = process.env.SUPABASE_ANON_KEY || config.supabase_anon_key;

  if (!url || !key) {
    console.log('Not configured. Run: memory-vault-cli setup');
    return;
  }

  const supabase = createSupabaseClient(url, key);
  const auth = new AuthService(supabase);
  const session = await auth.getSession();

  if (session) {
    console.log(`Logged in as: ${session.user.email}`);
    console.log(`User ID: ${session.user.id}`);
    console.log(`Expires: ${new Date((session.expires_at ?? 0) * 1000).toISOString()}`);
  } else {
    console.log('Not logged in. Run: memory-vault-cli auth login');
  }
}

export async function authLogout() {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.log('Not configured.');
    return;
  }
  const auth = new AuthService(supabase);
  await auth.signOut();
  console.log('Logged out.');
}

// ─── Setup Command ───
export async function setupCommand() {
  console.log('=== MemoryVault Setup ===\n');
  console.log('You need a Supabase project. Get one at https://supabase.com\n');

  const url = await askInput('Supabase URL (e.g. https://xxx.supabase.co): ');
  const key = await askInput('Supabase Anon Key: ');

  if (!url || !key) {
    console.error('Both URL and key are required.');
    process.exit(1);
  }

  // Test connection
  try {
    const supabase = createSupabaseClient(url, key);
    const { error } = await supabase.auth.getSession();
    if (error) throw error;
    console.log('\nConnection successful!');
  } catch (e: unknown) {
    console.error(`Connection failed: ${(e as Error).message}`);
    process.exit(1);
  }

  AuthService.saveConfig({ supabase_url: url, supabase_anon_key: key });
  console.log('Config saved to ~/.memoryvault/config.json');
  console.log('\nNext steps:');
  console.log('1. Run the SQL in scripts/setup-supabase.sql in your Supabase SQL Editor');
  console.log('2. Run: memory-vault-cli auth login');
  console.log('3. Run: memory-vault-cli sync');
}

// ─── Sync Command ───
export async function syncCommand(opts: { push?: boolean; pull?: boolean; status?: boolean }) {
  const config = AuthService.loadConfig();
  const url = process.env.SUPABASE_URL || config.supabase_url;
  const key = process.env.SUPABASE_ANON_KEY || config.supabase_anon_key;

  if (!url || !key) {
    console.error('Supabase not configured. Run: memory-vault-cli setup');
    process.exit(1);
  }

  const supabase = createSupabaseClient(url, key);
  const auth = new AuthService(supabase);
  const session = await auth.getSession();

  if (!session) {
    console.error('Not logged in. Run: memory-vault-cli auth login');
    process.exit(1);
  }

  const { SyncService } = await import('./sync.js');
  const store = getStore();
  const sync = new SyncService(store, supabase, session.user.id);

  if (opts.status) {
    const status = sync.getStatus();
    console.log(`Local only: ${status.localOnly}`);
    console.log(`Modified: ${status.modified}`);
    console.log(`Synced: ${status.synced}`);
    console.log(`Last sync: ${status.lastSync ?? 'never'}`);
    return;
  }

  if (opts.push) {
    const result = await sync.push();
    console.log(`Pushed ${result.pushed} memory(ies)`);
  } else if (opts.pull) {
    const result = await sync.pull();
    console.log(`Pulled ${result.pulled} memory(ies)`);
  } else {
    const result = await sync.sync();
    console.log(`Pushed ${result.pushed}, pulled ${result.pulled} memory(ies)`);
  }
}

// ─── Init Encryption ───
export async function initEncryption() {
  const { randomBytes } = await import('node:crypto');

  const choice = await askInput('Generate a strong passphrase automatically? (Y/n): ');
  let passphrase: string;

  if (choice.toLowerCase() === 'n') {
    passphrase = await askInput('Set encryption passphrase (min 8 chars): ');
    if (!passphrase || passphrase.length < 8) {
      console.error('Passphrase must be at least 8 characters.');
      process.exit(1);
    }
    const confirm = await askInput('Confirm passphrase: ');
    if (passphrase !== confirm) {
      console.error('Passphrases do not match.');
      process.exit(1);
    }
  } else {
    passphrase = randomBytes(24).toString('base64url');
  }

  const crypto = new CryptoService(passphrase);
  const store = getStore();

  // Encrypt all existing plaintext memories
  const all = store.export();
  const plaintext = all.filter(m => !m.is_encrypted);

  if (plaintext.length > 0) {
    console.log(`Encrypting ${plaintext.length} existing memories...`);

    const { getDatabase } = await import('./db.js');
    const db = getDatabase();

    for (const m of plaintext) {
      const encContent = crypto.encrypt(m.content);
      const encTags = crypto.encrypt(JSON.stringify(m.tags));
      const encExcerpt = m.source_excerpt ? crypto.encrypt(m.source_excerpt) : null;

      db.prepare('UPDATE memories SET content = ?, tags = ?, source_excerpt = ?, is_encrypted = 1 WHERE id = ?')
        .run(encContent, encTags, encExcerpt, m.id);
    }

    console.log(`Done. ${plaintext.length} memories encrypted.`);
  } else {
    console.log('No plaintext memories to encrypt.');
  }

  // Detect shell profile path
  const shell = process.env.SHELL ?? '';
  let profilePath: string;
  if (shell.includes('zsh')) {
    profilePath = '~/.zshrc';
  } else if (shell.includes('fish')) {
    profilePath = '~/.config/fish/config.fish';
  } else if (process.platform === 'win32') {
    profilePath = 'System Environment Variables (or $PROFILE for PowerShell)';
  } else {
    profilePath = '~/.bashrc';
  }

  console.log('\n=== Your Passphrase ===');
  console.log(`\n  ${passphrase}\n`);
  console.log('Save it somewhere safe (e.g. password manager). If lost, encrypted data cannot be recovered.\n');

  if (process.platform === 'win32') {
    console.log('Add this to your environment variables:\n');
    console.log(`  MEMORYVAULT_PASSPHRASE=${passphrase}\n`);
    console.log('Or in PowerShell $PROFILE:\n');
    console.log(`  $env:MEMORYVAULT_PASSPHRASE="${passphrase}"`);
  } else if (shell.includes('fish')) {
    console.log(`Add this to ${profilePath}:\n`);
    console.log(`  set -x MEMORYVAULT_PASSPHRASE "${passphrase}"`);
  } else {
    console.log(`Add this to ${profilePath}:\n`);
    console.log(`  export MEMORYVAULT_PASSPHRASE="${passphrase}"`);
  }
}
