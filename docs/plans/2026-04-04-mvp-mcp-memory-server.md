# MemoryVault MVP: MCP Memory Server 实现方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个基于 MCP 协议的本地记忆服务器，支持记忆的写入、语义搜索和管理，可接入 Claude Desktop / Cursor 等任意 MCP 客户端。

**Architecture:** TypeScript MCP Server（stdio 传输），使用 better-sqlite3 存储记忆元数据，sqlite-vec 扩展实现向量语义检索，OpenAI text-embedding-3-small 生成向量嵌入。本地优先，单文件数据库，零外部服务依赖（除 OpenAI Embedding API）。

**Tech Stack:** TypeScript, @modelcontextprotocol/server, better-sqlite3, sqlite-vec, OpenAI API, Zod v4, tsx

---

## 文件结构

```
memory-vault/
├── package.json
├── tsconfig.json
├── .env.example              # OPENAI_API_KEY=sk-xxx
├── .gitignore
├── docs/
│   └── plans/
│       └── 2026-04-04-mvp-mcp-memory-server.md  # 本文件
├── src/
│   ├── index.ts              # 入口：创建 McpServer，注册 tools/resources，启动 stdio
│   ├── db.ts                 # 数据库初始化、schema 创建、sqlite-vec 加载
│   ├── embedding.ts          # OpenAI embedding API 封装
│   ├── memory-store.ts       # 记忆 CRUD + 向量搜索（核心业务逻辑）
│   └── types.ts              # MemoryEntry 等类型定义
├── tests/
│   ├── db.test.ts
│   ├── embedding.test.ts
│   ├── memory-store.test.ts
│   └── integration.test.ts   # MCP 端到端集成测试
└── data/                     # .gitignore，运行时生成
    └── memory.db             # SQLite 数据库文件
```

**职责划分：**
- `types.ts` — 纯类型，零依赖
- `db.ts` — 数据库连接和 schema，不含业务逻辑
- `embedding.ts` — 只负责文本→向量，不知道数据库的存在
- `memory-store.ts` — 组合 db + embedding，提供业务方法
- `index.ts` — 组合 memory-store，注册为 MCP tools/resources

---

## Task 1: 项目初始化

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: 创建项目目录并初始化 git**

```bash
mkdir -p ~/Projects/memory-vault
cd ~/Projects/memory-vault
git init
```

- [ ] **Step 2: 创建 package.json**

```json
{
  "name": "memory-vault",
  "version": "0.1.0",
  "description": "MCP Memory Server - Your AI memory belongs to you",
  "type": "module",
  "bin": {
    "memory-vault": "./build/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^1.29.0",
    "better-sqlite3": "^11.0.0",
    "sqlite-vec": "^0.1.0",
    "openai": "^4.80.0",
    "zod": "^3.25.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.8.0",
    "vitest": "^3.0.0",
    "tsx": "^4.19.0"
  }
}
```

- [ ] **Step 3: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "build", "tests"]
}
```

- [ ] **Step 4: 创建 .gitignore**

```
node_modules/
build/
data/
.env
*.db
```

- [ ] **Step 5: 创建 .env.example**

```
OPENAI_API_KEY=sk-your-key-here
MEMORY_DB_PATH=./data/memory.db
```

- [ ] **Step 6: 安装依赖**

```bash
cd ~/Projects/memory-vault
pnpm install
```

Expected: 所有依赖安装成功，无报错。

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore .env.example pnpm-lock.yaml
git commit -m "chore: init project with dependencies"
```

---

## Task 2: 类型定义

**Files:**
- Create: `src/types.ts`
- Test: `tests/types.test.ts`（编译检查即可）

- [ ] **Step 1: 编写类型定义**

```typescript
// src/types.ts

export type MemoryType = 'identity' | 'preference' | 'project' | 'episode' | 'rule';
export type MemoryStatus = 'active' | 'archived' | 'pending_review';

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  tags: string[];
  project?: string;
  confidence: number;
  source_tool?: string;
  source_excerpt?: string;
  status: MemoryStatus;
  created_at: string;
  updated_at: string;
}

export interface MemorySearchResult extends MemoryEntry {
  distance: number;
}

export interface CreateMemoryInput {
  content: string;
  type: MemoryType;
  tags?: string[];
  project?: string;
  confidence?: number;
  source_tool?: string;
  source_excerpt?: string;
}

export interface SearchMemoryInput {
  query: string;
  type?: MemoryType;
  project?: string;
  limit?: number;
}

export interface UpdateMemoryInput {
  id: string;
  content?: string;
  type?: MemoryType;
  tags?: string[];
  project?: string;
  confidence?: number;
  status?: MemoryStatus;
}
```

- [ ] **Step 2: 验证 TypeScript 编译通过**

```bash
cd ~/Projects/memory-vault
npx tsc --noEmit
```

Expected: 无错误输出。

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add memory entry type definitions"
```

---

## Task 3: 数据库层

**Files:**
- Create: `src/db.ts`
- Test: `tests/db.test.ts`

- [ ] **Step 1: 编写 db.test.ts 测试**

```typescript
// tests/db.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { createDatabase, closeDatabase } from '../src/db.js';
import fs from 'node:fs';

const TEST_DB = './data/test-db.db';

afterEach(() => {
  closeDatabase();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

describe('createDatabase', () => {
  it('should create database with memories table', () => {
    const db = createDatabase(TEST_DB);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"
    ).get() as { name: string } | undefined;
    expect(tables?.name).toBe('memories');
  });

  it('should create vec_memories virtual table', () => {
    const db = createDatabase(TEST_DB);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_memories'"
    ).get() as { name: string } | undefined;
    expect(tables?.name).toBe('vec_memories');
  });

  it('should load sqlite-vec extension', () => {
    const db = createDatabase(TEST_DB);
    const result = db.prepare('SELECT vec_version() as version').get() as { version: string };
    expect(result.version).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/Projects/memory-vault
pnpm test -- tests/db.test.ts
```

Expected: FAIL — `createDatabase` 不存在。

- [ ] **Step 3: 实现 db.ts**

```typescript
// src/db.ts
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';

const EMBEDDING_DIMENSIONS = 1536; // OpenAI text-embedding-3-small

let _db: Database.Database | null = null;

export function createDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  sqliteVec.load(db);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('identity','preference','project','episode','rule')),
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      project TEXT,
      confidence REAL NOT NULL DEFAULT 0.8,
      source_tool TEXT,
      source_excerpt TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','pending_review')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories
    USING vec0(embedding float[${EMBEDDING_DIMENSIONS}])
  `);

  _db = db;
  return db;
}

export function getDatabase(): Database.Database {
  if (!_db) throw new Error('Database not initialized. Call createDatabase() first.');
  return _db;
}

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm test -- tests/db.test.ts
```

Expected: 3 tests PASS。

- [ ] **Step 5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat: database layer with sqlite-vec support"
```

---

## Task 4: Embedding 封装

**Files:**
- Create: `src/embedding.ts`
- Test: `tests/embedding.test.ts`

- [ ] **Step 1: 编写 embedding.test.ts**

```typescript
// tests/embedding.test.ts
import { describe, it, expect, vi } from 'vitest';
import { getEmbedding } from '../src/embedding.js';

// Mock OpenAI to avoid real API calls in tests
vi.mock('openai', () => {
  return {
    default: class {
      embeddings = {
        create: vi.fn().mockResolvedValue({
          data: [{ embedding: new Array(1536).fill(0.1) }],
        }),
      };
    },
  };
});

describe('getEmbedding', () => {
  it('should return a 1536-dimension float array', async () => {
    const result = await getEmbedding('hello world');
    expect(result).toHaveLength(1536);
    expect(typeof result[0]).toBe('number');
  });

  it('should throw on empty input', async () => {
    await expect(getEmbedding('')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test -- tests/embedding.test.ts
```

Expected: FAIL — `getEmbedding` 不存在。

- [ ] **Step 3: 实现 embedding.ts**

```typescript
// src/embedding.ts
import OpenAI from 'openai';

const MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

export async function getEmbedding(text: string): Promise<number[]> {
  if (!text.trim()) throw new Error('Cannot embed empty text');

  const response = await getClient().embeddings.create({
    model: MODEL,
    input: text,
    dimensions: DIMENSIONS,
  });

  return response.data[0].embedding;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm test -- tests/embedding.test.ts
```

Expected: 2 tests PASS。

- [ ] **Step 5: Commit**

```bash
git add src/embedding.ts tests/embedding.test.ts
git commit -m "feat: OpenAI embedding wrapper"
```

---

## Task 5: 记忆存储核心逻辑

**Files:**
- Create: `src/memory-store.ts`
- Test: `tests/memory-store.test.ts`

- [ ] **Step 1: 编写 memory-store.test.ts（写入 + 搜索）**

```typescript
// tests/memory-store.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { closeDatabase } from '../src/db.js';
import fs from 'node:fs';

// Mock embedding: 返回基于内容 hash 的伪向量，使不同内容产生不同向量
vi.mock('../src/embedding.js', () => ({
  getEmbedding: vi.fn().mockImplementation(async (text: string) => {
    const vec = new Array(1536).fill(0);
    for (let i = 0; i < text.length && i < 1536; i++) {
      vec[i] = text.charCodeAt(i) / 255;
    }
    return vec;
  }),
}));

const TEST_DB = './data/test-store.db';

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(TEST_DB);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  describe('write', () => {
    it('should create a memory and return it with an id', async () => {
      const memory = await store.write({
        content: 'User prefers TypeScript over JavaScript',
        type: 'preference',
        tags: ['language', 'typescript'],
      });
      expect(memory.id).toBeTruthy();
      expect(memory.content).toBe('User prefers TypeScript over JavaScript');
      expect(memory.type).toBe('preference');
      expect(memory.tags).toEqual(['language', 'typescript']);
    });
  });

  describe('search', () => {
    it('should return relevant memories by semantic search', async () => {
      await store.write({ content: 'User prefers TypeScript', type: 'preference' });
      await store.write({ content: 'Project uses Next.js', type: 'project' });

      const results = await store.search({ query: 'TypeScript', limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('TypeScript');
    });

    it('should filter by type', async () => {
      await store.write({ content: 'User prefers TypeScript', type: 'preference' });
      await store.write({ content: 'Project uses TypeScript', type: 'project' });

      const results = await store.search({ query: 'TypeScript', type: 'preference' });
      expect(results.every(r => r.type === 'preference')).toBe(true);
    });
  });

  describe('get', () => {
    it('should retrieve a memory by id', async () => {
      const created = await store.write({ content: 'test memory', type: 'identity' });
      const found = store.get(created.id);
      expect(found?.content).toBe('test memory');
    });

    it('should return null for non-existent id', () => {
      expect(store.get('non-existent')).toBeNull();
    });
  });

  describe('update', () => {
    it('should update memory content and re-embed', async () => {
      const created = await store.write({ content: 'old content', type: 'preference' });
      const updated = await store.update({ id: created.id, content: 'new content' });
      expect(updated.content).toBe('new content');
      expect(updated.updated_at).not.toBe(created.updated_at);
    });
  });

  describe('delete', () => {
    it('should remove a memory', async () => {
      const created = await store.write({ content: 'to delete', type: 'episode' });
      store.delete(created.id);
      expect(store.get(created.id)).toBeNull();
    });
  });

  describe('list', () => {
    it('should list all active memories', async () => {
      await store.write({ content: 'memory 1', type: 'identity' });
      await store.write({ content: 'memory 2', type: 'preference' });
      const all = store.list();
      expect(all).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test -- tests/memory-store.test.ts
```

Expected: FAIL — `MemoryStore` 不存在。

- [ ] **Step 3: 实现 memory-store.ts**

```typescript
// src/memory-store.ts
import { randomUUID } from 'node:crypto';
import { createDatabase, getDatabase } from './db.js';
import { getEmbedding } from './embedding.js';
import type {
  MemoryEntry,
  MemorySearchResult,
  CreateMemoryInput,
  SearchMemoryInput,
  UpdateMemoryInput,
} from './types.js';

export class MemoryStore {
  constructor(dbPath: string) {
    createDatabase(dbPath);
  }

  async write(input: CreateMemoryInput): Promise<MemoryEntry> {
    const db = getDatabase();
    const id = randomUUID();
    const now = new Date().toISOString();
    const tags = JSON.stringify(input.tags ?? []);

    const embedding = await getEmbedding(input.content);
    const vecBuffer = Buffer.from(new Float32Array(embedding).buffer);

    db.prepare(`
      INSERT INTO memories (id, type, content, tags, project, confidence, source_tool, source_excerpt, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(id, input.type, input.content, tags, input.project ?? null,
           input.confidence ?? 0.8, input.source_tool ?? null,
           input.source_excerpt ?? null, now, now);

    // vec_memories 的 rowid 需要是整数，用 memories 表的 rowid
    const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number };
    db.prepare('INSERT INTO vec_memories (rowid, embedding) VALUES (?, ?)').run(row.rowid, vecBuffer);

    return this.get(id)!;
  }

  async search(input: SearchMemoryInput): Promise<MemorySearchResult[]> {
    const db = getDatabase();
    const limit = input.limit ?? 10;

    const queryEmbedding = await getEmbedding(input.query);
    const vecBuffer = Buffer.from(new Float32Array(queryEmbedding).buffer);

    let sql = `
      SELECT m.*, v.distance
      FROM vec_memories v
      INNER JOIN memories m ON m.rowid = v.rowid
      WHERE v.embedding MATCH ?
        AND m.status = 'active'
    `;
    const params: unknown[] = [vecBuffer];

    if (input.type) {
      sql += ' AND m.type = ?';
      params.push(input.type);
    }
    if (input.project) {
      sql += ' AND m.project = ?';
      params.push(input.project);
    }

    sql += ' ORDER BY v.distance LIMIT ?';
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as (MemoryEntry & { distance: number; tags: string })[];

    return rows.map(row => ({
      ...row,
      tags: JSON.parse(row.tags as string),
      distance: row.distance,
    }));
  }

  get(id: string): MemoryEntry | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as (MemoryEntry & { tags: string }) | undefined;
    if (!row) return null;
    return { ...row, tags: JSON.parse(row.tags as string) };
  }

  async update(input: UpdateMemoryInput): Promise<MemoryEntry> {
    const db = getDatabase();
    const existing = this.get(input.id);
    if (!existing) throw new Error(`Memory not found: ${input.id}`);

    const now = new Date().toISOString();
    const updates: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (input.content !== undefined) {
      updates.push('content = ?');
      params.push(input.content);
    }
    if (input.type !== undefined) {
      updates.push('type = ?');
      params.push(input.type);
    }
    if (input.tags !== undefined) {
      updates.push('tags = ?');
      params.push(JSON.stringify(input.tags));
    }
    if (input.project !== undefined) {
      updates.push('project = ?');
      params.push(input.project);
    }
    if (input.confidence !== undefined) {
      updates.push('confidence = ?');
      params.push(input.confidence);
    }
    if (input.status !== undefined) {
      updates.push('status = ?');
      params.push(input.status);
    }

    params.push(input.id);
    db.prepare(`UPDATE memories SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    // 如果 content 变了，重新生成向量
    if (input.content !== undefined) {
      const embedding = await getEmbedding(input.content);
      const vecBuffer = Buffer.from(new Float32Array(embedding).buffer);
      const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(input.id) as { rowid: number };
      db.prepare('DELETE FROM vec_memories WHERE rowid = ?').run(row.rowid);
      db.prepare('INSERT INTO vec_memories (rowid, embedding) VALUES (?, ?)').run(row.rowid, vecBuffer);
    }

    return this.get(input.id)!;
  }

  delete(id: string): void {
    const db = getDatabase();
    const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number } | undefined;
    if (row) {
      db.prepare('DELETE FROM vec_memories WHERE rowid = ?').run(row.rowid);
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    }
  }

  list(type?: string, project?: string): MemoryEntry[] {
    const db = getDatabase();
    let sql = "SELECT * FROM memories WHERE status = 'active'";
    const params: unknown[] = [];

    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (project) { sql += ' AND project = ?'; params.push(project); }

    sql += ' ORDER BY updated_at DESC';

    const rows = db.prepare(sql).all(...params) as (MemoryEntry & { tags: string })[];
    return rows.map(row => ({ ...row, tags: JSON.parse(row.tags as string) }));
  }

  export(): MemoryEntry[] {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM memories ORDER BY created_at').all() as (MemoryEntry & { tags: string })[];
    return rows.map(row => ({ ...row, tags: JSON.parse(row.tags as string) }));
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm test -- tests/memory-store.test.ts
```

Expected: 7 tests PASS。

- [ ] **Step 5: Commit**

```bash
git add src/memory-store.ts tests/memory-store.test.ts
git commit -m "feat: memory store with CRUD and vector search"
```

---

## Task 6: MCP Server 入口 — 注册 Tools

**Files:**
- Create: `src/index.ts`
- Test: `tests/integration.test.ts`

- [ ] **Step 1: 编写集成测试**

```typescript
// tests/integration.test.ts
import { describe, it, expect, vi } from 'vitest';

// 这里只验证 MCP tools 的注册逻辑是否正确
// 完整的 MCP 端到端测试需要 stdio transport，留到手动验证
describe('MCP Server tools', () => {
  it('should be importable without errors', async () => {
    // 验证模块可以正常加载（不启动 stdio）
    const mod = await import('../src/index.js');
    expect(mod).toBeDefined();
  });
});
```

- [ ] **Step 2: 实现 index.ts**

```typescript
#!/usr/bin/env node
// src/index.ts
import 'dotenv/config';
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { MemoryStore } from './memory-store.js';
import type { MemoryType, MemoryStatus } from './types.js';

const DB_PATH = process.env.MEMORY_DB_PATH ?? './data/memory.db';
const store = new MemoryStore(DB_PATH);

const server = new McpServer(
  {
    name: 'memory-vault',
    version: '0.1.0',
  },
  {
    instructions: 'MemoryVault: 用户的个人 AI 记忆库。在对话中观察到用户的偏好、习惯、项目背景等有价值的信息时，主动调用 memory_write 存储。在回答问题前，调用 memory_search 检索相关上下文。',
  }
);

// ─── Tool: memory_write ───
server.registerTool(
  'memory_write',
  {
    title: 'Write Memory',
    description: '将一条记忆写入用户的记忆库。当你观察到用户的偏好、习惯、项目背景、技术选型等值得长期记住的信息时调用。',
    inputSchema: z.object({
      content: z.string().describe('记忆内容，用一句自然语言描述'),
      type: z.enum(['identity', 'preference', 'project', 'episode', 'rule']).describe(
        'identity=用户身份, preference=偏好习惯, project=项目信息, episode=具体事件, rule=明确规则'
      ),
      tags: z.array(z.string()).optional().describe('标签，如 ["typescript", "frontend"]'),
      project: z.string().optional().describe('关联的项目名'),
      confidence: z.number().min(0).max(1).optional().describe('置信度 0-1，默认 0.8'),
      source_tool: z.string().optional().describe('来源工具，如 "claude-desktop", "cursor"'),
    }),
  },
  async (input) => {
    const memory = await store.write(input);
    return {
      content: [{ type: 'text', text: JSON.stringify(memory, null, 2) }],
    };
  }
);

// ─── Tool: memory_search ───
server.registerTool(
  'memory_search',
  {
    title: 'Search Memory',
    description: '语义搜索用户的记忆库。在回答用户问题前调用，获取相关的历史上下文、偏好和项目信息。',
    inputSchema: z.object({
      query: z.string().describe('搜索查询，自然语言'),
      type: z.enum(['identity', 'preference', 'project', 'episode', 'rule']).optional().describe('限定记忆类型'),
      project: z.string().optional().describe('限定项目'),
      limit: z.number().min(1).max(50).optional().describe('返回数量，默认 10'),
    }),
  },
  async (input) => {
    const results = await store.search(input);
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  }
);

// ─── Tool: memory_list ───
server.registerTool(
  'memory_list',
  {
    title: 'List Memories',
    description: '列出用户的所有活跃记忆，可按类型和项目筛选。',
    inputSchema: z.object({
      type: z.enum(['identity', 'preference', 'project', 'episode', 'rule']).optional(),
      project: z.string().optional(),
    }),
  },
  async (input) => {
    const memories = store.list(input.type, input.project);
    return {
      content: [{ type: 'text', text: JSON.stringify(memories, null, 2) }],
    };
  }
);

// ─── Tool: memory_delete ───
server.registerTool(
  'memory_delete',
  {
    title: 'Delete Memory',
    description: '删除一条记忆。当用户明确要求遗忘某条信息时调用。',
    inputSchema: z.object({
      id: z.string().describe('要删除的记忆 ID'),
    }),
  },
  async ({ id }) => {
    store.delete(id);
    return {
      content: [{ type: 'text', text: `Memory ${id} deleted.` }],
    };
  }
);

// ─── Tool: memory_update ───
server.registerTool(
  'memory_update',
  {
    title: 'Update Memory',
    description: '更新一条已有的记忆。当用户的偏好或项目信息发生变化时调用。',
    inputSchema: z.object({
      id: z.string().describe('记忆 ID'),
      content: z.string().optional().describe('新的记忆内容'),
      type: z.enum(['identity', 'preference', 'project', 'episode', 'rule']).optional(),
      tags: z.array(z.string()).optional(),
      project: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      status: z.enum(['active', 'archived', 'pending_review']).optional(),
    }),
  },
  async (input) => {
    const memory = await store.update(input);
    return {
      content: [{ type: 'text', text: JSON.stringify(memory, null, 2) }],
    };
  }
);

// ─── Tool: memory_export ───
server.registerTool(
  'memory_export',
  {
    title: 'Export All Memories',
    description: '导出用户的全部记忆数据（JSON 格式）。用于备份或迁移。',
    inputSchema: z.object({}),
  },
  async () => {
    const all = store.export();
    return {
      content: [{ type: 'text', text: JSON.stringify(all, null, 2) }],
    };
  }
);

// ─── Resource: 当前记忆上下文 ───
server.registerResource(
  'memory-context',
  'memoryvault://context/summary',
  {
    title: 'Memory Context Summary',
    description: '用户记忆库的概览摘要，包含身份、偏好和活跃项目信息',
    mimeType: 'text/markdown',
  },
  async () => {
    const identities = store.list('identity');
    const preferences = store.list('preference');
    const projects = store.list('project');
    const rules = store.list('rule');

    let md = '## User Memory Context (by MemoryVault)\n\n';

    if (identities.length) {
      md += '### Identity\n';
      identities.forEach(m => { md += `- ${m.content}\n`; });
      md += '\n';
    }
    if (preferences.length) {
      md += '### Preferences\n';
      preferences.forEach(m => { md += `- ${m.content}\n`; });
      md += '\n';
    }
    if (projects.length) {
      md += '### Projects\n';
      projects.forEach(m => { md += `- ${m.content}\n`; });
      md += '\n';
    }
    if (rules.length) {
      md += '### Rules\n';
      rules.forEach(m => { md += `- ${m.content}\n`; });
      md += '\n';
    }

    return {
      contents: [{ uri: 'memoryvault://context/summary', text: md }],
    };
  }
);

// ─── 启动 ───
// 仅在直接运行时启动 stdio transport（测试时跳过）
if (process.env.NODE_ENV !== 'test') {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MemoryVault MCP Server running on stdio');
}

export { server, store };
```

- [ ] **Step 3: Commit**

```bash
git add src/index.ts tests/integration.test.ts
git commit -m "feat: MCP server with 6 tools and context resource"
```

---

## Task 7: Claude Desktop 接入配置

**Files:**
- Create: 无新代码文件
- 修改: Claude Desktop 配置

- [ ] **Step 1: 构建项目**

```bash
cd ~/Projects/memory-vault
pnpm build
```

Expected: `build/` 目录生成，无编译错误。

- [ ] **Step 2: 创建 .env 文件**

```bash
cp .env.example .env
# 手动编辑 .env，填入真实的 OPENAI_API_KEY
```

- [ ] **Step 3: 配置 Claude Desktop**

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`，添加：

```json
{
  "mcpServers": {
    "memory-vault": {
      "command": "node",
      "args": ["build/index.js"],
      "cwd": "/Users/jamesyu/Projects/memory-vault",
      "env": {
        "OPENAI_API_KEY": "你的key"
      }
    }
  }
}
```

或者使用 `tsx` 直接运行（开发阶段更方便）：

```json
{
  "mcpServers": {
    "memory-vault": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "cwd": "/Users/jamesyu/Projects/memory-vault",
      "env": {
        "OPENAI_API_KEY": "你的key"
      }
    }
  }
}
```

- [ ] **Step 4: 重启 Claude Desktop，验证 MCP Server 连接**

打开 Claude Desktop，在工具列表中应该能看到：
- `memory_write`
- `memory_search`
- `memory_list`
- `memory_delete`
- `memory_update`
- `memory_export`

- [ ] **Step 5: 手动测试核心流程**

在 Claude Desktop 中对话：

1. 告诉 Claude："我是一个全栈开发者，主要用 TypeScript 和 Next.js"
   → 期望 Claude 调用 `memory_write` 存储身份和偏好记忆

2. 新开一个对话，问："你还记得我用什么技术栈吗？"
   → 期望 Claude 调用 `memory_search` 检索到之前存储的记忆

3. 要求："帮我导出所有记忆"
   → 期望 Claude 调用 `memory_export` 返回 JSON

- [ ] **Step 6: Commit 配置文档**

```bash
git add docs/
git commit -m "docs: add Claude Desktop integration guide"
```

---

## Task 8: Markdown 导出功能

**Files:**
- Modify: `src/memory-store.ts`（添加 `exportMarkdown` 方法）
- Modify: `src/index.ts`（添加 `memory_export_markdown` tool）
- Test: `tests/memory-store.test.ts`（添加导出测试）

- [ ] **Step 1: 在 memory-store.test.ts 中添加测试**

```typescript
// 追加到 tests/memory-store.test.ts 的 describe 块中
describe('exportMarkdown', () => {
  it('should export memories as structured markdown', async () => {
    await store.write({ content: 'Full-stack developer', type: 'identity' });
    await store.write({ content: 'Prefers TypeScript', type: 'preference', tags: ['language'] });
    await store.write({ content: 'ProjectX uses Next.js', type: 'project', project: 'ProjectX' });

    const md = store.exportMarkdown();
    expect(md).toContain('# MemoryVault Export');
    expect(md).toContain('## Identity');
    expect(md).toContain('Full-stack developer');
    expect(md).toContain('## Preference');
    expect(md).toContain('Prefers TypeScript');
    expect(md).toContain('## Project');
    expect(md).toContain('ProjectX uses Next.js');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test -- tests/memory-store.test.ts
```

Expected: FAIL — `exportMarkdown` 不存在。

- [ ] **Step 3: 在 MemoryStore 中实现 exportMarkdown**

```typescript
// 追加到 src/memory-store.ts 的 MemoryStore class 中
exportMarkdown(): string {
  const all = this.export();
  const grouped: Record<string, MemoryEntry[]> = {};

  for (const m of all) {
    const key = m.type.charAt(0).toUpperCase() + m.type.slice(1);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(m);
  }

  let md = '# MemoryVault Export\n\n';
  md += `> Exported at ${new Date().toISOString()}\n\n`;

  for (const [type, memories] of Object.entries(grouped)) {
    md += `## ${type}\n\n`;
    for (const m of memories) {
      md += `- ${m.content}`;
      if (m.tags.length) md += ` [${m.tags.join(', ')}]`;
      if (m.project) md += ` (project: ${m.project})`;
      md += '\n';
    }
    md += '\n';
  }

  return md;
}
```

- [ ] **Step 4: 在 index.ts 中注册 memory_export_markdown tool**

```typescript
// 追加到 src/index.ts 的 tools 注册区域
server.registerTool(
  'memory_export_markdown',
  {
    title: 'Export Memories as Markdown',
    description: '将全部记忆导出为结构化的 Markdown 文档，方便用户保存和阅读。',
    inputSchema: z.object({}),
  },
  async () => {
    const md = store.exportMarkdown();
    return {
      content: [{ type: 'text', text: md }],
    };
  }
);
```

- [ ] **Step 5: 运行全部测试**

```bash
pnpm test
```

Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/memory-store.ts src/index.ts tests/memory-store.test.ts
git commit -m "feat: markdown export for portable memory backup"
```

---

## 验收标准

MVP 完成后，应满足以下条件：

| # | 验收项 | 验证方式 |
|---|--------|---------|
| 1 | `pnpm test` 全部通过 | 命令行 |
| 2 | `pnpm build` 无编译错误 | 命令行 |
| 3 | Claude Desktop 能看到 7 个 tools | Claude Desktop UI |
| 4 | 能通过对话写入记忆 | 在 Claude Desktop 中告诉它你的偏好 |
| 5 | 新对话能检索到之前的记忆 | 在新对话中问 Claude 是否记得你 |
| 6 | 能导出全部记忆为 JSON 和 Markdown | 调用 export tools |
| 7 | 数据存储在本地 `data/memory.db` | 检查文件存在 |

---

## 后续迭代方向（不在 MVP 范围内）

- **自动记忆提炼**：对话结束后自动分析并提取记忆（需要 MCP Sampling 能力）
- **记忆整理员**：定时后台任务，合并去重、短期→长期
- **E2EE 加密**：本地加密后再存储
- **云端同步**：加密数据跨设备同步
- **Web Dashboard**：记忆管理界面
- **Cursor / VS Code 接入**：同一个 MCP Server，多工具共享
- **记忆冲突检测**：新记忆与旧记忆矛盾时的处理策略
