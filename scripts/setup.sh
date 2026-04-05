#!/bin/bash
# MemoryVault Interactive Setup
# Run: bash scripts/setup.sh

set -euo pipefail

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

step=0
total=6

header() {
  step=$((step + 1))
  echo ""
  echo -e "${BOLD}[$step/$total] $1${NC}"
  echo -e "${DIM}$2${NC}"
  echo ""
}

success() {
  echo -e "  ${GREEN}OK${NC} $1"
}

skip() {
  echo -e "  ${DIM}SKIP${NC} $1"
}

fail() {
  echo -e "  ${RED}FAIL${NC} $1"
}

ask_yn() {
  read -r -p "  $1 (Y/n): " answer
  [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}

echo ""
echo -e "${BOLD}=== MemoryVault Setup ===${NC}"
echo "This will walk you through the full setup process."
echo ""

# ─── Step 1: Check prerequisites ───
header "Check prerequisites" "Node.js >= 18 and Ollama with nomic-embed-text"

# Node.js
if command -v node &>/dev/null; then
  NODE_VER=$(node -v)
  success "Node.js $NODE_VER"
else
  fail "Node.js not found. Install from https://nodejs.org"
  exit 1
fi

# Ollama
if command -v ollama &>/dev/null; then
  success "Ollama installed"
  if ollama list 2>/dev/null | grep -q "nomic-embed-text"; then
    success "nomic-embed-text model ready"
  else
    echo -e "  ${YELLOW}Pulling nomic-embed-text model...${NC}"
    ollama pull nomic-embed-text
    success "nomic-embed-text model pulled"
  fi
else
  fail "Ollama not found. Install from https://ollama.com"
  exit 1
fi

# ─── Step 2: Install & Build ───
header "Install & Build" "Install dependencies and compile TypeScript"

if [ ! -d "node_modules" ]; then
  pnpm install
fi
success "Dependencies installed"

pnpm build
success "Build complete"

# ─── Step 3: Register CLI commands ───
header "Register CLI" "Make memory-vault-cli available globally via npm link"

npm link 2>/dev/null
success "CLI registered: $(which memory-vault-cli)"

# ─── Step 4: MCP Integration ───
header "MCP Integration" "Connect MemoryVault to your AI tools"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
INDEX_PATH="$PROJECT_DIR/build/index.js"

if command -v claude &>/dev/null; then
  if claude mcp list 2>/dev/null | grep -q "memory-vault"; then
    success "Claude Code (already configured)"
  elif ask_yn "Add MemoryVault to Claude Code?"; then
    claude mcp add memory-vault node "$INDEX_PATH" 2>/dev/null && success "Added to Claude Code" || fail "Failed to add to Claude Code"
  else
    skip "Claude Code"
  fi
else
  skip "Claude Code not installed"
fi

if command -v codex &>/dev/null; then
  if codex mcp list 2>/dev/null | grep -q "memory-vault"; then
    success "Codex CLI (already configured)"
  elif ask_yn "Add MemoryVault to Codex CLI?"; then
    codex mcp add memory-vault -- node "$INDEX_PATH" 2>/dev/null && success "Added to Codex" || fail "Failed to add to Codex"
  else
    skip "Codex CLI"
  fi
else
  skip "Codex CLI not installed"
fi

# ─── Step 5: Encryption ───
header "End-to-End Encryption" "Encrypt your memories with AES-256-GCM (optional)"

if [ -f "$HOME/.memoryvault/crypto-salt" ]; then
  success "Encryption already configured"
elif ask_yn "Enable encryption?"; then
  memory-vault-cli init-encryption
  success "Encryption configured"
else
  skip "Encryption (can enable later with: memory-vault-cli init-encryption)"
fi

# ─── Step 6: Cloud Sync ───
header "Cloud Sync via Supabase" "Sync encrypted memories across devices (optional)"

if [ -f "$HOME/.memoryvault/config.json" ] && grep -q "supabase_url" "$HOME/.memoryvault/config.json" 2>/dev/null; then
  success "Supabase already configured"
  if [ -f "$HOME/.memoryvault/session.json" ]; then
    success "Already logged in"
  elif ask_yn "Login now?"; then
    memory-vault-cli auth login
    success "Logged in"
  fi
elif ask_yn "Set up cloud sync?"; then
  echo ""
  echo "  You need a Supabase project. If you don't have one:"
  echo "  1. Go to https://supabase.com and sign up (free)"
  echo "  2. Create a new project"
  echo "  3. Go to Settings > API to get your URL and anon key"
  echo "  4. Go to SQL Editor, paste scripts/setup-supabase.sql, click Run"
  echo "  5. Go to Authentication > Email Templates > Magic Link"
  echo "     Replace body with: Your MemoryVault verification code is: {{ .Token }}"
  echo ""

  if ask_yn "Ready to continue?"; then
    memory-vault-cli setup
    echo ""
    if ask_yn "Login now?"; then
      memory-vault-cli auth login
      success "Cloud sync configured and logged in"
    fi
  fi
else
  skip "Cloud sync (can enable later with: memory-vault-cli setup)"
fi

# ─── Done ───
echo ""
echo -e "${BOLD}=== Setup Complete ===${NC}"
echo ""
echo "  Start the dashboard:    memory-vault-dashboard"
echo "  Check memory health:    memory-vault-cli organize"
echo "  View sync status:       memory-vault-cli sync --status"
echo ""
echo "  MemoryVault will now silently collect and organize your AI memories."
echo ""
