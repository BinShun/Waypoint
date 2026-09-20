/**
 * Prove the roster survives a save that does not carry one.
 *
 * Waypoint keeps its own `team` and never sends `users`. On a REPLACE the
 * payload IS the truth, so an absent `users` key means "delete everybody" —
 * one ordinary save would sign the whole team out and report success. This
 * reproduces exactly that save and asserts the roster is still there.
 *
 * Run from customer-workbench/:  node scripts/verify-roster.mjs
 */
import { spawn } from 'node:child_process';
import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { claimPort } from './harness.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkspaceFile } from './disk.mjs';

const PORT = Number(process.env.ROSTER_PORT || 8850);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'wb-roster-'));

const p = spawn(process.execPath, ['server/server.mjs'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', WB_DATA_DIR: dir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
/* Wait for a port this process has PROVEN is free. Waiting on
   /api/health alone cannot fail when an old server is still listening,
   and the suite would then drive somebody else's server. See
   scripts/harness.mjs. */
await claimPort(PORT);
let log = '';
p.stdout.on('data', (d) => { log += d; });
p.stderr.on('data', (d) => { log += d; });

let up = false;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { up = true; break; } } catch { /* not yet */ }
  await wait(120);
}
if (!up) { console.log('server did not start\n' + log); p.kill(); process.exit(1); }

let pass = true;
let ran = 0;
const check = (name, cond, detail) => {
  ran++;
  if (!cond) pass = false;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + detail : ''}`);
};

try {
  const seed = { schemaVersion: 1, users: [{ id: 'u1', name: 'Teh Bin Shun', role: 'admin' }], customers: [] };
  let r = await fetch(`http://127.0.0.1:${PORT}/api/data`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(seed),
  });
  const first = await r.json();
  const rev = first.rev;

  /* A Waypoint save: every Waypoint collection, and no roster at all. */
  const wp = { schemaVersion: 1, customers: [{ id: 'c1', name: 'NusaTel', updatedAt: new Date().toISOString() }] };
  r = await fetch(`http://127.0.0.1:${PORT}/api/data`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Base-Rev': String(rev) },
    body: JSON.stringify({ state: wp, baseRev: rev }),
  });
  const saved = await r.json();
  const after = readWorkspaceFile(join(dir, 'workbench.json'));
  const users = after.users || [];

  check('the roster survives a save that carries no users', users.length === 1,
    `users=${users.length} mode=${saved.mode}`);
  check('and the customer still landed', (after.customers || []).length === 1,
    `customers=${(after.customers || []).length}`);
} finally {
  p.kill();
  rmSync(dir, { recursive: true, force: true });
}

/* ==========================================================================
   THE ROSTER DOES NOT GROW A COPY OF ITSELF ON EVERY SAVE
   ==========================================================================
   The roster is the one list whose rows have no `id` — a roster row IS a
   person's name, and the page calls it `n`. `mergeList` matches rows by `id`,
   and an unidentifiable row is one it cannot match, so it APPENDED: every save
   by every signed-in member doubled the team, four colleagues became eight,
   and the pickers drawn from it offered everybody twice. It was invisible for
   as long as the suites that save happened to run against a book with no
   roster in it.

   A second server, because this half needs an actual signed-in member: on the
   open copy the caller has no account, and the code deliberately trusts the
   person at the keyboard with their own roster. */
{
  const dir2 = mkdtempSync(join(tmpdir(), 'wb-roster2-'));
  const PORT2 = Number(process.env.ROSTER2_PORT || 8859);
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  const p2 = spawn(process.execPath, ['server/server.mjs'], {
    env: { ...process.env, PORT: String(PORT2), HOST: '127.0.0.1', WB_DATA_DIR: dir2, WB_TLS: '0', WB_DATA_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await claimPort(PORT2);
    let up2 = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(BASE2 + '/api/health')).ok) { up2 = true; break; } } catch { /* not yet */ }
      await wait(120);
    }
    if (!up2) throw new Error('the second server did not start');

    const PASSWORD = process.env.WP_PASS || 'Waypoint#2026';
    const salt = randomBytes(16);
    const at = new Date().toISOString();
    const ROSTER = [
      { n: 'Teh Bin Shun', r: 'Senior SA', f: 'SA', role: 'admin', last: '—', st: 'Active' },
      { n: 'Ahmad Faiz', r: 'Account Manager', f: 'BD', role: 'bd', last: '—', st: 'Active' },
      { n: 'John Teh', r: 'Solution Architect', f: 'SA', role: 'sa', last: '—', st: 'Active' },
    ];
    writeFileSync(join(dir2, 'workbench.json'), JSON.stringify({
      schemaVersion: 1, setupComplete: true,
      users: [
        { id: 'u_admin', name: 'Teh Bin Shun', role: 'admin', createdAt: at, updatedAt: at },
        { id: 'u_bd', name: 'Ahmad Faiz', role: 'bd', createdAt: at, updatedAt: at },
      ],
      credentials: {
        u_admin: { userId: 'u_admin', algo: 'pbkdf2-sha256', iterations: 150_000,
          salt: salt.toString('base64'),
          hash: pbkdf2Sync(PASSWORD, salt, 150_000, 32, 'sha256').toString('base64'),
          createdAt: at, updatedAt: at },
        u_bd: { userId: 'u_bd', algo: 'pbkdf2-sha256', iterations: 150_000,
          salt: salt.toString('base64'),
          hash: pbkdf2Sync(PASSWORD, salt, 150_000, 32, 'sha256').toString('base64'),
          createdAt: at, updatedAt: at },
      },
      team: ROSTER,
      customers: [{ id: 'c1', name: 'Sunrise Retail Group', owner: 'Ahmad Faiz', team: [], createdAt: at, updatedAt: at }],
      files: [], interactions: [], steps: [], audit: [], watch: [], products: [], insights: {}, opps: {}, logs: [],
    }));

    let jar = '';
    const api = async (path, opts = {}) => {
      const res = await fetch(BASE2 + path, {
        ...opts,
        headers: { ...(opts.headers || {}), 'Content-Type': 'application/json', ...(jar ? { Cookie: jar } : {}) },
      });
      const sc = res.headers.get('set-cookie');
      if (sc) jar = sc.split(';')[0];
      let body = null;
      try { body = await res.json(); } catch { /* empty */ }
      return { status: res.status, body };
    };

    const li = await api('/api/login', {
      method: 'POST', body: JSON.stringify({ userId: 'u_bd', password: PASSWORD }),
    });
    check('a member signs in to the roster server', li.status === 200, `HTTP ${li.status}`);

    const got = await api('/api/data');
    check('and is given the roster', (got.body?.state?.team || []).length === 3,
      `rows=${(got.body?.state?.team || []).length}`);

    /* The save the product actually makes: the client re-sends everything it
       was given, including the roster, with the customer edit that was the
       point of the save. */
    const st = JSON.parse(JSON.stringify(got.body.state));
    st.customers[0].team = ['John Teh'];
    const put = await api('/api/data', {
      method: 'PUT', body: JSON.stringify({ state: st, baseRev: got.body?.rev ?? 0 }),
    });
    check('the member\u2019s save is accepted', put.status === 200, `HTTP ${put.status}`);

    const diskAfter = readWorkspaceFile(join(dir2, 'workbench.json'));
    check('the roster did not grow a second copy of everybody',
      (diskAfter.team || []).length === 3, `rows=${(diskAfter.team || []).length}`);
    check('and it still names exactly the three people it named before',
      (diskAfter.team || []).map((r) => r.n).sort().join(',') === 'Ahmad Faiz,John Teh,Teh Bin Shun',
      (diskAfter.team || []).map((r) => r.n).join(','));
    check('the customer edit the save was actually for did land',
      (diskAfter.customers?.[0]?.team || []).includes('John Teh'),
      JSON.stringify(diskAfter.customers?.[0]?.team || []));

    /* Twice, because a bug that doubles once doubles again, and a single save
       cannot tell "kept" from "coincidentally equal". */
    const again = await api('/api/data');
    const st2 = JSON.parse(JSON.stringify(again.body.state));
    st2.customers[0].industry = 'Retail';
    await api('/api/data', { method: 'PUT', body: JSON.stringify({ state: st2, baseRev: again.body?.rev ?? 0 }) });
    const disk3 = readWorkspaceFile(join(dir2, 'workbench.json'));
    check('a second save does not double it either',
      (disk3.team || []).length === 3, `rows=${(disk3.team || []).length}`);

    /* A member rewriting somebody else's row is still refused — the guard this
       suite was widened for must not have been loosened to stop the doubling. */
    const third = await api('/api/data');
    const st3 = JSON.parse(JSON.stringify(third.body.state));
    const victim = st3.team.find((r) => r.n === 'Teh Bin Shun');
    if (victim) {
      victim.r = 'Intern';
      await api('/api/data', { method: 'PUT', body: JSON.stringify({ state: st3, baseRev: third.body?.rev ?? 0 }) });
      const disk4 = readWorkspaceFile(join(dir2, 'workbench.json'));
      check('a member still cannot rewrite a colleague\u2019s roster row',
        (disk4.team || []).find((r) => r.n === 'Teh Bin Shun')?.r === 'Senior SA',
        (disk4.team || []).find((r) => r.n === 'Teh Bin Shun')?.r);
    }

    /* The id'd and the nameless spellings of one person are ONE row — the
       doubling this suite was widened for a second time. The page mints a
       roster id from the name (`te_…`); the book can hold the same person
       with no id at all; to the merge those were two different people, both
       were kept, and every save re-added one of each until a scenario run
       left a 96 MB book behind it. An administrator's save carries both
       spellings — twice each — and must land one row per person, the id'd
       one. This half needs the administrator: only their save reaches the
       merge at all, a member's roster is reverted wholesale above. */
    jar = '';
    const li2 = await api('/api/login', {
      method: 'POST', body: JSON.stringify({ userId: 'u_admin', password: PASSWORD }),
    });
    check('the administrator signs in to the same server', li2.status === 200, `HTTP ${li2.status}`);

    const twin = (n) => ({ n, r: 'Senior SA', f: 'SA', role: 'admin', last: '—', st: 'Active' });
    const ided = { ...twin('Teh Bin Shun'), id: 'te_teh-bin-shun' };
    const admGot = await api('/api/data');
    const admState = JSON.parse(JSON.stringify(admGot.body.state));
    admState.team = [ided, twin('Teh Bin Shun'), ided, twin('Ahmad Faiz'), twin('Ahmad Faiz'), twin('John Teh')];
    const twinPut = await api('/api/data', {
      method: 'PUT', body: JSON.stringify({ state: admState, baseRev: admGot.body?.rev ?? 0 }),
    });
    check('the administrator\u2019s save with twin spellings is accepted', twinPut.status === 200,
      `HTTP ${twinPut.status}`);
    const disk5 = readWorkspaceFile(join(dir2, 'workbench.json'));
    const team5 = disk5.team || [];
    check('both spellings of one person land as one row', team5.length === 3,
      `rows=${team5.length} (${team5.map((r) => r.n).join(',')})`);
    check('and the person sent in both spellings keeps the id\u2019d one',
      (team5.find((r) => r.n === 'Teh Bin Shun') || {}).id === 'te_teh-bin-shun',
      team5.map((r) => `${r.n}:${r.id}`).join(','));

    /* The same twins through the MERGE path: a stale base revision takes the
       payload through mergeList, where a row sent twice used to be kept
       twice and re-kept on every save after that. */
    const stalePut = await api('/api/data', {
      method: 'PUT', body: JSON.stringify({ state: admState, baseRev: admGot.body?.rev ?? 0 }),
    });
    check('the stale save is answered with the merged truth', stalePut.status === 200,
      `HTTP ${stalePut.status}`);
    const disk6 = readWorkspaceFile(join(dir2, 'workbench.json'));
    check('the twins through the merge still leave one row each', (disk6.team || []).length === 3,
      `rows=${(disk6.team || []).length}`);
  } finally {
    p2.kill();
    rmSync(dir2, { recursive: true, force: true });
  }
}

console.log(`\n${ran} checks, ${pass ? 'all PASS' : 'FAILURES above'}  (${ran} checks)`);console.log(`RESULT: ${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
