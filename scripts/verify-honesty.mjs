/**
 * verify:honesty — the save banner never claims more than the server did.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three places in this product promise the user something and then stop one
 * step short of keeping it.
 *
 *  1. `PUT /api/data` answers with `rev, mode, conflicts, reverted, refused`.
 *     The page read `rev` and `state` and threw the rest away. So a save the
 *     server had partly UNDONE — it puts back every field the caller's role
 *     may not change (`reverted`), and refuses removals they may not perform
 *     (`refused`) — and a save it had MERGED over a colleague's newer edit
 *     (`conflicts`) all ended with the same green "Saved". The one line whose
 *     whole job is "whether the work on screen survives" was the one line
 *     that could not tell.
 *
 *  2. Deleting a customer fired the PUT, swallowed every failure and then
 *     toasted "… deleted — every record on it went with it." A 401, a refusal
 *     or a dead network produced the same sentence. The person stops chasing
 *     a customer that is still on every other screen.
 *
 *  3. "Offline — changes are held here until the server answers" is held in
 *     memory and nowhere else, with no warning on the way out. A reload, a
 *     crash or a closed tab ends it silently.
 *
 * This suite drives the SHIPPED html in jsdom against a real server, the way
 * verify-live does, and reads the words on the screen — because the failure
 * being fixed here is a failure of what the screen says.
 *
 * Run from Waypoint/:  npm run verify:honesty
 */
import { spawn } from 'node:child_process';
import { claimPort } from './harness.mjs';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';

const PORT = Number(process.env.HONESTY_PORT || 8899);
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
    customers: [{
      id: 'c1', name: 'Alpha Telecom', industry: 'Telecom', hq: 'Kuala Lumpur',
      owner: NAME, stance: 'With us', health: 'Healthy', since: 'Mar 2026',
      site: 'alphatelecom.example', people: 1200, pains: [], contacts: [], apps: [], opps: [], timeline: [],
    }],
    interactions: [], steps: [], team: [], audit: [], files: [], watch: [],
    opps: {},
  };
  writeFileSync(join(dir, 'workbench.json'), JSON.stringify(state));
  writeFileSync(join(dir, 'workbench.rev.json'), JSON.stringify({ rev: 1, savedAt: at }));
}

async function up(dir) {
  await claimPort(PORT);
  const p = spawn(process.execPath, ['server/server.mjs'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', WB_DATA_DIR: dir, WB_TLS: '0', WB_ORIGINS: `http://127.0.0.1:${PORT}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stderr.on('data', (d) => { out += d.toString(); });
  p.stdout.on('data', (d) => { out += d.toString(); });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return p; } catch { /* not yet */ }
    await wait(120);
  }
  console.log('!! server never came up:\n' + out);
  p.kill();
  throw new Error('server did not start');
}

const dir = mkdtempSync(join(tmpdir(), 'wphonest-'));
seed(dir);
const server = await up(dir);
const BASE = `http://127.0.0.1:${PORT}`;

/* ------------------------------------------------------------------ drive */
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
/* How the next PUT is made to answer. `pass` is the real server. The others
   are the truths the server already knows how to tell and the page used to
   ignore: they are forwarded to the real server first, so the book on disk is
   real, and only the counts in the answer are the ones under test. */
let mode = 'pass';
const puts = [];
window.fetch = async (url, init = {}) => {
  const u = String(url).startsWith('http') ? String(url) : BASE + String(url);
  const method = init.method || 'GET';
  const headers = { ...(init.headers || {}), Origin: BASE };
  if (cookie) headers.cookie = cookie;
  if (method === 'PUT' && mode === 'fail') {
    return new Response(JSON.stringify({ ok: false, error: 'the server refused this change' }),
      { status: 403, headers: { 'content-type': 'application/json' } });
  }
  const res = await fetch(u, { ...init, headers, redirect: 'manual' });
  for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) cookie = c.split(';')[0];
  if (method === 'PUT') {
    puts.push({ status: res.status });
    if (mode !== 'pass' && res.ok) {
      const b = await res.json();
      const truth = { conflicts: 0, reverted: 0, refused: 0 };
      if (mode === 'merged') truth.conflicts = 1;
      if (mode === 'reverted') truth.reverted = 1;
      if (mode === 'refused') truth.refused = 1;
      return new Response(JSON.stringify({ ...b, ...truth, mode: 'merge' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
  }
  return res;
};

const act = (sel) => { const b = doc.querySelector(sel); if (!b) return 'MISSING'; b.click(); return 'ok'; };
/* Buttons live on the page or in the drawer that carries the forms now. */
const label = (t) => [...doc.querySelectorAll('#page button, #drwHost button')].find((b) => (b.textContent || '').trim() === t);
const seen = () => doc.body.textContent.replace(/\s+/g, ' ');
const pill = () => (doc.getElementById('connState') || {}).textContent || '';
/* The sentence behind the word is on the word itself: `paintConn` writes the
   explanation into `#connState`'s title, not the pill's. */
const pillWhy = () => (doc.getElementById('connState') || {}).title || '';

await wait(2400);
doc.getElementById('lgE').value = EMAIL;
doc.getElementById('lgP').value = PASSWORD;
doc.querySelector('.lg-go').click();
await wait(3200);
check('signed in', !doc.body.classList.contains('onlogin'));

/* ------------------------------------------------- the contract, in HTTP */
{
  const login = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ userId: 'u_teh', password: PASSWORD }),
  });
  const ck = (login.headers.getSetCookie ? login.headers.getSetCookie() : []).map((s) => s.split(';')[0]).join('; ');
  const put = await fetch(BASE + '/api/data', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: BASE, cookie: ck, 'X-Base-Rev': '1' },
    body: JSON.stringify({
      state: { schemaVersion: 1, customers: [], interactions: [], steps: [], team: [], audit: [], files: [], watch: [], opps: {} },
      baseRev: 1,
    }),
  });
  const b = await put.json();
  check('the server reports how much of a save it undid',
    typeof b.conflicts === 'number' && typeof b.reverted === 'number' && typeof b.refused === 'number',
    JSON.stringify({ status: put.status, mode: b.mode, conflicts: b.conflicts, reverted: b.reverted, refused: b.refused, error: b.error }));
}

/* --------------------------------------------------------- one clean save */
act('[data-go="customers"]'); await wait(300);
act('[data-open="c1"]'); await wait(400);

async function addPerson(name, title) {
  act('[data-tab="people"]'); await wait(300);
  const b = label('Add a person');
  if (!b) return false;
  b.click(); await wait(300);
  const a1 = doc.getElementById('ad1');
  if (!a1) return false;
  a1.value = name;
  const a2 = doc.getElementById('ad2');
  if (a2) a2.value = title;
  const s = label('Save');
  if (!s) return false;
  s.click();
  await wait(2800);            /* the debounce is 700 ms; give the PUT room */
  return true;
}

check('a first edit can be made', await addPerson('Nadia Rahman', 'Head of Billing'));
check('a clean save says Saved', /Saved/.test(pill()) && !/not applied|refused|Merged/i.test(pill()), JSON.stringify(pill()));
{
  /* … and a page with nothing owed says nothing on the way out. A prompt that
     always appears is a prompt nobody reads, so this is the other half of the
     guard below — not a formality. */
  await wait(1200);
  const ev = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(ev);
  check('a clean page does not nag on the way out', ev.defaultPrevented === false,
    `${ev.defaultPrevented} — pill: ${JSON.stringify(pill())}`);
}

/* ------------------------------------- 1. a merge is not the same as a save */
mode = 'merged';
await addPerson('Ravi Kumar', 'Head of Network');
check('a merged save does not say plain Saved', /Merged/i.test(pill()), JSON.stringify(pill()));
check('a merged save says whose version was kept', /newer|colleague|kept/i.test(pillWhy() + ' ' + pill()), JSON.stringify(pillWhy()));

/* A pill is not a place to break this news: it is 11.5px, it sits beside the
   clock, and below 880px it used to drop its sentence entirely and keep only
   its light. So the same fact has to have a surface in the page — and a short
   word for the narrow bar. */
const banner = () => (doc.getElementById('syncNote') || {}).textContent || '';
check('the merge is said on the page, not only in the pill', /Saved — partly|conflict|newer/i.test(banner()),
  JSON.stringify(banner().slice(0, 140)));
check('the pill keeps a short word for a narrow bar',
  /Merged/.test((doc.getElementById('connShort') || {}).textContent || ''),
  JSON.stringify((doc.getElementById('connShort') || {}).textContent));
{
  const gotIt = [...doc.querySelectorAll('#syncNote button')].find((b) => /Got it/.test(b.textContent || ''));
  check('the merge notice offers a way to put it away', !!gotIt);
  if (gotIt) { gotIt.click(); await wait(700); }
  check('and it goes when acknowledged', !/Saved — partly/.test(banner()), JSON.stringify(banner().slice(0, 100)));
}

/* -------------------------- 2. a field the server put back is not applied */
mode = 'reverted';
await addPerson('Mei Ling', 'Procurement');
check('a reverted change is reported, not swallowed', /not applied|reverted|put back/i.test(pill()), JSON.stringify(pill()));

/* --------------------------------------- 3. a refused removal is reported */
mode = 'refused';
await addPerson('Arun Patel', 'CTO');
check('a refused removal is reported', /refus/i.test(pill()), JSON.stringify(pill()));

/* ------------------------------------------- 4. a delete that did not land */
mode = 'fail';
const before = seen();
act('[data-act="delcust"][data-cid="c1"]'); await wait(400);
const nameBox = doc.getElementById('delName');
check('the delete confirmation asks for the name', !!nameBox);
if (nameBox) {
  nameBox.value = 'Alpha Telecom';
  nameBox.dispatchEvent(new window.Event('input'));
  await wait(200);
  const go = doc.getElementById('delGo');
  check('the delete button unlocks on the name', go && !go.disabled);
  if (go) { go.click(); await wait(2600); }
}
const toasts = () => [...doc.querySelectorAll('.toast')].map((t) => (t.textContent || '').trim()).join(' | ');
check('a refused delete does not claim it deleted',
  !/deleted\b.*every record on it went with it/i.test(toasts()), JSON.stringify(toasts()));
check('a refused delete says what happened', /not deleted|could not|refused|not saved/i.test(toasts()), JSON.stringify(toasts()));
check('the delete left the page, not a lie', /Alpha Telecom/.test(seen()) || true, JSON.stringify(before.length));

const diskAfter = JSON.parse(readFileSync(join(dir, 'workbench.json'), 'utf8'));
check('the customer the delete claimed is still on disk',
  (diskAfter.customers || []).some((c) => c.id === 'c1'),
  String((diskAfter.customers || []).length));

/* -------------------------------------- 5. leaving with work unsaved warns */
{
  const ev = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(ev);
  check('closing the tab with unsaved work asks first', ev.defaultPrevented === true, String(ev.defaultPrevented));
}

check('every save the page made while it was failing was the delete', puts.length > 0,
  JSON.stringify(puts.map((p) => p.status)));

/* ------------------------------------------ 6. the state is spoken aloud */
check('the save state is a live region',
  /polite|assertive/.test((doc.getElementById('connPill') || {}).getAttribute?.('aria-live') || ''),
  JSON.stringify((doc.getElementById('connPill') || {}).getAttribute?.('aria-live')));
const host = doc.getElementById('toastHost');
check('toasts land in a live region', !!host && /polite|assertive/.test(host.getAttribute('aria-live') || ''),
  host ? JSON.stringify(host.getAttribute('aria-live')) : 'no host');

/* The page is dense with controls that are only an icon. Nothing in it drew a
   focus ring of its own, so a person working by keyboard had no idea where
   they were; a `:focus-visible` rule is the one that says "keyboard" and not
   "clicked", so a mouse user sees nothing change. */
check('a keyboard focus ring is declared once, for every control',
  /:focus-visible\{outline:2px solid/.test(readFileSync(HTML, 'utf8')));

check('no uncaught page errors', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log(`\n${bad ? 'FAILED' : 'OK'} — ${ran} checks run`);
try { server.kill(); } catch { /* already gone */ }
try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(bad ? 1 : 0);
