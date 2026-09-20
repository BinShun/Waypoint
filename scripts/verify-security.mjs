/**
 * Prove the transport and storage guards hold, and that each check can fail.
 *
 * A security assertion that has never gone red is not evidence — every check
 * below is written so that removing the guard makes it fail. Two of them went
 * red on the first run — a redirect that was not carrying HSTS, and an
 * undecryptable file whose error said "unable to authenticate data" instead of
 * naming the key. Both were real, and both were fixed because of it.
 *
 * Spare ports, throwaway data directories, nothing touches `data/`.
 *
 * Run from customer-workbench/:  npm run verify:security
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';

let ran = 0, pass = true;
const check = (name, cond, detail) => {
  ran++;
  if (!cond) pass = false;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${detail}` : ''}`);
};

const BASE_PORT = 8810;
const KEY_A = Buffer.alloc(32, 7).toString('base64');
const KEY_B = Buffer.alloc(32, 9).toString('base64');
const STATE = { schemaVersion: 1, users: [{ id: 'u1', name: 'Kelvin Lim', role: 'admin' }] };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function up(port, env, dir) {
  const p = spawn(process.execPath, ['server/server.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: env.HOST || '127.0.0.1', WB_DATA_DIR: dir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  p.stderr.on('data', (d) => { err += d.toString(); });
  p.stdout.on('data', (d) => { err += d.toString(); });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return { p, log: () => err };
    } catch { /* not yet */ }
    await wait(120);
  }
  console.log('!! server never came up:\n' + err);
  p.kill();
  throw new Error('server did not start');
}

const down = (s) => { try { s.p.kill(); } catch { /* gone */ } };

const get = (port, path, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers });
const put = (port, path, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

function lanIp() {
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return null;
}

const ip = lanIp();
/* TLS has to be off for the CSRF phase: with certs present the server answers a
   non-loopback connection by redirecting to https, and the 308 happens before
   the request ever reaches the handler, so it would not exercise the check. */
const noCerts = mkdtempSync(join(tmpdir(), 'wbnocerts-'));

/* ------------------------------------------------------------------ 1. headers */
console.log('\n=== security headers ===');
const dirA = mkdtempSync(join(tmpdir(), 'wbsec-'));
let dirB = null;
/* 0.0.0.0 so the LAN-address checks below can connect "from outside". */
let s = await up(BASE_PORT, { HOST: '0.0.0.0' }, dirA);
try {
  const r = await get(BASE_PORT, '/api/health', { Origin: `http://127.0.0.1:${BASE_PORT}` });
  const h = r.headers;
  check('CSP present', !!h.get('content-security-policy'), h.get('content-security-policy')?.slice(0, 60) + '…');
  check('CSP blocks exfiltration (connect-src \'self\')', /connect-src 'self'/.test(h.get('content-security-policy') || ''));
  check('CSP blocks framing', /frame-ancestors 'none'/.test(h.get('content-security-policy') || ''));
  check('nosniff', h.get('x-content-type-options') === 'nosniff');
  check('referrer-policy', h.get('referrer-policy') === 'no-referrer');
  check('X-Frame-Options DENY', h.get('x-frame-options') === 'DENY');
  check('permissions-policy present', !!h.get('permissions-policy'));
  check('no HSTS over plain http', h.get('strict-transport-security') === null);

  /* the negative: a stranger's Origin is refused outright */
  const bad = await get(BASE_PORT, '/api/health', { Origin: 'https://evil.example' });
  check('cross-origin read refused', bad.status === 403, `status ${bad.status}`);

  /* HSTS is only ever sent on a connection that is actually encrypted. This
     server has certs, so a non-loopback plain-http request is redirected. */
  if (!ip) {
    console.log('SKIP  HSTS-on-redirect: no LAN address to connect from');
  } else {
    const redirManual = await fetch(`http://${ip}:${BASE_PORT}/api/health`, {
      redirect: 'manual', headers: { Origin: `http://${ip}:${BASE_PORT}` },
    }).catch(() => null);
    check('non-loopback http is redirected to https', redirManual?.status === 308, `status ${redirManual?.status}`);
    check('the redirect itself carries HSTS',
      redirManual?.headers.get('strict-transport-security')?.includes('max-age') === true,
      redirManual?.headers.get('strict-transport-security') ?? 'none');
    check('the redirect also carries CSP', !!redirManual?.headers.get('content-security-policy'));
  }

  /* rate limit: hammer the health endpoint */
  let got429 = false, retryAfter = 0;
  for (let i = 0; i < 700; i++) {
    const rr = await get(BASE_PORT, '/api/health', { Origin: `http://127.0.0.1:${BASE_PORT}` });
    if (rr.status === 429) { got429 = true; retryAfter = Number(rr.headers.get('retry-after')); break; }
  }
  check('rate limit trips', got429, got429 ? `429 after a flood, Retry-After ${retryAfter}s` : 'never tripped');
} finally { down(s); }

/* ---------------------------------------------------------------------- 2. CSRF */
console.log('\n=== CSRF (a write must say where it came from) ===');
if (!ip) {
  console.log('SKIP  no LAN address - cannot make a non-loopback connection on this machine');
} else {
  dirB = mkdtempSync(join(tmpdir(), 'wbsec-'));
  s = await up(BASE_PORT + 1, { HOST: '0.0.0.0', WB_CERT_DIR: noCerts }, dirB);
  try {
    /* same request, two sources: loopback is a script we allow, a LAN peer
       with no Origin is a browser we cannot place, so it is refused. */
    const local = await put(BASE_PORT + 1, '/api/data', STATE);
    check('loopback write with no Origin allowed (curl / file:// copy)', local.status === 200, `status ${local.status}`);

    const peerOk = await fetch(`http://${ip}:${BASE_PORT + 1}/api/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: `http://${ip}:${BASE_PORT + 1}` },
      body: JSON.stringify(STATE),
    });
    check('LAN write WITH its own Origin allowed', peerOk.status === 200, `status ${peerOk.status}`);

    const peer = await fetch(`http://${ip}:${BASE_PORT + 1}/api/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(STATE),
    });
    check('LAN write with NO Origin refused', peer.status === 403, `status ${peer.status}`);
  } finally { down(s); }
}

/* -------------------------------------------------------- 3. encryption at rest */
console.log('\n=== encryption at rest ===');
const dirC = mkdtempSync(join(tmpdir(), 'wbsec-'));

/* 3a. no key: plain file, and the server says so */
s = await up(BASE_PORT + 2, {}, dirC);
try {
  await put(BASE_PORT + 2, '/api/data', STATE);
  const raw = readFileSync(join(dirC, 'workbench.json'), 'utf8');
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* expected when encrypted */ }
  check('without WB_DATA_KEY the file is plain JSON', parsed !== null);
  check('startup warns that encryption is off', /encryption at rest: OFF/.test(s.log()));
} finally { down(s); }

/* 3b. with a key: the file on disk is not readable */
const dirD = mkdtempSync(join(tmpdir(), 'wbsec-'));
s = await up(BASE_PORT + 3, { WB_DATA_KEY: KEY_A }, dirD);
try {
  await put(BASE_PORT + 3, '/api/data', STATE);
  const raw = readFileSync(join(dirD, 'workbench.json'), 'utf8');
  check('file is sealed', raw.startsWith('WBENC1.'), raw.slice(0, 24) + '…');
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* expected */ }
  check('file is NOT readable JSON without the key', parsed === null);
  check('no customer name survives in the file', !raw.includes('Kelvin Lim'));

  const back = await (await get(BASE_PORT + 3, '/api/data', { Origin: `http://127.0.0.1:${BASE_PORT + 3}` })).json();
  check('round-trips through the server', back?.state?.users?.[0]?.name === 'Kelvin Lim', JSON.stringify(back?.state?.users?.[0] ?? {}));
  check('startup reports encryption on', /encryption at rest: ON/.test(s.log()));
} finally { down(s); }

/* 3c. the wrong key must not silently serve unencrypted data */
s = await up(BASE_PORT + 4, { WB_DATA_KEY: KEY_B }, dirD);
try {
  const r = await get(BASE_PORT + 4, '/api/data', { Origin: `http://127.0.0.1:${BASE_PORT + 4}` });
  check('wrong key is refused, not ignored', r.status >= 500, `status ${r.status}`);
  const body = await r.json().catch(() => ({}));
  check('the error names the cause', /WB_DATA_KEY|decrypt|key/i.test(JSON.stringify(body)), JSON.stringify(body).slice(0, 120));
} finally { down(s); }

/* 3d. a plain file written before the key existed is upgraded, not orphaned */
const dirE = mkdtempSync(join(tmpdir(), 'wbsec-'));
writeFileSync(join(dirE, 'workbench.json'), JSON.stringify(STATE));
s = await up(BASE_PORT + 5, { WB_DATA_KEY: KEY_A }, dirE);
try {
  const before = await (await get(BASE_PORT + 5, '/api/data', { Origin: `http://127.0.0.1:${BASE_PORT + 5}` })).json();
  check('legacy plain file still readable', before?.state?.users?.[0]?.name === 'Kelvin Lim');
  await put(BASE_PORT + 5, '/api/data', { ...STATE, users: [{ id: 'u1', name: 'Kelvin Lim', role: 'admin' }, { id: 'u2', name: 'Siti', role: 'bd' }] });
  const raw = readFileSync(join(dirE, 'workbench.json'), 'utf8');
  check('upgraded to sealed on the next save', raw.startsWith('WBENC1.'));
} finally { down(s); }

/* 3e. production switch */
const dirF = mkdtempSync(join(tmpdir(), 'wbsec-'));
/* `WB_DATA_KEY` is cleared on purpose, not just left out. `verify:all` hands
   every suite a throwaway key through the environment, and a child that
   inherits it is a child that HAS a key — so the server this spawns starts
   happily, never exits, and the `await` below waits forever. The whole run
   hangs at "29 checks", which reads like a slow suite rather than a broken
   one. The check is "refuses to start WITHOUT a key", so the key has to be
   genuinely absent, whatever the parent happened to be carrying. */
const p = spawn(process.execPath, ['server/server.mjs'], {
  env: { ...process.env, WB_DATA_KEY: '', PORT: String(BASE_PORT + 6), HOST: '127.0.0.1',
         WB_DATA_DIR: dirF, WB_REQUIRE_ENCRYPTION: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
p.stderr.on('data', (d) => { out += d.toString(); });
p.stdout.on('data', (d) => { out += d.toString(); });
const code = await new Promise((r) => p.on('exit', r));
check('WB_REQUIRE_ENCRYPTION=1 refuses to start without a key', code !== 0, `exit ${code}`);
check('and says why', /WB_DATA_KEY/.test(out));

for (const d of [dirA, dirB, dirC, dirD, dirE, dirF].filter(Boolean)) {
  try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ }
}

console.log(`\n${ran} checks run. ${pass ? 'all passed' : 'FAILURES PRESENT'}`);
