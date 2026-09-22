/* verify:journey — walk the app the way a person uses it, and say exactly
   which step of the day breaks.

   WHY THIS EXISTS
   ---------------
   Every other suite asserts a feature: this button exists, that row saves.
   None of them answers the only question that matters: can a BD get through a
   real day — meet someone, add the customer, add the people, log the meeting,
   write the pain, open the opportunity, promise the follow-up, hand it to a
   colleague, come back next week, change something, and find it all again?

   A feature can pass every check above and still be unreachable, unfindable
   or unchangeable from where the user actually stands. So this suite does not
   test features. It walks a day, per role, in the shipped HTML, against a
   real server, and fails on the step where the person gets stuck.

   It also reloads the page mid-journey (a fresh DOM on the same session) and
   carries on, because "it is on the screen" and "it survived the refresh" are
   two different claims and only the second one is true.

   Run from customer-workbench/:  npm run verify:journey
*/
import { spawn } from 'node:child_process';
import { claimPort } from './harness.mjs';
import { mkdtempSync, copyFileSync, readFileSync } from 'node:fs';
import { readWorkspaceFile } from './disk.mjs';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.JOURNEY_PORT || 8851);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const PASSWORD = 'Waypoint#2026';
const HTML = join(ROOT, 'Waypoint-v1.html');
const SOURCE = readFileSync(HTML, 'utf8');

let pass = 0, fail = 0;
const fails = [];
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** Wait for a fact to reach the disk, polling instead of sleeping a fixed
 *  guess. A fixed wait can only be wrong twice — too short and it fails a
 *  working product under load (which is exactly how this suite once flaked
 *  inside verify:all while passing on its own), too long and it slows every
 *  run down. Predicates must tolerate a not-yet state and return the fact
 *  when it lands (undefined/false keeps polling). */
async function lands(pred, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() >= end) return pred();
    await wait(200);
  }
}

/* ------------------------------------------------------------------- seed */

const dir = mkdtempSync(join(tmpdir(), 'wp-journey-'));
copyFileSync(join(ROOT, 'data', 'workbench.json'), join(dir, 'workbench.json'));
const disk = () => readWorkspaceFile(join(dir, 'workbench.json'));

/* Four people, four roles, one password. Seeded on disk rather than created
   through the UI because this suite is about using the product, not setting
   it up — and because a journey that fails at "make me an account" tells us
   nothing about the journey. */
const PEOPLE = [
  { id: 'u_kelvin', name: 'Teh Bin Shun', role: 'admin' },
  { id: 'u_ahmad', name: 'Ahmad Faiz', role: 'bd' },
  { id: 'u_john', name: 'John Teh', role: 'sa' },
  { id: 'u_siti', name: 'Siti Nurhaliza', role: 'manager' }
];
{
  const d = disk();
  const at = new Date().toISOString();
  /* The stage picker is built from the workspace's own configured list. A
     fresh app ships a different default list than this journey walks, and a
     journey that depends on whichever list happens to be in data/ today is
     not testing the product — so the suite names its own stages, the same
     way it names its own people. */
  d.config = { stages: ['Interested', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost'] };
  d.users = PEOPLE.map(p => ({ id: p.id, name: p.name, role: p.role, title: p.role, locked: false, createdAt: at, updatedAt: at }));
  /* The roster the team pickers read. The baked demo roster used to supply
     this by accident; now the suite says who its own people are. */
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
  const { writeFileSync } = await import('node:fs');
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

async function up() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(ORIGIN + '/api/health')).ok) return true; } catch { /* not yet */ }
    await wait(150);
  }
  return false;
}

const pageErrors = [];

/* --------------------------------------------------------------- session */

/** One signed-in browser. `reload()` throws the DOM away and keeps the session.
 *  `via='enter'` signs in the way people actually do — typing the password and
 *  pressing Enter — to hold the shortcut to the same standard as the button. */
async function open(email, via = 'click') {
  const jar = { v: '' };
  const api = async (path, opts = {}) => {
    if (path === '/api/data' && opts.method === 'PUT' && process.env.JOURNEY_DEBUG) {
      try {
        const b = JSON.parse(opts.body);
        console.log('   [put] rev=' + b.baseRev +
          ' customers=' + ((b.state.customers || []).length) +
          ' team=' + ((b.state.team || []).length) +
          ' names=' + JSON.stringify((b.state.customers || []).map(x => x.name)));
      } catch (e) { /* ignore */ }
    }
    const res = await fetch(ORIGIN + path, {
      ...opts, redirect: 'manual',
      headers: { ...(opts.headers || {}), Origin: ORIGIN, ...(jar.v ? { cookie: jar.v } : {}) }
    });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (sc.length) jar.v = sc.map(s => s.split(';')[0]).join('; ');
    return res;
  };
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => pageErrors.push(String(e.message)));
  const dom = new JSDOM(SOURCE, {
    url: ORIGIN + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc
  });
  const win = dom.window;
  win.scrollTo = () => {};
  win.URL.createObjectURL = () => 'blob:stub';
  win.fetch = (u, o) => api(String(u).replace(ORIGIN, ''), o);
  await wait(900);

  let doc = win.document;
  const e = doc.getElementById('lgE'), p = doc.getElementById('lgP');
  if (e && p) {
    e.value = email; p.value = PASSWORD;
    if (via === 'enter') {
      p.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    } else {
      const btn = doc.querySelector('[data-act="signin"]');
      btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    }
    await wait(1600);
  }

  const sess = {
    win, api, jar,
    get doc() { return win.document; },
    $: (s) => win.document.querySelector(s),
    $$: (s) => [...win.document.querySelectorAll(s)],
    text: () => (win.document.getElementById('page') || win.document.body).textContent,
    veilText: () => (win.document.getElementById('capBody') || win.document.body).textContent,
    click: async (el, ms = 320) => {
      if (!el) return false;
      el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await wait(ms); return true;
    },
    set: async (el, v) => {
      if (!el) return false;
      el.value = v;
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
      el.dispatchEvent(new win.Event('change', { bubbles: true }));
      await wait(90); return true;
    },
    byText: (sel, t) => [...win.document.querySelectorAll(sel)].find(x => (x.textContent || '').includes(t)),
    /* Throw the DOM away, keep the session cookie: a real refresh. */
    reload: async () => {
      const vc2 = new VirtualConsole();
      vc2.on('jsdomError', e => pageErrors.push(String(e.message)));
      const d2 = new JSDOM(SOURCE, {
        url: ORIGIN + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc2
      });
      const w2 = d2.window;
      w2.scrollTo = () => {};
      w2.URL.createObjectURL = () => 'blob:stub';
      w2.fetch = (u, o) => api(String(u).replace(ORIGIN, ''), o);
      await wait(1400);
      sess.win = w2;
      return sess;
    }
  };
  return sess;
}

/* Wait for the app to reach a state, on a REAL timer rather than a spin loop.
   A `for (…) await wait(…)` loop looks equivalent and is not: each trip runs a
   fresh microtask turn while the JSDOM window it is inspecting keeps its own
   `pretendToBeVisual` frames coming, and a loop that outlives the work it was
   waiting for grows the heap until node dies with an allocation failure —
   which is what happened the first time this wait was written. `setTimeout`
   fires once, is cleared, and gives the event loop the idle time the window
   needs to finish its render. */
function waitForScreen(sess, ready, budgetMs = 6000) {
  return new Promise((res) => {
    const started = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = !!ready(); } catch { ok = false; }
      if (ok || Date.now() - started > budgetMs) { res(ok); return; }
      setTimeout(tick, 120);
    };
    setTimeout(tick, 120);
  });
}

if (!(await up())) { console.log('FAIL  the test server never answered'); process.exit(1); }
/* ========================================================================== */
/*  THE BD DAY                                                                */
/* ========================================================================== */
console.log('\n— BD — one working day, start to finish —');

const bd = await open('ahmad.faiz@global.tencent.com');
check('BD signs in', !bd.$('#lgE') || /Today|Customer/.test(bd.text()), bd.text().slice(0, 60));

/* 1. Add the customer they just met. */
await bd.click(bd.$('[data-go="customers"]'), 700);
check('BD can find where to add a customer', !!bd.$('[data-act="newcust"]'));
await bd.click(bd.$('[data-act="newcust"]'), 600);
await bd.set(bd.$('#ncQ'), 'Berjaya Retail');
await bd.click(bd.$('#ncSkip'), 300);             /* confidential path: no lookup */
let c = await lands(() => (disk().customers || []).find(x => /Berjaya/.test(x.name || '')));
check('the customer is created', !!c, (disk().customers || []).length + ' customers');
check('BD can see the customer they just created', /Berjaya/.test(bd.text()), 'on the screen');
check('the customer belongs to the person who created it', !!c && c.owner === 'Ahmad Faiz', c ? c.owner : '');

await bd.click(bd.$('[data-go="customers"]'), 800);
const card = bd.$$('#page [data-open]').find(x => /Berjaya/.test(x.textContent || ''));
check('BD can find it again in the customer list', !!card,
  bd.$$('#page [data-open]').length + ' cards on screen');
if (card) await bd.click(card, 900);
check('opening it shows the customer', /Berjaya/.test(bd.text()));

/* 2. Add a stakeholder. */
await bd.click(bd.byText('#page [data-tab]', 'People'), 700);
check('the People tab offers a way to add a person', !!bd.$('[data-act="addtoggle"][data-add="people"]'));
await bd.click(bd.$('[data-act="addtoggle"][data-add="people"]'), 500);
check('the form asks for a name, a title and a classification',
  !!bd.$('#ad1') && !!bd.$('#ad2') && !!bd.$('#ad3'));
await bd.set(bd.$('#ad1'), 'Mei Ling Tan');
await bd.set(bd.$('#ad2'), 'Head of Retail Technology');
await bd.click(bd.$('[data-act="addsave"]'), 300);
let p1 = await lands(() =>
  (disk().customers || []).find(x => c && x.id === c.id)?.contacts.find(x => x.n === 'Mei Ling Tan'));
check('the person is saved', !!p1, p1 ? p1.n + ' · ' + p1.t : 'not on disk');
check('and is on screen straight away', /Mei Ling Tan/.test(bd.text()));

/* 3. Log the meeting. */
await bd.click(bd.$('[data-go="interactions"]'), 800);
check('the Interactions screen offers a way to log one',
  !!bd.$('[data-act="addtoggle"][data-add="interactions"]'));
if (bd.$('[data-act="addtoggle"][data-add="interactions"]')) {
  await bd.click(bd.$('[data-act="addtoggle"][data-add="interactions"]'), 500);
  const sel = bd.$('#ad0');
  check('the form asks which customer it was with', !!sel, sel ? sel.options.length + ' customers' : '');
  await bd.set(sel, 'Berjaya Retail');
  await bd.set(bd.$('#ad1'), 'First call — retail platform refresh');
  await bd.set(bd.$('#ad2'), 'Mei Ling Tan');
  await bd.set(bd.$('#ad3'), 'They want a proposal in October.');
  await bd.click(bd.$('[data-act="addsave"]'), 300);
  const m1 = await lands(() => (disk().interactions || []).find(x => /retail platform refresh/i.test(x.t || '')));
  check('the meeting is saved', !!m1, m1 ? m1.t : 'not on disk');
  check('it is attached to the right customer', !!m1 && m1.c === c.id, m1 ? m1.c : '');
  check('it appears on the Interactions screen', /retail platform refresh/i.test(bd.text()));
}

/* 4. The meeting must show up on the customer's own timeline — one fact, two
      places, written once. */
await bd.click(bd.$('[data-go="customers"]'), 700);
await bd.click(bd.$$('#page [data-open]').find(x => /Berjaya/.test(x.textContent || '')), 900);
await bd.click(bd.byText('#page [data-tab]', 'Timeline'), 700);
check('the meeting is on the customer timeline too', /retail platform refresh/i.test(bd.text()),
  'one fact, two views');

/* 5. Pain points. */
await bd.click(bd.byText('#page [data-tab]', 'Brief'), 700);
check('the Brief offers a way to record what hurts', !!bd.$('[data-act="edpains"]'));
await bd.click(bd.$('[data-act="edpains"]'), 500);
await bd.set(bd.$('#ed1'), 'Nightly batch misses the 6am store opening\nNo single view of stock across channels');
await bd.click(bd.$('[data-act="edsave"]'), 300);
const cAfterPains = await lands(() => {
  const cc = (disk().customers || []).find(x => c && x.id === c.id);
  return (cc?.pains || []).length === 2 ? cc : undefined;
});
check('the pain points are saved', ((cAfterPains?.pains || []).length === 2),
  (cAfterPains?.pains || []).length + ' recorded');
check('and are on screen', /Nightly batch/.test(bd.text()));

/* 6. An opportunity. */
await bd.click(bd.byText('#page [data-tab]', 'Opportunities'), 700);
check('the Opportunities tab offers a way to add one',
  !!bd.$('[data-act="addtoggle"][data-add="opportunities"]'));
await bd.click(bd.$('[data-act="addtoggle"][data-add="opportunities"]'), 500);
await bd.set(bd.$('#ad1'), 'Warehouse robotics rollout');
await bd.set(bd.$('#ad2'), '900000');
await bd.click(bd.$('[data-act="addsave"]'), 300);
/* A name the demo seed does not carry: `find` must land on the row this
   test just wrote, not on the seed's own 'Retail data platform
   modernisation' deal, whose substring used to shadow it. */
const opp = await lands(() => Object.values(disk().opps || {}).find(o => /Warehouse robotics rollout/.test(o.t || '')));
check('the opportunity is saved', !!opp, opp ? opp.t + ' · ' + opp.v : 'not on disk');
check('it belongs to the customer', !!opp && opp.c === c.id);
check('and is on screen', /Warehouse robotics rollout/.test(bd.text()));

/* 7. A follow-up action, promised in the meeting. */
await bd.click(bd.$('[data-go="today"]'), 800);
check('Today offers a way to capture what was promised', !!bd.$('[data-act="capture"]'));
await bd.click(bd.$('[data-act="capture"]'), 600);
check('Capture asks for the sentence and which customer', !!bd.$('#capT') && !!bd.$('#capC'));
await bd.set(bd.$('#capC'), c.id);
await bd.set(bd.$('#capT'), 'Send the retail platform proposal to Mei Ling by 2026-10-15');
await bd.click(bd.$('#capParse'), 900);
check('it reads proposals out of the sentence', /proposal/i.test(bd.veilText()),
  bd.veilText().slice(0, 70).replace(/\s+/g, ' '));
const saveBtn = bd.byText('#capBody button', 'Save');
check('there is a way to save what it read', !!saveBtn);
if (saveBtn) {
  await bd.click(saveBtn, 300);
  const step = await lands(() => (disk().steps || []).find(s => /proposal/i.test(s.t || '')));
  check('the follow-up action is saved', !!step, step ? step.t : 'not on disk');
  check('it is on the customer it was promised to', !!step && step.c === c.id, step ? step.c : '');
}

/* 8. Leave, come back, refresh — the three ways a record gets lost. */
await bd.click(bd.$('[data-go="opportunities"]'), 800);
check('the opportunity shows on the Opportunities screen', /Warehouse robotics rollout/.test(bd.text()));
await bd.click(bd.$('[data-go="people"]'), 800);
check('the person shows on the People screen', /Mei Ling Tan/.test(bd.text()));

await bd.reload();
check('after a refresh the person is still there', /Mei Ling Tan/.test(bd.text()));
await bd.click(bd.$('[data-go="customers"]'), 900);
check('after a refresh the customer is still there', /Berjaya/.test(bd.text()),
  'this is where a bad scope rule loses it');

/* 9. Edit something, later. */
await bd.click(bd.$$('#page [data-open]').find(x => /Berjaya/.test(x.textContent || '')), 900);
await bd.click(bd.$('[data-act="edcust"]'), 600);
check('the customer record opens for editing', !!bd.$('#ed1') && !!bd.$('#ed4'),
  'name and website are both editable');
await bd.set(bd.$('#ed2'), 'Retail');
await bd.set(bd.$('#ed4'), 'berjaya.example');
await bd.click(bd.$('[data-act="edsave"]'), 1400);
const cEdited = (disk().customers || []).find(x => x.id === c.id);
check('the industry change is saved', cEdited.industry === 'Retail', cEdited.industry);
check('the website change is saved', cEdited.site === 'berjaya.example', cEdited.site);
check('the edit is on the audit trail',
  (disk().audit || []).some(a => /Customer updated/.test(a.what || '')),
  ((disk().audit || [])[0] || {}).what || '');

/* 10. The opportunity moves on, and the customer view has to know. */
await bd.click(bd.byText('#page [data-tab]', 'Opportunities'), 800);
const oppEdit = bd.$('[data-act="ed"]');
check('an opportunity can be edited', !!oppEdit);
if (oppEdit) {
  await bd.click(oppEdit, 600);
  /* 'Evaluating' was never a stage this workspace has. The stage picker is
     built from the workspace's own configured list — Interested, Qualified,
     Proposal, Negotiation, Won, Lost — and the product correctly refuses a
     value outside it. The assertion was checking that a stage the product does
     not offer got saved, which is not a capability worth having. Moving the
     deal one real step forward is. */
  await bd.set(bd.$('#ed3'), 'Proposal');
  await bd.set(bd.$('#ed2'), '1200000');
  await bd.click(bd.$('[data-act="edsave"]'), 1400);
  const o2 = Object.values(disk().opps || {})[0];
  check('the new value is saved', !!o2 && Number(o2.v) === 1200000, o2 ? String(o2.v) : '');
  check('the new stage is saved', !!o2 && o2.stage === 'Proposal', o2 ? o2.stage : '');
}

/* 11. Hand the customer to a colleague. */
await bd.click(bd.byText('#page [data-tab]', 'Brief'), 800);
const addTeam = bd.$('[data-act="teamadd"]');
check('the owner can put somebody else on the customer', !!addTeam);
if (addTeam) {
  const opts = [...((bd.$('#teamAdd' + c.id) || {}).options || [])].map(o => o.value);
  check('the colleague list offers the real roster', opts.includes('John Teh'), JSON.stringify(opts));
  await bd.set(bd.$('#teamAdd' + c.id), 'John Teh');
  await bd.click(addTeam, 300);
  /* A fixed wait can only be wrong twice — too short and it fails a working
     product under load (the 700 ms debounce sits between the click and the
     disk, and a save queued behind an in-flight one adds the rest), too long
     and it slows every run down. Every other step here polls for the fact;
     this one used to sleep 1300 ms and flake 1-in-8 under exactly the queue
     it now waits out. */
  const cTeam = await lands(() => {
    const cc = (disk().customers || []).find(x => x.id === c.id);
    return cc && (cc.team || []).includes('John Teh') ? cc : undefined;
  });
  check('the colleague is on the customer', !!cTeam,
    cTeam ? JSON.stringify(cTeam.team) : 'not on disk');
}

/* 11b. The same record, the other half: a BD reads what they run but does
        not get to change it. */
await bd.click(bd.byText('#page [data-tab]', 'What they run'), 700);
check('BD does not get to add a system', !bd.$('[data-act="addtoggle"][data-add="run"]'),
  'BD owns money, SA owns machines');

/* 12. Deletion is the administrator's act. A Remove drawn for a BD was a
      button that looked like it worked and was undone by the next reload —
      the server never accepted it — so it must not be drawn at all. */
await bd.click(bd.byText('#page [data-tab]', 'People'), 800);
check('a BD is offered no Remove — deletion belongs to the administrator',
  !bd.$('[data-act="rm"]'), 'the screen no longer promises what the server refuses');
check('a BD can still correct the person by editing', !!bd.$('#page button[data-ed]'));

/* ========================================================================== */
/*  SA — same customer, the other half of the record                         */
/* ========================================================================== */
console.log('\n— SA — the same account, the technical half —');

/* The SA signs in the way people actually do: type the password, press Enter.
   If the keystroke does not submit, the person is stuck on the login screen
   with a perfectly working button nobody clicks. */
const sa = await open('john.teh@global.tencent.com', 'enter');
check('SA signs in by pressing Enter', !sa.$('#lgE') || /Today|Customer/.test(sa.text()),
  sa.text().slice(0, 60));
await sa.click(sa.$('[data-go="customers"]'), 900);
check('the SA can see the customer they were put on', /Berjaya/.test(sa.text()),
  'put on by the owner in step 11');
const saCard = sa.$$('#page [data-open]').find(x => /Berjaya/.test(x.textContent || ''));
if (saCard) {
  await sa.click(saCard, 900);
  await sa.click(sa.byText('#page [data-tab]', 'What they run'), 800);
  check('SA can add a system', !!sa.$('[data-act="addtoggle"][data-add="run"]'));
  if (sa.$('[data-act="addtoggle"][data-add="run"]')) {
    await sa.click(sa.$('[data-act="addtoggle"][data-add="run"]'), 500);
    await sa.set(sa.$('#ad1'), 'Stock ledger (Oracle)');
    await sa.set(sa.$('#ad2'), 'Oracle Exadata');
    await sa.click(sa.$('[data-act="addsave"]'), 1300);
    const cSys = (disk().customers || []).find(x => x.id === c.id);
    check('the system is saved', (cSys.apps || []).some(a => /Stock ledger/.test(a.n)),
      (cSys.apps || []).length + ' systems');
  }
  await sa.click(sa.byText('#page [data-tab]', 'Opportunities'), 800);
  check('SA does not get to change the money', !sa.$('[data-act="addtoggle"][data-add="opportunities"]'),
    'BD owns money, SA owns machines');
  check('SA sees the opportunity but is offered no Edit on it',
    /Warehouse robotics rollout/.test(sa.text()) && !sa.$('[data-act="ed"]'),
    'reads across, does not write across');
}

/* ========================================================================== */
/*  MANAGER — reads everything, changes nothing                              */
/* ========================================================================== */
console.log('\n— Manager — sight, no pen —');

const mgr = await open('siti.nurhaliza@global.tencent.com');
await mgr.click(mgr.$('[data-go="customers"]'), 900);
check('Manager can see the whole book', /Berjaya/.test(mgr.text()));
check('Manager is offered no way to create a customer', !mgr.$('[data-act="newcust"]'));
check('Manager is offered no capture', !mgr.$('[data-act="capture"]'));
check('Manager is offered no export', !mgr.$('[data-act="export"]'));
check('Manager is not shown the Admin screen', !mgr.$('[data-go="admin"]'));

const mgrCard = mgr.$$('#page [data-open]').find(x => /Berjaya/.test(x.textContent || ''));
if (mgrCard) {
  await mgr.click(mgrCard, 900);
  check('Manager is offered no way to edit the customer', !mgr.$('[data-act="edcust"]'));
  check('Manager is offered no way to add a person', !mgr.$('[data-act="addtoggle"]'));
  check('Manager is offered no way to change the team', !mgr.$('[data-act="teamadd"]'));
  check('Manager is offered no way to remove anything', !mgr.$('[data-act="rm"]'),
    'read-only means no Remove either');
}

/* Hiding the button is a preference. The server is the rule: a Manager who
   posts a change anyway must still be refused. */
{
  const st = disk();
  const before = JSON.stringify((st.customers || []).find(x => x.id === c.id));
  const body = JSON.stringify({
    baseRev: 0, mode: 'replace',
    state: { customers: (st.customers || []).map(x => x.id === c.id ? { ...x, industry: 'Hacked' } : x) }
  });
  const res = await mgr.api('/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
  const after = (disk().customers || []).find(x => x.id === c.id);
  check('the server refuses a Manager who writes anyway',
    res.status === 403 || after.industry !== 'Hacked',
    'status ' + res.status + ', industry ' + after.industry);
  if (before) { /* the comparison was the point */ }
}

/* ========================================================================== */
/*  ADMIN — the only one who exports                                          */
/* ========================================================================== */
console.log('\n— Admin — the doors nobody else gets —');

const ad = await open('tehbinshun@global.tencent.com');
/* The sign-in is asynchronous and this is the LAST of four sessions to open,
   against a server that three earlier people have just been writing to. A
   fixed `wait(1600)` inside `open()` is enough for the first of them and was
   occasionally not enough for this one, which is why this check used to fail
   and pass on alternate runs with no code change between them. So wait for
   the app to actually arrive — and see `waitForScreen`, which polls on a timer
   that is cleared, rather than on a loop that keeps a JSDOM window alive. */
await waitForScreen(ad, () => /Search customers, people|Today/.test(ad.text()), 6000);
await ad.click(ad.$('[data-go="admin"]'), 900);
check('Admin can see the Admin screen', /Admin/.test(ad.text()),
  ad.text().replace(/\s+/g, ' ').slice(0, 60));
/* Export is an Admin door and it has to be reachable, not merely present:
   an Admin who cannot find it in three clicks does not have it. */
await ad.click(ad.$('[data-atab="roles"]'), 700);
check('Admin is offered an export', !!ad.$('[data-act="export"]'),
  'Roles tab → Export CSV');
await ad.click(ad.$('[data-atab="people"]'), 600);
await ad.click(ad.$('[data-go="customers"]'), 800);
const adCard = ad.$$('#page [data-open]').find(x => /Berjaya/.test(x.textContent || ''));
if (adCard) {
  await ad.click(adCard, 900);
  check('Admin can edit any customer, not just their own', !!ad.$('[data-act="edcust"]'));
  check('Admin can change who is on the team', !!ad.$('[data-act="teamadd"]'));
}
await ad.click(ad.$('[data-go="admin"]'), 800);
check('every act of the day is on the audit trail',
  (disk().audit || []).some(a => /Customer updated/.test(a.what || '')) &&
  (disk().audit || []).some(a => /Person added|Meeting logged/.test(a.what || '')),
  (disk().audit || []).length + ' entries');

/* ========================================================================== */
/*  FIRST USE — an empty workspace must still show the way                    */
/* ========================================================================== */
console.log('\n— First use — nothing in the book —');
{
  const { writeFileSync } = await import('node:fs');
  const empty = mkdtempSync(join(tmpdir(), 'wp-empty-'));
  const st = disk();
  writeFileSync(join(empty, 'workbench.json'), JSON.stringify({
    schemaVersion: 1, setupComplete: true, users: st.users, credentials: st.credentials,
    customers: [], opps: {}, interactions: [], steps: [], watch: [], audit: [], team: st.team || []
  }));
  const p2 = 8852;
  const s2 = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
  env: { ...process.env, WB_DATA_DIR: empty, PORT: String(p2), HOST: '127.0.0.1', WB_TLS: '0',
           WB_ORIGINS: 'http://127.0.0.1:' + p2 },
  stdio: ['ignore', 'pipe', 'pipe'],
});
/* Ports are proven free BEFORE either spawn, and the second one is `p2`, not
     the first server's port — claiming PORT twice is what made this suite fail
     its own guard. Checking both up front means a busy machine is reported
     once, clearly, instead of after half the run has already happened. */
  await claimPort(p2);
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch('http://127.0.0.1:' + p2 + '/api/health')).ok) break; } catch { /* not yet */ }
    await wait(150);
  }
  const jar = { v: '' };
  const api2 = async (path, opts = {}) => {
    const res = await fetch('http://127.0.0.1:' + p2 + path, {
      ...opts, redirect: 'manual',
      headers: { ...(opts.headers || {}), Origin: 'http://127.0.0.1:' + p2, ...(jar.v ? { cookie: jar.v } : {}) }
    });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (sc.length) jar.v = sc.map(s => s.split(';')[0]).join('; ');
    return res;
  };
  const vc3 = new VirtualConsole();
  const dom2 = new JSDOM(SOURCE, {
    url: 'http://127.0.0.1:' + p2 + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc3
  });
  const w = dom2.window;
  w.scrollTo = () => {};
  w.fetch = (u, o) => api2(String(u).replace('http://127.0.0.1:' + p2, ''), o);
  await wait(1100);
  const d2 = w.document;
  const el = d2.getElementById('lgE');
  if (el) {
    el.value = 'tehbinshun@global.tencent.com';
    d2.getElementById('lgP').value = PASSWORD;
    d2.querySelector('[data-act="signin"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(1600);
  }
  const page = (d2.getElementById('page') || d2.body).textContent;
  check('an empty workspace still renders', page.length > 20 && !/undefined|NaN/.test(page),
    page.slice(0, 70).replace(/\s+/g, ' '));
  check('and still offers the way to add the first customer',
    !!d2.querySelector('[data-act="newcust"]'), 'no dead end on first use');
  s2.kill();
}

/* ------------------------------------------------------------------ done */

srv.kill();
console.log('\n' + pass + ' passed, ' + fail + ' failed  (' + (pass + fail) + ' checks)');
if (pageErrors.length) console.log('page errors: ' + pageErrors.slice(0, 3).join(' | '));
if (fails.length) console.log('\nthe day breaks at:\n  - ' + fails.join('\n  - '));
console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(fail ? 1 : 0);
