# Phase 1 Remaining Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phase 1 of MemoryVault by adding memory extraction prompts, Claude Code integration setup, and a CLI tool for manual memory management.

**Architecture:** Three independent features built on top of the existing MCP server. (1) MCP Prompts for memory extraction — leverages the MCP protocol's Prompt capability so any MCP client can trigger memory extraction. (2) Claude Code integration — configuration guide + instructions tuning. (3) CLI tool — a standalone `memory-vault` command using the existing `MemoryStore` class directly (not going through MCP).

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `better-sqlite3`, `sqlite-vec`, `commander` (CLI), Vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/index.ts` | **Modify** — Register two new MCP Prompts (`extract` and `review`) |
| `src/cli.ts` | **Create** — CLI entry point using `commander`, delegates to `MemoryStore` |
| `src/cli-commands.ts` | **Create** — Individual CLI command implementations (add, list, search, get, delete, export) |
| `tests/prompts.test.ts` | **Create** — Tests for the MCP Prompt registration and response format |
| `tests/cli.test.ts` | **Create** — Tests for CLI command logic |
| `package.json` | **Modify** — Add `commander` dependency, add `cli` bin entry |
| `docs/claude-code-setup.md` | **Create** — Integration guide for Claude Code users |

---

### Task 1: Add MCP Prompt — `memory_extract`

**Files:**
- Modify: `src/index.ts` (add prompt registration after line 202)
- Test: `tests/prompts.test.ts`

This prompt provides a structured template that AI clients call at the end of a conversation to extract memories. It takes conversation text as input and returns a system prompt that instructs the AI to analyze the conversation and call `memory_write` for each extracted memory.

- [ ] **Step 1: Write the failing test for `memory_extract` prompt**

Create `tests/prompts.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('MCP Prompts', () => {
  describe('memory_extract', () => {
    it('should be registered and return extraction instructions', async () => {
      const mod = await import('../src/index.js');
      const server = mod.server as any;

      // Verify the prompt is registered by checking _prompts map
      const prompts = server._prompts;
      expect(prompts).toBeDefined();
      expect(prompts.has('memory_extract')).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/jamesyu/Projects/memory-vault && pnpm test -- tests/prompts.test.ts`
Expected: FAIL — `_prompts` does not have `memory_extract`

- [ ] **Step 3: Register the `memory_extract` prompt in `src/index.ts`**

Add the following after the Resource registration block (after line 202), before the server startup block:

```typescript
// ─── Prompt: memory_extract (记忆提炼) ───
server.registerPrompt(
  'memory_extract',
  {
    title: 'Extract Memories from Conversation',
    description: '分析对话内容，提取值得长期记住的用户信息。在对话结束时调用。',
    argsSchema: z.object({
      conversation: z.string().describe('要分析的对话内容'),
    }),
  },
  async ({ conversation }) => ({
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `你是一个记忆提炼引擎。分析以下用户与 AI 的对话记录，提取值得长期记住的信息。

提取规则：
1. 只提取"跨会话有价值"的信息，忽略一次性的具体问题
2. 关注用户的偏好、习惯、纠正行为和反复出现的模式
3. 关注项目层面的架构决策和技术选型
4. 忽略通用知识（如"React 是一个前端框架"）
5. 如果信息不确定，设置较低的 confidence（0.5-0.6）

对于每一条提取的记忆，请调用 memory_write 工具写入，参数说明：
- type: identity（用户身份）| preference（偏好习惯）| project（项目信息）| episode（具体事件）| rule（明确规则）
- content: 一句自然语言描述
- confidence: 0.0-1.0，根据信息确定程度设置
- tags: 相关标签数组
- project: 如果与特定项目相关，填写项目名

如果对话中没有值得记忆的信息，请说明"本次对话无需提取记忆"。

---

以下是对话内容：

${conversation}`,
        },
      },
    ],
  })
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/jamesyu/Projects/memory-vault && pnpm test -- tests/prompts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/jamesyu/Projects/memory-vault
git add src/index.ts tests/prompts.test.ts
git commit -m "feat: add memory_extract MCP prompt for conversation analysis"
```

---

### Task 2: Add MCP Prompt — `memory_review`

**Files:**
- Modify: `src/index.ts` (add after the `memory_extract` prompt)
- Modify: `tests/prompts.test.ts` (add test)

This prompt lets users review recent memories. It fetches the latest memories from the store and presents them for review.

- [ ] **Step 1: Write the failing test**

Add to `tests/prompts.test.ts`:

```typescript
describe('memory_review', () => {
  it('should be registered and return review instructions', async () => {
    const mod = await import('../src/index.js');
    const server = mod.server as any;

    const prompts = server._prompts;
    expect(prompts.has('memory_review')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/jamesyu/Projects/memory-vault && pnpm test -- tests/prompts.test.ts`
Expected: FAIL — `memory_review` not registered

- [ ] **Step 3: Register the `memory_review` prompt**

Add to `src/index.ts` after the `memory_extract` prompt:

```typescript
// ─── Prompt: memory_review (记忆审阅) ───
server.registerPrompt(
  'memory_review',
  {
    title: 'Review Recent Memories',
    description: '审阅最近存储的记忆，确认、修改或删除不准确的条目。',
    argsSchema: z.object({
      days: z.number().optional().describe('审阅最近多少天的记忆，默认 7 天'),
    }),
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
      : '（最近没有新增记忆）';

    return {
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `请帮我审阅最近 ${days ?? 7} 天的记忆。对于每条记忆，请判断是否准确，并建议保留、修改或删除。

如需修改，请调用 memory_update 工具。
如需删除，请调用 memory_delete 工具。

以下是最近的记忆条目：

${memoriesList}`,
          },
        },
      ],
    };
  }
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/jamesyu/Projects/memory-vault && pnpm test -- tests/prompts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/jamesyu/Projects/memory-vault
git add src/index.ts tests/prompts.test.ts
git commit -m "feat: add memory_review MCP prompt for memory auditing"
```

---

### Task 3: Install `commander` and add CLI entry point

**Files:**
- Modify: `package.json` (add `commander` dep, update `bin`)
- Create: `src/cli.ts`
- Create: `src/cli-commands.ts`

- [ ] **Step 1: Install commander**

```bash
cd /Users/jamesyu/Projects/memory-vault && pnpm add commander
```

- [ ] **Step 2: Create `src/cli-commands.ts` with the `add` command**

```typescript
import { MemoryStore } from './memory-store.js';
import type { MemoryType } from './types.js';

const DB_PATH = process.env.MEMORY_DB_PATH ?? './data/memory.db';

let _store: MemoryStore | null = null;
function getStore(): MemoryStore {
  if (!_store) _store = new MemoryStore(DB_PATH);
  return _store;
}

export async function addMemory(content: string, opts: { type: string; tags?: string; project?: string; confidence?: string }) {
  const store = getStore();
  const memory = await store.write({
    content,
    type: opts.type as MemoryType,
    tags: opts.tags ? opts.tags.split(',').map(t => t.trim()) : undefined,
    project: opts.project,
    confidence: opts.confidence ? parseFloat(opts.confidence) : undefined,
    source_tool: 'cli',
  });
  console.log(`✓ Memory created: ${memory.id}`);
  console.log(`  Type: ${memory.type}`);
  console.log(`  Content: ${memory.content}`);
  if (memory.tags.length) console.log(`  Tags: ${memory.tags.join(', ')}`);
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

export function exportMemories(opts: { format?: string }) {
  const store = getStore();
  if (opts.format === 'markdown') {
    console.log(store.exportMarkdown());
  } else {
    const all = store.export();
    console.log(JSON.stringify(all, null, 2));
  }
}
```

- [ ] **Step 3: Create `src/cli.ts`**

```typescript
#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import {
  addMemory,
  searchMemories,
  listMemories,
  getMemory,
  deleteMemory,
  exportMemories,
} from './cli-commands.js';

const program = new Command();

program
  .name('memory-vault')
  .description('MemoryVault CLI — manage your AI memories')
  .version('0.1.0');

program
  .command('add <content>')
  .description('Add a new memory')
  .requiredOption('-t, --type <type>', 'Memory type: identity | preference | project | episode | rule')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--project <project>', 'Associated project name')
  .option('--confidence <confidence>', 'Confidence 0-1')
  .action(addMemory);

program
  .command('search <query>')
  .description('Semantic search for memories')
  .option('-t, --type <type>', 'Filter by type')
  .option('--project <project>', 'Filter by project')
  .option('-l, --limit <limit>', 'Max results (default: 10)')
  .action(searchMemories);

program
  .command('list')
  .description('List all active memories')
  .option('-t, --type <type>', 'Filter by type')
  .option('--project <project>', 'Filter by project')
  .action(listMemories);

program
  .command('get <id>')
  .description('Get a specific memory by ID')
  .action(getMemory);

program
  .command('delete <id>')
  .description('Delete a memory by ID')
  .action(deleteMemory);

program
  .command('export')
  .description('Export all memories')
  .option('-f, --format <format>', 'Output format: json | markdown (default: json)')
  .action(exportMemories);

program.parse();
```

- [ ] **Step 4: Update `package.json` bin field**

Add `"memory-vault-cli"` to the `bin` field so both the MCP server and CLI are available:

```json
"bin": {
  "memory-vault": "./build/index.js",
  "memory-vault-cli": "./build/cli.js"
}
```

- [ ] **Step 5: Build and verify CLI loads**

```bash
cd /Users/jamesyu/Projects/memory-vault && pnpm build && node build/cli.js --help
```

Expected: Shows help text with `add`, `search`, `list`, `get`, `delete`, `export` commands.

- [ ] **Step 6: Commit**

```bash
cd /Users/jamesyu/Projects/memory-vault
git add src/cli.ts src/cli-commands.ts package.json
git commit -m "feat: add CLI tool for manual memory management"
```

---

### Task 4: Write CLI tests

**Files:**
- Create: `tests/cli.test.ts`

- [ ] **Step 1: Write tests for CLI commands**

Create `tests/cli.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase } from '../src/db.js';
import fs from 'node:fs';

// Mock embedding
vi.mock('../src/embedding.js', () => ({
  getEmbedding: vi.fn().mockImplementation(async (text: string) => {
    const vec = new Array(768).fill(0);
    for (let i = 0; i < text.length && i < 768; i++) {
      vec[i] = text.charCodeAt(i) / 255;
    }
    return vec;
  }),
}));

const TEST_DB = './data/test-cli.db';

describe('CLI commands', () => {
  beforeEach(() => {
    process.env.MEMORY_DB_PATH = TEST_DB;
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    delete process.env.MEMORY_DB_PATH;
    // Clear module cache so the store re-initializes with the new env
    vi.resetModules();
  });

  it('should add and list a memory', async () => {
    const { addMemory, listMemories } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await addMemory('I prefer TypeScript', { type: 'preference' });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Memory created'));

    logSpy.mockClear();
    listMemories({});
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('I prefer TypeScript'));

    logSpy.mockRestore();
  });

  it('should get a memory by id', async () => {
    const { addMemory, getMemory } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await addMemory('test memory for get', { type: 'identity' });

    // Extract the ID from the first log call
    const createCall = logSpy.mock.calls[0][0] as string;
    const id = createCall.replace('✓ Memory created: ', '');

    logSpy.mockClear();
    getMemory(id);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('test memory for get'));

    logSpy.mockRestore();
  });

  it('should delete a memory', async () => {
    const { addMemory, deleteMemory, getMemory } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await addMemory('to delete', { type: 'episode' });
    const createCall = logSpy.mock.calls[0][0] as string;
    const id = createCall.replace('✓ Memory created: ', '');

    deleteMemory(id);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Memory deleted'));

    expect(() => getMemory(id)).toThrow('exit');

    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('should export as JSON', async () => {
    const { addMemory, exportMemories } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await addMemory('export test', { type: 'identity' });
    logSpy.mockClear();

    exportMemories({});
    const output = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].content).toBe('export test');

    logSpy.mockRestore();
  });

  it('should export as markdown', async () => {
    const { addMemory, exportMemories } = await import('../src/cli-commands.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await addMemory('md export test', { type: 'preference' });
    logSpy.mockClear();

    exportMemories({ format: 'markdown' });
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('# MemoryVault Export');
    expect(output).toContain('md export test');

    logSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /Users/jamesyu/Projects/memory-vault && pnpm test -- tests/cli.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/jamesyu/Projects/memory-vault && pnpm test`
Expected: All tests PASS (existing 16 + new prompt tests + new CLI tests)

- [ ] **Step 4: Commit**

```bash
cd /Users/jamesyu/Projects/memory-vault
git add tests/cli.test.ts
git commit -m "test: add CLI command tests"
```

---

### Task 5: Claude Code integration guide and instructions tuning

**Files:**
- Create: `docs/claude-code-setup.md`
- Modify: `src/index.ts` (refine server instructions for better auto-extraction behavior)

- [ ] **Step 1: Create Claude Code setup guide**

Create `docs/claude-code-setup.md`:

```markdown
# MemoryVault — Claude Code Integration Guide

## Prerequisites

1. **Ollama running locally** with `nomic-embed-text` model:
   ```bash
   ollama pull nomic-embed-text
   ollama serve  # if not already running
   ```

2. **MemoryVault built**:
   ```bash
   cd /path/to/memory-vault
   pnpm install && pnpm build
   ```

## Add MemoryVault to Claude Code

```bash
claude mcp add memory-vault -- node /absolute/path/to/memory-vault/build/index.js
```

Or with a custom database path:
```bash
claude mcp add memory-vault -e MEMORY_DB_PATH=/path/to/your/memory.db -- node /absolute/path/to/memory-vault/build/index.js
```

## Verify

Start a Claude Code session and try:
- Ask Claude to remember something: "Remember that I prefer functional programming style"
- Ask Claude to recall: "What do you know about my preferences?"

Claude should automatically call `memory_write` and `memory_search` based on the server instructions.

## CLI Usage

```bash
# Add a memory manually
memory-vault-cli add "I'm a full-stack developer" -t identity

# Search memories
memory-vault-cli search "programming preferences"

# List all memories
memory-vault-cli list

# Export as markdown
memory-vault-cli export -f markdown
```

## Tips

- Use the `memory_extract` prompt at the end of productive sessions to capture key learnings
- Periodically run `memory_review` prompt to audit and clean up your memory store
- The CLI is useful for bulk operations and scripting
```

- [ ] **Step 2: Refine server instructions in `src/index.ts`**

Update the `instructions` field in the McpServer constructor (line 17) to be more specific about when to write and search:

```typescript
instructions: `MemoryVault: 用户的个人 AI 记忆库。

自动写入规则：
- 当用户透露个人偏好、工作习惯或编程风格时，调用 memory_write（type: preference）
- 当用户介绍自己的身份或背景时，调用 memory_write（type: identity）
- 当用户讨论项目架构、技术选型时，调用 memory_write（type: project）
- 当用户明确要求"记住这个"或"以后都这样做"时，调用 memory_write（type: rule）
- 写入前先用 memory_search 检查是否已有类似记忆，避免重复

自动搜索规则：
- 在回答用户问题前，如果问题涉及用户偏好或项目背景，先调用 memory_search
- 当用户问"你知道我..."或"之前说过..."时，调用 memory_search`,
```

- [ ] **Step 3: Build to verify no TypeScript errors**

```bash
cd /Users/jamesyu/Projects/memory-vault && pnpm build
```
Expected: Build succeeds

- [ ] **Step 4: Run full test suite**

```bash
cd /Users/jamesyu/Projects/memory-vault && pnpm test
```
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/jamesyu/Projects/memory-vault
git add docs/claude-code-setup.md src/index.ts
git commit -m "feat: add Claude Code integration guide and refine server instructions"
```

---

### Task 6: Final build and end-to-end verification

**Files:**
- No new files — verification only

- [ ] **Step 1: Clean build**

```bash
cd /Users/jamesyu/Projects/memory-vault && rm -rf build && pnpm build
```
Expected: Build succeeds, `build/index.js`, `build/cli.js`, `build/cli-commands.js` all exist

- [ ] **Step 2: Run full test suite**

```bash
cd /Users/jamesyu/Projects/memory-vault && pnpm test
```
Expected: All tests PASS

- [ ] **Step 3: Verify CLI works end-to-end**

```bash
cd /Users/jamesyu/Projects/memory-vault
node build/cli.js add "I prefer TypeScript over JavaScript" -t preference --tags "language,typescript"
node build/cli.js list
node build/cli.js search "programming language"
node build/cli.js export -f markdown
```

Expected: Each command outputs expected results. (Requires Ollama running for `add` and `search`.)

- [ ] **Step 4: Verify MCP server starts correctly**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}}}' | node build/index.js 2>/dev/null | head -1
```

Expected: JSON response with server capabilities including `prompts`

- [ ] **Step 5: Final commit if any fixups needed**

Only if previous steps revealed issues that needed fixing.
