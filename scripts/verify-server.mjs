/**
 * Security + integrity checks for the data server.
 *
 * The server owns the ONE file that is the whole workspace, so the interesting
 * failures are not "does it return 200" but "can a stranger reach it", "can a
 * colleague reach past their role" and "does one person's save destroy another
 * person's work". This exercises the real server on spare ports and puts the
 * real data file back exactly as it found it.
 *
 * Two phases:
 *   1. the original guards, against the real file, in open mode (WB_OPEN=1)
 *   2. multi-user behaviour - sign-in, gating, merging - against a throwaway
 *      workspace in a temp directory, so nothing here can touch your data
 *
 * Usage: node scripts/verify-server.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_FILE = join(ROOT, 'data', 'workbench.json');
const BACKUP_DIR = join(ROOT, 'data', 'backups');
const PORT = Number(process.env.TEST_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const SHARED_PORT = PORT + 1;
const SHARED_BASE = `http://127.0.0.1:${SHARED_PORT}`;

let pass = true;
let ran = 0;
const check = (name, cond, detail) => {
  ran++;
  if (!cond) pass = false;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${detail}` : ''}`);
};
const section = (name) => console.log(`\n=== ${name} ===`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------- guard ------------------------------- */
/* The point of this script is to prove the guards hold, not to tidy the
   workspace — so every byte it touches is put back afterwards. */
const guardBytes = existsSync(DATA_FILE) ? readFileSync(DATA_FILE) : null;
const backupsBefore = new Set(
  existsSync(BACKUP_DIR) ? readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json')) : [],
);
const restore = () => {
  try {
    if (guardBytes) writeFileSync(DATA_FILE, guardBytes);
    else if (existsSync(DATA_FILE)) unlinkSync(DATA_FILE);
  } catch (e) {
    console.log('!! could not restore the data file:', e.message);
  }
  try {
    if (existsSync(BACKUP_DIR)) {
      for (const f of readdirSync(BACKUP_DIR)) {
        if (f.endsWith('.json') && !backupsBefore.has(f)) unlinkSync(join(BACKUP_DIR, f));
      }
    }
  } catch { /* nothing to tidy */ }
};

/**
 * A caller that remembers its own session cookie, the way a browser does.
 * Without this every request would look like a fresh stranger.
 */
function browser(base) {
  let cookie = '';
  return {
    async call(pathname, init = {}, origin) {
      const headers = { ...(init.headers ?? {}) };
      if (cookie) headers.Cookie = cookie;
      if (origin !== undefined) headers.Origin = origin;
      const res = await fetch(base + pathname, { ...init, headers });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let body = null;
      try { body = await res.json(); } catch { /* not json */ }
      return { status: res.status, body, cors: res.headers.get('access-control-allow-origin') };
    },
    forget() { cookie = ''; },
  };
}

const anon = browser(BASE);
const call = (pathname, init = {}, origin) => anon.call(pathname, init, origin);

/* ------------------------------- servers ------------------------------- */
function spawnServer(port, extraEnv = {}) {
  const log = [];
  const child = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
    // WB_TLS=0 pins these to http. The server turns https on by itself as soon
    // as certs/ exists, and a harness that hard-codes http:// must not depend
    // on whether a certificate happens to have been generated on this machine.
    env: { ...process.env, PORT: String(port), WB_TLS: '0', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

/* ====================================================================== */
/*  PHASE 1 — the original guards, against the real file                  */
/* ====================================================================== */

const single = spawnServer(PORT, { WB_OPEN: '1' });

try {
  if (!await waitUp(BASE, single.log)) throw new Error('server never came up');

  section('reads');
  const health = await call('/api/health');
  check('health answers', health.status === 200 && health.body?.ok === true, `status=${health.status}`);
  const data = await call('/api/data');
  check('the workspace can be read', data.status === 200 && data.body?.ok === true,
    `status=${data.status} bytes=${data.body?.bytes}`);

  section('cross-origin is refused (the whole workspace is in this file)');
  const evil = 'https://evil.example';
  const evilGet = await call('/api/data', {}, evil);
  check('a random web page cannot read the data', evilGet.status === 403, `status=${evilGet.status}`);
  const evilOpts = await call('/api/data', { method: 'OPTIONS' }, evil);
  check('a preflight from a random page is refused', evilOpts.status === 403, `status=${evilOpts.status}`);
  const evilReset = await call('/api/reset', { method: 'POST' }, evil);
  check('a random page cannot wipe the file', evilReset.status === 403, `status=${evilReset.status}`);
  const evilPut = await call('/api/data', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"schemaVersion":1,"accounts":[]}',
  }, evil);
  check('a random page cannot overwrite the data', evilPut.status === 403, `status=${evilPut.status}`);
  check('the refused response opens nothing up and leaks nothing',
    evilGet.cors === null && !JSON.stringify(evilGet.body ?? {}).includes('accounts'),
    `cors=${evilGet.cors}`);

  section('the origins that must work still work');
  for (const [label, origin] of [['no Origin', undefined], ['file:// (null)', 'null'], ['localhost dev server', 'http://localhost:5173']]) {
    const r = await call('/api/data', {}, origin);
    check(`${label} is served`, r.status === 200, `status=${r.status}`);
  }
  const lan = await call('/api/data', {}, 'http://192.168.50.7:5173');
  check('a private LAN address is served (what the office uses)', lan.status === 200, `status=${lan.status}`);

  section('a bad write can never erase the workspace');
  const empty = await call('/api/data', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  check('an empty object is rejected', empty.status === 400, `status=${empty.status} ${empty.body?.error}`);
  const notJson = await call('/api/data', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{oops',
  });
  check('malformed JSON is rejected', notJson.status === 400, `status=${notJson.status}`);
  const wrongType = await call('/api/data', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"schemaVersion":1,"accounts":"nope"}',
  });
  check('a wrong-typed collection is rejected', wrongType.status === 400, `status=${wrongType.status} ${wrongType.body?.error}`);
  const badVersion = await call('/api/data', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"schemaVersion":99,"accounts":[]}',
  });
  check('an unknown schema version is rejected', badVersion.status === 400, `status=${badVersion.status}`);
  const after = await call('/api/data');
  check('the file is still intact after all of those',
    after.status === 200 && after.body?.bytes === data.body?.bytes,
    `${data.body?.bytes} -> ${after.body?.bytes}`);

  section('static files cannot escape dist/');
  const traverse = await call('/../package.json');
  check('a path traversal is refused', traverse.status === 403 || traverse.status === 404,
    `status=${traverse.status}`);
  const badEscape = await call('/%zz');
  check('a malformed escape is a bad request, not a crash', badEscape.status === 400,
    `status=${badEscape.status}`);
  const srcLeak = await call('/../server/server.mjs');
  check('the server source is never served', srcLeak.status === 403 || srcLeak.status === 404,
    `status=${srcLeak.status}`);

  section('maintenance endpoints');
  /* A stray temp file is what a crashed write leaves behind. */
  const tmpName = join(ROOT, 'data', `workbench.${process.pid}.tmp`);
  writeFileSync(tmpName, 'partial write');
  const cleanup = await call('/api/cleanup', { method: 'POST' });
  check('temp files are cleared', cleanup.status === 200 && cleanup.body?.removed >= 1,
    `removed=${cleanup.body?.removed}`);

  /* Reset only has something to delete when the file is actually there. After a
     wipe there is no file at all, so the check below used to fail for the wrong
     reason. Write one first; `restore()` puts the original (absent) state back
     at the end either way, so this never leaks into the real workspace. */
  if (!existsSync(DATA_FILE)) {
    writeFileSync(DATA_FILE, JSON.stringify({ schemaVersion: 1, accounts: [] }));
  }
  const reset = await call('/api/reset', { method: 'POST' });
  check('reset deletes the file', reset.status === 200 && reset.body?.deleted === true,
    `status=${reset.status}`);
  const backupsAfter = existsSync(BACKUP_DIR)
    ? readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json'))
    : [];
  const fresh = backupsAfter.filter((f) => !backupsBefore.has(f));
  check('reset leaves a backup behind', fresh.length >= 1, `backups=${JSON.stringify(fresh)}`);
} catch (e) {
  pass = false;
  console.log('\n!! harness error (phase 1):', e.message);
} finally {
  restore();
  single.child.kill('SIGTERM');
  await wait(200);
}

/* ====================================================================== */
/*  PHASE 1b — the deployed public link (own-host CORS)                    */
/*                                                                         */
/*  The app is served BY this server, through a reverse proxy, so the       */
/*  browser still sends an Origin on PUT - and that Origin is a PUBLIC      */
/*  hostname, which is not in the private ranges. Refusing it made every    */
/*  save come back 403 and the app reported "Data server offline", while    */
/*  curl and jsdom both sailed through: neither sends an Origin at all.     */
/*  Run against a throwaway workspace so a successful write is harmless.    */
/* ====================================================================== */

const PUBLIC_HOST = 'account-workbench.app-tencent.workbuddy.host';
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const PUBLIC_PORT = SHARED_PORT + 2;
const PUBLIC_BASE = `http://127.0.0.1:${PUBLIC_PORT}`;
const PUBLIC_TMP = mkdtempSync(join(tmpdir(), 'cwb-public-'));
const publicSrv = spawnServer(PUBLIC_PORT, { WB_DATA_DIR: PUBLIC_TMP, WB_OPEN: '1' });

try {
  if (!await waitUp(PUBLIC_BASE, publicSrv.log)) throw new Error('public-host server never came up');
  const pub = browser(PUBLIC_BASE);
  const save = (origin, host) => pub.call('/api/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(host ? { 'X-Forwarded-Host': host } : {}) },
    body: '{"schemaVersion":1,"accounts":[]}',
  }, origin);

  const selfPut = await save(PUBLIC_ORIGIN, PUBLIC_HOST);
  check('the deployed app can save from its own public hostname', selfPut.status === 200,
    `status=${selfPut.status} ${selfPut.body?.error ?? ''}`);
  check('that save is answered with the matching CORS header', selfPut.cors === PUBLIC_ORIGIN,
    `cors=${selfPut.cors}`);
  /* Browsers do not send an Origin on a same-origin GET, so in production the
     read never even reaches the check - but the proxy does forward the host, so
     an explicit Origin must still be welcome. */
  const selfGet = await pub.call('/api/data', { headers: { 'X-Forwarded-Host': PUBLIC_HOST } },
    PUBLIC_ORIGIN);
  check('a read from the public hostname works too', selfGet.status === 200, `status=${selfGet.status}`);

  const otherHost = await save('https://not-my-host.example', PUBLIC_HOST);
  check('a DIFFERENT public hostname is still refused (no DNS-rebinding hole)',
    otherHost.status === 403, `status=${otherHost.status}`);
  /* A hosted proxy overwrites `X-Forwarded-Host` with the sandbox's internal
     address and never presents a public `Host`, so the "is this our own
     hostname?" rule has nothing true to compare against. That is the case that
     403'd every save and put "Data server offline" on the screen. The name
     declared in server/published-origins.txt is what carries it. */
  const noFwd = await save(PUBLIC_ORIGIN, null);
  check('the published name is honoured even when the proxy forwards nothing',
    noFwd.status === 200, `status=${noFwd.status} ${noFwd.body?.error ?? ''}`);
  /* Declaring the name must not widen the rule: the list holds the exact
     hostname, so a name that merely contains ours is still a stranger. */
  const lookalike = await save(`https://${PUBLIC_HOST}.evil.example`, PUBLIC_HOST);
  check('a hostname that merely contains our own is still refused',
    lookalike.status === 403, `status=${lookalike.status}`);
  const nullPublic = await save('null', PUBLIC_HOST);
  check('an Origin of "null" is refused once the server is public', nullPublic.status === 403,
    `status=${nullPublic.status}`);
  const nullLocal = await save('null', null);
  check('an Origin of "null" still works on a private server (the file:// build)',
    nullLocal.status === 200, `status=${nullLocal.status} ${nullLocal.body?.error ?? ''}`);
} catch (e) {
  pass = false;
  console.log('\n!! harness error (phase 1b):', e.message);
} finally {
  publicSrv.child.kill('SIGTERM');
  rmSync(PUBLIC_TMP, { recursive: true, force: true });
  await wait(200);
}

/* ====================================================================== */
/*  PHASE 2 — shared workspace: sign-in, roles, merging                   */
/* ====================================================================== */

const TMP = mkdtempSync(join(tmpdir(), 'cwb-verify-'));
const shared = spawnServer(SHARED_PORT, { WB_DATA_DIR: TMP });

/* A throwaway workspace with three colleagues, two of whom have a password. */
const T0 = new Date().toISOString();
const FUTURE = new Date(Date.now() + 120_000).toISOString();
function makeCred(userId, password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 150_000, 32, 'sha256');
  return {
    userId, algo: 'pbkdf2-sha256', iterations: 150_000,
    salt: salt.toString('base64'), hash: hash.toString('base64'),
    createdAt: T0, updatedAt: T0,
  };
}
const seed = {
  schemaVersion: 1,
  setupComplete: true,
  currentUserId: 'u_a',
  users: [
    { id: 'u_a', name: 'Ada Admin', role: 'admin', title: 'SA', createdAt: T0, updatedAt: T0 },
    { id: 'u_b', name: 'Bob BD', role: 'bd', title: 'BD', createdAt: T0, updatedAt: T0 },
    { id: 'u_c', name: 'Cara NoPass', role: 'sa', title: 'SA', createdAt: T0, updatedAt: T0 },
  ],
  credentials: { u_a: makeCred('u_a', 'admin-pass-1'), u_b: makeCred('u_b', 'bd-pass-1234') },
  accounts: [
    { id: 'acc_1', name: 'NusaTel', industry: 'Telco', priority: 'p0', createdAt: T0, updatedAt: T0 },
  ],
  nextSteps: [
    { id: 'ns_a', title: 'Send the proposal', status: 'todo', priority: 'p1', createdAt: T0, updatedAt: T0 },
    { id: 'ns_x', title: 'Chase the budget owner', status: 'todo', priority: 'p2', createdAt: T0, updatedAt: T0 },
  ],
  /* Bob has to be ON this account for the collision below to be real. Without
     a team row a BD is scoped to nothing: Bob's view contains no accounts at
     all, so he never sends the stale name, the merge sees no difference, and
     the "two people editing at once" section quietly tested one person.
     That is not a bug in the server - it is the scope working - but a section
     that is meant to prove "we never lose your work" has to start from two
     people who can both actually see the record. */
  team: [
    { id: 'tm_1', userId: 'u_b', accountId: 'acc_1', fn: 'BD', isPrimary: true, createdAt: T0, updatedAt: T0 },
  ],
  logs: [],
};
writeFileSync(join(TMP, 'workbench.json'), JSON.stringify(seed));
writeFileSync(join(TMP, 'workbench.rev.json'), JSON.stringify({ rev: 1, savedAt: T0, bytes: 0 }));

const put = (b, body) => b.call('/api/data', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const ids = (rows, key = 'id') => (rows ?? []).map((r) => r[key]).join(',');
/* Exact membership, never a substring test: `ns_ada` contains `ns_a`, so
   `.includes('ns_a')` on a joined id list happily reports a deleted row. */
const hasId = (rows, id) => (rows ?? []).some((r) => r.id === id);
const readState = (b) => b.call('/api/data');

try {
  if (!await waitUp(SHARED_BASE, shared.log)) throw new Error('shared server never came up');

  const admin = browser(SHARED_BASE);
  const bob = browser(SHARED_BASE);
  const stranger = browser(SHARED_BASE);

  section('the door is shut until somebody signs in');
  const anonRead = await stranger.call('/api/data');
  check('an anonymous read is refused', anonRead.status === 401, `status=${anonRead.status}`);
  const anonPut = await put(stranger, { state: seed, baseRev: 1 });
  check('an anonymous write is refused', anonPut.status === 401, `status=${anonPut.status}`);
  const anonReset = await stranger.call('/api/reset', { method: 'POST' });
  check('an anonymous reset is refused', anonReset.status === 401, `status=${anonReset.status}`);
  const sess = await stranger.call('/api/session');
  check('the app can still ask who is signed in', sess.status === 200 && sess.body?.requiresAuth === true,
    `requiresAuth=${sess.body?.requiresAuth}`);
  const dir = await stranger.call('/api/directory');
  check('the sign-in list names only accounts that have a password',
    dir.status === 200 && ids(dir.body?.users) === 'u_a,u_b', `users=${ids(dir.body?.users)}`);
  check('the sign-in list carries no hashes',
    !JSON.stringify(dir.body ?? {}).includes('pbkdf2'), `body=${JSON.stringify(dir.body).slice(0, 80)}`);

  section('signing in');
  const badPw = await bob.call('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'u_b', password: 'wrong-password' }),
  });
  check('a wrong password is refused', badPw.status === 401, `status=${badPw.status}`);
  const noPw = await stranger.call('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'u_c', password: 'anything' }),
  });
  check('a colleague with no password cannot sign in at all', noPw.status === 401, `status=${noPw.status}`);
  const bobIn = await bob.call('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'u_b', password: 'bd-pass-1234' }),
  });
  check('the right password signs Bob in', bobIn.status === 200 && bobIn.body?.user?.id === 'u_b',
    `status=${bobIn.status}`);
  const bobSess = await bob.call('/api/session');
  check('the session sticks to the next request', bobSess.status === 200 && bobSess.body?.authed === true,
    `authed=${bobSess.body?.authed}`);
  const bobRead = await readState(bob);
  check('a signed-in colleague can read the workspace', bobRead.status === 200, `status=${bobRead.status}`);

  section('a colleague cannot reach past their role');
  check('password hashes are blanked out, not handed over',
    !JSON.stringify(bobRead.body?.state?.credentials ?? {}).includes('pbkdf2')
    && Object.keys(bobRead.body?.state?.credentials ?? {}).length === 2,
    `credentials=${JSON.stringify(bobRead.body?.state?.credentials).slice(0, 70)}`);
  check('the blanked hashes are useless as a credential',
    (bobRead.body?.state?.credentials?.u_a?.algo ?? '') === 'server-managed',
    `algo=${bobRead.body?.state?.credentials?.u_a?.algo}`);
  check('but the roster is still there, so the app knows it is set up',
    (bobRead.body?.state?.users ?? []).length === 3, `users=${bobRead.body?.state?.users?.length}`);

  const escalate = await put(bob, {
    state: {
      ...bobRead.body.state,
      users: bobRead.body.state.users.map((u) => (u.id === 'u_b' ? { ...u, role: 'admin' } : u)),
    },
    baseRev: bobRead.body.rev,
  });
  check('a write that tries to promote itself is accepted but does not stick', escalate.status === 200,
    `status=${escalate.status}`);
  const afterEscalate = await readState(bob);
  check('Bob is still a BD on disk',
    afterEscalate.body.state.users.find((u) => u.id === 'u_b')?.role === 'bd',
    `role=${afterEscalate.body.state.users.find((u) => u.id === 'u_b')?.role}`);
  check('and the administrator hash survived Bob writing over it',
    await (async () => {
      const probe = browser(SHARED_BASE);
      const r = await probe.call('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'u_a', password: 'admin-pass-1' }),
      });
      return r.status === 200;
    })(), 'admin can still sign in');

  const bobReset = await bob.call('/api/reset', { method: 'POST' });
  check('a non-administrator cannot wipe the workspace', bobReset.status === 403, `status=${bobReset.status}`);
  const bobCleanup = await bob.call('/api/cleanup', { method: 'POST' });
  check('a non-administrator cannot run cleanup', bobCleanup.status === 403, `status=${bobCleanup.status}`);

  section('two people editing at once: merge, never lose work');
  const aIn = await admin.call('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'u_a', password: 'admin-pass-1' }),
  });
  check('the administrator signs in', aIn.status === 200, `status=${aIn.status}`);

  const aView = await readState(admin);
  const bView = await readState(bob);
  const revBoth = aView.body.rev;
  check('both colleagues are looking at the same revision',
    revBoth === bView.body.rev && revBoth > 0, `rev=${revBoth}`);

  /* Ada edits the account and adds an action. Same revision -> replaces. */
  const aWrite = await put(admin, {
    state: {
      ...aView.body.state,
      accounts: [{ ...aView.body.state.accounts[0], name: 'NusaTel Berhad', updatedAt: FUTURE }],
      nextSteps: [...aView.body.state.nextSteps,
        { id: 'ns_ada', title: 'Book the workshop', status: 'todo', priority: 'p0', createdAt: T0, updatedAt: FUTURE }],
    },
    baseRev: revBoth,
  });
  check('the first writer replaces the file outright', aWrite.status === 200 && aWrite.body?.mode === 'replace',
    `mode=${aWrite.body?.mode} rev=${aWrite.body?.rev}`);

  /* Bob was still on the old revision and did not know. He adds his own action
     and - crucially - still holds the OLD account name. */
  const bWrite = await put(bob, {
    state: {
      ...bView.body.state,
      nextSteps: [...bView.body.state.nextSteps,
        { id: 'ns_bob', title: 'Call the procurement lead', status: 'todo', priority: 'p1', createdAt: T0, updatedAt: FUTURE }],
    },
    baseRev: revBoth,
  });
  check('the second writer is merged instead of overwriting', bWrite.status === 200 && bWrite.body?.mode === 'merge',
    `mode=${bWrite.body?.mode}`);
  check('and is told how many collisions there were', typeof bWrite.body?.conflicts === 'number',
    `conflicts=${bWrite.body?.conflicts}`);
  check('and is handed the merged truth so it catches up immediately',
    !!bWrite.body?.state, `hasState=${!!bWrite.body?.state}`);

  const merged = (await readState(admin)).body.state;
  check("Ada's action survived", hasId(merged.nextSteps, 'ns_ada'), `steps=${ids(merged.nextSteps)}`);
  check("Bob's action survived too", hasId(merged.nextSteps, 'ns_bob'), `steps=${ids(merged.nextSteps)}`);
  check('the account keeps the newer name, not the stale one Bob sent',
    merged.accounts[0].name === 'NusaTel Berhad', `name=${merged.accounts[0].name}`);
  const conflictFile = join(TMP, 'conflicts.jsonl');
  check('the version that lost is written down rather than thrown away',
    existsSync(conflictFile) && readFileSync(conflictFile, 'utf8').includes('acc_1'),
    `exists=${existsSync(conflictFile)}`);

  section('deleting still works, and never eats somebody else\'s edit');
  /* Removing a row is an act, not a silence. There used to be two ways to do
     it — name it in the envelope, or leave it out of the blob — and the second
     one was the hole: the administrator sees every customer, so their client's
     omissions were the only deletes that were ever honoured, and an ordinary
     save left out the audit log and the insights map and took them with it.
     An omission now means "this client has nothing to say about this row",
     for everybody, so the envelope is the only thing that removes anything —
     and destroying a record is still the administrator's alone. */
  const bNow = await readState(bob);
  const bRev = bNow.body.rev;
  const bSavedAt = bNow.body.savedAt;
  const delWrite = await put(bob, {
    state: { ...bNow.body.state, nextSteps: bNow.body.state.nextSteps.filter((n) => n.id !== 'ns_a') },
    deleted: { nextSteps: ['ns_a'] },
    baseRev: bRev,
  });
  check('a colleague\'s delete is answered, not refused outright', delWrite.status === 200,
    `status=${delWrite.status}`);
  check('but the record is not destroyed — only an administrator may delete',
    hasId((await readState(admin)).body.state.nextSteps, 'ns_a'),
    `steps=${ids((await readState(admin)).body.state.nextSteps)}`);

  const aNow = await readState(admin);
  const adminDel = await put(admin, {
    state: { ...aNow.body.state, nextSteps: aNow.body.state.nextSteps.filter((n) => n.id !== 'ns_a') },
    deleted: { nextSteps: ['ns_a'] },
    baseRev: aNow.body.rev,
  });
  check("an administrator's delete with a current revision is honoured",
    adminDel.status === 200 && adminDel.body?.mode === 'replace', `mode=${adminDel.body?.mode}`);
  check('the deleted action is gone',
    !hasId((await readState(admin)).body.state.nextSteps, 'ns_a'),
    `steps=${ids((await readState(admin)).body.state.nextSteps)}`);

  /* Bob decides to drop ns_x. Before his save lands, Ada edits ns_x. */
  const bBefore = await readState(bob);
  const staleRev = bBefore.body.rev;
  const staleSavedAt = bBefore.body.savedAt;
  const aEdit = await put(admin, {
    state: {
      ...(await readState(admin)).body.state,
      nextSteps: (await readState(admin)).body.state.nextSteps.map((n) =>
        (n.id === 'ns_x' ? { ...n, title: 'Chase the CFO', updatedAt: FUTURE } : n)),
    },
    baseRev: staleRev,
  });
  check('Ada edits the very record Bob is about to delete', aEdit.status === 200, `status=${aEdit.status}`);
  const bDelete = await put(bob, {
    state: { ...bBefore.body.state, nextSteps: bBefore.body.state.nextSteps.filter((n) => n.id !== 'ns_x') },
    deleted: { nextSteps: ['ns_x'] },
    baseRev: staleRev,
    baseSavedAt: staleSavedAt,
  });
  check('the stale delete is merged, not applied blindly', bDelete.status === 200 && bDelete.body?.mode === 'merge',
    `mode=${bDelete.body?.mode}`);
  const afterDelete = (await readState(admin)).body.state;
  check("Ada's edit wins - the delete does not take her work with it",
    hasId(afterDelete.nextSteps, 'ns_x'), `steps=${ids(afterDelete.nextSteps)}`);
  check('and it is her wording that survived',
    afterDelete.nextSteps.find((n) => n.id === 'ns_x')?.title === 'Chase the CFO',
    `title=${afterDelete.nextSteps.find((n) => n.id === 'ns_x')?.title}`);

  section('the revision counter');
  const revs = [];
  for (let i = 0; i < 3; i++) {
    const v = await readState(admin);
    const w = await put(admin, { state: v.body.state, baseRev: v.body.rev });
    revs.push(w.body?.rev);
  }
  check('every save moves the revision forward',
    revs.every((r, i) => typeof r === 'number' && (i === 0 || r > revs[i - 1])), `revs=${revs.join('->')}`);
  /* Read the state through the server, not off the disk: with `WB_DATA_KEY`
     set the file is sealed, and `JSON.parse` on it would fail the harness
     rather than answer the question. What matters is that the state a client
     is handed carries no revision — wherever the file happens to be stored. */
  const served = await readState(admin);
  check('the revision lives beside the data file, not inside it',
    existsSync(join(TMP, 'workbench.rev.json')) && served.body?.state?.rev === undefined,
    'rev not in the state the app reads');

  section('brute force is slowed down');
  const attacker = browser(SHARED_BASE);
  let locked = 0;
  for (let i = 0; i < 10; i++) {
    const r = await attacker.call('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u_a', password: `guess-${i}` }),
    });
    if (r.status === 429) { locked = i + 1; break; }
  }
  check('repeated wrong passwords are throttled', locked > 0 && locked <= 9, `blocked on attempt ${locked}`);

  section('signing out');
  const out = await bob.call('/api/logout', { method: 'POST' });
  check('logout succeeds', out.status === 200, `status=${out.status}`);
  const afterOut = await bob.call('/api/data');
  check('and the session really is gone', afterOut.status === 401, `status=${afterOut.status}`);

  section('an administrator still holds the keys');
  const adminReset = await admin.call('/api/reset', { method: 'POST' });
  check('an administrator can wipe the workspace', adminReset.status === 200, `status=${adminReset.status}`);
} catch (e) {
  pass = false;
  console.log('\n!! harness error (phase 2):', e.message);
  console.log(shared.log.join(''));
} finally {
  shared.child.kill('SIGTERM');
  await wait(200);
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* temp dir, best effort */ }
}

/* ====================================================================== */
/*  PHASE 3 — https, only when a certificate actually exists               */
/* ====================================================================== */

const TLS_PORT = SHARED_PORT + 1;
if (existsSync(join(ROOT, 'certs', 'cert.pem')) && existsSync(join(ROOT, 'certs', 'key.pem'))) {
  const TMP2 = mkdtempSync(join(tmpdir(), 'cwb-tls-'));
  writeFileSync(join(TMP2, 'workbench.json'), JSON.stringify({
    ...seed,
    credentials: { u_a: makeCred('u_a', 'admin-pass-1') },
  }));
  // Self-signed, so the checker has to be told not to reject its own cert.
  const prevReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const tlsBase = `https://127.0.0.1:${TLS_PORT}`;
  const tls = spawnServer(TLS_PORT, { WB_DATA_DIR: TMP2, WB_TLS: '1' });
  try {
    if (!await waitUp(tlsBase, tls.log)) throw new Error('tls server never came up');
    section('https, when a certificate has been made');
    const probe = await fetch(`${tlsBase}/api/health`);
    check('the server answers over https', probe.ok, `status=${probe.status}`);

    /* One port, both protocols. The office reaches the app over https, but the
       double-clicked copy runs from file:// and a file:// page cannot call a
       self-signed https address it has never visited — so this machine keeps
       plain http on the same port. Regression worth locking: https used to take
       http away completely, and every save from that copy silently stopped
       reaching the file ("Data server offline · not saved to file"). */
    const plainProbe = await fetch(`http://127.0.0.1:${TLS_PORT}/api/health`);
    check('the same port still answers plain http from this machine', plainProbe.ok,
      `status=${plainProbe.status}`);
    const plainLogin = await fetch(`http://127.0.0.1:${TLS_PORT}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u_a', password: 'admin-pass-1' }),
    });
    const plainCookie = plainLogin.headers.get('set-cookie') ?? '';
    check('and a cookie handed out over that plain http call is not marked Secure',
      plainLogin.ok && plainCookie.length > 0 && !/Secure/i.test(plainCookie),
      `status=${plainLogin.status} cookie=${plainCookie.slice(0, 90)}`);

    const r = await fetch(`${tlsBase}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u_a', password: 'admin-pass-1' }),
    });
    const cookie = r.headers.get('set-cookie') ?? '';
    check('the session cookie is marked Secure over https', /Secure/i.test(cookie), `cookie=${cookie.slice(0, 90)}`);
    check('and HttpOnly, so a script on the page cannot read it', /HttpOnly/i.test(cookie), `cookie=${cookie.slice(0, 90)}`);
    check('and SameSite, so another site cannot ride on it', /SameSite=Lax/i.test(cookie), `cookie=${cookie.slice(0, 90)}`);

    const token = (await r.json())?.token;
    check('a token is handed back for callers that cannot use cookies (the file:// build)',
      typeof token === 'string' && token.length >= 32, `token=${String(token).slice(0, 8)}…`);
    const byHeader = await fetch(`${tlsBase}/api/data`, { headers: { 'X-Session-Token': String(token) } });
    check('that token authenticates a header-only caller', byHeader.status === 200, `status=${byHeader.status}`);
  } catch (e) {
    pass = false;
    console.log('\n!! harness error (phase 3):', e.message);
  } finally {
    tls.child.kill('SIGTERM');
    await wait(200);
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevReject ?? '';
    if (prevReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    try { rmSync(TMP2, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
} else {
  console.log('\n(https checks skipped - no certs/. Run "npm run cert" to generate one.)');
}

const restored = guardBytes ? (existsSync(DATA_FILE) && readFileSync(DATA_FILE).equals(guardBytes)) : !existsSync(DATA_FILE);
check('\nthe real data file is byte-for-byte what it was before', restored,
  `${guardBytes ? guardBytes.length : 0} bytes`);

console.log(`\n${ran} checks run.`);
console.log(pass ? '\nRESULT: PASS - the data server holds its guards\n' : '\nRESULT: FAIL\n');
process.exit(pass ? 0 : 1);
