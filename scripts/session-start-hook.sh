#!/bin/bash
# MemoryVault SessionStart Hook
# Emits project recall context to stdout for Claude Code injection.

set -euo pipefail

PAYLOAD=$(cat -)
CWD=$(printf '%s' "$PAYLOAD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('cwd',''))" 2>/dev/null || true)

if [ -z "$CWD" ]; then
  exit 0
fi

python3 - "$CWD" <<'PY' || true
import subprocess
import sys

cwd = sys.argv[1]
try:
    result = subprocess.run(
        ["memory-vault-cli", "recall", "--cwd", cwd, "--format", "context"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=2,
        check=False,
    )
    if result.returncode == 0:
        sys.stdout.write(result.stdout)
except Exception:
    pass
PY

nohup memory-vault-cli sweep-codex --limit 3 >/dev/null 2>&1 &

exit 0
