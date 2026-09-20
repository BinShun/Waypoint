/* verify:roles — the four-role acceptance test.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every other suite asks "does this work?" This one asks the second question,
 * which is the one that matters in a shared workspace: "does it NOT work for
 * the people it must not work for?" A permission enforced only by hiding a
 * button is not a permission — it is a preference, and the network tab does
 * not respect preferences.
 *
 * So every check here is made with a real session cookie and a hand-made
 * request, deliberately bypassing the UI: if the server says yes to a Manager
 * who should be read-only, the layout being tidy is not a defence.
 *
 * Run from customer-workbench/:  WP_PASS=… npm run verify:roles
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { claimPort } from './harness.mjs';
import { readWorkspaceFile } from './disk.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8857;
const ORIGIN = 'http://127.0.0.1:' + PORT;
const PASS = process.env.WP_PASS || 'Waypoint#2026';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nowStamp = () => new Date().toISOString();

/* --------------------------------------------------------------- server ---- */
const dir = mkdtempSync(join(tmpdir(), 'wp-roles-'));
writeFileSync(join(dir, 'workbench.json'), JSON.stringify({
  schemaVersion: 1, setupComplete: true,
  users: [], credentials: {}, logs: [],
}, null, 1));
const disk = () => readWorkspaceFile(join(dir, 'workbench.json'));

/* The manager ask below creates a real copilot task, and its echo executor
   reaches for a model if one is configured in this shell. This suite has no
   stand-in endpoint, so the honest environment is none at all: the task will
   fail not-configured behind the response, which is fine — the check is
   whether the role gate lets the ask through, not whether the model answers. */
const SPAWN_ENV = { ...process.env };
for (const k of Object.keys(SPAWN_ENV)) if (k.startsWith('AI_')) delete SPAWN_ENV[k];
const srv = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
  env: { ...SPAWN_ENV, WB_DATA_DIR: dir, PORT: String(PORT), WB_TLS: '0', WB_ORIGINS: ORIGIN },
  stdio: ['ignore', 'pipe', 'pipe'],
});
/* Wait for a port this process has PROVEN is free. Waiting on
   /api/health alone cannot fail when an old server is still listening,
   and the suite would then drive somebody else's server. See
   scripts/harness.mjs. */
await claimPort(PORT);
srv.stderr.on('data', (d) => { const s = String(d); if (/Error/.test(s)) console.log('[server] ' + s.trim()); });

/** One browser's worth of cookies, so roles cannot leak into each other. */
function session(label) {
  const s = { label, cookie: '', rev: 0 };
  s.req = async (path, opts = {}) => {
    const res = await fetch(ORIGIN + path, {
      ...opts,
      redirect: 'manual',
      headers: { ...(opts.headers || {}), Origin: ORIGIN, ...(s.cookie ? { cookie: s.cookie } : {}) },
    });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (sc.length) s.cookie = sc.map((x) => x.split(';')[0]).join('; ');
    return res;
  };
  s.json = async (path, opts = {}) => {
    const r = await s.req(path, opts);
    const text = await r.text();
    let body = {};
    try { body = JSON.parse(text); } catch { /* not JSON — the text is the answer */ }
    return { status: r.status, headers: r.headers, text, ...body };
  };
  /** Read the book exactly as this session is allowed to see it. */
  s.read = async () => {
    const d = await s.json('/api/data');
    if (d.status === 200) s.rev = d.rev || 0;
    return d;
  };
  /* Save the way the real client saves: the whole of what it can see, plus the
     revision it last read — which is the `replace` path, the one that takes the
     payload as the whole truth. That is the dangerous path and the ordinary
     one, so it is the one under test. */
  s.put = async (overrides = {}, deleted = {}) => {
    const cur = (await s.read()).state || {};
    const state = { ...cur, ...overrides, schemaVersion: 1 };
    return s.json('/api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Base-Rev': String(s.rev) },
      body: JSON.stringify({ state, deleted, baseRev: s.rev }),
    });
  };
  return s;
}

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(ORIGIN + '/api/health')).ok) break; } catch { /* not yet */ }
  await wait(150);
}
check('the server is up', (await fetch(ORIGIN + '/api/health')).ok);

/* ------------------------------------------------- first-run admin setup --- */
/* The workspace we just made is empty of people, so the first caller to create
   one becomes the administrator. That is the product's own rule, and it is
   worth asserting: it is also the moment an attacker would aim at. Everything
   below runs AFTER it, so the door is shut for the rest of the suite. */
const admin = session('admin');
let adminId = null;
{
  const r = await admin.json('/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Teh Bin Shun', email: 'tehbinshun@global.tencent.com', role: 'admin', password: PASS,
    }),
  });
  adminId = r.user?.id || null;
  check('the first administrator is created', r.status === 200 && !!adminId, 'HTTP ' + r.status);
  /* Creating the account does not sign you in — the workspace is closed from
     here, so the administrator has to present their password like everybody
     else. Worth stating: the call above is the only unauthenticated one. */
  const l = await admin.json('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: adminId, password: PASS }),
  });
  check('the administrator signs in', l.status === 200, 'HTTP ' + l.status);
  const bad = await admin.json('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: adminId, password: 'Wrong#Password' }),
  });
  check('a wrong password is refused', bad.status === 401, 'HTTP ' + bad.status);
}

/* ------------------------------------------------------------- the cast ---- */
const CAST = [
  { key: 'bd', name: 'Ahmad Faiz', email: 'ahmad@example.com', role: 'bd' },
  { key: 'sa', name: 'John Teh', email: 'john@example.com', role: 'sa' },
  { key: 'manager', name: 'Siti Nurhaliza', email: 'siti@example.com', role: 'manager' },
  { key: 'viewer', name: 'Nadia Rahman', email: 'nadia@example.com', role: 'viewer' },
];
for (const p of CAST) {
  const r = await admin.json('/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: p.name, email: p.email, role: p.role, password: PASS }),
  });
  check(`the administrator creates the ${p.role} account`, r.status === 200, 'HTTP ' + r.status);
}

/* Two customers with different owners, so BD and SA each have something of
   their own and something that is not theirs. Without this a scoped role sees
   an empty product, which is a different failure from the one under test. */
{
  const t = nowStamp();
  const customers = [
    {
      id: 'c1', name: 'NusaTel Berhad', industry: 'Telecom', hq: 'Kuala Lumpur',
      owner: 'Ahmad Faiz', stance: 'With us', health: 'Healthy', since: 'Mar 2026',
      site: 'nusatel.com.my', pains: [], contacts: [], apps: [], timeline: [], updatedAt: t,
    },
    {
      id: 'c2', name: 'Kinabalu Water', industry: 'Utilities', hq: 'Kota Kinabalu',
      /* §2: every customer has exactly one Primary BD AND one Primary SA.
         c2 had no SA, so the account team it could offer a Tracker from was
         half-formed and the role scoping below was being tested against a
         shape the product does not allow. */
      owner: 'John Teh', sa: 'Siti Norbaya',
      stance: 'Undecided', health: 'Watch', since: 'Jun 2026',
      site: 'kinabaluwater.com.my', pains: [], contacts: [], apps: [], timeline: [], updatedAt: t,
    },
  ];
  const r = await admin.put({
    customers,
    steps: [{ id: 's1', c: 'c1', t: 'Send the revised pricing', o: 'Ahmad Faiz', due: '2026-10-01', p: 'p1', from: 'us', updatedAt: t }],
    interactions: [{ id: 'm1', c: 'c2', title: 'Discovery', at: '2026-09-20T10:00:00.000Z', updatedAt: t }],
    opps: {
      o1: { id: 'o1', c: 'c1', name: 'Core migration', value: 400000, stage: 'Proposal', updatedAt: t },
      o2: { id: 'o2', c: 'c2', name: 'DR site', value: 120000, stage: 'Qualify', updatedAt: t },
    },
  });
  check('the administrator can seed the book', r.status === 200, 'HTTP ' + r.status);
  check('both customers are on disk', (disk().customers || []).length === 2,
    (disk().customers || []).length + ' customers');
}

/* -------------------------------------------------------------- Sign in ---- */
const sessions = { admin };
for (const p of CAST) {
  const s = session(p.key);
  const d = await s.json('/api/directory');
  const me = (d.users || []).find((u) => u.name === p.name);
  const l = await s.json('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: me?.id, password: PASS }),
  });
  check(`the ${p.role} signs in`, l.status === 200, 'HTTP ' + l.status);
  sessions[p.key] = s;
}

/* ---------------------------------------------------------- a stranger ---- */
/* Now the workspace has people in it, so every one of these must be refused.
   Run before this point an empty workspace is legitimately open — that is how
   the first administrator is ever made — and a green light here would mean
   nothing. */
{
  const anon = session('anonymous');
  const d = await anon.json('/api/data');
  check('a stranger cannot read the workspace', d.status === 401, 'HTTP ' + d.status);
  const e = await anon.json('/api/export?kind=customers');
  check('a stranger cannot export', e.status === 401, 'HTTP ' + e.status);
  const u = await anon.json('/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Nobody', email: 'nobody@example.com', role: 'admin', password: 'Waypoint#2026' }),
  });
  check('a stranger cannot create an account', u.status === 401, 'HTTP ' + u.status);
  const w = await anon.json('/api/data', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: { schemaVersion: 1, customers: [] } }),
  });
  check('a stranger cannot write', w.status === 401, 'HTTP ' + w.status);
  const ai = await anon.json('/api/ai/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'hello' }),
  });
  check('a stranger cannot reach the model', ai.status === 401, 'HTTP ' + ai.status);
  const cfg = await anon.json('/api/ai/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: 'https://example.invalid/v1', apiKey: 'sk-test' }),
  });
  check('a stranger cannot change the model settings', cfg.status === 401, 'HTTP ' + cfg.status);
  const rst = await anon.json('/api/reset', { method: 'POST' });
  check('a stranger cannot clear the workspace', rst.status === 401, 'HTTP ' + rst.status);
}

/* A step's Tracker must be the account's Primary BD or Primary SA (§5), and
   the server ENFORCES that — so a row whose owner is not on the account is
   refused with HTTP 400. This helper used to hard-code 'Ahmad Faiz', who owns
   c1 but NOT c2, which made every write against c2 fail. The fixture was wrong;
   the rule was right. Taking the owner from the customer keeps the two in step
   however the fixture is edited later. */
const stepRow = (id, cid, text) => ({
  id, c: cid, t: text, o: cust(cid).owner || 'Ahmad Faiz',
  track: cust(cid).owner || 'Ahmad Faiz',
  due: '2026-12-01', w: 'in 2d', from: 'us', p: 'p1',
  updatedAt: nowStamp(),
});
const rows = (key) => disk()[key] || [];
const steps = () => rows('steps');
const cust = (id) => (disk().customers || []).find((c) => c.id === id) || {};

/* ============================================================== ADMIN ===== */
{
  const s = sessions.admin;
  const d = await s.read();
  check('ADMIN can read the whole workspace', d.status === 200 && (d.state.customers || []).length === 2,
    (d.state.customers || []).length + ' customers');
  const put = await s.put({ steps: [...steps(), stepRow('s_admin', 'c2', 'Admin wrote this')] });
  check('ADMIN can write', put.status === 200, 'HTTP ' + put.status);
  check('and the write is on the disk', steps().some((x) => x.id === 's_admin'));
  const ex = await s.req('/api/export?kind=customers');
  const body = await ex.text();
  check('ADMIN can export', ex.status === 200 && /Customer,Industry/.test(body) && /Kinabalu Water/.test(body),
    'HTTP ' + ex.status);
  /* Removing a row is an act, not a silence. It used to be possible to delete
     by simply leaving a row out of the payload, and for the administrator —
     the one role whose client sends only some of the collections — that turned
     every ordinary save into a delete of everything it did not mention, audit
     log and insights included. So the client now NAMES what it removed, and an
     omission means "this client has nothing to say about this collection".
     Destroying a record is still the administrator's alone, either way. */
  const del = await s.put({ steps: steps().filter((x) => x.id !== 's_admin') }, { steps: ['s_admin'] });
  check('ADMIN can delete', del.status === 200 && !steps().some((x) => x.id === 's_admin'),
    'HTTP ' + del.status);
  /* And the silence really is a silence: write a row, then leave it out of the
     next save without naming it, and it has to still be there. */
  await s.put({ steps: [...steps(), stepRow('s_omit', 'c2', 'left out on purpose')] });
  await s.put({ steps: steps().filter((x) => x.id !== 's_omit') });
  check('a row merely left out of a save is not destroyed',
    steps().some((x) => x.id === 's_omit'), `steps=${steps().map((x) => x.id).join(',')}`);
  await s.put({}, { steps: ['s_omit'] });
  const del2 = await s.put({ steps: [...steps(), stepRow('s_admin2', 'c2', 'again')] });
  await s.put({}, { steps: ['s_admin2'] });
  check('ADMIN can delete by the envelope too', !steps().some((x) => x.id === 's_admin2'),
    'HTTP ' + del2.status);
}

/* ================================================================== BD ===== */
{
  const s = sessions.bd;
  const d = await s.read();
  const seen = (d.state.customers || []).map((c) => c.name);
  check('BD reads only the customers they are on', seen.length === 1 && /NusaTel/.test(seen[0]),
    seen.join(', ') || 'none');
  check('BD cannot see the other customer in the response', !/Kinabalu/.test(d.text));

  const put = await s.put({ steps: [...(d.state.steps || []), stepRow('s_bd', 'c1', 'BD wrote this')] });
  check('BD can write to their own customer', put.status === 200, 'HTTP ' + put.status);
  check('and it lands', steps().some((x) => x.id === 's_bd'));

  /* The one that would have shipped: an ordinary save of an ordinary edit,
     carrying the scoped view, must not be read as "delete everything else". */
  check('BD saving their own view does not erase the rest of the book',
    (disk().customers || []).length === 2 && /Kinabalu Water/.test(cust('c2').name),
    (disk().customers || []).length + ' customers left');
  check('and the other customer keeps its records',
    rows('interactions').some((m) => m.id === 'm1') && (disk().opps || {}).o2 !== undefined);

  const beforeC2 = JSON.stringify(cust('c2'));
  const beforeO2 = JSON.stringify((disk().opps || {}).o2);
  const out = await s.put({
    customers: [{ ...cust('c1') }, { id: 'c2', name: 'Renamed By BD', updatedAt: nowStamp() }],
    steps: [...(d.state.steps || []), stepRow('s_bd2', 'c2', 'BD wrote this too')],
    opps: { ...(d.state.opps || {}), o2: { id: 'o2', c: 'c2', name: 'Not your opp', updatedAt: nowStamp() } },
  });
  check('BD is not refused outright for an out-of-scope write (it is reverted, not 500)',
    out.status === 200, 'HTTP ' + out.status);
  check('the server says how much it took back', out.reverted > 0, out.reverted + ' reverted');
  check('BD cannot change a customer they are not on', JSON.stringify(cust('c2')) === beforeC2,
    cust('c2').name || '?');
  check('BD cannot change an opportunity on someone else\'s customer',
    JSON.stringify((disk().opps || {}).o2) === beforeO2);
  /* The back door: a row that is not on disk yet used to sail through, because
     there was nothing to scope it to. It names a customer, so it is in scope
     or it is nothing. */
  check('BD cannot hang a new record on a customer they are not on',
    !steps().some((x) => x.id === 's_bd2'));

  const ex = await s.req('/api/export?kind=customers');
  check('BD cannot export — the server refuses, not the layout', ex.status === 403, 'HTTP ' + ex.status);
  const u = await s.json('/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bd Pal', email: 'pal@example.com', role: 'bd', password: PASS }),
  });
  check('BD cannot create accounts', u.status === 403, 'HTTP ' + u.status);
  const promo = await s.put({ users: [{ ...(disk().users || [])[0], role: 'admin' }] });
  const me = (disk().users || []).find((x) => x.name === 'Ahmad Faiz');
  check('BD cannot promote themselves to administrator', me?.role === 'bd', me?.role || '?');
  void promo;
}

/* ================================================================== SA ===== */
{
  const s = sessions.sa;
  const d = await s.read();
  const seen = (d.state.customers || []).map((c) => c.name);
  check('SA reads only the customers they are on', seen.length === 1 && /Kinabalu/.test(seen[0]),
    seen.join(', ') || 'none');
  const put = await s.put({ steps: [...(d.state.steps || []), stepRow('s_sa', 'c2', 'SA wrote this')] });
  check('SA can write to their own customer', steps().some((x) => x.id === 's_sa'), 'HTTP ' + put.status);
  const beforeC1 = JSON.stringify(cust('c1'));
  await s.put({ customers: [{ id: 'c1', name: 'Renamed By SA', updatedAt: nowStamp() }] });
  check('SA cannot change a customer they are not on', JSON.stringify(cust('c1')) === beforeC1,
    cust('c1').name || '?');
  check('SA saving their own view does not erase the rest of the book',
    (disk().customers || []).length === 2 && /NusaTel/.test(cust('c1').name));
  const ex = await s.req('/api/export?kind=customers');
  check('SA cannot export', ex.status === 403, 'HTTP ' + ex.status);
}

/* ============================================================= MANAGER ===== */
{
  const s = sessions.manager;
  const d = await s.read();
  check('MANAGER can read the whole book', d.status === 200 && (d.state.customers || []).length === 2,
    (d.state.customers || []).length + ' customers');
  const before = JSON.stringify(steps());
  const beforeCustomers = JSON.stringify(disk().customers || []);
  const put = await s.put({ steps: [...steps(), stepRow('s_mgr', 'c1', 'Manager wrote this')] });
  check('MANAGER cannot write — refused by the server, not by a hidden button',
    put.status === 403, 'HTTP ' + put.status);
  check('and nothing reached the disk', JSON.stringify(steps()) === before);
  const del = await s.put({ customers: [] });
  check('MANAGER cannot delete the book by saving an empty view',
    JSON.stringify(disk().customers || []) === beforeCustomers, 'HTTP ' + del.status);
  const ex = await s.req('/api/export?kind=customers');
  check('MANAGER cannot export', ex.status === 403, 'HTTP ' + ex.status);
  const u = await s.json('/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Mgr Pal', email: 'mgrpal@example.com', role: 'bd', password: PASS }),
  });
  check('MANAGER cannot create accounts', u.status === 403, 'HTTP ' + u.status);
  const ai = await s.json('/api/ai/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'summarise the book' }),
  });
  check('MANAGER cannot ask the model', ai.status === 403, 'HTTP ' + ai.status);
  /* The same person, the other door. §17/§18: asking the copilot is reading,
     not writing — the raw prompt channel stays shut, but a task the server
     assembles from material the manager can already see is let through. */
  const task = await s.json('/api/ai/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'echo' }),
  });
  check('MANAGER can ask the copilot — asking is reading (§17)',
    task.status === 200 && task.ok === true, 'HTTP ' + task.status);
  const cfg = await s.json('/api/ai/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: 'https://example.invalid/v1', apiKey: 'sk-test' }),
  });
  check('MANAGER cannot change the model settings', cfg.status === 403, 'HTTP ' + cfg.status);
  const rst = await s.json('/api/reset', { method: 'POST' });
  check('MANAGER cannot clear the workspace', rst.status === 403, 'HTTP ' + rst.status);
}

/* ============================================================== VIEWER ===== */
{
  /* A viewer watches. Even asking spends tokens and surfaces data on a screen
     that role was never meant to work from — so every model door is shut. */
  const s = sessions.viewer;
  const t = await s.json('/api/ai/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'echo' }),
  });
  check('a viewer cannot ask the copilot', t.status === 403, 'HTTP ' + t.status);
  const c = await s.json('/api/ai/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'hello' }),
  });
  check('a viewer cannot reach the raw prompt channel', c.status === 403, 'HTTP ' + c.status);
}

/* ------------------------------------------------------- secrets stay in --- */
{
  const s = sessions.bd;
  const d = await s.read();
  const blob = d.text;
  check('no password hash reaches a colleague', !/"hash"\s*:\s*"[A-Za-z0-9+/]{8}/.test(blob));
  check('no salt reaches a colleague', !/"salt"\s*:\s*"[A-Za-z0-9+/]{8}/.test(blob));
  const a = await sessions.admin.read();
  check('no password hash reaches the administrator either', !/"hash"\s*:\s*"[A-Za-z0-9+/]{8}/.test(a.text));
}

srv.kill();
console.log(`\n${pass} passed, ${fail} failed  (${pass + fail} checks)`);
process.exit(fail ? 1 : 0);
