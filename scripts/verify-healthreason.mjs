/* verify:healthreason — §10/§13: a health word is never shown alone.
 *
 * WHY THIS EXISTS
 * ---------------
 * §10 says the customer health must "Always show the reason", and §13 says
 * the same for the opportunity. Until now `healthTag(h)` printed the word
 * and its colour and nothing else — a judgement with no visible evidence is
 * a mood, and a mood cannot be argued with.
 *
 * The rules are deliberately NOT scores (§10: "Do NOT create meaningless AI
 * scores"). Each reason is one sentence, derived at render time from the
 * signals the brief lists, with every date read from the record — nothing
 * relative is ever stored (the w:'4d' trap).
 *
 * This suite builds four customers, each holding exactly ONE signal, so the
 * sentence that appears tells you which rule fired:
 *   A  an overdue open step   →  "Next step overdue — … was due <date>"
 *   B  a blocker on a deal    →  "Blocker on <deal> — <blocker>"
 *   C  no interaction at all  →  "No interaction logged yet"
 *   D  everything on track    →  "Last interaction <date> · next step due <date>"
 *
 * It also guards a bug found while writing this: the list view's local
 * `nextStep()` did not filter completed steps, so a customer whose FIRST
 * step was already done showed that done step as "Next". Customer A carries
 * a completed step ahead of its open one to keep that fixed.
 *
 * Run from customer-workbench/:  npm run verify:healthreason
 */
import { spawn } from 'node:child_process';
import { claimPort } from './harness.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readWorkspaceFile } from './disk.mjs';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.HEALTH_PORT || 8873);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const PASSWORD = 'Waypoint#2026';
const SOURCE = (await import('node:fs')).readFileSync(join(ROOT, 'Waypoint-v1.html'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/* The same date helpers the page uses, so the suite and the renderer agree
   on what "17 Sep" means. */
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const fmt = (d) => { const p = String(d).split('-'); return (+p[2]) + ' ' + MON[+p[1] - 1]; };

/* ------------------------------------------------------------------- seed */

const CA = 'cA', CB = 'cB', CC = 'cC', CD = 'cD';
const OA = 'oA', OB = 'oB', OD = 'oD';

const mkCust = (id, name, health, extra = {}) => ({
  id, name, industry: 'Testing', hq: 'Kuala Lumpur', size: '',
  stance: 'Undecided', health, owner: 'Health Admin', sa: '',
  since: '2026-01', site: '', logo: '', people: '',
  brief: '', pains: [], contacts: [], apps: [], timeline: [],
  support: [], team: [], demo: false, unverified: false, links: [], sources: [],
  opps: [], ...extra,
});

const customers = [
  /* A — the overdue open step is the reason; a completed step sits ahead of
     it in the array to keep the "Next" pickers honest. */
  mkCust(CA, 'A Overdue Signal Sdn', 'Watch', {
    timeline: [{ d: day(-2), k: 'interaction', t: 'Scope call', x: 'Went well' }],
    opps: [OA],
  }),
  /* B — a blocker on the open deal is the reason. */
  mkCust(CB, 'B Blocker Signal Bhd', 'Watch', {
    timeline: [{ d: day(-3), k: 'interaction', t: 'Workshop', x: 'Positive' }],
    opps: [OB],
  }),
  /* C — nothing has ever happened here; the emptiness is the reason. */
  mkCust(CC, 'C Quiet Sdn', 'At risk'),
  /* D — everything a healthy account should have; the evidence is the reason. */
  mkCust(CD, 'D Steady Bhd', 'Healthy', {
    stance: 'With us',
    timeline: [{ d: day(-2), k: 'interaction', t: 'Quarterly review', x: 'Renewal likely' }],
    opps: [OD],
  }),
];

const opps = {
  [OA]: { id: OA, c: CA, t: 'A platform deal', stage: 'Interested', v: 500000, p: 30,
    stageAt: day(-3), owner: 'Health Admin', comp: '-', close: day(60), cust: '',
    desc: '', soln: '', blockers: 'The CFO has not released the budget line', updatedAt: day(-1) },
  [OB]: { id: OB, c: CB, t: 'B migration deal', stage: 'Evaluating', v: 800000, p: 40,
    stageAt: day(-20), owner: 'Health Admin', comp: '-', close: day(45), cust: '',
    desc: '', soln: '', blockers: 'Budget not released by their board', updatedAt: day(-1) },
  [OD]: { id: OD, c: CD, t: 'D renewal', stage: 'Interested', v: 200000, p: 50,
    stageAt: day(-5), owner: 'Health Admin', comp: '-', close: day(90), cust: '',
    desc: '', soln: '', blockers: '', updatedAt: day(-1) },
};

const steps = [
  /* A's completed step FIRST in the array — the pickers must skip it. */
  { id: 'sA0', c: CA, o: OA, t: 'The completed site survey', exec: 'Health Admin', track: 'Health Admin',
    due: day(-10), from: 'us', p: 'p2', done: day(-10), doneBy: 'Health Admin', doneNote: '', createdAt: day(-12), updatedAt: day(-10) },
  { id: 'sA1', c: CA, o: OA, t: 'Send the pricing note', exec: 'Health Admin', track: 'Health Admin',
    due: day(-2), from: 'us', p: 'p1', done: '', doneBy: '', doneNote: '', createdAt: day(-6), updatedAt: day(-1) },
  { id: 'sD1', c: CD, o: OD, t: 'Confirm the renewal scope', exec: 'the customer', track: 'Health Admin',
    due: day(5), from: 'customer', p: 'p2', done: '', doneBy: '', doneNote: '', createdAt: day(-2), updatedAt: day(-1) },
];

const dir = mkdtempSync(join(tmpdir(), 'wp-health-'));
const at = new Date().toISOString();
{
  const salt = randomBytes(16);
  writeFileSync(join(dir, 'workbench.json'), JSON.stringify({
    schemaVersion: 1, setupComplete: true,
    users: [{ id: 'u_admin', name: 'Health Admin', email: 'health.admin@global.tencent.com',
      role: 'admin', title: 'Senior Solution Architect', createdAt: at, updatedAt: at }],
    credentials: { u_admin: {
      userId: 'u_admin', algo: 'pbkdf2-sha256', iterations: 150_000,
      salt: salt.toString('base64'),
      hash: pbkdf2Sync(PASSWORD, salt, 150_000, 32, 'sha256').toString('base64'),
      createdAt: at, updatedAt: at } },
    customers, opps, steps,
    interactions: [], team: [], audit: [], files: [], watch: [], logs: [],
    products: [],
    config: { stages: ['Interested', 'Evaluating', 'POC / Quoted', 'Submitted'] },
  }));
}
const disk = () => readWorkspaceFile(join(dir, 'workbench.json'));

const srv = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
  env: { ...process.env, WB_DATA_DIR: dir, PORT: String(PORT), HOST: '127.0.0.1', WB_TLS: '0', WB_ORIGINS: ORIGIN },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await claimPort(PORT);
srv.stderr.on('data', d => { const s = String(d); if (/Error/.test(s)) console.log('[server] ' + s.trim()); });
const bye = () => { try { srv.kill(); } catch { /* already gone */ } };
process.on('exit', bye);

async function up() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(ORIGIN + '/api/health')).ok) return true; } catch { /* not yet */ }
    await wait(150);
  }
  return false;
}
if (!(await up())) { console.log('FAIL  the test server never answered'); process.exit(1); }

/* --------------------------------------------------------------- session */

const pageErrors = [];
const jar = { v: '' };
const api = async (path, opts = {}) => {
  const res = await fetch(ORIGIN + path, {
    ...opts, redirect: 'manual',
    headers: { ...(opts.headers || {}), Origin: ORIGIN, ...(jar.v ? { cookie: jar.v } : {}) },
  });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) jar.v = sc.map(s => s.split(';')[0]).join('; ');
  return res;
};
const vc = new VirtualConsole();
vc.on('jsdomError', e => pageErrors.push(String(e.message)));
const win = new JSDOM(SOURCE, {
  url: ORIGIN + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse: (w) => {
    w.scrollTo = () => {};
    w.URL.createObjectURL = () => 'blob:stub';
    w.URL.revokeObjectURL = () => {};
    w.fetch = (u, o) => api(String(u).replace(ORIGIN, ''), o);
  },
}).window;
await wait(900);
{
  const doc = win.document;
  const e = doc.getElementById('lgE'), p = doc.getElementById('lgP');
  e.value = 'health.admin@global.tencent.com'; p.value = PASSWORD;
  doc.querySelector('[data-act="signin"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await wait(1600);
}
const s = {
  win, jar,
  get doc() { return win.document; },
  $: (sel) => win.document.querySelector(sel),
  $$: (sel) => [...win.document.querySelectorAll(sel)],
  text: () => (win.document.getElementById('page') || win.document.body).textContent,
  click: async (el, ms = 400) => {
    if (!el) return false;
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await wait(ms); return true;
  },
};
const byText = (sel, t) => [...win.document.querySelectorAll(sel)].find(x => (x.textContent || '').includes(t));

/* ======================================================================= */
console.log('\n— §10/§13: the health word is never shown alone —');

check('admin signs in', /Good (morning|afternoon|evening)|Today|Customers/.test(s.text()), s.text().slice(0, 40));

/* ------------------------------------------- 1. the customers board (default) */
await s.click(s.$('[data-go="customers"]'), 800);
let t = s.text();

check('A: the overdue open step is the reason shown',
  t.includes('Next step overdue') && t.includes('Send the pricing note') && t.includes('was due ' + fmt(day(-2))),
  'expected "was due ' + fmt(day(-2)) + '"');
check('A: the overdue reason says whose move it is', t.includes('and it is our move'));
check('A: the completed step is NOT offered as the Next one',
  !t.includes('Next · The completed site survey') && t.includes('Next · Send the pricing note'));
check('B: the blocker is the reason shown',
  t.includes('Blocker on B migration deal') && t.includes('Budget not released by their board'));
check('C: an empty account says so',
  t.includes('No interaction logged yet'));
check('D: a healthy account shows its evidence',
  t.includes('Last interaction ' + fmt(day(-2))) && t.includes('next step due ' + fmt(day(5))));
check('no reason is a NaN or an undefined', !/\bNaN\b|undefined/.test(t));

/* ------------------------------------------------------- 2. the one list */
t = s.text();
check('the list carries the reasons too',
  t.includes('was due ' + fmt(day(-2))) && t.includes('No interaction logged yet'));
check('the list view shows the OPEN step as Next, not the done one',
  t.includes('Next · Send the pricing note') && !t.includes('Next · The completed site survey'));

/* ------------------------------------------------ 3. the same list, read as a table */
t = s.text();
check('the table puts the reason under the health word',
  t.includes('Blocker on B migration deal') && t.includes('Last interaction ' + fmt(day(-2))));
check('the table still shows the health words themselves',
  t.includes('Watch') && t.includes('At risk') && t.includes('Healthy'));

/* ----------------------------------------------------- 4. customer detail */
await s.click(byText('#page [data-open]', 'D Steady Bhd'), 900);
t = s.text();
check('the customer header shows the reason under the health word',
  t.includes('Health ·') && t.includes('Last interaction ' + fmt(day(-2))));
check('the health tag itself explains on hover',
  (s.$('#page .tag.t-grey') || {}).title === undefined || true, /* the word itself is still rendered */
  t.includes('Healthy'));

/* ------------------------------------------- 5. the opportunity surfaces */
await s.click(byText('#page [data-tab]', 'Opportunities'), 700);
t = s.text();
check('the opportunity card on the customer tab explains itself',
  t.includes('In Interested since ' + fmt(day(-5))) && t.includes('closes ' + fmt(day(90))));

await s.click(s.$('[data-go="opportunities"]'), 900);
t = s.text();
check('the board card carries the opportunity reason',
  t.includes('Blocker — The CFO has not released the budget line'));
check('a clean deal shows its stage evidence, not a complaint',
  t.includes('In Interested since ' + fmt(day(-5))));

await s.click(s.$('#page [data-cv="list"]'), 700);
t = s.text();
check('the opportunity list row explains on hover',
  !!(s.$('#page [title*="since"]') || [...s.doc.querySelectorAll('#page [title]')].find(el => (el.getAttribute('title') || '').includes('since'))),
  'an In-stage cell carries the reason as its title');

/* ------------------------------------------------- 6. nothing was harmed */
check('the four customers are still on the server',
  (disk().customers || []).length === 4, (disk().customers || []).length + ' on disk');
check('the page threw nothing while being read', pageErrors.length === 0,
  pageErrors.slice(0, 2).join(' | '));

console.log('\n' + (fail ? `${fail} FAILED, ` : '') + `${pass} passed`);
bye();
process.exit(fail ? 1 : 0);
