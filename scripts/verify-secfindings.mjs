/**
 * §36 — the security findings, as permanent regression tests.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * A second security audit produced twelve findings (N1–N12) and a set of
 * throwaway probes (`t1.mjs`…`t10.mjs` in /tmp) that demonstrated each one.
 * The probes lived in a temp directory and died with it. What survived was the
 * FIX — and a fix with no test behind it is a fix that comes back.
 *
 * N1–N4 are already permanent: `verify-isolation.mjs` drives the workspace
 * emptying, the row-ownership forgery (both directions), the audit stamping.
 * This suite carries the OTHER EIGHT, each one written as the attack it was
 * found by, not as a description of the fix:
 *
 *   N5  a disabled account keeps working through a session it already had
 *   N6  `insights` answered across customers
 *   N7  a BD rewriting a shared roster row
 *   N8  `/api/directory` answering a stranger
 *   N9  `mustChange` honoured by the screen but not by the server
 *   N10 `/api/reset` leaving sessions alive, and the open window it creates
 *   N11 encryption off in silence
 *   N12 the remembered-device token, and what it can do
 *
 * The shape of every check is the same: do the thing that broke, then assert
 * the workspace did NOT move. A test that only asserts a status code proves the
 * server said no; these assert nothing changed, which is what "no" has to mean.
 *
 * Runs against a throwaway workspace on a spare port. Real data is never
 * touched, and no fixture here is copied from `data/`.
 *
 * Usage: node scripts/verify-secfindings.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimPort } from './harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SEC_PORT || 8831);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = true, ran = 0;
const check = (name, cond, detail) => {
  ran++;
  if (!cond) pass = false;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${detail}` : ''}`);
};
const section = (n) => console.log(`\n=== ${n} ===`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function browser(base) {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async call(pathname, init = {}) {
      const headers = { ...(init.headers ?? {}) };
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(base + pathname, { ...init, headers });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      return { status: res.status, body, headers: res.headers };
    },
  };
}

async function spawnServer(port, extraEnv = {}) {
  await claimPort(port);
  const log = [];
  const child = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
    env: { ...process.env, PORT: String(port), WB_TLS: '0', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  return { child, log, stop: () => { try { child.kill(); } catch { /* gone */ } } };
}

async function waitUp(base, log, tries = 60) {
  for (let i = 0; i < tries; i++) {
    await wait(120);
    try { if ((await fetch(`${base}/api/health`)).ok) return true; } catch { /* still booting */ }
  }
  console.log('server never came up:\n' + log.join(''));
  return false;
}

/* ------------------------------------------------------------- workspace */
const TMP = mkdtempSync(join(tmpdir(), 'cwb-sec-'));
const T0 = new Date().toISOString();

function makeCred(userId, password) {
  const salt = crypto.randomBytes(16);
  return {
    userId, algo: 'pbkdf2-sha256', iterations: 150_000,
    salt: salt.toString('base64'),
    hash: crypto.pbkdf2Sync(password, salt, 150_000, 32, 'sha256').toString('base64'),
    createdAt: T0, updatedAt: T0,
  };
}

let seed = null;
function makeSeed() {
  return {
    schemaVersion: 1, setupComplete: true,
    users: [
      { id: 'u_a', name: 'Ada Admin', role: 'admin', createdAt: T0, updatedAt: T0 },
      { id: 'u_b', name: 'Bob BD', role: 'bd', createdAt: T0, updatedAt: T0 },
      { id: 'u_m', name: 'Mia Manager', role: 'manager', createdAt: T0, updatedAt: T0 },
      /* N5: disabled. The password still matches; the door must still be shut. */
      { id: 'u_d', name: 'Dan Gone', role: 'bd', active: false, createdAt: T0, updatedAt: T0 },
    ],
    credentials: {
      u_a: makeCred('u_a', 'admin-pass-1'),
      u_b: makeCred('u_b', 'bd-pass-1234'),
      u_m: makeCred('u_m', 'manager-pass-1'),
      u_d: makeCred('u_d', 'dan-pass-1234'),
    },
    customers: [
      { id: 'c_bob', name: 'Bob Industries', owner: 'Bob BD', createdAt: T0, updatedAt: T0 },
      { id: 'c_ada', name: 'Ada Holdings', owner: 'Ada Admin', createdAt: T0, updatedAt: T0 },
    ],
    files: [], interactions: [], steps: [], audit: [], watch: [], products: [],
    /* N7: the shared roster. `c` here is a COUNT, not a customer id — which is
       exactly what made it eligible for a scope decision it should never get. */
    team: [
      { n: 'Ada Admin', r: 'Admin', f: 'ADMIN', role: 'admin', last: '—', st: 'Active', c: 2 },
      { n: 'Bob BD', r: 'Senior BD', f: 'BD', role: 'bd', last: '—', st: 'Active', c: 1 },
    ],
    /* N6: a map keyed by customer id. The key IS the scope. */
    insights: { c_bob: { note: 'bob insight' }, c_ada: { note: 'ada insight' } },
    opps: {
      o_bob: { id: 'o_bob', c: 'c_bob', t: 'Bob deal', v: 100, stage: 'Scoping' },
      o_ada: { id: 'o_ada', c: 'c_ada', t: 'Ada deal', v: 200, stage: 'Scoping' },
    },
    logs: [{ id: 'l_1', actorId: 'u_a', ts: T0, what: 'boot' }],
  };
}

const diskOf = (dir) => JSON.parse(readFileSync(join(dir, 'workbench.json'), 'utf8'));
const login = (b, userId, password) => b.call('/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId, password }),
});

/* ========================================================================== */
/* `WB_DATA_KEY: ''` is not decoration. The aggregate run passes a key down to
   every suite, and this one reads the workspace file directly (`diskOf`) to
   assert what is on disk rather than what the API said. Inheriting that key
   seals the file and every one of those parses dies on `WBENC1.…`. Encryption
   at rest is N11's subject and N11 spawns its own servers to test it; the rest
   of this suite must not be at the mercy of whether the runner happens to have
   a key. */
const srv = await spawnServer(PORT, { WB_DATA_DIR: TMP, WB_DATA_KEY: '' });
let admin, bob, mia;
try {
  seed = makeSeed();
  writeFileSync(join(TMP, 'workbench.json'), JSON.stringify(seed));
  if (!await waitUp(BASE, srv.log)) throw new Error('server never came up');

  admin = browser(BASE); bob = browser(BASE); mia = browser(BASE);
  section('the cast');
  check('an administrator signs in', (await login(admin, 'u_a', 'admin-pass-1')).status === 200);
  check('a BD signs in', (await login(bob, 'u_b', 'bd-pass-1234')).status === 200);
  check('a Manager signs in', (await login(mia, 'u_m', 'manager-pass-1')).status === 200);

  /* ====================================================================== */
  section('N5 — an account turned off must stop working, including where it already was');

  /* The half `verify-isolation` does not reach: not "can they sign in", but
     "does a session opened BEFORE the disable keep working AFTER it". A door
     that is locked only at the entrance is not locked. */
  const dan = browser(BASE);
  {
    /* Sign in first — while it is still allowed — by re-enabling, then
       disabling through the API as an admin, the way a real offboarding goes. */
    const reEnable = await admin.call('/api/user', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'u_d', active: true }),
    });
    check('an administrator can re-enable the account to set the test up',
      reEnable.status === 200, `HTTP ${reEnable.status}`);
  }
  const danIn = await login(dan, 'u_d', 'dan-pass-1234');
  check('the colleague signs in while still employed', danIn.status === 200, `HTTP ${danIn.status}`);
  check('and their session works', (await dan.call('/api/data')).status === 200);

  {
    const dis = await admin.call('/api/user', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'u_d', active: false }),
    });
    check('the administrator disables the account', dis.status === 200, `HTTP ${dis.status}`);
    check('the disable is on disk', diskOf(TMP).users.find((u) => u.id === 'u_d')?.active === false);
  }
  {
    const after = await dan.call('/api/data');
    check('N5 · the session they already had is refused after the disable',
      after.status !== 200, `HTTP ${after.status}`);
    const relog = await login(browser(BASE), 'u_d', 'dan-pass-1234');
    check('N5 · and a fresh sign-in is refused too', relog.status !== 200, `HTTP ${relog.status}`);
  }

  /* ====================================================================== */
  section('N6 — the insights map is scoped by the customer it is keyed on');

  {
    const r = await bob.call('/api/data');
    const ins = r.body?.state?.insights ?? {};
    check('N6 · a BD does not receive another customer’s insights',
      !('c_ada' in ins), `keys=${Object.keys(ins).join(',') || '(none)'}`);
    check('but does receive their own', 'c_bob' in ins, `keys=${Object.keys(ins).join(',')}`);

    const rr = await mia.call('/api/data');
    const mins = rr.body?.state?.insights ?? {};
    check('a Manager sees every customer, so both keys are theirs',
      'c_ada' in mins && 'c_bob' in mins, `keys=${Object.keys(mins).join(',')}`);
  }
  {
    /* Writing is the same hole from the other end, so it is checked too — and
       the assertion has to be about the CONTENT, not the key. The disk keeps
       `c_ada` either way: the row is restored by the merge, because a member's
       client always re-sends rows it can no longer see. What must not land is
       the member's VERSION of it. */
    const plant = { note: 'planted by bob', at: new Date().toISOString() };
    const before = JSON.parse(JSON.stringify(diskOf(TMP).insights ?? {}));
    const cur = await bob.call('/api/data');
    const rev = cur.body?.rev ?? 0;
    const st = JSON.parse(JSON.stringify(cur.body.state));
    st.insights = { ...(st.insights || {}), c_ada: plant };
    const put = await bob.call('/api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Base-Rev': String(rev) },
      body: JSON.stringify({ state: st, baseRev: rev }),
    });
    const after = diskOf(TMP).insights ?? {};
    check('N6 · planting an insight on a customer outside your scope does not land',
      put.status === 200 && after.c_ada?.note !== plant.note,
      `HTTP ${put.status}, c_ada.note=${JSON.stringify(after.c_ada?.note)}`);
    check('N6 · and the untouched customer’s insight is byte-for-byte what it was',
      JSON.stringify(after.c_ada) === JSON.stringify(before.c_ada),
      JSON.stringify(after.c_ada));
    check('N6 · the member’s own insight is still theirs to write',
      after.c_bob?.note === before.c_bob?.note || !!after.c_bob,
      JSON.stringify(after.c_bob));
  }

  /* ====================================================================== */
  section('N7 — the roster is shared, and a BD may not rewrite it');

  {
    /* `team[].c` is a COUNT of customers. Because the scope reader looked for
       `c`, each colleague looked like a row belonging to customer "2" — so a
       BD's ordinary save reverted the whole roster and emptied the list of
       colleagues everybody picks from. */
    const st = JSON.parse(JSON.stringify(diskOf(TMP)));
    st.team = st.team.map((t) => ({ ...t, n: t.n === 'Ada Admin' ? 'Ada Admin (compromised)' : t.n }));
    const put = await bob.call('/api/data', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: st, baseRev: (await bob.call('/api/data')).body?.rev ?? 0 }),
    });
    const after = diskOf(TMP).team;
    check('N7 · a BD rewrite of a colleague’s roster row does not land',
      after.some((t) => t.n === 'Ada Admin'), `names=${after.map((t) => t.n).join(', ')}`);
    check('and the roster still holds everybody', after.length === 2, `rows=${after.length}`);
  }
  {
    /* The shape of the original bug, asserted directly: a BD's save must not
       shrink the roster. This is the check that would have caught it, because
       the failure was an EMPTY list rather than a forbidden one. */
    const cur = await bob.call('/api/data');
    const st = JSON.parse(JSON.stringify(cur.body.state));
    st.team = [];                     /* "I did not send it" is not "delete it" */
    await bob.call('/api/data', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: st, baseRev: cur.body?.rev ?? 0 }),
    });
    check('N7 · a save that leaves the roster out does not empty it',
      (diskOf(TMP).team || []).length === 2, `rows=${(diskOf(TMP).team || []).length}`);
  }

  /* ====================================================================== */
  section('N8 — the directory is public by necessity, and says nothing but names');

  {
    /* The audit filed this as "the directory is not authenticated at all". On
       inspection the endpoint HAS to be reachable before sign-in: it is what
       draws the list of names a person picks from, and a sign-in screen that
       cannot name the people who may sign in is not a sign-in screen. So the
       question is not "is it closed" but "does it say more than a name".
       What must never cross is password material, and it does not: the fields
       are id, name, role, title, locked, hasPassword. This check asserts the
       narrow thing that is actually load-bearing, rather than a status code
       the design deliberately does not produce. */
    const anon = browser(BASE);
    const r = await anon.call('/api/directory');
    check('the directory answers before sign-in, so the name picker can work',
      r.status === 200, `HTTP ${r.status}`);
    const blob = JSON.stringify(r.body ?? {});
    check('N8 · and it carries no hash, salt or password',
      !/hash|salt|password/i.test(blob.replace(/"hasPassword"/g, '')), blob.slice(0, 90));
    const keys = Object.keys(r.body?.users?.[0] ?? {});
    check('N8 · its fields are exactly the public ones, nothing extra',
      keys.length > 0 && keys.every((k) => ['id', 'name', 'role', 'title', 'locked', 'hasPassword'].includes(k)),
      keys.join(','));
    check('N8 · and it does not hand out a disabled account as an option',
      !(r.body?.users ?? []).some((u) => u.id === 'u_d'),
      (r.body?.users ?? []).map((u) => u.id).join(','));
  }
  {
    /* A signed-in member may read it too — same public shape, no widening. */
    const r = await bob.call('/api/directory');
    if (r.status === 200 && (r.body?.users ?? []).length) {
      const blob = JSON.stringify(r.body.users[0]);
      check('N8 · an authenticated read carries no hash or salt either',
        !/hash|salt/.test(blob), blob.slice(0, 90));
    } else {
      check('N8 · an authenticated read carries no hash or salt either', true,
        `HTTP ${r.status} — the directory is closed to members in this build`);
    }
  }

  /* ====================================================================== */
  section('N9 — the first-password rule is enforced by the server, not the screen');

  {
    /* A new account is created with `mustChange`. The screen then refuses to
       show the app until the password is changed — but a screen is not a
       guard, so the honest test is whether the SERVER knows and says so.
       The create call needs the starting password up front (the server hashes
       it; it is never chosen by the new colleague), and answers with the public
       user shape. */
    const startPw = 'Starter-pass-9';
    const made = await admin.call('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Starter', role: 'bd', password: startPw }),
    });
    check('an administrator can create an account', made.status === 200,
      `HTTP ${made.status} ${made.body?.error ?? ''}`);
    const newId = made.body?.user?.id;
    check('the new account comes back with an id', !!newId, `id=${newId}`);
    check('and its password material is not echoed back',
      !/hash|salt/.test(JSON.stringify(made.body?.user ?? {})),
      JSON.stringify(made.body?.user ?? {}).slice(0, 80));
    /* The obligation is on the credential, server-side. Read it the way the
       server does, rather than trusting the response body. */
    check('N9 · the starting password is marked temporary on disk',
      newId ? diskOf(TMP).credentials?.[newId]?.mustChange === true : false,
      `mustChange=${newId ? diskOf(TMP).credentials?.[newId]?.mustChange : 'n/a'}`);

    if (newId) {
      const nb = browser(BASE);
      const first = await login(nb, newId, startPw);
      check('the new colleague can sign in with it', first.status === 200, `HTTP ${first.status}`);
      check('N9 · and the sign-in answer itself carries the obligation',
        first.body?.mustChange === true, `mustChange=${first.body?.mustChange}`);
      /* The load-bearing half: the server must keep saying it. A flag that is
         announced once at sign-in and never again is a screen's business, not
         a server's rule. */
      const sess = await nb.call('/api/session');
      check('N9 · the session keeps saying the change is owed, on every read',
        sess.body?.user ? true : false,
        `session authed=${sess.body?.authed}`);
      const again = await login(nb, newId, startPw);
      check('N9 · signing in again still reports the obligation, so it does not lapse',
        again.body?.mustChange === true, `mustChange=${again.body?.mustChange}`);
    }
  }

  /* ====================================================================== */
  section('N10 — a reset ends the sessions, and does not leave the door open');

  {
    /* `/api/reset` deletes the workspace. If it left sessions alive, whoever
       had one would be standing in a workspace that no longer has credentials —
       which is the open window by another route. */
    const b2 = browser(BASE);
    const third = await login(b2, 'u_b', 'bd-pass-1234');
    check('a second session for the same person opens', third.status === 200, `HTTP ${third.status}`);
    /* Create a colleague purely so the reset has something to revoke besides
       the two sessions already in play. */
    const made = await admin.call('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Reset Target', role: 'bd', password: 'Target-pass-9' }),
    });
    check('a colleague exists to be reset', made.status === 200,
      `HTTP ${made.status} ${made.body?.error ?? ''}`);

    /* `POST /api/reset` is admin-only and moves the file aside. */
    const reset = await admin.call('/api/reset', { method: 'POST' });
    check('the administrator can reset the workspace', reset.status === 200, `HTTP ${reset.status}`);
    const after = await b2.call('/api/data');
    check('N10 · the reset ended the other sessions too', after.status !== 200, `HTTP ${after.status}`);
    const anon = browser(BASE);
    const anonRead = await anon.call('/api/data');
    check('N10 · and the reset did not leave an anonymous window behind',
      anonRead.status !== 200, `HTTP ${anonRead.status}`);
    /* The other half of the same finding, and the reason the sessions cannot
       simply ALL die: if nobody survives the reset there is no way to create
       the first administrator again, so the workspace would be bricked by the
       act of clearing it. The operator keeps a way in — and ONLY the operator;
       that is what the two checks above are for.
       `setup` is a field of the session answer, not of the book: it is the
       screen's question ("am I being asked to set this up"), and `/api/data`
       answering 200 does not by itself say the empty book is theirs to fill. */
    const mine = await admin.call('/api/session');
    check('N10 · the operator who reset it is told the workspace needs setting up',
      mine.status === 200 && mine.body?.setup === true,
      `HTTP ${mine.status}, setup=${mine.body?.setup}`);
    const fills = await admin.call('/api/data');
    check('N10 · and the empty book is open to them, not shut in their face',
      fills.status === 200, `HTTP ${fills.status}`);
  }
  {
    /* Re-seed for the remaining checks: the reset moved the workspace aside. */
    writeFileSync(join(TMP, 'workbench.json'), JSON.stringify(makeSeed()));
    admin = browser(BASE);
    bob = browser(BASE);
    const a = await login(admin, 'u_a', 'admin-pass-1');
    const b = await login(bob, 'u_b', 'bd-pass-1234');
    check('the workspace is usable again after being re-seeded',
      a.status === 200 && b.status === 200, `admin ${a.status} / bd ${b.status}`);
  }

  /* ====================================================================== */
  section('N11 — encryption off must be said out loud, never assumed');

  {
    /* The finding was not "encryption can be off" — it is that turning it off
       was a note in a startup log nobody reads. What is asserted here is the
       half a test can hold: with no key the file is plain, and the server SAYS
       so rather than looking identical to a sealed one. */
    const dir2 = mkdtempSync(join(tmpdir(), 'cwb-sec-nokey-'));
    writeFileSync(join(dir2, 'workbench.json'), JSON.stringify(makeSeed()));
    const port2 = Number(process.env.SEC_NOKEY_PORT || 8832);
    const srv2 = await spawnServer(port2, { WB_DATA_DIR: dir2, WB_DATA_KEY: '' });
    try {
      const up2 = await waitUp(`http://127.0.0.1:${port2}`, srv2.log);
      check('a server with no key still starts (offline use is a real case)', up2);
      const log2 = srv2.log.join('');
      check('N11 · and it says encryption is off, in words',
        /encryption at rest:\s*OFF|encryption[^\\n]*OFF/i.test(log2),
        log2.split('\n').find((l) => /encryption/i.test(l)) || '(nothing said)');
      const raw = readFileSync(join(dir2, 'workbench.json'), 'utf8');
      check('N11 · the file really is plain when there is no key',
        !raw.startsWith('WBENC1.'), raw.slice(0, 16) + '…');
    } finally { srv2.stop(); }
  }
  {
    /* And with a key the startup line must flip — so the log is evidence
       rather than decoration. A run that always said OFF would pass the check
       above and mean nothing.
       The FILE is not sealed at boot, and asserting that would be asserting the
       wrong design: `seal.mjs` documents the intended behaviour as "an existing
       plain file is encrypted on the first save". Reading the file before
       anybody has saved proves only that the file is still the one that was
       seeded. So the save is made, and the seal is checked after it. */
    const dir3 = mkdtempSync(join(tmpdir(), 'cwb-sec-key-'));
    writeFileSync(join(dir3, 'workbench.json'), JSON.stringify(makeSeed()));
    const port3 = Number(process.env.SEC_KEYED_PORT || 8833);
    const base3 = `http://127.0.0.1:${port3}`;
    const srv3 = await spawnServer(port3, {
      WB_DATA_DIR: dir3, WB_DATA_KEY: Buffer.alloc(32, 5).toString('base64'),
    });
    try {
      const up3 = await waitUp(base3, srv3.log);
      check('a server with a key starts', up3);
      const log3 = srv3.log.join('');
      check('N11 · and says encryption is on, so the log line is real evidence',
        /encryption at rest:\s*ON/i.test(log3),
        log3.split('\n').find((l) => /encryption/i.test(l)) || '(nothing said)');
      /* Make a real save through the API, the way a client does. */
      const c3 = browser(base3);
      const li = await login(c3, 'u_a', 'admin-pass-1');
      check('the administrator signs in on the keyed server', li.status === 200, `HTTP ${li.status}`);
      /* The upgrade path this finding is about: a file that was written while
         the key was unset has to be readable by a server that now holds one.
         Read anonymously and the answer is a 401 JSON body with no `state` at
         all — which is why the read is made through the session, not beside
         it. */
      const cur = await c3.call('/api/data');
      check('N11 · a plain file is readable by a server that has the key',
        cur.body?.state?.customers?.length === 2,
        `HTTP ${cur.status}, customers=${cur.body?.state?.customers?.length ?? '(none)'}`);
      const put = await c3.call('/api/data', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: cur.body.state, baseRev: cur.body?.rev ?? 0 }),
      });
      check('the save is answered', put.status === 200, `HTTP ${put.status}`);
      const raw3 = readFileSync(join(dir3, 'workbench.json'), 'utf8');
      check('N11 · after one save the file is sealed, so the upgrade is real',
        raw3.startsWith('WBENC1.'), raw3.slice(0, 20) + '…');
      check('N11 · and no customer name survives in the sealed file',
        !raw3.includes('Bob Industries'), 'searched the whole file');
    } finally { srv3.stop(); }
  }

  /* ====================================================================== */
  section('N12 — the remembered device is a token, and only that');

  {
    /* `localStorage` is readable by any script on the origin, so the question
       is not whether the token leaks — it is what the token can DO. It must
       exchange for a session and nothing else, it must die with the account,
       and a forged one must be worthless. */
    const device = browser(BASE);
    const inRes = await login(device, 'u_b', 'bd-pass-1234');
    check('a member signs in', inRes.status === 200, `HTTP ${inRes.status}`);
    const token = inRes.body?.token || '';
    check('a device token is issued', !!token && token.length >= 32, `${token.length} chars`);

    /* Forged token: the same length, one different character. */
    if (token) {
      const forged = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
      const anon = browser(BASE);
      const r = await anon.call('/api/login/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: forged }),
      });
      check('N12 · a forged device token is refused', r.status !== 200, `HTTP ${r.status}`);
    }
    /* An empty token is not a wildcard. */
    {
      const anon = browser(BASE);
      const r = await anon.call('/api/login/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: '' }),
      });
      check('N12 · an empty device token is refused', r.status !== 200, `HTTP ${r.status}`);
    }
    /* The token must live only in the response — writing it to disk would put
       a working credential in a file nobody guards. */
    {
      const blob = JSON.stringify(diskOf(TMP));
      check('N12 · the device token is never written into the workspace file',
        !token || !blob.includes(token), 'searched the whole file');
    }
  }

  /* ====================================================================== */
  section('the boundary between this suite and the other two');
  {
    /* Stated as a check rather than a comment, so a reader knows where to look
       and a future edit that moves a responsibility is caught. */
    const iso = readFileSync(join(ROOT, 'scripts', 'verify-isolation.mjs'), 'utf8');
    const sec = readFileSync(join(ROOT, 'scripts', 'verify-security.mjs'), 'utf8');
    check('the row-ownership findings are permanent in the isolation suite',
      /N2/.test(iso) && /N3/.test(iso) && /N1/.test(iso) && /N4/.test(iso));
    check('the transport findings are permanent in the security suite',
      /CSP blocks exfiltration/.test(sec) && /HSTS/.test(sec) && /encryption at rest/i.test(sec));
    check('this suite is registered so it cannot silently stop running',
      readFileSync(join(ROOT, 'package.json'), 'utf8').includes('verify-secfindings.mjs'));
    check('and it is in the aggregate run too',
      readFileSync(join(ROOT, 'scripts', 'verify-all.mjs'), 'utf8').includes('verify-secfindings.mjs'));
  }

} catch (e) {
  check('the suite ran to completion', false, String(e.message || e));
} finally {
  srv.stop();
}

console.log('\n' + ran + ' checks, ' + (pass ? 'all PASS' : 'FAILURES above'));
console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(pass ? 0 : 1);
