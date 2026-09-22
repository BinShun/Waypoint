/* verify:import — §26: the import carries real relationships, or it stops.
 *
 * WHY THIS EXISTS
 * ---------------
 * §26 widened the paste-import from customers to the four things that hang
 * off a customer: People, Opportunity, MOM (the interaction a MOM lives on)
 * and Next Step. The brief's hard rule for all four: importing must keep
 * "real relationships", never produce orphan rows — an imported Next Step
 * must attach to a customer that exists and is visible, and an Opportunity
 * the same. The client cannot be trusted to hold that line alone, so the
 * server must hold it too.
 *
 * What this suite proves, in two halves:
 *
 *   THE PAGE — every kind refuses bad rows in the preview with the reason
 *   said out loud (customer not on the book, duplicate name, a stage that
 *   is not a stage, a date that is not a date), and commits good rows to
 *   the right customer with the right shape: a person lands in that
 *   customer's contacts, an opportunity in the map AND the customer's own
 *   opps list, an interaction with its timeline twin, a next step tracked
 *   by the account's Primary BD — the one choice §5 allows.
 *
 *   THE SERVER — a forged PUT is refused whatever client sent it: an
 *   opportunity naming a customer that does not exist (or none at all) is
 *   a 400 with code orphan-opportunity; the same forge against interactions
 *   and steps still hits the rules that were already there. And a honest
 *   PUT — a new opportunity on a real customer — still saves, so the new
 *   rule guards the door without locking it.
 *
 * Run from customer-workbench/:  npm run verify:import
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
const PORT = Number(process.env.IMPORT_PORT || 8875);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const PASSWORD = 'Waypoint#2026';
const SOURCE = (await import('node:fs')).readFileSync(join(ROOT, 'Waypoint-v1.html'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

/* ------------------------------------------------------------------- seed */

const CA = 'cA', CB = 'cB';
const mkCust = (id, name, extra = {}) => ({
  id, name, industry: 'Testing', hq: 'Kuala Lumpur', size: '',
  stance: 'Undecided', health: 'Watch', owner: 'Import Admin', sa: '',
  since: '2026-01', site: '', logo: '', people: '',
  brief: '', pains: [], contacts: [], apps: [], timeline: [],
  support: [], team: [], demo: false, unverified: false, links: [], sources: [],
  opps: [], ...extra,
});

/* One person already on customer A, so the import's duplicate rule has
   something real to refuse. */
const customers = [
  mkCust(CA, 'Nusantara Retail Group', {
    contacts: [{ n: 'Existing Person', t: 'Head of IT', s: 'Undecided', o: 'Import Admin', b: 'Influencer', em: '', ph: '', note: '' }],
  }),
  mkCust(CB, 'Beta Trading Sdn'),
];

const dir = mkdtempSync(join(tmpdir(), 'wp-import-'));
const at = new Date().toISOString();
{
  const salt = randomBytes(16);
  writeFileSync(join(dir, 'workbench.json'), JSON.stringify({
    schemaVersion: 1, setupComplete: true,
    users: [{ id: 'u_admin', name: 'Import Admin', email: 'import.admin@global.tencent.com',
      role: 'admin', title: 'Senior Solution Architect', createdAt: at, updatedAt: at }],
    credentials: { u_admin: {
      userId: 'u_admin', algo: 'pbkdf2-sha256', iterations: 150_000,
      salt: salt.toString('base64'),
      hash: pbkdf2Sync(PASSWORD, salt, 150_000, 32, 'sha256').toString('base64'),
      createdAt: at, updatedAt: at } },
    customers, opps: {}, steps: [], interactions: [],
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
  e.value = 'import.admin@global.tencent.com'; p.value = PASSWORD;
  doc.querySelector('[data-act="signin"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await wait(1600);
}
const s = {
  win, jar,
  get doc() { return win.document; },
  $: (sel) => win.document.querySelector(sel),
  text: () => (win.document.getElementById('page') || win.document.body).textContent,
  sheet: () => (win.document.getElementById('capBody') || {}).textContent || '',
  click: async (el, ms = 400) => {
    if (!el) return false;
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await wait(ms); return true;
  },
};

/* Paste rows into the open sheet, read them, and hand back what the sheet
   now says. Each call switches kind first, so a leftover row from the
   previous kind cannot survive the switch. */
async function paste(kind, text) {
  await s.click(s.$('[data-ikind="' + kind + '"]'), 350);
  const ta = s.$('#impT');
  if (!ta) return '(no paste area)';
  ta.value = text;
  await s.click(s.$('#impRead'), 450);
  return s.sheet();
}
async function commit() {
  await s.click(s.$('#impGo'), 1100);
  return s.sheet();
}

/* ======================================================================= */
console.log('\n— §26: the import carries real relationships, or it stops —');

check('admin signs in', /Good (morning|afternoon|evening)|Today|Customers/.test(s.text()), s.text().slice(0, 40));

/* Open the door: Admin → People tab carries the Import button. */
await s.click(s.$('[data-go="admin"]'), 900);
check('the Admin screen offers the import', !!s.$('[data-act="importcsv"]'));
await s.click(s.$('[data-act="importcsv"]'), 600);
check('the sheet opens on five kinds',
  !!(s.$('#capVeil') || {}).classList?.contains?.('on') === true
  && ['customers', 'people', 'opps', 'interactions', 'steps']
    .every(k => !!s.$('[data-ikind="' + k + '"]')));

/* ---------------------------------------------------------- 1. People */
{
  const t = await paste('people', [
    'Customer, Name, Title, Band, Email, Phone',
    'Nusantara Retail Group, Sarah Lim, Head of IT, Decision maker, sarah.lim@example.com, +60 3-2000 1000',
    'Ghost Corp Sdn, Nobody There, CEO, User, , ',
    'Nusantara Retail Group, Existing Person, Head of IT, Influencer, , ',
    'Nusantara Retail Group, Sarah Lim, CFO, Blocker, , ',
    'Beta Trading Sdn, Bad Band Person, CTO, Chieffriend, , ',
  ].join('\n'));
  check('people: one good row survives the read', /1 row to import/.test(t), t.match(/\d+ rows? to import/) ? '' : t.slice(0, 120));
  check('people: an unknown customer is refused with the reason',
    t.includes('Ghost Corp Sdn') && t.includes('is not on the book'));
  check('people: a person already on the customer is refused',
    t.includes('Existing Person is already on Nusantara Retail Group'));
  check('people: the same person twice in one paste is refused the second time',
    (t.match(/Sarah Lim is already on/g) || []).length >= 1);
  check('people: a band that is not a band is refused',
    t.includes('band must be one of'));
  await commit();
  const d = disk();
  const cA = d.customers.find(c => c.id === CA);
  const sarah = (cA.contacts || []).find(p => p.n === 'Sarah Lim');
  check('people: the person landed on the right customer with the right shape',
    !!sarah && sarah.t === 'Head of IT' && sarah.b === 'Decision maker' && sarah.em === 'sarah.lim@example.com',
    sarah ? '' : 'Sarah Lim not found on disk');
  check('people: nothing else landed anywhere',
    (d.customers.find(c => c.id === CB).contacts || []).length === 0
    && (cA.contacts || []).length === 2);
}

/* --------------------------------------------------- 2. Opportunities */
{
  const t = await paste('opps', [
    'Customer, Title, Value, Stage, Close date, Description',
    'Beta Trading Sdn, POS migration, RM 250000, Evaluating, ' + day(60) + ', Six-week assessment of the order platform',
    'Beta Trading Sdn, Bogus stage deal, 100000, Signed sealed, , ',
    'Beta Trading Sdn, Bad close date, 100000, Interested, 31/12/2026, ',
    ', No customer deal, 100000, Interested, , ',
    'Ghost Corp Sdn, Ghost deal, 100000, Interested, , ',
  ].join('\n'));
  check('opps: one good row survives the read', /1 row to import/.test(t));
  check('opps: a stage that is not a stage is refused with the legal ones named',
    t.includes('stage must be one of') && t.includes('Evaluating'));
  check('opps: a close date that is not a date is refused',
    t.includes('the close date needs to look like'));
  check('opps: a row with no customer is refused', t.includes('no customer'));
  check('opps: an unknown customer is refused', t.includes('Ghost Corp Sdn') && t.includes('is not on the book'));
  await commit();
  const d = disk();
  const deal = Object.values(d.opps || {}).find(o => o.t === 'POS migration');
  const cB = d.customers.find(c => c.id === CB);
  check('opps: the deal landed on the map against the right customer',
    !!deal && deal.c === CB && deal.v === 250000 && deal.stage === 'Evaluating');
  check('opps: the customer\u2019s own opps list points back at it',
    (cB.opps || []).includes(deal ? deal.id : '__none__'));
}

/* --------------------------------------------------- 3. Interactions */
{
  const t = await paste('interactions', [
    'Customer, Title, Date, Kind, Attendees, Outcome',
    'Nusantara Retail Group, Kickoff call, ' + day(-2) + ', Call, Their CTO and two architects, Scope agreed for the assessment',
    'Nusantara Retail Group, Smoke signal, ' + day(-1) + ', Signal fire, , ',
    'Nusantara Retail Group, Bad date, someday, Call, , ',
  ].join('\n'));
  check('interactions: one good row survives the read', /1 row to import/.test(t));
  check('interactions: a kind that is not a kind is refused',
    t.includes('kind must be one of: Meeting, Call, Email, Video call'));
  check('interactions: a date that is not a date is refused', t.includes('the date needs to look like'));
  await commit();
  const d = disk();
  const m = (d.interactions || []).find(x => x.t === 'Kickoff call');
  const cA = d.customers.find(c => c.id === CA);
  check('interactions: the record landed with its date and kind',
    !!m && m.c === CA && m.d === day(-2) && m.k === 'Call');
  check('interactions: the customer\u2019s timeline carries its twin',
    (cA.timeline || []).some(x => x.k === 'interaction' && x.t === 'Kickoff call'));
}

/* ----------------------------------------------------- 4. Next steps */
{
  const t = await paste('steps', [
    'Customer, Title, Due date, Owner, Whose move',
    'Beta Trading Sdn, Send architecture notes, ' + day(7) + ', Import Admin, us',
    'Beta Trading Sdn, Bad due, tomorrow!, Import Admin, us',
    'Beta Trading Sdn, Bad move, ' + day(7) + ', Import Admin, sideways',
    'Ghost Corp Sdn, Ghost step, ' + day(7) + ', Import Admin, us',
  ].join('\n'));
  check('steps: one good row survives the read', /1 row to import/.test(t));
  check('steps: a due date that is not a date is refused', t.includes('the due date needs to look like'));
  check('steps: a move that is nobody\u2019s is refused', t.includes('whose move must be us or customer'));
  check('steps: an unknown customer is refused', t.includes('Ghost Corp Sdn') && t.includes('is not on the book'));
  await commit();
  const d = disk();
  const st = (d.steps || []).find(x => x.t === 'Send architecture notes');
  const cB = d.customers.find(c => c.id === CB);
  check('steps: the step landed with its date and owner',
    !!st && st.c === CB && st.due === day(7) && st.exec === 'Import Admin');
  check('steps: the Tracker is the account\u2019s own Primary BD — the one §5 allows',
    !!st && st.track === cB.owner, st ? 'track=' + st.track : 'no step on disk');
  check('steps: the save was accepted, so the server\u2019s tracker rule agrees',
    !!st, 'stepIntegrity let this row through');
  check('steps: the customer\u2019s timeline carries the promise',
    (cB.timeline || []).some(x => x.k === 'step' && x.t === 'Send architecture notes'));
}

/* ------------------------------------- 5. Customers still import (regression) */
{
  const t = await paste('customers', [
    'Customer, Industry, HQ, Website, Owner',
    'Sunrise Retail Group, Retail, Kuala Lumpur, sunriseretail.com.my, Import Admin',
    'Sunrise Retail Group, Retail, Kuala Lumpur, , ',
  ].join('\n'));
  check('customers: the same name twice in one paste is refused the second time',
    /1 row to import/.test(t) && t.includes('Sunrise Retail Group is already on the book'));
  await commit();
  const d = disk();
  const sun = d.customers.find(c => c.name === 'Sunrise Retail Group');
  check('customers: the new customer landed unverified, as before',
    !!sun && sun.unverified === true && sun.industry === 'Retail');
}

/* ------------------------------------------------ the server half — */

/* A forged PUT must be refused whatever the client: the import UI is a
   preference, the relationship is a rule. Each attempt starts from the
   CURRENT disk truth, injects one bad row, and offers it with a matching
   revision — the replace path, the strongest claim a client can make. */
async function forge(mutate) {
  const got = await (await api('/api/data')).json();
  const state = JSON.parse(JSON.stringify(got.state));
  const trouble = mutate(state);
  if (trouble) return trouble;
  const res = await api('/api/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-base-rev': String(got.rev) },
    body: JSON.stringify({ state, baseRev: got.rev, deleted: {} }),
  });
  return { status: res.status, body: await res.json() };
}

{
  const r = await forge((state) => {
    state.opps['oGhost'] = { id: 'oGhost', c: 'cX99', t: 'Ghost deal', stage: 'Interested',
      v: 1, p: 10, stageAt: day(0), owner: 'Import Admin', comp: '-', close: '', cust: '', desc: '', soln: '' };
  });
  check('server: an opportunity naming a customer that does not exist is a 400',
    r.status === 400 && r.body.code === 'orphan-opportunity',
    'status ' + r.status + ' code ' + r.body.code);
}
{
  const r = await forge((state) => {
    state.opps['oNoCust'] = { id: 'oNoCust', c: '', t: 'Nobody\u2019s deal', stage: 'Interested',
      v: 1, p: 10, stageAt: day(0), owner: 'Import Admin', comp: '-', close: '', cust: '', desc: '', soln: '' };
  });
  check('server: an opportunity naming no customer at all is a 400',
    r.status === 400 && r.body.code === 'orphan-opportunity',
    'status ' + r.status + ' code ' + r.body.code);
}
{
  const r = await forge((state) => {
    state.opps['oFine'] = { id: 'oFine', c: CA, t: 'An honest deal', stage: 'Interested',
      v: 1000, p: 10, stageAt: day(0), owner: 'Import Admin', comp: '-', close: '', cust: '', desc: '', soln: '' };
  });
  check('server: an honest opportunity on a real customer still saves',
    r.status === 200 && !!disk().opps.oFine,
    'status ' + r.status);
}
{
  const r = await forge((state) => {
    state.interactions.push({ id: 'mGhost', c: 'cX99', t: 'Ghost call', d: day(0), w: '',
      loc: '', att: '-', ours: 'Import Admin', sum: '', out: '', k: 'Call' });
  });
  check('server: a forged orphan interaction is still a 400 (the rule that was already there)',
    r.status === 400 && r.body.code === 'orphan-meeting',
    'status ' + r.status + ' code ' + r.body.code);
}
{
  const r = await forge((state) => {
    state.steps.push({ id: 'sGhost', c: 'cX99', t: 'Ghost step', exec: 'Import Admin', track: 'Import Admin',
      due: '', w: '', from: 'us', p: 'p1', done: '', doneBy: '', doneNote: '' });
  });
  check('server: a forged orphan step is still a 400',
    r.status === 400, 'status ' + r.status + ' code ' + r.body.code);
}

/* ---------------------------------------- the book is whole at the end */
{
  const d = disk();
  const ids = new Set(d.customers.map(c => c.id));
  const orphanOpps = Object.values(d.opps || {}).filter(o => !ids.has(o.c));
  const orphanSteps = (d.steps || []).filter(x => !ids.has(x.c));
  const orphanMeetings = (d.interactions || []).filter(x => !ids.has(x.c));
  check('disk: not one imported or forged row hangs off nothing',
    orphanOpps.length === 0 && orphanSteps.length === 0 && orphanMeetings.length === 0,
    orphanOpps.length + '/' + orphanSteps.length + '/' + orphanMeetings.length + ' orphans');
  check('the page threw nothing while being used', pageErrors.length === 0,
    pageErrors.slice(0, 2).join(' | '));
}

console.log('\n' + (fail ? `${fail} FAILED, ` : '') + `${pass} passed`);
bye();
process.exit(fail ? 1 : 0);
