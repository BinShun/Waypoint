/* verify:interactions — §17: the rename is real, and it did not lose anything.

   WHY THIS IS ITS OWN SUITE
   -------------------------
   A collection rename is the kind of change that looks finished the moment the
   word disappears from the source. Three separate things have to be true, and
   only the first is visible in a diff:

     1. The new name is used everywhere the old one was.
     2. A workspace that was written BEFORE the rename still opens and still
        saves. This is the one that gets skipped, and it fails on the only
        workspace that matters — the one with real rows in it, in front of the
        person who has to keep working.
     3. Saving such a workspace migrates it, rather than leaving two
        collections holding the same rows forever.

   So this suite builds a workspace that looks exactly like a pre-rename file —
   rows under `meetings`, timeline entries with `k:'meeting'` — walks it through
   the API the way the browser does, and checks all three. Then it runs the
   migration script over a copy of the same file and proves the move is
   lossless, field by field, rather than trusting the script's own report.

   It also guards the part that is easy to over-fix: the ROW's own classifier
   (`k`: Meeting / Call / Email / Video call). The collection was renamed; the
   classifier was not, and a suite that let the two drift together would pass
   while quietly turning every Call into an Interaction-typed record.

   Run: WP_PASS=<password> npm run verify:interactions
   Works in a temp workspace it creates itself, so it never touches real data. */
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkspaceFile } from './disk.mjs';
import { startServer } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.INT_PORT || 8867);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const PASS = process.env.WP_PASS || '';
const SOURCE = readFileSync(join(ROOT, 'Waypoint-v1.html'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

if (!PASS) { console.log('FAIL  no WP_PASS in the environment'); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'wp-int-'));
const FILE = join(dir, 'workbench.json');
const disk = () => readWorkspaceFile(FILE);

/* ------------------------------------------------------- the pre-rename book --
   Deliberately shaped like a file written by the OLD code: the collection is
   `meetings`, and its timeline entries say `k:'meeting'`. If this suite seeded
   `interactions` it would prove nothing at all, because it would never exercise
   the compatibility path it exists to guard. */
const OLD_ROWS = [
  { id: 'm1', c: 'c1', t: 'Kick-off workshop', d: '2026-09-10', loc: 'Their office',
    att: 'Aminah binti Hassan', ours: 'Teh Bin Shun', sum: 'Scoped the migration.',
    out: 'Proposal by October.', k: 'Meeting' },
  /* This one is a CALL, not a meeting. §17 is the reason it can exist without
     the collection lying about what it holds — and the reason the script must
     leave `k` alone. */
  { id: 'm2', c: 'c1', t: 'Budget check-in', d: '2026-09-12', loc: '',
    att: '', ours: 'Kelvin Teh', sum: '', out: 'Budget moves to Q1.', k: 'Call' },
  { id: 'm3', c: 'c2', t: 'Security review', d: '2026-09-14', loc: 'Online',
    att: 'Raj Kumar', ours: 'Jayden Lu', sum: 'Went through the questionnaire.',
    out: 'They will return it signed.', k: 'Email' },
];

const seed = {
  schemaVersion: 1, setupComplete: true,
  users: [], credentials: {}, logs: [], audit: [], files: [], watch: [],
  customers: [
    { id: 'c1', name: 'Alpha Manufacturing', industry: 'Manufacturing', owner: 'Teh Bin Shun',
      health: 'OK', stance: 'Undecided', opps: [], contacts: [], apps: [], team: [], pains: [],
      timeline: [
        { d: '2026-09-10', k: 'meeting', t: 'Kick-off workshop', x: 'Scoped the migration.' },
        { d: '2026-09-13', k: 'note', t: 'Sent the questionnaire', x: 'No reply yet.' },
      ] },
    { id: 'c2', name: 'Beta Logistics', industry: 'Logistics', owner: 'Teh Bin Shun',
      health: 'OK', stance: 'Undecided', opps: [], contacts: [], apps: [], team: [], pains: [],
      timeline: [
        { d: '2026-09-14', k: 'meeting', t: 'Security review', x: 'Signed return promised.' },
        { d: '2026-09-15', k: 'opp', t: 'Cloud migration', x: 'Created · Interested' },
      ] },
  ],
  /* THE OLD KEY. Not `interactions` — that is the point. */
  meetings: OLD_ROWS,
  steps: [], team: [], opps: {}, products: [],
};

/* THE BOOK IS NOT EMPTY, SO IT NEEDS A DOOR.
   `identify()` opens the front door only when there are NO PASSWORDS AND NO
   CUSTOMERS. A file with three customers and no credentials is treated as a
   broken deploy and answered with 401 — deliberately, because that is exactly
   the shape a deploy that dropped `data/` produces. So the seeded book carries
   a real administrator, hashed with the same PBKDF2 parameters the server
   verifies against; anything else would be testing the refusal instead of the
   rename. */
{
  const salt = randomBytes(16);
  const at = new Date().toISOString();
  seed.users = [{ id: 'u_int', name: 'Int Admin', role: 'admin', title: 'admin', locked: false, createdAt: at, updatedAt: at }];
  seed.credentials = {
    u_int: {
      userId: 'u_int', algo: 'pbkdf2-sha256', iterations: 150_000,
      salt: salt.toString('base64'),
      hash: pbkdf2Sync(PASS, salt, 150_000, 32, 'sha256').toString('base64'),
      createdAt: at, updatedAt: at,
    },
  };
  seed.team = [{ n: 'Int Admin', r: 'Senior SA', f: 'ADMIN', role: 'admin', last: '—', st: 'Active' }];
}
writeFileSync(FILE, JSON.stringify(seed));

let srv;
try {
  srv = await startServer({
    spawnBin: process.execPath,
    args: [join(ROOT, 'server', 'server.mjs')],
    env: { ...process.env, WB_DATA_DIR: dir, PORT: String(PORT), WB_TLS: '0' },
    port: PORT,
  });
} catch (e) {
  console.log('FAIL  ' + e.message);
  process.exit(1);
}
srv.stderr.on('data', (d) => { const s = String(d); if (/Error/.test(s)) console.log('[server] ' + s.trim()); });
const bye = () => { try { srv.kill(); } catch { /* gone */ } };
process.on('exit', bye);

/* ------------------------------------------------------------ one browser -- */
let cookie = '';
async function api(path, opts = {}) {
  const res = await fetch(ORIGIN + path, {
    ...opts, redirect: 'manual',
    headers: { Origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
  });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map((s) => s.split(';')[0]).join('; ');
  return res;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ========================================================================== */
console.log('\n— §17: a pre-rename workspace —');

/* 1 · it still OPENS. The window is the front door for a workspace with no
       password and no customers; here there are customers, so sign in first. */
{
  const r = await api('/api/session');
  check('the sign-in screen answers on an un-migrated workspace', r.status === 200, 'HTTP ' + r.status);
}
/* Bootstrap with a real sign-in, which is the only path a real deploy takes. */
{
  const res = await fetch(ORIGIN + '/api/login', {
    method: 'POST',
    headers: { Origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'Int Admin', password: PASS }),
  });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map((s) => s.split(';')[0]).join('; ');
  check('the workspace can be entered', res.status === 200, 'HTTP ' + res.status);
}

const read = await api('/api/data');
check('the book is readable', read.status === 200, 'HTTP ' + read.status);
const state = (await read.json()).state || {};

/* THE COMPATIBILITY ASSERTION. An un-migrated workspace must hand its rows
   over under the NEW key, or the Interactions screen comes up empty on a
   workspace that has three rows in it — which reads as data loss to the
   person looking at it. */
check('the old rows arrive under the new name',
  Array.isArray(state.interactions) && state.interactions.length === 3,
  'interactions=' + (Array.isArray(state.interactions) ? state.interactions.length : 'absent'));
check('and they are the same rows, not placeholders',
  (state.interactions || []).some((m) => m.t === 'Kick-off workshop')
  && (state.interactions || []).some((m) => m.t === 'Security review'));
check('the row classifier is untouched by the rename',
  (state.interactions || []).some((m) => m.k === 'Call'));

/* 2 · it still SAVES, and the save migrates. A validator that insisted on the
       new key would 400 here and freeze the workspace. */
const before = (await (await api('/api/data')).json()).rev;
const put = await api('/api/data', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    state: { ...state, interactions: state.interactions },
    baseRev: before,
  }),
});
check('an un-migrated workspace can still be saved', put.status === 200,
  'HTTP ' + put.status + ' ' + (put.status !== 200 ? JSON.stringify(await put.json()).slice(0, 160) : ''));

const after = disk();
check('the save put the rows on disk under the new key',
  Array.isArray(after.interactions) && after.interactions.length === 3,
  'interactions=' + (Array.isArray(after.interactions) ? after.interactions.length : 'absent'));
check('and retired the old key rather than leaving a duplicate',
  !('meetings' in after),
  Object.keys(after).filter((k) => /meeting|interaction/.test(k)).join(','));

/* 3 · an un-migrated client is not destroyed by the server's patience. A page
       that has not been updated still sends `meetings`; the migration must not
       run on that payload, because the rows it would delete are the rows it
       was supposed to move. */
{
  const d2 = mkdtempSync(join(tmpdir(), 'wp-int2-'));
  const f2 = join(d2, 'workbench.json');
  writeFileSync(f2, JSON.stringify(seed));
  const PORT2 = PORT + 1;
  let srv2 = null;
  try {
    srv2 = await startServer({
      spawnBin: process.execPath,
      args: [join(ROOT, 'server', 'server.mjs')],
      env: { ...process.env, WB_DATA_DIR: d2, PORT: String(PORT2), WB_TLS: '0' },
      port: PORT2,
    });
    let ck = '';
    const api2 = async (path, opts = {}) => {
      const res = await fetch('http://127.0.0.1:' + PORT2 + path, {
        ...opts, redirect: 'manual',
        headers: { Origin: 'http://127.0.0.1:' + PORT2, ...(ck ? { cookie: ck } : {}), ...(opts.headers || {}) },
      });
      const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (sc.length) ck = sc.map((s) => s.split(';')[0]).join('; ');
      return res;
    };
    await api2('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'Int Admin', password: PASS }),
    });
    const b = await (await api2('/api/data')).json();
    /* Send the state back exactly as an OLD client would: rows under
       `meetings`, no `interactions` key at all. */
    const legacyPayload = { ...b.state };
    delete legacyPayload.interactions;
    legacyPayload.meetings = b.state.meetings || b.state.interactions;
    const r2 = await api2('/api/data', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: legacyPayload, baseRev: b.rev }),
    });
    await wait(200);
    const d2s = readWorkspaceFile(f2);
    const rows = (d2s.interactions || d2s.meetings || []);
    check('an un-updated client does not lose the rows it still calls meetings',
      r2.status === 200 && rows.length === 3,
      'HTTP ' + r2.status + ' rows=' + rows.length);
  } catch (e) {
    check('an un-updated client does not lose the rows it still calls meetings', false, e.message);
  } finally {
    try { srv2 && srv2.kill(); } catch { /* gone */ }
  }
}

/* 4 · the migration script, on a copy of the same pre-rename file. The script
       reports its own result, so this compares the FILE to the file rather
       than believing the report. */
console.log('\n— §17: the migration script —');
{
  const md = mkdtempSync(join(tmpdir(), 'wp-mig-'));
  const mf = join(md, 'workbench.json');
  writeFileSync(mf, JSON.stringify(seed));

  const run = (extra = []) => execFileSync(process.execPath,
    [join(ROOT, 'scripts', 'migrate-interactions.mjs'), ...extra],
    { cwd: ROOT, env: { ...process.env, WB_DATA_DIR: md }, encoding: 'utf8' });

  /* Dry run writes nothing. */
  const dry = run();
  const dryFile = readWorkspaceFile(mf);
  check('the dry run reports the rows it found', /meetings\s*:\s*3 row/.test(dry));
  check('and it writes nothing at all',
    Array.isArray(dryFile.meetings) && !Array.isArray(dryFile.interactions));

  const applied = run(['--apply']);
  check('the applied run reports success', /✔ migrated and confirmed/.test(applied));
  const mfState = readWorkspaceFile(mf);

  check('every row survived the move',
    Array.isArray(mfState.interactions) && mfState.interactions.length === 3,
    'interactions=' + (Array.isArray(mfState.interactions) ? mfState.interactions.length : 'absent'));
  const sameRows = JSON.stringify(
    [...(mfState.interactions || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  ) === JSON.stringify([...OLD_ROWS].sort((a, b) => String(a.id).localeCompare(String(b.id))));
  check('and they are byte-identical — nothing was rewritten on the way through', sameRows);
  check('the old key is gone', !('meetings' in mfState));

  const tl = (mfState.customers || []).flatMap((c) => c.timeline || []);
  check('the timeline entries were retagged', tl.filter((t) => t.k === 'interaction').length === 2,
    'interaction=' + tl.filter((t) => t.k === 'interaction').length);
  check('and no entry still says meeting', tl.filter((t) => t.k === 'meeting').length === 0);
  check('the entries that were never interactions are left alone',
    tl.some((t) => t.k === 'note') && tl.some((t) => t.k === 'opp'));
  check('the row classifier is NOT retagged — a Call is still a Call',
    (mfState.interactions || []).some((m) => m.k === 'Call'));

  /* Idempotence: a second run must be a no-op, not a second rewrite. */
  const again = run(['--apply']);
  check('running it twice is a no-op, not a second rewrite',
    /already migrated/.test(again), again.trim().split('\n').pop());

  /* Everything else in the file is untouched. */
  check('the customers were not disturbed',
    JSON.stringify(mfState.customers.map((c) => c.id)) === JSON.stringify(seed.customers.map((c) => c.id)));
}

/* 5 · the page source itself. Cheap, and it catches the half-rename: the
       collection switched but a stray call site still reading the old key. */
console.log('\n— §17: the source —');
check('the page reads the new collection', /D\.interactions/.test(SOURCE));
check('and no longer reads the old one', !/D\.meetings\b/.test(SOURCE));
check('nothing in the page writes the old key back',
  !/s\.meetings\s*=/.test(SOURCE) && !/'meetings'\s*\]/.test(SOURCE));
check('the signed-in shell knows the new screen name',
  /screenInteractions/.test(SOURCE) && /k:\s*'interactions'/.test(SOURCE));

console.log('\n' + pass + ' passed, ' + fail + ' failed  (' + (pass + fail) + ' checks)\n');
bye();
process.exit(fail ? 1 : 0);
