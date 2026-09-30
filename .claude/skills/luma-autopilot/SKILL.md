---
name: luma-autopilot
description: Nightly Luma registration run — build the queue, classify each event in the owner's logged-in Chrome tab, dry-run review, register with pacing, log results. Use when asked to run the Luma sync or register for events.
---

# luma-autopilot runbook

You are registering the owner of this repo (the person in `profile.json`) for free, in-person
events on Luma, from their own Chrome session. Work in this order. `RUN` is today's date as
`MMDD` (e.g. `0930`). All paths are relative to the repo root.

## 0. Preflight

1. Load the browser tools and call `tabs_context_mcp`. If the Claude in Chrome extension is
   **not connected**, do NOT try to fix Chrome from a script (quitting it strands the browser).
   Do step 1 only, write the queue table to `state/pending.txt` under a dated header, and say at
   the top of your reply that the extension was not attached so nothing was registered. See
   `docs/TROUBLESHOOTING.md` for the usual causes.
2. Peer check. Open `https://luma.com/home` in a **new tab** and read `localStorage` for any key
   starting with `__hb` whose `at` is under 30 minutes old. If one exists, another session is
   already driving this account: write one line to `state/launch.log` saying so and stop.
3. Check localStorage size on luma.com: sum the lengths of all values. If it is over ~4MB, run
   the engine's `__reset('<old run id>')` for old runs first — the 5MB quota kills the
   classifier silently.

## 1. Build the queue

```
node bin/build-queue.mjs --run RUN
```

It sweeps Luma's public discover search for the keywords in `config.json`, applies the
region/window/free/in-person rules, drops what `state/reg-log.txt` already covers, scores the
rest and writes `state/queue-RUN.json`. Read the printed table. Strike anything obviously wrong
for this person by removing its slug from the `slugs` array in the JSON (edit the file). Online
events, paid events, women-focused events (when configured) and members-only tiers are never
registered; the engine re-checks all of these from the live event page.

## 2. Inject the engine

```
node bin/inject.mjs --run RUN
```

Read the file it prints (`state/inject-RUN.js`) and evaluate its **entire contents** with the
javascript tool in the luma.com tab. It defines `__classifyRun`, `__regRun`, `__doOne`,
`__status`, `__review`, `__fix`, `__skip`, `__reset`. Then put the queue's slugs in place:

```js
localStorage['__qRUN'] = JSON.stringify(<the "slugs" array from state/queue-RUN.json>)
```

## 3. Classify

Run `__classifyRun()` fire-and-forget (do not await it in the tool call — call it and return).
Poll `__status()` about every 60 seconds until `hb.state` is `CLS-DONE`. It reads one event page
every ~3 seconds; a `429` state means it is cooling down on its own for two minutes. If the
heartbeat stops advancing for 5+ minutes, reload the tab, re-evaluate the inject file, and call
`__classifyRun()` again — it resumes where it left off.

**Never edit plans in localStorage while `__classifyRun` is still running**; it writes the whole
map back and will clobber your edit.

## 4. Dry-run review (mandatory)

Call `__review()` then `get_page_text`. For every READY plan, check each answer against
`profile.json`. Typical mistakes: a "who referred you" question answered with the person's own
name, a "what role are you hiring for" answered with their title, a membership question answered
yes, a vertical claimed that the profile never stated. Fix with
`__fix('slug', /label regex/i, value)` (arrays for select questions) or drop with
`__skip('slug', 'why')`.

NEEDS-HUMAN plans are blocked on a fact the profile does not have. **Do not guess** eligibility,
identity, addresses, memberships, money or dates. They go to `state/pending.txt` in step 6.

## 5. Register

Run `__regRun()` fire-and-forget. It posts one registration every 20 seconds. Every ~10 minutes
make any javascript tool call on the tab (e.g. `__status()`) so Chrome does not throttle the
loop, and read the results.

A `GATE` result means Luma asked for additional verification. The loop already waits 5 minutes
and retries that slug once; if the same slug gates twice it stops for the night (`GATED-STOP`).
Do not restart it, do not lower the pacing, do not work around the gate. Report it.

Never kill a loop by flipping `window.__running`; reload the tab instead. Never re-run `__doOne`
on a slug without reading `__resRUN` first.

For fewer than 10 READY slugs, you may call `__doOne('slug')` one at a time instead of the loop,
20 seconds apart.

## 6. Log and report

Append one line per processed slug to `state/reg-log.txt`:

```
<slug> <STATUS> <RUN> <short reason>
```

for REGISTERED / WAITLIST / ALREADY / SKIP-* / FAIL-* / 404 / CLOSED / MEMBERS-ONLY /
OUT-OF-REGION / GATE. **Do not log NEEDS-HUMAN** — overwrite `state/pending.txt` instead with a
dated header and one block per event:

```
<title>  —  https://luma.com/<slug>
    Q: <question>  [option | option | …]
```

so the owner can answer and a later run retries them (they are re-queued on purpose).

Finish with a short summary: registered, waitlisted, skipped by reason, NEEDS-HUMAN count, any
gate, and any answering bug you found. If you fixed an answering rule, patch
`browser/pipeline.js` in the repo, not just the page, and say so.

## Hard rules

- In-person only. Never online, virtual, webinar, livestream.
- Free tickets only. Never paid, never a membership-restricted tier.
- Never claim a membership, an affiliation, a role or a vertical the profile does not state.
- Never answer for the human on eligibility, identity, addresses, money or dates.
- One registration every 20 seconds, one page read every 3 seconds. A gate is a stop, not a
  puzzle.
- `profile.json` stays in the luma.com tab and in this repo. It never goes in a summary.
