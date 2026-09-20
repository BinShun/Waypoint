/* verify:calendar — §19: a time view you can walk into, not a picture.
 *
 * WHY THIS EXISTS
 * ---------------
 * §19 asked for a Calendar that shows next steps, interactions and due
 * dates — and warned, in the same breath, against decorative features.
 * The test of "not decorative" is simple: every dot on the grid must be a
 * door. This suite proves it the blunt way — it clicks things.
 *
 * The month grid is built from records that already exist, so the suite
 * seeds exactly one of each kind on days that are safely inside the
 * current month (never straddling a month end), plus the two things that
 * must NOT appear: a finished step and a parked deal's close date. The
 * overdue work is named above the grid whatever month it fell in, which
 * is the calendar's way of never reading quieter than the work is.
 *
 * Run from customer-workbench/:  npm run verify:calendar
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
const PORT = Number(process.env.CAL_PORT || 8877);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const PASSWORD = 'Waypoint#2026';
const SOURCE = (await import('node:fs')).readFileSync(join(ROOT, 'Waypoint-v1.html'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const now = new Date();
const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
const dom = now.getDate();
const today = ym + '-' + String(dom).padStart(2, '0');
const day5 = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
/* A second date that is always inside the current month, never today, and
   never past either edge — the month grid is exactly one month wide. */
const otherDay = ym + '-' + String(Math.min(Math.max(dom >= 15 ? dom - 7 : dom + 7, 1), 28)).padStart(2, '0');

/* ------------------------------------------------------------------- seed */

const CA = 'cA', CB = 'cB';
const mkCust = (id, name, extra = {}) => ({
  id, name, industry: 'Testing', hq: 'Kuala Lumpur', size: '',
  stance: 'Undecided', health: 'Watch', owner: 'Calendar Admin', sa: '',
  since: '2026-01', site: '', logo: '', people: '',
  brief: '', pains: [], contacts: [], apps: [], timeline: [],
  support: [], team: [], demo: false, unverified: false, links: [], sources: [],
  opps: [], ...extra,
});

const customers = [ mkCust(CA, 'Alpha Calendar Sdn'), mkCust(CB, 'Beta Calendar Bhd') ];

const opps = {
  oOpen: { id: 'oOpen', c: CA, t: 'The closing deal', stage: 'Evaluating', v: 300000, p: 40,
    stageAt: day5(-3), owner: 'Calendar Admin', comp: '-', close: otherDay, cust: '', desc: '', soln: '' },
  /* Parked: off the stage list, so its close date closes nothing. */
  oWon: { id: 'oWon', c: CA, t: 'The won deal', stage: 'Won', v: 900000, p: 100,
    stageAt: day5(-30), owner: 'Calendar Admin', comp: '-', close: otherDay, cust: '', desc: '', soln: '' },
};

const steps = [
  /* Due today — lands in today's outlined cell. */
  { id: 'sToday', c: CA, t: 'The call to schedule today', exec: 'Calendar Admin', track: 'Calendar Admin',
    due: today, w: '', from: 'us', p: 'p1', done: '', doneBy: '', doneNote: '' },
  /* Due on another day of this month. */
  { id: 'sSoon', c: CB, t: 'The architecture note', exec: 'Calendar Admin', track: 'Calendar Admin',
    due: otherDay, w: '', from: 'us', p: 'p1', done: '', doneBy: '', doneNote: '' },
  /* Finished — nags nobody, dots nothing. */
  { id: 'sDone', c: CA, t: 'The finished survey', exec: 'Calendar Admin', track: 'Calendar Admin',
    due: otherDay, w: '', from: 'us', p: 'p2', done: day5(-1), doneBy: 'Calendar Admin', doneNote: '' },
  /* Overdue — belongs above the grid, whatever month it fell in. */
  { id: 'sLate', c: CB, t: 'The late promise', exec: 'Calendar Admin', track: 'Calendar Admin',
    due: day5(-5), w: '', from: 'us', p: 'p1', done: '', doneBy: '', doneNote: '' },
  /* Undated — named under the grid, where it cannot hide. */
  { id: 'sNever', c: CB, t: 'The undated follow-up', exec: 'Calendar Admin', track: 'Calendar Admin',
    due: '', w: '', from: 'us', p: 'p1', done: '', doneBy: '', doneNote: '' },
];

const interactions = [
  { id: 'mCal', c: CA, t: 'The workshop we ran', d: otherDay, w: '', loc: 'Their office',
    att: 'Their CTO', ours: 'Calendar Admin', sum: '', out: 'Positive', k: 'Call' },
];

const dir = mkdtempSync(join(tmpdir(), 'wp-cal-'));
const at = new Date().toISOString();
{
  const salt = randomBytes(16);
  writeFileSync(join(dir, 'workbench.json'), JSON.stringify({
    schemaVersion: 1, setupComplete: true,
    users: [{ id: 'u_admin', name: 'Calendar Admin', email: 'calendar.admin@global.tencent.com',
      role: 'admin', title: 'Senior Solution Architect', createdAt: at, updatedAt: at }],
    credentials: { u_admin: {
      userId: 'u_admin', algo: 'pbkdf2-sha256', iterations: 150_000,
      salt: salt.toString('base64'),
      hash: pbkdf2Sync(PASSWORD, salt, 150_000, 32, 'sha256').toString('base64'),
      createdAt: at, updatedAt: at } },
    customers, opps, steps, interactions,
    team: [], audit: [], files: [], watch: [], logs: [],
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
  e.value = 'calendar.admin@global.tencent.com'; p.value = PASSWORD;
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
console.log('\n— §19: a time view you can walk into, not a picture —');

check('admin signs in', /Today|Customers/.test(s.text()), s.text().slice(0, 40));
check('the rail carries the Calendar', !!s.$('[data-go="calendar"]'));

await s.click(s.$('[data-go="calendar"]'), 800);
let t = s.text();
check('the screen names the month it is showing',
  t.includes('Calendar') && t.includes(MON[now.getMonth()] + ' ' + now.getFullYear()),
  'expected ' + MON[now.getMonth()] + ' ' + now.getFullYear());
check('today\u2019s cell is outlined, not just numbered',
  (() => {
    const cell = s.$$('#page div').find(d => (d.getAttribute('style') || '').includes('outline:2px solid var(--blue)'));
    return !!(cell && (cell.textContent || '').trim().startsWith(String(dom)));
  })(),
  'the outlined cell should be day ' + dom);

/* ------------------------------------------------- what is on the grid */
check('a next step due today is on the grid', t.includes('The call to schedule today'));
check('a next step due later this month is on the grid', t.includes('The architecture note'));
check('an interaction sits on its date', t.includes('The workshop we ran'));
check('an open opportunity\u2019s close date sits on its date', t.includes('The closing deal'));

/* --------------------------------------------- what is NOT on the grid */
check('a finished step dots nothing', !t.includes('The finished survey'));
check('a parked deal\u2019s close date closes nothing', !t.includes('The won deal'));

/* --------------------------------------------------------- the overdue */
check('the overdue work is named above the grid', t.includes('The late promise'));
check('and says how late, in days', /due \d+ \w+/.test(t));

/* ------------------------------------------------------ the undated */
check('the undated work is named under the grid, and is a door too',
  !!byText('#page [data-cgo]', 'The undated follow-up')
  && (byText('#page [data-cgo]', 'The undated follow-up').textContent || '').includes('no date'));

/* ------------------------------------------------------- the doors open */
{
  const door = byText('#page [data-cgo]', 'The architecture note');
  check('a grid entry is a door, not a picture', !!door);
  await s.click(door, 900);
  t = s.text();
  check('clicking a step opens the account on its timeline',
    t.includes('Beta Calendar Bhd') && (win.location.hash.includes('tab=timeline') || t.includes('Timeline')),
    'hash=' + win.location.hash);
}
{
  await s.click(s.$('[data-go="calendar"]'), 700);
  const door = byText('#page [data-cgo]', 'The closing deal');
  check('a close-date entry names the tab it opens', !!door && (door.getAttribute('title') || '').includes('opportunities'));
  await s.click(door, 900);
  t = s.text();
  check('clicking a close date opens the account\u2019s opportunities',
    t.includes('Alpha Calendar Sdn') && (win.location.hash.includes('tab=opportunities') || t.includes('The closing deal')),
    'hash=' + win.location.hash);
}

/* ------------------------------------------------------- month travel */
{
  await s.click(s.$('[data-go="calendar"]'), 700);
  await s.click(s.$('[data-cal="prev"]'), 700);
  t = s.text();
  const prevName = now.getMonth() === 0 ? 'Dec ' + (now.getFullYear() - 1) : MON[now.getMonth() - 1] + ' ' + now.getFullYear();
  check('the previous month answers by name', t.includes(prevName), 'expected ' + prevName);
  check('the URL stayed put — the month is a conversation, not a place',
    win.location.hash.includes('calendar') && !win.location.hash.includes('month'), win.location.hash);
  await s.click(s.$('[data-cal="next"]'), 700);
  await s.click(s.$('[data-cal="today"]'), 700);
  t = s.text();
  check('This month comes back to the month you are in',
    t.includes(MON[now.getMonth()] + ' ' + now.getFullYear()));
}

/* ------------------------------------------------- the address itself */
check('the calendar has an address of its own', win.location.hash.includes('#/calendar'), win.location.hash);

/* ------------------------------------------------- nothing was harmed */
check('the two customers are still on the server',
  (disk().customers || []).length === 2, (disk().customers || []).length + ' on disk');
check('the page threw nothing while being used', pageErrors.length === 0,
  pageErrors.slice(0, 2).join(' | '));

console.log('\n' + (fail ? `${fail} FAILED, ` : '') + `${pass} passed`);
bye();
process.exit(fail ? 1 : 0);
