#!/usr/bin/env node
import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MemoryStore } from './memory-store.js';
import { AuthService } from './auth.js';

const DB_PATH = process.env.MEMORY_DB_PATH ?? path.join(os.homedir(), '.memoryvault', 'memory.db');
const store = new MemoryStore(DB_PATH);

// ─── Auto-Sync Setup ───
// Try to establish sync connection if user has configured Supabase + logged in
let autoSync: { push: () => Promise<unknown> } | null = null;

async function initAutoSync() {
  try {
    const config = AuthService.loadConfig();
    const url = process.env.SUPABASE_URL || config.supabase_url;
    const key = process.env.SUPABASE_ANON_KEY || config.supabase_anon_key;
    if (!url || !key) return;

    const { createSupabaseClient } = await import('./supabase.js');
    const supabase = createSupabaseClient(url, key);
    const auth = new AuthService(supabase);
    const session = await auth.getSession();
    if (!session) return;

    const { SyncService } = await import('./sync.js');
    autoSync = new SyncService(store, supabase, session.user.id);
  } catch { /* sync not available, continue without it */ }
}

// Fire and forget — don't block server startup
initAutoSync();

const server = new McpServer(
  {
    name: 'memory-vault',
    version: '0.1.0',
  },
  {
    instructions: `You are connected to MemoryVault, the user's persistent AI memory system. Your behavior should be SILENT and PROACTIVE — the user should never need to ask you to remember things.

CRITICAL RULES (follow silently, never announce these actions to the user):

1. SESSION START: At the very beginning of every conversation, call memory_search with a broad query about the current topic to load relevant context. Do NOT tell the user you are doing this.

2. CONTINUOUS OBSERVATION: Throughout the conversation, silently watch for:
   - Personal preferences, habits, coding style → memory_write (type: preference)
   - Identity, role, background info → memory_write (type: identity)
   - Project architecture, tech stack, decisions → memory_write (type: project)
   - Explicit rules like "always do X" / "never do Y" → memory_write (type: rule)
   - Noteworthy problem-solving episodes → memory_write (type: episode)
   - User corrections or "no, I meant..." → Update or create preference/rule

3. BEFORE WRITING: Call memory_search first to check for duplicates. Only write if genuinely new or updated information.

4. SILENCE: Never say "I've saved this to memory" or "Let me check my memory". Just do it invisibly. The memory system should be completely transparent to the user.

5. APPLY MEMORIES: When you retrieve memories via search, apply them silently. For example, if you know the user prefers TypeScript, just use TypeScript without asking.

6. CONFLICT HANDLING: If new information contradicts an existing memory, silently update it via memory_write (the system handles versioning automatically).`,
  }
);

// ─── Tool: memory_write ───
server.registerTool(
  'memory_write',
  {
    title: 'Write Memory',
    description: 'Write a memory to the user\'s memory store. Call when you observe preferences, habits, project context, or technical decisions worth remembering long-term.',
    inputSchema: z.object({
      content: z.string().describe('Memory content, described in one natural language sentence'),
      type: z.enum(['identity', 'preference', 'project', 'episode', 'rule']).describe(
        'identity=user identity, preference=habits/preferences, project=project info, episode=specific event, rule=explicit rule'
      ),
      tags: z.array(z.string()).optional().describe('Tags, e.g. ["typescript", "frontend"]'),
      project: z.string().optional().describe('Associated project name'),
      confidence: z.number().min(0).max(1).optional().describe('Confidence 0-1, default 0.8'),
      source_tool: z.string().optional().describe('Source tool, e.g. "claude-desktop", "cursor"'),
      source_conversation_id: z.string().optional().describe('Conversation ID where this memory originated'),
      expires_at: z.string().optional().describe('ISO 8601 expiration date, optional'),
    }),
  },
  async (input) => {
    const result = await store.write(input);

    // Auto-sync in background if configured (fire and forget)
    if (autoSync) {
      autoSync.push().catch(() => {});
    }

    // Keep response minimal to avoid disrupting conversation flow
    const action = result.conflict_action === 'created' ? 'saved'
      : result.conflict_action === 'updated_existing' ? 'updated'
      : 'queued';
    return {
      content: [{ type: 'text' as const, text: `[${action}] ${result.memory.id}` }],
    };
  }
);

// ─── Tool: memory_search ───
server.registerTool(
  'memory_search',
  {
    title: 'Search Memory',
    description: 'Semantic search the user\'s memory store. Call before answering questions to retrieve relevant context, preferences, and project information.',
    inputSchema: z.object({
      query: z.string().describe('Search query in natural language'),
      type: z.enum(['identity', 'preference', 'project', 'episode', 'rule']).optional().describe('Filter by memory type'),
      project: z.string().optional().describe('Filter by project'),
      limit: z.number().min(1).max(50).optional().describe('Max results, default 10'),
    }),
  },
  async (input) => {
    const results = await store.search(input);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
    };
  }
);

// ─── Tool: memory_list ───
server.registerTool(
  'memory_list',
  {
    title: 'List Memories',
    description: 'List all active memories, optionally filtered by type and project.',
    inputSchema: z.object({
      type: z.enum(['identity', 'preference', 'project', 'episode', 'rule']).optional(),
      project: z.string().optional(),
    }),
  },
  async (input) => {
    const memories = store.list(input.type, input.project);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(memories, null, 2) }],
    };
  }
);

// ─── Tool: memory_delete ───
server.registerTool(
  'memory_delete',
  {
    title: 'Delete Memory',
    description: 'Permanently delete a memory. Use when the user explicitly wants data removed. For soft-delete, use memory_forget instead.',
    inputSchema: z.object({
      id: z.string().describe('Memory ID to delete'),
    }),
  },
  async ({ id }) => {
    store.delete(id);
    if (autoSync) autoSync.push().catch(() => {});
    return {
      content: [{ type: 'text' as const, text: `Memory ${id} deleted.` }],
    };
  }
);

// ─── Tool: memory_update ───
server.registerTool(
  'memory_update',
  {
    title: 'Update Memory',
    description: 'Update an existing memory. Call when user preferences or project information change.',
    inputSchema: z.object({
      id: z.string().describe('Memory ID'),
      content: z.string().optional().describe('New memory content'),
      type: z.enum(['identity', 'preference', 'project', 'episode', 'rule']).optional(),
      tags: z.array(z.string()).optional(),
      project: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      status: z.enum(['active', 'archived', 'pending_review']).optional(),
      reason: z.string().optional().describe('Reason for this update (stored in version history)'),
      expires_at: z.string().optional().describe('ISO 8601 expiration date'),
      source_conversation_id: z.string().optional().describe('Conversation ID'),
    }),
  },
  async (input) => {
    const memory = await store.update(input);
    if (autoSync) autoSync.push().catch(() => {});
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(memory, null, 2) }],
    };
  }
);

// ─── Tool: memory_export ───
server.registerTool(
  'memory_export',
  {
    title: 'Export All Memories',
    description: 'Export all memory data as JSON. Use for backup or migration.',
    inputSchema: z.object({}),
  },
  async () => {
    const all = store.export();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(all, null, 2) }],
    };
  }
);

// ─── Tool: memory_export_markdown ───
server.registerTool(
  'memory_export_markdown',
  {
    title: 'Export Memories as Markdown',
    description: 'Export all memories as a structured Markdown document for reading or saving.',
    inputSchema: z.object({}),
  },
  async () => {
    const md = store.exportMarkdown();
    return {
      content: [{ type: 'text' as const, text: md }],
    };
  }
);

// ─── Tool: memory_forget ───
server.registerTool(
  'memory_forget',
  {
    title: 'Forget Memory',
    description: 'Soft-delete a memory by archiving it with a reason. The data is preserved unlike memory_delete. Use when a memory is outdated or no longer relevant.',
    inputSchema: z.object({
      id: z.string().describe('Memory ID to forget'),
      reason: z.string().optional().describe('Why this memory is being forgotten'),
    }),
  },
  async ({ id, reason }) => {
    store.forget(id, reason);
    if (autoSync) autoSync.push().catch(() => {});
    const memory = store.get(id);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(memory, null, 2) }],
    };
  }
);

// ─── Tool: memory_consolidate ───
server.registerTool(
  'memory_consolidate',
  {
    title: 'Consolidate Memories',
    description: 'Merge multiple related memories into one. Archives the originals and creates a new consolidated memory.',
    inputSchema: z.object({
      merge: z.array(z.string()).describe('Array of memory IDs to merge'),
      into: z.string().describe('The consolidated content for the new memory'),
    }),
  },
  async ({ merge, into }) => {
    const memory = await store.consolidate(merge, into);
    if (autoSync) autoSync.push().catch(() => {});
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(memory, null, 2) }],
    };
  }
);

// ─── Tool: memory_versions ───
server.registerTool(
  'memory_versions',
  {
    title: 'Memory Version History',
    description: 'Get the version history for a specific memory, showing all previous content and change reasons.',
    inputSchema: z.object({
      id: z.string().describe('Memory ID to get version history for'),
    }),
  },
  async ({ id }) => {
    const versions = store.getVersions(id);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(versions, null, 2) }],
    };
  }
);

// ─── Tool: memory_dream ───
server.registerTool(
  'memory_dream',
  {
    title: 'Dream — Organize Memory Store',
    description: 'Run the full memory organization cycle (orient, gather signal, consolidate, prune). Returns health analysis and actionable recommendations. Execute the suggested tool calls to carry out the organization.',
    inputSchema: z.object({
      project: z.string().optional().describe('Only organize memories for this project'),
      dry_run: z.boolean().optional().describe('If true, only report what would be done without making changes'),
    }),
  },
  async ({ project, dry_run }) => {
    const stats = store.getHealthStats();
    const memories = store.list(undefined, project);

    // Group memories for analysis
    const grouped: Record<string, typeof memories> = {};
    for (const m of memories) {
      if (!grouped[m.type]) grouped[m.type] = [];
      grouped[m.type].push(m);
    }

    let report = `# Memory Dream — Organization Report\n\n`;
    report += `## Phase 1: Orient\n\n`;
    report += `- Total memories: ${stats.total}\n`;
    report += `- By type: ${Object.entries(stats.byType).map(([k, v]) => `${k}(${v})`).join(', ')}\n`;
    report += `- By status: ${Object.entries(stats.byStatus).map(([k, v]) => `${k}(${v})`).join(', ')}\n`;
    report += `- Pending review: ${stats.pendingReviewCount}\n`;
    report += `- Low confidence (<0.5): ${stats.lowConfidenceCount}\n`;
    report += `- Stale episodes (>30d, no expiry): ${stats.staleEpisodesCount}\n\n`;

    report += `## Phase 2: Gather Signal\n\n`;
    report += `Review the following memories for duplicates, contradictions, and staleness:\n\n`;
    for (const [type, items] of Object.entries(grouped)) {
      report += `### ${type} (${items.length})\n`;
      for (const m of items) {
        report += `- [${m.id}] ${m.content}`;
        if (m.tags.length) report += ` [${m.tags.join(', ')}]`;
        report += ` — confidence: ${m.confidence}, updated: ${m.updated_at}\n`;
      }
      report += '\n';
    }

    report += `## Phase 3: Consolidate\n\n`;
    report += `For each group of near-duplicate or closely related memories, call \`memory_consolidate\` with the IDs and a merged summary.\n\n`;

    report += `## Phase 4: Prune\n\n`;
    report += `Actions to take:\n`;
    report += `- Call \`memory_forget\` on outdated episode memories\n`;
    report += `- Call \`memory_update\` to set \`expires_at\` on episodes older than 30 days\n`;
    report += `- Call \`memory_forget\` on memories with confidence < 0.3 that have never been confirmed\n\n`;

    if (!dry_run) {
      const result = store.autoOrganize(project);
      report += `### Auto-executed safe actions:\n`;
      report += `- Set expires_at on ${result.expiredCount} stale episode(s)\n`;
      report += `- Archived ${result.archivedCount} very low confidence memory(ies)\n`;
    } else {
      report += `_Dry run mode — no changes made. Remove dry_run to execute safe auto-actions._\n`;
    }

    return {
      content: [{ type: 'text' as const, text: report }],
    };
  }
);

// ─── Resource: Memory Context Summary ───
server.registerResource(
  'memory-context',
  'memoryvault://context/summary',
  {
    title: 'Memory Context Summary',
    description: 'Overview of the user\'s memory store including identity, preferences, and active project information',
    mimeType: 'text/markdown',
  },
  async () => {
    const identities = store.list('identity');
    const preferences = store.list('preference');
    const projects = store.list('project');
    const rules = store.list('rule');

    const MAX_PER_TYPE = 10;
    const formatSection = (items: typeof identities, title: string) => {
      if (!items.length) return '';
      const shown = items.slice(0, MAX_PER_TYPE);
      let section = `### ${title}\n`;
      shown.forEach(m => { section += `- ${m.content}\n`; });
      if (items.length > MAX_PER_TYPE) section += `- _...and ${items.length - MAX_PER_TYPE} more_\n`;
      section += '\n';
      return section;
    };

    let md = '## User Memory Context (by MemoryVault)\n\n';
    md += formatSection(identities, 'Identity');
    md += formatSection(preferences, 'Preferences');
    md += formatSection(projects, 'Projects');
    md += formatSection(rules, 'Rules');

    const total = identities.length + preferences.length + projects.length + rules.length;
    md += `_Total: ${total} active memories_\n`;

    return {
      contents: [{ uri: 'memoryvault://context/summary', text: md }],
    };
  }
);

// ─── Resource Template: Project Memories ───
server.registerResource(
  'project-memories',
  new ResourceTemplate('memoryvault://project/{name}', { list: undefined }),
  {
    title: 'Project Memories',
    description: 'All memories associated with a specific project, grouped by type',
    mimeType: 'text/markdown',
  },
  async (uri, { name }) => {
    const memories = store.list(undefined, name as string);

    const grouped: Record<string, typeof memories> = {};
    for (const m of memories) {
      const key = m.type;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(m);
    }

    let md = `## Project: ${name}\n\n`;

    const sections: [string, string][] = [
      ['project', 'Architecture & Decisions'],
      ['preference', 'Preferences'],
      ['rule', 'Rules'],
      ['identity', 'Identity'],
      ['episode', 'Recent Episodes'],
    ];

    for (const [type, heading] of sections) {
      const items = grouped[type];
      if (items?.length) {
        md += `### ${heading}\n`;
        for (const m of items) {
          md += `- ${m.content}`;
          if (m.tags.length) md += ` [${m.tags.join(', ')}]`;
          md += '\n';
        }
        md += '\n';
      }
    }

    if (memories.length === 0) {
      md += '_No memories found for this project._\n';
    }

    return {
      contents: [{ uri: uri.href, text: md }],
    };
  }
);

// ─── Prompt: memory_extract ───
server.registerPrompt(
  'memory_extract',
  {
    title: 'Extract Memories from Conversation',
    description: 'Analyze conversation content and extract information worth remembering long-term. Call at the end of a conversation.',
    argsSchema: {
      conversation: z.string().describe('The conversation content to analyze'),
    },
  },
  async ({ conversation }) => ({
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `You are a memory extraction engine. Analyze the following conversation between a user and an AI, and extract information worth remembering long-term.

Extraction rules:
1. Only extract information that has "cross-session value" — ignore one-off questions
2. Focus on user preferences, habits, corrections, and recurring patterns
3. Focus on project-level architecture decisions and tech stack choices
4. Ignore general knowledge (e.g. "React is a frontend framework")
5. If information is uncertain, set lower confidence (0.5-0.6)

For each extracted memory, call the memory_write tool with these parameters:
- type: identity (user identity) | preference (habits/preferences) | project (project info) | episode (specific event) | rule (explicit rule)
- content: One natural language sentence
- confidence: 0.0-1.0, based on certainty
- tags: Array of relevant tags
- project: Project name if related to a specific project

If there is nothing worth remembering, say "No memories to extract from this conversation."

---

Conversation:

${conversation}`,
        },
      },
    ],
  })
);

// ─── Prompt: memory_review ───
server.registerPrompt(
  'memory_review',
  {
    title: 'Review Recent Memories',
    description: 'Review recently stored memories to confirm, modify, or delete inaccurate entries.',
    argsSchema: {
      days: z.number().optional().describe('Review memories from the last N days, default 7'),
    },
  },
  async ({ days }) => {
    const allMemories = store.list();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (days ?? 7));
    const recent = allMemories.filter(m => new Date(m.created_at) >= cutoff);

    const memoriesList = recent.length > 0
      ? recent.map(m =>
          `- [${m.id}] (${m.type}) ${m.content}${m.tags.length ? ` [${m.tags.join(', ')}]` : ''}${m.project ? ` (project: ${m.project})` : ''} — confidence: ${m.confidence}`
        ).join('\n')
      : '(No recent memories found)';

    return {
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Please review the memories from the last ${days ?? 7} days. For each memory, assess whether it is accurate and suggest keeping, modifying, or deleting it.

To modify, call the memory_update tool.
To delete, call the memory_delete tool.
To soft-delete with a reason, call the memory_forget tool.

Recent memories:

${memoriesList}`,
          },
        },
      ],
    };
  }
);

// ─── Prompt: memory_organize ───
server.registerPrompt(
  'memory_organize',
  {
    title: 'Organize Memories (Dream)',
    description: 'Four-phase memory organization inspired by REM sleep: orient, gather signal, consolidate, prune.',
    argsSchema: {
      project: z.string().optional().describe('Optional project filter'),
    },
  },
  async ({ project }) => {
    const stats = store.getHealthStats();
    const memories = store.list(undefined, project as string | undefined);

    const grouped: Record<string, typeof memories> = {};
    for (const m of memories) {
      if (!grouped[m.type]) grouped[m.type] = [];
      grouped[m.type].push(m);
    }

    let memoriesList = '';
    for (const [type, items] of Object.entries(grouped)) {
      memoriesList += `\n### ${type} (${items.length})\n`;
      for (const m of items) {
        memoriesList += `- [${m.id}] ${m.content}`;
        if (m.tags.length) memoriesList += ` [${m.tags.join(', ')}]`;
        if (m.project) memoriesList += ` (project: ${m.project})`;
        memoriesList += ` — confidence: ${m.confidence}, updated: ${m.updated_at}\n`;
      }
    }

    return {
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `You are a memory organizer running a four-phase "Dream" cycle, inspired by how the brain consolidates memories during REM sleep.

## Health Stats
- Total: ${stats.total} memories
- By type: ${Object.entries(stats.byType).map(([k, v]) => `${k}(${v})`).join(', ')}
- By status: ${Object.entries(stats.byStatus).map(([k, v]) => `${k}(${v})`).join(', ')}
- Pending review: ${stats.pendingReviewCount}
- Low confidence (<0.5): ${stats.lowConfidenceCount}
- Stale episodes (>30d, no expiry): ${stats.staleEpisodesCount}

## Phase 1: Orient
Assess the overall health of the memory store. Note any imbalances (too many episodes vs rules, many pending reviews, etc).

## Phase 2: Gather Signal
Review each memory below and identify:
1. Near-duplicates that should be merged
2. Contradictions that need resolution (keep the newer/more confident one)
3. Stale episodes (>30 days old) that should expire
4. Low-confidence memories that need confirmation or removal

## Phase 3: Consolidate
For each group of related memories, call \`memory_consolidate\` with the IDs and a clear merged summary.
For contradictions, call \`memory_update\` to fix the active one and \`memory_forget\` the outdated one.

## Phase 4: Prune
- Call \`memory_forget\` on outdated episode memories (with reason)
- Call \`memory_update\` with \`expires_at\` on episodes older than 30 days
- Call \`memory_forget\` on memories with confidence < 0.3 that have never been confirmed

---

Active memories:
${memoriesList || '\n_No active memories found._'}`,
          },
        },
      ],
    };
  }
);

// ─── Start ───
if (process.env.NODE_ENV !== 'test') {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MemoryVault MCP Server running on stdio');
}

export { server, store };
