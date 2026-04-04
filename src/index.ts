#!/usr/bin/env node
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MemoryStore } from './memory-store.js';

const DB_PATH = process.env.MEMORY_DB_PATH ?? './data/memory.db';
const store = new MemoryStore(DB_PATH);

const server = new McpServer(
  {
    name: 'memory-vault',
    version: '0.1.0',
  },
  {
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
      content: [{ type: 'text' as const, text: JSON.stringify(memory, null, 2) }],
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
      content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
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
      content: [{ type: 'text' as const, text: JSON.stringify(memories, null, 2) }],
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
      content: [{ type: 'text' as const, text: `Memory ${id} deleted.` }],
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
      content: [{ type: 'text' as const, text: JSON.stringify(memory, null, 2) }],
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
      content: [{ type: 'text' as const, text: JSON.stringify(all, null, 2) }],
    };
  }
);

// ─── Tool: memory_export_markdown ───
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
      content: [{ type: 'text' as const, text: md }],
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

// ─── Prompt: memory_extract (记忆提炼) ───
server.registerPrompt(
  'memory_extract',
  {
    title: 'Extract Memories from Conversation',
    description: '分析对话内容，提取值得长期记住的用户信息。在对话结束时调用。',
    argsSchema: {
      conversation: z.string().describe('要分析的对话内容'),
    },
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

// ─── Prompt: memory_review (记忆审阅) ───
server.registerPrompt(
  'memory_review',
  {
    title: 'Review Recent Memories',
    description: '审阅最近存储的记忆，确认、修改或删除不准确的条目。',
    argsSchema: {
      days: z.number().optional().describe('审阅最近多少天的记忆，默认 7 天'),
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

// ─── 启动 ───
if (process.env.NODE_ENV !== 'test') {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MemoryVault MCP Server running on stdio');
}

export { server, store };
