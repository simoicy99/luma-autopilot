# luma-autopilot

A nightly job in which Claude Code registers the owner of this repo for free, in-person
events on Luma from their own logged-in Chrome session. The runbook is the project skill at
`.claude/skills/luma-autopilot/SKILL.md`; `prompt.txt` just points at it.

Rules that hold in every session here:

- `profile.json` and `config.json` are the owner's personal data. Never commit them, never
  paste them into a summary, never send them anywhere but the luma.com tab.
- Registration is a real action on someone's account. Always dry-run (`__review()`) before
  `__regRun()`, never guess an answer marked NEEDS-HUMAN, never register for online, paid or
  members-only events, and never try to defeat Luma's rate gate — pacing is the fix.
- All run state lives in the tab's localStorage and in `state/`. Nothing else on the machine
  is touched.
