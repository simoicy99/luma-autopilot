#!/bin/zsh
# Checks everything the nightly run depends on. Run it after setup and whenever
# a night produced nothing.
ROOT="${0:A:h:h}"
ok()   { echo "  ✔ $1"; }
bad()  { echo "  ✘ $1"; FAIL=1; }
warn() { echo "  ! $1"; }
FAIL=0

echo "luma-autopilot doctor"
echo
echo "tools"
if command -v node >/dev/null; then
  V=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
  [[ $V -ge 18 ]] && ok "node $(node --version)" || bad "node $(node --version) is too old (need 18+)"
else bad "node not found (https://nodejs.org)"; fi
if command -v claude >/dev/null; then
  ok "claude CLI at $(command -v claude)"
  if claude auth status >/dev/null 2>&1; then ok "claude is logged in ($(claude auth status 2>/dev/null | grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+' | head -1))"
  else warn "claude auth status failed — run 'claude' once and /login"; fi
else bad "claude CLI not found (npm i -g @anthropic-ai/claude-code)"; fi
[[ -d "/Applications/Google Chrome.app" ]] && ok "Google Chrome installed" || bad "Google Chrome not found"

echo
echo "config"
for f in profile.json config.json; do
  if [[ -f "$ROOT/$f" ]]; then
    node -e "JSON.parse(require('fs').readFileSync('$ROOT/$f','utf8'))" 2>/dev/null && ok "$f is valid JSON" || bad "$f is not valid JSON"
  else bad "$f missing — cp ${f%.json}.example.json $f and fill it in"; fi
done
if [[ -f "$ROOT/profile.json" && -f "$ROOT/config.json" ]]; then
  if node "$ROOT/bin/inject.mjs" --run doctor >/dev/null 2>/tmp/luma-doctor.err; then ok "profile passes the field checks (E.164 phone, /in/ linkedin)"; rm -f "$ROOT/state/inject-doctor.js"
  else bad "$(cat /tmp/luma-doctor.err | tr '\n' ' ')"; fi
  EX=$(node -e "const p=require('$ROOT/profile.json');process.stdout.write(p.email==='you@example.com'?'1':'0')")
  [[ $EX == 1 ]] && bad "profile.json still has the example email"
fi

echo
echo "schedule"
if launchctl print "gui/$(id -u)/com.luma-autopilot" >/dev/null 2>&1; then ok "launchd job installed"
else warn "launchd job not installed (bin/install-launchd.sh) — fine if you only run manually"; fi
if pmset -g 2>/dev/null | grep -qE '^\s*sleep\s+0'; then ok "Mac never sleeps on this power source"
else warn "Mac may sleep before the run — a sleeping Mac kills the session mid-run (System Settings → Energy, or 'caffeinate')"; fi

echo
echo "things this script cannot check — do them by hand once:"
echo "  • The Chrome PROFILE you keep open has the 'Claude in Chrome' extension installed and enabled"
echo "  • That Chrome profile is logged in to luma.com"
echo "  • Chrome's claude.ai login is the SAME account as 'claude auth status' above (else the extension shows 'not connected')"
echo "  • Terminal has Automation permission for System Events (first launch prompts for it)"
echo
[[ $FAIL == 0 ]] && echo "all checks passed" || { echo "fix the ✘ items above"; exit 1; }
