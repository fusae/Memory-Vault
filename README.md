# MemoryVault

> MCP Memory Server — your AI memory belongs to you, not the platform.

MemoryVault is a local-first MCP (Model Context Protocol) memory server that gives AI tools persistent, searchable memory. It stores memories in SQLite, uses `sqlite-vec` + Ollama for semantic retrieval, supports optional AES-256-GCM encryption, and can sync encrypted data through Supabase.

## What It Does

- Local semantic memory with `SQLite + sqlite-vec + Ollama (nomic-embed-text)`
- MCP server with proactive memory instructions for connected clients
- Optional end-to-end encryption via `MEMORYVAULT_PASSPHRASE`
- Optional cloud sync via Supabase Magic Link auth
- Claude Code `SessionEnd` hook for automatic extraction after a chat ends
- Built-in dashboard on `http://localhost:3080`
- CLI commands for add/search/list/export/review/cleanup/sync

## Quick Start

```bash
git clone https://github.com/fusae/Memory-Vault.git
cd Memory-Vault
bash scripts/setup.sh
```

The setup script will:

- check Node.js and Ollama
- install dependencies and build
- register CLI commands globally
- offer to connect Claude Code and Codex CLI
- optionally enable encryption
- optionally configure Supabase sync

## Manual Setup

### 1. Prerequisites

- Node.js `>= 18`
- `pnpm`
- Ollama running locally

Pull the embedding model:

```bash
ollama pull nomic-embed-text
```

### 2. Install and Build

```bash
git clone https://github.com/fusae/Memory-Vault.git
cd Memory-Vault
pnpm install
pnpm build
pnpm link --global
```

After `pnpm link --global`, these commands are available globally:

- `memory-vault` — MCP server entry
- `memory-vault-cli` — CLI
- `memory-vault-dashboard` — dashboard

If `pnpm link --global` fails with `ERR_PNPM_NO_GLOBAL_BIN_DIR`, set `PNPM_HOME` first:

```bash
export PNPM_HOME="$HOME/.local/share/pnpm"
mkdir -p "$PNPM_HOME"
export PATH="$PNPM_HOME:$PATH"
pnpm link --global
```

To make it persistent:

```bash
echo 'export PNPM_HOME="$HOME/.local/share/pnpm"' >> ~/.bashrc
echo 'export PATH="$PNPM_HOME:$PATH"' >> ~/.bashrc
```

### 3. Environment

```bash
cp .env.example .env
```

Important variables:

- `MEMORY_DB_PATH` — defaults to `~/.memoryvault/memory.db`
- `OLLAMA_BASE_URL` — defaults to `http://localhost:11434`
- `MEMORYVAULT_PASSPHRASE` — optional, enables E2EE
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` — optional, for sync
- `DASHBOARD_PORT` — optional, defaults to `3080`

## Encryption

Initialize encryption:

```bash
memory-vault-cli init-encryption
```

This generates or asks for a passphrase, then encrypts existing memories. Set the passphrase in your shell environment before running the MCP server or dashboard.

## Cloud Sync

### 1. Create a Supabase project

Create a project at [supabase.com](https://supabase.com), then copy:

- Project URL
- anon public key

### 2. Run the schema

Open Supabase SQL Editor and run:

`scripts/setup-supabase.sql`

### 3. Configure Magic Link email template

In Supabase Dashboard:

`Authentication -> Email Templates -> Magic Link`

Set the email body to:

```text
Your MemoryVault verification code is: {{ .Token }}
```

### 4. Save config and log in

```bash
memory-vault-cli setup
memory-vault-cli auth login
```

Useful sync commands:

```bash
memory-vault-cli auth status
memory-vault-cli sync --status
memory-vault-cli sync
memory-vault-cli sync --push
memory-vault-cli sync --pull
```

When the MCP server is running and auth is valid, writes also try to auto-push in the background.

## MCP Integration

MemoryVault is a local `stdio` MCP server:

```bash
node /path/to/memory-vault/build/index.js
```

### Claude Code

```bash
claude mcp add memory-vault node /path/to/memory-vault/build/index.js
claude mcp list
```

### Codex CLI

```bash
codex mcp add memory-vault -- node /path/to/memory-vault/build/index.js
codex mcp list
```

### Generic MCP Client

Use a `stdio` server with:

- command: `node`
- args: `/path/to/memory-vault/build/index.js`

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "memory-vault": {
      "command": "node",
      "args": ["/path/to/memory-vault/build/index.js"],
      "env": {
        "MEMORYVAULT_PASSPHRASE": "your-passphrase-if-needed"
      }
    }
  }
}
```

## Claude SessionEnd Hook

MemoryVault ships with:

`scripts/session-end-hook.sh`

This hook:

- skips very short sessions
- runs `memory-vault-cli organize --auto`
- generates an extraction prompt from the transcript
- calls `claude -p` in the background to write memories through MCP

Example Claude Code hook config:

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

If your local Claude setup does not use `~/.claude/mcp.json`, update the `--mcp-config` path inside `scripts/session-end-hook.sh`.

## Dashboard

Start it with:

```bash
memory-vault-dashboard
```

Open:

[http://localhost:3080](http://localhost:3080)

## CLI

### Core

```bash
memory-vault-cli add "I prefer TypeScript" -t preference --tags "typescript,style"
memory-vault-cli search "TypeScript"
memory-vault-cli list
memory-vault-cli get <id>
memory-vault-cli delete <id>
memory-vault-cli export
memory-vault-cli export -f markdown
```

### Organization

```bash
memory-vault-cli organize
memory-vault-cli organize --auto
memory-vault-cli synthesize --hours 24
memory-vault-cli synthesize --hours 24 --dry-run
```

`organize` focuses on health stats and safe cleanup. `synthesize` scans recent memories for untagged entries, duplicates, contradictions, and low-value items.

### Extraction

```bash
memory-vault-cli extract -f path/to/transcript.jsonl
cat notes.txt | memory-vault-cli extract
```

This command prints an extraction prompt for an MCP-capable model to execute.

### Auth and Sync

```bash
memory-vault-cli setup
memory-vault-cli auth login
memory-vault-cli auth status
memory-vault-cli auth logout
memory-vault-cli sync
memory-vault-cli sync --status
```

## Scheduled Synthesis

The repo includes:

`scripts/synthesize-cron.sh`

It runs:

```bash
memory-vault-cli synthesize --hours 24
```

Use it from `cron` or `launchd` for periodic cleanup/review.

## MCP Capabilities

### Tools (11)

| Tool | Description |
|------|-------------|
| `memory_write` | Write a memory with semantic conflict detection |
| `memory_search` | Semantic search across memories |
| `memory_list` | List active memories |
| `memory_delete` | Permanently delete a memory |
| `memory_update` | Update a memory with version history |
| `memory_export` | Export all memories as JSON |
| `memory_export_markdown` | Export all memories as Markdown |
| `memory_forget` | Soft-delete a memory with reason |
| `memory_consolidate` | Merge multiple memories into one |
| `memory_versions` | Show version history |
| `memory_dream` | Run the full dream/organization cycle |

### Resources (2)

| Resource | Description |
|----------|-------------|
| `memoryvault://context/summary` | Summary of identity, preferences, projects, and rules |
| `memoryvault://project/{name}` | Project-scoped memory view |

### Prompts (3)

| Prompt | Description |
|--------|-------------|
| `memory_extract` | Extract long-term memories from a conversation |
| `memory_review` | Review recent memories |
| `memory_organize` | Four-phase memory organization prompt |

## How Clients Use It

The MCP server instructs connected models to:

- call `memory_search` at session start
- silently apply retrieved preferences and project context
- proactively write identity/preferences/rules/project decisions
- check for duplicates before writing
- avoid telling the user that memory was saved

Whether a client actually does this depends on the client and model honoring the MCP instructions.

## License

MIT
