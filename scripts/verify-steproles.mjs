/* verify:steproles — §5/§6: a Next Step has two people on it, and the server
   is the one that decides.

   WHY THIS IS ITS OWN SUITE
   -------------------------
   The brief is explicit that the customer-level rules must be enforced by the
   BACKEND, not by hiding a control in the UI: "must be enforced at API level,
   not by UI hiding". A Tracker who is not the account's Primary BD or Primary
   SA is exactly that kind of rule. If the only thing stopping a bad Tracker is
   the dropdown in `ADD_SPEC.steps` not offering them, then anyone with curl
   can write one — and the record will look correct forever after.

   So this suite never touches the HTML. It talks to the server directly and
   tries to write the things that must not be writable, then checks that the
   file on disk was genuinely left alone. That is the difference between a rule
   and a suggestion.

   Run: WP_PASS=<password> npm run verify:steproles
   It works in a temp workspace it creates itself, so it never touches real data. */
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkspaceFile } from './disk.mjs';
import { startServer } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.STEP_PORT || 8863);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const PASS = process.env.WP_PASS || '';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

if (!PASS) { console.log('FAIL  no WP_PASS in the environment'); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'wp-step-'));
const disk = () => readWorkspaceFile(join(dir, 'workbench.json'));

/* An account with exactly one Primary BD and one Primary SA, as §2 requires,
   and one step row that is legal — the baseline everything else is compared
   against. Nothing here is a fixture of convenience: it is the smallest book
   the rule can be exercised against. */
const CID = 'c1';
const SID = 's1';

/* THE WORKSPACE STARTS GENUINELY EMPTY, AND THAT IS NOT A CONVENIENCE.
   `identify()` opens the front door only when there are NO PASSWORDS AND NO
   CUSTOMERS — a file with customers in it and no credentials is treated as a
   broken deploy and answered with 401, on purpose (see the comment there).
   Writing the customer into the file first, as this suite used to, meant the
   window was already shut and every request came back "Sign in to the shared
   workspace." The book is therefore created THROUGH THE API below, which is
   also the only path a real deployment ever takes. */
const seed = {
  schemaVersion: 1, setupComplete: true,
  users: [], credentials: {}, logs: [], audit: [], files: [], watch: [],
  products: [], interactions: [], customers: [], opps: {}, steps: [], team: [],
  config: { stages: ['Interested', 'Won', 'Lost'] },
};
writeFileSync(join(dir, 'workbench.json'), JSON.stringify(seed), 'utf8');

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

/* One browser's worth of cookies. */
let cookie = '';
const api = async (path, opts = {}) => {
  const res = await fetch(ORIGIN + path, {
    ...opts, redirect: 'manual',
    headers: { ...(opts.headers || {}), Origin: ORIGIN, ...(cookie ? { cookie } : {}) },
  });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map((s) => s.split(';')[0]).join('; ');
  return res;
};
const json = async (path, opts = {}) => {
  const r = await api(path, opts);
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

/* ------------------------------------------- first-run admin, then sign in */
{
  const created = await json('/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Rule Admin', email: 'rule.admin@example.test', role: 'admin', password: PASS }),
  });
  check('a first administrator can be created', created.status === 200 && !!created.user,
    'HTTP ' + created.status);
  const login = await json('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: created.user?.id, password: PASS }),
  });
  check('and can sign in', login.status === 200 && login.ok === true, 'HTTP ' + login.status);
}

/* Establish the revision, then BUILD THE BOOK through the API — the customer
   with its two owners, and one legal step row. Nothing is written to the file
   behind the server's back, so what is tested below is reachable exactly the
   way a real client reaches it. */
let rev = 0;
const read = async () => (await json('/api/data'));
const put = async (state, extra = {}) => {
  const r = await json('/api/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Base-Rev': String(rev) },
    body: JSON.stringify({ state, baseRev: rev, ...extra }),
  });
  if (r.rev) rev = r.rev;
  return r;
};
{
  const r = await read();
  rev = r.rev || 0;
  check('the empty workspace is readable', r.status === 200 && !!r.state, 'HTTP ' + r.status);
}

/* The account §2 describes: exactly one Primary BD and one Primary SA. */
const baselineCustomer = {
  id: CID, name: 'Rule Test Bhd', industry: 'Retail', hq: 'KL', size: '~10',
  stance: 'Undecided', health: 'Watch',
  owner: 'Primary BD', sa: 'Primary SA', since: '2026-01', site: '',
  logo: '', people: '', brief: '', pains: [], contacts: [], apps: [],
  opps: [], timeline: [], support: [], team: [], demo: false,
  unverified: false, links: [], sources: [], updatedAt: new Date().toISOString(),
};
const baselineStep = {
  id: SID, c: CID, o: null, t: 'Baseline legal step',
  exec: 'Primary BD', track: 'Primary BD',
  due: '2026-12-01', from: 'us', p: 'p1',
  done: '', doneBy: '', doneNote: '',
};
{
  const r0 = await read();
  const state = { ...r0.state, customers: [baselineCustomer], steps: [baselineStep] };
  const r = await put(state);
  check('the account and one legal step can be created',
    r.status === 200 && r.ok === true, 'HTTP ' + r.status + (r.error ? ' — ' + r.error : ''));
  check('and the customer is on disk with both owners',
    (disk().customers || []).some((c) => c.id === CID && c.owner === 'Primary BD' && c.sa === 'Primary SA'),
    (disk().customers || []).map((c) => c.name + '(' + c.owner + '/' + c.sa + ')').join(', ') || 'none');
}

/* Build the state a client would send, by copying what it just read — the same
   shape the real app PUTs, which is the path under test. */
const withStep = (patch) => {
  const base = JSON.parse(JSON.stringify(disk()));
  base.steps = base.steps.map((s) => (s.id === SID ? { ...s, ...patch } : s));
  return base;
};

/* ========================================================================== */
/*  1. The legal baseline must be accepted, or nothing below proves anything.  */
/* ========================================================================== */
{
  const r = await put(withStep({ track: 'Primary SA' }));
  check('a Tracker who IS the account\u2019s Primary SA is accepted',
    r.status === 200 && r.ok === true, 'HTTP ' + r.status + (r.error ? ' — ' + r.error : ''));
  const on = (disk().steps || []).find((s) => s.id === SID);
  check('and the Tracker really landed on disk', on && on.track === 'Primary SA',
    on ? String(on.track) : 'gone');
}

/* ========================================================================== */
/*  2. The rule: a Tracker outside the account team is refused.                */
/* ========================================================================== */
{
  const before = disk();
  const r = await put(withStep({ track: 'Somebody Else' }));
  check('a Tracker who is NOT on the account team is refused',
    r.status === 400 && r.ok !== true, 'HTTP ' + r.status);
  check('the refusal names the offending Tracker and both owners',
    /Somebody Else/.test(r.error || '') && /Primary BD/.test(r.error || '') && /Primary SA/.test(r.error || ''),
    String(r.error || '').slice(0, 110));
  check('the refusal carries its own code, not a generic one',
    r.code === 'tracker-not-on-account', String(r.code));

  const after = disk();
  check('NOTHING was written to the file',
    JSON.stringify(after.steps) === JSON.stringify(before.steps),
    'the step rows are byte-identical');
}

/* ========================================================================== */
/*  3. §6: a completed step keeps who did it, who tracked it, and when.        */
/* ========================================================================== */
{
  /* Execution Owner and Tracker are DIFFERENT people, and the Execution Owner
     is deliberately NOT on the account team — a Product SA. This is Scenario 3
     from the brief, and it is the shape a single `o` field could never carry. */
  const r = await put(withStep({
    exec: 'David Tan (Product SA)',
    track: 'Primary SA',
    done: '2026-09-19',
    doneBy: 'David Tan (Product SA)',
    doneNote: 'Architecture note sent.',
  }));
  check('a Non-Core Member may EXECUTE while the account\u2019s SA tracks',
    r.status === 200 && r.ok === true, 'HTTP ' + r.status + (r.error ? ' — ' + r.error : ''));

  const row = (disk().steps || []).find((s) => s.id === SID);
  check('the completed row survives the save', !!row);
  check('it keeps its completion date', row && row.done === '2026-09-19', row ? String(row.done) : 'gone');
  check('it keeps who completed it', row && row.doneBy === 'David Tan (Product SA)', row ? String(row.doneBy) : 'gone');
  check('it keeps the original Execution Owner', row && row.exec === 'David Tan (Product SA)', row ? String(row.exec) : 'gone');
  check('it keeps the Tracker', row && row.track === 'Primary SA', row ? String(row.track) : 'gone');
  check('it keeps its note', row && row.doneNote === 'Architecture note sent.', row ? String(row.doneNote) : 'gone');
}

/* ========================================================================== */
/*  4. A step row must still point at a customer that exists.                  */
/* ========================================================================== */
{
  const before = disk();
  const ghost = JSON.parse(JSON.stringify(before));
  ghost.steps = [...ghost.steps, {
    id: 's_ghost', c: 'c_does_not_exist', t: 'Orphan', exec: 'Primary BD', track: 'Primary BD',
    due: '', from: 'us', p: 'p1', done: '', doneBy: '', doneNote: '',
  }];
  const r = await put(ghost);
  check('a step pointing at a customer that does not exist is refused',
    r.status === 400 && r.ok !== true, 'HTTP ' + r.status);
  check('the orphan step never reaches the file',
    !(disk().steps || []).some((s) => s.id === 's_ghost'));
}

/* ========================================================================== */
/*  5. The old single-field row must still be readable, not rejected.          */
/* ========================================================================== */
{
  /* Rows written before the two-role change carry only `o`. They are not
     invalid — they are un-migrated — and a rule that rejected them would make
     the workspace unwritable the moment it was upgraded.
     `o` is the EXECUTION owner, and §5 lets the execution owner be anybody,
     so such a row has made no tracker claim at all. The server must therefore
     skip it rather than read `o` as a Tracker. Doing the latter is not
     enforcement, it is invention: a real book holding rows executed by
     somebody who is not the account's BD would have every save refused. */
  const legacy = withStep({ track: undefined, exec: undefined, o: 'Primary BD' });
  legacy.steps = legacy.steps.map((s) => {
    if (s.id !== SID) return s;
    const { track, exec, ...rest } = s;
    return { ...rest, o: 'Primary BD' };
  });
  const r = await put(legacy);
  check('a row carrying only the old single owner is still accepted',
    r.status === 200 && r.ok === true, 'HTTP ' + r.status + (r.error ? ' — ' + r.error : ''));
  const row = (disk().steps || []).find((s) => s.id === SID);
  check('and it is read as tracking that person', row && (row.track || row.exec || row.o) === 'Primary BD',
    row ? JSON.stringify({ o: row.o, exec: row.exec, track: row.track }) : 'gone');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed  (' + (pass + fail) + ' checks)\n');
process.exit(fail ? 1 : 0);
