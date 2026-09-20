/* backup:live — copy the workspace off the running app BEFORE a deploy.
 *
 * WHY THIS EXISTS
 * ---------------
 * A deploy uploads this directory. `data/` is in .gitignore with a paragraph
 * explaining why it must never ride along — and the deploy tool does not read
 * .gitignore. So on 17 Sep a redeploy replaced the live workspace (25,719 bytes
 * of customer records) with this machine's empty 640-byte skeleton, and there
 * was no copy of it anywhere. The guard was a comment.
 *
 * So: take the copy first, every time, and refuse to continue if it cannot be
 * taken. A deploy that cannot be preceded by a backup is a deploy to postpone.
 *
 * The backup lands OUTSIDE the project directory, for the same reason the key
 * does — a backup inside the folder you are about to upload is not a backup.
 *
 * Run from customer-workbench/:
 *   WP_PASS=… node scripts/backup-live.mjs [https://host]
 */
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = (process.argv[2] || process.env.WP_HOST || 'https://waypoint.app-tencent.workbuddy.host').replace(/\/+$/, '');
const PASS = process.env.WP_PASS || 'Waypoint#2026';
const OUT = join(ROOT, '..', '.live-backups');

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
  console.error('✘ cannot reach ' + HOST + ' — no backup was taken. Do not deploy.');
  process.exit(1);
}

const me = dirList.users.find((u) => u.role === 'admin') || dirList.users[0];
const login = await call('/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId: me.id, password: PASS }),
});
if (!login.ok) {
  console.error(`✘ sign-in failed (HTTP ${login.status}) — no backup was taken. Do not deploy.`);
  process.exit(1);
}

const data = await call('/api/data');
if (!data.ok) {
  console.error(`✘ could not read the workspace (HTTP ${data.status}) — no backup was taken. Do not deploy.`);
  process.exit(1);
}
const text = await data.text();
const state = JSON.parse(text).state || {};
const rows = Object.values(state).reduce((a, v) => a + (Array.isArray(v) ? v.length : 0), 0);

mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = join(OUT, `waypoint-${stamp}.json`);
writeFileSync(file, text);

console.log(`✔ ${HOST}`);
console.log(`  rows on record : ${rows}  (${(state.customers || []).length} customers)`);
console.log(`  saved to       : ${file}`);
console.log(`  ${statSync(file).size} bytes`);
if (rows < 5 && !(state.customers || []).length) {
  console.log('\n⚠ the live workspace looks empty. That is either correct or the last deploy already');
  console.log('  clobbered it — check the backups in this folder before you go any further.');
}
console.log('\nNow deploy — and then `npm run restore:live`, because a deploy empties');
console.log('the live workspace and only this file has the copy. See restore-live.mjs.');
