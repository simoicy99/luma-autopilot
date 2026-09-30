#!/bin/zsh
# Installs (or reinstalls) the nightly launchd job from config.json's schedule.
set -e
ROOT="${0:A:h:h}"
PLIST="$HOME/Library/LaunchAgents/com.luma-autopilot.plist"

[[ -f "$ROOT/config.json" ]] || { echo "config.json missing — copy config.example.json first"; exit 1; }
HOUR=$(node -e "const c=require('$ROOT/config.json');process.stdout.write(String((c.schedule||{}).hour??23))")
MINUTE=$(node -e "const c=require('$ROOT/config.json');process.stdout.write(String((c.schedule||{}).minute??0))")

# launchd starts with a minimal PATH; bake in the one that has node and claude.
NODE_DIR=$(dirname "$(command -v node)")
CLAUDE_DIR=$(dirname "$(command -v claude)")
SAFE_PATH="$NODE_DIR:$CLAUDE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/state"
sed -e "s|__ROOT__|$ROOT|g" -e "s|__HOUR__|$HOUR|g" -e "s|__MINUTE__|$MINUTE|g" -e "s|__PATH__|$SAFE_PATH|g" \
  "$ROOT/launchd/com.luma-autopilot.plist.template" >"$PLIST"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed: runs daily at $(printf '%02d:%02d' "$HOUR" "$MINUTE") local time"
echo "plist: $PLIST"
echo "test it now with:  launchctl kickstart gui/$(id -u)/com.luma-autopilot"
