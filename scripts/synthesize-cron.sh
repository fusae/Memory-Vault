#!/bin/bash
# MemoryVault Synthesis Cron Job
# Runs periodic memory synthesis to find duplicates, contradictions, and cleanup.
#
# Install via cron (runs every 24 hours at 3am):
#   crontab -e
#   0 3 * * * /path/to/memory-vault/scripts/synthesize-cron.sh >> ~/.memoryvault/synthesize.log 2>&1
#
# Or via launchd (macOS) — create ~/Library/LaunchAgents/com.memoryvault.synthesize.plist:
#   <?xml version="1.0" encoding="UTF-8"?>
#   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
#   <plist version="1.0">
#   <dict>
#     <key>Label</key>
#     <string>com.memoryvault.synthesize</string>
#     <key>ProgramArguments</key>
#     <array>
#       <string>/path/to/memory-vault/scripts/synthesize-cron.sh</string>
#     </array>
#     <key>StartCalendarInterval</key>
#     <dict>
#       <key>Hour</key>
#       <integer>3</integer>
#       <key>Minute</key>
#       <integer>0</integer>
#     </dict>
#     <key>StandardOutPath</key>
#     <string>/tmp/memoryvault-synthesize.log</string>
#     <key>StandardErrorPath</key>
#     <string>/tmp/memoryvault-synthesize.log</string>
#   </dict>
#   </plist>
#
#   Then: launchctl load ~/Library/LaunchAgents/com.memoryvault.synthesize.plist

set -euo pipefail

echo "=== MemoryVault Synthesis — $(date -Iseconds) ==="

# Run synthesis for the last 24 hours with auto-cleanup
memory-vault-cli synthesize --hours 24 2>&1

echo ""
echo "=== Synthesis complete ==="
