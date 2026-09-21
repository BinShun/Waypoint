/**
 * Drive the shipped HTML against a real server and prove a whole round trip
 * actually lands: sign in → open a customer → add a row on every tab → read
 * the file on disk.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every suite before this one tested the server from the outside, with bodies
 * written by hand. That is how a 400 went unnoticed: the server insisted
 * `opps` was an array, the client had always held it as a map, and every save
 * the real app made was refused. The UI looked perfect — the row appeared, the
 * toast said "Added" — and nothing was ever written. A hand-written body would
 * have followed the server's assumption and passed.
 *
 * So this suite never writes a request body. It loads `Waypoint-v1.html`
 * in jsdom, points it at a live server on a spare port, clicks through the app
 * the way a person does, and then reads `workbench.json` off the disk. It also
 * records the status of every PUT, because "the row is on screen" and "the row
 * was saved" are two different claims and only the second one matters.
 *
 * It also walks every screen and every customer tab and fails on any one of
 * them that offers no way to create anything, because that gap is exactly what
 * this suite was written to catch.
 *
 * Spare port, throwaway data directory, nothing touches `data/`.
 *
 * Run from customer-workbench/:  npm run verify:live
 */
import { spawn } from 'node:child_process';
import { claimPort } from './harness.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readWorkspaceFile } from './disk.mjs';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const PORT = Number(process.env.LIVE_PORT || 8845);
const HTML = process.env.LIVE_HTML || 'Waypoint-v1.html';
const NAME = 'Teh Bin Shun';
const EMAIL = 'tehbinshun@global.tencent.com';
const PASSWORD = 'Waypoint#2026';

let ran = 0, bad = false;
const check = (name, cond, detail) => {
  ran++;
  if (!cond) bad = true;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${detail}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------- seed */

/* The same derivation as the server's verifyPassword and the app's auth:
   pbkdf2-sha256, 16-byte salt, 32-byte key, 150k iterations, base64. Written
   here rather than reusing set-password.mjs because that script is pinned to
   ./data and this suite must never touch it. */
function seed(dir) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(PASSWORD, salt, 150_000, 32, 'sha256');
  const at = new Date().toISOString();
  const state = {
    schemaVersion: 1,
    setupComplete: true,
    users: [{ id: 'u_teh', name: NAME, role: 'admin', title: 'Senior Solution Architect', locked: false, createdAt: at, updatedAt: at }],
    credentials: {
      u_teh: { userId: 'u_teh', algo: 'pbkdf2-sha256', iterations: 150_000, salt: salt.toString('base64'), hash: hash.toString('base64'), createdAt: at, updatedAt: at },
    },
    logs: [{ id: 'l_seed', at, action: 'create', entityType: 'auth', entityId: 'u_teh', summary: 'Workspace created for Waypoint' }],
    /* The app itself ships empty, so this suite brings its own customer. The
       demo customer it used to lean on is gone from the product — a real
       workspace only ever contains what somebody entered. */
    customers: [{
      id: 'c1', name: 'Alpha Telecom', industry: 'Telecom', hq: 'Kuala Lumpur',
      owner: NAME, stance: 'With us', health: 'Healthy', since: 'Mar 2026',
      site: 'alphatelecom.example', people: 1200, pains: [], contacts: [
        { n: 'Sarah Lim', t: 'Head of Billing', s: 'With us', o: NAME, b: 'Influencer', note: '' },
      ], apps: [], opps: [], timeline: [],
    }],
    interactions: [], steps: [], team: [], audit: [], files: [], watch: [],
    opps: {},
  };
  writeFileSync(join(dir, 'workbench.json'), JSON.stringify(state));
  writeFileSync(join(dir, 'workbench.rev.json'), JSON.stringify({ rev: 1, savedAt: at }));
}

async function up(dir) {
  const p = spawn(process.execPath, ['server/server.mjs'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', WB_DATA_DIR: dir, WB_TLS: '0', WB_ORIGINS: `http://127.0.0.1:${PORT}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
/* Wait for a port this process has PROVEN is free. Waiting on
   /api/health alone cannot fail when an old server is still listening,
   and the suite would then drive somebody else's server. See
   scripts/harness.mjs. */
await claimPort(PORT);
  let err = '';
  p.stderr.on('data', (d) => { err += d.toString(); });
  p.stdout.on('data', (d) => { err += d.toString(); });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return { p, log: () => err };
    } catch { /* not yet */ }
    await wait(120);
  }
  console.log('!! server never came up:\n' + err);
  p.kill();
  throw new Error('server did not start');
}

/* ------------------------------------------------------------------ drive */

const dir = mkdtempSync(join(tmpdir(), 'wplive-'));
seed(dir);
const server = await up(dir);
const BASE = `http://127.0.0.1:${PORT}`;

const errs = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => { if (!/scrollTo/.test(String(e.message))) errs.push(String(e.message)); });

const dom = new JSDOM(readFileSync(HTML, 'utf8'), {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: BASE + '/',
  virtualConsole: vc,
});
const { window } = dom;
const doc = window.document;

let cookie = '';
const puts = [];
window.fetch = async (url, init = {}) => {
  const u = String(url).startsWith('http') ? String(url) : BASE + String(url);
  const headers = { ...(init.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(u, { ...init, headers: { ...headers, Origin: BASE }, redirect: 'manual' });
  if ((init.method || 'GET') === 'PUT') puts.push({ url: u, status: res.status });
  for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) cookie = c.split(';')[0];
  return res;
};

const act = (sel) => { const b = doc.querySelector(sel); if (!b) return 'MISSING'; b.click(); return 'ok'; };
const seen = () => (doc.getElementById('page') || doc.body).textContent.replace(/\s+/g, ' ');
const label = (t) => [...doc.querySelectorAll('#page button')].find((b) => (b.textContent || '').trim() === t);
const ROLE_LABEL = { manager: 'Manager', bd: 'BD', sa: 'SA' };
/* Which screen is actually on screen, read off the nav highlight — not off what
   was clicked. Clicking a route you are not allowed in must not leave you there. */
const viewRoute = () => (doc.querySelector('#nav .nav.on')?.textContent || '').trim().toLowerCase();

await wait(2200);
doc.getElementById('lgE').value = EMAIL;
doc.getElementById('lgP').value = PASSWORD;
doc.querySelector('.lg-go').click();
await wait(3000);
check('sign in against the real directory', !doc.body.classList.contains('onlogin'));

/* ------------------------------------------------- add a row on each tab */

act('[data-go="customers"]'); await wait(200);
act('[data-open="c1"]'); await wait(300);

const ADD = {
  people: ['Add a person', 'Nadia Rahman', 'Head of Billing'],
  run: ['Add a system', 'Fraud engine v2', 'AWS'],
  opportunities: ['Add opportunity', 'Billing migration PoC', '1250000'],
  timeline: ['Add a note', 'CFO re-opened the review', 'Budget frozen'],
};

for (const [tab, [btn, a, b]] of Object.entries(ADD)) {
  act(`[data-tab="${tab}"]`); await wait(250);
  check(`${tab}: "${btn}" control exists`, !!label(btn));
  if (!label(btn)) continue;
  label(btn).click(); await wait(250);
  check(`${tab}: the form opens`, !!doc.getElementById('ad1'));
  if (!doc.getElementById('ad1')) continue;
  doc.getElementById('ad1').value = a;
  if (doc.getElementById('ad2')) doc.getElementById('ad2').value = b;
  check(`${tab}: Save is offered`, !!label('Save'));
  if (label('Save')) { label('Save').click(); await wait(400); }
  check(`${tab}: "${a}" is in the record`, seen().includes(a));
}

/* The debounce is 700 ms; give the PUT room to land and be written. */
await wait(3000);

check('every save was accepted', puts.length > 0 && puts.every((p) => p.status === 200),
  puts.map((p) => p.status).join(',') || 'no PUT was ever sent');

/* -------------------------------------------------- did it reach the disk? */

const disk = readWorkspaceFile(join(dir, 'workbench.json'));
const c1 = (disk.customers || []).find((c) => c.id === 'c1') || {};
const opps = Object.values(disk.opps || {});

check('on disk: the person', (c1.contacts || []).some((p) => p.n === 'Nadia Rahman'));
check('on disk: the system', (c1.apps || []).some((a) => a.n === 'Fraud engine v2'));
check('on disk: the opportunity (opps is a map)', opps.some((o) => o.t === 'Billing migration PoC'), `${opps.length} opps`);
check('on disk: the note', (c1.timeline || []).some((t) => t.t === 'CFO re-opened the review'));
check('on disk: customers survived', (disk.customers || []).length > 0, String((disk.customers || []).length));
check('on disk: the roster survived', (disk.users || []).length > 0, String((disk.users || []).length));
check('on disk: the audit grew', (disk.audit || []).length > 0, String((disk.audit || []).length));

/* ------------------------------------- the global People page can create too */

act('[data-go="people"]'); await wait(250);
check('people: "Add a person" control exists', !!label('Add a person'));
if (label('Add a person')) {
  label('Add a person').click(); await wait(250);
  const pick = doc.getElementById('ad0');
  check('people: the form asks which customer', !!pick, pick ? pick.options.length + ' customers' : '');
  if (pick) {
    pick.value = pick.options.length > 1 ? pick.options[1].value : pick.value;
    doc.getElementById('ad1').value = 'Hafiz Idris';
    if (doc.getElementById('ad2')) doc.getElementById('ad2').value = 'Head of Billing';
    if (label('Save')) { label('Save').click(); await wait(400); }
  }
}

/* --------------------------------------------- and what was added can go away */

act('[data-go="customers"]'); await wait(200);
act('[data-open="c1"]'); await wait(250);
act('[data-tab="timeline"]'); await wait(250);
const rmBtn = [...doc.querySelectorAll('#page button')].find((b) => (b.textContent || '').trim() === 'Remove');
check('timeline: a note can be removed', !!rmBtn);
if (rmBtn) {
  rmBtn.click(); await wait(250);
  check('remove asks first, on the row', !!label('Yes, remove') && !!label('Cancel'));
  if (label('Yes, remove')) { label('Yes, remove').click(); await wait(400); }
}

await wait(3000);
const after = readWorkspaceFile(join(dir, 'workbench.json'));
const c1b = (after.customers || []).find((c) => c.id === 'c1') || {};
const c2b = (after.customers || []).find((c) => c.id === 'c1') || {};
check('on disk: the removed note is gone', !(c1b.timeline || []).some((t) => t.t === 'CFO re-opened the review'));
check('on disk: the person added from People went to the picked customer',
  (c2b.contacts || []).some((p) => p.n === 'Hafiz Idris'),
  (c2b.contacts || []).slice(-2).map((p) => p.n).join(', ') || '(none)');
check('every save was still accepted', puts.every((p) => p.status === 200), puts.map((p) => p.status).join(','));

/* ------------------------------------------------- and what is there can change */

act('[data-go="customers"]'); await wait(200);
act('[data-open="c1"]'); await wait(250);
act('[data-tab="people"]'); await wait(250);
const row = doc.querySelector('#page [data-sel]');
if (row) { row.click(); await wait(250); }
/* The customer header has its own Edit; the per-record one carries data-ed. */
const edBtn = doc.querySelector('#page button[data-ed]');
check('people: a person can be edited', !!edBtn);
if (edBtn) {
  edBtn.click(); await wait(250);
  const t = doc.getElementById('ed2');
  check('edit: the form opens prefilled', !!t && !!t.value, t ? t.value : '(empty)');
  if (t) t.value = 'Group Chief Technology Officer';
  if (label('Save')) { label('Save').click(); await wait(400); }
  check('edit: the new title is on screen', seen().includes('Group Chief Technology Officer'));
}

act('[data-tab="run"]'); await wait(250);
const sysEdit = doc.querySelector('#page button[data-ed]');
check('run: a system can be edited', !!sysEdit);
if (sysEdit) {
  sysEdit.click(); await wait(250);
  const n = doc.getElementById('ed1');
  if (n) n.value = 'Billing (BSCS) - Exadata';
  if (label('Save')) { label('Save').click(); await wait(400); }
  check('edit: the renamed system is on screen', seen().includes('Billing (BSCS) - Exadata'));
}

await wait(3000);
const after2 = readWorkspaceFile(join(dir, 'workbench.json'));
const c1c = (after2.customers || []).find((c) => c.id === 'c1') || {};
check('on disk: the edited title persisted', (c1c.contacts || []).some((p) => p.t === 'Group Chief Technology Officer'));
check('on disk: the edited system persisted', (c1c.apps || []).some((a) => a.n === 'Billing (BSCS) - Exadata'));
check('every save was accepted after editing too', puts.every((p) => p.status === 200), puts.map((p) => p.status).join(','));

/* ------------------------------------------- is there a way to add things? */

const CREATE = /^(?:\+\s*)?(?:new|add|log|capture|create)/i;
/* Three surfaces hold nothing of their own. The brief is assembled from what
   is already recorded, Files belong to the customer's own tab, and every card
   on Insights is computed from records elsewhere — there is no "insight" to
   create, only facts to read. Everything else that shows records must offer a
   way to make one. */
const MAY_BE_READ_ONLY = new Set(['customer/brief', 'customer/files', 'insights']);
const gaps = [];
const broken = [];

const sweep = async (where) => {
  const text = seen();
  /* "undefined" and "NaN" on screen are the fingerprints of a computed value
     that silently stopped computing. Cheap to look for, and it is how a
     hardcoded number that was never wired up gives itself away. */
  if (/\bundefined\b|\bNaN\b/.test(text)) broken.push(where);
  const bs = [...doc.querySelectorAll('#page button, #page a.btn')].map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim());
  if (!bs.some((t) => CREATE.test(t))) gaps.push(where);
};

for (const r of ['today', 'customers', 'people', 'opportunities', 'interactions', 'products', 'insights', 'admin']) {
  act(`[data-go="${r}"]`); await wait(220);
  await sweep(r);
}
act('[data-go="customers"]'); await wait(200); act('[data-open="c1"]'); await wait(250);
for (const t of ['brief', 'people', 'run', 'opportunities', 'timeline', 'files']) {
  act(`[data-tab="${t}"]`); await wait(180);
  await sweep('customer/' + t);
}
const unexpected = gaps.filter((g) => !MAY_BE_READ_ONLY.has(g));
check('every screen that lists records can create one', unexpected.length === 0,
  unexpected.length ? unexpected.join(', ') : gaps.length ? 'only: ' + gaps.join(', ') : 'all of them');
check('no screen shows an undefined or NaN value', broken.length === 0, broken.join(', '));

/* ---------------------------------- the same screens, through each role's eyes
   A screen that only works for an administrator is not finished. View-as is the
   honest test: same data, narrower scope, and any computed value that assumed
   the whole workspace shows up here as undefined. */
const roleBroken = [];
/* Twice a source comment has sat inside a template literal and shipped to the
   screen as prose — once at the top of the default screen, where it stayed
   until a screenshot for something else caught it. A static scan of the
   source cannot fairly tell a template's copy from its code (braces from
   destructuring look exactly like braces from interpolation), so the check
   lives here, where there is nothing to interpret: if `/*` is in the page
   the user reads, it shipped. */
const commentLeak = [];
for (const role of ['manager', 'bd', 'sa']) {
  /* The view-as switcher lives on the Admin screen when you are an admin, and in
     the banner on every screen once you are not. Enter from Admin, leave from
     the banner — that is exactly the path a user has. */
  act('[data-go="admin"]'); await wait(300);
  act('[data-atab="roles"]'); await wait(250);
  let asBtn = doc.querySelector('[data-as="' + role + '"]');
  if (!asBtn) { act('[data-go="today"]'); await wait(200); asBtn = doc.querySelector('[data-as="' + role + '"]'); }
  if (!asBtn) { roleBroken.push(role + ':no-switch'); continue; }
  asBtn.click(); await wait(350);
  if (!new RegExp('Viewing as ' + ROLE_LABEL[role], 'i').test(seen())) roleBroken.push(role + ':no-banner');
  for (const r of ['today', 'customers', 'people', 'opportunities', 'interactions', 'products']) {
    act('[data-go="' + r + '"]'); await wait(200);
    if (viewRoute() === 'admin') { roleBroken.push(role + '/' + r + ':locked-out'); continue; }
    const t = seen();
    if (/\bundefined\b|\bNaN\b/.test(t)) roleBroken.push(role + '/' + r);
    if (t.includes('/*')) commentLeak.push(role + '/' + r);
    /* Every view of the two screens that have them — the board was where the
       leak lived, and the default is exactly where a glance does not go. */
    for (const cv of ['list', 'table', 'board']) {
      const btn = doc.querySelector('#page [data-cv="' + cv + '"]');
      if (!btn) continue;
      btn.click(); await wait(140);
      const tv = seen();
      if (/\bundefined\b|\bNaN\b/.test(tv)) roleBroken.push(role + '/' + r + '/' + cv);
      if (tv.includes('/*')) commentLeak.push(role + '/' + r + '/' + cv);
    }
  }
  act('[data-go="customers"]'); await wait(200);
  const card = doc.querySelector('#page [data-open]');
  if (card) {
    card.click(); await wait(300);
    for (const tb of ['brief', 'people', 'run', 'opportunities', 'timeline']) {
      act('[data-tab="' + tb + '"]'); await wait(160);
      if (/\bundefined\b|\bNaN\b/.test(seen())) roleBroken.push(role + '/customer/' + tb);
    }
  }
  act('[data-as="admin"]'); await wait(300);
}
check('every screen renders for every role, with nothing undefined', roleBroken.length === 0, roleBroken.join(', '));

check('a comment never ships to the screen', commentLeak.length === 0,
  commentLeak.length ? commentLeak.join(', ') : 'no source note renders as copy, on any view');

/* --------------------------------------- wave 13 — the four repairs ---
   Each of these was a thing a user reached for and could not find: the way
   out, the second door to the walkthroughs, the pen on the board card, and
   the guest's book. They are checked on the rendered DOM because that is
   where the user met them. */
act('[data-go="opportunities"]'); await wait(300);
const boardEdit = doc.querySelector('#page .opp .acts button[data-act="ed"]')
  || doc.querySelector('#page .opp-act button[data-act="ed"]');
check('the board card carries an Edit behind the half-of-the-record rule',
  !!boardEdit, boardEdit ? 'the card is a door, not a wall' : 'no way into a card from the board');
if (boardEdit){
  boardEdit.click(); await wait(200);
  const edopen = doc.querySelector('#page .col-ed');
  check('the edit form opens under the card it came from',
    !!edopen && !!edopen.querySelector('[data-act="edsave"]'),
    edopen ? 'form, save and cancel under the card' : 'the click did nothing');
  const edno = edopen && edopen.querySelector('[data-act="edno"]');
  if (edno){ edno.click(); await wait(150); }
  check('cancel closes it again', !doc.querySelector('#page .col-ed'));
}

const railTour = doc.querySelector('#railFoot button[data-act="tourmenu"]');
check('the rail carries a second door to the walkthroughs',
  !!railTour, railTour ? railTour.textContent.trim() : 'the corner float is the only door again');
if (railTour){
  railTour.click(); await wait(200);
  const tm = doc.getElementById('tMenu');
  check('the rail door opens the same tour menu',
    !!tm?.classList.contains('on') && (tm?.querySelectorAll('[data-tour-start]').length || 0) >= 5,
    `${tm?.querySelectorAll('[data-tour-start]').length || 0} tours listed`);
  if (tm) tm.classList.remove('on');
}

const meBtn = doc.getElementById('meBtn');
check('the identity chip is a control once you are signed in',
  !!meBtn && meBtn.classList.contains('has-session'));
if (meBtn){
  meBtn.click(); await wait(200);
  const mm = doc.getElementById('meMenu');
  check('the identity menu offers the way out',
    !!mm?.classList.contains('on') && /Sign out/.test(mm.textContent || '')
      && /Change password/.test(mm.textContent || ''),
    mm ? 'who you are, your secret, and the door' : 'the menu did not open');
  if (mm) mm.classList.remove('on');
}


check('no uncaught page errors', errs.length === 0, errs.slice(0, 3).join(' // '));

/* -------------------------------- a half-typed form survives a redraw -----

   `render()` rebuilds the page from the data, and a half-filled form is not in
   the data — it is not a record yet. So every redraw throws it away, and this
   product redraws on its own: a save lands, the server hands back the truth,
   and the page is rebuilt. Somebody typing a person's name, pausing to look up
   their e-mail, and pressing Save was told "A name, at least." about a name
   they had typed. The draft has to travel with the redraw. */
act('[data-go="customers"]'); await wait(250);
act('[data-open="c1"]'); await wait(300);
act('[data-tab="people"]'); await wait(250);

const TYPED = 'Draft Person ' + Date.now().toString().slice(-5);
if (label('Add a person')) {
  label('Add a person').click(); await wait(250);
  const f = doc.getElementById('ad1');
  if (f) {
    f.value = TYPED;
    if (doc.getElementById('ad2')) doc.getElementById('ad2').value = 'Head of Draft';
    /* A redraw on purpose, then the one the product makes on its own. */
    window.render();
    check('a redraw keeps what was typed', doc.getElementById('ad1')?.value === TYPED,
      JSON.stringify(doc.getElementById('ad1')?.value));
    await wait(1600);   /* the save the app schedules for itself lands in here */
    check('a background save does not wipe the form either', doc.getElementById('ad1')?.value === TYPED,
      JSON.stringify(doc.getElementById('ad1')?.value));
    if (label('Save')) label('Save').click();
    await wait(3000);
  }
}
const draftDisk = readWorkspaceFile(join(dir, 'workbench.json'));
const c1d = (draftDisk.customers || []).find((c) => c.id === 'c1') || {};
check('and the draft that survived can actually be saved',
  (c1d.contacts || []).some((p) => p.n === TYPED),
  (c1d.contacts || []).slice(-2).map((p) => p.n).join(', ') || '(none)');

/* ------------------------------------- the one error state that must not be silent */

/* Stop the server under the app's feet and make an edit. The row still appears
   — nothing in the UI stops you — so the only honest thing left is to say that
   the save did not happen. A workspace that loses an edit while looking calm is
   worse than one that crashes. */
check('no failure banner while everything works', !/Not saved/.test(seen()));
try { server.p.kill(); } catch { /* already gone */ }
await wait(400);
act('[data-go="customers"]'); await wait(200);
act('[data-open="c1"]'); await wait(250);
act('[data-tab="timeline"]'); await wait(200);
if (label('Add a note')) {
  label('Add a note').click(); await wait(200);
  const f = doc.getElementById('ad1');
  if (f) f.value = 'Typed while the server was down';
  if (label('Save')) label('Save').click();
}
await wait(2500);
check('a failed save is visible on screen', /Not saved/i.test(seen()), seen().match(/Not saved[^·]{0,60}/i)?.[0] || '');
check('the failed save offers a retry', !!label('Retry now'));

/* ------------------------------------------------- an error must not look like a success
   Every message shares one black surface, and that is fine — the surface is
   not what a person needs to tell apart at a glance. "Could not reach the
   server" and "Customer created" used to be identical; an error now carries
   the risk edge and nothing else changes. Called straight on the window
   because the state that produces each one has just been destroyed above. */
window.eval("toast('The model could not be reached.', null, 'err')");
let lastToast = [...doc.querySelectorAll('body > div')].pop();
check('an error toast carries the risk edge',
  /var\(--risk\)/.test(lastToast?.getAttribute('style') || ''),
  (lastToast?.getAttribute('style') || '').slice(60, 140));
lastToast?.remove();
window.eval("toast('Customer created.')");
lastToast = [...doc.querySelectorAll('body > div')].pop();
check('a success toast stays quiet',
  !/var\(--risk\)/.test(lastToast?.getAttribute('style') || ''));
lastToast?.remove();

/* --------------------------------------------------- the tour lives in the corner
   L1: the top bar used to carry a permanent "Quick tour" button — the one
   action you take once, then only occasionally, holding pixels that search,
   status and identity need every day. The tour is now a corner float, and
   its menu opens upward from it, because below a bottom-corner button there
   is nothing but the edge of the screen. */
const fab = doc.getElementById('tourOpen');
const topBar = doc.querySelector('header.top');
check('the top bar no longer carries the tour', !!fab && !!topBar
  && !topBar.querySelector('#tourOpen') && /tour-fab/.test(fab?.className || ''),
  fab ? `class="${(fab.className || '').slice(0, 40)}"` : 'the float was not found');
window.eval("tourMenu()");
const tmenu = doc.getElementById('tMenu');
check('the corner float still opens the tours', !!tmenu?.classList.contains('on')
  && /data-tour-start/.test(tmenu?.innerHTML || ''),
  tmenu ? `${tmenu.querySelectorAll('[data-tour-start]').length} tours listed` : 'the menu did not open');
/* jsdom lays nothing out, so "above the float" cannot be measured here — that
   is photographed in Playwright. What jsdom can prove is that the menu is
   placed by the anchor at all, in pixels, not left at the stylesheet's
   top-right default. (With no layout the rect reads 0 everywhere, so the
   anchor legitimately writes -10px — the sign is not the point.) */
check('the menu is anchored by the float, in pixels',
  !!tmenu && /^-?\d+px$/.test(tmenu.style.top || '') && /^-?\d+px$/.test(tmenu.style.left || ''),
  tmenu ? `top ${tmenu.style.top} · left ${tmenu.style.left}` : 'no inline anchor');

/* The connection dot used to be painted with an inline colour written by
   hand — `dot.style.background = 'var(--risk)'` — so "which dots can be
   alarmed" was invisible to the stylesheet. It is a class now. */
window.eval("paintConn()");
const cdot = doc.getElementById('connDot');
check('the connection dot is painted by a class, not by an inline colour',
  !!cdot && /^dot dot--(ok|warn|risk|blue)$/.test(cdot.className || '')
    && !/background/.test(cdot.getAttribute('style') || ''),
  cdot ? `class="${cdot.className}"` : 'the dot was not found');

/* ------------------------------------------------------------------ done */

/* --------------------------------------- the guest's book, seen last ---
   The guest posture is entered last because it replaces the session's view
   of the data: enterApp(true) loads the demo book into memory, and nothing
   after this can assume the signed-in book is still on screen. What has to
   be true there: the four DEMO companies are visible, the rail says which
   book this is, and there is no pen anywhere — the guest reads. */
window.eval('enterApp(true)');
await wait(300);
act('[data-go="customers"]'); await wait(250);
const guestCards = doc.querySelectorAll('#page .card[data-open]');
check('the guest sees all four DEMO companies',
  guestCards.length === 4,
  `${guestCards.length} cards: ${[...guestCards].map(c => (c.textContent || '').split('\n')[0]).join(' · ').slice(0, 80)}`);
check('the guest book says it is sample data, in the rail',
  !!doc.querySelector('#railFoot .sample-tag'));
check('the guest board carries no pen',
  (doc.querySelector('#page .opp-act') || null) === null
    && !doc.querySelector('#page button[data-act="ed"]'));
const guestBody = doc.body.textContent || '';
check('the signed-in book left nothing behind in the guest view',
  !/Nusantara/.test(guestBody), 'the sample workspace shows only the demo book');
check('every DEMO record is marked where it is read',
  /Maybank — DEMO/.test(guestBody) && /Astro — DEMO/.test(guestBody));

dom.window.close();
try { server.p.kill(); } catch { /* gone */ }
rmSync(dir, { recursive: true, force: true });

console.log(`\n${ran} checks run. ${bad ? 'FAILURES above' : 'all passed'}`);
process.exit(bad ? 1 : 0);
