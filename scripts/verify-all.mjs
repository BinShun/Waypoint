/* verify:all — one command, every suite, one verdict.
 *
 * WHY THIS EXISTS
 * ---------------
 * The suites grew one at a time, each answering a question the others do not:
 * does the server hold its guards, is the encryption real, does a concurrent
 * save lose work, does the page actually run in a DOM, does the model really
 * get asked, may a Manager really not write. Remembering to run nine commands
 * is how one of them quietly stops being run at all.
 *
 * Nothing here is skipped for being slow, and a suite that cannot run — a
 * missing password, a port in use — is reported as a failure rather than
 * quietly passed over.
 *
 * Run from customer-workbench/:  WP_PASS=… npm run verify:all
 */
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* One app, one source: `Waypoint-v1.html`. Before anything runs, stage it
   into dist/ exactly as a deploy would — a suite that loads a stale copy is
   a suite that passes on code nobody shipped. */
{
  const { writeFileSync, mkdirSync, readFileSync, existsSync } = await import('node:fs');
  const { join: j } = await import('node:path');
  const appHtml = j(ROOT, 'Waypoint-v1.html');
  if (!existsSync(appHtml)) {
    console.log(`[verify:all] FAIL — ${appHtml} is missing; nothing to verify.`);
    process.exit(1);
  }
  mkdirSync(j(ROOT, 'dist'), { recursive: true });
  writeFileSync(j(ROOT, 'dist', 'index.html'), readFileSync(appHtml, 'utf8'));
}

const SUITES = [
  ['dead', 'scripts/verify-dead.mjs', 'nothing on screen is pretending'],
  ['server', 'scripts/verify-server.mjs', 'the data server holds its guards'],
  ['isolation', 'scripts/verify-isolation.mjs', 'the book stays inside its own covers'],
  ['truth', 'scripts/verify-truth.mjs', 'the numbers on the board are true'],
  ['security', 'scripts/verify-security.mjs', 'encryption, headers, lockout'],
  ['acid', 'scripts/verify-acid.mjs', 'a save is atomic'],
  ['roster', 'scripts/verify-roster.mjs', 'the roster survives a save'],
  ['live', 'scripts/verify-live.mjs', 'the page runs in a DOM'],
  ['newflows', 'scripts/verify-newflows.mjs', 'every flow, end to end'],
  ['steproles', 'scripts/verify-steproles.mjs', 'a Next Step\u2019s two people, enforced by the server'],
  ['opportunity', 'scripts/verify-opportunity.mjs', 'the deal screen has two views and no drifting form'],
  ['healthreason', 'scripts/verify-healthreason.mjs', '\u00a710/\u00a713: the health word is never shown alone'],
  ['interactions', 'scripts/verify-interactions.mjs', '\u00a717: the rename kept every row it moved'],
  ['import', 'scripts/verify-import.mjs', '\u00a726: the import carries real relationships, or it stops'],
  ['calendar', 'scripts/verify-calendar.mjs', '\u00a719: a time view you can walk into, not a picture'],
  ['routes', 'scripts/verify-routes.mjs', 'the address bar is a real address, and not a way in'],
  ['secfindings', 'scripts/verify-secfindings.mjs', '\u00a736: the security findings, kept fixed'],
  ['ai', 'scripts/verify-ai.mjs', 'the model really is asked'],
  ['copilot', 'scripts/verify-copilot.mjs', '§31 T1–T6: the acceptance walkthrough, end to end'],
  ['copilot-scope', 'scripts/verify-copilot-scope.mjs', '§4: the AI layer never sees what the caller cannot'],
  ['ai-tasks', 'scripts/verify-ai-tasks.mjs', '§21–§23: the task table holds under fire'],
  ['roles', 'scripts/verify-roles.mjs', 'four roles, CAN and MUST-NOT'],
  ['journey', 'scripts/verify-journey.mjs', 'a real day, per role, without getting stuck'],
  ['scenarios', 'scripts/verify-scenarios.mjs', 'the four acceptance journeys, executed'],
  ['encryption', 'scripts/verify-encryption.mjs', 'the file cannot be read off the disk'],
];

if (!process.env.WP_PASS) {
  console.log('[verify:all] WP_PASS is not set — using the shipped password. Set it to test another.');
} else {
  /* Fail fast, in plain words, on a password the server will refuse anyway.
     The suites create administrators and sign pages in with WP_PASS, and the
     server demands 8+ characters with a letter and a number — so a one-off
     `WP_PASS=x` used to surface as forty misleading failures across four
     suites (admin creation 400s, page logins "Incorrect password", fixtures
     collapsing into TypeErrors) that read like the product had broken, when
     the only thing broken was the test run's own credential. A guard that
     names the cause in one line beats an evening of forensics. */
  const p = process.env.WP_PASS;
  const why = [];
  if (p.length < 8) why.push('at least 8 characters');
  if (!/[a-zA-Z]/.test(p)) why.push('a letter');
  if (!/[0-9]/.test(p)) why.push('a number');
  if (why.length) {
    console.log(`[verify:all] FAIL — WP_PASS is set but the server would refuse it (needs ${why.join(', ')}).`);
    console.log('             Every suite that creates an account or signs a page in with it would go red for this alone.');
    process.exit(1);
  }
}
/* The encryption suite needs a key; it is the one suite that cannot run without
   one. Rather than skip it — a skipped suite is a suite nobody believes — give
   it a throwaway key when the environment has none. It proves the mechanism,
   which is the part that can break; it is not the key that guards real data. */
const DATA_KEY = process.env.WB_DATA_KEY || randomBytes(32).toString('base64');
if (!process.env.WB_DATA_KEY) {
  console.log('[verify:all] WB_DATA_KEY is not set — encryption runs on a throwaway key.');
  console.log('             Run with the real key to prove the shipped file is sealed.');
}

const results = [];
const unreadable = [];
for (const [name, file, claim] of SUITES) {
  const t0 = Date.now();
  /* A throwaway key goes to ONE suite: `encryption`, which exists to prove the
     seal works and cannot run without something to seal with. Every other suite
     gets an explicitly EMPTY key, and that is not tidiness.
   *
   * A suite that spins up its own server over its own temp workspace and reads
   * the file to check what was saved must not have a key in its environment.
   * With one, the server encrypts that throwaway file, and the suite's own
   * assertion — "the customer on disk is X", "the meeting is saved", "the
   * record the BD reads is the one the SA wrote" — reads ciphertext or fails to
   * parse it. Encryption is symmetric, so most checks survive: the same key
   * writes and reads, and the product behaves correctly throughout. Only the
   * checks that look at the FILE break, which is why this surfaced as a
   * handful of unrelated-looking failures rather than as a wave.
   *
   * It surfaced while verifying an unrelated change, and it was intermittent:
   * `verify:all` mints a random key per run, so the same suite passes or fails
   * depending on nothing the developer did. A suite that is only sometimes
   * right is worse than one that is always wrong — it teaches people to re-run
   * instead of read. `secrecy of the real file` is `encryption`'s job, and it
   * still gets the key.
   *
   * This bug was already known and fixed by hand, four separate times —
   * `verify-secfindings` carries a comment explaining it at its own server
   * call, and `roster`, `truth` and `server` clear the key too. Eleven other
   * suites never learned. Setting it once, here, is the version of that fix
   * that cannot be forgotten by the next suite somebody writes. */
  const key = (name === 'encryption') ? DATA_KEY : '';
  const r = spawnSync(process.execPath, [join(ROOT, file)], {
    cwd: ROOT,
    env: { ...process.env, WP_PASS: process.env.WP_PASS || 'Waypoint#2026', WB_DATA_KEY: key },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  /* Three ways a suite says how many checks it ran, because they were written
     at different times: `N passed, M failed  (T checks)`, `N checks, all PASS`,
     and `T checks run`. Only the first two patterns were understood, so the
     suites that use the third — `roster` and `secfindings` — reported `?` and
     their checks were quietly left out of the total, which is why the headline
     count had been understating the suite for weeks. `TOTAL_RE` is the
     parenthesised total, which is the one number that is right in all three. */
  const TOTAL_RE = /\((\d+)\s+checks?\)/;
  const counts = [...out.matchAll(/(\d+)\s+(?:checks?\s+run|checks?,\s*all\s+PASS|passed)/g)].map((m) => Number(m[1]));
  const totalMatch = out.match(TOTAL_RE);
  const ran = totalMatch ? Number(totalMatch[1]) : (counts[0] ?? null);
  const failedLine = out.split('\n').find((l) => /^\s*\d+ failed/.test(l.trim()));
  const failed = failedLine ? Number(failedLine.match(/(\d+) failed/)[1]) : (r.status === 0 ? 0 : 1);
  results.push({ name, claim, ok: r.status === 0, failed, ran, ms: Date.now() - t0, out });
  const mark = r.status === 0 ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name.padEnd(10)} ${String(ran ?? '?').padStart(4)} checks  ${(Date.now() - t0) / 1000}s  — ${claim}`);
  /* A suite whose count could not be read is reported as such rather than as a
     `?` that nobody notices: the number is the only evidence that the suite
     actually did something. */
  if (ran === null) unreadable.push(name);
}

console.log('');
if (unreadable.length) {
  console.log(`NOTE — ${unreadable.length} suite(s) did not report how many checks they ran: ${unreadable.join(', ')}.`);
  console.log('       Their pass/fail is still real; the total below is short by their count.');
}
const bad = results.filter((r) => !r.ok);
if (!bad.length) {
  console.log(`ALL GREEN — ${results.length} suites, ${results.reduce((a, r) => a + (r.ran || 0), 0)} checks.`);
  console.log('The application is in a working state.');
  process.exit(0);
}
console.log(`${bad.length} of ${results.length} suites failed:`);
for (const r of bad) {
  console.log(`\n----- ${r.name} -----`);
  const lines = r.out.split('\n').filter((l) => /FAIL|Error|error:/i.test(l));
  console.log(lines.slice(0, 12).join('\n') || '(no failure line found — read the log above)');
}
process.exit(1);
