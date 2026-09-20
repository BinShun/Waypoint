/**
 * §17 — rename `meetings` to `interactions` in a workspace, on disk.
 *
 * WHY THIS IS A SCRIPT AND NOT A LINE OF SERVER CODE
 * --------------------------------------------------
 * The rename has two halves and they carry different risks.
 *
 *   - READING is safe to do lazily, so the server and the page accept the old
 *     key forever: a workspace that has not been migrated still opens, and
 *     still saves.
 *   - WRITING is where a mistake is permanent. Folding one collection into
 *     another on every request would mean the server rewriting customer data
 *     on a code path nobody is watching, triggered by any save, from any
 *     client. A migration belongs in a script somebody runs deliberately, that
 *     backs up first and proves what it did, not in a request handler.
 *
 * So the app is tolerant and this is decisive. The app reads both keys; this
 * collapses them to one and deletes the one that is left behind.
 *
 * WHAT IT DOES
 *   1. `meetings` rows move to `interactions` (merged by id — a row that
 *      exists under both keys appears once).
 *   2. Timeline entries with `k:'meeting'` become `k:'interaction'`. This is
 *      the SECOND, separate surface of the same rename: the timeline's `k`
 *      is a fact-type vocabulary, not the collection key, and it is easy to
 *      rename one and forget the other.
 *   3. `meetings` is removed as a key. Leaving both keys is the failure this
 *      script exists to fix: two collections holding the same rows, and every
 *      future reader has to guess which one is authoritative.
 *
 * Note what it does NOT touch: an interaction row's own `k` field (Meeting /
 * Call / Email / Video call). That is the classifier and it stays exactly as
 * it is — the rename broadened the container, not the contents.
 *
 * USAGE
 *   # dry run against the real data dir — prints what it would do, writes nothing
 *   WB_DATA_DIR=/path/to/data WB_DATA_KEY=… node scripts/migrate-interactions.mjs
 *
 *   # do it
 *   WB_DATA_DIR=/path/to/data WB_DATA_KEY=… node scripts/migrate-interactions.mjs --apply
 *
 * SAFETY
 *   - Dry run by default. `--apply` is required to write anything.
 *   - Copies the file to `<data>/backups/` before writing.
 *   - Refuses a sealed file when WB_DATA_KEY is unset, rather than replacing
 *     an encrypted workspace with plain text.
 *   - Atomic write (temp + rename), so a reader never sees a partial file.
 *   - Bumps the revision, so an open browser tab MERGES instead of replacing
 *     the file with its own stale copy.
 *   - Reads the file back afterwards and reports the row counts it finds, so
 *     "it said done" is never the only evidence.
 *   - Idempotent: run it twice and the second run finds nothing to do.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { readWorkspaceFile, dataKey, seal, ENC_PREFIX } from '../server/seal.mjs';

const APPLY = process.argv.includes('--apply');

/* Resolve the data directory the way the server does. Printing it is the
   point: an operator should never have to guess which book was edited. */
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

const raw = readFileSync(DATA_FILE, 'utf8');
const sealed = raw.startsWith(ENC_PREFIX);
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

/* ------------------------------------------------------------ the plan ---- */

const oldRows = Array.isArray(state.meetings) ? state.meetings : [];
const newRows = Array.isArray(state.interactions) ? state.interactions : [];
const byId = new Map();
for (const r of oldRows) if (r && r.id != null) byId.set(String(r.id), r);
for (const r of newRows) if (r && r.id != null) byId.set(String(r.id), r);
/* Rows with no id cannot be merged by id. Keep them, positioned after the
   identified ones, rather than dropping a record on the floor. */
const loose = [...oldRows, ...newRows].filter((r) => !r || r.id == null);
const merged = [...byId.values(), ...loose];

const tlOld = (state.customers || [])
  .reduce((a, c) => a + ((c.timeline || []).filter((t) => t && t.k === 'meeting').length), 0);

const nothingToDo = oldRows.length === 0
  && tlOld === 0
  && !('meetings' in state);

console.log(`data dir     : ${DATA_DIR}`);
console.log(`sealed       : ${sealed ? 'yes' : 'no'}`);
console.log(`meetings     : ${oldRows.length} row(s) under the old key`);
console.log(`interactions : ${newRows.length} row(s) under the new key`);
console.log(`  -> merged  : ${merged.length} row(s)`);
console.log(`timeline     : ${tlOld} entr(ies) with k:'meeting' -> k:'interaction'`);

if (nothingToDo) {
  console.log('\n✔ nothing to do — this workspace is already migrated.');
  process.exit(0);
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing was written. Re-run with --apply to migrate.');
  process.exit(0);
}

/* ----------------------------------------------------------- the write ---- */

/* Back up first: this rewrites the one file everything lives in. */
mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = join(BACKUP_DIR, `workbench.before-interactions-${stamp}.json`);
copyFileSync(DATA_FILE, backup);

let retagged = 0;
for (const c of (state.customers || [])) {
  if (!Array.isArray(c?.timeline)) continue;
  for (const t of c.timeline) {
    if (t && t.k === 'meeting') { t.k = 'interaction'; retagged += 1; }
  }
}

if (merged.length) state.interactions = merged;
else if (!('interactions' in state)) state.interactions = [];
delete state.meetings;

/* Write through the project's own format so encryption is preserved exactly. */
const key = dataKey();
const body = JSON.stringify(state);
const out = key ? ENC_PREFIX + seal(Buffer.from(body, 'utf8'), key).toString('base64') : body;
const tmp = `${DATA_FILE}.${process.pid}.${Date.now().toString(36)}.tmp`;
writeFileSync(tmp, out, 'utf8');
renameSync(tmp, DATA_FILE);

/* Bump the revision so an open tab MERGES instead of replacing with its own
   stale copy — which would put the old key straight back. */
let rev = 0;
try {
  const n = Number(JSON.parse(readFileSync(REV_FILE, 'utf8'))?.rev);
  if (Number.isFinite(n) && n > 0) rev = n;
} catch { /* no rev file yet */ }
const revTmp = `${REV_FILE}.${process.pid}.tmp`;
writeFileSync(revTmp, JSON.stringify({ rev: rev + 1, savedAt: new Date().toISOString() }), 'utf8');
renameSync(revTmp, REV_FILE);

/* Prove it, by reading the file back. */
const verify = readWorkspaceFile(DATA_FILE);
const vNew = Array.isArray(verify.interactions) ? verify.interactions.length : -1;
const vOld = 'meetings' in verify;
const vTl = (verify.customers || [])
  .reduce((a, c) => a + ((c.timeline || []).filter((t) => t && t.k === 'meeting').length), 0);

const ok = !vOld && vNew === merged.length && vTl === 0;

console.log(`backup       : ${backup}`);
console.log(`revision     : ${rev} -> ${rev + 1}`);
console.log(`retagged     : ${retagged} timeline entr(ies)`);
console.log(`read back    : interactions=${vNew}, old key present=${vOld}, stale timeline kinds=${vTl}`);
console.log(`verified     : ${ok ? '✔ migrated and confirmed on disk' : '✘ VERIFY FAILED — restore from the backup above'}`);
process.exit(ok ? 0 : 1);
