# Troubleshooting

Everything here was learned the hard way over two months of nightly runs. Check
`bin/doctor.sh` first, then the matching section.

## "Browser extension is not connected"

The Claude in Chrome extension pairs with Claude Code only when three things line up:

1. **The Chrome profile that is open has the extension installed.** Chrome keeps one
   extension list per profile. If you have several profiles, the window you left open may be
   the one without it. Open `chrome://extensions` in that window and look for "Claude".
2. **Chrome's claude.ai login and Claude Code's login are the same account.** Run
   `claude auth status` in a terminal and compare with the account shown at claude.ai in that
   Chrome window. A `/login` into a different account silently breaks pairing for every new
   session.
3. **Chrome is actually showing a window.** Quitting Chrome from a script can leave it
   running with zero windows; `open -a "Google Chrome"` then does nothing. Quit it from the
   Dock and reopen it by hand.

What does not help: relaunching Chrome from a script, reinstalling the extension, clearing
sockets. Fix the account or the profile, then start a fresh Claude session.

## The run happened but nothing was registered

- Read `state/launch.log` for the launch time and `state/reg-log.txt`'s modification time.
  A run an hour old with no log write has not been working.
- Look at the Terminal window the job opened. The common last lines are
  `API Error: Your computer went to sleep mid-response` (let the Mac stay awake: System
  Settings → Energy, or run `caffeinate -i` in another tab) and
  `Not logged in · Please run /login`.
- If it says the extension was not attached, see above. The queue is still in
  `state/queue-<run>.json` and `state/pending.txt`; a session with a browser can pick it up.

## It ran from cron and died in 3 seconds

Use launchd, not cron, and an interactive Terminal, not `claude -p`. Cron runs outside your
GUI login session, cannot reach the Keychain, and headless sessions have no browser tools.
`bin/install-launchd.sh` does it right.

## The nightly run fires at the wrong time or not at all

`StartCalendarInterval` is local time. If the Mac was asleep at that minute, launchd runs the
job once it wakes, which may be the next morning with Chrome closed. Keep the Mac awake around
the run, or move the run to when you are at the machine.

## The classifier stalls with no error

- **localStorage is full.** luma.com's own storage plus old runs can hit the 5MB quota, and a
  quota error inside the loop looks like a stall. `__status().localStorageKB` shows usage;
  `__reset('<old run>')` frees it. The heartbeat state `LS-FULL` is the tell.
- **HTTP 429.** Page reads are rate-limited. The loop sleeps two minutes on its own; the
  heartbeat shows `429`. Reads faster than ~3 seconds apart trigger it.
- **Chrome throttled the tab.** A background tab that nothing touched for ~5 minutes gets its
  timers cut to roughly one per minute. The engine uses Worker timers to dodge most of it, but
  poke the tab with any javascript call every ~10 minutes.

## `GATE` / `additional-verification-required`

Luma asks for extra verification in two situations that look identical: that one event
carries its own challenge, or the account has used up a rolling budget for the night (about a
dozen registrations in quick succession trips it; 20 seconds apart runs clean). The loop waits
5 minutes and retries the same slug once; if it gates again it stops for the night. Trying a
different slug is the only way to tell the two apart. If everything gates, stop and let the
account rest until tomorrow. It is rate-based, not a ban.

## `{"message":"Invalid request."}` on every registration

The payload shape is exact. The three fields that get it wrong:

- `phone` must be E.164 (`+14155550123`), and only sent when the event requires it.
- `linkedin` is the **path** (`/in/handle`), not the URL.
- a `company` question takes an object `{company, job_title}`, not a string.

`bin/inject.mjs` checks the first two before it will build the blob.

## Every event classifies as ALREADY

`guest_data` on the event page is a stub even when you are not registered. The engine tests
`approval_status`, not existence. If Luma changes the shape, that is the line to fix in
`browser/pipeline.js` (`plan()`).

## Two sessions ran at once

The heartbeat in localStorage (`__hb<run>`) is how a session knows another one is live. The
runbook's peer check stands down when one is under 30 minutes old. A session that died with
the Mac asleep can leave a stale heartbeat; if you are sure nothing is running, `__reset` it.

## A registration was made in error

You can usually cancel it in the UI: open the event page, "Cancel registration" / "Leave
waitlist", confirm. Then add the slug to `config.json`'s `skipSlugs`.
