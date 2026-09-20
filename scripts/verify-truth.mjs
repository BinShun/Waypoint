/**
 * Data-truth guards for the Waypoint server.
 *
 * The other suites ask "does the server hold its guards" and "does one
 * colleague stay out of another's records". This one asks a different kind of
 * question: is the number on the screen actually true?
 *
 * The case that started it: an opportunity's `age` — the days it has sat in
 * its current stage — was a field the CLIENT wrote once at creation as `0`
 * and never touched again. Every deal on the board therefore claimed "0 days
 * in stage" for its whole life, which quietly turned the stalled-deal column,
 * the "30d" warning and the board's sort order into fiction. The one number
 * the board uses to say "this needs attention" was always zero.
 *
 * So the server owns the clock now. It stamps WHEN a deal entered its stage,
 * and derives the days on every read. These checks are the ones that fail if
 * anybody ever lets a client assert the number again.
 *
 * Runs against a throwaway workspace in a temp directory on a spare port, so
 * nothing here can touch real data.
 *
 * Usage: node scripts/verify-truth.mjs
 */
import { spawn } from 'node:child_process';
import { claimPort } from './harness.mjs';
import crypto from 'node:crypto';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkspace } from '../server/seal.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 8823);
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
      try { body = await res.json(); } catch { /* not json */ }
      return { status: res.status, body };
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

const TMP = mkdtempSync(join(tmpdir(), 'cwb-truth-'));
const srv = await spawnServer(PORT, { WB_DATA_DIR: TMP });

const T0 = new Date().toISOString();
/* The deal was last touched five days ago, and carries no `stageAt` — which is
   exactly the shape every deal already on disk has. */
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

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
  users: [{ id: 'u_a', name: 'Ada Admin', role: 'admin', createdAt: T0, updatedAt: T0 }],
  credentials: { u_a: makeCred('u_a', 'admin-pass-1') },
  customers: [{ id: 'c1', name: 'Alice Bank', owner: 'Ada Admin', createdAt: T0, updatedAt: T0 }],
  stages: ['Interested', 'Qualified', 'Won', 'Lost'],
  opps: {
    o1: {
      id: 'o1', c: 'c1', t: 'Core banking refresh', stage: 'Interested',
      v: 100000, p: 10, age: 0, owner: 'Ada Admin', comp: '-', close: '',
      cust: '', desc: '', updatedAt: daysAgo(5),
    },
  },
};

writeFileSync(join(TMP, 'workbench.json'), JSON.stringify(seed));
writeFileSync(join(TMP, 'workbench.rev.json'), JSON.stringify({ rev: 1 }));

if (!(await waitUp(BASE, srv.log))) { srv.child.kill(); process.exit(1); }

const b = browser(BASE);
const login = await b.call('/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId: 'u_a', password: 'admin-pass-1' }),
});
check('the administrator signs in', login.status === 200 && login.body?.ok, 'HTTP ' + login.status);

const read = () => b.call('/api/data').then((r) => r.body);
const put = async (mutate) => {
  const cur = await read();
  const next = mutate(cur.state);
  const r = await b.call('/api/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Base-Rev': String(cur.rev) },
    body: JSON.stringify({ state: next, baseRev: cur.rev }),
  });
  return { r, cur };
};

/* ------------------------------------------------- 1. the number is derived */

section('the age is derived, not asserted');

let st = (await read()).state;
check('a deal last touched five days ago reads five days', st.opps.o1.age === 5,
  'age=' + st.opps.o1.age);
check('and the seed said zero — the server replaced it', seed.opps.o1.age === 0,
  'the client had written ' + seed.opps.o1.age);

/* A client that simply asserts a number must not be believed: reporting is
   fine, asserting is not, and there is no way to tell them apart except by
   ignoring what was sent. */
await put((s) => ({ ...s, opps: { ...s.opps, o1: { ...s.opps.o1, age: 999 } } }));
st = (await read()).state;
check('a client that claims 999 days is not believed', st.opps.o1.age === 5, 'age=' + st.opps.o1.age);

/* ------------------------------------------- 2. the clock survives a save */

section('the stage clock');

/* Saving anything else — a value, a description — must NOT restart the clock.
   A deal does not become new because somebody corrected its amount. */
await put((s) => ({ ...s, opps: { ...s.opps, o1: { ...s.opps.o1, v: 250000 } } }));
st = (await read()).state;
check('changing the value does not make the deal young again', st.opps.o1.age === 5,
  'age=' + st.opps.o1.age);
check('and the change itself was saved', st.opps.o1.v === 250000, 'v=' + st.opps.o1.v);
check('the date the stage was entered is now on the record', !!st.opps.o1.stageAt,
  st.opps.o1.stageAt ?? 'still missing');

/* Moving the stage IS a new chapter: the clock has to restart. */
await put((s) => ({ ...s, opps: { ...s.opps, o1: { ...s.opps.o1, stage: 'Qualified' } } }));
st = (await read()).state;
const today = new Date().toISOString().slice(0, 10);
check('moving the stage restarts the clock', st.opps.o1.age === 0, 'age=' + st.opps.o1.age);
check('and stamps today as the day it happened', st.opps.o1.stageAt === today,
  st.opps.o1.stageAt ?? 'none');
check('the stage really moved', st.opps.o1.stage === 'Qualified', st.opps.o1.stage);

/* ------------------------------------------- 3. it is on the disk, not just
   in the response — a workspace opened by any other tool must read the same. */

section('and it is written down');

await put((s) => s);
/* Read the file the way any other tool would: sealed files get opened with the
   key that wrote them, plain ones are just JSON. `verify:all` hands every suite
   a throwaway WB_DATA_KEY, so the server here may well have encrypted the
   workspace — and a bare JSON.parse on a sealed file dies with a SyntaxError
   that says nothing about the real cause. */
const onDisk = parseWorkspace(
  await (await import('node:fs')).promises.readFile(join(TMP, 'workbench.json'), 'utf8'),
);
check('the stage date survives on the disk', !!onDisk.opps?.o1?.stageAt,
  onDisk.opps?.o1?.stageAt ?? 'missing');
check('and the disk carries the derived number too', onDisk.opps?.o1?.age === 0,
  'age=' + (onDisk.opps?.o1?.age ?? '?'));

srv.child.kill();
rmSync(TMP, { recursive: true, force: true });

console.log(`\n${ran} checks run.${pass ? '  all passed' : '  *** FAILURES ***'}`);
console.log(pass ? 'RESULT: PASS - the numbers on the board are true' : 'RESULT: FAIL');
process.exit(pass ? 0 : 1);
