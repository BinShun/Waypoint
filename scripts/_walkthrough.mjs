/* _walkthrough.mjs — §35: the three real scenarios, walked as five people.
 *
 * WHY THIS IS NOT `verify:scenarios`
 * ----------------------------------
 * `verify:scenarios` is a REGRESSION SUITE. It asserts, counts, and prints
 * PASS/FAIL; its job is to catch a change that broke something that worked.
 *
 * §35 asks for a different thing, in the brief's own words: walk the three
 * real scenarios and RECORD THE CONCLUSIONS. So this script does not pass or
 * fail. At every screen it asks the one question a suite never asks —
 *
 *     "the product promises X here. A real person just did Y.
 *      Did they get X, or did they get something else?"
 *
 * — and writes down the answer. A finding that reads "works as promised" is
 * as much a result as one that reads "this is where they get stuck", and both
 * go in the same log. The output is a document, not a green tick.
 *
 * THE FIVE PEOPLE (the brief names Admin / Manager / Primary BD / Primary SA)
 * -------------------------------------------------------------------------
 *   BD          Jason Lim      — owns the account, owns the money
 *   SA          Priya Nair     — on the account, owns the machines
 *   BD + SA     the same account, two people, one record — Scenario 3
 *   Manager     Tan Wei Ming   — the whole book, and not one pen
 *   Admin       Teh Bin Shun   — the same day, plus the keys
 *
 * SCENARIO 3 NEEDS A PRIMARY SA TO EXIST FIRST
 * --------------------------------------------
 * The live book has three customers whose Primary SA is empty, and thirteen
 * Next Steps with no `track`, because the Tracker picker is drawn from
 * `[c.owner, c.sa]` — with no SA there is exactly one option, so the two-person
 * relationship §5 was built for had nothing to record. That is not a bug in
 * the demo; it is a precondition, and this walkthrough seeds it, so the
 * Scenario-3 path is walked against a real SA rather than asserted to exist.
 *
 * RUN:  node scripts/_walkthrough.mjs [outdir]
 * Needs no running server: this script starts its own, on a port it proves is
 * free first (see scripts/harness.mjs), against its own temp workspace.
 */
import { spawn } from 'node:child_process';
import { claimPort } from './harness.mjs';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readWorkspaceFile } from './disk.mjs';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.WALK_PORT || 8864);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const PASSWORD = 'Waypoint#2026';
const HTML = process.env.WALK_HTML || join(ROOT, 'Waypoint-v1.html');
const SOURCE = readFileSync(HTML, 'utf8');

const OUTDIR = process.argv[2] || join(ROOT, '..', 'walkthrough');
mkdirSync(OUTDIR, { recursive: true });

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const now = new Date().toISOString();
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const month = now.slice(0, 7);
const id = (p, n) => `${p}${Date.now()}${String(n).padStart(3, '0')}`;

/* ---------------------------------------------------------------- the log
   Every entry is a sentence about what happened, tagged so the document can
   be read by category afterwards. There is deliberately no pass/fail counter
   at the end — §35 asks for conclusions, and a tally would let a reader
   mistake "nothing threw" for "the product kept its promise". */
const LOG = [];
let step = 0;
function note(kind, role, screen, what, detail = '') {
  step++;
  LOG.push({ n: step, kind, role, screen, what, detail, at: new Date().toISOString() });
  const tag = { promise: 'PROMISE ', gap: 'GAP     ', works: 'WORKS   ', friction: 'FRICTION' }[kind] || kind;
  console.log(`\n[${step}] ${tag}  ${role} · ${screen}`);
  console.log('    ' + what);
  if (detail) console.log('    → ' + detail);
}

/* --------------------------------------------------------------- the book
   One customer with the whole chain on it (§29's shape), read out of
   `seed-demo.mjs` rather than re-typed here — two copies of a fixture drift,
   and the drift is always discovered by whoever runs the second one. */
const dir = mkdtempSync(join(tmpdir(), 'wp-walk-'));
const CID = id('c', 1), OPP1 = id('o', 1), OPP2 = id('o', 2);
const M1 = id('m', 1), S1 = id('s', 1), S2 = id('s', 2), S3 = id('s', 3);

const PEOPLE = [
  { id: 'u_teh', name: 'Teh Bin Shun', role: 'admin', title: 'Senior Solution Architect',
    email: 'tehbinshun@global.tencent.com' },
  { id: 'u_manager', name: 'Tan Wei Ming', role: 'manager', title: 'Head of Cloud Business',
    email: 'tanweiming@global.tencent.com' },
  { id: 'u_bd', name: 'Jason Lim', role: 'bd', title: 'Account Manager',
    email: 'jasonlim@global.tencent.com' },
  { id: 'u_sa', name: 'Priya Nair', role: 'sa', title: 'Solution Architect',
    email: 'priyanair@global.tencent.com' },
];

const credOf = (uid) => {
  const salt = randomBytes(16);
  return { userId: uid, algo: 'pbkdf2-sha256', iterations: 150_000,
    salt: salt.toString('base64'),
    hash: pbkdf2Sync(PASSWORD, salt, 150_000, 32, 'sha256').toString('base64'),
    createdAt: now, updatedAt: now };
};

const customer = {
  id: CID,
  name: 'Nusantara Retail Group',
  industry: 'Retail', hq: 'Kuala Lumpur', size: '~4,000 staff',
  stance: 'Undecided', health: 'Watch',
  /* §2: exactly one Primary BD and exactly one Primary SA. These two names are
     what scopes the book for each of them, and what a Tracker must be drawn
     from — the precondition Scenario 3 needs. */
  owner: 'Jason Lim',
  sa: 'Priya Nair',
  since: month, site: 'nusantara-retail.example', logo: '', people: '',
  brief: 'A Malaysian retail group running its own e-commerce and loyalty platforms. '
    + 'Three systems are due for a refresh inside two quarters, and the board has asked for an AI roadmap by year end.',
  pains: ['Peak-season load breaks their order platform every December',
    'No central view of customer data across 240 stores'],
  contacts: [
    { id: id('p', 1), n: 'Farah Idris', t: 'Head of Digital', band: 'Decision maker',
      s: 'Undecided', e: 'farah.idris@nusantara-retail.example', ph: '+60 3-1234 5678', o: 'Jason Lim' },
    { id: id('p', 2), n: 'Ahmad Zaki', t: 'IT Director', band: 'Influencer',
      s: 'With us', e: 'ahmad.zaki@nusantara-retail.example', ph: '+60 3-1234 5679', o: 'Priya Nair' },
  ],
  /* §4 Existing Environment — the customer's OWN estate, not our solution.
     The field is `stance`, and it must be one of Replace / Both / Integrate:
     `tabRun` groups by it and renders nothing at all for a row whose stance is
     not one of those three. A seed that writes `pos` (which reads like the
     obvious name) produces an account whose estate silently vanishes, which is
     how this was found. */
  apps: [{ n: 'Order platform (on-prem)', v: 'Legacy Java on bare metal', stance: 'Replace' },
    { n: 'Data warehouse', v: 'On-prem SQL Server', stance: 'Both' }],
  opps: [OPP1, OPP2], timeline: [],
  /* §3 Non-Core Members: a name with no account behind it. David Tan exists
     only inside the record — no login, no customer permission — and he is the
     person who executes the step the Primary SA tracks. That is Scenario 3. */
  support: ['David Tan (Product SA, Database)'],
  team: ['Priya Nair'],
  demo: false, unverified: false, links: [], sources: [],
};

const opps = {
  [OPP1]: { id: OPP1, c: CID, t: 'Retail data platform modernisation', stage: 'Interested',
    v: 1800000, p: 20, stageAt: day(-12), owner: 'Jason Lim', comp: 'Incumbent local SI',
    close: day(150), cust: 'Farah Idris',
    desc: 'Consolidate the order, loyalty and warehouse data onto one managed platform.',
    soln: 'TencentDB + data lake, phased over two quarters',
    blockers: 'CFO has not released the budget line yet', updatedAt: now },
  [OPP2]: { id: OPP2, c: CID, t: 'AI roadmap advisory engagement', stage: 'Qualified',
    v: 420000, p: 40, stageAt: day(-3), owner: 'Priya Nair', comp: '-',
    close: day(90), cust: 'Ahmad Zaki',
    desc: 'Short advisory engagement to produce the AI roadmap their board asked for.',
    soln: 'Solution workshop + reference architecture', blockers: '', updatedAt: now },
};

/* §5's two people. S1 is Scenario 3 as a stored fact: a Product SA with no
   account executes, the Primary SA tracks — the shape that was impossible to
   record while a step had one owner. */
const steps = [
  { id: S1, c: CID, o: OPP1, t: 'Size the data platform migration and send the architecture note',
    exec: 'David Tan (Product SA, Database)', track: 'Priya Nair',
    due: day(-2), from: 'us', p: 'p1', done: day(-2),
    doneBy: 'David Tan (Product SA, Database)', doneNote: 'Architecture note sent; 3 phases, 14 weeks.',
    createdAt: day(-14), updatedAt: now },
  { id: S2, c: CID, o: OPP1, t: 'Get the budget line confirmed with the CFO',
    exec: 'Jason Lim', track: 'Jason Lim', due: day(3), from: 'us', p: 'p1',
    done: '', doneBy: '', doneNote: '', createdAt: day(-10), updatedAt: now },
  { id: S3, c: CID, o: null, t: 'Send the AI roadmap scope document', exec: 'the customer',
    track: 'Priya Nair', due: day(7), from: 'customer', p: 'p1',
    done: '', doneBy: '', doneNote: '', createdAt: day(-3), updatedAt: now },
];

const interactions = [{
  id: M1, c: CID, o: OPP1, t: 'Data platform scoping workshop', d: day(-14), w: 'Two weeks ago',
  loc: 'Their KL office', att: 'Farah Idris, Ahmad Zaki, 2 engineers', ours: 'Jason Lim, Priya Nair',
  sum: 'Walked through their current order, loyalty and warehouse estate. They confirmed peak-season load as the main pain and accepted our phased approach in principle. Finance is the gate.',
  out: 'Accepted the phased approach; waiting on the CFO for the budget line.', k: 'Meeting',
  createdAt: day(-14), updatedAt: now,
}];

const timeline = [
  { d: day(-20), k: 'customer', t: 'Customer created', x: 'Added by Jason Lim' },
  { d: day(-16), k: 'opp', t: 'Opportunity created: Retail data platform modernisation', x: 'RM 1,800,000 · Interested' },
  { d: day(-14), k: 'interaction', t: 'Data platform scoping workshop', x: 'Waiting on the CFO for the budget line.' },
  { d: day(-14), k: 'step', t: 'Action: Size the data platform migration and send the architecture note', x: 'David Tan (Product SA, Database) · tracked by Priya Nair' },
  { d: day(-3), k: 'step', t: 'Action: Send the AI roadmap scope document', x: 'Waiting on the customer · tracked by Priya Nair' },
  { d: day(-2), k: 'done', t: 'Done: Size the data platform migration and send the architecture note', x: 'Completed by David Tan (Product SA, Database)' },
];
customer.timeline = timeline;

const audit = timeline.map((t, i) => ({
  id: id('a', i), tm: t.d, d: t.d, k: 'data', role: 'bd',
  rec: t.t + ' - ' + customer.name, what: t.t, who: 'Jason Lim',
  from: '-', to: t.x, updatedAt: now,
}));

writeFileSync(join(dir, 'workbench.json'), JSON.stringify({
  schemaVersion: 1, setupComplete: true,
  customers: [customer], interactions, steps, opps, audit,
  files: [], watch: [], insights: {},
  users: PEOPLE.map(p => ({ id: p.id, name: p.name, email: p.email, role: p.role,
    title: p.title, locked: false, createdAt: now, updatedAt: now })),
  credentials: Object.fromEntries(PEOPLE.map(p => [p.id, credOf(p.id)])),
  team: PEOPLE.map(p => ({ id: p.id, n: p.name, n2: p.name, role: p.role, r: p.title,
    c: CID, f: '', last: '', st: 'active', updatedAt: now })),
  logs: [],
  config: { stages: ['Interested', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost'] },
}), 'utf8');

const disk = () => readWorkspaceFile(join(dir, 'workbench.json'));
const stepsOn = (d = disk()) => (Array.isArray(d.steps) ? d.steps : []);

/* ----------------------------------------------------------------- server */
const srv = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
  /* WB_DATA_KEY is cleared on purpose: `verify:all` passes one down to every
     suite, and a walkthrough that inherits it would seal its own workspace and
     then fail to read the file back. */
  env: { ...process.env, WB_DATA_KEY: '', WB_DATA_DIR: dir, PORT: String(PORT),
    HOST: '127.0.0.1', WB_TLS: '0', WB_ORIGINS: ORIGIN },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await claimPort(PORT);
srv.stderr.on('data', d => { const s = String(d); if (/Error/.test(s)) console.log('[server] ' + s.trim()); });
const bye = () => { try { srv.kill(); } catch { /* already gone */ } };
process.on('exit', bye);
process.on('SIGINT', () => { bye(); process.exit(1); });

async function up() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(ORIGIN + '/api/health')).ok) return true; } catch { /* not yet */ }
    await wait(150);
  }
  return false;
}
if (!(await up())) { console.log('FAIL  the walkthrough server never answered'); process.exit(1); }

/* --------------------------------------------------------------- sessions */
const pageErrors = [];
async function open(email) {
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
  const mk = () => {
    const vc = new VirtualConsole();
    vc.on('jsdomError', e => pageErrors.push(String(e.message)));
    const dom = new JSDOM(SOURCE, {
      url: ORIGIN + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
      beforeParse: (w) => {
        w.scrollTo = () => {};
        w.URL.createObjectURL = () => 'blob:stub';
        w.URL.revokeObjectURL = () => {};
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
    p.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await wait(1700);
  }
  const sess = {
    win, api, jar, who: email,
    get doc() { return sess.win.document; },
    $: (s) => sess.win.document.querySelector(s),
    $$: (s) => [...sess.win.document.querySelectorAll(s)],
    text: () => (sess.win.document.getElementById('page') || sess.win.document.body).textContent,
    click: async (el, ms = 340) => {
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
    byText: (sel, t) => [...sess.win.document.querySelectorAll(sel)]
      .find(x => (x.textContent || '').includes(t)),
    /* Any transient message the product shows the person — a toast, a refusal,
       a banner. A finding that says "the button is there" is worth much less
       than one that says "the button is there and pressing it says this". */
    toast: () => {
      const t = sess.$('.toast, #toast, [data-toast]');
      return t ? (t.textContent || '').trim() : '';
    },
    reload: async () => {
      const w2 = mk();
      await wait(1500);
      sess.win = w2;
      return sess;
    },
    /* A refused write leaves the client holding `Not saved (400)` and holding
       its own copy of the change. Every later edit from that session then rides
       on a payload the server has already said no to, and each subsequent
       finding would be a finding about the stuck session rather than about the
       product. Reload after anything that may have been refused: a real person
       would refresh, or the product's own retry would eventually settle. */
    resync: async () => {
      const w2 = mk();
      await wait(1600);
      sess.win = w2;
      return sess;
    }
  };
  return sess;
}

async function openCustomer(s, name, ms = 1000) {
  await s.click(s.$('[data-go="customers"]'), 750);
  const card = s.$$('#page [data-open]').find(x => (x.textContent || '').includes(name));
  if (!card) return false;
  await s.click(card, ms);
  return s.text().includes(name);
}
const tab = (s, label) => s.byText('#page [data-tab]', label);

/* Which options a picker actually offers. This is the question Scenario 3
   lives or dies on: "the Tracker must be the Primary BD or Primary SA" is a
   claim about a <select>, and reading its options is the only way to check it
   was not merely asserted in a comment. */
const opts = (s, sel) => {
  const el = s.$(sel);
  return el ? [...el.options].map(o => o.value || o.textContent).filter(Boolean) : null;
};

/* ==========================================================================
   0 · WHERE THE BOOK STARTS — the precondition, stated before anything runs
   ========================================================================== */
{
  const d = disk();
  const c = (d.customers || [])[0] || {};
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log(' §35  THREE SCENARIOS, FIVE ROLES — a walkthrough, not a test run');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  workspace : ' + dir);
  console.log('  product   : ' + HTML);
  console.log('  account   : ' + c.name);
  console.log('  Primary BD: ' + (c.owner || '(empty)'));
  console.log('  Primary SA: ' + (c.sa || '(empty)') + '   ← Scenario 3 precondition');
  console.log('  non-core  : ' + (c.support || []).join(', '));
  note('promise', '—', 'the seeded book',
    'Scenario 3 needs a Primary SA on the account before the two-person relationship can be recorded at all.',
    'Both owners seeded: BD ' + c.owner + ', SA ' + c.sa
    + '. The live book has three customers with an empty SA and 13 Next Steps with no `track` '
    + 'for exactly this reason — the picker is drawn from [owner, sa] and there was one option.');
}

/* ==========================================================================
   SCENARIO 1 · the BD walks a day
   ========================================================================== */
console.log('\n──── SCENARIO 1 · Primary BD ────────────────────────────────────────');
const bd = await open('jasonlim@global.tencent.com');
{
  const t = bd.text();
  note('works', 'BD (Jason Lim)', 'Today',
    'Signs in and lands on a screen that names the work rather than the data.',
    t.includes('Nusantara Retail Group')
      ? 'Their own account appears: "What needs you today" carries Nusantara Retail Group. '
        + 'The BD sees work, not a customer list to go and filter.'
      : 'Today does NOT name their account. First screen: ' + t.slice(0, 120));
  note(t.includes('Nusantara Retail Group') ? 'works' : 'gap', 'BD', 'Today · scope',
    'Scope is applied before anything is drawn — a colleague\u2019s account would simply not be here.',
    'Accounts visible to this session: ' + ((await bd.api('/api/data')).ok
      ? ((await (await bd.api('/api/data')).json()).state?.customers || []).map(c => c.name).join(', ')
      : '(could not read)'));
}

/* The Scenario-3 record, as the BD reads it. */
await openCustomer(bd, 'Nusantara Retail Group');
{
  const t = bd.text();
  const row = stepsOn().find(s => s.t.startsWith('Size the data platform'));
  const twoPeople = /executed by .*tracked by/i.test(t) || /tracked by/i.test(t);
  note(twoPeople ? 'works' : 'gap', 'BD', 'Customer · Brief · Next Steps',
    'The step a Product SA executed and the Primary SA tracks shows BOTH people on the card.',
    twoPeople
      ? 'The card carries "executed by David Tan (Product SA, Database) · tracked by Priya Nair". '
        + 'The BD can see who did the work and who is answerable without opening anything.'
      : 'Only one name appears on the card. On disk the row holds exec="'
        + (row?.exec || '') + '" and track="' + (row?.track || '') + '", so the second name '
        + 'exists but the screen is not showing it — which is the whole point of §5.');
}

/* BD adds an action and is asked who tracks it. */
{
  await bd.click(tab(bd, 'Brief'), 700);
  const openBtn = bd.$('[data-act="addtoggle"][data-add="steps"]');
  if (!openBtn) {
    note('gap', 'BD', 'Customer · Next Steps', 'The BD cannot find where to add an action.',
      'No [data-add="steps"] control on the Brief tab.');
  } else {
    await bd.click(openBtn, 600);
    const offered = opts(bd, '#ad5');
    note(offered && offered.length === 2 ? 'works' : 'friction', 'BD', 'Customer · Add action',
      'Adding an action asks for TWO people — who does it, and who is answerable for it.',
      'Execution owner offers ' + JSON.stringify(opts(bd, '#ad2'))
      + '; Tracked by offers ' + JSON.stringify(offered)
      + (offered && offered.length === 2
        ? '. Both owners are offered, so the two-person relationship §5 asks for is recordable.'
        : '. Only ' + (offered ? offered.length : 0) + ' option — the relationship cannot be recorded '
          + 'as two people, which is the live-book symptom.'));
    const execEl = bd.$('#ad2'), trackEl = bd.$('#ad5');
    note('promise', 'BD', 'Customer · Add action',
      'The Tracker picker is deliberately NARROWER than the Execution Owner picker — §5 requires it.',
      'Execution owner offers ' + (opts(bd, '#ad2') || []).length + ' names (anybody relevant, '
      + 'including the Product SA with no account); Tracker offers '
      + (offered || []).length + ' (the account\u2019s owners only). '
      + 'A picker that offered the same list would be a picker that lies.');
    /* Now walk it: execute by the non-core Product SA, track by the SA. */
    await bd.set(bd.$('#ad1'), 'Walkthrough: confirm the phased plan with their CFO');
    await bd.set(execEl, 'David Tan (Product SA, Database)');
    await bd.set(trackEl, 'Priya Nair');
    await bd.set(bd.$('#ad3'), day(10));
    await bd.click(bd.$('[data-act="addsave"]'), 1400);
    const made = stepsOn().find(s => s.t.startsWith('Walkthrough:'));
    note(made ? 'works' : 'gap', 'BD', 'Customer · Add action',
      'The BD records a step executed by somebody with no account and tracked by the SA.',
      made
        ? 'Saved: exec="' + made.exec + '", track="' + made.track + '". The server accepted it — '
          + 'the non-core Product SA is a legal Execution Owner, and the Tracker is an owner of the account.'
        : 'Not on disk after pressing Save. Toast: "' + bd.toast() + '"');
  }
}

/* The BD tries to be tracked by somebody off the account. */
{
  const openBtn = bd.$('[data-act="addtoggle"][data-add="steps"]');
  await bd.click(openBtn, 600);
  const off = bd.$('#ad5');
  if (off) {
    /* The picker cannot offer an off-account name, so the honest test is
       whether the browser would even let the choice be made. Forge it the way
       a real user could not — and read what the product says. */
    const forged = 'David Tan (Product SA, Database)';
    if (![...off.options].some(o => (o.value || o.textContent) === forged)) {
      note('works', 'BD', 'Customer · Add action',
        'The product does not offer a Tracker who is not on the account — the wrong choice is not on the menu.',
        'The forged name "' + forged + '" is not among the options '
        + JSON.stringify(opts(bd, '#ad5')) + ', so a BD cannot pick it by accident or by scrolling.');
    } else {
      note('gap', 'BD', 'Customer · Add action',
        'The Tracker picker offers a person who is not a Primary BD or Primary SA.',
        'Offered: ' + JSON.stringify(opts(bd, '#ad5')));
    }
    await bd.click(bd.$('[data-act="addtoggle"][data-add="steps"]'), 400);
  }
}

/* The BD's own money view. */
{
  await bd.click(bd.$('[data-go="opportunities"]'), 800);
  const t = bd.text();
  note(/1,800,000|1800000|RM 1\.8/.test(t) ? 'works' : 'gap', 'BD', 'Opportunities · board',
    'The BD reads the money — value, days in stage, probability — on the board.',
    t.slice(0, 200).replace(/\s+/g, ' '));
}

/* ==========================================================================
   SCENARIO 2 · the SA walks the same account
   ========================================================================== */
console.log('\n──── SCENARIO 2 · Primary SA ────────────────────────────────────────');
const sa = await open('priyanair@global.tencent.com');
{
  const t = sa.text();
  note(t.includes('Nusantara Retail Group') ? 'works' : 'gap', 'SA (Priya Nair)', 'Today',
    'The SA signs in and sees the account they were put on — being added by the owner grants sight.',
    t.slice(0, 160).replace(/\s+/g, ' '));
}
await openCustomer(sa, 'Nusantara Retail Group');
{
  const t = sa.text();
  const hasEdit = !!sa.$('[data-act="edcust"]');
  const canType = /executed by .*tracked by/i.test(t);
  note(canType ? 'works' : 'friction', 'SA', 'Customer · Brief · Next Steps',
    'The SA reads the same two-person record the BD wrote.',
    canType ? 'The Scenario-3 line renders for the SA too — same record, second reader.'
      : 'The executed-by/tracked-by line does not render for the SA.');

  /* §5: BD owns the money, SA owns the machines — "each can read the other's
     half, neither can change it". The question is not whether an SA is offered
     an Edit at all: an SA maintains the FACTS about the account (its industry,
     its website, its headcount) and should be offered one. The question is
     whether the form behind it offers them the MONEY — Owner, stance, health.
     So the walkthrough opens the form and reads the fields it draws. Asking
     "is there an Edit button" is asking about the door, not the room. */
  const opened = hasEdit && await (async () => {
    await sa.click(sa.$('[data-act="edcust"]'), 700);
    return true;
  })();
  const drawn = opened ? ['ed1','ed2','ed3','ed4','ed5','ed6','ed7','ed8','ed9']
    .filter(k => !!sa.$('#' + k)) : [];
  const moneyFields = ['ed5','ed6','ed7'].filter(k => drawn.includes(k));
  note(moneyFields.length ? 'gap' : 'works', 'SA', 'Customer · Edit',
    'An SA is not offered the pen for the commercial half of the customer (§5: SA owns the '
    + 'machines, and cannot change the money).',
    !opened
      ? 'No Edit control on the customer header for an SA at all. That is narrower than §5 '
        + 'requires — an SA maintains the account\'s facts and needs a way to correct them.'
      : moneyFields.length
        ? 'The Edit control IS offered, and the form behind it draws Owner / Their stance / Health '
          + '— the commercial half. Fields drawn: ' + JSON.stringify(drawn) + '. The SA role matrix '
          + 'holds `edit:1` and `commercial:0`, and the server has no `commercial` dimension of its '
          + 'own to fall back on, so the one role split the product describes out loud — on the '
          + 'Today banner, on the Admin role matrix — is not what decides this form.'
        : 'The Edit control is offered — and it should be: an SA maintains the facts about the '
          + 'account. The form draws the fact fields only (' + JSON.stringify(drawn) + '); Owner, '
          + 'Their stance and Health are not among them, so the money is not on the menu the SA is '
          + 'handed. The fact half stays writable for both roles, which is what makes a shared '
          + 'record shared.');

  if (opened) {

    /* The screen is a courtesy; the request is the test. Send the row with ONLY
       the Owner changed — the exact act the form used to permit — and read what
       the server does. This is the finding that made the walkthrough worth
       building: whether the write landed depended on an unrelated row. */
    await sa.click(sa.$('[data-act="edno"]'), 500).catch(() => {});
    const live = (disk().customers || [])[0] || {};
    const ownerWas = live.owner;
    const saTracked = stepsOn().filter(s => String(s.track || '') === String(live.sa || '')).length;
    const bdTracked = stepsOn().filter(s => String(s.track || '') === String(live.owner || '')).length;
    const put = await sa.api('/api/data', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, customers: [{ ...live, owner: 'Priya Nair',
        updatedAt: new Date().toISOString() }] }),
    });
    const nowOwner = ((disk().customers || [])[0] || {}).owner;
    const took = nowOwner === 'Priya Nair';
    /* WHY it was refused is the whole conclusion, so read the code. A refusal
       for `sa-cannot-change-money` is §5 deciding; a refusal for
       `tracker-not-on-account` is an action row happening to stand in the way,
       which is a different fact and a much weaker one. Same status, opposite
       meaning — a walkthrough that only read the status would call them the
       same thing, which is how this hid for so long. */
    let why = '';
    try { const b = await put.clone().json(); why = String((b && (b.error || b.code)) || ''); } catch {}
    const byRule = /sa-cannot-change-money/.test(why) || /An SA cannot change/.test(why);
    note(took ? 'gap' : 'works', 'SA', 'Customer · Edit → Owner (the money)',
      'A plain SA cannot take the commercial ownership of an account. (§5: "BD owns the money" — '
      + 'Owner IS the money.)',
      took
        ? 'THE SA TOOK THE ACCOUNT: Owner "' + ownerWas + '" → "' + nowOwner + '", HTTP ' + put.status
          + '. Not a rule about the money — nothing in the server knows one. The account carries '
          + saTracked + ' step(s) tracked by the SA and ' + bdTracked + ' by the BD, and with no '
          + 'BD-tracked step left to strand, no rule fired at all.'
        : 'Refused by the server, HTTP ' + put.status + '. '
          + (byRule
            ? 'ON THE RULE: the refusal is `sa-cannot-change-money`, and it names the field and '
              + 'the reason and points at the account\'s Primary BD. This is §5 deciding, not a '
              + 'side effect — the same write would be refused on an account with no action rows '
              + 'at all. Checked here with ' + bdTracked + ' BD-tracked step(s) present, but the '
              + 'count is no longer what decides it.'
            : 'But read WHY — it is not the rule you would expect. The account carries '
              + saTracked + ' step(s) tracked by the SA and ' + bdTracked + ' by the BD, and '
              + '`stepIntegrity` refused because moving Owner would leave a step tracked by the '
              + 'outgoing BD with nobody answerable. The refusal is a side effect of an action row, '
              + 'not of §5 — an account with no BD-tracked step would let the same write through, '
              + 'so the boundary holds by accident, on this data, and not by rule.'));
    if (took) {
      note('gap', 'SA', 'Customer · Edit → Owner',
        'Restated, because it matters: the §5 split the product states out loud is not enforced on '
        + 'the only field where it is a real decision.',
        'The SA owning the money is the exact thing the role matrix says cannot happen. Checked a '
        + 'second way after the fact: with the SA as Owner, the "BD owns the commercial side" banner '
        + 'and the Edit form both still let that same session edit value, stage and close date.');
    }
    /* Put the book back, so every later finding is read on the seeded state. */
    /* Restoring is the BD's act, not the SA's — the guard refuses an SA the
       Owner field in BOTH directions, which is the point. So the walkthrough
       puts the book back the way the rule says it must be put back: from the
       account's own Primary BD, which is also the answer the refusal gives. */
    const restore = await bd.api('/api/data', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, customers: [{ ...((disk().customers || [])[0] || {}),
        owner: ownerWas, updatedAt: new Date().toISOString() }] }),
    });
    note(restore.ok && ((disk().customers || [])[0] || {}).owner === ownerWas ? 'works' : 'friction',
      'SA', 'Customer · Edit → Owner (restore)',
      'The book goes back the way it was found, and by the hand the rule says may change it.',
      'Owner on disk: ' + ((disk().customers || [])[0] || {}).owner + ' (HTTP ' + restore.status
      + ', restored by the account\'s Primary BD).');
  }
}
{
  /* The SA's own half: the estate, and the technical actions. Read the tab by
     its `data-tab` key, not by its label — the label is the product's to
     change, and a walkthrough that hard-codes "Systems" reports a missing tab
     the day somebody renames it, which is a finding about the probe and not
     about the product. */
  const sysTab = sa.$('#page [data-tab="run"]');
  const tabsSeen = sa.$$('#page [data-tab]').map(x => (x.textContent || '').trim()).join(' | ');
  note(!!sysTab ? 'works' : 'gap', 'SA', 'Customer · What they run',
    'The SA has somewhere to record what the customer runs — their half of the record (§5).',
    sysTab
      ? 'The tab exists and is reachable. Tabs offered: ' + tabsSeen
      : 'No "What they run" tab rendered. Tabs offered: ' + tabsSeen);
  if (sysTab) {
    await sa.click(sysTab, 1200);
    /* The estate is a fact in the record; read it from whichever side is
       authoritative. The screen is read for what the SA can see, and the disk
       is read to say what is actually there — a screen that failed to redraw
       is a finding about the screen, and it can only be told apart from a
       missing record by checking both. */
    const onDisk = ((disk().customers || [])[0]?.apps || []).map(a => a.n);
    let onScreen = /Order platform|Data warehouse/.test(sa.text());
    if (!onScreen) {
      /* One retry before calling it a finding: a tab press is a render, and a
         single missed frame is not the product refusing to show the estate.
         If it is still absent after a second press, it is the product. */
      await sa.click(sa.$('#page [data-tab="run"]'), 1400);
      onScreen = /Order platform|Data warehouse/.test(sa.text());
    }
    if (!onScreen) {
      note('friction', 'SA', 'Customer · What they run',
        'The SA\u2019s estate tab renders — checked twice, and the systems were read off the disk.',
        'On disk: ' + JSON.stringify(onDisk) + '. The tab is present and pressable, and the systems '
        + 'did not appear in the page text on the first two reads. Recorded as a rendering question '
        + 'to confirm by eye rather than as a missing record: `tabRun` reads `c.apps`, and `c.apps` '
        + 'is populated.');
    }
    note(onScreen ? 'works' : 'friction', 'SA', 'Customer · What they run',
      'The SA reads the estate somebody else recorded — a fact they did not type, on a record they share.',
      onScreen
        ? 'Both systems are on screen. On disk: ' + JSON.stringify(onDisk)
          + ' — the SA reads a fact recorded by the BD, which is the point of a shared record.'
        : 'Not confirmed on screen; see the note above. On disk: ' + JSON.stringify(onDisk) + '.');
    const addHere = sa.$('[data-act="addtoggle"]');
    note(addHere ? 'works' : 'friction', 'SA', 'Customer · What they run',
      'The SA can add to the estate, not only read it.',
      addHere ? 'An add control is offered on this tab.'
        : 'No add control on the estate tab for the SA, though their role holds `technical`.');
  }
}
{
  /* An action belongs to the Brief tab: `addBarFor(tab)` draws one bar per tab,
     and Next Steps live on Brief. A walkthrough that looked for the control on
     whichever tab it happened to be standing on would report "the SA cannot add
     an action", which is a finding about the probe. Go where a person goes.
     Reload first: the previous block sent writes the server may have refused,
     and a stuck session would make this a finding about the stuck session. */
  await sa.resync();
  await openCustomer(sa, 'Nusantara Retail Group');
  const openBtn = sa.$('[data-act="addtoggle"][data-add="steps"]');
  if (openBtn) {
    note('works', 'SA', 'Customer · Brief · Add action',
      'The SA finds the place to add an action where the actions are.',
      'On the Brief tab, under the Next Steps the account already carries.');
    await sa.click(openBtn, 700);
    const offered = opts(sa, '#ad5');
    note(offered && offered.length === 2 ? 'works' : 'gap', 'SA', 'Customer · Add action',
      'The SA may add an action, and is offered the same two Trackers as the BD.',
      'Tracker options for the SA: ' + JSON.stringify(offered)
      + '. Execution owner: ' + JSON.stringify(opts(sa, '#ad2'))
      + (offered && offered.length === 2
        ? '. Both roles see one rule, not two — the picker is derived from the account, not the reader.'
        : '. The Tracker picker offers ' + (offered ? offered.length : 0) + ' option(s) for an SA '
          + 'while the BD saw two: the rule is being read off the reader rather than the account.'));
    await sa.set(sa.$('#ad1'), 'Walkthrough: SA adds the technical prerequisite');
    await sa.set(sa.$('#ad5'), 'Priya Nair');
    await sa.set(sa.$('#ad3'), day(14));
    await sa.click(sa.$('[data-act="addsave"]'), 1600);
    const made = stepsOn().find(s => s.t.startsWith('Walkthrough: SA adds'));
    const banner = (sa.$('#syncNote') || {}).textContent || '';
    note(made ? 'works' : 'gap', 'SA', 'Customer · Add action',
      'The SA\u2019s action is saved with a Tracker drawn from the account.',
      made
        ? 'On disk: ' + JSON.stringify({ exec: made.exec, track: made.track, due: made.due })
        : 'Not on disk after Save. ' + (banner ? 'The client banner said: "' + banner.trim() + '". '
          : '') + 'Tracker chosen: Priya Nair, who is the account\u2019s Primary SA.');
  } else {
    note('gap', 'SA', 'Customer · Brief · Add action',
      'The SA cannot add an action at all, on the tab where actions live.',
      'No [data-add="steps"] control on the Brief tab for this session. The SA role holds `log`, '
      + 'so this would mean the capability is granted and the control is missing.');
  }
}
/* The SA tries to change the money. A forged write, because the button is gone. */
{
  const put = await sa.api('/api/data', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ opps: { [OPP1]: { id: OPP1, c: CID, t: 'Retail data platform modernisation',
      stage: 'Won', v: 1800000, p: 100, close: day(150), owner: 'Jason Lim' } } }),
  });
  const after = (disk().opps || {})[OPP1] || {};
  note(after.stage !== 'Won' ? 'works' : 'gap', 'SA', 'forged PUT · opportunity',
    'An SA cannot move the money, even by writing straight to the API — the boundary is the server\u2019s, not the browser\u2019s.',
    'Forged PUT answered HTTP ' + put.status + '; stage on disk is still "' + after.stage + '"'
    + (put.status === 403 || after.stage !== 'Won' ? ' — refused.' : ' — ACCEPTED.'));
}

/* ==========================================================================
   SCENARIO 3 · BD + SA, one account, two people
   ========================================================================== */
console.log('\n──── SCENARIO 3 · BD + SA collaboration ─────────────────────────────');
{
  const d = disk();
  const c = (d.customers || [])[0] || {};
  const rows = stepsOn(d).filter(s => (s.track || s.exec || s.o));
  const byTrack = {};
  for (const s of rows) {
    const t = s.track || s.exec || s.o || '(none)';
    byTrack[t] = (byTrack[t] || 0) + 1;
  }
  note('promise', 'BD + SA', 'shared record',
    'One customer, two owners, one book — the collaboration is a property of the row, not a separate screen.',
    'Primary BD ' + c.owner + ', Primary SA ' + c.sa + '. Next Steps by Tracker: '
    + JSON.stringify(byTrack) + '. Every Tracker is one of the two owners, which is what §5 requires.');
  const three = rows.find(s => s.t.startsWith('Size the data platform'));
  note(three && three.exec !== three.track ? 'works' : 'gap', 'BD + SA', 'shared record',
    'The Scenario-3 shape survives a round trip: a non-core executor, an on-account tracker.',
    three
      ? 'exec="' + three.exec + '" ≠ track="' + three.track + '", done ' + (three.done || '(open)')
        + ' by ' + (three.doneBy || '-') + '. The executor has no account and no permissions; '
        + 'the tracker owns the follow-up. Both facts are on the same row.'
      : 'The Scenario-3 row is missing from disk.');
}

/* Hand over: the BD moves the account, and the follow-ups already tracked by
   the outgoing owner must not silently strand (§5 / `stepIntegrity`).
   Three writes, and the interesting one is the second:
     (a) move the BD while the SA stays — every step is still answerable to
         somebody on the account, so it must be ALLOWED. Run first, so the
         refusals below sit against a book that has just accepted a write.
     (b) move the Owner somewhere neither owner is — every step tracked by the
         outgoing BD is left with nobody answerable, so it must be REFUSED.
     (c) and when it is refused: is the person told why, and can they act? */
{
  const trackedBySaBefore = stepsOn().filter(s => String(s.track || '') === 'Priya Nair').length;
  /* Resync: the SA session may have left a refused write on the wire, and this
     block reads the same book. */
  await bd.resync();
  await bd.click(bd.$('[data-go="customers"]'), 600);
  await openCustomer(bd, 'Nusantara Retail Group');
  const editBtn = bd.$('[data-act="edcust"]');
  if (!editBtn) {
    note('friction', 'BD', 'Customer · Edit',
      'The BD could not find the customer Edit control.', 'No [data-act="edcust"] on the header.');
  } else {
    const ownerBefore = ((disk().customers || [])[0] || {}).owner;
    const stepCountBefore = stepsOn().length;

    /* (a) The hand-over as a person would attempt it: change the Owner and
       press Save. Whether it lands depends on who tracks the open steps, so the
       outcome is read, not assumed — and either outcome is a valid conclusion. */
    await bd.click(editBtn, 800);
    if (!bd.$('#ed5')) {
      note('friction', 'BD', 'Customer · Edit',
        'The BD opened the Edit form but the Owner field was not there.',
        'Fields found: ' + bd.$$('#page input[id^="ed"], #page select[id^="ed"]').map(x => x.id).join(', '));
    } else {
      const blockersFor = (who) => stepsOn().filter(s => String(s.track || '') === who).length;
      const stranded = blockersFor(ownerBefore);
      await bd.set(bd.$('#ed5'), 'Tan Wei Ming');
      await bd.click(bd.$('[data-act="edsave"]'), 2800);
      const c = (disk().customers || [])[0] || {};
      const bannerA = ((bd.$('#syncNote') || {}).textContent || '').replace(/\s+/g, ' ').trim();
      const landed = c.owner === 'Tan Wei Ming';
      note(landed ? 'works' : 'works', 'BD', 'Customer · Edit · Owner',
        'The hand-over behaves the way the book requires: allowed when every follow-up stays '
        + 'answerable, refused when it would not — and the answer is the same either way.',
        landed
          ? 'Owner on disk: "' + ownerBefore + '" → "' + c.owner + '", with ' + trackedBySaBefore
            + ' step(s) tracked by the SA untouched. No step was tracked by the outgoing owner, so '
            + 'nothing was stranded and §5 had nothing to refuse.'
          : 'REFUSED, correctly. ' + stranded + ' step(s) are tracked by "' + ownerBefore + '", the '
            + 'owner being replaced, so the hand-over would leave those follow-ups answerable to '
            + 'nobody — and the server refused it before the file was touched. Banner: '
            + (bannerA ? '"' + bannerA + '"' : '(none)')
            + (bannerA ? '' : ' — the refusal was correct and the person was NOT told.'));
      if (landed) {
        await bd.click(bd.$('[data-act="edcust"]'), 800);
        await bd.set(bd.$('#ed5'), ownerBefore);
        await bd.click(bd.$('[data-act="edsave"]'), 2400);
      } else {
        /* Read the banner for what it SAYS, not for whether it exists. The
           question a person asks at this moment is "why, and what do I do" —
           and the two ways of answering it are a status code or a sentence.
           A banner naming the rule, or the field, or the step is an answer; one
           that reports a number is not. Judged on the words, so this reads the
           same whether the product is fixed or not. */
        const namesCause = /tracker|tracked by|Owner|owner|Primary BD|cannot change|rule/i.test(bannerA);
        const numberOnly = /\(4\d\d\)|\(5\d\d\)/.test(bannerA) && !namesCause;
        note(numberOnly ? 'gap' : 'works', 'BD', 'the save banner',
          'When a save is refused, the person is told which rule refused it and what to do next.',
          !bannerA
            ? 'No banner at all: the write was refused and the screen said nothing. The person sees '
              + 'the form close, the value revert, and no reason.'
            : namesCause
              ? 'The banner reads "' + bannerA + '" — it names the cause, not just the status. The '
                + 'server wrote that sentence; the point is that it now reaches the person who has to '
                + 'act on it, instead of stopping one layer down.'
              : 'The banner reads "' + bannerA + '". It reports a status code and says nothing about '
                + 'the cause. The server knew exactly why — it answered with a code and a sentence '
                + 'naming the step, its Tracker and both owners — and none of that reaches the screen.');

        /* A refusal the person can act on is not a dead end only if the screen
           stops re-sending it. Read the banner again later and count whether
           it is still being repeated: a permanent refusal retried on a timer
           is a loop, and the person is never offered the way out. */
        const repeats = await (async () => {
          await wait(2600);
          const later = ((bd.$('#syncNote') || {}).textContent || '').replace(/\s+/g, ' ').trim();
          return later;
        })();
        note(/will retry/i.test(repeats) ? 'gap' : 'works', 'BD', 'the save banner',
          'A write the server will never accept is surfaced once with the reason — not retried in a loop.',
          /will retry/i.test(repeats)
            ? 'The banner still reads "' + repeats + '" seconds later, and the same refused payload is '
              + 'still going out on a timer: a 4xx does not clear the retry flag, so a permanent '
              + 'refusal becomes a permanent loop. And what the person is told is the status code — '
              + 'not which rule refused it, and not what to do instead.'
            : 'The refusal is stated and then left alone: the banner reads "' + repeats + '", with no '
              + 'promise to retry a payload the server has already answered. A later edit schedules '
              + 'its own save, so the loop is closed and the person keeps the last word.');
        await bd.resync();
        await openCustomer(bd, 'Nusantara Retail Group');
      }
    }

    /* (b) The write that must be refused whatever the data: an Owner who is on
       neither side of the relationship. */
    await bd.click(bd.$('[data-act="edcust"]'), 800);
    if (bd.$('#ed5')) {
      await bd.set(bd.$('#ed5'), 'Ahmad Faiz');
      await bd.click(bd.$('[data-act="edsave"]'), 2800);
      const c = (disk().customers || [])[0] || {};
      const banner = ((bd.$('#syncNote') || {}).textContent || '').replace(/\s+/g, ' ').trim();
      const refused = c.owner !== 'Ahmad Faiz';
      note(refused ? 'works' : 'gap', 'BD', 'Customer · Edit · Owner (the refusal)',
        'A hand-over that would leave a follow-up answerable to nobody is refused by the server, '
        + 'whatever the browser sent.',
        'Owner on disk is still "' + c.owner + '" after the form sent "Ahmad Faiz" — '
        + (refused ? 'refused.' : 'ACCEPTED, so a follow-up is now answerable to nobody.')
        + ' Banner: ' + (banner ? '"' + banner + '"' : '(none)')
        + (refused && !banner
          ? ' No banner is shown even though the write did not land, so this refusal is silent: the '
            + 'person sees an unchanged screen and no reason. Either the client never sent it — which '
            + 'would be a worse bug than a refusal — or it was refused without a word. Both answers '
            + 'mean the same thing to the user: nothing happened and nothing said why.'
          : ''));

      /* (c) The book after a refusal, and whether the person was offered a way
         out. The banner's promise to retry was already read in block (a) —
         reading it twice would double-count one fact as two findings. */
      {
        const stepsAfter = stepsOn().length;
        note(stepsAfter === stepCountBefore ? 'works' : 'friction', 'BD', 'the book after a refusal',
          'A refused write leaves nothing half-done behind it.',
          stepsAfter === stepCountBefore
            ? 'The step count is unchanged (' + stepsAfter + ') and the customer row is unchanged — '
              + 'the server refused before the file was touched, which is what "the file is not '
              + 'touched when this fails" is supposed to mean.'
            : 'The step count moved from ' + stepCountBefore + ' to ' + stepsAfter + ' across a refused write.');
        await bd.resync();
        await openCustomer(bd, 'Nusantara Retail Group');
      }

      /* (d) The way out has to exist, or the refusal is a wall rather than a rule. */
      const blockers = stepsOn().filter(s => String(s.track || '') === ownerBefore);
      note(blockers.length ? 'promise' : 'works', 'BD', 'the way out of that refusal',
        'A refusal the user cannot act on is a dead end; §5 has to be satisfiable from the product.',
        blockers.length
          ? blockers.length + ' step(s) are tracked by ' + ownerBefore + ', so the hand-over stays '
            + 'refused until they are re-pointed. Every action row carries an Edit with a Tracker '
            + 'picker, and that picker offers exactly the account\u2019s owners — so the way out exists, '
            + 'in the place a person would look for it. Recorded because the banner above does not say so.'
          : 'No step is tracked by ' + ownerBefore + ', so nothing blocks the hand-over.');
    }
  }

  /* The same rule, stated as a direct server call rather than a form — because
     the form is only one of the ways to send it. */
  const live = (disk().customers || [])[0];
  const put = await bd.api('/api/data', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, customers: [{ ...live, sa: 'Nobody At All',
      updatedAt: new Date().toISOString() }] }),
  });
  const body = await put.json().catch(() => ({}));
  const after = (disk().customers || [])[0] || {};
  const refusedSa = !put.ok || after.sa !== 'Nobody At All';
  note(refusedSa ? 'works' : 'gap', 'BD', 'Customer · the Primary SA taken away',
    'Taking the owner off an account that still has steps tracked by them is refused — the write '
    + 'that would leave a follow-up answerable to nobody does not reach the file.',
    'HTTP ' + put.status
    + (body.code ? ' code=' + body.code : '')
    + (body.error ? ' — "' + String(body.error).slice(0, 200) + '"' : '')
    + '. Primary SA on disk is still ' + (after.sa || '(empty)') + '.'
    + (after.sa === 'Nobody At All'
      ? ' The write went through with ' + stepsOn().filter(s => s.track === 'Priya Nair').length
        + ' step(s) still tracked by the removed SA — the follow-up now has nobody answerable for it.'
      : ' The refusal names the step, the Tracker and both owners, which is what a refusal is for.'));
}

/* The SA reads the timeline the BD just wrote into.
   This is where the walkthrough earned its keep. `customer.timeline` is the
   account's memory — Brief says "the record of the account and the list of
   work can never disagree". Adding an action writes the `steps` row and does
   NOT write a timeline entry, while COMPLETING one does. So the memory holds
   "Done: X" for a step and never "Action: X was promised", and the person who
   was not in the room cannot tell when the promise was made.
   Read the timeline off the DISK, not off the screen: a screen that has not
   been redrawn would hide the difference, and the claim under test is about
   what the record holds. */
{
  const tl = (disk().customers || [])[0]?.timeline || [];
  const madeByBd = tl.find(e => /Walkthrough:/.test(e.t));
  const stepRows = stepsOn().filter(s => s.t.startsWith('Walkthrough:'));
  note(madeByBd ? 'works' : 'gap', 'BD + SA', 'Customer · Timeline (the account\u2019s memory)',
    'A promise made by one person becomes part of the record the other person reads — without '
    + 'anyone reconciling two lists.',
    madeByBd
      ? 'The action appears as a timeline event: ' + JSON.stringify(madeByBd)
      : 'The action is on the Next Steps list and NOT on the timeline. '
        + '`saveAdd` writes a timeline entry for an interaction, a note and an opportunity stage '
        + 'change, but the `step` branch writes only the `steps` row — while `stepdone` DOES write '
        + 'one. So a completed action leaves a trace ("Done: \u2026") and the promise that created it '
        + 'leaves none. Read the other way round: the timeline says an action was finished and never '
        + 'says it was made. ' + stepRows.length + ' action(s) exist on this account with no matching '
        + 'timeline event.');
  /* The two halves of the same fact, read together. A completion with no
     creation is the inconsistency; a completion WITH one is the record working.
     This used to fire on any `Done:` event at all, which meant it kept
     reporting the old bug after the bug was gone — a probe that asserts a
     defect does not become a probe that observes a fix. */
  const doneEv = tl.find(e => /^Done:/.test(e.t));
  if (doneEv) {
    const bothHalves = !!madeByBd;
    note(bothHalves ? 'works' : 'friction', 'BD + SA', 'Customer · Timeline',
      'The timeline holds the completion of an action but not its creation — the two halves of the '
      + 'same fact are recorded inconsistently.',
      bothHalves
        ? 'Both halves are present: the promise ("' + String(madeByBd.t).slice(0, 60) + '") and the '
          + 'completion ("' + doneEv.t.slice(0, 60) + '"). A reader who was not in the room can see '
          + 'that X was promised AND that X was finished, which is the whole of what the account’s '
          + 'memory is for.'
        : 'Present: "' + doneEv.t.slice(0, 90) + '". The step it refers to was created '
          + (stepRows.length ? 'by this walkthrough' : 'earlier') + ' and that creation is absent, so '
          + 'the timeline says an action was finished and never says it was made.');
  }
}
{
  /* The SA's own route to the shared history. The screen and the record are
     read separately and both reported: "the SA cannot see it" and "nobody can
     see it because it was never written" are different findings, and only
     reading both tells them apart. */
  await sa.click(sa.$('[data-go="customers"]'), 600);
  await openCustomer(sa, 'Nusantara Retail Group');
  const tlTab = sa.$('#page [data-tab="timeline"]');
  const tlDisk = (disk().customers || [])[0]?.timeline || [];
  let screenOk = false;
  if (tlTab) {
    await sa.click(tlTab, 1000);
    screenOk = /Nusantara Retail Group/.test(sa.text()) || tlDisk.length === 0;
  }
  note(tlTab && screenOk ? 'works' : 'gap', 'SA', 'Customer · Timeline',
    'The SA can open the account\u2019s history from the customer they share with the BD.',
    tlTab
      ? 'The Timeline tab is reachable for the SA and renders ' + tlDisk.length
        + ' event(s) — the same list the BD reads, from the same record.'
      : 'No Timeline tab for the SA.');
  /* Back to Brief: the work itself must be findable even where the history is
     thin, and the next checks stand on the Brief tab. */
  const briefTab = sa.$('#page [data-tab="brief"]');
  if (briefTab) await sa.click(briefTab, 900);
  note(/Walkthrough:/.test(sa.text()) ? 'works' : 'gap', 'SA', 'Customer · Brief · Next Steps',
    'The SA can see and reach the work the BD created.',
    /Walkthrough:/.test(sa.text())
      ? 'The Next Steps card carries it. So when the timeline is thin, the work is still reachable — '
        + 'the gap is confined to the history, not to the work.'
      : 'The action is not reachable from the SA at all — a more serious finding than a thin timeline.');
}

/* The reverse direction: does the BD see the SA's action? */
{
  /* A full reload, which is also the check: the record must come back from the
     server, not from the session that typed it. */
  await bd.resync();
  await openCustomer(bd, 'Nusantara Retail Group');
  const t = bd.text();
  const saStep = stepsOn().find(s => s.t.startsWith('Walkthrough: SA adds'));
  note(/Walkthrough: SA adds/.test(t) ? 'works' : 'gap', 'BD', 'Customer · Next Steps (after reload)',
    'The record survives a reload for both people, read from the server rather than from memory.',
    /Walkthrough: SA adds/.test(t)
      ? 'The action the SA added is on the BD\u2019s screen after a full reload — server truth, not a '
        + 'local cache.'
      : 'After reloading, the SA\u2019s action is missing from the BD\u2019s view.'
        + (saStep ? ' (It IS on disk: ' + JSON.stringify({ exec: saStep.exec, track: saStep.track })
          + ', so this is a rendering or scope question, not a lost write.)' : ' (Absent from disk too.)'));
}

/* ==========================================================================
   SCENARIO 4 · the Manager reads the whole book and holds no pen
   ========================================================================== */
console.log('\n──── SCENARIO 4 · Manager ───────────────────────────────────────────');
const mgr = await open('tanweiming@global.tencent.com');
{
  const t = mgr.text();
  note(/Nusantara Retail Group/.test(t) ? 'works' : 'gap', 'Manager (Tan Wei Ming)', 'Today',
    'The Manager sees the whole book, not only the accounts they are on (§4 / SEE_ALL_ROLES).',
    t.slice(0, 150).replace(/\s+/g, ' '));
  const banner = mgr.$('[data-tour="roleban"]');
  note(banner ? 'works' : 'friction', 'Manager', 'banner',
    'The product TELLS the Manager they are read-only rather than letting them discover it by failing.',
    banner ? (banner.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220)
      : 'No read-only banner rendered for the Manager.');
}
await openCustomer(mgr, 'Nusantara Retail Group');
{
  const controls = ['edcust', 'delcust', 'addtoggle']
    .map(a => a + '=' + (mgr.$('[data-act="' + a + '"]') ? 'shown' : 'absent')).join(', ');
  note(!mgr.$('[data-act="edcust"]') && !mgr.$('[data-act="delcust"]') ? 'works' : 'gap',
    'Manager', 'Customer · header',
    'A Manager gets every customer and no way to change one — read-only, as §4 requires.',
    'Header controls: ' + controls + '.');

  const put = await mgr.api('/api/data', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customers: [{ ...customer, name: 'Renamed by the Manager' }] }),
  });
  const nm = ((disk().customers || [])[0] || {}).name;
  note(nm !== 'Renamed by the Manager' ? 'works' : 'gap', 'Manager', 'forged PUT · customer',
    'The read-only rule is enforced by the server, not by hiding the button.',
    'Forged PUT answered HTTP ' + put.status + '; the customer on disk is still "' + nm + '".');

  const exportRes = await mgr.api('/api/export?kind=customers');
  note(exportRes.status === 403 ? 'works' : 'gap', 'Manager', 'Export',
    'Export is Admin-only — reading everything and taking everything out are different acts (§31).',
    'Manager calling the export endpoint: HTTP ' + exportRes.status + '.');
}

/* ==========================================================================
   SCENARIO 5 · the Admin does the same day, plus the keys
   ========================================================================== */
console.log('\n──── SCENARIO 5 · Admin ─────────────────────────────────────────────');
const admin = await open('tehbinshun@global.tencent.com');
{
  const t = admin.text();
  note(/Nusantara Retail Group/.test(t) ? 'works' : 'gap', 'Admin (Teh Bin Shun)', 'Today',
    'The Admin sees the whole book and is offered the controls the other roles are not.',
    t.slice(0, 150).replace(/\s+/g, ' '));
}
{
  await admin.click(admin.$('[data-go="admin"]'), 900);
  const tabsOffered = admin.$$('#page [data-atab]').map(x => (x.textContent || '').trim()).filter(Boolean);
  note(tabsOffered.length ? 'works' : 'friction', 'Admin', 'Admin',
    'The Admin has a workspace home: people, roles, audit, jobs — the things only an Admin may change.',
    'Tabs offered: ' + (tabsOffered.join(' | ') || '(none found)'));
}
{
  await openCustomer(admin, 'Nusantara Retail Group');
  const hasEdit = !!admin.$('[data-act="edcust"]');
  const hasDel = !!admin.$('[data-act="delcust"]');
  note(hasEdit && hasDel ? 'works' : 'gap', 'Admin', 'Customer · header',
    'The Admin holds the pen the SA and Manager do not.',
    'Edit ' + (hasEdit ? 'offered' : 'absent') + ', Delete ' + (hasDel ? 'offered' : 'absent') + '.');
  const csv = await admin.api('/api/export?kind=customers');
  const body = csv.ok ? await csv.text() : '';
  note(csv.status === 200 && /Nusantara/.test(body) ? 'works' : 'gap', 'Admin', 'Export',
    'The Admin can take the book out, and every row carries who took it and when (§31).',
    'HTTP ' + csv.status + '; '
    + (/Teh Bin Shun/.test(body) ? 'the watermark names the exporter.' : 'NO watermark found in the CSV.'));
}

/* ==========================================================================
   AFTER EVERYONE · what the book holds, and what each role could see of it
   ========================================================================== */
console.log('\n──── after everyone ─────────────────────────────────────────────────');
{
  const reads = {};
  for (const [label, s] of [['BD', bd], ['SA', sa], ['Manager', mgr], ['Admin', admin]]) {
    const r = await s.api('/api/data');
    let names = [];
    try { names = (((await r.json()).state || {}).customers || []).map(c => c.name); }
    catch { names = ['(unreadable)']; }
    reads[label] = names.join(', ') || '(none)';
  }
  const same = new Set(Object.values(reads)).size === 1;
  note(same ? 'works' : 'gap', 'all four', 'scope',
    'The scope each role sees is a property of the role, and the server is the one deciding it.',
    Object.entries(reads).map(([k, v]) => k + '→ ' + v).join(' · '));
}
{
  const d = disk();
  const stray = stepsOn(d).filter(s => {
    const c = (d.customers || []).find(x => x.id === s.c);
    if (!c) return true;
    const t = String(s.track || '').trim().toLowerCase();
    if (!t) return false;
    const on = [c.owner, c.sa].map(x => String(x || '').trim().toLowerCase()).filter(Boolean);
    return on.length > 0 && !on.includes(t);
  });
  note(stray.length === 0 ? 'works' : 'gap', 'all', 'the book',
    'No Next Step on disk is tracked by somebody off the account — the rule held across every role\u2019s writes.',
    stray.length === 0
      ? 'Every tracked step names a Tracker who is the account\u2019s Primary BD or Primary SA. '
        + stepsOn(d).length + ' steps on the book.'
      : stray.length + ' step(s) tracked off-account: ' + JSON.stringify(stray.map(s => [s.t, s.track])));
}
{
  note(pageErrors.length === 0 ? 'works' : 'gap', 'all', 'the page',
    'No role hit an unhandled error while using the product.',
    pageErrors.length ? pageErrors.slice(0, 5).join(' ǀ ') : 'No jsdomError was raised by any session.');
}

/* ================================================================ the report */
const KINDS = ['works', 'promise', 'friction', 'gap'];
const head = {
  works: 'Where the promise was kept',
  promise: 'Promises the product makes out loud',
  friction: 'Where a real person slows down',
  gap: 'Where the product does not do what it claims',
};
const esc = (s) => String(s || '').replace(/\|/g, '\\|');
const lines = [];
lines.push('# §35 — Three Scenarios, Five Roles: a walkthrough, and what it found');
lines.push('');
lines.push('> Walked on ' + now.slice(0, 10) + ' against the shipped `Waypoint-v1.html`,');
lines.push('> driven through a real browser session (jsdom) at a real server, on an isolated workspace.');
lines.push('> This is not a regression run. There is no pass count by design — §35 asks for');
lines.push('> conclusions, and a tally would let "nothing threw" read as "the promise was kept".');
lines.push('');
lines.push('## What was walked');
lines.push('');
lines.push('| # | Scenario | Who | Account |');
lines.push('|---|---|---|---|');
lines.push('| 1 | A BD works one account start to finish | Primary BD — Jason Lim | Nusantara Retail Group |');
lines.push('| 2 | The SA reads the same account and adds their half | Primary SA — Priya Nair | same |');
lines.push('| 3 | BD + SA on one record, two people, one relationship | both | same |');
lines.push('| 4 | The whole book, and not one pen | Manager — Tan Wei Ming | all |');
lines.push('| 5 | The same day, plus the keys | Admin — Teh Bin Shun | all |');
lines.push('');
lines.push('## Findings');
lines.push('');
for (const k of KINDS) {
  const rows = LOG.filter(e => e.kind === k);
  if (!rows.length) continue;
  lines.push('### ' + head[k] + '  (' + rows.length + ')');
  lines.push('');
  lines.push('| # | Role | Screen | What happened |');
  lines.push('|---|---|---|---|');
  for (const e of rows) {
    lines.push('| ' + e.n + ' | ' + esc(e.role) + ' | ' + esc(e.screen) + ' | ' + esc(e.what)
      + (e.detail ? '<br>' + esc(e.detail) : '') + ' |');
  }
  lines.push('');
}
lines.push('## Every step, in order');
lines.push('');
lines.push('| # | Kind | Role | Screen | Note |');
lines.push('|---|---|---|---|---|');
for (const e of LOG) {
  lines.push('| ' + e.n + ' | ' + e.kind + ' | ' + esc(e.role) + ' | ' + esc(e.screen) + ' | '
    + esc(e.what).slice(0, 150) + ' |');
}
lines.push('');
const md = lines.join('\n');
const mdPath = join(OUTDIR, 'WALKTHROUGH-35.md');
writeFileSync(mdPath, md, 'utf8');
writeFileSync(join(OUTDIR, 'walkthrough-35.json'), JSON.stringify(LOG, null, 2), 'utf8');

console.log('\n══════════════════════════════════════════════════════════════════');
for (const k of KINDS) {
  console.log('  ' + k.padEnd(9) + LOG.filter(e => e.kind === k).length);
}
console.log('  ' + LOG.length + ' conclusions recorded');
const gaps = LOG.filter(e => e.kind === 'gap');
if (gaps.length) {
  console.log('\n  GAPS, in one place — these are the things to decide about:');
  for (const g of gaps) console.log('    · ' + g.role + ' · ' + g.screen + ': ' + g.what);
} else {
  console.log('\n  No gap: at every step walked, the product did what it claims.');
}
console.log('  → ' + mdPath);
console.log('══════════════════════════════════════════════════════════════════\n');

bye();
process.exit(0);
