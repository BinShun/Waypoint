/* restore:live — put a backup back into the running app AFTER a deploy.
 *
 * WHY THIS EXISTS
 * ---------------
 * `backup-live.mjs` takes the copy but nothing puts it back. A deploy uploads
 * this directory, `data/` never rides along, and the new sandbox boots an empty
 * workspace — so every publish quietly empties the live book. The backup is
 * only half a safety net until something restores it.
 *
 * This is the other half. It signs in as an administrator, reads the live
 * revision, and PUTs the backup state back with that revision so the server
 * takes the wholesale-replace path.
 *
 * It REFUSES to overwrite a live workspace that holds more than the backup,
 * unless you pass --force. Restoring an old file over newer work is exactly
 * the loss this script exists to prevent.
 *
 * Run from customer-workbench/:
 *   WP_PASS=… node scripts/restore-live.mjs [path-to-backup] [--force]
 *
 * With no path it takes the newest file in ../.live-backups/.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = (process.env.WP_HOST || 'https://waypoint.app-tencent.workbuddy.host').replace(/\/+$/, '');
const PASS = process.env.WP_PASS || 'Waypoint#2026';
const OUT = join(ROOT, '..', '.live-backups');
const FORCE = process.argv.includes('--force');

const argPath = process.argv.slice(2).find((a) => !a.startsWith('--'));

let file = argPath;
if (!file) {
  const all = readdirSync(OUT)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, m: statSync(join(OUT, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!all.length) {
    console.error(`✘ no backups in ${OUT} — nothing to restore.`);
    process.exit(1);
  }
  file = join(OUT, all[0].f);
}

let envelope;
try {
  envelope = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`✘ cannot read ${file}: ${e.message}`);
  process.exit(1);
}
const backupState = envelope && envelope.state ? envelope.state : envelope;
if (!backupState || typeof backupState !== 'object') {
  console.error('✘ that file holds no workspace state.');
  process.exit(1);
}

const countRows = (s) =>
  Object.values(s || {}).reduce((a, v) => a + (Array.isArray(v) ? v.length : 0), 0);
const backupRows = countRows(backupState);
const backupCustomers = (backupState.customers || []).length;

let cookie = '';
async function call(path, opts = {}) {
  const res = await fetch(HOST + path, {
    ...opts,
    redirect: 'manual',
    headers: { Origin: HOST, ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
  });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map((x) => x.split(';')[0]).join('; ');
  return res;
}

const dirList = await call('/api/directory').then((r) => r.json()).catch(() => null);
if (!dirList?.users?.length) {
  console.error('✘ cannot reach ' + HOST + ' — nothing was changed.');
  process.exit(1);
}
const admin = dirList.users.find((u) => u.role === 'admin') || dirList.users[0];
const login = await call('/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId: admin.id, password: PASS }),
});
if (!login.ok) {
  console.error(`✘ sign-in failed (HTTP ${login.status}) — nothing was changed.`);
  process.exit(1);
}

const before = await call('/api/data').then((r) => r.json());
const liveState = before.state || {};
const liveRows = countRows(liveState);
const liveCustomers = (liveState.customers || []).length;

console.log(`host   : ${HOST}`);
console.log(`backup : ${basename(file)}  — ${backupRows} rows, ${backupCustomers} customers`);
console.log(`live   : ${liveRows} rows, ${liveCustomers} customers`);

/* Refuse to trade newer work for an older copy. An empty live workspace is
   always safe to fill; a fuller one is a decision only --force should make. */
if (!FORCE && liveRows > backupRows) {
  console.error(
    `\n✘ the live workspace holds MORE than the backup (${liveRows} > ${backupRows}).\n` +
      '  Restoring would destroy newer work. Pass --force only if you are certain.'
  );
  process.exit(1);
}

const rev = Number(before.rev || 0);
const put = await call('/api/data', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'X-Base-Rev': String(rev) },
  body: JSON.stringify({ state: backupState, baseRev: rev, deleted: {} }),
});
const putBody = await put.json().catch(() => ({}));
if (!put.ok || putBody.ok === false) {
  console.error(`\n✘ the server refused the restore (HTTP ${put.status}).`);
  console.error('  ' + (putBody.error || JSON.stringify(putBody).slice(0, 300)));
  process.exit(1);
}

const after = await call('/api/data').then((r) => r.json());
const nowState = after.state || {};
const nowRows = countRows(nowState);
const nowCustomers = (nowState.customers || []).length;

console.log(`\nmode   : ${putBody.mode || 'replace'}  (rev ${rev} -> ${putBody.rev})`);
console.log(`after  : ${nowRows} rows, ${nowCustomers} customers`);
console.log(`  ${(nowState.customers || []).map((c) => c.name).join(', ') || '—'}`);
console.log(`  team ${(nowState.team || []).length} · audit ${(nowState.audit || []).length} · products ${(nowState.products || []).length}`);

if (nowCustomers !== backupCustomers || nowRows < backupRows) {
  console.error('\n✘ the restore did not land — live does not match the backup.');
  process.exit(1);
}
console.log('\n✔ restored.');
