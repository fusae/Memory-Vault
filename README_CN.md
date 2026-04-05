# MemoryVault

> MCP 记忆服务 — 你的 AI 记忆属于你，不属于任何平台。

MemoryVault 是一个本地优先、端到端加密的 MCP（Model Context Protocol）记忆服务器，为你的 AI 助手提供持久化、可搜索、跨平台的记忆能力。

不用再为每一个新工具反复解释你是谁、偏好什么、项目怎么架构。MemoryVault 作为通用的 AI 上下文层，自动提取、加密、同步你的工作记忆。

## 核心特性

- **本地优先语义搜索**：基于 SQLite + sqlite-vec 和 Ollama（nomic-embed-text），768 维向量搜索，完全离线可用。
- **端到端加密（E2EE）**：使用 AES-256-GCM 在本地加密，密钥永不上传。云端只存密文。
- **云端同步**：通过 Supabase PostgreSQL + Magic Link 认证，实现跨设备无缝同步。Last-write-wins 冲突解决。
- **AutoDream（REM 式整理）**：模拟大脑 REM 睡眠，自动清理、合并、裁剪过期记忆，保持上下文窗口精简。四阶段流程：定位 → 采集 → 整合 → 裁剪。
- **Web 管理面板**：内置轻量级 Dashboard，可视化管理记忆、查看版本历史、监控记忆健康度。
- **自动提取**：集成 Claude Code 的 SessionEnd Hook，对话结束后自动从会话记录中提取有价值的上下文。

---

## 安装与配置

### 1. 前置要求

- **Node.js** >= 18
- **Ollama** 本地运行，并拉取嵌入模型：
  ```bash
  ollama pull nomic-embed-text
  ```

### 2. 安装

```bash
git clone https://github.com/memoryvault/memory-vault.git
cd memory-vault
pnpm install
pnpm build

# 注册全局 CLI 命令
npm link
```

`npm link` 之后可以在任意目录直接使用 `memory-vault-cli` 命令。

### 3. 基础配置（仅本地使用）

```bash
cp .env.example .env
```

### 4. 启用端到端加密（可选）

```bash
memory-vault-cli init-encryption
```

默认会自动生成一个强随机密码（输入 `n` 可以手动设定）。初始化完成后，按照输出提示将密码添加到你的 shell 配置文件中。

### 5. 启用云端同步（可选，需要 Supabase）

**5.1 创建 Supabase 项目**

1. 去 [supabase.com](https://supabase.com) 注册（免费套餐即可）
2. 点击 "New Project"，填写项目名和区域，设置数据库密码
3. 等待项目创建完成

**5.2 获取凭证**

在 Supabase 项目 Dashboard 中，进入 **Settings > API**，复制：
- **Project URL**（如 `https://abcdefg.supabase.co`）
- **anon public key**（以 `eyJ...` 开头的字符串）

**5.3 建表**

在 Supabase Dashboard 中进入 **SQL Editor**，粘贴 `scripts/setup-supabase.sql` 的内容，点击 **Run**。

**5.4 配置邮件验证**

进入 **Authentication > Email Templates > Magic Link**，将邮件内容替换为：

```
Your MemoryVault verification code is: {{ .Token }}
```

这样 CLI 登录时会收到数字验证码而不是链接。

**5.5 连接 MemoryVault**

```bash
# 输入 Supabase URL 和 Anon Key
memory-vault-cli setup

# 用邮箱登录
memory-vault-cli auth login
```

登录后，每次写入、更新或删除记忆时会**自动同步**到云端，无需手动操作。如果 session 过期，会看到一次提示 — 重新执行 `memory-vault-cli auth login` 即可。

也可以手动同步或查看状态：

```bash
memory-vault-cli sync --status   # 查看同步状态
memory-vault-cli sync            # 手动全量同步（推送 + 拉取）
memory-vault-cli sync --pull     # 从云端拉取（如换设备时使用）
```

---

## Web 管理面板

```bash
memory-vault-dashboard
```

打开 `http://localhost:3080`，可以查看记忆时间线、编辑记忆、查看同步状态和记忆健康度。

---

## MCP 接入

### Claude Code

```bash
claude mcp add memory-vault node /path/to/memory-vault/build/index.js
```

**自动提取 Hook（SessionEnd）**

在 `~/.claude/settings.json` 中添加以下配置，退出 Claude Code 时自动提取记忆并执行清理：

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/memory-vault/scripts/session-end-hook.sh"
          }
        ]
      }
    ]
  }
}
```

### Claude Desktop

在 `~/Library/Application Support/Claude/claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "memory-vault": {
      "command": "node",
      "args": ["/path/to/memory-vault/build/index.js"],
      "env": {
        "MEMORYVAULT_PASSPHRASE": "如果启用了加密，填写你的密码"
      }
    }
  }
}
```

---

## CLI 命令

```bash
# 记忆管理
memory-vault-cli add "我偏好使用 TypeScript" -t preference --tags "language,typescript"
memory-vault-cli search "TypeScript"
memory-vault-cli list
memory-vault-cli get <id>
memory-vault-cli delete <id>

# AutoDream 与提取
memory-vault-cli organize --auto
memory-vault-cli extract -f <transcript.jsonl>

# 认证与同步
memory-vault-cli auth login
memory-vault-cli auth status
memory-vault-cli sync
memory-vault-cli sync --status

# 导出
memory-vault-cli export
memory-vault-cli export -f markdown
```

---

## MCP 能力一览

### 工具（11 个）

| 工具 | 说明 |
|------|------|
| `memory_write` | 写入记忆，含语义冲突检测 |
| `memory_search` | 语义搜索 |
| `memory_list` | 按类型/项目列出记忆 |
| `memory_update` | 更新记忆，保留版本历史 |
| `memory_delete` | 永久删除 |
| `memory_forget` | 软删除（归档），记录原因 |
| `memory_consolidate` | 合并多条记忆为一条 |
| `memory_versions` | 查看版本历史 |
| `memory_export` | 导出为 JSON |
| `memory_export_markdown` | 导出为 Markdown |
| `memory_dream` | 执行四阶段 AutoDream 整理 |

### 资源（2 个）

| 资源 | 说明 |
|------|------|
| `memoryvault://context/summary` | 记忆总览（身份、偏好、规则） |
| `memoryvault://project/{name}` | 按项目查询记忆 |

### 提示模板（3 个）

| 模板 | 说明 |
|------|------|
| `memory_extract` | 从对话中提取跨会话有价值的信息 |
| `memory_review` | 审查近期记忆 |
| `memory_organize` | REM 式四阶段整理指令 |

---

## 许可证

MIT
