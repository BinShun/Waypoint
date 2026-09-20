/**
 * Set (or reset) the sign-in password for one user, straight in data/workbench.json.
 *
 * WHY THIS EXISTS
 * ---------------
 * Passwords are stored as PBKDF2-HMAC-SHA256 hashes with a per-user salt, so a
 * forgotten one cannot be read back - not by the app, not by the server, not by
 * anybody with the file. The only way forward is to write a NEW hash. This is
 * that write.
 *
 * It reproduces exactly what src/lib/auth.ts does in the browser
 * (algo `pbkdf2-sha256`, 16-byte salt, 32-byte key, 150,000 iterations, both
 * base64), so the server's own `verifyPassword` accepts the result unchanged.
 *
 * USAGE
 *   node scripts/set-password.mjs --user "Teh Bin Shun" --password 'the-new-one'
 *   node scripts/set-password.mjs --user u_admin --password 'the-new-one'
 *
 * `--user` matches the id exactly, or the name case-insensitively.
 *
 * BEFORE YOU RUN IT
 *   Close every browser tab that has the workbench open. A tab holding an older
 *   state will push that state back on its next save, and `credentials` is one
 *   of the collections an administrator's write is allowed to replace - which
 *   would quietly undo this. The revision is bumped so a tab that is still open
 *   MERGES instead of replacing, but closing them is the real protection.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = resolve(__dirname, '..', 'data', 'workbench.json');
const REV_FILE = resolve(__dirname, '..', 'data', 'workbench.rev.json');
const BACKUP_DIR = resolve(__dirname, '..', 'data', 'backups');

/* Must match src/lib/auth.ts and server/server.mjs. */
const ALGO = 'pbkdf2-sha256';
const KEY_LEN = 32;
const SALT_LEN = 16;
const ITERATIONS = 150_000;

/* Same policy as passwordIssues() in src/lib/auth.ts. */
function passwordIssues(password) {
  const issues = [];
  if (!password) issues.push('Password is required');
  if (password.length < 8) issues.push('At least 8 characters');
  if (!/[a-zA-Z]/.test(password)) issues.push('Include at least one letter');
  if (!/[0-9]/.test(password)) issues.push('Include at least one number');
  return issues;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const who = arg('user');
const password = arg('password');

if (!who || !password) {
  console.error('usage: node scripts/set-password.mjs --user "<id or name>" --password "<new password>"');
  process.exit(2);
}

const problems = passwordIssues(password);
if (problems.length) {
  console.error('That password does not meet the policy the app enforces:');
  problems.forEach((p) => console.error('  - ' + p));
  process.exit(2);
}

const stamp = () => new Date().toISOString();

if (!existsSync(DATA_FILE)) {
  console.error('no data file at ' + DATA_FILE);
  process.exit(1);
}

const state = JSON.parse(readFileSync(DATA_FILE, 'utf8'));

const users = Array.isArray(state.users) ? state.users : [];
const user = users.find((u) => u.id === who)
  || users.find((u) => String(u.name ?? '').toLowerCase() === who.toLowerCase())
  || users.find((u) => String(u.name ?? '').toLowerCase().includes(who.toLowerCase()));

if (!user) {
  console.error(`no user matching "${who}". Known users:`);
  users.forEach((u) => console.error(`  ${u.id}  ${u.name}  (${u.role})`));
  process.exit(1);
}

/* Back up first: this rewrites the one file everything lives in. */
mkdirSync(BACKUP_DIR, { recursive: true });
const backup = resolve(BACKUP_DIR, `workbench.json.before-password-${Date.now()}`);
writeFileSync(backup, JSON.stringify(state), 'utf8');

const salt = randomBytes(SALT_LEN);
const hash = pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, 'sha256');
const now = stamp();

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
/* The app treats "no credentials at all" as a fresh install, so make sure the
   workspace is still marked as set up. */
state.setupComplete = true;

state.logs = Array.isArray(state.logs) ? state.logs : [];
state.logs.unshift({
  id: `l_pw_${Date.now()}`,
  at: now,
  action: 'update',
  entityType: 'auth',
  entityId: user.id,
  summary: `Password ${existing ? 'reset' : 'set'} for ${user.name} from the command line`,
});

/* Atomic write: the server never sees a half-written file. */
const tmp = `${DATA_FILE}.${process.pid}.tmp`;
writeFileSync(tmp, JSON.stringify(state), 'utf8');
renameSync(tmp, DATA_FILE);

/* Bump the revision so a tab that is still open MERGES rather than replacing
   the file with its own stale copy. */
let rev = 0;
try {
  const j = JSON.parse(readFileSync(REV_FILE, 'utf8'));
  const n = Number(j?.rev);
  if (Number.isFinite(n) && n > 0) rev = n;
} catch { /* no rev file yet - start at 0 */ }
const revTmp = `${REV_FILE}.${process.pid}.tmp`;
writeFileSync(revTmp, JSON.stringify({ rev: rev + 1, savedAt: now }), 'utf8');
renameSync(revTmp, REV_FILE);

console.log(`done.`);
console.log(`  user      : ${user.name} (${user.id}, ${user.role})`);
console.log(`  backup    : ${backup}`);
console.log(`  data file : ${DATA_FILE}`);
console.log(`  revision  : ${rev} -> ${rev + 1}`);
console.log('');
console.log('Sign in with the new password. If the server is running it picks the file up');
console.log('on the next request; reload the page in the browser before signing in.');
