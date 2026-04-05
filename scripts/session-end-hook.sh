#!/bin/bash
# MemoryVault SessionEnd Hook
# Reads Claude Code session transcript and extracts memories via claude -p
#
# Install: copy to ~/.memoryvault/hooks/session-end.sh
# Configure in ~/.claude/settings.json:
#   "hooks": {
#     "SessionEnd": [{ "hooks": [{ "type": "command", "command": "~/.memoryvault/hooks/session-end.sh" }] }]
#   }

set -euo pipefail

# Read hook payload from stdin
PAYLOAD=$(cat -)
TRANSCRIPT_PATH=$(echo "$PAYLOAD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('transcript_path',''))" 2>/dev/null)

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  exit 0
fi

# Skip very short sessions (< 5 lines likely just /hooks or /exit)
LINE_COUNT=$(wc -l < "$TRANSCRIPT_PATH")
if [ "$LINE_COUNT" -lt 10 ]; then
  exit 0
fi

# Run auto-organize (fast, no LLM needed)
memory-vault-cli organize --auto 2>/dev/null || true

# Extract memories from transcript via claude
# The prompt instructs Claude to call memory_write via the MCP server
PROMPT=$(memory-vault-cli extract -f "$TRANSCRIPT_PATH" 2>/dev/null)

if [ -n "$PROMPT" ]; then
  # Run in background to not block session exit
  nohup claude -p "$PROMPT" --mcp-config ~/.claude/mcp.json >/dev/null 2>&1 &
fi
