# MemoryVault

> MCP Memory Server — Your AI memory belongs to you.

MemoryVault is a local-first MCP (Model Context Protocol) server that gives your AI assistants persistent, searchable memory. Memories are stored locally with semantic vector search powered by Ollama.

## Prerequisites

- **Node.js** >= 18
- **Ollama** running locally with `nomic-embed-text` model

```bash
# Install Ollama and pull the embedding model
ollama pull nomic-embed-text
```

## Installation

```bash
npm install
npm run build
```

## Configuration

Copy `.env.example` to `.env` and adjust as needed:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_DB_PATH` | `~/.memoryvault/memory.db` | SQLite database location |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API endpoint |

## MCP Integration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "memory-vault": {
      "command": "node",
      "args": ["/path/to/memory-vault/build/index.js"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add memory-vault node /path/to/memory-vault/build/index.js
```

## CLI Usage

```bash
# Add a memory
npx memory-vault-cli add "I prefer TypeScript" -t preference --tags "language,typescript"

# Search memories
npx memory-vault-cli search "TypeScript"

# List all memories
npx memory-vault-cli list

# Export
npx memory-vault-cli export
npx memory-vault-cli export -f markdown
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `memory_write` | Write a new memory with conflict detection |
| `memory_search` | Semantic search across memories |
| `memory_list` | List active memories with filters |
| `memory_update` | Update existing memory with version history |
| `memory_delete` | Permanently delete a memory |
| `memory_forget` | Soft-delete (archive) with reason |
| `memory_consolidate` | Merge multiple memories into one |
| `memory_versions` | View version history for a memory |
| `memory_export` | Export all memories as JSON |
| `memory_export_markdown` | Export all memories as Markdown |

## MCP Resources

| Resource | Description |
|----------|-------------|
| `memoryvault://context/summary` | Memory context overview |
| `memoryvault://project/{name}` | All memories for a specific project |

## MCP Prompts

| Prompt | Description |
|--------|-------------|
| `memory_extract` | Extract memories from conversation |
| `memory_review` | Review recent memories |
| `memory_organize` | Suggest memory consolidation and cleanup |

## License

MIT
