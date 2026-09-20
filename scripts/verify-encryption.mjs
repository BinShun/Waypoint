/* verify:encryption — the workspace file cannot be read off the disk.
 *
 * WHY THIS EXISTS
 * ---------------
 * One JSON file is the whole product: every customer, every note, every person's
 * stance. If that file can be opened with a text editor the security work
 * upstream of it is decoration — one copied file and none of the role rules
 * apply any more.
 *
 * The awkward part is the switch-over, and that is most of what this suite
 * covers: a workspace saved BEFORE the key existed must not be orphaned by
 * turning it on. So the order is asserted, not assumed — plain file, read it,
 * write it, and only then must it be sealed.
 *
 * Run from customer-workbench/:  npm run verify:encryption
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { claimPort } from './harness.mjs';
import { adminSeed, signIn } from './verify-auth.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8861;
const KEY = process.env.WB_DATA_KEY || '';
const ORIGIN = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!KEY) {
  console.log('FAIL  WB_DATA_KEY is not set — nothing to test.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'wp-enc-'));
const file = join(dir, 'workbench.json');
/* One administrator is seeded up front: the workspace holds rows from the
   first byte, so the anonymous setup window is closed and every read and write
   here has to carry a session. The FILE FORMAT is what is under test — the
   suite signs in only so the format is the thing being measured. */
writeFileSync(file, JSON.stringify({
  schemaVersion: 1, setupComplete: true, logs: [], ...adminSeed(),
}, null, 1));

/* This suite reboots the server several times on the SAME port — stop it,
   start it without the key, start it again with one. Each boot therefore has to
   wait for the previous process to actually release the port before it can
   spawn, or it collides with its own predecessor. That is what the claim is
   for, and it is why boot() is async. */
async function boot(port, withKey) {
  const env = { ...process.env, WB_DATA_DIR: dir, PORT: String(port), WB_TLS: '0', WB_ORIGINS: ORIGIN };
  if (withKey) { env.WB_DATA_KEY = KEY; env.WB_REQUIRE_ENCRYPTION = '1'; }
  else { delete env.WB_DATA_KEY; delete env.WB_REQUIRE_ENCRYPTION; }
  await claimPort(port);
  const srv = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = { text: '' };
  srv.stdout.on('data', (d) => { log.text += d; });
  srv.stderr.on('data', (d) => { log.text += d; });
  return { srv, log };
}

/* ------------------------------------------------- with the key, from plain */
const a = await boot(PORT, true);
for (let i = 0; i < 60; i++) { try { if ((await fetch(ORIGIN + '/api/health')).ok) break; } catch { /* not yet */ } await wait(150); }

const auth = await signIn(ORIGIN);
check('the suite is signed in', auth.ok, auth.ok ? 'as u_teh' : 'HTTP ' + auth.status);

const before = readFileSync(file, 'utf8');
check('the workspace starts as an ordinary plain file', !before.startsWith('WBENC1.'), before.length + ' bytes');

const read = await (await fetch(ORIGIN + '/api/data', { headers: { cookie: auth.cookie } })).text();
check('a plain file saved before the key existed is still readable', read.includes('schemaVersion'));

const put = await fetch(ORIGIN + '/api/data', {
  method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, cookie: auth.cookie },
  body: JSON.stringify({
    state: { schemaVersion: 1, customers: [{ id: 'c1', name: 'NusaTel Berhad' }] },
  }),
});
check('the first write succeeds', put.status === 200, 'HTTP ' + put.status);

const after = readFileSync(file, 'utf8');
check('and that write seals the file', after.startsWith('WBENC1.'));
check('the sealed file is no longer JSON', (() => { try { JSON.parse(after); return false; } catch { return true; } })());
check('no customer name is readable in the file', !after.includes('NusaTel'));

const back = await (await fetch(ORIGIN + '/api/data', { headers: { cookie: auth.cookie } })).text();
check('and the server still reads it back', back.includes('NusaTel Berhad'));
check('the server says encryption is on', /encryption at rest: ON/.test(a.log.text));
a.srv.kill();
await wait(400);

/* --------------------------------------------------------- without the key */
const b = await boot(PORT + 1, false);
await wait(1200);
/* Not /api/health — that route only stats the file and never decrypts it, so it
   answers happily and would hide the entire point of this suite. */
const noKey = await fetch('http://127.0.0.1:' + (PORT + 1) + '/api/data').catch(() => null);
const body = noKey ? await noKey.text() : '';
b.srv.kill();
check('without the key the data cannot be served', !noKey || noKey.status !== 200 || !body.includes('NusaTel'),
  noKey ? 'HTTP ' + noKey.status : 'no answer');
check('no customer name ever comes back', !String(body).includes('NusaTel'));
check('and it says why, in words someone can act on',
  /WB_DATA_KEY is not set|encrypted but|Could not decrypt/.test(b.log.text));
/* The keyless server is entitled to report "encryption at rest: OFF" — it was
   started without a key, and saying so loudly is the correct behaviour. What
   must NOT happen is the file being rewritten in the clear: that would turn one
   misconfigured restart into permanent, silent exposure. */
const stillSealed = readFileSync(file, 'utf8');
check('a keyless start never rewrites the file in the clear', stillSealed.startsWith('WBENC1.'));
check('and the ciphertext is untouched by it', stillSealed === after);

console.log(`\n${pass} passed, ${fail} failed  (${pass + fail} checks)`);
process.exit(fail ? 1 : 0);
