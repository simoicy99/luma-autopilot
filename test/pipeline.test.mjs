// Offline tests for browser/pipeline.js. No network, no browser, no real Luma.
//
//   node --test test/pipeline.test.mjs
//
// The engine is evaluated in a node:vm sandbox that stands in for a luma.com tab:
// fetch() serves a fixture event page, localStorage is in-memory, and timers fire
// immediately so the 2.7 s classify pacing does not slow the suite. Tests drive the
// same public surface the runbook uses (__classifyRun, then the stored plan) and
// assert on the resulting classification and answers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = fs.readFileSync(path.join(ROOT, 'browser', 'pipeline.js'), 'utf8');
const RUN = 'test';
const TZ = 'America/Los_Angeles';

// Fictional profile; never the owner's profile.json.
function profile({ facts = {}, policy = {} } = {}) {
  return {
    email: 'ada@example.com', first: 'Ada', last: 'Lovelace', phone: '+14155550123',
    company: 'Analytical Engines', title: 'Founder', linkedin: '/in/ada', website: 'https://example.com',
    city: 'San Francisco', country: 'United States', blurb: 'Building an early-stage AI startup.',
    facts: { isFounder: true, companySize: '2-10', yc: false, ...facts },
    policy: { agreeToTerms: true, joinCommunities: true, ...policy },
  };
}

const CONFIG = { timezone: TZ, regionWords: ['san francisco'], noOnline: true };

function eventPage(questions) {
  const data = {
    api_id: 'evt-1',
    event: { name: 'Founders Dinner', url: 'dinner', timezone: TZ, location_type: 'offline', geo_address_info: { city: 'San Francisco' }, start_at: '2026-11-10T02:00:00Z' },
    hosts: [{ name: 'Host' }], calendar: { name: 'Calendar' }, guest_data: {},
    ticket_types: [{ api_id: 'tt-free', type: 'free' }],
    registration_availability: 'open',
    registration_questions: questions,
  };
  const next = { props: { pageProps: { initialData: { data } } } };
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script></html>`;
}

// Evaluate the engine in a fresh sandbox and classify one event; returns the stored plan.
async function classify(questions, profileOpts) {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const requests = [];
  const sandbox = {
    localStorage,
    // Fake timer: run on the next macrotask regardless of the requested delay.
    setTimeout: (fn) => setImmediate(fn),
    fetch: async (url, init = {}) => {
      requests.push({ url, method: init.method || 'GET' });
      if (url === 'https://luma.com/dinner') return { status: 200, text: async () => eventPage(questions) };
      return { status: 404, text: async () => '' };
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`window.__P = ${JSON.stringify(profile(profileOpts))}; window.__CFG = ${JSON.stringify(CONFIG)}; window.__RUN = '${RUN}';`, sandbox);
  vm.runInContext(ENGINE, sandbox, { filename: 'pipeline.js' });
  localStorage.setItem('__q' + RUN, JSON.stringify(['dinner']));

  assert.equal(await sandbox.__classifyRun(), 'done');
  // The vm context has no real fetch; this stub is its only network. Classification may read
  // the fixture page and nothing else: no other URL, and never the register endpoint.
  assert.deepEqual(requests, [{ url: 'https://luma.com/dinner', method: 'GET' }]);
  return JSON.parse(localStorage.getItem('__cls' + RUN)).dinner;
}

const answerFor = (plan, id) => (plan.answers || []).find((a) => a.question_id === id);

test('required question about current membership is left for the human', async () => {
  const plan = await classify([
    { id: 'q1', question_type: 'select', required: true, label: 'Are you a member of South Park Commons?', options: ['Yes', 'No', 'Not a member'] },
  ]);
  assert.equal(plan.cls, 'NEEDS-HUMAN');
  assert.equal(plan.needs.length, 1);
});

test('a single-option membership question is not auto-accepted', async () => {
  const plan = await classify([
    { id: 'q1', question_type: 'select', required: true, label: 'Membership', options: ["Yes, I'm a current member"] },
  ]);
  assert.equal(plan.cls, 'NEEDS-HUMAN');
});

test('a required checkbox attesting membership is not ticked', async () => {
  const plan = await classify([
    { id: 'q1', question_type: 'checkbox', required: true, label: 'I confirm I am a current member of the AI Collective' },
  ]);
  assert.equal(plan.cls, 'NEEDS-HUMAN');
});

test('unknown optional membership question is omitted, event stays READY', async () => {
  const plan = await classify([
    { id: 'q1', question_type: 'select', required: false, label: 'Are you an alumni of our accelerator?', options: ['Yes', 'No'] },
    { id: 'q2', question_type: 'text', required: true, label: 'Company' },
  ]);
  assert.equal(plan.cls, 'READY');
  assert.equal(answerFor(plan, 'q1'), undefined);
  assert.equal(answerFor(plan, 'q2').value, 'Analytical Engines');
});

const JOIN_Q = { id: 'j', question_type: 'select', required: true, label: 'Would you like to join our community Slack?', options: ["Yes, I'm already a member", 'Yes, add me', 'No thanks'] };

test('prospective join with joinCommunities on picks the join option, not "already a member"', async () => {
  const plan = await classify([JOIN_Q], { policy: { joinCommunities: true } });
  assert.equal(plan.cls, 'READY');
  assert.deepEqual(answerFor(plan, 'j').value, ['Yes, add me']);
});

test('prospective join with joinCommunities off declines', async () => {
  const plan = await classify([JOIN_Q], { policy: { joinCommunities: false } });
  assert.equal(plan.cls, 'READY');
  assert.deepEqual(answerFor(plan, 'j').value, ['No thanks']);
});

test('policy off never falls back to claiming membership', async () => {
  const plan = await classify([
    { id: 'j', question_type: 'select', required: true, label: 'Want to join our builders community?', options: ['Already a member', 'Yes'] },
  ], { policy: { joinCommunities: false } });
  assert.equal(plan.cls, 'NEEDS-HUMAN');
});

test('policy on with only a membership claim available leaves it for the human', async () => {
  for (const label of ['Want to join our builders community?', 'Interested in becoming a member?']) {
    const plan = await classify([
      { id: 'j', question_type: 'select', required: true, label, options: ['Already a member', 'No'] },
    ], { policy: { joinCommunities: true } });
    assert.equal(plan.cls, 'NEEDS-HUMAN', label);
  }
});

test('YC questions need an explicit yc fact', async () => {
  const q = { id: 'yc', question_type: 'select', required: true, label: 'Are you a YC company?', options: ['Yes', 'No'] };
  assert.equal((await classify([q], { facts: { yc: null } })).cls, 'NEEDS-HUMAN');
  const known = await classify([q], { facts: { yc: false } });
  assert.equal(known.cls, 'READY');
  assert.deepEqual(answerFor(known, 'yc').value, ['No']);
});

test('ordinary profile facts and terms still answer as before', async () => {
  const plan = await classify([
    { id: 'size', question_type: 'select', required: true, label: 'Company size', options: ['1', '2-10', '11-50'] },
    { id: 'mail', question_type: 'email', required: true, label: 'Email' },
    { id: 'coc', question_type: 'checkbox', required: true, label: 'I agree to the code of conduct' },
    { id: 'team', question_type: 'select', required: false, label: 'How many team members will you bring?', options: ['Just me', '2', '3+'] },
  ]);
  assert.equal(plan.cls, 'READY');
  assert.deepEqual(answerFor(plan, 'size').value, ['2-10']);
  assert.equal(answerFor(plan, 'mail').value, 'ada@example.com');
  assert.equal(answerFor(plan, 'coc').value, true);
  assert.deepEqual(answerFor(plan, 'team').value, ['Just me']);
});

test('join consent never uses an option that states membership (curly or straight quotes)', async () => {
  for (const claim of ['Yes, I’m a member', "Yes, I'm a member", 'Yes, a member', 'Yes – I’m already part of the community']) {
    const withJoin = await classify([
      { id: 'j', question_type: 'select', required: true, label: 'Would you like to join our community Slack?', options: [claim, 'Yes, add me', 'No thanks'] },
    ], { policy: { joinCommunities: true } });
    assert.equal(withJoin.cls, 'READY', claim);
    assert.deepEqual(answerFor(withJoin, 'j').value, ['Yes, add me'], claim);

    const onlyClaim = await classify([
      { id: 'j', question_type: 'select', required: true, label: 'Would you like to join our community Slack?', options: [claim, 'No'] },
    ], { policy: { joinCommunities: true } });
    assert.equal(onlyClaim.cls, 'NEEDS-HUMAN', claim);
  }
});

test('a prospective option about becoming a member is still a valid join answer', async () => {
  const plan = await classify([
    { id: 'j', question_type: 'select', required: true, label: 'Interested in becoming a member?', options: ['Yes, I’d like to become a member', 'No thanks'] },
  ], { policy: { joinCommunities: true } });
  assert.equal(plan.cls, 'READY');
  assert.deepEqual(answerFor(plan, 'j').value, ['Yes, I’d like to become a member']);
});

test('text membership question mentioning an organization is left for the human', async () => {
  const label = 'Are you a member of our organization?';
  const required = await classify([{ id: 't', question_type: 'text', required: true, label }]);
  assert.equal(required.cls, 'NEEDS-HUMAN');

  const optional = await classify([
    { id: 't', question_type: 'text', required: false, label },
    { id: 'c', question_type: 'text', required: true, label: 'Company' },
  ]);
  assert.equal(optional.cls, 'READY');
  assert.equal(answerFor(optional, 't'), undefined);
});

test('plain employer text fields still get company details', async () => {
  const plan = await classify([
    { id: 'org', question_type: 'text', required: true, label: 'Organization' },
    { id: 'aff', question_type: 'text', required: true, label: 'Professional affiliation:' },
  ]);
  assert.equal(plan.cls, 'READY');
  assert.equal(answerFor(plan, 'org').value, 'Analytical Engines');
  assert.equal(answerFor(plan, 'aff').value, 'Founder, Analytical Engines');
});
