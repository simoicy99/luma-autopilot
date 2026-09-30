#!/usr/bin/env node
// Builds tonight's registration queue from Luma's public discover search.
// No database, no login: each keyword in config.json returns up to 50 upcoming
// events; the union is filtered to your region, window and rules, scored, and
// written to state/queue-<run>.json.
//
//   node bin/build-queue.mjs                # tonight (run id = MMDD)
//   node bin/build-queue.mjs --run 0930     # explicit run id
//   node bin/build-queue.mjs --broad        # any relevant event, not only high-signal
//   node bin/build-queue.mjs --all          # everything that passes the hard rules
//   node bin/build-queue.mjs --days 7
//
// Prints the queue as a table on stdout, counts on stderr.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state');
const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

function loadJson(name) {
  const p = path.join(ROOT, name);
  if (!fs.existsSync(p)) { console.error(`missing ${name} — copy ${name.replace('.json', '.example.json')} to ${name} and fill it in`); process.exit(2); }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
const CFG = loadJson('config.json');
const now = new Date();
const RUN = opt('run', `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`);
const DAYS = Number(opt('days', CFG.daysAhead || 21));
const OUT = path.join(STATE, `queue-${RUN}.json`);
fs.mkdirSync(STATE, { recursive: true });

// ---------- what earlier nights already handled ----------
// reg-log.txt lines: <slug> <STATUS> <run> [note]. NEEDS-HUMAN is never logged, so it retries.
const done = new Set();
const logPath = path.join(STATE, 'reg-log.txt');
if (fs.existsSync(logPath)) {
  for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(\S+)/);
    if (m && m[2] !== 'ERR') done.add(m[1]);
  }
}

// ---------- scoring (text only; same idea as a "high signal" test) ----------
const TOPICS = [
  /\b(ai|a\.i\.|llms?|agents?|agentic|mcp|ml|machine learning|gpt|claude|anthropic|openai|gemini|deepmind|nvidia|cursor|hugging ?face|robotics)\b/i,
  /\b(founders?|co-?founders?|yc|y combinator|a16z|sequoia|vcs?|venture|investors?|angels?|demo day|pitch|fundrais\w*|seed|pre-seed|series a|lps?|gps?)\b/i,
  /\b(hackathon|build night|builders?|devs?|developers?|engineers?|technical|infra|open source|hardware|semiconductor|disrupt|techcrunch|tech ?week|summit|conference|afterparty|after party|launch|gtm|saas|b2b)\b/i,
];
const NAMES = /\b(sequoia|a16z|andreessen|khosla|greylock|benchmark|founders fund|lightspeed|accel|kleiner|index ventures|general catalyst|conviction|thrive capital|lux capital|bessemer|redpoint|felicis|y ?combinator|yc|openai|anthropic|deepmind|nvidia|meta ai|mistral|hugging ?face|perplexity|stripe|south park commons|ai tinkerers)\b/i;
const FORMATS = /\b(dinner|fireside|in conversation|salon|roundtable|round table|invite[- ]only|invitation[- ]only|private (dinner|event|gathering|salon)|closed[- ]door|founders? only|demo day|pitch)\b/i;
const BUILD = /\b(hackathon|hack day|build night|builders night)\b/i;
const ONLINE = /\b(virtual|online|zoom|webinar|livestream|live stream)\b/i;
const VENDOR = /\b(webinar|training|certification|bootcamp|what['’]s new|office hours|open house|info session|user group|job fair|career fair|recruiting|happy hour|mixer|speed networking|networking (night|event|mixer)|coffee|walk|course|class|lesson|tutorial)\b/i;
const WORKSHOP = /\b(workshop|hands-on)\b/i;
const WOMEN = /\b(women|womxn|woman|female|ladies|girls?|she\/her|femme|mujeres|sisters?)\b/i;
const NON_LATIN = /[一-鿿぀-ヿ가-힯Ѐ-ӿ؀-ۿऀ-ॿ]/;
const IRREL = (CFG.skipTitlePatterns || []).length ? new RegExp(CFG.skipTitlePatterns.join('|'), 'i') : /$^/;

function score(title, body, requireApproval) {
  let relevance = 0;
  for (const re of TOPICS) { if (re.test(title)) relevance += 30; else if (re.test(body)) relevance += 10; }
  let signal = 0;
  if (NAMES.test(title)) signal += 30; else if (NAMES.test(body)) signal += 20;
  if (FORMATS.test(title)) signal += 20; else if (BUILD.test(title)) signal += 10;
  if (requireApproval) signal += 10;
  if (VENDOR.test(title)) signal -= 40;
  if (WORKSHOP.test(title) && !/hackathon/i.test(title)) signal -= 20;
  return { relevance, signal };
}

// ---------- sweep ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seen = new Map();
const keywords = CFG.keywords || [];
console.error(`sweeping ${keywords.length} keywords (≈${Math.round(keywords.length * 2.2)}s)…`);
for (const kw of keywords) {
  const url = `https://api.luma.com/discover/get-paginated-events?query=${encodeURIComponent(kw)}&pagination_limit=100`;
  try {
    const r = await fetch(url, { headers: { 'accept': 'application/json' } });
    if (r.status === 429) { console.error(`  429 on "${kw}", sleeping 60s`); await sleep(60000); continue; }
    if (!r.ok) { console.error(`  ${r.status} on "${kw}"`); continue; }
    const j = await r.json();
    for (const e of j.entries || []) {
      const slug = e.event?.url; if (!slug) continue;
      if (!seen.has(slug)) seen.set(slug, { e, kw });
    }
  } catch (err) { console.error(`  fetch failed on "${kw}": ${String(err).slice(0, 80)}`); }
  await sleep(2000);
}
console.error(`${seen.size} unique events found`);

// ---------- filter ----------
const winEnd = new Date(now.getTime() + DAYS * 86400000);
const cities = new Set((CFG.cities || []).map((c) => c.toLowerCase()));
const counts = {};
const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
const rows = [];
for (const [slug, { e, kw }] of seen) {
  const ev = e.event || {};
  const start = new Date(e.start_at || ev.start_at);
  if (!(start > now && start < winEnd)) { bump('outside window'); continue; }
  if ((ev.timezone || '') !== CFG.timezone) { bump('other timezone'); continue; }
  const city = (ev.geo_address_info?.city || '').toLowerCase();
  if (city && cities.size && !cities.has(city)) { bump('other city'); continue; }
  if (CFG.noOnline !== false && (ev.location_type && ev.location_type !== 'offline')) { bump('online'); continue; }
  if (CFG.noOnline !== false && ONLINE.test(ev.name || '')) { bump('online'); continue; }
  const ti = e.ticket_info || {};
  if (CFG.noPaid !== false && ti.is_free === false) { bump('paid'); continue; }
  if (ti.is_sold_out && !e.waitlist_active) { bump('sold out'); continue; }
  if (e.registration_availability && e.registration_availability !== 'open' && e.registration_availability !== 'sold-out') { bump('closed'); continue; }
  if (done.has(slug)) { bump('already processed'); continue; }
  if ((CFG.skipSlugs || []).includes(slug)) { bump('skipSlugs'); continue; }
  const hosts = (e.hosts || []).map((h) => h.name).join(', ');
  const cal = e.calendar?.name || '';
  const title = ev.name || '';
  if (CFG.skipWomenFocused !== false && WOMEN.test(`${title} ${hosts} ${cal}`)) { bump('women-focused'); continue; }
  if (IRREL.test(title)) { bump('skip pattern'); continue; }
  if (CFG.skipNonLatinTitles !== false && NON_LATIN.test(title)) { bump('non-latin title'); continue; }
  const { relevance, signal } = score(title, `${hosts} ${cal}`, !!ti.require_approval);
  const high = relevance >= 20 && signal >= 20;
  const relevant = relevance >= 20;
  if (!flag('all')) {
    if (flag('broad') ? !relevant : (CFG.highSignalOnly !== false ? !high : !relevant)) { bump(high ? 'x' : relevant ? 'low signal' : 'not relevant'); continue; }
  }
  rows.push({ slug, title, start: start.toISOString(), city: ev.geo_address_info?.city || '', hosts, calendar: cal, relevance, signal, approval: !!ti.require_approval, keyword: kw });
}
rows.sort((a, b) => (b.signal - a.signal) || (b.relevance - a.relevance) || (a.start < b.start ? -1 : 1));
const cap = Number(CFG.maxPerNight || 80);
const kept = rows.slice(0, cap);

fs.writeFileSync(OUT, JSON.stringify({ run: RUN, builtAt: now.toISOString(), days: DAYS, mode: flag('all') ? 'all' : flag('broad') ? 'broad' : (CFG.highSignalOnly !== false ? 'high-signal' : 'broad'), slugs: kept.map((r) => r.slug), events: kept }, null, 2));

// ---------- report ----------
const fmt = (d) => new Date(d).toLocaleString('en-US', { timeZone: CFG.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
console.log(`queue ${RUN} — ${kept.length} events (${rows.length} passed, cap ${cap})`);
console.log('sig  rel  when             slug        title  |  hosts');
for (const r of kept) console.log(`${String(r.signal).padStart(3)}  ${String(r.relevance).padStart(3)}  ${fmt(r.start).padEnd(16)} ${r.slug.padEnd(11)} ${r.title.slice(0, 60)}  |  ${r.hosts.slice(0, 40)}`);
console.error('dropped: ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', '));
console.error(`wrote ${path.relative(ROOT, OUT)}`);
