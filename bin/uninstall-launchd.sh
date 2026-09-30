#!/bin/zsh
PLIST="$HOME/Library/LaunchAgents/com.luma-autopilot.plist"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "removed nightly job"
