/**
 * Prove that many people editing at once cannot lose each other's work.
 *
 * The write itself was already atomic (temp file → fsync → rename), and that
 * was the part everyone checks. The part that actually loses data is the
 * DECISION in front of the write: a PUT reads the revision, decides "nobody
 * else has written, so I am the whole truth", and writes. Two people doing
 * that in the same instant both read revision N and both write N+1. The
 * second one wins, the first person's edit is gone, no conflict is recorded,
 * and both browsers were told "saved".
 *
 * So this suite fires a burst of simultaneous saves from different users, each
 * touching a different customer, and then asks the only question that matters:
 * is every single one of those edits still on disk? It also checks the
 * revision climbed once per save — if two saves collide the counter moves once
 * for both, which is the fingerprint of the bug.
 *
 * Every check here is written so that removing the serialisation makes it go
 * red; `npm run verify:acid` is not evidence until it has been seen to fail.
 *
 * Spare ports, throwaway data directories, nothing touches `data/`.
 *
 * Run from customer-workbench/:  npm run verify:acid
 */
import { spawn } from 'node:child_process';
import { claimPort } from './harness.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkspaceFile } from './disk.mjs';
import { adminSeed, signIn } from './verify-auth.mjs';

let ran = 0, pass = true;
const check = (name, cond, detail) => {
  ran++;
  if (!cond) pass = false;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${detail}` : ''}`);
};

const PORT = Number(process.env.ACID_PORT || 8840);
const SERVER = process.env.ACID_SERVER || 'server/server.mjs';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function up(dir) {
  const p = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', WB_DATA_DIR: dir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
/* Wait for a port this process has PROVEN is free. Waiting on
   /api/health alone cannot fail when an old server is still listening,
   and the suite would then drive somebody else's server. See
   scripts/harness.mjs. */
await claimPort(PORT);
  let err = '';
  p.stderr.on('data', (d) => { err += d.toString(); });
  p.stdout.on('data', (d) => { err += d.toString(); });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return { p, log: () => err };
    } catch { /* not yet */ }
    await wait(120);
  }
  console.log('!! server never came up:\n' + err);
  p.kill();
  throw new Error('server did not start');
}

/* Every request carries the session cookie once there is one: after the first
   write the workspace is no longer empty, and an unsigned request is answered
   401 — which used to read as "the save was lost" when it was really
   "nobody was signed in". */
let cookie = '';
const api = (path, init) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init?.headers || {}),
    },
  });

const T0 = '2026-09-01T00:00:00.000Z';
const stamp = (i) => new Date(Date.parse(T0) + i * 1000).toISOString();

/** One customer per editor, so a correct merge keeps every one of them. */
const N = 12;
function seed() {
  return {
    schemaVersion: 1,
    ...adminSeed(),
    accounts: Array.from({ length: N }, (_, i) => ({
      id: `acc_${i}`,
      name: `Customer ${i}`,
      note: 'untouched',
      updatedAt: T0,
    })),
  };
}

/* A burst that collides can leave the file part-written. Report that as a
   FAIL — a suite that crashes instead of reporting is a suite nobody reads. */
function readStateSafe(dir) {
  try {
    return readWorkspaceFile(join(dir, 'workbench.json'));
  } catch (e) {
    return { __corrupt: e.message };
  }
}

const dir = mkdtempSync(join(tmpdir(), 'wb-acid-'));
const srv = await up(dir);
try {
  /* ---------------------------------------------------------- establish */
  let r = await api('/api/data', { method: 'PUT', body: JSON.stringify(seed()) });
  const first = await r.json();
  check('the workspace is created', r.status === 200 && first.mode === 'create', `mode=${first.mode}`);
  const baseRev = first.rev;
  check('a revision is handed back', Number.isFinite(baseRev) && baseRev > 0, `rev=${baseRev}`);

  /* The workspace now holds rows, so from here every write needs an account. */
  const auth = await signIn(`http://127.0.0.1:${PORT}`);
  cookie = auth.cookie;
  check('the suite is signed in', auth.ok && !!cookie, auth.ok ? 'as u_teh' : `HTTP ${auth.status}`);

  const base = seed();

  /* ------------------------------------------------- the simultaneous burst */
  /* Twelve people, twelve customers, one HTTP burst. Every request carries the
     SAME baseRev because every one of them read the file before any of them
     wrote it — which is exactly the state the lock has to survive. */
  const burst = await Promise.all(
    Array.from({ length: N }, (_, i) => {
      const state = JSON.parse(JSON.stringify(base));
      state.accounts[i].note = `edited by ${i}`;
      state.accounts[i].updatedAt = stamp(i + 1);
      return api('/api/data', {
        method: 'PUT',
        body: JSON.stringify({ state, baseRev }),
        headers: { 'X-Base-Rev': String(baseRev) },
      }).then(async (res) => ({ i, status: res.status, body: await res.json() }));
    })
  );

  check('every save is answered 200', burst.every((b) => b.status === 200),
    burst.filter((b) => b.status !== 200).map((b) => `${b.i}:${b.status}`).join(' ') || 'all 200');
  check('every save reports success', burst.every((b) => b.body.ok === true));

  /* ------------------------------------------------------------ the verdict */
  const final = readStateSafe(dir);
  check('the file is still valid JSON', !final.__corrupt, final.__corrupt || 'ok');
  const notes = Object.fromEntries(final.accounts.map((a) => [a.id, a.note]));

  const kept = Array.from({ length: N }, (_, i) => notes[`acc_${i}`] === `edited by ${i}`);
  const lostCount = kept.filter((k) => !k).length;
  check(`all ${N} simultaneous edits are on disk`, lostCount === 0,
    `${N - lostCount}/${N} kept${lostCount ? ` — lost: ${kept.map((k, i) => (k ? null : i)).filter((v) => v !== null).join(',')}` : ''}`);

  const revs = burst.map((b) => b.body.rev).filter((v) => Number.isFinite(v));
  const uniqueRevs = new Set(revs);
  check('each save got its own revision', uniqueRevs.size === N,
    `${uniqueRevs.size} distinct of ${N} — collisions: ${N - uniqueRevs.size}`);

  const revsAfter = await (await api('/api/health')).json().catch(() => ({}));
  const lastRev = Math.max(...revs);
  check('the revision climbed once per save', lastRev === baseRev + N,
    `${baseRev} -> ${lastRev} (expected ${baseRev + N})`);
  void revsAfter;

  /* ------------------------------------------- a second round, to be sure */
  /* One burst could pass by luck. Three in a row that keep everything is not
     luck, it is a lock. */
  let roundsOk = true;
  let rev = lastRev;
  for (let round = 0; round < 3; round++) {
    const snapshot = readStateSafe(dir);
    const rs = await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const state = JSON.parse(JSON.stringify(snapshot));
        state.accounts[i].note = `r${round} by ${i}`;
        state.accounts[i].updatedAt = stamp(1000 + round * 100 + i);
        return api('/api/data', {
          method: 'PUT',
          body: JSON.stringify({ state, baseRev: rev }),
          headers: { 'X-Base-Rev': String(rev) },
        }).then(async (res) => ({ i, body: await res.json() }));
      })
    );
    rev = Math.max(...rs.map((x) => x.body.rev).filter(Number.isFinite));
    const after = readStateSafe(dir);
    if (after.__corrupt || snapshot.__corrupt) { roundsOk = false; continue; }
    const ok = after.accounts.every((a, i) => a.note === `r${round} by ${i}`);
    if (!ok) roundsOk = false;
  }
  check('three more bursts, still nothing lost', roundsOk);

  /* ------------------------------------------------------- durability bits */
  const dirNow = (await import('node:fs')).readdirSync(dir);
  check('no temp file left behind', !dirNow.some((f) => /\.tmp$/.test(f)),
    dirNow.filter((f) => /\.tmp$/.test(f)).join(' ') || 'clean');
  const mode = (await import('node:fs')).statSync(join(dir, 'workbench.json')).mode & 0o777;
  check('the data file is still private to the server', mode === 0o600, '0' + mode.toString(8));
} finally {
  try { srv.p.kill(); } catch { /* gone */ }
  await wait(200);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${ran} checks run.  RESULT: ${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
