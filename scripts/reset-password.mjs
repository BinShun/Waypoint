/**
 * Reset one user's sign-in password in a RELOCATED, ENCRYPTED workspace.
 *
 * WHY THIS IS NOT `set-password.mjs`
 * ----------------------------------
 * `set-password.mjs` hardcodes `<project>/data/workbench.json` and reads it with
 * a bare `JSON.parse`. Both assumptions are false for the published workspace:
 *
 *   1. The live book does not live in the project directory. It is wherever
 *      `WB_DATA_DIR` points, and the project's own `data/` is the local demo
 *      book. Aimed at the live workspace, `set-password.mjs` would cheerfully
 *      rewrite the wrong file and report success — a silent no-op on the thing
 *      the operator was trying to fix.
 *   2. The live file is sealed (`WBENC1.` prefix). `JSON.parse` on it throws,
 *      so the failure would at least be loud — but only after the wrong-file
 *      bug had already been introduced by the first assumption.
 *
 * So this script takes the data directory as an argument, reads and writes
 * through the project's own `server/seal.mjs` (the one place the file format is
 * defined), and refuses to do anything unless it can prove the file it is about
 * to edit is the file the running server is serving.
 *
 * It reuses the same PBKDF2 parameters as the server, so `verifyPassword`
 * accepts the result unchanged.
 *
 * USAGE
 *   WB_DATA_DIR=/path/to/data WB_DATA_KEY=… \
 *     node scripts/reset-password.mjs --user u_teh --password 'the-new-one'
 *
 * SAFETY
 *   - Writes a timestamped backup beside the data before touching anything.
 *   - Atomic write (temp + rename), so a reader never sees a partial file.
 *   - Bumps the revision, so an open browser tab MERGES instead of replacing
 *     the file with its stale copy.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { readWorkspaceFile, dataKey, seal, ENC_PREFIX } from '../server/seal.mjs';

/* Must match src/lib/auth.ts and server/server.mjs exactly. */
const ALGO = 'pbkdf2-sha256';
const KEY_LEN = 32;
const SALT_LEN = 16;
const ITERATIONS = 150_000;

/* The same policy the app enforces, so the new password is not rejected at sign-in. */
function passwordIssues(p) {
  const out = [];
  if (!p) out.push('Password is required');
  if (p.length < 8) out.push('At least 8 characters');
  if (!/[a-zA-Z]/.test(p)) out.push('Include at least one letter');
  if (!/[0-9]/.test(p)) out.push('Include at least one number');
  return out;
}

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const who = arg('user');
const password = arg('password');

if (!who || !password) {
  console.error('usage: WB_DATA_DIR=… node scripts/reset-password.mjs --user "<id or name>" --password "<new password>"');
  process.exit(2);
}

const problems = passwordIssues(password);
if (problems.length) {
  console.error('That password does not meet the policy the app enforces:');
  problems.forEach((p) => console.error('  - ' + p));
  process.exit(2);
}

/* Resolve the data directory the same way the server does: WB_DATA_DIR wins,
   otherwise the project default. Printing it is the point — an operator should
   never have to guess which book was edited. */
const DATA_DIR = process.env.WB_DATA_DIR
  ? resolve(process.env.WB_DATA_DIR)
  : resolve(process.cwd(), 'data');
const DATA_FILE = join(DATA_DIR, 'workbench.json');
const REV_FILE = join(DATA_DIR, 'workbench.rev.json');
const BACKUP_DIR = join(DATA_DIR, 'backups');

if (!existsSync(DATA_FILE)) {
  console.error(`✘ no data file at ${DATA_FILE}`);
  process.exit(1);
}

const sealed = readFileSync(DATA_FILE, 'utf8').startsWith(ENC_PREFIX);
if (sealed && !dataKey()) {
  console.error(
    `✘ ${DATA_FILE} is encrypted but WB_DATA_KEY is not set.\n` +
    `  Refusing to touch it: writing now would replace the sealed file with plain text.`,
  );
  process.exit(1);
}

let state;
try {
  state = readWorkspaceFile(DATA_FILE);
} catch (e) {
  console.error(`✘ could not read ${DATA_FILE}: ${e.message}`);
  process.exit(1);
}
if (!state || typeof state !== 'object') {
  console.error(`✘ ${DATA_FILE} holds no workspace state.`);
  process.exit(1);
}

const users = Array.isArray(state.users) ? state.users : [];
const user = users.find((u) => u.id === who)
  || users.find((u) => String(u.name ?? '').toLowerCase() === who.toLowerCase())
  || users.find((u) => String(u.name ?? '').toLowerCase().includes(who.toLowerCase()));

if (!user) {
  console.error(`✘ no user matching "${who}". Known users:`);
  users.forEach((u) => console.error(`    ${u.id}  ${u.name}  (${u.role})`));
  process.exit(1);
}
/* Ambiguous substring matches are how the wrong person gets a new password. */
const loose = users.filter((u) => String(u.name ?? '').toLowerCase().includes(who.toLowerCase()));
if (loose.length > 1 && !users.some((u) => u.id === who)) {
  console.error(`✘ "${who}" matches more than one person. Use the exact id:`);
  loose.forEach((u) => console.error(`    ${u.id}  ${u.name}  (${u.role})`));
  process.exit(1);
}

const now = new Date().toISOString();

/* Back up first: this rewrites the one file everything lives in. */
mkdirSync(BACKUP_DIR, { recursive: true });
const backup = join(BACKUP_DIR, `workbench.json.before-reset-${Date.now()}`);
copyFileSync(DATA_FILE, backup);

const salt = randomBytes(SALT_LEN);
const hash = pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, 'sha256');

state.credentials = state.credentials ?? {};
const existing = state.credentials[user.id];
state.credentials[user.id] = {
  userId: user.id,
  algo: ALGO,
  iterations: ITERATIONS,
  salt: salt.toString('base64'),
  hash: hash.toString('base64'),
  createdAt: existing?.createdAt ?? now,
  updatedAt: now,
};
/* The app reads "no credentials at all" as a fresh install. */
state.setupComplete = true;

state.logs = Array.isArray(state.logs) ? state.logs : [];
state.logs.unshift({
  id: `l_pw_${Date.now()}`,
  at: now,
  action: 'update',
  entityType: 'auth',
  entityId: user.id,
  summary: `Password reset for ${user.name} from the command line`,
});

/* Write through the project's own format so encryption is preserved exactly. */
const key = dataKey();
const body = JSON.stringify(state);
const out = key ? ENC_PREFIX + seal(Buffer.from(body, 'utf8'), key).toString('base64') : body;
const tmp = `${DATA_FILE}.${process.pid}.${Date.now().toString(36)}.tmp`;
writeFileSync(tmp, out, 'utf8');
renameSync(tmp, DATA_FILE);

/* Bump the revision so an open tab MERGES instead of replacing with its stale copy. */
let rev = 0;
try {
  const n = Number(JSON.parse(readFileSync(REV_FILE, 'utf8'))?.rev);
  if (Number.isFinite(n) && n > 0) rev = n;
} catch { /* no rev file yet */ }
const revTmp = `${REV_FILE}.${process.pid}.tmp`;
writeFileSync(revTmp, JSON.stringify({ rev: rev + 1, savedAt: now }), 'utf8');
renameSync(revTmp, REV_FILE);

/* Prove the write actually took, by reading the file back and checking the
   stored hash against the password we just set. "The script said done" is not
   evidence; a PBKDF2 comparison against the bytes on disk is. */
const verify = readWorkspaceFile(DATA_FILE);
const saved = verify?.credentials?.[user.id];
const check = saved
  ? pbkdf2Sync(password, Buffer.from(saved.salt, 'base64'), saved.iterations, KEY_LEN, 'sha256')
  : null;
const ok = !!check && check.length === Buffer.from(saved.hash, 'base64').length
  && check.equals(Buffer.from(saved.hash, 'base64'));

console.log(`data dir  : ${DATA_DIR}`);
console.log(`sealed    : ${sealed ? 'yes' : 'no'}`);
console.log(`user      : ${user.name} (${user.id}, ${user.role})`);
console.log(`backup    : ${backup}`);
console.log(`revision  : ${rev} -> ${rev + 1}`);
console.log(`verified  : ${ok ? '✔ the stored hash matches the new password' : '✘ VERIFY FAILED'}`);
process.exit(ok ? 0 : 1);
