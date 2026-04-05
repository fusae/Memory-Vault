# MemoryVault

> MCP Memory Server — Your AI memory belongs to you, not the platform.

MemoryVault is a local-first, end-to-end encrypted MCP (Model Context Protocol) server that gives your AI assistants persistent, searchable, and cross-platform memory.

Instead of retraining every new AI tool on who you are, what you prefer, and how your project works, MemoryVault acts as your universal AI context layer. It automatically extracts, encrypts, and syncs your working memory across devices.

## Key Features

- **Local-First Semantic Search**: Powered by SQLite + sqlite-vec and Ollama (nomic-embed-text) for fast, local 768-dimensional vector search.
- **E2EE (End-to-End Encryption)**: Memories are encrypted locally using AES-256-GCM. Your passphrase never leaves your machine; the cloud only sees ciphertext.
- **Cloud Sync**: Seamless cross-device synchronization backed by Supabase PostgreSQL and Magic Link authentication. Last-write-wins conflict resolution.
- **AutoDream (REM-style Consolidation)**: Automatically cleans up, merges, and prunes stale memories using a 4-phase "REM sleep" cycle to keep the context window lean.
- **Web Dashboard**: A lightweight, built-in dashboard for managing your memories, viewing version history, and monitoring memory health.
- **Auto-Extraction**: Integrates with Claude Code's SessionEnd hook to automatically extract valuable context when you finish a conversation.

---

## Installation & Setup

### 1. Prerequisites

- **Node.js** >= 18
- **Ollama** running locally with the embedding model:
  ```bash
  ollama pull nomic-embed-text
  ```

### 2. Install

```bash
git clone https://github.com/memoryvault/memory-vault.git
cd memory-vault
pnpm install
pnpm build

# Register CLI commands globally
npm link
```

After `npm link`, you can use `memory-vault-cli` directly from anywhere.

### 3. Basic Configuration (Local Only)

```bash
cp .env.example .env
```

### 4. Enable End-to-End Encryption (Optional)

```bash
memory-vault-cli init-encryption
```

The command will auto-generate a strong passphrase by default (or enter `n` to set your own). After initialization, add the passphrase to your shell profile as instructed by the output.

### 5. Enable Cloud Sync via Supabase (Optional)

```bash
# Provide your Supabase URL and Anon Key
memory-vault-cli setup

# Run scripts/setup-supabase.sql in your Supabase SQL Editor

# Login via Magic Link
memory-vault-cli auth login
```

Once logged in, memories are **automatically synced** to the cloud after every write, update, or delete. No manual sync needed. If your session expires, you'll see a one-time warning — just run `memory-vault-cli auth login` again.

You can also sync manually or check status:

```bash
memory-vault-cli sync --status   # Check sync status
memory-vault-cli sync            # Manual full sync (push + pull)
memory-vault-cli sync --pull     # Pull from cloud (e.g. on a new device)
```

---

## Web Dashboard

```bash
memory-vault-dashboard
```

Open `http://localhost:3080`. From here you can view your timeline, edit memories, check sync status, and monitor memory health.

---

## MCP Integration

### Claude Code

```bash
claude mcp add memory-vault node /path/to/memory-vault/build/index.js
```

**Auto-Extraction Hook (SessionEnd)**

To automatically extract memories and run cleanup when you exit Claude Code, add this to `~/.claude/settings.json`:

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

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "memory-vault": {
      "command": "node",
      "args": ["/path/to/memory-vault/build/index.js"],
      "env": {
        "MEMORYVAULT_PASSPHRASE": "your-passphrase-if-using-e2ee"
      }
    }
  }
}
```

---

## CLI Usage

```bash
# Core Memory Management
memory-vault-cli add "I prefer TypeScript" -t preference --tags "language,typescript"
memory-vault-cli search "TypeScript"
memory-vault-cli list
memory-vault-cli get <id>
memory-vault-cli delete <id>

# AutoDream & Extraction
memory-vault-cli organize --auto
memory-vault-cli extract -f <transcript.jsonl>

# Auth & Sync
memory-vault-cli auth login
memory-vault-cli auth status
memory-vault-cli sync
memory-vault-cli sync --status

# Export
memory-vault-cli export
memory-vault-cli export -f markdown
```

---

## MCP Capabilities

### Tools (11)

| Tool | Description |
|------|-------------|
| `memory_write` | Write a new memory with semantic conflict detection |
| `memory_search` | Semantic search across memories |
| `memory_list` | List active memories with filters |
| `memory_update` | Update existing memory with version history |
| `memory_delete` | Permanently delete a memory |
| `memory_forget` | Soft-delete (archive) with a tracked reason |
| `memory_consolidate` | Merge multiple memories into one |
| `memory_versions` | View version history for a memory |
| `memory_export` | Export all memories as JSON |
| `memory_export_markdown` | Export all memories as Markdown |
| `memory_dream` | Run the 4-phase AutoDream consolidation cycle |

### Resources (2)

| Resource | Description |
|----------|-------------|
| `memoryvault://context/summary` | Global memory context overview |
| `memoryvault://project/{name}` | All memories for a specific project |

### Prompts (3)

| Prompt | Description |
|--------|-------------|
| `memory_extract` | Extract cross-session value from a conversation transcript |
| `memory_review` | Review recently added memories |
| `memory_organize` | REM-sleep style 4-phase consolidation prompt |

---

## License

MIT
