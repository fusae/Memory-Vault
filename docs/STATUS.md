# MemoryVault 项目状态

> 产品 PRD 见 `docs/memory-vault-prd.md`

## 当前版本: 0.1.0

MVP + Phase 2 Batch 1 已完成，49 tests，12 commits。

## 已实现功能

### MCP Tools (10个)
| Tool | PRD 对应 | 说明 |
|------|---------|------|
| `memory_write` | 六.1 memory_write | 写入记忆，含冲突检测（语义相似度 < 0.3） |
| `memory_search` | 六.1 memory_search | 语义搜索，自动过滤过期记忆 |
| `memory_list` | — | 按类型/项目列出记忆，自动过滤过期（PRD 未明确列出，实用补充） |
| `memory_update` | — | 更新记忆，保留版本历史（PRD 未明确列出，实用补充） |
| `memory_delete` | — | 硬删除（PRD 只提了 forget，delete 是补充） |
| `memory_forget` | 六.1 memory_forget | 软删除（归档），记录原因 |
| `memory_consolidate` | 六.1 memory_consolidate | 合并多条记忆为一条 |
| `memory_versions` | — | 查看版本历史（实用补充） |
| `memory_export` | 五.5.1 数据导出 | 导出全部记忆为 JSON |
| `memory_export_markdown` | 五.5.1 数据导出 | 导出全部记忆为 Markdown |

### MCP Resources (2个)
| Resource | PRD 对应 | 说明 |
|----------|---------|------|
| `memoryvault://context/summary` | 六.2 memoryvault://context/current | 记忆总览（identity/preference/project/rule） |
| `memoryvault://project/{name}` | 六.2 memoryvault://project/{name} | 按项目查询所有记忆 |

### MCP Prompts (3个)
| Prompt | PRD 对应 | 说明 |
|--------|---------|------|
| `memory_extract` | 六.3 extract | 从对话中提取记忆 |
| `memory_review` | 六.3 review | 审查近期记忆 |
| `memory_organize` | 五.3.1 定时整理 | 建议整理和合并 |

### 其他已实现
- CLI 命令行工具（add, search, list, export）→ PRD 十一 Phase 1
- SQLite + sqlite-vec 向量搜索（768维，Ollama nomic-embed-text）→ PRD 九.1 本地优先方案
- 数据模型：expires_at 过期时间、version history 版本历史 → PRD 七.1
- 冲突检测：写入时语义相似度检测 → PRD 五.3.3
- npm 发布配置（package.json, LICENSE, README）
- 接入 Claude Desktop / Claude Code → PRD 十一 Phase 1

## 已知问题

### P1 - Resource 上下文爆炸风险
`memoryvault://context/summary` 和 `memoryvault://project/{name}` 全量返回所有记忆的完整 content，无分页、无截断、无数量上限。当记忆数量增多后会撑爆 AI 客户端的上下文窗口。

**需要优化方向：**
- 每个类别加数量上限（如最近 10 条）
- 只返回摘要（content 前 100 字符 + 总数统计）
- 支持分页（cursor 参数）
- 统计优先，AI 需要详情时再用 search/list tool 查

## 待调研

### Claude Code `/dream` 集成
Claude Code 2026 新增 `/dream`（AutoDream）功能，自动整理 AI 的 MEMORY.md，类似大脑 REM 睡眠时的记忆整理。需要调研：
- `/dream` 的具体机制（是否可扩展到第三方 MCP server）
- MemoryVault 能否 hook 进去，让 `/dream` 同时整理 MemoryVault 的记忆
- 如果不能直接集成，考虑自建类似能力：自定义 `/dream` 命令 + SessionEnd hook + Scheduled Task
- 需要升级 `memory_consolidate` 和 `memory_organize`，支持自动识别重复/过期/矛盾记忆

**前提：** 需要 Claude Code >= 2.1.x（已更新到 2.1.92，下次新会话验证）

## 未实现功能（对照 PRD）

### Phase 2：体验打磨（PRD 十一）

#### Batch 2 — 记忆提炼优化
- [ ] 自动记忆提炼（PRD 五.3）— 对话结束后自动分析提取记忆，目前只有 prompt 模板，没有自动触发机制
- [ ] confidence 置信度机制（PRD 五.3.3）— 低置信度记忆累计 3 次后自动升级
- [ ] 记忆可解释性（PRD 五.5.2）— 每条记忆附带来源说明和原始对话片段
- [ ] source 字段完善（PRD 七.1）— 目前 source 只是 string，PRD 要求 { tool, conversation_id, excerpt }

#### Batch 3 — Web Dashboard
- [ ] 记忆时间线页面（PRD 五.5.1）
- [ ] 记忆图谱可视化（PRD 五.5.1）
- [ ] 记忆编辑页面（PRD 五.5.1）
- [ ] 接入管理（PRD 五.5.1）— 管理哪些工具有权限
- [ ] 记忆健康度面板（PRD 五.5.1）
- [ ] 审批机制（PRD 五.5.2）— 新记忆弹出确认，类似 1Password

#### Batch 4 — 安全与同步
- [ ] 端到端加密 E2EE（PRD 八）— AES-256 加密存储
- [ ] 云端同步（PRD 九.2）— Supabase Realtime / CRDTs
- [ ] 用户认证（PRD 九.2）— Magic Link / Passkey
- [ ] IDE 插件（PRD 十一 Phase 2）— Cursor / VS Code 集成

### Phase 3：生态扩展（PRD 十一）
- [ ] 知识图谱引擎（PRD 七.2）— 实体关系提取与查询
- [ ] 浏览器插件 Chrome Extension
- [ ] 团队共享记忆空间
- [ ] 记忆市场 — 公开规则/偏好模板共享
- [ ] 开源 Self-hosted 版本
- [ ] API 开放平台

## 技术备忘

- SDK `argsSchema` 必须用 raw Zod shape `{ key: z.string() }`，不能用 `z.object()`（会导致 TypeError）
- `server.registerResourceTemplate` 不存在，用 `server.registerResource` + `new ResourceTemplate()`
- `vec_memories` MATCH 查询在空表会报错，需先 `COUNT(*)` 守卫
- 内部注册的 prompts 在 `server._registeredPrompts`（普通对象，用 `in` 检查）
- Embedding: Ollama nomic-embed-text, 768 维向量
