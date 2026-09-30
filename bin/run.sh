#!/bin/zsh
# Nightly launcher. launchd runs this; it opens Chrome, then opens a Terminal
# window running an INTERACTIVE Claude Code session with prompt.txt.
#
# Why not `claude -p` from cron? Cron runs outside your GUI login session, so
# it cannot reach the Keychain (Claude says "Not logged in") and headless
# sessions cannot attach the Claude in Chrome extension. Only an interactive
# session in a real Terminal window can drive the browser.

ROOT="${0:A:h:h}"
LOG="$ROOT/state/launch.log"
PROMPT_FILE="$ROOT/prompt.txt"
mkdir -p "$ROOT/state"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] launching luma-autopilot" >>"$LOG"

if [[ ! -f "$ROOT/profile.json" || ! -f "$ROOT/config.json" ]]; then
  echo "  profile.json or config.json missing — run bin/doctor.sh" >>"$LOG"
  exit 1
fi

MODEL=$(node -e "const c=require('$ROOT/config.json');process.stdout.write(c.claudeModel||'')" 2>/dev/null)
MODEL_FLAG=""
[[ -n "$MODEL" ]] && MODEL_FLAG="--model '$MODEL'"

# Chrome must be running (with the Claude extension installed in the open profile).
open -a "Google Chrome" 2>>"$LOG"
sleep 3

osascript <<EOF >>"$LOG" 2>&1
tell application "Terminal"
  activate
  do script "cd '$ROOT' && claude $MODEL_FLAG \"\$(cat '$PROMPT_FILE')\""
end tell
EOF
