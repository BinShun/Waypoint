/**
 * Data-isolation guards for the Waypoint server.
 *
 * The other suites ask "does the server hold its guards". This one asks the
 * narrower, nastier question: can one colleague reach another colleague's
 * customer — by rewriting the record, by leaving it out of a save, by forging
 * the audit trail, or by signing in after being disabled.
 *
 * It runs against a throwaway workspace in a temp directory on a spare port,
 * so nothing here can touch real data.
 *
 * Usage: node scripts/verify-isolation.mjs
 */
import { spawn } from 'node:child_process';
import { claimPort } from './harness.mjs';
import crypto from 'node:crypto';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 8821);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = true;
let ran = 0;
const check = (name, cond, detail) => {
  ran++;
  if (!cond) pass = false;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${detail}` : ''}`);
};
const section = (name) => console.log(`\n=== ${name} ===`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function browser(base) {
  let cookie = '';
  return {
    async call(pathname, init = {}) {
      const headers = { ...(init.headers ?? {}) };
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(base + pathname, { ...init, headers });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let body = null;
      try { body = await res.json(); } catch { /* not json — a blob, usually */ }
      return { status: res.status, body, text: body === null ? await res.text().catch(() => '') : '' };
    },
  };
}

async function spawnServer(port, extraEnv = {}) {
  const log = [];
  const child = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
  env: { ...process.env, PORT: String(port), WB_TLS: '0', ...extraEnv },
  stdio: ['ignore', 'pipe', 'pipe'],
});
/* Wait for a port this process has PROVEN is free. Waiting on
   /api/health alone cannot fail when an old server is still listening,
   and the suite would then drive somebody else's server. See
   scripts/harness.mjs. */
await claimPort(port);
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  return { child, log };
}

async function waitUp(base, log, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await wait(150);
    try { if ((await fetch(`${base}/api/health`)).ok) return true; } catch { /* still booting */ }
  }
  console.log('server never came up:\n' + log.join(''));
  return false;
}

/* ------------------------------------------------------------- workspace */

const TMP = mkdtempSync(join(tmpdir(), 'cwb-iso-'));
const srv = await spawnServer(PORT, { WB_DATA_DIR: TMP });

const T0 = new Date().toISOString();
function makeCred(userId, password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 150_000, 32, 'sha256');
  return {
    userId, algo: 'pbkdf2-sha256', iterations: 150_000,
    salt: salt.toString('base64'), hash: hash.toString('base64'),
    createdAt: T0, updatedAt: T0,
  };
}

const SECRET = 'ZENITH CONFIDENTIAL — board pricing, do not share';

/* A Waypoint-shaped workspace: `customers` with no `accounts`, so scoping runs
   by owner name the way the real one does. Two customers on two different
   people, with a document on each. */
const seed = {
  schemaVersion: 1,
  setupComplete: true,
  users: [
    { id: 'u_a', name: 'Ada Admin', role: 'admin', createdAt: T0, updatedAt: T0 },
    { id: 'u_b', name: 'Bob BD', role: 'bd', createdAt: T0, updatedAt: T0 },
    { id: 'u_d', name: 'Dan Disabled', role: 'bd', active: false, createdAt: T0, updatedAt: T0 },
  ],
  credentials: {
    u_a: makeCred('u_a', 'admin-pass-1'),
    u_b: makeCred('u_b', 'bd-pass-1234'),
    u_d: makeCred('u_d', 'dan-pass-1234'),
  },
  customers: [
    { id: 'c_alice', name: 'Alice Bank', owner: 'Bob BD', createdAt: T0, updatedAt: T0 },
    { id: 'c_zen', name: 'Zenith Corp', owner: 'Ada Admin', createdAt: T0, updatedAt: T0 },
  ],
  files: [
    { id: 'f_alice', c: 'c_alice', n: 'alice.txt', k: 'doc', createdAt: T0, updatedAt: T0 },
    { id: 'f_zen', c: 'c_zen', n: 'secret.txt', k: 'doc', createdAt: T0, updatedAt: T0 },
  ],
  interactions: [
    { id: 'm_alice', c: 'c_alice', t: 'Kickoff', d: '2026-09-01', createdAt: T0, updatedAt: T0 },
    { id: 'm_zen', c: 'c_zen', t: 'Board', d: '2026-09-02', createdAt: T0, updatedAt: T0 },
  ],
  steps: [
    { id: 's_alice', c: 'c_alice', t: 'Send pricing', createdAt: T0, updatedAt: T0 },
    { id: 's_zen', c: 'c_zen', t: 'Sign the NDA', createdAt: T0, updatedAt: T0 },
  ],
  audit: [
    { id: 'a_1', d: '2026-09-01', who: 'Ada Admin', role: 'admin', k: 'data',
      what: 'Customer created', rec: 'Zenith Corp', from: '-', to: '-' },
  ],
  /* Neither of these is in the client's SYNC_LISTS / SYNC_MAPS — which is
     exactly why they were the two an ordinary administrator save kept emptying.
     They are here to be emptied again if the refill ever stops working. */
  logs: [
    { id: 'l_1', actorId: 'u_a', ts: T0, what: 'boot' },
    { id: 'l_2', actorId: 'u_b', ts: T0, what: 'sign in' },
  ],
  insights: { c_alice: { note: 'alice insight' }, c_zen: { note: 'zenith insight' } },
  opps: {
    o_alice: { id: 'o_alice', c: 'c_alice', t: 'Core migration', v: 100, stage: 'Scoping' },
    o_zen: { id: 'o_zen', c: 'c_zen', t: 'DR build', v: 200, stage: 'Scoping' },
  },
  watch: [],
  team: [],
  products: [],
};
writeFileSync(join(TMP, 'workbench.json'), JSON.stringify(seed));
writeFileSync(join(TMP, 'workbench.rev.json'), JSON.stringify({ rev: 1, savedAt: T0, bytes: 0 }));

const putState = (b, state, baseRev, deleted) => b.call('/api/data', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(deleted ? { state, baseRev, deleted } : { state, baseRev }),
});
const rows = (b) => b.call('/api/data');
const rowWith = (state, key, id) => (state?.[key] ?? []).find((r) => r && r.id === id);
const hasRow = (state, key, id) => !!rowWith(state, key, id);
const login = (b, userId, password) => b.call('/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId, password }),
});

try {
  if (!await waitUp(BASE, srv.log)) throw new Error('server never came up');

  const admin = browser(BASE);
  const bob = browser(BASE);

  section('three colleagues, one of whom has left');
  check('the administrator signs in', (await login(admin, 'u_a', 'admin-pass-1')).status === 200);
  check('the BD signs in', (await login(bob, 'u_b', 'bd-pass-1234')).status === 200);
  const dan = browser(BASE);
  const danIn = await login(dan, 'u_d', 'dan-pass-1234');
  check('a DISABLED colleague is refused even with the right password',
    danIn.status !== 200, `status=${danIn.status}`);
  const danRead = await rows(dan);
  check('and is refused the workspace too', danRead.status !== 200, `status=${danRead.status}`);

  section('a confidential document, and the wall around it');
  const up = await admin.call('/api/files', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'f_zen', data: 'data:text/plain;base64,' + Buffer.from(SECRET).toString('base64') }),
  });
  check('the administrator stores a document on their own customer', up.status === 200, `status=${up.status}`);
  const adminGet = await admin.call('/api/file?id=f_zen');
  check('the administrator can read it back', adminGet.status === 200, `status=${adminGet.status}`);
  const bobGet0 = await bob.call('/api/file?id=f_zen');
  check('the BD cannot, before trying anything clever', bobGet0.status !== 200, `status=${bobGet0.status}`);

  /* ------------------------------------------------------------------ N2 */
  section('rewriting whose customer a record belongs to (N2)');
  const bv = await rows(bob);
  check('the BD is scoped to one customer', !hasRow(bv.body.state, 'customers', 'c_zen'),
    `customers=${(bv.body.state.customers ?? []).map((c) => c.id).join(',')}`);
  /* The attack: take a row the BD cannot see, rename its customer to one they
     can, and let "the row you sent is in scope" do the rest. */
  const steal = await putState(bob, {
    ...bv.body.state,
    files: [...(bv.body.state.files ?? []), { id: 'f_zen', c: 'c_alice', n: 'stolen.txt', k: 'doc' }],
  }, bv.body.rev);
  check('the write itself is answered', steal.status === 200, `status=${steal.status}`);
  const bobGet1 = await bob.call('/api/file?id=f_zen');
  check('the document is STILL out of reach afterwards', bobGet1.status !== 200, `status=${bobGet1.status}`);
  const afterSteal = await rows(admin);
  check('and still belongs to the customer it always did',
    rowWith(afterSteal.body.state, 'files', 'f_zen')?.c === 'c_zen',
    `c=${rowWith(afterSteal.body.state, 'files', 'f_zen')?.c}`);
  check('with its own name, not the one the BD gave it',
    rowWith(afterSteal.body.state, 'files', 'f_zen')?.n === 'secret.txt',
    `n=${rowWith(afterSteal.body.state, 'files', 'f_zen')?.n}`);

  /* ------------------------------------------------------------------ N3 */
  section('the same trick with the customer simply left off (N3)');
  const bv2 = await rows(bob);
  const blank = await putState(bob, {
    ...bv2.body.state,
    files: [...(bv2.body.state.files ?? []), { id: 'f_zen', n: 'rewritten.txt', k: 'doc' }],
  }, bv2.body.rev);
  check('the write is answered', blank.status === 200, `status=${blank.status}`);
  const afterBlank = await rows(admin);
  check('a row with no customer named is not a row anybody may rewrite',
    rowWith(afterBlank.body.state, 'files', 'f_zen')?.n === 'secret.txt',
    `n=${rowWith(afterBlank.body.state, 'files', 'f_zen')?.n}`);

  section('the same wall holds for the other collections');
  const bv3 = await rows(bob);
  const grabAll = await putState(bob, {
    ...bv3.body.state,
    interactions: [...(bv3.body.state.interactions ?? []), { id: 'm_zen', c: 'c_alice', t: 'stolen interaction' }],
    steps: [...(bv3.body.state.steps ?? []), { id: 's_zen', c: 'c_alice', t: 'stolen step' }],
    opps: { ...(bv3.body.state.opps ?? {}), o_zen: { id: 'o_zen', c: 'c_alice', t: 'stolen deal', v: 999 } },
  }, bv3.body.rev);
  check('the write is answered', grabAll.status === 200, `status=${grabAll.status}`);
  const afterGrab = await rows(admin);
  check('the meeting stayed on its own customer',
    rowWith(afterGrab.body.state, 'interactions', 'm_zen')?.c === 'c_zen',
    `c=${rowWith(afterGrab.body.state, 'interactions', 'm_zen')?.c}`);
  check('the next step stayed on its own customer',
    rowWith(afterGrab.body.state, 'steps', 's_zen')?.c === 'c_zen',
    `c=${rowWith(afterGrab.body.state, 'steps', 's_zen')?.c}`);
  check('the money did not move',
    afterGrab.body.state.opps?.o_zen?.c === 'c_zen' && afterGrab.body.state.opps?.o_zen?.v === 200,
    `c=${afterGrab.body.state.opps?.o_zen?.c} v=${afterGrab.body.state.opps?.o_zen?.v}`);

  /* ------------------------------------------------------------------ N1 */
  section('a payload that says almost nothing cannot empty the workspace (N1)');
  const av = await rows(admin);
  /* `schemaVersion` is here because the page always sends it: a payload without
     it is refused by `validate` before authorisation ever runs, so leaving it
     out would test the wrong guard. */
  const wipe = await putState(admin, { schemaVersion: 1, customers: [] }, av.body.rev);
  check('the minimal write is answered', wipe.status === 200, `status=${wipe.status} ${wipe.body?.error ?? ''}`);
  const afterWipe = await rows(admin);
  const w = afterWipe.body.state;
  check('the customers came back', (w.customers ?? []).length === 2, `customers=${(w.customers ?? []).length}`);
  check('the documents came back', (w.files ?? []).length === 2, `files=${(w.files ?? []).length}`);
  check('the interactions came back', (w.interactions ?? []).length === 2, `interactions=${(w.interactions ?? []).length}`);
  check('the next steps came back', (w.steps ?? []).length === 2, `steps=${(w.steps ?? []).length}`);
  check('the audit trail came back', (w.audit ?? []).length >= 1, `audit=${(w.audit ?? []).length}`);
  check('the opportunities came back', Object.keys(w.opps ?? {}).length === 2, `opps=${Object.keys(w.opps ?? {}).length}`);

  section('an ordinary save does not eat what the client never sends (N1)');
  /* The page syncs some collections and not others. A save carrying the ones
     it does sync used to be read as "delete everything else" — for the
     administrator, the one role whose client syncs the fewest. */
  const av2 = await rows(admin);
  const { logs, insights, ...synced } = av2.body.state;
  const ordinary = await putState(admin, synced, av2.body.rev);
  check('the save is answered', ordinary.status === 200, `status=${ordinary.status}`);
  const afterOrdinary = await rows(admin);
  check('the activity log survived an ordinary save',
    (afterOrdinary.body.state.logs ?? []).length === 2, `logs=${(afterOrdinary.body.state.logs ?? []).length}`);
  check('the insights map survived an ordinary save',
    Object.keys(afterOrdinary.body.state.insights ?? {}).length === 2,
    `insights=${Object.keys(afterOrdinary.body.state.insights ?? {}).length}`);

  /* ------------------------------------------------------------------ N4 */
  section('the audit trail is stamped by the session, not by the client (N4)');
  const bv4 = await rows(bob);
  const forge = await putState(bob, {
    ...bv4.body.state,
    audit: [{ id: 'a_forged', d: '2026-09-01', who: 'Ada Admin', role: 'admin', k: 'data',
      what: 'Customer deleted', rec: 'Alice Bank', from: '-', to: '-' }],
  }, bv4.body.rev);
  check('the write is answered', forge.status === 200, `status=${forge.status}`);
  const afterForge = await rows(admin);
  const forged = rowWith(afterForge.body.state, 'audit', 'a_forged');
  check('the forged row landed', !!forged, `found=${!!forged}`);
  check('but it names the person who actually sent it', forged?.who === 'Bob BD', `who=${forged?.who}`);
  check('and their real role, not the one they claimed', forged?.role === 'bd', `role=${forged?.role}`);
  check('the words are still the ones they typed', forged?.what === 'Customer deleted', `what=${forged?.what}`);

  const bv5 = await rows(bob);
  const tamper = await putState(bob, {
    ...bv5.body.state,
    audit: (bv5.body.state.audit ?? []).map((a) => (a.id === 'a_1' ? { ...a, what: 'I was never here' } : a)),
  }, bv5.body.rev);
  check('the write is answered', tamper.status === 200, `status=${tamper.status}`);
  const afterTamper = await rows(admin);
  check('history already written cannot be rewritten',
    rowWith(afterTamper.body.state, 'audit', 'a_1')?.what === 'Customer created',
    `what=${rowWith(afterTamper.body.state, 'audit', 'a_1')?.what}`);

  /* ------------------------------------------------------- delete is named */
  section('removing a row is an act, not a silence');
  const av3 = await rows(admin);
  const omitted = await putState(admin, {
    ...av3.body.state,
    customers: (av3.body.state.customers ?? []).filter((c) => c.id !== 'c_zen'),
  }, av3.body.rev);
  check('the write is answered', omitted.status === 200, `status=${omitted.status}`);
  const afterOmit = await rows(admin);
  check('leaving a row out is not a delete — it comes back',
    hasRow(afterOmit.body.state, 'customers', 'c_zen'),
    `customers=${(afterOmit.body.state.customers ?? []).map((c) => c.id).join(',')}`);

  const av4 = await rows(admin);
  /* Everything on the customer is named with it, the way the page does it: a
     customer may not be deleted out from under its own interactions — or,
     since the orphan-opportunity rule, out from under its own opportunities,
     which deleteCustomerNow clears alongside the rest. A test that named
     only the customer would be testing those guards instead of this one. */
  const named = await putState(admin, {
    ...av4.body.state,
    customers: (av4.body.state.customers ?? []).filter((c) => c.id !== 'c_zen'),
    interactions: (av4.body.state.interactions ?? []).filter((m) => m.c !== 'c_zen'),
    steps: (av4.body.state.steps ?? []).filter((s) => s.c !== 'c_zen'),
    files: (av4.body.state.files ?? []).filter((f) => f.c !== 'c_zen'),
    opps: Object.fromEntries(Object.entries(av4.body.state.opps ?? {}).filter(([, o]) => o.c !== 'c_zen')),
  }, av4.body.rev, { customers: ['c_zen'], interactions: ['m_zen'], steps: ['s_zen'], files: ['f_zen'], opps: ['o_zen'] });
  check('the named delete is answered', named.status === 200, `status=${named.status} ${named.body?.error ?? ''}`);
  const afterNamed = await rows(admin);
  check('naming it under the envelope still removes it',
    !hasRow(afterNamed.body.state, 'customers', 'c_zen'),
    `customers=${(afterNamed.body.state.customers ?? []).map((c) => c.id).join(',')}`);

  const bv6 = await rows(bob);
  const bobDel = await putState(bob, {
    ...bv6.body.state,
    customers: (bv6.body.state.customers ?? []).filter((c) => c.id !== 'c_alice'),
  }, bv6.body.rev, { customers: ['c_alice'] });
  check('the BD\'s delete is answered', bobDel.status === 200, `status=${bobDel.status}`);
  const afterBobDel = await rows(admin);
  check('but destroying is still the administrator\'s alone',
    hasRow(afterBobDel.body.state, 'customers', 'c_alice'),
    `customers=${(afterBobDel.body.state.customers ?? []).map((c) => c.id).join(',')}`);
} catch (e) {
  pass = false;
  console.log('\n!! harness error:', e.message);
  console.log(e.stack);
} finally {
  srv.child.kill('SIGTERM');
  await wait(200);
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* temp dir */ }
}

console.log(`\n${ran} checks run.`);
console.log(pass ? '\nRESULT: PASS - the book stays inside its own covers\n' : '\nRESULT: FAIL\n');
process.exit(pass ? 0 : 1);
