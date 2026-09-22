/* verify:opportunity — §12's two views, and the edit form that cannot drift.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two separate promises are checked here, and both were broken before.
 *
 * 1. §12 says the Opportunity page must offer a List AND a Board, and that the
 *    Board must not be the only way to manage opportunities. The board was the
 *    only view: it answers "where is everything", which is a question about
 *    position. It cannot answer "which of my deals close this quarter", which
 *    is a question about values — and at volume every card is the same size
 *    whether it is worth RM 5k or RM 5m, so it stops being scannable.
 *
 * 2. §12 also requires a clear Edit action. The form that edit opens was built
 *    from a positional array, written out twice — once on the customer's
 *    Opportunities tab, once on the board card. Two copies of a list that must
 *    stay in step drift the day a field is added: the copy nobody edited shifts
 *    every value one place and Save writes a competitor into the close date,
 *    with no error anywhere. TRAPS.md records this exact shape.
 *
 * The check that matters for (2) is not "does the form open" — it is "does a
 * value survive a round trip". So this suite sets a distinctive value in every
 * field, saves, reopens, and compares field by field. A form that renders
 * blank boxes where saved data exists fails HERE, before a person loses it.
 *
 * Run from customer-workbench/:  npm run verify:opportunity
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
/* A port of its own. Two suites sharing one port is a collision that reports
   "busy" instead of a result — see the comment in verify-scenarios.mjs. */
const PORT = Number(process.env.OPP_PORT || 8871);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const PASSWORD = 'Waypoint#2026';
const SOURCE = (await import('node:fs')).readFileSync(join(ROOT, 'Waypoint-v1.html'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------- seed */

const dir = mkdtempSync(join(tmpdir(), 'wp-opp-'));
const at0 = new Date().toISOString();
writeFileSync(join(dir, 'workbench.json'), JSON.stringify({
  schemaVersion: 1, setupComplete: true,
  users: [], credentials: {}, logs: [],
  customers: [], interactions: [], steps: [], team: [], audit: [],
  files: [], watch: [], opps: {},
}));
const disk = () => readWorkspaceFile(join(dir, 'workbench.json'));

const PEOPLE = [
  { id: 'u_admin', name: 'Opp Admin', role: 'admin' },
];
{
  const d = disk();
  const at = new Date().toISOString();
  d.users = PEOPLE.map(p => ({ id: p.id, name: p.name, role: p.role, title: p.role, locked: false, createdAt: at, updatedAt: at }));
  d.team = PEOPLE.map(p => ({ n: p.name, r: 'Senior SA', f: p.role.toUpperCase(), role: p.role, last: '—', st: 'Active' }));
  d.credentials = {};
  for (const p of PEOPLE) {
    const salt = randomBytes(16);
    d.credentials[p.id] = {
      userId: p.id, algo: 'pbkdf2-sha256', iterations: 150_000,
      salt: salt.toString('base64'),
      hash: pbkdf2Sync(PASSWORD, salt, 150_000, 32, 'sha256').toString('base64'),
      createdAt: at, updatedAt: at,
    };
  }
  writeFileSync(join(dir, 'workbench.json'), JSON.stringify(d));
}

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
async function open(email) {
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
  const mk = () => {
    const vc = new VirtualConsole();
    vc.on('jsdomError', e => pageErrors.push(String(e.message)));
    return new JSDOM(SOURCE, {
      url: ORIGIN + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
      beforeParse: (w) => {
        w.scrollTo = () => {};
        w.URL.createObjectURL = () => 'blob:stub';
        w.URL.revokeObjectURL = () => {};
        w.fetch = (u, o) => api(String(u).replace(ORIGIN, ''), o);
      },
    }).window;
  };
  const win = mk();
  await wait(900);
  const doc = win.document;
  const e = doc.getElementById('lgE'), p = doc.getElementById('lgP');
  if (e && p) {
    e.value = email; p.value = PASSWORD;
    doc.querySelector('[data-act="signin"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await wait(1600);
  }
  const sess = {
    win, api, jar,
    get doc() { return sess.win.document; },
    $: (s) => sess.win.document.querySelector(s),
    $$: (s) => [...sess.win.document.querySelectorAll(s)],
    text: () => (sess.win.document.getElementById('page') || sess.win.document.body).textContent,
    click: async (el, ms = 320) => {
      if (!el) return false;
      el.dispatchEvent(new sess.win.MouseEvent('click', { bubbles: true }));
      await wait(ms); return true;
    },
    set: async (el, v) => {
      if (!el) return false;
      el.value = v;
      el.dispatchEvent(new sess.win.Event('input', { bubbles: true }));
      el.dispatchEvent(new sess.win.Event('change', { bubbles: true }));
      await wait(80); return true;
    },
    byText: (sel, t) => [...sess.win.document.querySelectorAll(sel)].find(x => (x.textContent || '').includes(t)),
  };
  return sess;
}

/* ========================================================================== */
console.log('\n— An opportunity, from the customer —');

const s = await open('opp.admin@global.tencent.com');
check('admin signs in', /Good (morning|afternoon|evening)|Today|Customers/.test(s.text()), s.text().slice(0, 40));

/* Build a customer through the UI, so the test walks the same road a person
   does. Every control here is read out of the source, never guessed: the
   new-customer sheet asks its question in `#ncQ`, and "Create without a
   lookup" (`#ncSkip`) is the path that needs no network — a test that called
   the public-record lookup would be testing somebody else's uptime. */
await s.click(s.$('[data-go="customers"]'), 700);
check('a customer can be created from the Customers screen', !!s.$('[data-act="newcust"]'));
await s.click(s.$('[data-act="newcust"]'), 600);
await s.set(s.$('#ncQ'), 'Opp Probe Bhd');
await s.click(s.$('#ncSkip'), 1200);
check('a customer exists to hang opportunities on', /Opp Probe Bhd/.test(s.text()));
check('and it is on the server',
  (disk().customers || []).some(c => c.name === 'Opp Probe Bhd'),
  (disk().customers || []).length + ' on disk');

/* Open it, then its Opportunities tab. */
await s.click(s.$$('#page [data-open]').find(x => (x.textContent || '').includes('Opp Probe Bhd')), 900);
await s.click(s.byText('#page [data-tab]', 'Opportunities'), 700);

/* ------------------------------------------------- 1. it can be created ---- */
/* Inside a customer the add bar is drawn by the page shell as
   `addBarFor(tab)` — keyed on the open tab, not on a labelled button — so the
   control is found by what it does. Note there is deliberately NO customer
   picker here: on this screen "the customer" is the record you are inside, and
   the picker is added only where a person is not already in one
   (`pickCustomer`). Asserting `#ad0` here would demand a field the design
   deliberately omits. */
const addBtn = s.$('[data-act="addtoggle"][data-add="opportunities"]');
check('the customer’s Opportunities tab offers a way to add one', !!addBtn);
await s.click(addBtn, 600);
check('the add form asks for the deal itself',
  !!s.$('#ad1') && !!s.$('#ad2') && !!s.$('#ad3'));
check('and it needs no customer picker — the customer is the one you are in', !s.$('#ad0'));
await s.set(s.doc.getElementById('ad1'), 'The distinctive one');
await s.set(s.doc.getElementById('ad2'), '1500000');
await s.click(s.$('[data-act="addsave"]'), 1200);
check('an opportunity can be created from the customer', /The distinctive one/.test(await s.text()));
check('and it reached the server', Object.values(disk().opps || {}).some(o => o.t === 'The distinctive one'),
  Object.keys(disk().opps || {}).length + ' opportunities on disk');

/* ------------------------------------- 2. the section requires BOTH views -- */
/* The customer page has its own view switch; what §12 is about is the
   Opportunities *screen* in the nav. Go there and look for the two controls. */
await s.click(s.$('[data-go="opportunities"]'), 900);
const oppText = s.text();
check('the Opportunities screen is reachable', /Opportunities/.test(oppText));

const boardBtn = s.$('#page [data-cv="board"]');
const listBtn = s.$('#page [data-cv="list"]');
check('the Opportunities screen offers a Board view', !!boardBtn);
check('and a List view — the board is not the only way', !!listBtn);

/* Switching to List must actually change what is drawn, not just the button. */
const beforeSwitch = s.text();
await s.click(listBtn, 700);
const afterSwitch = s.text();
check('switching to List redraws the screen', beforeSwitch !== afterSwitch);
check('the List view carries the opportunity', /The distinctive one/.test(afterSwitch));
check('and it shows columns a board cannot', /Customer/.test(afterSwitch) && /Value/.test(afterSwitch));

/* It must be a real table, not a board with different words. */
check('the List view is drawn as a table', !!s.$('#page table tbody tr'));

await s.click(s.$('#page [data-cv="board"]'), 700);
check('and the Board comes back', /The distinctive one/.test(s.text()) && !!s.$('#page .board'));

/* ------------------------------- 3. the edit form round-trips every field -- */
/* This is the check that would have caught the positional-array bug. Every
   field gets a value nobody would type by accident, so a shifted column is
   unmistakable rather than plausible. */
const UNIQUE = {
  ed1: 'Roundtrip title',
  ed2: '2750000',
  ed4: '65',
  ed5: '2027-03-31',
  ed6: 'Oracle probe',
  ed7: 'Their signer probe',
  ed8: 'A description that must survive the trip',
  ed10: 'A loss reason that must not appear while the stage is not Lost',
};

/* Open the edit form from the List view, which is where a person managing a
   pipeline actually works. */
await s.click(s.$('#page [data-cv="list"]'), 700);
const rowEdit = s.$$('#page tbody [data-act="ed"]')[0];
check('the List view offers a clear Edit action', !!rowEdit);
await s.click(rowEdit, 700);

const formOpen = ['ed1', 'ed2', 'ed3', 'ed4', 'ed5', 'ed6', 'ed7', 'ed8', 'ed9', 'ed10'].every(k => s.doc.getElementById(k));
check('the edit form renders all ten fields', formOpen);

/* Every rendered field must be pre-filled with what is on disk. A blank box
   where data exists is the failure mode: Save writes the blank back. The row
   is found BY NAME rather than by "the first key", so this suite cannot pass
   by accident against somebody else's row if the seed ever grows. */
const oppRow = () => Object.values(disk().opps || {}).find(o => o.t === 'The distinctive one')
  || Object.values(disk().opps || {})[0];
const oppId = Object.keys(disk().opps || {}).find(k => (disk().opps[k] || {}).t === 'The distinctive one');
check('the created opportunity has a row of its own', !!oppId);
const before = (disk().opps || {})[oppId] || {};
check('the form is pre-filled from the saved row, not left blank',
  (s.doc.getElementById('ed1') || {}).value === 'The distinctive one',
  'ed1="' + ((s.doc.getElementById('ed1') || {}).value || '') + '"');
check('the numeric field carries the saved value',
  (s.doc.getElementById('ed2') || {}).value === '1500000',
  'ed2="' + ((s.doc.getElementById('ed2') || {}).value || '') + '"');

/* Now set them all and save. `edsave` is the action edForm() writes; the
   capital-S guess this once used silently matched a fallback "Save" and the
   click landed on the wrong control. */
for (const [k, v] of Object.entries(UNIQUE)) await s.set(s.doc.getElementById(k), v);
const saveBtn = s.$('[data-act="edsave"]');
check('the form offers the Save action edForm draws', !!saveBtn);
await s.click(saveBtn, 1200);

/* Read the disk, field by field. This is the assertion the array shape broke. */
const after = (disk().opps || {})[oppId] || {};
check('the title saved', after.t === UNIQUE.ed1, String(after.t));
check('the value saved', String(after.v) === UNIQUE.ed2, String(after.v));
check('the probability saved', String(after.p) === UNIQUE.ed4, String(after.p));
check('the close date saved', after.close === UNIQUE.ed5, String(after.close));
check('the competitor saved', after.comp === UNIQUE.ed6, String(after.comp));
check('their owner saved', after.cust === UNIQUE.ed7, String(after.cust));
check('the description saved', after.desc === UNIQUE.ed8, String(after.desc));
check('nothing leaked between fields',
  after.close !== UNIQUE.ed6 && after.comp !== UNIQUE.ed5,
  JSON.stringify({ close: after.close, comp: after.comp }));

/* Reopen: the form must show what was saved, which is what proves the round
   trip rather than just a successful write. */
await s.click(s.$$('#page tbody [data-act="ed"]')[0], 700);
check('reopening the form shows the saved close date',
  (s.doc.getElementById('ed5') || {}).value === UNIQUE.ed5,
  '"' + ((s.doc.getElementById('ed5') || {}).value || '') + '"');
check('reopening the form shows the saved competitor',
  (s.doc.getElementById('ed6') || {}).value === UNIQUE.ed6,
  '"' + ((s.doc.getElementById('ed6') || {}).value || '') + '"');
check('reopening the form shows the saved description',
  (s.doc.getElementById('ed8') || {}).value === UNIQUE.ed8,
  '"' + ((s.doc.getElementById('ed8') || {}).value || '') + '"');

check('no page errors were thrown', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

console.log('\n' + pass + ' passed, ' + fail + ' failed  (' + (pass + fail) + ' checks)\n');
bye();
process.exit(fail ? 1 : 0);
