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
