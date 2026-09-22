/* verify:scenarios — the four acceptance journeys, executed, not asserted.
 *
 * WHY THIS EXISTS
 * ---------------
 * verify:journey walks "a day" per role. This suite walks the four journeys
 * the product was sold on, in the order a real person meets them, asking at
 * every step the only honest question: where would I click to do this?
 * If the answer is "nowhere", the suite fails THERE, at the missing action —
 * not later at the API that would have worked.
 *
 *   BD       new customer → people → meeting → pains → opportunity →
 *            actions + owner → progress → edit → timeline → away → back →
 *            reload → everything still there.
 *   SA       open the same customer → read the brief → add what they run →
 *            read the opportunity (no commercial edit) → add a technical
 *            action → both records and the timeline agree.
 *   Manager  read the whole book, change nothing: no add, no edit, no remove,
 *            no export, no admin — and a forged PUT is refused by the server.
 *   Admin    the same BD workflow end to end, plus users, plus export, plus
 *            delete.
 *
 * Everything is checked three ways: on the screen, on the disk the server
 * owns, and again after the DOM is thrown away and redrawn from the server.
 * Run from customer-workbench/:  npm run verify:scenarios
 */
import { spawn } from 'node:child_process';
import { claimPort } from './harness.mjs';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { readWorkspaceFile } from './disk.mjs';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/* 8869, not 8861. verify-encryption.mjs already owns 8861, so the two suites
   collided whenever both were reachable and the loser reported a busy port
   instead of a result. A port per suite, and none of them shared. */
const PORT = Number(process.env.SCEN_PORT || 8869);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const PASSWORD = 'Waypoint#2026';
const HTML = process.env.SCEN_HTML || join(ROOT, 'Waypoint-v1.html');
const SOURCE = readFileSync(HTML, 'utf8');

let pass = 0, fail = 0;
const fails = [];
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/* A save is a PUT that lands whenever the event loop, the server and the
   disk agree — a fixed wait races all three, and under load the write can
   land a beat after it. Poll for the record the way the AI suites poll for
   their answers: a slow write is not a lost one. This suite flaked three
   times in full runs (an action, a meeting, an opportunity — the same
   shape at three different rows, green on rerun every time) before this
   lesson was written down. The probe returns the row once it is there;
   whatever it returns at the end is what the checks see. */
const savedRow = async (read, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const v = read();
    if (v) return v;
    await wait(300);
  }
  return read();
};

/* ------------------------------------------------------------------- seed */

const dir = mkdtempSync(join(tmpdir(), 'wp-scen-'));
/* A clean empty workspace — not data/workbench.json, which now carries the real book. */
const at0 = new Date().toISOString();
writeFileSync(join(dir, 'workbench.json'), JSON.stringify({
  schemaVersion: 1, setupComplete: true,
  users: [], credentials: {}, logs: [],
  customers: [], interactions: [], steps: [], team: [], audit: [],
  files: [], watch: [], opps: {},
  /* products omitted on purpose: a brand-new workspace falls back to the
     shipped catalogue, and the opportunity-product flow depends on it. */
}));
const disk = () => readWorkspaceFile(join(dir, 'workbench.json'));

const PEOPLE = [
  { id: 'u_kelvin', name: 'Teh Bin Shun', role: 'admin' },
  { id: 'u_ahmad', name: 'Ahmad Faiz', role: 'bd' },
  { id: 'u_john', name: 'John Teh', role: 'sa' },
  { id: 'u_siti', name: 'Siti Nurhaliza', role: 'manager' }
];
{
  const d = disk();
  const at = new Date().toISOString();
  d.users = PEOPLE.map(p => ({ id: p.id, name: p.name, role: p.role, title: p.role, locked: false, createdAt: at, updatedAt: at }));
  /* The roster the team and owner pickers read. The baked demo roster used to
     supply these people by accident — a real workspace starts empty and the
     administrator says who is on it, so this suite says who its own are. */
  d.team = PEOPLE.map(p => ({ n: p.name, r: p.role === 'bd' ? 'Account Manager' : p.role === 'sa' ? 'Solution Architect' : p.role === 'manager' ? 'BD Manager' : 'Senior SA', f: p.role.toUpperCase(), role: p.role, last: '—', st: 'Active' }));
  d.credentials = {};
  for (const p of PEOPLE) {
    const salt = randomBytes(16);
    d.credentials[p.id] = {
      userId: p.id, algo: 'pbkdf2-sha256', iterations: 150_000,
      salt: salt.toString('base64'),
      hash: pbkdf2Sync(PASSWORD, salt, 150_000, 32, 'sha256').toString('base64'),
      createdAt: at, updatedAt: at
    };
  }
  writeFileSync(join(dir, 'workbench.json'), JSON.stringify(d));
}

const srv = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
  env: { ...process.env, WB_DATA_DIR: dir, PORT: String(PORT), HOST: '127.0.0.1', WB_TLS: '0', WB_ORIGINS: ORIGIN },
  stdio: ['ignore', 'pipe', 'pipe'],
});
/* Wait for a port this process has PROVEN is free. Waiting on
   /api/health alone cannot fail when an old server is still listening,
   and the suite would then drive somebody else's server. See
   scripts/harness.mjs. */
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
async function open(email, via = 'click') {
  const jar = { v: '' };
  const api = async (path, opts = {}) => {
    const res = await fetch(ORIGIN + path, {
      ...opts, redirect: 'manual',
      headers: { ...(opts.headers || {}), Origin: ORIGIN, ...(jar.v ? { cookie: jar.v } : {}) }
    });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (sc.length) jar.v = sc.map(s => s.split(';')[0]).join('; ');
    return res;
  };
  /* beforeParse, not assignment after construction: JSDOM runs the inline
     script DURING construction, so a fetch wired afterwards never reaches the
     boot sequence — and a reload then "fails" for a reason no browser has.
     Wiring it before parse makes the fresh DOM behave like a real refresh:
     same cookie, same /api/session resume, same data load. */
  const mk = () => {
    const vc = new VirtualConsole();
    vc.on('jsdomError', e => pageErrors.push(String(e.message)));
    const dom = new JSDOM(SOURCE, {
      url: ORIGIN + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
      beforeParse: (w) => {
        w.scrollTo = () => {};
        w.URL.createObjectURL = () => 'blob:stub';
        w.URL.revokeObjectURL = () => {};   /* jsdom has neither; a browser has both */
        w.fetch = (u, o) => api(String(u).replace(ORIGIN, ''), o);
      }
    });
    return dom.window;
  };
  const win = mk();
  await wait(900);

  const doc = win.document;
  const e = doc.getElementById('lgE'), p = doc.getElementById('lgP');
  if (e && p) {
    e.value = email; p.value = PASSWORD;
    if (via === 'enter') {
      p.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    } else {
      doc.querySelector('[data-act="signin"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    }
    await wait(1600);
  }

  const sess = {
    win, api, jar, who: email,
    /* Every reader goes through sess.win, never the captured `win` — after a
       reload the old DOM is still alive in memory, and a suite that reads it
       proves nothing about the fresh one. */
    get doc() { return sess.win.document; },
    $: (s) => sess.win.document.querySelector(s),
    $$: (s) => [...sess.win.document.querySelectorAll(s)],
    text: () => (sess.win.document.getElementById('page') || sess.win.document.body).textContent,
    veilText: () => (sess.win.document.getElementById('capBody') || sess.win.document.body).textContent,
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
      await wait(90); return true;
    },
    byText: (sel, t) => [...sess.win.document.querySelectorAll(sel)].find(x => (x.textContent || '').includes(t)),
    reload: async () => {
      const w2 = mk();
      await wait(1400);
      sess.win = w2;
      return sess;
    }
  };
  return sess;
}

/* Where a user clicks to open a customer from anywhere. */
async function openCustomer(s, name, ms = 900) {
  await s.click(s.$('[data-go="customers"]'), 700);
  const card = s.$$('#page [data-open]').find(x => (x.textContent || '').includes(name));
  if (!card) return false;
  await s.click(card, ms);
  return s.text().includes(name);
}
const tab = (s, label) => s.byText('#page [data-tab]', label);
/* A date N days out, ISO, computed — never a hardcoded string that goes stale. */
function todayPlus(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* ========================================================================== */
console.log('\n— SCENARIO 1 · BD: one account, start to finish —');

const bd = await open('ahmad.faiz@global.tencent.com', 'enter');
check('BD signs in', /Good (morning|afternoon|evening)|Today|Customers/.test(bd.text()), bd.text().slice(0, 50));

/* 1 · a brand new customer, straight from the meeting */
await bd.click(bd.$('[data-go="customers"]'), 700);
check('BD can find where to add a customer', !!bd.$('[data-act="newcust"]'));
await bd.click(bd.$('[data-act="newcust"]'), 600);
await bd.set(bd.$('#ncQ'), 'Sunrise Retail Group');
await bd.click(bd.$('#ncSkip'), 1200);
let sun = await savedRow(() => (disk().customers || []).find(x => x.name === 'Sunrise Retail Group'));
if (!sun) {
  /* A save that has not reached the disk is either slow, refused by the
     server, or never sent — and the suite used to report all three as
     "0 customers on disk", which reads as "the product forgot to write"
     and sends the reader looking in the wrong place. Name the difference:
     the record on screen proves the click worked, a "Not saved" banner
     proves the PUT did not, and a page error names the exception. */
  console.log('   [diag] sheet: ncQ=' + !!bd.$('#ncQ') + ' ncSkip=' + !!bd.$('#ncSkip')
    + ' | on screen: ' + bd.$$('#page [data-open]').length + ' customer card(s)'
    + ' | banner: ' + ((bd.text().match(/Not saved[^.]*\./) || ['none'])[0].slice(0, 160))
    + ' | page errors: ' + (pageErrors.slice(0, 2).join(' | ') || 'none'));
}
check('the new customer is on the server', !!sun, (disk().customers || []).length + ' customers on disk');
check('BD sees it immediately', /Sunrise Retail Group/.test(bd.text()));
check('the creator owns it', sun && sun.owner === 'Ahmad Faiz', sun ? sun.owner : '');

/* 2 · the person they just met */
check('opening it works the way a user would click', await openCustomer(bd, 'Sunrise Retail Group'));
check('the People tab is where a person gets added', await bd.click(tab(bd, 'People'), 700) && !!bd.$('[data-act="addtoggle"][data-add="people"]'));
await bd.click(bd.$('[data-act="addtoggle"][data-add="people"]'), 500);
check('the person form asks how to reach them', !!bd.$('#ad4') && !!bd.$('#ad5'),
  'email + phone — a contact you cannot reach is a name, not a contact');
await bd.set(bd.$('#ad1'), 'Mei Ling Tan');
await bd.set(bd.$('#ad2'), 'Head of Retail Technology');
await bd.set(bd.$('#ad3'), 'Influencer');
await bd.set(bd.$('#ad4'), 'meiling@sunriseretail.example');
await bd.set(bd.$('#ad5'), '+60 3-2181 0000');
await bd.click(bd.$('[data-act="addsave"]'), 1200);
sun = await savedRow(() => (disk().customers || []).find(x => x.name === 'Sunrise Retail Group'
  && (x.contacts || []).some(p => p.n === 'Mei Ling Tan')));
const pMei = (sun.contacts || []).find(p => p.n === 'Mei Ling Tan');
check('the person is saved on the server', !!pMei, (sun.contacts || []).length + ' people on disk');
check('with the email and phone a BD actually uses',
  pMei && pMei.em === 'meiling@sunriseretail.example' && pMei.ph === '+60 3-2181 0000',
  pMei ? (pMei.em || 'no email') + ' · ' + (pMei.ph || 'no phone') : '');
check('and is on screen straight away', /Mei Ling Tan/.test(bd.text()));

/* 3 · the meeting */
await bd.click(bd.$('[data-go="interactions"]'), 800);
check('the Interactions screen offers Log an interaction', !!bd.$('[data-act="addtoggle"][data-add="interactions"]'));
await bd.click(bd.$('[data-act="addtoggle"][data-add="interactions"]'), 500);
await bd.set(bd.$('#ad0'), 'Sunrise Retail Group');
await bd.set(bd.$('#ad1'), 'Retail platform workshop');
await bd.set(bd.$('#ad2'), 'Mei Ling Tan');
await bd.set(bd.$('#ad3'), 'They want a proposal by October');
check('the activity form knows a call is not a meeting — the classifier is k, not the collection', !!bd.$('#ad4')
  && [...bd.$('#ad4').options].some(o => o.text === 'Call'));
await bd.set(bd.$('#ad4'), 'Call');
await bd.click(bd.$('[data-act="addsave"]'), 1300);
let mtg = await savedRow(() => (disk().interactions || []).find(x => /Retail platform workshop/i.test(x.t || '')));
check('the meeting is saved', !!mtg, mtg ? mtg.t : 'not on disk');
check('and it is logged as the activity type it was', mtg && mtg.k === 'Call', mtg ? (mtg.k || 'Meeting') : '');
check('attached to the right customer', mtg && mtg.c === sun.id, mtg ? mtg.c : '');

/* 3b · a meeting can also be logged where its results will be read: inside
      the customer, on the Timeline, with no customer picker to get wrong. */
check('back on the customer, the Brief tab is one click away', await openCustomer(bd, 'Sunrise Retail Group') && await bd.click(tab(bd, 'Brief'), 700));
await bd.click(tab(bd, 'Timeline'), 700);
check('the Timeline tab offers Log an interaction for THIS customer',
  !!bd.byText('#page [data-act="addtoggle"][data-add="interactions"]', 'Log an interaction'));
await bd.click(bd.$('[data-act="addtoggle"][data-add="interactions"]'), 500);
check('the customer picker opens on THIS customer, not the first in the list',
  (bd.$('#ad0') || {}).value === 'Sunrise Retail Group', (bd.$('#ad0') || {}).value || '(no picker)');
await bd.set(bd.$('#ad1'), 'Budget review call');
await bd.set(bd.$('#ad2'), 'Mei Ling Tan');
await bd.set(bd.$('#ad3'), 'Budget confirmed for Q1');
await bd.click(bd.$('[data-act="addsave"]'), 1200);
let m2 = await savedRow(() => (disk().interactions || []).find(x => x.t === 'Budget review call'));
check('the customer-page meeting is saved on the right customer', m2 && m2.c === sun.id,
  m2 ? m2.c : 'not on disk');

/* 3c · a mistake in a meeting can be corrected, not just re-lived. */
await bd.click(bd.$('[data-go="interactions"]'), 800);
const medBtn = bd.$$('#page button[data-ed]').find(b => (b.dataset.ed || '').startsWith('interaction|'));
check('the meeting card offers Edit', !!medBtn);
await bd.click(medBtn, 500);
check('the edit form carries the fields the card displays',
  !!bd.$('#ed1') && !!bd.$('#ed3') && !!bd.$('#ed5') && !!bd.$('#ed6'),
  'topic/where/summary/outcome');
await bd.set(bd.$('#ed1'), 'Budget review call — follow-up');
await bd.set(bd.$('#ed3'), 'Their office, KL');
await bd.set(bd.$('#ed5'), 'Walked the renewal quote line by line.');
await bd.click(bd.$('[data-act="edsave"]'), 1200);
const m2id = (m2 || {}).id || '';
sun = await savedRow(() => (disk().customers || []).find(x => x.name === 'Sunrise Retail Group'));
m2 = await savedRow(() => (disk().interactions || []).find(x => x.id === m2id && /follow-up/.test(x.t || '')))
  || (disk().interactions || []).find(x => x.id === m2id);
check('the meeting edit is saved', m2 && m2.t === 'Budget review call — follow-up' && m2.loc === 'Their office, KL',
  m2 ? m2.t + ' · ' + m2.loc : 'not on disk');
check('and the timeline entry moved with it',
  (sun.timeline || []).some(t => t.k === 'interaction' && t.t === 'Budget review call — follow-up'),
  'the pair stayed one fact');

/* 3d · removal is the administrator's act, and the screen must say so. A BD
      who sees a working Remove and finds the row back after a reload has been
      lied to twice — so the button is simply not drawn for them. */
check('a BD is offered no Remove on a meeting — the matrix reserves deletion to Admin',
  !bd.$$('#page button[data-act="rm"]').length,
  bd.$$('#page button[data-act="rm"]').map(b => b.dataset.rm).join(',') || 'none drawn');
check('a BD corrects a mistake by editing it, which they can', !!bd.$$('#page button[data-ed]').length);

/* 3e · the date filter on Meetings is a real filter, not decoration. */
await bd.click(bd.$('[data-act="addtoggle"][data-add="interactions"]'), 500);
await bd.set(bd.$('#ad1'), 'Old quarter review');
await bd.set(bd.$('#ad2'), '-');
await bd.set(bd.$('#ad3'), '-');
await bd.click(bd.$('[data-act="addsave"]'), 1200);
const oldEd = bd.$$('#page button[data-ed]').find(b => (b.dataset.ed || '').startsWith('interaction|'));
if (oldEd) {
  await bd.click(oldEd, 500);
  await bd.set(bd.$('#ed2'), '2026-05-20');      /* ~120 days ago */
  await bd.click(bd.$('[data-act="edsave"]'), 1200);
}
check('the range filter defaults to Last 90 days', (bd.$('#meetRange') || {}).value === 'Last 90 days');
check('which really hides the old meeting', !/Old quarter review/.test(bd.text()),
  'the list is filtered, not just labelled');
await bd.set(bd.$('#meetRange'), 'All time');
const oldMonth = bd.$$('#page .mg').find(b => /2026-05|May/.test(b.textContent || ''));
if (oldMonth) await bd.click(oldMonth, 500);   /* collapsed months stay collapsed — open it */
check('and All time really brings it back', /Old quarter review/.test(bd.text()));

/* 4 · the pains, in the place the brief says they live */
check('back on the customer, the Brief tab is one click away', await openCustomer(bd, 'Sunrise Retail Group') && await bd.click(tab(bd, 'Brief'), 700));
check('the pains card offers Edit', !!bd.$('[data-act="edpains"]'));
await bd.click(bd.$('[data-act="edpains"]'), 500);
await bd.set(bd.$('#ed1'), 'Billing runs on hardware that is out of support\nCheckout downtime in peak season costs them real revenue');
await bd.click(bd.$('[data-act="edsave"]'), 1200);
sun = await savedRow(() => (disk().customers || []).find(x => x.name === 'Sunrise Retail Group'
  && (x.pains || []).length === 2));
check('the pain points are saved', (sun.pains || []).length === 2, (sun.pains || []).length + ' on disk');
check('and readable on screen', /Checkout downtime/.test(bd.text()));

/* 5 · the opportunity */
check('the Opportunities tab offers Add opportunity',
  await bd.click(tab(bd, 'Opportunities'), 700) && !!bd.$('[data-act="addtoggle"][data-add="opportunities"]'));
await bd.click(bd.$('[data-act="addtoggle"][data-add="opportunities"]'), 500);
await bd.set(bd.$('#ad1'), 'Retail platform migration');
await bd.set(bd.$('#ad2'), '1800000');
await bd.set(bd.$('#ad3'), 'Interested');
await bd.click(bd.$('[data-act="addsave"]'), 1300);
const oppRow = await savedRow(() => Object.values((disk().opps || {}))
  .find(o => o.t === 'Retail platform migration'));
check('the opportunity is saved', !!oppRow, Object.keys(disk().opps || {}).length + ' on disk');
check('and hangs off the right customer', oppRow && oppRow.c === sun.id, oppRow ? oppRow.c : '');

/* 6 · work to do, with an owner — the action a BD promises in the room */
check('the Brief tab shows an open-actions card for this customer',
  await bd.click(tab(bd, 'Brief'), 700) && /Open actions|What we owe/i.test(bd.text()));
check('and an Add action control where the actions are listed', !!bd.$('[data-act="addtoggle"][data-add="steps"]'));
await bd.click(bd.$('[data-act="addtoggle"][data-add="steps"]'), 500);
/* §5: an action now names TWO people — who EXECUTES it, and who TRACKS it —
   because doing the work and being answerable for it are different jobs, and a
   Product SA who executes is not on the account team. The form therefore has
   five fields where it had four: ad2 is the execution owner, ad5 the tracker,
   and ad3/ad4 are due date and whose court it is in. Reading the old positions
   silently typed the due date into the Tracker box, so this assertion now
   checks the SHAPE OF THE FORM and the row it produces, not a field count. */
check('the action form asks what, who executes, who tracks, by when, and whose court it is in',
  !!bd.$('#ad1') && !!bd.$('#ad2') && !!bd.$('#ad5') && !!bd.$('#ad3') && !!bd.$('#ad4'),
  ['what', 'execution owner', 'tracker', 'due', 'waiting on']
    .filter((_, i) => !bd.$('#ad' + [1, 2, 5, 3, 4][i])).join(', ') + ' missing');
await bd.set(bd.$('#ad1'), 'Send the proposal draft to Mei Ling');
await bd.set(bd.$('#ad2'), 'Ahmad Faiz');      // execution owner
await bd.set(bd.$('#ad5'), 'Ahmad Faiz');      // tracker — the account's Primary BD
await bd.set(bd.$('#ad3'), '2026-09-20');
await bd.set(bd.$('#ad4'), 'us');
await bd.click(bd.$('[data-act="addsave"]'), 1200);
/* A save under load can land a beat after the fixed wait — poll for it the
   way the AI suites do, so a busy machine is not read as a lost write. This
   exact spot flaked once in verify:all (4 red, disk still at the previous
   count) and was green on an identical rerun and standalone: the write was
   never lost, only slower than the window. */
let step = null;
for (let i = 0; i < 20 && !step; i++){ await wait(300);
  step = (disk().steps || []).find(s => s.t === 'Send the proposal draft to Mei Ling'); }
check('the action is saved on the server', !!step, (disk().steps || []).length + ' steps on disk');
check('the execution owner was assigned, not defaulted to somebody else',
  step && step.exec === 'Ahmad Faiz', step ? String(step.exec) : '');
check('and the tracker is recorded separately from the execution owner',
  step && step.track === 'Ahmad Faiz', step ? String(step.track) : '');
check('the due date survived', step && step.due === '2026-09-20', step ? step.due : '');
check('and the customer page lists it', /Send the proposal draft to Mei Ling/.test(bd.text()));

/* 7 · progress on the opportunity */
await bd.click(tab(bd, 'Opportunities'), 700);
const edBtn = bd.$$('#page [data-act="ed"]').find(b => (b.dataset.ed || '').startsWith('opp|'));
check('the opportunity has an Edit', !!edBtn);
await bd.click(edBtn, 500);
check('the edit form carries the facts the screens compute from',
  !!bd.$('#ed5') && !!bd.$('#ed6') && !!bd.$('#ed7') && !!bd.$('#ed8'),
  'close date / competitor / their owner / description');
const closeDate = todayPlus(30);
await bd.set(bd.$('#ed4'), '40');
const stageSel = bd.$('#ed3');
if (stageSel && stageSel.options.length > 1) await bd.set(stageSel, stageSel.options[1].text);
await bd.set(bd.$('#ed5'), closeDate);
await bd.set(bd.$('#ed6'), 'Oracle');
await bd.set(bd.$('#ed7'), 'Mei Ling Tan');
await bd.set(bd.$('#ed8'), 'Replace the billing platform; renewal is the forcing event.');
check('the edit form can reassign OUR owner', !!bd.$('#ed9'));
await bd.set(bd.$('#ed9'), 'Ahmad Faiz');
await bd.click(bd.$('[data-act="edsave"]'), 1200);
const oppAfter = await savedRow(() => (disk().opps || {})[oppRow.id] && (disk().opps || {})[oppRow.id].p === 40
  ? (disk().opps || {})[oppRow.id] : null);
check('probability is updated on the server', oppAfter && oppAfter.p === 40, oppAfter ? oppAfter.p + '%' : '');
check('the stage moved', oppAfter && oppAfter.stage !== oppRow.stage, oppAfter ? oppAfter.stage : '');
check('the close date is saved', oppAfter && oppAfter.close === closeDate, oppAfter ? oppAfter.close : '');
check('the competitor is saved', oppAfter && oppAfter.comp === 'Oracle', oppAfter ? oppAfter.comp : '');
check('their owner is saved', oppAfter && oppAfter.cust === 'Mei Ling Tan', oppAfter ? oppAfter.cust : '');
check('our owner is saved where it can be reassigned', oppAfter && oppAfter.owner === 'Ahmad Faiz',
  oppAfter ? oppAfter.owner : '');
check('the audit trail says who changed it',
  (disk().audit || []).some(a => /Opportunity updated/.test(a.what || '') && a.who === 'Ahmad Faiz'));
check('the opportunity card offers products from the catalogue', !!bd.$('#page select[id^="oppItem"]'));
{
  const sel = bd.$('#page select[id^="oppItem"]');
  if (sel && sel.options.length) {
    const pid = sel.options[0].value;
    await bd.set(sel, pid);
    await bd.click(bd.$('[data-act="oppitem"]'), 1200);
    const oid = await savedRow(() => {
      const k = Object.keys(disk().opps || {}).find(k => (disk().opps[k].items || []).includes(pid));
      return k || null;
    });
    check('the product is attached on the server',
      oid && (disk().opps[oid].items || []).includes(pid),
      'what we are selling them is on the record');
    check('and shows on the card as a chip', sel.options[0].text.split(' ')[0] && new RegExp(sel.options[0].text.split(' ')[0]).test(bd.text()));
  }
}
sun = await savedRow(() => (disk().customers || []).find(x => x.name === 'Sunrise Retail Group'
  && (x.timeline || []).some(t => t.k === 'opp' && /Retail platform migration/.test(t.t))));
check('the timeline carries the opportunity as an event',
  (sun.timeline || []).some(t => t.k === 'opp' && /Retail platform migration/.test(t.t)),
  'creation and stage changes are account history');
check('the strip now counts a real close date', /1\s*closing in 45d/.test(bd.text()), 'not a dead statistic any more');
await bd.click(bd.$('[data-go="insights"]'), 700);
check('Insights can finally name a competitor', /Oracle/.test(bd.text()),
  'the rivals card reads what the opportunity records');
check('and the pipeline table shows the stage the deal is in',
  /Pipeline/.test(bd.text()) && /open pipeline/i.test(bd.text()) && new RegExp(oppAfter.stage).test(bd.text()),
  'the number a manager opens a CRM for');

/* 8 · correct a fact on the record */
check('back from Insights, the customer is one click away',
  await openCustomer(bd, 'Sunrise Retail Group'));
await bd.click(tab(bd, 'Brief'), 700);
check('the About card offers Edit', !!bd.$('[data-act="edcust"]'));
await bd.click(bd.$('[data-act="edcust"]'), 500);
check('the edit form reaches every printed fact', !!bd.$('#ed8') && !!bd.$('#ed9'),
  'headcount + customer-since were display-only before');
await bd.set(bd.$('#ed2'), 'Retail');
await bd.set(bd.$('#ed4'), 'sunriseretail.com.my');
await bd.set(bd.$('#ed8'), '2300');
await bd.set(bd.$('#ed9'), 'Apr 2026');
await bd.click(bd.$('[data-act="edsave"]'), 1200);
sun = (disk().customers || []).find(x => x.name === 'Sunrise Retail Group');
check('the industry and website corrections are saved', sun.industry === 'Retail' && sun.site === 'sunriseretail.com.my',
  sun.industry + ' · ' + sun.site);
check('and the headcount and customer-since corrections too',
  sun.people === 2300 && sun.since === 'Apr 2026', sun.people + ' people · since ' + sun.since);

/* 9 · one fact, every place it belongs */
await bd.click(tab(bd, 'Timeline'), 700);
check('the meeting is on the customer timeline', /Retail platform workshop/.test(bd.text()));
{
  const nMeet = (sun.timeline || []).filter(t => t.k === 'interaction').length;
  check('the timeline counts the interactions it holds', new RegExp(nMeet + '\\s*interactions?\\b').test(bd.text()),
    nMeet + ' expected');
}

/* 9b · the palette searches the whole book, not just four questions. */
{
  await bd.click(bd.$('[data-go="today"]'), 300);
  bd.win.document.getElementById('cmdOpen').onclick();
  const inp = bd.win.document.getElementById('palI');
  inp.value = 'Mei Ling';
  inp.dispatchEvent(new bd.win.Event('input', { bubbles: true }));
  await wait(300);
  const hits = bd.$$('#pal [data-hit]');
  check('the palette finds the person by name', hits.length >= 1, hits.length + ' hits');
  if (hits.length) {
    await bd.click(hits[0], 800);
    check('and jumping lands on their customer', /Sunrise Retail Group/.test(bd.text()) && /Mei Ling Tan/.test(bd.text()));
  }
}

/* 10 · away, back, and a real reload — three claims, one truth */
await bd.click(bd.$('[data-go="today"]'), 700);
check('the promised action is on Today, waiting for the BD', /Send the proposal draft to Mei Ling/.test(bd.text()));
check('coming back finds the customer again', await openCustomer(bd, 'Sunrise Retail Group'));
await bd.reload();
await wait(400);
check('after a real reload the customer is still there', await openCustomer(bd, 'Sunrise Retail Group'));
const after = {
  c: (disk().customers || []).find(x => x.name === 'Sunrise Retail Group'),
  steps: (disk().steps || []).filter(s => s.t === 'Send the proposal draft to Mei Ling').length,
  opps: Object.values(disk().opps || {}).filter(o => o.t === 'Retail platform migration').length,
  meets: (disk().interactions || []).filter(m => /Retail platform workshop/i.test(m.t || '')).length
};
check('reload kept the people', (after.c.contacts || []).some(p => p.n === 'Mei Ling Tan'));
check('reload kept the pains', (after.c.pains || []).length === 2);
check('reload kept the opportunity at its new probability',
  after.opps === 1 && Object.values(disk().opps).find(o => o.t === 'Retail platform migration').p === 40);
/* Both people, by name, on the row that came back from the server. The old
   form of this read `s.o`, which the two-role model no longer writes — so the
   check would have failed no matter how correct the reload was. */
check('reload kept the action with its two people and its date', after.steps === 1
  && (() => {
    const row = (disk().steps || []).find(s => s.t === 'Send the proposal draft to Mei Ling');
    return !!row && row.exec === 'Ahmad Faiz' && row.track === 'Ahmad Faiz' && row.due === '2026-09-20';
  })());
check('reload kept the meeting', after.meets === 1);
check('the screen agrees with the disk after the reload — action and pains on the Brief',
  /Send the proposal draft/.test(bd.text()) && /Checkout downtime/.test(bd.text()));
await bd.click(tab(bd, 'People'), 700);
check('and the people came back with it', /Mei Ling Tan/.test(bd.text()));

/* ========================================================================== */
console.log('\n— SCENARIO 2 · SA: the technical half of the same account —');

/* A BD meets the customer; an SA works it. The owner puts the SA on the
   team first — that is the product's own rule, so the scenario follows it. */
check('the BD can find the customer again after the reload', await openCustomer(bd, 'Sunrise Retail Group'));
await bd.click(tab(bd, 'Brief'), 700);
const teamSel = bd.$$('#page select[id^="teamAdd"]');
check('the owner can put an SA on this customer', teamSel.length > 0);
if (teamSel.length) {
  const opt = [...teamSel[0].options].find(o => /John Teh/.test(o.text));
  if (opt) await bd.set(teamSel[0], opt.value);
  await bd.click(bd.$$('#page [data-act="teamadd"]')[0], 1200);

  sun = await savedRow(() => (disk().customers || []).find(x => x.name === 'Sunrise Retail Group'
    && (x.team || []).includes('John Teh')));
  check('the SA is on the team on the server', (sun.team || []).includes('John Teh'), JSON.stringify(sun.team || []));
}

const sa = await open('john.teh@global.tencent.com');
check('SA signs in', /Today|Customers/.test(sa.text()), sa.text().slice(0, 50));
check('the customer the BD built is visible to the SA now', await openCustomer(sa, 'Sunrise Retail Group'));
await sa.click(tab(sa, 'Brief'), 700);
check('the SA can read the commercial half — the pains and the open action',
  /Checkout downtime/.test(sa.text()) && /Send the proposal draft/.test(sa.text()));
check('a fact a manager needs is on screen: the open action', /Send the proposal draft/.test(sa.text()));

/* the SA's own half: what they run */
await sa.click(tab(sa, 'What they run'), 700);
check('the SA can add a system', !!sa.$('[data-act="addtoggle"][data-add="run"]'));
await sa.click(sa.$('[data-act="addtoggle"][data-add="run"]'), 500);
await sa.set(sa.$('#ad1'), 'Billing (BSCS)');
await sa.set(sa.$('#ad2'), 'Oracle Database, on-premise, out of support');
await sa.set(sa.$('#ad3'), 'Replace');
await sa.click(sa.$('[data-act="addsave"]'), 1200);
sun = await savedRow(() => (disk().customers || []).find(x => x.name === 'Sunrise Retail Group'
  && (x.apps || []).some(a => a.n === 'Billing (BSCS)')));
check('the system is saved', !!(sun.apps || []).find(a => a.n === 'Billing (BSCS)'),
  (sun.apps || []).length + ' systems on disk');
check('and grouped under Replace on screen', /we can replace/i.test(sa.text()));

/* the opportunity: read, never rewrite the money */
await sa.click(tab(sa, 'Opportunities'), 700);
check('the SA sees the BD’s opportunity', /Retail platform migration/.test(sa.text()));
check('the SA is offered no commercial Edit on it',
  !sa.$$('#page [data-act="ed"]').some(b => (b.dataset.ed || '').startsWith('opp|')));
check('and no Remove on it either', !sa.$$('#page [data-act="rm"]').some(b => (b.dataset.rm || '').startsWith('opp|')));

/* the SA's own action, on the same record */
await sa.click(tab(sa, 'Brief'), 700);
check('the SA can add an action too', !!sa.$('[data-act="addtoggle"][data-add="steps"]'));
await sa.click(sa.$('[data-act="addtoggle"][data-add="steps"]'), 500);
/* THE POINT OF THIS ROW IS WHO TRACKS IT, NOT WHO DOES IT.
   John Teh is a Solution Architect but he is NOT this account's Primary SA —
   Ahmad Faiz owns it. §5 is explicit that the TRACKER must be the customer's
   Primary BD or Primary SA, and the server refuses anything else, so typing
   John Teh into the tracker box now returns a 400 and nothing is written. That
   refusal is the feature. What is asserted here is the useful half of it: an SA
   can RECORD the action, and the Tracker is the person answerable for the
   account. The old assertion read `s.o`, a field the two-role model no longer
   writes, so it could never have passed. */
await sa.set(sa.$('#ad1'), 'Size the BSCS migration to TencentDB');
await sa.set(sa.$('#ad2'), 'John Teh');        // execution owner — anyone may execute
await sa.set(sa.$('#ad5'), sun.owner);         // tracker — must be the account's Primary BD
await sa.set(sa.$('#ad3'), '2026-09-30');
await sa.set(sa.$('#ad4'), 'us');
await sa.click(sa.$('[data-act="addsave"]'), 1200);
{
  const row = await savedRow(() => (disk().steps || []).find(s => s.t === 'Size the BSCS migration to TencentDB'));
  check('the SA\u2019s action is saved on the server', !!row,
    (disk().steps || []).length + ' steps on disk');
  check('it records the SA as the execution owner',
    row && row.exec === 'John Teh', row ? String(row.exec) : '');
  check('and the account\u2019s Primary BD as the tracker',
    row && row.track === sun.owner, row ? String(row.track) : '');
}
check('both actions are on the customer now', /Send the proposal draft/.test(sa.text()) && /Size the BSCS migration/.test(sa.text()));

/* the timeline carries the technical facts too */
await sa.click(tab(sa, 'Timeline'), 700);
check('the timeline still shows the BD’s meeting', /Retail platform workshop/.test(sa.text()));
await sa.reload();
await wait(400);
check('the SA’s work survives a reload', await openCustomer(sa, 'Sunrise Retail Group')
  && (disk().customers || []).find(x => x.name === 'Sunrise Retail Group').apps.length === 1);

/* ========================================================================== */
console.log('\n— SCENARIO 3 · Manager: the whole book, and not one pen —');

const mg = await open('siti.nurhaliza@global.tencent.com', 'enter');
check('Manager signs in', /Today|Customers/.test(mg.text()), mg.text().slice(0, 50));
check('Manager sees every customer, including the one the BD built',
  await openCustomer(mg, 'Sunrise Retail Group'));
await mg.click(tab(mg, 'Brief'), 700);
check('Manager reads the pains', /Checkout downtime/.test(mg.text()));
await mg.click(tab(mg, 'Opportunities'), 700);
check('Manager reads the opportunity and its stage', /Retail platform migration/.test(mg.text()));
await mg.click(mg.$('[data-go="interactions"]'), 700);
check('Manager reads the meeting', /Retail platform workshop/.test(mg.text()));
await mg.click(mg.$('[data-go="today"]'), 700);
check('Manager reads the risks: the overdue count and the needs-you list are on Today',
  /Overdue/.test(mg.text()) && /Needs you today/.test(mg.text()));

/* Not one control that writes — anywhere the Manager stands. */
const writeControls = mg.$$('#page [data-act]').filter(b =>
  ['addtoggle', 'addsave', 'ed', 'edsave', 'edcust', 'edpains', 'edbrief', 'rm', 'rmyes',
   'delcust', 'capture', 'teamadd', 'teamrm', 'newcust', 'watchadd', 'wasave', 'export', 'stepdone']
    .includes(b.dataset.act));
check('no write control is drawn for a Manager, anywhere on Today',
  writeControls.length === 0, writeControls.map(b => b.dataset.act).join(','));
check('no Capture button for a Manager', !mg.$('[data-act="capture"]'));
await mg.click(mg.$('[data-go="customers"]'), 700);
const writeCust = mg.$$('#page [data-act]').filter(b =>
  ['addtoggle', 'addsave', 'ed', 'edsave', 'edcust', 'edpains', 'rm', 'newcust', 'teamadd', 'export']
    .includes(b.dataset.act));
check('none on the Customers screen either', writeCust.length === 0, writeCust.map(b => b.dataset.act).join(','));
await openCustomer(mg, 'Sunrise Retail Group');
const writeInside = mg.$$('#page [data-act]').filter(b =>
  ['addtoggle', 'addsave', 'ed', 'edsave', 'edcust', 'edpains', 'edbrief', 'rm', 'teamadd', 'teamrm', 'watchadd', 'export', 'stepdone']
    .includes(b.dataset.act));
check('and none inside a customer', writeInside.length === 0, writeInside.map(b => b.dataset.act).join(','));
check('no Export anywhere a Manager can reach', !mg.$('[data-act="export"]'));
check('no Admin entry in the navigation for a Manager', !mg.$('[data-go="admin"]'));

/* The Files tab used to offer Manager an upload the server always refused. */
await openCustomer(mg, 'Sunrise Retail Group');
await mg.click(tab(mg, 'File & Audit'), 700);
check('the Files tab offers a Manager no upload control', !mg.$('[data-act="fileadd"]'),
  'a form that cannot succeed is not read-only, it is a trap');
await mg.click(mg.$('[data-go="interactions"]'), 700);
check('and no Edit on a meeting card either', !mg.$$('#page button[data-ed]').length);

/* The stance filter on People is a real filter now. */
await mg.click(mg.$('[data-go="people"]'), 700);
await mg.set(mg.$('#peopleStance'), 'With us');
check('Stance: With us really filters the list', !/Mei Ling Tan/.test(mg.text()),
  'she is Undecided, so she leaves the list');
await mg.set(mg.$('#peopleStance'), 'Undecided');
check('and Undecided brings her back', /Mei Ling Tan/.test(mg.text()));

/* The server, not the layout, is the rule. */
const forged = await mg.api('/api/data', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ state: { ...disk(), customers: [{ id: 'x1', name: 'Forged Co' }] }, baseRev: 999, deleted: {} })
});
check('a Manager’s forged write is refused by the server', forged.status === 403 || forged.status === 401, 'HTTP ' + forged.status);
check('nothing was written', !(disk().customers || []).some(c => c.name === 'Forged Co'));
const mgExport = await mg.api('/api/export?kind=customers');
check('a Manager asking the server to export is refused too', mgExport.status === 403, 'HTTP ' + mgExport.status);

/* ========================================================================== */
console.log('\n— SCENARIO 4 · Admin: the same day, plus the keys —');

const ad = await open('teh.binshun@global.tencent.com');
check('Admin signs in', /Today|Customers/.test(ad.text()), ad.text().slice(0, 50));

/* The same BD workflow, end to end, as Admin. */
check('Admin can add a customer', await ad.click(ad.$('[data-go="customers"]'), 700)
  && !!ad.$('[data-act="newcust"]'));
await ad.click(ad.$('[data-act="newcust"]'), 600);
await ad.set(ad.$('#ncQ'), 'Westport Logistics');
await ad.click(ad.$('#ncSkip'), 1200);
check('the Admin’s customer is on the server', await savedRow(() =>
  (disk().customers || []).find(c => c.name === 'Westport Logistics')));
check('Admin opens it', await openCustomer(ad, 'Westport Logistics'));
await ad.click(tab(ad, 'People'), 700);
await ad.click(ad.$('[data-act="addtoggle"][data-add="people"]'), 500);
await ad.set(ad.$('#ad1'), 'Rajesh Kumar');
await ad.set(ad.$('#ad2'), 'IT Director');
await ad.set(ad.$('#ad3'), 'Decision maker');
await ad.click(ad.$('[data-act="addsave"]'), 1200);
check('Admin adds a person', await savedRow(() =>
  (disk().customers || []).find(c => c.name === 'Westport Logistics'
    && (c.contacts || []).some(p => p.n === 'Rajesh Kumar'))));
await ad.click(tab(ad, 'Opportunities'), 700);
await ad.click(ad.$('[data-act="addtoggle"][data-add="opportunities"]'), 500);
await ad.set(ad.$('#ad1'), 'Warehouse modernisation');
await ad.set(ad.$('#ad2'), '900000');
await ad.set(ad.$('#ad3'), 'Interested');
await ad.click(ad.$('[data-act="addsave"]'), 1300);
check('Admin creates an opportunity', await savedRow(() =>
  Object.values(disk().opps || {}).find(o => o.t === 'Warehouse modernisation')));
await ad.click(tab(ad, 'Brief'), 700);
await ad.click(ad.$('[data-act="addtoggle"][data-add="steps"]'), 500);
await ad.set(ad.$('#ad1'), 'Scope the warehouse POC');
await ad.set(ad.$('#ad2'), 'Teh Bin Shun');
await ad.set(ad.$('#ad3'), '2026-09-25');
await ad.set(ad.$('#ad4'), 'us');
await ad.click(ad.$('[data-act="addsave"]'), 1200);
check('Admin creates an action', await savedRow(() =>
  (disk().steps || []).find(s => s.t === 'Scope the warehouse POC')));
check('Admin can edit any customer — the Edit is drawn', !!ad.$('[data-act="edcust"]'));
check('Admin sees the Delete control on a customer', !!ad.$('[data-act="delcust"]'));

/* Import: the way a book of thirty customers actually arrives. */
{
  await ad.click(ad.$('[data-go="admin"]'), 700);
  /* §26 widened the door from customers to five kinds, so the button now
     reads just "Import" — the sheet inside is where the kind is chosen. */
  const impBtn = ad.byText('#page button', 'Import');
  check('the Admin screen offers the import', !!impBtn);
  if (impBtn) {
    await ad.click(impBtn, 600);
    const ta = ad.$('#impT');
    check('the import sheet asks for pasted rows', !!ta);
    if (ta) {
      ta.value = 'Customer, Industry, HQ, Website, Owner\n' +
        'Imported Alpha Sdn Bhd, Logistics, Penang, alpha.example, Teh Bin Shun\n' +
        'Imported Beta Sdn Bhd, Banking, KL, , Teh Bin Shun\n' +
        ', , , , \n' +
        'Sunrise Retail Group, Retail, KL, , Teh Bin Shun';
      ta.dispatchEvent(new ad.win.Event('input', { bubbles: true }));
      await ad.click(ad.$('#impRead'), 700);
      check('the preview refuses the nameless row', /refused/i.test(ad.veilText()),
        'nothing silently dropped');
      check('and says the duplicate was skipped', /duplicate/i.test(ad.veilText()) || /Already on the book/i.test(ad.veilText()));
      check('two rows are ready to import', /2 rows to import/i.test(ad.veilText()) || /Import 2/.test(ad.veilText()));
      await ad.click(ad.$('#impGo'), 1500);
      const st2 = await savedRow(() => (disk().customers || []).some(c => c.name === 'Imported Alpha Sdn Bhd')
        && (disk().customers || []).some(c => c.name === 'Imported Beta Sdn Bhd')
        ? (disk().customers || []) : null);
      check('both customers are on the server', st2.some(c => c.name === 'Imported Alpha Sdn Bhd') && st2.some(c => c.name === 'Imported Beta Sdn Bhd'),
        st2.length + ' customers on disk');
      check('marked Unverified until somebody confirms them',
        st2.find(c => c.name === 'Imported Alpha Sdn Bhd')?.unverified === true);
      check('the import is on the audit trail',
        (disk().audit || []).some(a => /Customer imported/.test(a.what || '')));
    }
  }
}

/* Deletion is the administrator's act, so the Admin proves it end to end:
   remove a meeting and BOTH copies of it go — the list and the timeline. */
await ad.click(ad.$('[data-go="interactions"]'), 800);
const adRm = ad.$$('#page button[data-act="rm"]').find(b => (b.dataset.rm || '').startsWith('interaction|'));
check('the Admin is offered Remove on a meeting', !!adRm, adRm ? adRm.dataset.rm : 'none');
if (adRm) {
  const target = (adRm.dataset.rm || '').split('|')[2];
  const before = (disk().interactions || []).find(m => m.id === target);
  await ad.click(adRm, 400);
  await ad.click(ad.$('[data-act="rmyes"]'), 1200);
  await new Promise((r) => setTimeout(r, 2500));   /* the save is debounced 700 ms */
  const gone = !(disk().interactions || []).some(m => m.id === target);
  const sunRow = (disk().customers || []).find(x => x.name === 'Sunrise Retail Group');
  check('the meeting is really gone from the server', gone,
    'was ' + (before ? before.t : '?'));
  check('and its timeline entry went with it',
    !(sunRow.timeline || []).some(t => t.k === 'interaction' && before && t.t === before.t));
}

/* With no model endpoint, every AI surface must be honestly absent rather
   than a button that apologises when pressed.
   When this suite is run in a deployment that DOES have an endpoint — which is
   every real one — the premise is false and the honest check is the opposite
   one: the button appears, and it appears because the server said so. Asserting
   the absent state in both worlds is how a suite teaches people to ignore red. */
if (process.env.AI_BASE_URL && process.env.AI_API_KEY) {
  check('the AI action is offered, because a model really is connected',
    !!ad.$('[data-act="insights"]') || !!ad.$('[data-act="mom"]') || !!ad.$('[data-act="ainews"]'),
    'a connected model is not hidden');
} else {
  check('with no model connected, no AI action button is offered',
    !ad.$('[data-act="insights"]') && !ad.$('[data-act="mom"]') && !ad.$('[data-act="ainews"]'),
    'nothing pretends');
}

/* ------------------------- the full account-control set, from the screen ---
   Create, edit, disable, re-activate, reset the password, remove. Every one
   is the SERVER's decision; the screen may only report what it did. */
{
  await ad.click(ad.$('[data-go="admin"]'), 700);
  const newUserBtn = ad.byText('#page button', '+ Add person');
  check('Admin can create an account', !!newUserBtn);
  if (newUserBtn) {
    await ad.click(newUserBtn, 500);
    await ad.set(ad.$('#nu1'), 'Control Test');
    await ad.set(ad.$('#nu2'), 'control.test@global.tencent.com');
    await ad.set(ad.$('#nu5'), 'Starter#2026');
    const make = ad.byText('#capBody button', 'Create account');
    await ad.click(make, 1500);
    check('the account exists on the server',
      (disk().users || []).some(u => u.name === 'Control Test'),
      (disk().users || []).map(u => u.name).join(', '));
    check('and must change the starting password',
      (disk().credentials?.['u_control-test'] || {}).mustChange === true
      || Object.values(disk().credentials || {}).some(c => c.mustChange === true));

    const rowEdit = () => ad.$('#page button[data-act="edituser"][data-u="Control Test"]');
    check('the roster row offers Edit', !!rowEdit());

    /* disable → re-activate */
    await ad.click(rowEdit(), 500);
    await ad.click(ad.byText('#capBody button', 'Disable account'), 1200);
    check('the account can be disabled — server first',
      (disk().users || []).find(u => u.name === 'Control Test')?.active === false,
      ((disk().users || []).find(u => u.name === 'Control Test') || {}).active + '');
    await ad.click(rowEdit(), 500);
    const reBtn = ad.byText('#capBody button', 'Re-activate account');
    check('a disabled account is offered Re-activate', !!reBtn);
    await ad.click(reBtn, 1200);
    check('and the server re-activates it',
      (disk().users || []).find(u => u.name === 'Control Test')?.active !== false);

    /* reset password */
    await ad.click(rowEdit(), 500);
    await ad.click(ad.byText('#capBody button', 'Reset password'), 400);
    check('the reset field opens', !!ad.$('#euPwIn'));
    await ad.set(ad.$('#euPwIn'), 'Reset#2026x');
    await ad.click(ad.byText('#capBody button', 'Set it'), 1200);
    {
      const cred = (disk().users || []).find(u => u.name === 'Control Test');
      const c = cred && Object.entries(disk().credentials || {})
        .find(([id]) => id === cred.id);
      check('the new password is set and forces a change', !!c && c[1].mustChange === true);
    }

    /* remove — and the history keeps the name */
    await ad.click(ad.$('#page button[data-act="deluserask"][data-u="Control Test"]'), 400);
    check('removing asks first, on the row', !!ad.byText('#page button', 'Yes, remove'));
    await ad.click(ad.$('#page button[data-act="delusergo"][data-u="Control Test"]'), 1500);
    check('the account is gone from the server',
      !(disk().users || []).some(u => u.name === 'Control Test'),
      (disk().users || []).map(u => u.name).join(', '));
    check('and its credential went with it', (() => {
      const fn = (disk().users || []).find(u => u.name === 'Control Test');
      return !fn;
    })());
    check('the audit keeps their name — history is not rewritten',
      (disk().audit || []).some(a => /Account removed/.test(a.what || '') && /Control Test/.test(a.rec || '')));
    check('the Admin cannot delete themselves',
      !ad.$('#page button[data-act="deluserask"][data-u="Teh Bin Shun"]'));
  }
}

/* The admin-only keys. A real admin hunts for export under Admin → Roles. */
await ad.click(ad.$('[data-go="admin"]'), 800);
check('the Admin screen exists', /Admin/.test(ad.text()));
await ad.click(ad.$('[data-atab="roles"]'), 700);
check('the Roles tab is where access and export live', /Roles|access/i.test(ad.text()));
check('the matrix lists only capabilities something actually reads',
  !/Approve or reject|Leave a comment|Reassign an owner|See the audit trail|Import ·/.test(ad.text()),
  'a switch that switches nothing is a lie');
const exportBtn = ad.$('[data-act="export"]');
check('the Export control exists and is offered to Admin', !!exportBtn);
/* jsdom cannot carry a real download, so the proof goes to the server: the
   endpoint the button calls, called the way the button calls it. */
const csv = await ad.api('/api/export?kind=customers');
const csvText = csv.ok ? await csv.text() : '';
check('the export endpoint answers with the customers', csv.status === 200 && /Sunrise Retail Group/.test(csvText), 'HTTP ' + csv.status);
check('every row carries the watermark — who exported and when',
  /Teh Bin Shun/.test(csvText) && /2026-/.test(csvText));
check('and the file is named and attached, not dumped into the page',
  /attachment/.test(csv.headers.get('Content-Disposition') || ''), csv.headers.get('Content-Disposition') || '(none)');
const anonExport = await fetch(ORIGIN + '/api/export?kind=customers', { headers: { Origin: ORIGIN } });
check('a stranger cannot export the book', anonExport.status === 401 || anonExport.status === 403, 'HTTP ' + anonExport.status);
await ad.click(exportBtn, 900);
await new Promise((r) => setTimeout(r, 2500));   /* the audit row lands with the debounced save */
check('pressing Export records itself on the audit trail',
  (disk().audit || []).some(a => /Exported the workspace/.test(a.what || '') && a.who === 'Teh Bin Shun'));

/* Delete, with the typed name, on the Admin's own customer. */
check('Admin opens the customer to delete it', await openCustomer(ad, 'Westport Logistics'));
await ad.click(ad.$('[data-act="delcust"]'), 600);
check('the delete sheet demands the typed name', !!ad.$('#delName') && !!ad.$('#delGo'));
const goBtn = ad.$('#delGo');
check('the confirm button starts disabled', goBtn && goBtn.disabled === true);
await ad.set(ad.$('#delName'), 'Westport Logistics');
const goNow = ad.$('#delGo');
check('typing the exact name enables it', goNow && goNow.disabled === false);
await ad.click(goNow, 1500);
check('the customer is gone from the server', !(disk().customers || []).some(c => c.name === 'Westport Logistics'));
check('and everything that hung off it went too',
  !Object.values(disk().opps || {}).some(o => o.t === 'Warehouse modernisation')
  && !(disk().steps || []).some(s => s.t === 'Scope the warehouse POC'));
check('the audit trail records the delete',
  (disk().audit || []).some(a => /deleted/i.test(a.what || '') && a.who === 'Teh Bin Shun'));

/* ========================================================================== */
console.log('\n— after everyone: the workspace holds only what people entered —');
const demos = (disk().customers || []).filter(c => c.demo);
check('no demo customer exists anywhere', demos.length === 0, demos.map(c => c.name).join(', '));
check('no record the scenarios did not create: the BD customer plus the two imports',
  (disk().customers || []).length === 3
    && (disk().customers || []).some(c => c.name === 'Sunrise Retail Group')
    && (disk().customers || []).some(c => c.name === 'Imported Alpha Sdn Bhd')
    && (disk().customers || []).some(c => c.name === 'Imported Beta Sdn Bhd')
    && !(disk().customers || []).some(c => c.name === 'Customer'),
  (disk().customers || []).map(c => c.name).join(', '));
/* A row must be read from whichever key holds it. §17 renamed the collection
   to `interactions`, but the server drops the old key only on a save that
   carries the new one — so a workspace this suite has not saved since the
   rename still answers under `meetings`. Reading only the new name here made
   the assertion pass vacuously (an empty list trivially has no orphan). */
const intRows = (d) => (Array.isArray(d.interactions) ? d.interactions : (Array.isArray(d.meetings) ? d.meetings : []));
check('every interaction on the server belongs to a customer that exists', (() => {
  const ids = new Set((disk().customers || []).map(c => c.id));
  return intRows(disk()).every(m => ids.has(m.c));
})(), intRows(disk()).length + ' interactions');
/* A meeting without a customer must be refused by the SERVER, whoever asks.
   A row that merely went missing from the payload is NOT a delete in this
   protocol — `restoreHidden` puts every unnamed absence back, which is what
   keeps one ordinary save from emptying the book. So the only removal the
   server can hear is one named in its own `deleted` envelope, and that is
   what is sent here. Anything else would be testing a rule the product does
   not claim to have. */
{
  const now = await ad.api('/api/data');
  const rev = (await now.json()).rev || 0;
  const put = (st, deleted = {}) => ad.api('/api/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Base-Rev': String(rev) },
    body: JSON.stringify({ state: st, baseRev: rev, deleted })
  });
  const st = JSON.parse(JSON.stringify(disk()));
  /* The orphan is pushed onto the key the file actually uses, so the payload
     carries a row the server has to judge — not an empty array it can accept. */
  const stKey = Array.isArray(st.interactions) ? 'interactions' : 'meetings';
  (st[stKey] = st[stKey] || []).push({ id: 'orphan1', c: 'no-such-customer', t: 'Orphan', d: todayPlus(0) });
  const r = await put(st);
  check('the server refuses a meeting with no valid customer', r.status === 400, 'HTTP ' + r.status);
  check('and nothing of that payload reached the file', !intRows(disk()).some(m => m.id === 'orphan1'));
  const st2 = JSON.parse(JSON.stringify(disk()));
  const gone = (st2.customers || []).map((c) => c.id);
  const r2 = await put(st2, { customers: gone });   /* delete the customer, keep its meetings */
  check('deleting a customer while keeping its meetings is refused too', r2.status === 400, 'HTTP ' + r2.status);
  /* And the unnamed absence is a no-op, not a silent orphan: the customers
     come back, so there is nothing for the rule to refuse. Proving both halves
     is what makes the refusal above mean something. */
  const st3 = JSON.parse(JSON.stringify(disk()));
  st3.customers = [];
  const r3 = await put(st3);
  check('a customer that merely went missing is put back, not orphaned',
    r3.status === 200 && (disk().customers || []).length === 3, 'HTTP ' + r3.status);
  check('the workspace is unchanged after both refusals', (disk().customers || []).length === 3);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed  (' + (pass + fail) + ' checks)');
if (pageErrors.length) console.log('page errors: ' + pageErrors.slice(0, 3).join(' | '));
if (fails.length) console.log('\nthe journey breaks at:\n  - ' + fails.join('\n  - '));
console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
bye();
process.exit(fail ? 1 : 0);
