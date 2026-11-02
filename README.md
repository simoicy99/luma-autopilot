# luma-autopilot

A local browser-automation utility that has [Claude Code](https://docs.claude.com/en/docs/claude-code)
find, review and register you for **free, in-person** [Luma](https://luma.com) events, using
your own logged-in Chrome session and the answers in your `profile.json`.

- Runs on your machine. It uses no hosted service and stores no credentials; registration goes
  through your luma.com tab with your cookies.
- A launchd job runs it nightly on macOS. The engine is plain JavaScript that runs in a Chrome tab.
- Required questions that no rule answers become `NEEDS-HUMAN` and are listed in
  `state/pending.txt`. Recognized membership questions are left for review.
- MIT licensed. This is not an official Luma integration: it calls the private web endpoints
  the Luma site itself uses, so changes on Luma's side can break it.

## How a run flows

```
discover  →  classify  →  review  →  register  →  log
```

| Step | Where | What happens |
| --- | --- | --- |
| **Discover** | `bin/build-queue.mjs` | Sends one public discover search per keyword in `config.json`, 2 s apart, with no login. Keeps events in your timezone, cities and date window that look free, in person and open. Ranks them, caps the list and writes `state/queue-MMDD.json`. |
| **Classify** | `__classifyRun()` in `browser/pipeline.js` | Reads each event page live, about 3 s apart, and plans an answer for every registration question. Each event ends up `READY`, `NEEDS-HUMAN`, `ALREADY` or a `SKIP-*` / `CLOSED` / `MEMBERS-ONLY` status. |
| **Review** | `__review()`, `__fix()`, `__skip()` | Prints the planned answers in the tab. Claude checks them against `profile.json` and can fix an answer or drop an event. |
| **Register** | `__regRun()` | Posts each `READY` plan to Luma's register endpoint, 20 s apart. If Luma's verification gate appears, it waits 5 minutes and retries once; a second gate stops the run for the night. |
| **Log** | runbook | Claude appends results to `state/reg-log.txt` and writes open questions to `state/pending.txt`. |

Claude follows the runbook in [`.claude/skills/luma-autopilot/SKILL.md`](.claude/skills/luma-autopilot/SKILL.md).
`prompt.txt` just points at it.

**Reading the code:**
[`plan()`](browser/pipeline.js#L322-L376) applies the hard filters and turns an event into a
plan. [`ansOpt()`](browser/pipeline.js#L130-L228) and [`ansText()`](browser/pipeline.js#L230-L320)
are the label-matching answer rules, and the [membership rules](browser/pipeline.js#L64-L95)
sit just above them. [`__regRun()`](browser/pipeline.js#L430-L448) is the paced register loop.
Discovery and ranking are in [`bin/build-queue.mjs`](bin/build-queue.mjs#L64-L131).

## What the code enforces, and what it doesn't

**Enforced in `browser/pipeline.js`:**
- Only `READY` events are posted. An event is `READY` when it has a free ticket type with no
  membership restriction, registration is open (or sold out with an active waitlist), and every
  required question has an answer.
- Online events are skipped unless `config.json` sets `noOnline: false`. Paid-only and
  membership-gated tiers are always skipped.
- `__regRun()` waits 20 s between posts and stops after a repeated gate.
- Any rule that returns no answer leaves a required question unanswered, and the event becomes
  `NEEDS-HUMAN`. An optional question with no answer is left blank.
- **Recognized membership questions are left for review.** When the label patterns recognize
  a question about whether you currently belong to a group (member, alumni, affiliated, "part
  of" a community), it gets no answer. This includes checkboxes that attest membership. For a
  recognized prospective question ("Would you like to join our community?"),
  `policy.joinCommunities` picks among options that don't state a membership status. So
  "Yes, I'm a member" and "Yes, a member" are skipped, while "Yes, I'd like to become a member"
  is allowed. A bare employer field ("Organization", "Professional affiliation") still gets
  your company. YC questions need an explicit `facts.yc`. The patterns are regexes and can miss
  phrasings they weren't written for.
- A question with only one option is not auto-accepted. It goes through the same rules as
  any other question.

**Runbook only (Claude's instructions, not code):**
- **The dry run.** `__regRun()` doesn't check that `__review()` ran. Claude reviews first
  because `SKILL.md` tells it to. On an unattended nightly run, that review is Claude checking
  its own plan, not you. Watch the first few runs yourself.
- Spacing manual `__doOne()` calls 20 s apart, logging, the peer-session check, and keeping
  `profile.json` out of summaries.

**Heuristic, so review it:** the answer rules are regexes over question labels. They can
misread a question they weren't written for. Answers come from profile fields and `policy`, and
some rules also pick fixed defaults written into the code (for example the coding-tool and
LLM-access questions). Optional questions are answered too when a rule
matches, and many open-ended text questions fall back to your `blurb`.

## Requirements

- macOS for the scheduler (launchd plus a Terminal window). The engine itself is portable.
- [Claude Code](https://docs.claude.com/en/docs/claude-code), logged in, and the
  [Claude in Chrome](https://claude.com/chrome) extension installed in the Chrome profile you
  keep open.
- That Chrome profile logged in to luma.com.
- Node 18 or newer.

## Setup

```bash
git clone https://github.com/simoicy99/luma-autopilot.git
cd luma-autopilot
cp profile.example.json profile.json     # who you are, what you'll say on forms
cp config.example.json config.json       # where you are, what you want
chmod +x bin/*.sh
bin/doctor.sh                            # preflight checks
```

**`profile.json`.** `phone` must be E.164 (`+14155550123`) and `linkedin` must be the path
form (`/in/handle`). `bin/inject.mjs` refuses to build the browser bundle until both pass. A
`null` fact means "I don't know". Most rules that read a fact return no answer when it is
`null`, so a required question becomes `NEEDS-HUMAN`. A few rules fall back to a default
instead; for example, dietary questions pick a "None" option. Review the dry run.
`policy` decides what the bot may agree to on your behalf (`agreeToTerms`, `joinCommunities`,
`bringGuest`, `speakOrPitch`, `vendorDemos`).

**`config.json`.** Set your timezone, cities, search keywords, `daysAhead`, `maxPerNight` and
`schedule`. `highSignalOnly: true` keeps events that look like a room worth being in (named
firms, dinners, firesides, demo days, hackathons) and drops vendor trainings, mixers and office
hours. The `skip*` / `no*` switches and `skipTitlePatterns` control the other filters.

## Running it

**By hand (watch the first run):**

```bash
claude "$(cat prompt.txt)"
```

Claude builds the queue and injects the engine into a luma.com tab. It classifies the events,
renders the dry run, registers, and writes `state/reg-log.txt` and `state/pending.txt`. If an
answer is wrong, fix it in `profile.json` if it's a fact, or in `browser/pipeline.js` if it's a
rule.

**The pieces on their own:**

```bash
node bin/build-queue.mjs            # ranked table + state/queue-MMDD.json
node bin/build-queue.mjs --broad    # any on-topic event, not only high-signal
node bin/build-queue.mjs --all      # everything that passes the hard filters
node bin/build-queue.mjs --days 7   # override daysAhead
node bin/inject.mjs                 # state/inject-MMDD.js for the browser tab
```

**Nightly:** `bin/install-launchd.sh` schedules `bin/run.sh` at `config.json → schedule`. It
opens Chrome, then a Terminal window running an interactive Claude session with `prompt.txt`.
A headless `claude -p` from cron can't reach the Keychain or the browser extension. The Mac
must be awake and Chrome must be showing a window with the extension installed.
`bin/uninstall-launchd.sh` removes the job.

## Tests

```bash
node --test test/pipeline.test.mjs
```

These are offline tests with no network calls and no browser. They load `browser/pipeline.js`
in a `node:vm` sandbox with a stubbed `fetch` that serves fixture event pages, an in-memory
`localStorage` and immediate timers. Then they run the real `__classifyRun()` and check the
stored plans. Each test asserts the only request was a `GET` of the fixture page, so the
suite never touches the network or the register endpoint. Cases covered:

- Required current-membership dropdowns, checkboxes and text questions → `NEEDS-HUMAN`.
  Optional ones are left blank.
- A single-option membership question is not auto-accepted.
- Prospective joins follow `policy.joinCommunities` on and off. Options stating membership
  ("already a member", "Yes, I'm a member" / "Yes, I’m a member", "Yes, a member") are never
  picked; "Yes, I'd like to become a member" is.
- YC questions need `facts.yc`.
- Employer fields ("Organization", "Professional affiliation"), company size, email and a
  code-of-conduct checkbox still answer.

CI runs the same suite plus `node --check browser/pipeline.js` on every push and pull
request ([`.github/workflows/test.yml`](.github/workflows/test.yml)).

## Files

```
profile.example.json / config.example.json   copy to profile.json / config.json (gitignored)
prompt.txt                                   what the nightly session is told
.claude/skills/luma-autopilot/SKILL.md       the runbook Claude follows
browser/pipeline.js                          in-tab engine: classify, review, register
bin/build-queue.mjs                          discovery and ranking
bin/inject.mjs                               bundles profile + config + engine for the tab
bin/run.sh, bin/install-launchd.sh           nightly launcher and scheduler
bin/doctor.sh                                preflight checks
test/pipeline.test.mjs                       offline classification tests (CI: .github/workflows/test.yml)
docs/TROUBLESHOOTING.md                      what goes wrong and what to do
state/                                       queues, logs, pending questions (gitignored)
```

## Safety and etiquette

- Registering is a real action on your account, and hosts see the answers you submit. The
  engine sends POST requests only to Luma's register endpoint, only for queued `READY` events,
  with your cookies, at most one every 20 s in the loop.
- Luma's verification gate is a stop, never something to route around. If everything gates,
  let the account rest until the next night.
- If you registered by mistake, you can usually cancel from the event page ("Cancel
  registration" / "Leave waitlist"). Then add the slug to `skipSlugs`. Approval-required events
  and waitlists depend on the host.
- Keep `profile.json` and `config.json` gitignored. If Luma changes its page or payload shape,
  `browser/pipeline.js` is where to fix it. See [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

## License

MIT. See [LICENSE](LICENSE).
