# luma-autopilot

Have Claude Code register you for free, in-person events on [Luma](https://luma.com) every
night, from your own logged-in Chrome, with your own answers to the sign-up questions.

It is a runbook plus three small tools:

- **`bin/build-queue.mjs`** finds candidate events with Luma's public discover search (no
  database, no login), filters them to your region, window and rules, and ranks them.
- **`browser/pipeline.js`** runs inside your luma.com tab. It reads each event, fills the
  registration form from `profile.json`, shows you the planned answers, and registers through
  the same endpoint the Register button uses, one every 20 seconds.
- **`.claude/skills/luma-autopilot/SKILL.md`** is the runbook Claude follows: build queue,
  classify, dry-run review, register, log. `bin/run.sh` and a launchd job start it nightly.

Anything the profile cannot answer honestly (eligibility, memberships, money, addresses) is
left for you in `state/pending.txt` instead of guessed.

## Requirements

- macOS (the scheduler uses launchd and opens Terminal; the engine itself is portable).
- [Claude Code](https://docs.claude.com/en/docs/claude-code) logged in, and the
  [Claude in Chrome](https://claude.com/chrome) extension installed in the Chrome profile you
  keep open.
- That Chrome profile logged in to luma.com.
- Node 18 or newer.

## Setup (about 10 minutes)

```bash
git clone https://github.com/<you>/luma-autopilot
cd luma-autopilot
cp profile.example.json profile.json     # who you are, what you'll say on forms
cp config.example.json config.json       # where you are, what you want
chmod +x bin/*.sh
```

Fill in `profile.json`. Two fields have strict formats because Luma rejects anything else:
`phone` is E.164 (`+14155550123`) and `linkedin` is the path (`/in/handle`). A `null` fact means
"I don't know", and any question that needs it is left for you rather than guessed.

Edit `config.json`: your timezone and city list, the keywords to search, how many days ahead,
and the run time. `highSignalOnly: true` keeps only events that look like a room worth being
in (named firms, dinners, firesides, demo days, hackathons) and drops vendor trainings, mixers
and office hours. Set it to `false` for anything on-topic.

Then check the machine:

```bash
bin/doctor.sh
```

## Run it once by hand

In the repo, start Claude Code and paste the prompt:

```bash
claude "$(cat prompt.txt)"
```

Claude builds the queue, shows you the table, injects the engine into a luma.com tab,
classifies every event, renders a dry-run of every answer it plans to give, then registers
with 20-second pacing and writes `state/reg-log.txt` and `state/pending.txt`. Watch the first
run. If an answer is wrong, the fix belongs in `profile.json` (a fact) or in
`browser/pipeline.js` (a rule).

You can also run the pieces yourself:

```bash
node bin/build-queue.mjs            # prints the ranked table, writes state/queue-MMDD.json
node bin/build-queue.mjs --broad    # any on-topic event, not only high-signal
node bin/inject.mjs                 # writes state/inject-MMDD.js for the browser
```

## Run it nightly

```bash
bin/install-launchd.sh
```

This schedules `bin/run.sh` at the hour in `config.json`. It opens Chrome, then a Terminal
window running an interactive Claude session with `prompt.txt`. Interactive is the point: a
headless `claude -p` from cron cannot reach the Keychain or the browser extension. The Mac
has to be awake and Chrome has to be showing a window with the extension installed.

`bin/uninstall-launchd.sh` removes it.

## How it decides

1. Discover search, one request per keyword, 2 seconds apart, up to 50 events each.
2. Keep events in your timezone and city list, in the next `daysAhead` days, free, in person,
   still open, not already in `state/reg-log.txt`.
3. Score text for relevance (AI, founders, builders) and signal (named firms, small formats,
   approval-required lists; vendor words count against). Sort, cap at `maxPerNight`.
4. In the browser, re-read each event live: ticket types, sold-out state, timezone, location
   type, and every registration question. Fill what the profile can. Anything required that
   it cannot fill becomes NEEDS-HUMAN.
5. Dry run on screen, then register.

## Files

```
profile.example.json         your identity and form answers (copy to profile.json)
config.example.json          region, keywords, rules, schedule (copy to config.json)
prompt.txt                   what the nightly session is told
.claude/skills/luma-autopilot/SKILL.md   the runbook Claude follows
browser/pipeline.js          the in-tab engine (classify, review, register)
bin/build-queue.mjs          candidate discovery and ranking
bin/inject.mjs               bundles profile + config + engine for the tab
bin/run.sh                   nightly launcher (Chrome + Terminal + Claude)
bin/install-launchd.sh       schedule / unschedule
bin/doctor.sh                preflight checks
docs/TROUBLESHOOTING.md      what goes wrong and what to do
state/                       queues, logs, pending questions (gitignored)
```

## Safety and etiquette

- The engine only ever POSTs to Luma's register endpoint for events you queued, with your
  cookies, at one registration per 20 seconds. Luma's extra-verification gate is treated as a
  stop, never something to route around.
- It never claims a membership, role or vertical you did not put in `profile.json`.
- Every registration is reversible from the event page. If one was a mistake, cancel it there
  and add the slug to `skipSlugs`.
- `profile.json` and `config.json` are gitignored. Keep them that way.
- This uses Luma's private web API from your own browser session. It is not an official
  integration; if Luma changes the page or payload shape, `browser/pipeline.js` is where to fix
  it. Read `docs/TROUBLESHOOTING.md` before assuming the worst.

## License

MIT.
