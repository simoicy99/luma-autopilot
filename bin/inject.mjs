#!/usr/bin/env node
// Bundles profile.json + config.json + tonight's run id + browser/pipeline.js
// into ONE JavaScript blob that Claude evaluates in the luma.com tab.
//
//   node bin/inject.mjs            # writes state/inject-<MMDD>.js and prints its path
//   node bin/inject.mjs --run 0930
//
// The blob is written to a file (not printed) because Claude's javascript tool
// takes it verbatim and the file is the easiest thing to read in whole.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const i = args.indexOf('--run');
const now = new Date();
const RUN = i >= 0 && args[i + 1] ? args[i + 1] : `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

for (const f of ['profile.json', 'config.json']) {
  if (!fs.existsSync(path.join(ROOT, f))) { console.error(`missing ${f}`); process.exit(2); }
}
const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'profile.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const engine = fs.readFileSync(path.join(ROOT, 'browser', 'pipeline.js'), 'utf8');

const problems = [];
if (!/^\+\d{8,15}$/.test(profile.phone || '')) problems.push('profile.phone must be E.164, e.g. +14155550123 (Luma rejects raw digits)');
if (profile.linkedin && !/^\/in\//.test(profile.linkedin)) problems.push('profile.linkedin must be the path form "/in/handle", not a full URL');
if (!profile.email || !profile.first || !profile.last) problems.push('profile.email, first and last are required');
if (!config.timezone) problems.push('config.timezone is required');
if (problems.length) { console.error('profile/config problems:\n  - ' + problems.join('\n  - ')); process.exit(2); }

const blob = `window.__P=${JSON.stringify(profile)};\nwindow.__CFG=${JSON.stringify(config)};\nwindow.__RUN=${JSON.stringify(RUN)};\n${engine}`;
const out = path.join(ROOT, 'state', `inject-${RUN}.js`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, blob);
console.log(out);
console.error(`${Math.round(blob.length / 1024)} KB, run ${RUN}`);
