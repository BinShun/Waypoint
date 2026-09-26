#!/usr/bin/env node
/**
 * Customer Workbench - shared data server.
 *
 * Why this exists
 * ---------------
 * Browser storage is scoped per ORIGIN (scheme + host + port). That means the
 * preview panel, `npm run dev`, `npm run preview` and a double-clicked file://
 * copy are four *different* workspaces, and Chrome / Safari / Edge each keep
 * their own copy again. Anything typed in one is invisible in the others.
 *
 * This server removes that entire class of problem: there is exactly ONE file
 * on disk (`data/workbench.json`), and every browser, every tab, every preview
 * port reads and writes that same file. It also serves the built app from
 * `dist/`, so opening the served URL is the fully shared workspace.
 *
 * WHAT COLLEAGUES CAN AND CANNOT REACH
 * ------------------------------------
 * They get the built app in `dist/` and the `/api/*` endpoints. That is all.
 * Static files are resolved against `dist/` and cannot escape it, so the
 * source, the scripts, the data directory and this server are never served -
 * nobody on the network can edit the application, only use it.
 *
 * Design constraints (deliberate)
 * -------------------------------
 *  - Zero dependencies: `node server/server.mjs` is all there is to it.
 *  - CORS is guarded, not open: loopback, the private LAN ranges this thing is
 *    meant to live on, anything you list in WB_ORIGINS, and this server's own
 *    public hostname (so the deployed app can save). A random web page must
 *    not be able to read or overwrite the workspace. See `corsFor`.
 *  - Writes are ATOMIC: write a temp file, then rename. A crash mid-write can
 *    never leave a half-written, unparseable JSON file behind.
 *  - Writes MERGE, they do not clobber. Every client says which revision it
 *    based its edit on. Same revision -> accept as-is (so deletions work).
 *    Stale revision -> merge record by record on `updatedAt`, keep anything the
 *    client never saw, and write whatever loses into `data/conflicts.jsonl`.
 *    See "Concurrency" below.
 *
 * Concurrency (the rule: merge, never lose work)
 * ----------------------------------------------
 *  PUT carries `X-Base-Rev` (the revision it last read) and a `deleted` map
 *  (ids it removed, diffed against its own last-synced copy).
 *   - baseRev === current rev  -> nobody else wrote, accept wholesale.
 *   - otherwise                -> merge:
 *       * record in both       -> the newer `updatedAt` wins; the loser is
 *                                 appended to data/conflicts.jsonl
 *       * record only on disk  -> KEPT (the client may simply never have seen
 *                                 it; absence is not proof of a delete)
 *       * id in `deleted`      -> removed, unless someone edited that record
 *                                 after the client last synced. Then it is kept
 *                                 and logged: losing a colleague's edit is
 *                                 worse than leaving a row they can delete again.
 *  `users` and `credentials` are server-owned: only an administrator's write
 *  may change them, otherwise anyone could hand themselves the admin role or
 *  replace a password hash.
 *
 * Endpoints
 * ---------
 *   GET  /api/health            -> { ok, file, exists, bytes, savedAt, rev }
 *   GET  /api/session           -> { ok, authed, setup, requiresAuth, user }
 *   GET  /api/directory         -> { ok, users: [{ id, name, role, hasPassword }] }
 *   POST /api/login             -> { userId, password } -> sets the session cookie
 *   POST /api/logout            -> clears it
 *   GET  /api/data              -> { ok, empty, state, savedAt, bytes, rev }
 *   PUT  /api/data              -> { state, baseRev, deleted } -> { ok, savedAt, rev, mode }
 *   POST /api/reset             -> admin only: backs the file up, then deletes it
 *   POST /api/cleanup           -> admin only: removes stray .tmp files
 *   GET  /                      -> the built app (dist/index.html)
 *
 * Environment
 * -----------
 *   HOST          bind address (default 127.0.0.1; use 0.0.0.0 for the office LAN)
 *   PORT          default 8787
 *   WB_OPEN=1     single-user mode: no login, and reset/cleanup stay open.
 *                 For working alone on this machine. Do not use on a LAN.
 *   WB_ORIGINS    extra allowed origins, comma separated (e.g. https://wb.mycorp.net)
 *   WB_DATA_DIR   put the workspace somewhere else (used by the test harness)
 *   WB_TLS=0      serve plain http even when certs/key.pem + certs/cert.pem exist
 *
 * Nothing outside `data/` is ever written: no log files, no cache. The extras
 * that appear are `data/backups/` (pruned to KEEP_BACKUPS copies),
 * `data/workbench.rev.json` (the revision counter) and `data/conflicts.jsonl`.
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fsp from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { ENC_PREFIX, dataKey, seal, readWorkspaceFile } from './seal.mjs';
import { lookupCompany, lookupChoices, classifyIndustryPublic, companyBrief, collectNews, readMinutes, salesInsights } from './company-lookup.mjs';
import { aiStatus, aiComplete, readAiConfig, writeAiConfig, writeAiBudget, clearAiConfig } from './ai.mjs';
import { recoverStuckTasks, queuedTasks, runTask, createTask, tasksFor, findTask, retryTask, registerExecutor, hasExecutor, RefusedError, answerByRule, classifyAsk, buildCustomerContext, buildOppContext, buildGlobalContext, buildFocusWeekItems, buildCustomerFacts, buildOppFacts, buildPipelineFacts, findReusableSummary } from './copilot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA_DIR = process.env.WB_DATA_DIR ? path.resolve(process.env.WB_DATA_DIR) : path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'workbench.json');
const REV_FILE = path.join(DATA_DIR, 'workbench.rev.json');
const CONFLICT_FILE = path.join(DATA_DIR, 'conflicts.jsonl');
/* Append-only, one line per export, written by the server at the moment the
   file leaves. The in-app audit trail can be edited by whoever owns the data;
   this cannot be changed from the browser at all, which is the point. */
const EXPORT_LOG = path.join(DATA_DIR, 'exports.jsonl');
const DIST_DIR = path.join(ROOT, 'dist');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
/* Uploaded documents live beside the data, never in it: the state file stays
   small enough to merge row by row, and a 2 MB PDF is not a merge conflict.
   The row in `state.files` is the record; this directory is the document. */
const FILES_DIR = path.join(DATA_DIR, 'files');
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const CERT_DIR = process.env.WB_CERT_DIR ? path.resolve(process.env.WB_CERT_DIR) : path.join(ROOT, 'certs');
const KEY_FILE = path.join(CERT_DIR, 'key.pem');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');
const KEEP_BACKUPS = 10;

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const MAX_BODY = 64 * 1024 * 1024; // attachments are inlined base64, so allow room
const SCHEMA_VERSION = 1;

/** `WB_OPEN=1`: one person, this machine, no login. Never on a shared LAN. */
const OPEN_MODE = process.env.WB_OPEN === '1';

/* ==================================================================== origins */

const BASE_CORS = {
  'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Base-Rev,X-Base-Saved-At,X-Session-Token',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
};

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/**
 * Extra origins you have explicitly allowed (WB_ORIGINS). Compared by
 * hostname, so a port change does not need another restart.
 */
const EXTRA_HOSTNAMES = new Set(
  (process.env.WB_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try { return new URL(/^https?:\/\//i.test(s) ? s : `http://${s}`).hostname.toLowerCase(); } catch { return ''; }
    })
    .filter(Boolean),
);

/**
 * Optional suffix allow-list (WB_ORIGIN_SUFFIX), for hosted deployments whose
 * public hostname is generated per publish and therefore cannot be committed.
 *
 * `.app-tencent.workbuddy.host` is one of those: every publish hands out a
 * fresh `a0b1c2d3.` label, so a committed list is always one publish behind and
 * the first person to open the new link is told "Cross-origin requests are not
 * allowed." This is the same idea as WB_ORIGINS, matched at the end of the
 * hostname instead of the whole of it.
 *
 * Deliberately empty unless you set it. Widening the allow-list to a whole
 * zone also widens it to anything else hosted there, so it is an opt-in for a
 * deployment you control, not a default. Like every other entry here it only
 * answers "is this a browser we reply to" — it never touches `isPrivateHost`,
 * so the `Origin: null` hatch stays shut on a public server.
 */
const ORIGIN_SUFFIXES = (process.env.WB_ORIGIN_SUFFIX ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)
  .map((s) => (s.startsWith('.') ? s : `.${s}`));

/** True when `hostname` sits under one of the suffixes above. */
function matchesOriginSuffix(hostname) {
  if (!ORIGIN_SUFFIXES.length) return false;
  const h = String(hostname).toLowerCase();
  return ORIGIN_SUFFIXES.some((s) => h === s.slice(1) || h.endsWith(s));
}

/**
 * The hostnames this app is published as, read from `server/published-origins.txt`.
 *
 * Deliberately NOT folded into `isPrivateHost`: these are public names, and
 * treating them as private would flip `isPubliclyServed()` and quietly reopen
 * the `Origin: null` hatch for the `file://` build on a public deployment.
 * They only ever answer the question "is this a browser we will reply to".
 */
const PUBLISHED_HOSTNAMES = (() => {
  const set = new Set();
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'published-origins.txt');
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const h = line.split('#')[0].trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (h) set.add(h);
    }
  } catch {
    /* No file is fine — WB_ORIGINS and the Host comparison still apply. */
  }
  return set;
})();

/**
 * Is this an address that could only be reached from inside this network?
 *
 * Binding to 127.0.0.1 is NOT enough on its own. Any web page anywhere can run
 * `fetch('http://127.0.0.1:8787/api/data')`; with `Access-Control-Allow-Origin: *`
 * the browser happily hands the answer back, so a page you merely visited could
 * read every customer note and PUT (or POST /api/reset) over the top of it.
 * This file is the whole workspace, so the origin has to be checked.
 *
 * When the server is opened up to the office LAN the browsers that matter are
 * on 10.x / 172.16-31.x / 192.168.x, so those are allowed too - they are not
 * routable from the internet. Denying on `Origin` also defeats DNS rebinding,
 * because a rebound hostname still sends the attacker's Origin.
 */
function isPrivateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '');
  if (LOCAL_HOSTNAMES.has(h)) return true;
  if (EXTRA_HOSTNAMES.has(h)) return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16
    if (a === 169 && b === 254) return true;          // link-local
    if (a === 127) return true;                       // loopback
    return false;
  }
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

/**
 * The hostname the caller typed to reach this server, taken from
 * `X-Forwarded-Host` (set by the public reverse proxy) and falling back to
 * `Host`. Lower-cased, port stripped, first value only when a proxy chains
 * several. Empty when there is nothing to compare against.
 */
function selfHost(req) {
  const fwd = req.headers['x-forwarded-host'];
  const raw = (Array.isArray(fwd) ? fwd[0] : fwd) || req.headers.host || '';
  return String(raw).split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
}

/**
 * True when this server is reachable from the open internet.
 *
 * The `Origin: null` escape hatch below exists for the double-clickable
 * `file://` build, which is fine while the server sits on your own machine -
 * but on a public deployment any sandboxed iframe anywhere can send
 * `Origin: null`, so the hatch has to close the moment the server goes public.
 */
function isPubliclyServed(req) {
  const host = selfHost(req);
  return !!host && !isPrivateHost(host);
}

/**
 * Is this a browser we are willing to answer?
 *
 * Five ways in, and the last two are the ones that were missing:
 *  1. The address is private (loopback / office LAN) - the normal case.
 *  2. You listed it in WB_ORIGINS.
 *  3. You listed it in server/published-origins.txt - same idea as (2), but
 *     committed, because a hosted deployment has no way to set an env var and
 *     the proxy does not always forward its own public name.
 *  4. It is *this* server's own public hostname. Behind the public reverse
 *     proxy the browser still sends an `Origin` header, because the app is
 *     served from one port and the API answers on the same host through a
 *     different path. Rejecting it meant every save came back 403 and the app
 *     reported "Data server offline". It cannot be abused: the browser - not
 *     the page - sets both `Host` and `Origin`, so an attacker's page always
 *     arrives with a mismatched pair, which is exactly the DNS-rebinding case
 *     this check was written for.
 *  5. It sits under a suffix you named in WB_ORIGIN_SUFFIX - for a public name
 *     that is generated at publish time and so cannot be listed in advance.
 */
function isLocalOrigin(origin, req) {
  if (!origin) return true;                        // curl, or a plain same-origin GET
  if (origin === 'null') return !isPubliclyServed(req); // the file:// build, on a private server only
  let hostname = '';
  try { hostname = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  if (isPrivateHost(hostname)) return true;
  if (EXTRA_HOSTNAMES.has(hostname)) return true;
  if (PUBLISHED_HOSTNAMES.has(hostname)) return true;   // this app's own public name
  if (matchesOriginSuffix(hostname)) return true;       // a generated public name
  if (req && selfHost(req) === hostname) return true;
  return false;
}

/** Returns the CORS headers for this request, or null when it must be refused. */
function corsFor(req) {
  const origin = req.headers.origin;
  if (!isLocalOrigin(origin, req)) return null;
  // Echo the caller instead of `*`: a wildcard cannot be combined with
  // credentials, and echoing keeps the check honest.
  const allowOrigin = origin ?? '*';
  const headers = { ...BASE_CORS, 'Access-Control-Allow-Origin': allowOrigin };
  if (allowOrigin !== '*') headers['Access-Control-Allow-Credentials'] = 'true';
  return headers;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[server ${stamp()}]`, ...a);

/* ====================================================== encryption at rest  */
/* The format, the key and the reading of either shape live in `server/seal.mjs`
   so the test suites read the file the same way the server does. See the note
   at the top of that file for why that matters. */

/* ------------------------------------------------------------------ storage */

async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

async function statFile() {
  try {
    const s = await fsp.stat(DATA_FILE);
    return { exists: true, bytes: s.size, savedAt: s.mtime.toISOString() };
  } catch {
    return { exists: false, bytes: 0, savedAt: undefined };
  }
}

/* ============================================================ file storage */

/* An id is used as a filename, so it is restricted rather than escaped:
   anything that is not a plain token is refused, which removes both traversal
   and the question of what "escaped correctly" would even mean here. */
const SAFE_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const blobPath = (id) => path.join(FILES_DIR, id);

async function ensureFilesDir() {
  await fsp.mkdir(FILES_DIR, { recursive: true, mode: 0o700 });
}

async function writeBlob(id, buf) {
  await ensureFilesDir();
  const tmp = blobPath(id) + '.tmp';
  await fsp.writeFile(tmp, buf, { mode: 0o600 });
  await fsp.rename(tmp, blobPath(id));
}

async function readBlob(id) {
  try { return await fsp.readFile(blobPath(id)); } catch { return null; }
}

/* A row can be deleted from the state while its document is still on disk.
   Sweeping after a save keeps the two in step — an orphaned PDF is customer
   data sitting outside the rules that govern customer data. */
async function sweepOrphanBlobs(state) {
  if (!state || !Array.isArray(state.files)) return;
  const keep = new Set(state.files.map((f) => String(f && f.id)).filter(Boolean));
  let names = [];
  try { names = await fsp.readdir(FILES_DIR); } catch { return; }
  for (const n of names) {
    if (!SAFE_FILE_ID.test(n)) continue;
    if (keep.has(n)) continue;
    try { await fsp.unlink(blobPath(n)); } catch { /* gone already */ }
  }
}

/**
 * Reads either format — see `server/seal.mjs` for the rule and the reasoning.
 */
async function readState() {
  return readWorkspaceFile(DATA_FILE);
}

/* -------------------------------------------------- one writer at a time ---
 * "Atomic write" is not enough on its own. The WRITE is atomic, but the
 * DECISION behind it is not: a PUT reads the file, merges or replaces, and
 * writes — and every one of those steps awaits. Two people saving in the same
 * moment both read revision 10, both conclude "nobody else wrote, so I am the
 * whole truth", and both write 11. The second write wins, the first person's
 * edit is gone, no conflict is recorded, and both browsers were told "saved".
 * That is the one failure a shared book must never have.
 *
 * So the whole read → decide → write cycle is serialised. Node runs a single
 * thread, which makes an in-process promise chain a real lock: while one save
 * is in flight the next one queues behind it, and when it finally runs it
 * re-reads the file and sees the revision the first one just wrote — which is
 * precisely what pushes it onto the MERGE path instead of the replace path.
 * Serialising does not make the merge unnecessary; it makes the merge correct.
 */
let writeTail = Promise.resolve();
function serialize(job) {
  const run = writeTail.then(job, job);
  /* A rejected job must not poison the queue for the next caller. */
  writeTail = run.then(() => {}, () => {});
  return run;
}

/**
 * fsync the DIRECTORY, not just the file. A rename is a directory entry: if
 * the directory is not flushed, a crash can leave the new file's bytes on disk
 * with no name pointing at them — the write "succeeded" and the data is gone.
 */
async function syncDir(dir) {
  let h = null;
  try {
    h = await fsp.open(dir, 'r');
    await h.sync();
  } catch {
    /* Windows will not open a directory as a file. The rename is still durable
       there; everywhere else this is the difference between "the file is
       there" and "the file was there". */
  } finally {
    if (h) await h.close().catch(() => {});
  }
}

/**
 * Atomic write: write to a sibling temp file, fsync, then rename over the
 * target. A reader either sees the old file or the new one, never a partial.
 */
async function writeState(state) {
  await ensureDirs();
  const body = JSON.stringify(state);
  const key = dataKey();
  const out = key
    ? ENC_PREFIX + seal(Buffer.from(body, 'utf8'), key).toString('base64')
    : body;
  /* Unique per write, not just per process: two writers aimed at the same temp
     path truncate each other's file and the surviving rename then fails — which
     is a 500 to somebody whose only mistake was saving at the same moment. */
  const tmp = `${DATA_FILE}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const handle = await fsp.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(out, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, DATA_FILE);
  await syncDir(DATA_DIR);
  /* The whole workspace is one file and it is nobody else's business. */
  try { await fsp.chmod(DATA_FILE, 0o600); } catch { /* Windows, or a mounted volume */ }
  return body.length;
}

/**
 * Keep a few rolling copies. Cheap insurance against "I wiped the wrong thing",
 * and the only extra files this server ever creates. They prune themselves to
 * KEEP_BACKUPS, so they can never grow without bound.
 */
async function rotateBackup() {
  try {
    const info = await statFile();
    if (!info.exists) return;
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    const name = `workbench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    await fsp.copyFile(DATA_FILE, path.join(BACKUP_DIR, name));
    const files = (await fsp.readdir(BACKUP_DIR)).filter((f) => f.endsWith('.json')).sort();
    while (files.length > KEEP_BACKUPS) {
      await fsp.unlink(path.join(BACKUP_DIR, files.shift()));
    }
  } catch (e) {
    log('backup rotation skipped:', e.message);
  }
}

async function deleteData({ keepBackup = true } = {}) {
  if (keepBackup) await rotateBackup();
  try {
    await fsp.unlink(DATA_FILE);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * Remove stray temp files. `writeState` writes `<file>.<pid>.tmp` and renames
 * it, so a crashed process can leave one behind. They are never readable by
 * the app - they are litter - but Settings offers to clear them and that
 * button used to call a function that did not exist.
 */
async function clearTemp() {
  let removed = 0;
  let entries = [];
  try {
    entries = await fsp.readdir(DATA_DIR);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!/\.tmp$/i.test(name)) continue;
    try {
      await fsp.unlink(path.join(DATA_DIR, name));
      removed++;
    } catch {
      /* already gone */
    }
  }
  return removed;
}

/* ----------------------------------------------------------------- revision */

/**
 * The revision is a counter kept BESIDE the data file, not inside it.
 *
 * It cannot live inside the state: the browser round-trips the whole object, so
 * a rev inside it would be overwritten by whichever client saved last and would
 * stop meaning anything.
 */
async function readRev() {
  try {
    const j = JSON.parse(await fsp.readFile(REV_FILE, 'utf8'));
    const rev = Number(j?.rev);
    return Number.isFinite(rev) && rev > 0 ? rev : 0;
  } catch {
    return 0;
  }
}

/**
 * Written AFTER the data file, deliberately. If the process dies between the
 * two writes the revision looks STALE (too low) rather than too high, and a
 * stale revision makes the next write MERGE instead of replacing. Merging is
 * the safe failure - replacing is how work disappears.
 */
async function writeRev(rev, savedAt, bytes) {
  const tmp = `${REV_FILE}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const h = await fsp.open(tmp, 'w', 0o600);
  try {
    await h.writeFile(JSON.stringify({ rev, savedAt, bytes }), 'utf8');
    await h.sync();
  } finally {
    await h.close();
  }
  await fsp.rename(tmp, REV_FILE);
  await syncDir(DATA_DIR);
}

/**
 * When a merge drops a record somebody typed, the record is NOT thrown away -
 * it is appended here so it can be recovered by hand. Bounded: past 2 MB the
 * file is rotated rather than allowed to grow forever.
 */
async function appendConflicts(entries, userId) {
  if (!entries.length) return;
  const at = new Date().toISOString();
  const lines = entries
    .map((e) => JSON.stringify({ at, by: userId ?? null, ...e }))
    .join('\n') + '\n';
  try {
    await fsp.appendFile(CONFLICT_FILE, lines, 'utf8');
    const st = await fsp.stat(CONFLICT_FILE);
    if (st.size > 2 * 1024 * 1024) {
      await fsp.rename(CONFLICT_FILE, CONFLICT_FILE.replace(/\.jsonl$/, `.${Date.now()}.jsonl`));
    }
  } catch (e) {
    log('could not record the conflict:', e.message);
  }
}

/* ------------------------------------------------------------------- export */

/**
 * The only way customer data is meant to leave the product.
 *
 * Built here, not in the browser, for three reasons:
 *  - an authorisation check the client performs is a suggestion; this one is
 *    the server's own answer;
 *  - the export is recorded whether or not anybody remembers to;
 *  - there is then exactly one implementation of "what a customer row looks
 *    like in a spreadsheet", instead of two that drift apart.
 *
 * Who exported and when goes on EVERY row. A watermark does not survive being
 * pasted into Excel, but a column does — and a single row forwarded out of
 * context still carries the name of the person who took it.
 */
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function customerCsv(state, who) {
  const at = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const name = who?.name || 'Administrator';
  const oppsMap = state.opps || {};
  const head = ['Customer', 'Industry', 'HQ', 'Onboarded', 'Health', 'Owner', 'Confidential', 'Demo',
    'Opportunities', 'Open value', 'People', 'Systems', 'Last meeting', 'Next step',
    'Exported by', 'Exported at'];
  const rows = (state.customers || []).map((c) => {
    const ops = (c.opps || []).map((id) => oppsMap[id]).filter(Boolean);
    const meets = (c.timeline || []).filter((t) => t.k === 'meeting');
    const last = meets[meets.length - 1];
    const next = (state.steps || [])
      .filter((s) => s.c === c.id)
      .sort((a, b) => String(a.due || '').localeCompare(String(b.due || '')))[0];
    return [
      c.name, c.industry || '', c.hq || '', c.onboard ? 'Onboarded' : 'Not onboarded', c.health || '', c.owner || '',
      c.confidential ? 'Yes' : 'No', c.demo ? 'Yes' : 'No',
      ops.length, ops.reduce((a, o) => a + (Number(o.v) || 0), 0),
      (c.contacts || []).length, (c.apps || []).length,
      last ? last.d + ' ' + (last.t || '') : '',
      next ? (next.t || '') + (next.due ? ' — due ' + next.due : '') : '',
      name, at,
    ];
  });
  return {
    csv: [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n'),
    name: 'waypoint-customers-' + at.slice(0, 10) + '.csv',
    rows: rows.length,
  };
}

/** One line, appended, never rewritten: who took the data out and how much. */
async function recordExport(entry) {
  try {
    await fsp.appendFile(EXPORT_LOG, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    log('could not record the export:', e.message);
  }
}

/* -------------------------------------------------------------------- merge */

/** Top-level shape of DataState: which keys are lists and which are maps. */
const LIST_KEYS = ['users', 'accounts', 'departments', 'contacts', 'contactOwners', 'team',
  'interactions', 'tools', 'applications', 'opportunities', 'nextSteps', 'attachments', 'products',
  'accountProducts', 'logs',
  /* Waypoint (v9) collections. Same merge, same rules — they are just the
     names the newer client uses, and a client whose collections the server
     does not recognise is a client that cannot save at all. Note `opps` is
     NOT here: v9 holds opportunities as a map keyed by id, not a list.

     `meetings` and `interactions` are BOTH listed on purpose. §17 renamed the
     collection; listing only the new name would make every pre-rename
     workspace unsaveable, because the merge loop walks this list and a
     collection it does not know is a collection it will not carry forward.
     The old key stays until the migration script has run everywhere. */
  'customers', 'meetings', 'interactions', 'steps', 'audit', 'files',
  /* No `depts` key here on purpose: departments belong to a customer and ride
     inside `customers` as `c.depts`. A top-level list would have been a second
     source of truth for a name every customer is allowed to spell differently. */
  /* `views` are saved list questions (filters, sort, columns). Rows of
     {id, obj, name, owner, shared, def} — merged like any other list so one
     person's saved view survives a reload and a teammate can open it. */
  'views',
  /* `watch` holds the signals a person recorded and, crucially, their decision
     on each one (confirmed / not relevant). It used to ride inside `config`,
     which made a human judgement a setting rather than a record. */
  'watch'];
const MAP_KEYS = ['credentials', 'insights', 'config', 'opps'];

/**
 * Collections only an administrator may change.
 *
 * `users` carries `role` and `credentials` carries the password hashes. Left
 * mergeable by everybody, any signed-in colleague could rewrite their own row
 * to `role: 'admin'` - or drop an existing hash and write one they know - and
 * the RBAC in the UI would politely agree with them. So the server owns both:
 * a non-administrator's write keeps whatever is already on disk.
 */
const ADMIN_ONLY_KEYS = ['users', 'credentials'];

const idOf = (r) => (r && typeof r === 'object' ? r.id : undefined);
/* The roster is the one list whose rows are not identified by `id`: a roster
   row IS a person's name, and the page calls it `n`. Judging those rows by
   `idOf` answered "no id" for every one of them, and `mergeList` treats an
   unidentifiable row as something it cannot match — so it appended. Every save
   by every member therefore DOUBLED the roster: four colleagues became eight,
   eight became sixteen, each copy indistinguishable from the last, and the
   pickers drawn from it grew a duplicate of everybody. Identifying the row by
   the field it actually has is the whole fix. */
const rowKeyOf = (r) => {
  if (!r || typeof r !== 'object') return undefined;
  if (r.id !== undefined) return r.id;
  if (r.n !== undefined) return 'n:' + String(r.n);
  return undefined;
};
const tsOf = (r) => (r && typeof r.updatedAt === 'string' ? r.updatedAt : '');
const deletedIdsFor = (deleted, key) =>
  new Set(Array.isArray(deleted?.[key]) ? deleted[key].filter((x) => typeof x === 'string') : []);

function sameBody(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/**
 * Merge one list collection.
 *
 * `baseSavedAt` is the file timestamp the client last saw. It is what makes a
 * delete decidable: a record whose `updatedAt` has moved past it was edited by
 * somebody ELSE after this client synced, so "the client deleted it" and "the
 * client never saw the edit" look identical and the safe answer is to keep it.
 */
function mergeList(key, diskRows, inRows, removed, baseSavedAt, ctx) {
  /* `team` rows carry no `id` — see `rowKeyOf`. Only `team` uses the fallback:
     everywhere else a row without an `id` genuinely is unidentifiable, and
     silently matching those on some other field would be a guess. */
  const idFor = key === 'team' ? rowKeyOf : idOf;
  /* A `deleted` envelope names rows by their own identifier — `'John Teh'` for
     a roster row — while `rowKeyOf` returns the tagged `'n:John Teh'` form it
     uses internally. Both spellings are accepted so that a removal somebody
     did write down is not silently ignored. */
  const wasRemoved = (id) => removed.has(id)
    || (typeof id === 'string' && id.startsWith('n:') && removed.has(id.slice(2)));
  const out = [];
  const diskById = new Map();
  for (const row of diskRows ?? []) {
    const id = idFor(row);
    if (id === undefined) out.push(row);       // untyped row: nothing to match on
    else diskById.set(id, row);
  }

  const sent = new Set();
  for (const row of inRows ?? []) {
    const id = idFor(row);
    if (id === undefined) { out.push(row); continue; }
    /* A row the client sent twice is one row, not two. Without this, a
       payload holding two spellings of the same person — the roster after a
       page had minted ids for nameless twins — kept every copy on every
       save, and the collection grew without bound while each save got
       slower than the one before it. The first copy wins. */
    if (sent.has(id)) continue;
    sent.add(id);
    const disk = diskById.get(id);
    if (!disk) { out.push(row); continue; }                 // new on the client
    if (wasRemoved(id)) continue;                           // deleted below
    const dTs = tsOf(disk);
    const iTs = tsOf(row);
    if (iTs && dTs && iTs < dTs) {
      // Somebody else edited it more recently - theirs wins, ours is filed.
      out.push(disk);
      if (!sameBody(disk, row)) {
        ctx.conflicts.push({ collection: key, id, reason: 'stale-edit', discarded: row });
      }
      continue;
    }
    out.push(row);
  }

  for (const [id, disk] of diskById) {
    if (sent.has(id)) continue;
    if (wasRemoved(id)) {
      const dTs = tsOf(disk);
      const editedAfterSync = !!dTs && !!baseSavedAt && dTs > baseSavedAt;
      if (editedAfterSync) {
        out.push(disk);
        ctx.conflicts.push({ collection: key, id, reason: 'delete-vs-edit', discarded: null });
        continue;
      }
      continue;                                             // delete honoured
    }
    // On disk but not in the payload. Absence is not proof of a delete - the
    // client may simply be holding an older copy - so it is kept.
    out.push(disk);
  }
  return out;
}

function mergeMap(key, diskMap, inMap, removed, ctx) {
  const out = {};
  for (const [k, disk] of Object.entries(diskMap ?? {})) {
    if (Object.prototype.hasOwnProperty.call(inMap ?? {}, k)) {
      const inc = inMap[k];
      const dTs = tsOf(disk);
      const iTs = tsOf(inc);
      if (iTs && dTs && iTs < dTs) {
        out[k] = disk;
        if (!sameBody(disk, inc)) ctx.conflicts.push({ collection: key, id: k, reason: 'stale-edit', discarded: inc });
        continue;
      }
      out[k] = inc;
      continue;
    }
    if (removed.has(k)) continue;
    out[k] = disk;
  }
  for (const [k, v] of Object.entries(inMap ?? {})) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/**
 * One person is one roster row, whatever spellings arrived.
 *
 * The page mints a roster id from the person's name (`te_…`); an older or
 * hand-seeded book can hold the same person with no id at all, and to the
 * merge those are two different people: both were kept, and every save
 * re-added one of each, so a sync loop grew the roster without bound — a
 * full scenario run left a 96 MB book and every save behind it slower than
 * the last. The roster is the server's table: deduplicate by NAME on every
 * write path, and the row carrying an id — the server's own spelling —
 * wins over its nameless twin.
 */
function dedupeTeam(rows) {
  if (!Array.isArray(rows)) return rows;
  const best = new Map();
  for (const r of rows) {
    if (!r || typeof r !== 'object' || r.n === undefined) continue;
    const key = String(r.n);
    const prev = best.get(key);
    if (!prev || (prev.id === undefined && r.id !== undefined)) best.set(key, r);
  }
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object' || r.n === undefined) { out.push(r); continue; }
    const key = String(r.n);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(best.get(key));
  }
  return out;
}

/** Merge `incoming` into `disk`. Returns { state, conflicts }. */
function mergeState(disk, incoming, deleted, baseSavedAt) {
  const ctx = { conflicts: [] };
  const merged = { ...disk, ...incoming };

  for (const key of LIST_KEYS) {
    if (!Array.isArray(disk?.[key]) && !Array.isArray(incoming?.[key])) continue;
    merged[key] = mergeList(
      key,
      Array.isArray(disk?.[key]) ? disk[key] : [],
      Array.isArray(incoming?.[key]) ? incoming[key] : [],
      deletedIdsFor(deleted, key),
      baseSavedAt,
      ctx,
    );
  }
  /* §17: `meetings` was renamed to `interactions`. The line above spreads
     `disk` first and the client no longer sends the old key, so without this
     the pre-rename collection would sit on disk forever beside its own copy —
     two collections holding the same rows, and every future reader has to
     guess which one is authoritative. The rename is only real once the old key
     stops being written.

     It is only dropped when the incoming state actually CARRIES the new key.
     A client that has not been updated still sends `meetings` and no
     `interactions`; deleting its rows here would be the rename destroying the
     data it was supposed to move. So: migrate on evidence of the new key,
     otherwise leave the old one alone. */
  if (Array.isArray(incoming?.interactions) && incoming.meetings === undefined) {
    if (merged.meetings !== undefined) delete merged.meetings;
  }

  for (const key of MAP_KEYS) {
    if (!disk?.[key] && !incoming?.[key]) continue;
    merged[key] = mergeMap(
      key,
      disk?.[key] ?? {},
      incoming?.[key] ?? {},
      deletedIdsFor(deleted, key),
      ctx,
    );
  }
  return { state: merged, conflicts: ctx.conflicts };
}

/* ======================================================= row-level access */

/**
 * Row-level access, enforced here rather than in the browser.
 *
 * Until now "you only see the customers you are on the team of" was a filter in
 * `src/lib/perm.ts`, applied to a state object this server had already sent in
 * full. That is a UI preference, not a boundary: the data reached the machine
 * regardless, and `PUT /api/data` accepted the same whole-file blob back while
 * protecting only `users` and `credentials`.
 *
 * These are the server's own copies of those rules, and they are applied to
 * BOTH directions of the sync — scoping only the read would leave the write
 * wide open.
 *
 * The merge is what makes this safe rather than destructive. `mergeList` reads
 * a row that is on disk but missing from the payload as "this client may be
 * holding an older copy", never as a delete. So on the merge path a dropped row
 * simply survives untouched. The `replace` path has no such courtesy — it takes
 * the payload as the whole truth — so here out-of-scope rows are reverted to
 * their disk version rather than dropped. That way every path agrees.
 */

/** Roles that see every customer by default. Mirrors `MATRIX` in perm.ts. */
const SEE_ALL_ROLES = new Set(['admin', 'manager', 'viewer']);
/** Roles allowed to change business records at all.
 *
 *  Manager is NOT in here. A Manager reads the whole book and changes nothing
 *  in it: hiding the buttons in the browser is a courtesy, this is the rule.
 *  It used to be listed, which meant a Manager who opened the network tab (or
 *  simply replayed a request) could write anything the server would accept.
 *  Same for a viewer. */
const WRITE_ROLES = new Set(['admin', 'bd', 'sa']);
/** Destroying a record is the administrator's alone: the two-handed approval
 *  in the UI ends with the administrator's own request, never the requester's. */
const DELETE_ROLES = new Set(['admin']);
/** Every role an account may hold. Anything else is refused when one is made. */
const ROLES = new Set(['admin', 'manager', 'bd', 'sa', 'viewer']);
/** Roles allowed to ask the model anything at all (§17/§18).
 *
 *  Deliberately NOT `WRITE_ROLES`: reading insight out of the book is not
 *  writing into it. A manager who may see every customer must not be locked
 *  out of the briefings and questions about them — but "ask" stops at
 *  reading: actions that would create or change a record still go through
 *  `WRITE_ROLES` like every other write. A viewer watches; even asking
 *  spends tokens and surfaces data on a screen that role was never meant
 *  to work from.
 *
 *  Two consumers, one idea: the copilot task table and the record services
 *  (classify/brief/news/mom/insights) both only ever read the book or
 *  summarise what the caller can already see. Confirming a suggested WRITE
 *  is not "asking" and will get its own set the day it exists. */
const AI_ROLES_READ = new Set(['admin', 'manager', 'bd', 'sa']);

/** Which customer a row hangs off. `accounts` are keyed by their own id;
 *  every other collection names the account it belongs to. */
function accountOf(key, row) {
  if (!row || typeof row !== 'object') return undefined;
  // A customer row IS the customer: it is scoped by its own id, not by a field.
  if (key === 'accounts' || key === 'customers') return row.id;
  /* The roster is people, not customer records. Waypoint's team row uses `c`
     for how many customers somebody is on — a NUMBER — and reading it here
     made every colleague look like a row belonging to customer "4". Out of
     scope for a BD, so each one was reverted on save: the first BD to save
     emptied the whole roster, and the add-a-colleague list came up empty
     for everybody afterwards. A person is not scoped to one customer. */
  if (key === 'team') return undefined;
  // Waypoint names the customer `c`; the older client uses `accountId`.
  return row.c ?? row.accountId;
}

/** Account ids this session may see. `null` means unrestricted. */
function visibleAccountIds(state, user) {
  /* `null` means "unrestricted", so returning it for a caller with no account
     handed a stranger the whole book: it is how an anonymous request read
     every customer and downloaded every document during the setup window.
     Nobody is not a role that sees everything — it is a caller with no
     account, and the honest answer is an empty set: a row that names a
     customer is out of scope, a row that names none still carries nothing a
     stranger should have. `new Set()` is deliberately NOT `null`. */
  if (!user) return new Set();
  if (SEE_ALL_ROLES.has(user.role)) return null;

  /* Waypoint keeps its roster keyed by PERSON and names a customer's owner by
     NAME, not by an `accountId`. Running the account-based rule below against
     it finds no matches and returns an empty set — which silently shows a
     signed-in colleague an empty product. An empty book is a worse failure
     than a whole one, so a Waypoint workspace is scoped by owner name. */
  if (Array.isArray(state?.customers) && !Array.isArray(state?.accounts)) {
    const ids = new Set();
    for (const c of state.customers ?? []) {
      if (!c) continue;
      if (c.owner === user.name) ids.add(c.id);
      else if (Array.isArray(c.owners) && c.owners.includes(user.name)) ids.add(c.id);
      /* Being put on a customer by its owner is how a colleague is brought
         into an account, so it has to grant sight. Without this the owner
         can add an SA to a customer on screen and the SA still signs in to
         an empty book — the invitation exists in the UI and nowhere else. */
      else if (Array.isArray(c.team) && c.team.includes(user.name)) ids.add(c.id);
    }
    return ids;
  }

  const ids = new Set();
  for (const t of state?.team ?? []) {
    if (t && t.userId === user.id && t.accountId) ids.add(t.accountId);
  }
  return ids;
}

/** A row is in scope when it names no customer, or names one the user may see.
 *  Rows with no accountId carry no customer data — setup and sign-in entries —
 *  and dropping them would blind the audit log. */
function rowInScope(key, row, ids) {
  if (ids === null) return true;
  const a = accountOf(key, row);
  if (a === undefined || a === null || a === '') return true;
  return ids.has(a);
}

/**
 * How a map row is scoped. A list row carries its customer in a field, so one
 * rule fits all of them. A map row does not: in `insights` the KEY is the
 * customer, in Waypoint's `opps` the key is the opportunity id and the customer
 * is in the row, and in `config` there is no customer at all. Comparing every
 * key against a set of customer ids — the obvious shortcut — silently reverts
 * every opportunity and all of `config` for anyone who is not an admin.
 */
function mapInScope(key, ids, user) {
  if (ids === null) return () => true;
  /* `config` names no customer, so no id test can ever be true for it, and
     "a map row with no customer is in scope" used to make it writable by
     every BD and SA in the workspace. It is not a record — it is the setting
     every card in the product is drawn from, and the stage names in it are
     interpolated straight into the page. One save put
     `Interested"><img src=x onerror=alert(1)>` in front of every colleague
     who opened the app. Workspace settings belong to the administrator. */
  if (key === 'config') return () => isAdminRole(user?.role);
  if (key === 'opps') return (k, v) => rowInScope(key, v, ids);
  return (k) => ids.has(k);   // `insights`: the key IS the customer
}

/** Audit rows were written before a row had any id to scope by: the customer
 *  lives in the text — "Record - Customer" is the house shape. So they are
 *  scoped the way a reader would scope them: a row that names a customer this
 *  session may not see is dropped, unless it also names one they may (one
 *  row can name two sides). A row that names nobody — sign-ins, model
 *  settings — carries no customer data and stays, the same rule as rows with
 *  no accountId below.
 *
 *  Names also CHANGE: "Radio Televisyen Malaysia" became "Radio Televisyen
 *  Malaysia (RTM)" and the rows already written kept the old words, so the
 *  first version of this filter still handed four RTM rows to members who
 *  are not on RTM. Each customer is therefore also known by its name without
 *  a trailing parenthetical — but only when that shorter form belongs to
 *  exactly one customer, so "Acme (A)" and "Acme (B)" cannot stand in for
 *  each other. */
function scopeAudit(rows, state, ids) {
  if (ids === null) return rows;
  const customers = (state.customers ?? []).filter(Boolean);
  const nameOf = (c) => String(c?.name ?? '').trim();
  const baseOf = (n) => n.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const baseCount = new Map();
  for (const c of customers) {
    const b = baseOf(nameOf(c));
    if (b.length >= 3) baseCount.set(b, (baseCount.get(b) ?? 0) + 1);
  }
  const candidates = (c) => {
    const full = nameOf(c);
    const out = full.length >= 3 ? [full] : [];
    const b = baseOf(full);
    if (b.length >= 3 && b !== full && baseCount.get(b) === 1) out.push(b);
    return out;
  };
  const visible = customers.filter((c) => ids.has(c?.id)).flatMap(candidates);
  const hidden = customers.filter((c) => !ids.has(c?.id)).flatMap(candidates);
  if (!hidden.length) return rows;
  return (rows ?? []).filter((r) => {
    if (!r) return false;
    const hay = [r.rec, r.what, r.from, r.to].map((s) => String(s ?? '')).join(' \u0000 ');
    const mentions = (n) => hay.includes(n);
    if (!hidden.some(mentions)) return true;
    return visible.some(mentions);
  });
}

/** The state as this session is allowed to read it. Mirrors `scopeData()`. */
/**
 * §17 — present a workspace under the current collection names.
 *
 * `meetings` was renamed to `interactions`. Rows on disk keep the old key until
 * `scripts/migrate-interactions.mjs` moves them, and the server must not rewrite
 * a workspace merely because somebody opened it — a read is not a write.
 *
 * So the rename is applied to the ANSWER instead. This runs on the way out, once,
 * after scoping, which is why it is a function here rather than a `pick()` line
 * tucked inside `scopeState`: an administrator's read short-circuits `scopeState`
 * entirely (`ids === null` returns the state as-is), so a normalisation buried
 * in there would apply to everybody EXCEPT the one role most likely to be
 * looking at an old workspace. One rule, one place, both paths.
 *
 * Two things it deliberately does not do:
 *   - It does not rewrite the row's own classifier (`k`: Meeting / Call /
 *     Email / Video call). The container was renamed; the contents were not.
 *   - It does not touch the disk. Reading an old workspace must leave it
 *     byte-identical; the migration script is the only thing that writes.
 */
function renameCollections(state) {
  if (!state || typeof state !== 'object') return state;
  const out = { ...state };
  /* The new key wins when both are present, so a half-migrated file cannot
     shadow the rows that were moved. */
  if (!Array.isArray(out.interactions) && Array.isArray(out.meetings)) {
    out.interactions = out.meetings;
  }
  /* The old key never crosses the wire. Handing back both spellings of the same
     rows invites every future reader to pick one and be wrong half the time. */
  delete out.meetings;
  return out;
}

function scopeState(state, ids) {
  if (!state || ids === null) return state;

  /* Waypoint rows point at their customer with `c`, not `accountId`, so the
     generic rule below would keep every one of them. Scope them here. */
  if (Array.isArray(state.customers) && !Array.isArray(state.accounts)) {
    const wp = (key) => (state[key] ?? []).filter(
      (r) => r && (r.c === undefined || r.c === null || r.c === '' || ids.has(r.c))
    );
    const wpm = (key) => {
      const out = {};
      for (const [k, v] of Object.entries(state[key] ?? {})) {
        if (v && (v.c === undefined || v.c === null || v.c === '' || ids.has(v.c))) out[k] = v;
      }
      return out;
    };
    /* Some maps are keyed BY the customer rather than holding one — `insights`
       is the one that matters here. The rule is the same shape but the witness
       is the key, and using the value-reading helper above on such a map does
       not narrow it: a row with no `c` reads as "names nobody", which is
       always in scope. Two helpers because there are genuinely two cases, and
       one helper that guessed would have leaked silently. It closes over `ids`
       rather than taking a set, so a caller cannot hand it the wrong one. */
    const wpmByKey = (key) => {
      const out = {};
      for (const [k, v] of Object.entries(state[key] ?? {})) {
        if (ids.has(k)) out[k] = v;
      }
      return out;
    };
    return {
      ...state,
      customers: (state.customers ?? []).filter((c) => ids.has(c?.id)),
      // `opps` is a map keyed by opportunity id, not a list. Calling .filter
      // on it throws, and a 500 on read is a workspace nobody can open.
      opps: Array.isArray(state.opps) ? wp('opps') : wpm('opps'),
      /* §17: scoped from whichever key holds the rows — see `renameCollections`
         for why the answer is normalised after this, not inside it. */
      interactions: wp(Array.isArray(state.interactions) ? 'interactions' : 'meetings'),
      steps: wp('steps'),
      files: wp('files'),
      /* `watch` is a customer's news decisions — it names its customer in `c`,
         the same rule as the lists above. `audit` carries no id at all; it is
         scoped by the names written in its text (see scopeAudit). An account
         member saw forty-odd rows about customers they are not on before
         this: the browser was not showing them, but they had crossed the wire. */
      watch: wp('watch'),
      audit: scopeAudit(state.audit, state, ids),
      /* `insights` is a map whose KEY is the customer — so it takes the same
         rule as `opps`, one bracket over. It was missing from this branch and
         present in the branch below, which is the worst shape a scoping bug
         can take: the rule existed, was correct, and simply was not applied on
         the path a real workspace takes. A Waypoint file has `customers` and no
         `accounts`, so it always came through HERE, and a BD received every
         other customer's insights while their customers, opportunities and
         steps were correctly narrowed — a leak that looks like a working
         screen.
         NOT `wpm`: that helper reads the customer off the VALUE (`v.c`), which
         is right for `opps` and exactly wrong here. An insight value carries no
         `c` — the key IS the customer — so every entry would answer "names no
         customer" and pass straight through, which is how the first version of
         this fix changed nothing. The key is the thing to test. */
      insights: wpmByKey('insights'),
    };
  }

  /* Only collections that exist on disk are returned.
     Inventing an empty array here is not a neutral act: the client takes the
     server's answer as the whole truth and replaces its own collection with
     it. So "this workspace has never heard of `team`" would arrive as "your
     team is nobody", and the first person to sign in on a fresh workspace
     would quietly erase the roster — which is exactly what happened: the
     add-a-colleague list came up empty on every customer, forever.
     Absence has to mean "the server has nothing to say about this". */
  const pick = (key) =>
    (Array.isArray(state[key]) ? state[key].filter((r) => rowInScope(key, r, ids)) : undefined);
  const contacts = pick('contacts') ?? [];
  const contactIds = new Set(contacts.map((c) => c?.id));
  // `insights` is a map keyed by the customer's id, so the key IS the scope.
  const insights = {};
  for (const [k, v] of Object.entries(state.insights ?? {})) {
    if (ids.has(k)) insights[k] = v;
  }
  const out = {
    ...state,
    insights,
    departments: pick('departments'),
    contacts: pick('contacts'),
    // contactOwners carry no accountId of their own — scope through the contact.
    contactOwners: Array.isArray(state.contactOwners)
      ? state.contactOwners.filter((o) => contactIds.has(o?.contactId)) : undefined,
    team: pick('team'),
    /* §17: scoped from whichever key holds the rows. `renameCollections` then
       makes the answer speak only the new name — after scoping, so that the
       administrator path (which skips `scopeState` entirely) is normalised too. */
    interactions: pick(Array.isArray(state.interactions) ? 'interactions' : 'meetings'),
    tools: pick('tools'),
    applications: pick('applications'),
    opportunities: pick('opportunities'),
    nextSteps: pick('nextSteps'),
    accountProducts: pick('accountProducts'),
    attachments: pick('attachments'),
    logs: pick('logs'),
  };
  if (Array.isArray(state.accounts)) out.accounts = state.accounts.filter((a) => ids.has(a?.id));
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/**
 * May this session CREATE this row?
 *
 * A row that is not on disk yet names no team row to scope it to, and for a
 * long time that meant every create sailed through. It is a back door: send a
 * brand-new step with `c` set to a customer you cannot see and the record lands
 * in somebody else's book — invisible to you, writable by you, and outside
 * every rule that was supposed to guard it.
 *
 * So a create is judged by the customer it names, exactly like an edit. Two
 * kinds of row are still allowed through regardless: a row that carries no
 * customer at all (an audit entry, a watch decision), and a customer itself —
 * a new customer names nobody but its own id, and nobody could ever start one
 * if creating it required already being on its team.
 */
function rowMayBeCreated(key, row, ids) {
  if (ids === null) return true;
  const a = accountOf(key, row);
  if (a === undefined || a === null || a === '') return true;
  if (key === 'accounts' || key === 'customers') return true;
  return ids.has(a);
}

/**
 * Put back the rows this session cannot see but the payload omitted.
 *
 * The scoped client is handed only its own slice of the book, and it saves that
 * slice straight back — with a matching revision, which is the `replace` path,
 * where the payload is taken as the whole truth. A row that is absent is a
 * deleted row. So without this, one BD saving one note erased every customer
 * they were not on. Not a hypothetical: it is the ordinary save.
 *
 * The mirror image has to keep working, so an IN-scope row that is absent stays
 * deleted — but only for a role allowed to destroy. `DELETE_ROLES` says the
 * administrator alone, and an omission is not a warrant: a colleague who simply
 * leaves a row out of the blob would delete it while the envelope route would
 * have refused them, which is no rule at all.
 *
 * That rule was then read the other way round, and that reading was the bug.
 * "Only an authorised delete removes a row" was implemented as "an absence by
 * someone who may delete IS a delete", which meant the administrator — the one
 * role that sees everything — lost the refill entirely: `ids === null`
 * short-circuited the function on the first line, so every collection the
 * administrator's client does not sync (the audit log, the insights map) came
 * back off the disk, missed the refill, and was written back EMPTY by the very
 * next ordinary save. A workspace lost its whole history one unremarkable
 * save at a time, and `reverted` stayed 0 because no authorisation function
 * had been consulted.
 *
 * So absence is now "this client has nothing to say about this row", for
 * everybody, including the administrator. The only thing that removes a row is
 * a `deleted` envelope naming it, and that is still gated on DELETE_ROLES.
 * Deleting has to be an act somebody performed, not a silence somebody left.
 */
function restoreHidden(key, rows, diskRows, ids, allowedDeletes) {
  const present = new Set();
  for (const r of rows) {
    const id = idOf(r);
    if (id !== undefined) present.add(id);
  }
  for (const r of diskRows ?? []) {
    const id = idOf(r);
    if (id === undefined || present.has(id)) continue;
    if (allowedDeletes && allowedDeletes.has(id)) continue;   // named AND authorised: it stays deleted
    rows.push(r);                                             // everything else comes back
  }
  return rows;
}

/**
 * Out-of-scope rows in the payload are put back to their disk version.
 *
 * Reverting rather than dropping is what keeps the `merge` and `replace` paths
 * consistent: on a replace the payload is the whole truth, so a row that is
 * merely absent would be deleted. A row is only ever the client's when the
 * client is allowed to change it.
 *
 * Ownership is read off the row ON DISK, never off the row the client sent —
 * see the note at the branch below.
 */
function authorizeRows(key, diskRows, inRows, ids) {
  const diskById = new Map();
  for (const r of diskRows ?? []) {
    const id = idOf(r);
    if (id !== undefined) diskById.set(id, r);
  }
  const out = [];
  const lost = [];
  let reverted = 0;
  for (const row of inRows ?? []) {
    const id = idOf(row);
    if (id !== undefined && !diskById.has(id) && !rowMayBeCreated(key, row, ids)) {
      reverted += 1;
      lost.push({ collection: key, id, row });
      continue;
    }
    /* The row ALREADY ON DISK decides whether this session may touch it.
       Reading the customer off the row the CLIENT sent was a hole wide enough
       to walk a whole customer out of the building: rows are matched by id, so
       re-sending somebody else's file row with `c` changed to a customer I can
       see made `rowInScope` answer yes, and the edit went through — after
       which `GET /api/file?id=…` handed the document over with a 200. The same
       trick moved meetings, steps, signals and opportunities, and money with
       them. Deleting `c` instead of rewriting it did the same job from the
       other side. The id is the one thing both ends agree on, so the disk row
       behind it is the only honest witness to whose record this is. */
    const disk = diskById.get(id);
    if (id === undefined || !disk || rowInScope(key, disk, ids)) {
      out.push(row);
      continue;
    }
    out.push(disk);
    // Only count it when the client actually tried to change something. The
    // scoped client re-sends rows it can no longer see verbatim on every save,
    // and counting those would make this number meaningless.
    if (!sameBody(disk, row)) {
      reverted += 1;
      /* A discarded edit is a discarded edit. The merge never sees this row -
         it was replaced by the disk version before merging - so without this
         the "we never throw your work away" file would silently miss exactly
         the case it was written for: somebody typed something they were not
         allowed to save. */
      lost.push({ collection: key, id, row });
    }
  }
  return { rows: out, reverted, lost };
}

/**
 * Ids this session may delete: in scope, and only for a role that may destroy.
 *
 * The scope is read off the ROW, not off the id — only `accounts` has a row id
 * that is also an account id. Asking `ids.has(id)` for a contact or a deal
 * would compare a record id against a set of customer ids and refuse every
 * delete that was in fact perfectly in scope.
 */
function authorizeDeletes(key, diskRows, removed, ids, role) {
  const allowed = new Set();
  let refused = 0;
  if (!removed || removed.size === 0) return { allowed, refused };
  const mayDelete = DELETE_ROLES.has(role);
  const diskById = new Map();
  for (const r of diskRows ?? []) {
    const id = idOf(r);
    if (id !== undefined) diskById.set(id, r);
  }
  for (const id of removed) {
    const disk = diskById.get(id);
    // Deleting something that is not on disk is a no-op, not a permission.
    if (disk === undefined) continue;
    if (mayDelete && rowInScope(key, disk, ids)) { allowed.add(id); continue; }
    refused += 1;
  }
  return { allowed, refused };
}

/**
 * The audit trail is the one collection where the server, not the client,
 * decides who did something.
 *
 * A row already on disk is immutable: history cannot be rewritten after the
 * fact, so the disk version is restored over whatever the client sent. A new
 * row keeps the client's words but is re-stamped with the identity from the
 * session — `actorId` was client-supplied, which made the trail not merely
 * editable but forgeable.
 */
function authorizeLogs(diskRows, inRows, ids, user) {
  const diskById = new Map();
  for (const r of diskRows ?? []) {
    const id = idOf(r);
    if (id !== undefined) diskById.set(id, r);
  }
  const out = [];
  const lost = [];
  let reverted = 0;
  for (const row of inRows ?? []) {
    if (!row || typeof row !== 'object') continue;
    const id = idOf(row);
    if (id !== undefined && diskById.has(id)) {
      const disk = diskById.get(id);
      out.push(disk);
      if (!sameBody(disk, row)) reverted += 1;
      continue;                                   // logs are append-only, not discarded
    }
    if (!rowInScope('logs', row, ids)) {
      reverted += 1;
      lost.push({ collection: 'logs', id, row });
      continue;
    }
    out.push({ ...row, actorId: user ? user.id : row.actorId, ts: row.ts || new Date().toISOString() });
  }
  return { rows: out, reverted, lost };
}

/**
 * The Waypoint audit trail is append-only, and the server stamps it.
 *
 * It used to travel as an ordinary collection, which made history not merely
 * editable but FORGEABLE: the client filled `who` in from its own `D.me`, so a
 * colleague could write "Kelvin Lim deleted the customer" and the row would go
 * on saying exactly that to everybody who read it afterwards. An audit row
 * whose author is the person being audited is not an audit row.
 *
 * So a row already on disk is restored over whatever was sent — history is not
 * rewritten after the fact — and a new row keeps its words but is re-stamped
 * with the name and role the session authenticated, not the ones it claimed.
 */
function authorizeAudit(diskRows, inRows, user) {
  const diskById = new Map();
  for (const r of diskRows ?? []) {
    const id = idOf(r);
    if (id !== undefined) diskById.set(id, r);
  }
  const out = [];
  const lost = [];
  let reverted = 0;
  for (const row of inRows ?? []) {
    if (!row || typeof row !== 'object') continue;
    const id = idOf(row);
    if (id !== undefined && diskById.has(id)) {
      const disk = diskById.get(id);
      out.push(disk);
      if (!sameBody(disk, row)) reverted += 1;
      continue;                                   // append-only, like `logs`
    }
    out.push({ ...row, who: user?.name ?? row.who, role: user?.role ?? row.role });
  }
  return { rows: out, reverted, lost };
}

/**
 * An opportunity's `age` — the days it has sat in its current stage — is the
 * server's number, not the client's.
 *
 * It used to be a field the client wrote ONCE, at creation, as `age: 0`, and
 * never touched again. So every deal on the board claimed "0 days in stage"
 * for the whole of its life. That quietly turned the stalled-deal column, the
 * "30d" warning and the board's sort order into fiction: the one number the
 * board uses to say "this needs attention" was always zero.
 *
 * Two halves, then. `stampStage` records WHEN a deal entered its stage, and
 * only when the stage actually moves. `deriveOppAges` turns that date into
 * days on every read, so the number is true at the instant it is shown. A deal
 * already on disk carries no such date, so its last known touch seeds it — the
 * only honest guess the record can support, and far better than a zero that
 * means nothing.
 */
function dayStamp(d) {
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(+t) ? '' : t.toISOString().slice(0, 10);
}

function stampStage(outMap, diskMap) {
  const today = dayStamp(new Date());
  for (const [k, v] of Object.entries(outMap)) {
    if (!v || typeof v !== 'object') continue;
    const was = diskMap?.[k];
    const seed = !was
      ? today                                                   // brand new: starts now
      : String(was.stage ?? '') !== String(v.stage ?? '')
        ? today                                                 // the stage moved: restart
        : (v.stageAt || was.stageAt || dayStamp(was.updatedAt) || today);
    if (v.stageAt === seed) continue;
    /* Never write into the row that came off the disk — that object may be the
       server's own copy, shared with the file. */
    outMap[k] = { ...v, stageAt: seed };
  }
}

function deriveOppAges(state) {
  const opps = state?.opps;
  if (!opps || typeof opps !== 'object') return state;
  const today = Date.parse(dayStamp(new Date()) + 'T00:00:00Z');
  let changed = false;
  const out = {};
  for (const [k, o] of Object.entries(opps)) {
    if (!o || typeof o !== 'object') { out[k] = o; continue; }
    const from = o.stageAt || dayStamp(o.updatedAt);
    const start = from ? Date.parse(from + 'T00:00:00Z') : NaN;
    const age = Number.isNaN(start) ? 0 : Math.max(0, Math.round((today - start) / 86400000));
    if (age !== o.age) changed = true;
    out[k] = { ...o, age };
  }
  /* The customer's opps array is an index of the map, not a second source of
     truth. Any path that wrote the map without the index (a concurrent save
     race, an old build) used to leave the customer's Opportunities page
     blind to deals the pipeline could still see. Reconcile both ways: ids
     whose record points at this customer join the index, ids pointing
     elsewhere or nowhere leave it. */
  const customers = state.customers;
  if (Array.isArray(customers)) {
    let custChanged = false;
    const next = customers.map(c => {
      if (!c || typeof c !== 'object') return c;
      const own = Object.keys(out).filter(id => out[id] && out[id].c === c.id);
      const kept = (Array.isArray(c.opps) ? c.opps : []).filter(id => own.includes(id));
      const want = [...kept, ...own.filter(id => !kept.includes(id))];
      const same = Array.isArray(c.opps) && c.opps.length === want.length
        && c.opps.every((id, i) => id === want[i]);
      if (same) return c;
      custChanged = true;
      return { ...c, opps: want };
    });
    if (custChanged) { changed = true; return { ...state, opps: out, customers: next }; }
  }
  return changed ? { ...state, opps: out } : state;
}

/**
 * Build the payload this session is actually allowed to write, and the deletes
 * it is actually allowed to perform. Everything else is reverted to disk.
 */
function authorizeIncoming(disk, incoming, deleted, user) {
  const ids = visibleAccountIds(disk, user);
  const state = { ...incoming };
  const nextDeleted = {};
  const lost = [];
  let reverted = 0;
  let refused = 0;

  for (const key of LIST_KEYS) {
    const diskRows = Array.isArray(disk?.[key]) ? disk[key] : [];
    /* Deletes are decided FIRST: `restoreHidden` has to know which absences are
       an authorised destroy and which are merely a client that cannot see the
       row it omitted. */
    const removed = deletedIdsFor(deleted, key);
    const d = authorizeDeletes(key, diskRows, removed, ids, user?.role);
    if (removed.size) nextDeleted[key] = [...d.allowed];
    refused += d.refused;
    /* A collection key that is absent is NOT a delete — it is "this client has
       nothing to say about it". It used to be a delete: this loop only ran
       when the key was PRESENT in the payload, so a body carrying nothing but
       `customers` reached the replace path (where the payload is taken as the
       whole truth) with no `state[key]` for `restoreHidden` to refill, and
       every other collection on disk — audit, meetings, steps, files, watch —
       simply disappeared. One ordinary save, no privilege needed, and no
       trace: `reverted` stayed 0 because no authorisation function had been
       called at all.
       So absence now walks the same road as an empty array: `authorizeRows`
       and `restoreHidden` run anyway, and restoreHidden puts back every row
       this session may not destroy. The only thing that removes a row is a
       named `deleted` envelope, and that is still gated on DELETE_ROLES.
       A collection on NEITHER side is still left out entirely: writing `[]`
       into a workspace that has never heard of `accounts` is not a no-op —
       the client takes the server's answer as the truth, and an empty array
       it invented would come back as a real one on the next save. */
    const hasIncoming = Array.isArray(incoming?.[key]);
    const hasDisk = Array.isArray(disk?.[key]);
    if (!hasIncoming && !hasDisk) continue;
    const inRows = hasIncoming ? incoming[key] : [];
    /* The roster is the server's, not the client's. `users` is not one of the
       collections the app syncs (see SYNC_LISTS in the page), so an ordinary
       save from the administrator arrives without it — and "the client said
       nothing about `users`" is not the same claim as "the client deleted
       everybody". Reading it as the second one emptied the roster on the very
       first save: every account gone, every session dead including the one
       that made the save, and the workspace unopenable until somebody edited
       the file by hand.
       So a roster the client did not send — absent, or empty with nothing
       named in `deleted` — is left exactly as it is on disk. Removing an
       account still works, through the account endpoints or a named `deleted`
       envelope, and both are still gated on DELETE_ROLES. */
    if (ADMIN_ONLY_KEYS.includes(key) && hasDisk
      && (!hasIncoming || (inRows.length === 0 && !removed.size))) {
      state[key] = diskRows;
      continue;
    }
    /* The roster is shared, and nobody's to edit but the administrator's.
       `accountOf('team')` answers `undefined` — deliberately, because a roster
       row's `c` is a COUNT of customers, not a customer id, and reading it as
       one is what once emptied the roster for everybody. But "no customer
       attached" then also meant "in scope for every member", which left the
       other half of the same bug standing: a BD could re-send the roster with a
       colleague's row rewritten and the change LANDED. The way this surfaces is
       worse than a data leak in one respect — the roster is what every
       add-a-colleague picker and every owner dropdown is drawn from, so editing
       it edits who exists.
       The only thing in the product that writes a roster row is the moment an
       administrator creates an account (see the create-user path in the page),
       so the honest rule is the one written here: reading the roster is
       everybody's, changing it is the administrator's. Implemented as "refuse
       the client's version and keep the disk's" rather than as a 403, so an
       ordinary member's save — which always re-sends the whole roster it was
       given — stays a no-op instead of failing.
       This asks whether there IS a non-administrator, not whether an
       administrator is absent: `!isAdminRole(user?.role)` is also true for a
       caller with no account at all, and that is the one-person `WB_OPEN` copy
       and the first-run setup, where the person at the keyboard IS the owner
       and freezing the roster would stop them writing their own name into it. */
    if (key === 'team' && hasDisk && user && !isAdminRole(user.role)) {
      const incomingTeam = new Map();
      for (const r of inRows) if (r && r.n !== undefined) incomingTeam.set(String(r.n), r);
      /* Anything the member actually changed about somebody else is reverted
         and counted, so the save reports honestly instead of silently
         discarding. A row they did not touch is kept verbatim.
         "Changed" is compared field by field, NOT with `sameBody`: that helper
         is a `JSON.stringify` equality, and key ORDER counts. The page rebuilds
         each roster row from the fields it happens to read, so a row that is
         the same person with the same rank in a different property order read
         as an edit — which set `reverted`, which made the response carry the
         scoped truth, which overwrote the client's local state and silently
         undid whatever the user had just done in the same save (the SA they had
         put on a customer's team). A no-op has to stay a no-op. */
      const sameRow = (a, b) => {
        if (a === b) return true;
        if (!a || !b) return false;
        const ka = Object.keys(a).filter((k) => a[k] !== undefined);
        const kb = Object.keys(b).filter((k) => b[k] !== undefined);
        if (ka.length !== kb.length) return false;
        for (const k of ka) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
        return true;
      };
      const kept = diskRows.map((r) => {
        const sent = incomingTeam.get(String(r?.n));
        if (!sent || sameRow(r, sent)) return r;
        reverted += 1;
        lost.push({ collection: 'team', id: String(r?.n), row: sent });
        return r;
      });
      state[key] = kept;
      continue;
    }
    const r = key === 'logs'
      ? authorizeLogs(diskRows, inRows, ids, user)
      : key === 'audit'
        ? authorizeAudit(diskRows, inRows, user)
        : authorizeRows(key, diskRows, inRows, ids);
    state[key] = restoreHidden(key, r.rows, diskRows, ids, d.allowed);
    reverted += r.reverted;
    if (r.lost?.length) lost.push(...r.lost);
  }

  /* §17: retire `meetings` once the payload has actually spoken the new name.
     This has to be here rather than in `mergeState`, because a save whose base
     revision is current takes the REPLACE path and never calls `mergeState` at
     all — the payload is taken as the whole truth. That is the ordinary case:
     one person, one tab, nothing else writing. Cleaning up only in the merge
     path would leave the old key on disk for every normal save and clear it
     only during a conflict, which is the opposite of useful.

     The guard is the whole point: an un-updated client still sends `meetings`
     and no `interactions`, and dropping its rows here would be the rename
     destroying the data it was meant to move. Migrate on evidence of the new
     key; otherwise leave the old one exactly where it is. */
  if (Array.isArray(state.interactions) && incoming.meetings === undefined) {
    delete state.meetings;
  }

  for (const key of MAP_KEYS) {
    /* `credentials` is skipped here on purpose. It is the server's, on every
       path, and it is restored after the merge - see the note at the write.
       Scoping it here would only compare user ids against a set of customer
       ids and count every key as an attempted change. */
    if (key === 'credentials') continue;
    /* `user` goes in because one map — `config` — is decided by role rather
       than by customer: see mapInScope. */
    const inScope = mapInScope(key, ids, user);
    const diskMap = (disk?.[key] && typeof disk[key] === 'object') ? disk[key] : {};
    const rawMap = incoming?.[key];
    const inMap = (rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap)) ? rawMap : null;
    /* Same order as the lists: decide the deletes before deciding what an
       absent key means. */
    const removed = deletedIdsFor(deleted, key);
    const allowedMap = new Set();
    if (removed.size) {
      for (const id of removed) {
        if (!(id in diskMap)) continue;
        if (DELETE_ROLES.has(user?.role) && inScope(id, diskMap[id])) allowedMap.add(id);
        else refused += 1;
      }
      nextDeleted[key] = [...allowedMap];
    }
    /* Same rule as the lists above: an absent map is "no opinion", not "delete
       the lot". Left out of this block, `opps`, `insights` and `config` went
       to the replace path untouched by the restore loop below and vanished
       from the file — an opportunity map and the whole stage list, gone with
       one save. A map nobody has ever written is still left absent: an
       invented `{}` is read by the client as "this workspace really does have
       an empty one". */
    if (inMap || Object.keys(diskMap).length) {
      const entries = inMap ?? {};
      const outMap = {};
      for (const [k, v] of Object.entries(entries)) {
        /* Ownership is read off the value ON DISK, for the same reason the list
           rule reads it there: the key is the one thing both ends agree on, so
           the row behind it is the only honest witness. An opportunity is a
           map entry, and re-sending one under its own id with `c` changed to a
           customer I can see used to be enough to move the deal — and its
           value — into my book. */
        const diskV = diskMap[k];
        const onDisk = diskV !== undefined;
        if (inScope(k, onDisk ? diskV : v)) {
          outMap[k] = v;
          continue;                                  // new, or mine to change
        }
        if (onDisk) {
          outMap[k] = diskV;
          if (!sameBody(diskV, v)) { reverted += 1; lost.push({ collection: key, id: k, row: v }); }
        } else {
          reverted += 1;
          lost.push({ collection: key, id: k, row: v });
        }
      }
      /* The same rule the lists now keep: an omitted key is "no opinion", not
         "delete it" — for the administrator too. The `ids !== null` guard that
         used to sit here gave the administrator a different rule from everybody
         else, and the administrator is precisely the session whose client syncs
         the fewest collections, so `insights` and the opportunity map were the
         two that kept coming back empty after an ordinary save. */
      for (const [k, v] of Object.entries(diskMap)) {
        if (k in outMap || allowedMap.has(k)) continue;
        outMap[k] = v;
      }
      state[key] = outMap;
      /* Only the opportunity map keeps a clock, and only the server may wind
         it: a client that says "0 days" is not reporting, it is asserting. */
      if (key === 'opps') stampStage(outMap, diskMap);
    }
  }

  return { state, deleted: nextDeleted, ids, reverted, refused, lost };
}

/* ==================================================================== auth */

/**
 * Password verification, server side.
 *
 * The in-app check in `src/lib/auth.ts` is only there so the app still works
 * when it is opened as a standalone file with no server. Once the workspace is
 * shared, checking on the client is not a check at all: the hashes live in the
 * very file the API hands out, so anyone could read them. This is the real one,
 * and it reads the same format (PBKDF2-HMAC-SHA256, per-user salt) so nothing
 * has to be re-hashed.
 */
const ALGO = 'pbkdf2-sha256';
const KEY_LEN = 32;
const SALT_LEN = 16;
const ITERATIONS = 150_000;

/* One policy, enforced in the same place for a password set by an administrator
   and one changed by its owner — the alternative is two policies that disagree,
   and the weaker one is the one that gets used. */
function passwordIssues(password) {
  const issues = [];
  if (!password) issues.push('A password is required');
  if (String(password).length < 8) issues.push('At least 8 characters');
  if (!/[a-zA-Z]/.test(String(password))) issues.push('At least one letter');
  if (!/[0-9]/.test(String(password))) issues.push('At least one number');
  return issues;
}

function hashCredential(password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const hash = crypto.pbkdf2Sync(String(password), salt, ITERATIONS, KEY_LEN, 'sha256');
  return {
    algo: ALGO,
    iterations: ITERATIONS,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
  };
}

/* A password that changes without leaving a footprint is how an evening
   of "who did this" begins: every route that writes a credential also
   writes one line into the visible audit log — the same shape the
   command-line password tool leaves — so the Admin page can always say
   who changed whose password, when, and through which door. */
function noteAuthEvent(state, userId, summary) {
  state.logs = Array.isArray(state.logs) ? state.logs : [];
  state.logs.unshift({
    id: `l_pw_${Date.now()}`,
    at: new Date().toISOString(),
    action: 'update',
    entityType: 'auth',
    entityId: userId,
    summary,
  });
}

function verifyPassword(password, cred) {
  if (!cred || cred.algo !== ALGO || typeof password !== 'string') return false;
  let salt, expected;
  try {
    salt = Buffer.from(String(cred.salt ?? ''), 'base64');
    expected = Buffer.from(String(cred.hash ?? ''), 'base64');
  } catch { return false; }
  if (!salt.length || expected.length !== KEY_LEN) return false;
  const iterations = Number(cred.iterations);
  // Guard the cost: a hostile payload could claim 10^9 iterations and pin a core.
  if (!Number.isFinite(iterations) || iterations < 1 || iterations > 1_000_000) return false;
  const derived = crypto.pbkdf2Sync(password, salt, iterations, KEY_LEN, 'sha256');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

/** Only this role may use /api/reset, /api/cleanup, change the roster, set the
 *  model endpoint, or export.
 *
 *  Manager is deliberately absent. "Manager" in this product means a reader
 *  with the whole book open — a head of sales who needs to see everything and
 *  must not be able to change any of it. Giving that role administrative
 *  powers because of the word "manager" is exactly the kind of naming accident
 *  that turns into a permission incident. */
const ADMIN_ROLES = new Set(['admin']);
const isAdminRole = (role) => ADMIN_ROLES.has(role);

const SESSION_COOKIE = 'cwb_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Sessions are in memory only: a restart signs everybody out, which is the
 *  honest behaviour for a workspace that lives on somebody's laptop. */
const sessions = new Map();

function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('hex');
  /* If the browser arriving here was holding the reset's founder session, this
     sign-in replaces it and that token will never be sent again — so the mark
     goes with it. A founder entry nothing can present is a window closed on
     nobody, which is exactly the state `founders` must not be able to reach. */
  const was = readCookies(req)[SESSION_COOKIE];
  if (was && founders.delete(was)) sessions.delete(was);
  sessions.set(token, {
    userId,
    createdAt: Date.now(),
    lastSeen: Date.now(),
    ip: req.socket?.remoteAddress ?? '',
    agent: String(req.headers['user-agent'] ?? '').slice(0, 120),
  });
  return token;
}

/**
 * The one session that may rebuild the workspace after a reset, and only it.
 *
 * A reset deletes the file the accounts live in, so the very next request
 * arrives at an empty book with no passwords — which is the first-run window,
 * and that window has to be reachable or the machine is bricked: there would
 * be no way to create the first administrator again. Its PROBLEM was never
 * that it existed, it was WHO it opened for. The window was defined as "no
 * passwords and no customers", a property of the file, so it opened for every
 * caller that could reach the port — the operator who cleared the workspace
 * and any stranger who happened to be pointing at it, with exactly the same
 * welcome. Somebody clearing the book to hand the machine to a new team, or to
 * sell it, was really handing over an unlocked workspace with the door held
 * open.
 *
 * So the window is narrowed to a person rather than a state: the session that
 * performed the reset survives it (every OTHER session dies), and it alone may
 * walk into the empty book. `/api/logout` clears it if the operator would
 * rather it did not, and a restart clears it too, because sessions live in
 * memory only — after which the deploy itself is the only thing that can open
 * the book, which is the case the window was originally written for.
 */
const founders = new Set();

/** True when this request carries the reset's own session. */
function isFounder(req) {
  const token = readCookies(req)[SESSION_COOKIE] || String(req.headers['x-session-token'] ?? '');
  return !!token && founders.has(token);
}

/**
 * Revoke sessions.
 *
 * Called with a `userId`, this revokes every session held by that account. A
 * password used to be changeable without invalidating anything: the account
 * moved on, the door it had handed out did not. Somebody who had signed in on
 * a shared machine, or whose password was reset because it had leaked, kept a
 * working session afterwards and there was no way to take it back — an
 * administrator resetting a colleague's password was really only changing it
 * for the next person to type.
 *
 * `exceptToken` keeps the caller's own session alive. Changing your password
 * should not sign you out of the request that changed it, and an
 * administrator acting on somebody else's account is never holding that
 * person's token.
 *
 * Called with NO `userId`, it revokes every session there is, whoever holds
 * it. That is the shape the workspace reset needs: the reset deletes the file
 * the accounts lived in, so afterwards every token in the map belongs to an
 * account that no longer exists and must stop being honoured. The earlier
 * `if (!userId) return 0` made that call a no-op — the door was asked to close
 * and quietly did nothing, which is worse than not asking.
 *
 * The two meanings are distinguished by `arguments.length`, so that
 * `killSessions(undefined)` — a caller that looked up a user id and did not
 * find one — stays the harmless no-op it has always been rather than silently
 * escalating into "sign everyone out".
 */
function killSessions(userId, exceptToken) {
  const all = arguments.length === 0;
  if (!all && !userId) return 0;
  let n = 0;
  for (const [token, s] of sessions) {
    if (!all && s.userId !== userId) continue;
    if (exceptToken && token === exceptToken) continue;
    sessions.delete(token);
    n += 1;
  }
  return n;
}

function readCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * The session token comes from the cookie, or - when cookies cannot work - from
 * an `X-Session-Token` header.
 *
 * The double-clickable file:// build has an opaque origin, so a browser will
 * not reliably store or replay a cookie for a server on a different origin.
 * The standalone HTML is a one-person copy of the app, so it still has to be
 * able to talk to a shared server; the header is how. It is only ever held in
 * memory on the client, never written down.
 */
function sessionFor(req) {
  const token = readCookies(req)[SESSION_COOKIE] || String(req.headers['x-session-token'] ?? '');
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.lastSeen > SESSION_TTL_MS) { sessions.delete(token); return null; }
  s.lastSeen = Date.now();
  return { token, ...s };
}

function cookieHeader(token, secure) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (token) parts.push(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  else parts.push('Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/* ==================================================== CSRF and safe methods  */

/**
 * A session cookie rides along with ANY request to this origin — including one
 * a stranger's page fires at it. Two ways a write can prove it is ours:
 *
 *  1. An `Origin` header naming a host we already answer. Browsers send it on
 *     every cross-site POST/PUT/DELETE and a page cannot change it, so this is
 *     the real check. (The CORS gate above already refuses a hostile Origin,
 *     which is why this looks like a second opinion.)
 *  2. A custom header — `X-Session-Token`. A cross-site page can only add one
 *     by passing a CORS preflight, which we refuse.
 *
 * A write with NEITHER is a script or curl rather than a browser. That is
 * allowed from this machine only: the LAN server exists so the double-clicked
 * copy and the office network can reach it, and an attacker's page cannot make
 * your browser talk to your own loopback while hiding its Origin.
 *
 * `SameSite=Lax` on the cookie is the third layer, and the oldest.
 */
function csrfOk(req) {
  const m = req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  if (req.headers.origin) return isLocalOrigin(req.headers.origin, req);
  if (req.headers['x-session-token']) return true;
  return isLoopback(req.socket?.remoteAddress);
}

/* ======================================================= security headers  */

/**
 * Sent on every response, errors included.
 *
 * The honest part about the CSP: the app ships as ONE html file with inline
 * `<script>` and `<style>`, so the policy cannot forbid inline script — doing
 * so would simply break the app. What it still takes away is the part that
 * matters after an injection: `connect-src 'self'` means injected script cannot
 * send the customer list anywhere, `frame-ancestors 'none'` blocks
 * click-jacking, and `form-action 'self'` blocks a forged form. The proper fix
 * is a per-response nonce injected into the html at serve time; that needs the
 * template to be re-served rather than read from disk, so it is a deliberate
 * follow-up and not a claim made here.
 */
function securityHeaders(secure) {
  const h = {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",          // customer logos come from their own sites
      "font-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
  /* Only ever over https — a browser that trusts an http HSTS header can be
     pinned to https for two years by anybody on the wire. */
  if (secure) h['Strict-Transport-Security'] = 'max-age=15552000; includeSubDomains';
  return h;
}

/* ------------------------------- rate limiting ------------------------------ */

/**
 * A flat ceiling on API calls per address, on top of the failed-sign-in lock
 * below. This is not anti-abuse for the internet — it is the difference between
 * a runaway tab hammering the one file and a server that stays responsive for
 * everybody else on the LAN.
 */
const API_WINDOW_MS = 60_000;
const API_MAX_PER_WINDOW = 600;             // 10/second sustained; a person is nowhere near it
const apiHits = new Map();                  // ip -> { n, start }
let apiPrunedAt = Date.now();

/**
 * Whose calls these are.
 *
 * Behind a reverse proxy every colleague arrives from the proxy's own address,
 * so the flat ceiling below was shared by the whole team: one person leaving a
 * chatty tab open could spend the budget everybody else needed. The header is
 * only read when the operator has said the proxy is theirs to trust
 * (`WB_TRUST_PROXY=1`) — a client can put anything in `X-Forwarded-For`, and
 * believing it by default would turn a per-address ceiling into no ceiling at
 * all. Default unchanged: the socket address.
 */
function clientIp(req) {
  if (process.env.WB_TRUST_PROXY === '1') {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

function apiThrottle(req) {
  const ip = clientIp(req);
  const now = Date.now();
  if (now - apiPrunedAt > 5 * 60_000) {              // forget idle addresses
    apiPrunedAt = now;
    for (const [k, v] of apiHits) if (now - v.start > API_WINDOW_MS) apiHits.delete(k);
  }
  const rec = apiHits.get(ip);
  if (!rec || now - rec.start > API_WINDOW_MS) {
    apiHits.set(ip, { n: 1, start: now });
    return 0;
  }
  rec.n += 1;
  if (rec.n <= API_MAX_PER_WINDOW) return 0;
  return Math.max(1, Math.ceil((rec.start + API_WINDOW_MS - now) / 1000));
}

const FAIL_LIMIT = 8;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;
const failures = new Map();   // "ip|userId" -> { count, first, until }

function throttleState(ip, userId) {
  const key = `${ip}|${userId}`;
  const now = Date.now();
  const rec = failures.get(key);
  if (!rec) return { blocked: false, key, remaining: FAIL_LIMIT };
  if (rec.until && now < rec.until) {
    return { blocked: true, key, retryIn: Math.ceil((rec.until - now) / 1000) };
  }
  if (now - rec.first > FAIL_WINDOW_MS) { failures.delete(key); return { blocked: false, key, remaining: FAIL_LIMIT }; }
  return { blocked: false, key, remaining: Math.max(0, FAIL_LIMIT - rec.count) };
}

function noteFailure(key) {
  const now = Date.now();
  const rec = failures.get(key) ?? { count: 0, first: now, until: 0 };
  rec.count++;
  if (now - rec.first > FAIL_WINDOW_MS) { rec.count = 1; rec.first = now; rec.until = 0; }
  if (rec.count >= FAIL_LIMIT) rec.until = now + LOCK_MS;
  failures.set(key, rec);
}

/* --------------------------------- the gate -------------------------------- */

const PUBLIC_USER_FIELDS = (u, hasPassword) => ({
  id: u.id,
  name: u.name,
  role: u.role,
  title: u.title,
  locked: !!u.locked,
  hasPassword,
});

/**
 * Replace password hashes with an inert marker before the state leaves.
 *
 * The keys are kept on purpose: the app reads `Object.keys(credentials).length`
 * to decide whether the first-run setup is done, so blanking the map entirely
 * would send every non-administrator straight back to the setup wizard. The
 * marker uses an unknown `algo`, and `verifyPassword` fails closed on an
 * unknown algo, so it is useless as a credential.
 */
function stripSecrets(state) {
  if (!state?.credentials) return state;
  const blank = {};
  for (const k of Object.keys(state.credentials)) {
    blank[k] = { userId: k, algo: 'server-managed', iterations: 0, salt: '', hash: '', createdAt: '', updatedAt: '' };
  }
  return { ...state, credentials: blank };
}

/**
 * Resolve who is calling. Returns `null` when a response has already been sent
 * (401 / 403 / 429), so every caller can simply `if (!who) return;`.
 */
async function identify(req, res, cors, secure) {
  const disk = await readState();
  const hasCredentials = !!disk && !!disk.credentials && Object.keys(disk.credentials).length > 0;
  /* "Open" used to mean "nobody has a password", which is not the same thing
     as "there is nothing to protect". An administrator clearing the workspace
     deletes the file the credentials live in, so the very next request — from
     anybody who can reach the port — arrived here with a book still full of
     customers and no password on the door: read everything, write anything,
     delete the workspace, and create yourself as administrator. A deploy that
     ships without `data/` does the same.
     So the window is now "no passwords AND no customers": a genuinely empty
     book, which is the only case where there is nobody to ask. A file with
     customers in it and no credentials is a broken deploy, and the answer to
     it is 401 (or 403 for the guarded routes below), not the keys. */
  const bookIsEmpty = !disk
    || ((Array.isArray(disk.customers) ? disk.customers.length : 0) === 0
      && (Array.isArray(disk.accounts) ? disk.accounts.length : 0) === 0);
  /* An empty book is not by itself a reason to open the door — see `founders`.
     The window belongs to a PERSON in two honest cases: the operator who just
     cleared the workspace and is about to set it up again (they hold the
     surviving founder session), and a genuine first run, where there is no
     account in existence that could be asked for a password. The second case
     cannot be told apart from "a reset just happened" by looking at the file —
     both are an absent file — so it is told apart by `founders`: when a reset
     is in progress somebody holds a session and the window is theirs alone;
     when the machine has simply never been set up, nobody holds anything and
     the only visitor is the person standing at it. */
  const bookNobodyCanClaim = !hasCredentials && bookIsEmpty;
  if (OPEN_MODE || (bookNobodyCanClaim && (founders.size === 0 || isFounder(req)))) {
    // `open` also means "trusted with the roster": in single-user mode there is
    // nobody to protect the roster from, and freezing it here would stop the
    // owner from ever setting their own password.
    return { authed: true, setup: !hasCredentials, open: true, user: null, disk, secure };
  }
  const s = sessionFor(req);
  if (!s) {
    send(res, 401, { ok: false, error: 'Sign in to the shared workspace.', code: 'auth-required' }, cors);
    return null;
  }
  const user = (disk.users ?? []).find((u) => u.id === s.userId);
  if (!user) {
    sessions.delete(s.token);
    send(res, 401, { ok: false, error: 'Your account no longer exists.', code: 'auth-required' }, cors);
    return null;
  }
  /* `active: false` is "this person has left". It used to be checked nowhere
     on the way in — only `locked` was — so a disabled account went on signing
     in and reading the book it had been removed from, which makes the
     administrator's own action a lie. Leaving is not locking, so the answer
     says which it is: one is a mistake to be undone, the other is not. */
  if (user.locked || user.active === false) {
    sessions.delete(s.token);
    send(res, 403, {
      ok: false,
      code: user.locked ? 'locked' : 'inactive',
      error: user.locked
        ? `${user.name}'s account is locked. Ask an administrator to unlock it.`
        : `${user.name}'s account is no longer active. Ask an administrator to restore it.`,
    }, cors);
    return null;
  }
  return { authed: true, setup: false, user, session: s, disk, secure };
}

/* ------------------------------------------------------------- http helpers */

/** `cors` is per-request (see corsFor); OPEN_CORS is only for internal errors
 *  raised before the request's CORS headers could be computed. */
const OPEN_CORS = { ...BASE_CORS, 'Access-Control-Allow-Origin': '*' };

function send(res, code, obj, cors = OPEN_CORS, headers = {}) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...cors,
    ...headers,
  });
  res.end(body);
}

class PayloadTooLarge extends Error {}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new PayloadTooLarge(`Body exceeds ${Math.round(MAX_BODY / 1024 / 1024)} MB.`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * The one place that decides whether a payload is a workbench state.
 *
 * This is the guard rail on the only destructive write in the system: a PUT
 * replaces the whole file, so accepting a truncated or half-built object would
 * silently erase real customer data. Every collection the app knows about must
 * be the right TYPE when it is present, and at least one known collection must
 * actually be there — `{}` used to be accepted, which made "accidentally
 * overwrite everything with nothing" a single request away.
 */
function validate(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return 'Body must be a JSON object.';
  }
  if (state.schemaVersion !== SCHEMA_VERSION) {
    return `Unsupported schemaVersion ${String(state.schemaVersion)} (expected ${SCHEMA_VERSION}).`;
  }
  for (const k of LIST_KEYS) {
    if (k in state && !Array.isArray(state[k])) return `${k} must be an array.`;
  }
  for (const k of MAP_KEYS) {
    if (k in state && (typeof state[k] !== 'object' || Array.isArray(state[k]) || state[k] === null)) {
      return `${k} must be an object.`;
    }
  }
  const known = [...LIST_KEYS, ...MAP_KEYS].some((k) => k in state);
  if (!known) return 'Body does not look like a workbench state (no known collection).';
  return null;
}

/**
 * An interaction is contact with a customer — never a free-floating record.
 *
 * §17 renamed this collection from `meetings` to `interactions`, because the
 * old name was narrower than the thing: a row's own classifier (`k`) has
 * always been able to say Call or Email or Video call, so calling the
 * collection "meetings" described one of its four kinds as if it were all of
 * them. The records did not change; the name caught up.
 *
 * Because the rename is a MIGRATION and not a clean cutover, this reads BOTH
 * keys. A workspace written before the rename still opens, and — this is the
 * part that matters — saving it does not make it worse: the client writes the
 * new key only, and `interactionRows()` finds the old one until the migration
 * script has run. A validator that insisted on the new key would turn every
 * un-migrated workspace into a workspace that cannot be saved at all, which
 * is the same class of mistake as inferring a Tracker from an Execution Owner
 * (see `stepIntegrity`).
 *
 * The UI makes the customer mandatory, but the UI is a preference; this is
 * the rule. It runs on the state that is ABOUT to be written, after merges
 * and reverts, so it sees the truth the file would hold: every interaction
 * must name a customer that exists in that same state. Creating one without a
 * customer, editing one away from its customer, or deleting the customer
 * while leaving its interactions behind are all refused here, whatever client
 * tried it.
 *
 * Returns null when the relationship holds, or the reason it does not.
 */
function interactionRows(state) {
  if (Array.isArray(state?.interactions)) return state.interactions;
  if (Array.isArray(state?.meetings)) return state.meetings;
  return [];
}

function meetingIntegrity(state) {
  const meetings = interactionRows(state);
  if (!meetings.length) return null;
  const ids = new Set((Array.isArray(state?.customers) ? state.customers : [])
    .map((c) => (c && typeof c === 'object' ? String(c.id ?? '') : ''))
    .filter(Boolean));
  for (const m of meetings) {
    if (!m || typeof m !== 'object') return 'An interaction row is not an object.';
    const c = String(m.c ?? '').trim();
    if (!c) return 'An interaction has no customer — every interaction belongs to one.';
    if (!ids.has(c)) return `An interaction refers to customer "${c}", which does not exist.`;
  }
  return null;
}

/**
 * An opportunity belongs to a customer the book actually holds.
 *
 * §26 extended the import to opportunities, and an import is the one channel
 * where rows arrive in bulk from outside the product — a customer column
 * that does not match any account is not a hypothesis, it is the ordinary
 * failure of a pasted spreadsheet. People are embedded in the customer's own
 * row, and an interaction or a next step that names nobody is already
 * refused by its integrity rule; the opportunity map was the one collection
 * where a row could name a customer that does not exist — or none at all —
 * and still land on the file.
 *
 * The scope layer does not catch this for the administrator, who sees
 * everything (`ids === null` reverts nothing) — and the administrator is
 * exactly the role the import answers to. So this is not a permission but an
 * assertion about the state being written: the same stance as
 * meetingIntegrity and stepIntegrity, in the same place, checked after the
 * merges and reverts so it judges the truth that would land, whatever client
 * tried it.
 *
 * Returns null when the relationship holds, or the reason it does not.
 */
function oppIntegrity(state) {
  const opps = state?.opps;
  if (!opps || typeof opps !== 'object' || Array.isArray(opps)) return null;
  const ids = new Set((Array.isArray(state?.customers) ? state.customers : [])
    .map((c) => (c && typeof c === 'object' ? String(c.id ?? '') : ''))
    .filter(Boolean));
  for (const v of Object.values(opps)) {
    if (!v || typeof v !== 'object') return 'An opportunity row is not an object.';
    const c = String(v.c ?? '').trim();
    if (!c) return 'An opportunity has no customer — every opportunity belongs to one.';
    if (!ids.has(c)) return `An opportunity refers to customer "${c}", which does not exist.`;
  }
  return null;
}

/**
 * A Next Step is tracked by somebody who is on the account, or it is tracked
 * by nobody.
 *
 * §5 of the brief splits an action between two people: an Execution Owner, who
 * does the work and may be anyone relevant — a Product SA, a specialist, a
 * supporting person with no account at all — and a Tracker, who follows it up
 * and MUST be the customer's Primary BD or Primary SA. The reason is not
 * bookkeeping: a step whose follow-up sits with somebody outside the account
 * team is a step nobody is answerable for, and it fails silently — the action
 * stays open, nobody is nagged, and it is discovered a quarter later.
 *
 * The client checks this too, so the person is told at the form. This is the
 * rule. It runs on the state about to be written, after merges and reverts,
 * and it reads the customer's CURRENT owners from that same state — so
 * changing an account's BD does not quietly orphan the steps already tracked
 * by the old one; the write that would leave them stranded is refused, and
 * somebody has to decide where they go.
 *
 * ONLY A DECLARED `track` IS POLICED — never one inferred from `exec` or `o`.
 *
 * That distinction is the whole rule. `exec` is "who does the work" and the
 * spec lets it be anybody, including an outside participant with no account;
 * `track` is "who is answerable" and must be on the account. A row written
 * before this change has only `o` and never made a tracker claim, so there is
 * no claim to check. Inferring one would not enforce §5 — it would invent a
 * violation, and then refuse to save a workspace over data the user typed
 * months earlier under the old model.
 *
 * It also has to hold against the live book, not a fixture: three real
 * accounts hold rows executed by a colleague who is not the account's BD, and
 * reading those `exec` values as trackers would have frozen every save on the
 * workspace the moment this shipped.
 *
 * The client always writes an explicit `track` on both the add and the edit
 * path, so every row that has made a claim is checked, and every row that has
 * not is left alone until somebody edits it.
 *
 * Returns null when the rule holds, or the reason it does not.
 */
function stepIntegrity(state) {
  const steps = Array.isArray(state?.steps) ? state.steps : [];
  if (!steps.length) return null;
  const byId = new Map();
  for (const c of (Array.isArray(state?.customers) ? state.customers : [])) {
    if (c && typeof c === 'object' && c.id != null) byId.set(String(c.id), c);
  }
  const norm = (x) => String(x ?? '').trim().toLowerCase();
  for (const s of steps) {
    if (!s || typeof s !== 'object') return 'A next step row is not an object.';
    const c = byId.get(String(s.c ?? ''));
    if (!c) return `A next step refers to customer "${String(s.c ?? '')}", which does not exist.`;
    const track = norm(s.track);
    if (!track) continue;   /* no declared tracker -> nothing to police (§5 legacy rows) */
    const onAccount = [c.owner, c.sa].map(norm).filter(Boolean);
    if (!onAccount.length) continue;   /* account has no owners yet — nothing to compare against */
    if (!onAccount.includes(track)) {
      return `Next step "${String(s.t ?? s.id ?? '')}" is tracked by "${String(s.track)}", `
        + `who is not a Primary BD or Primary SA of ${String(c.name ?? c.id)} `
        + `(BD: ${String(c.owner || 'unset')}, SA: ${String(c.sa || 'unset')}).`;
    }
  }
  return null;
}

/**
 * §5 on the one field where it is a real decision: an SA does not own the money.
 *
 * `owner` is not a label — it decides whose book the account is in, which is
 * what `visibleAccountIds` reads to decide who can see the row at all. So an SA
 * writing it is not a small edit; it is handing themselves the account, and
 * taking it off whoever had it. `onboard` and `health` are the same half of the
 * bargain: how the account stands. An SA may read all three — that is what
 * the shared record is for — and may write none of them.
 *
 * WHY THIS IS HERE, AND WHAT IT IS NOT
 * ------------------------------------
 * The client has no `commercial` capability on the server's side of the wire:
 * `CAPS` lives in the page, and the page is the thing being written to. The
 * role matrix the product states out loud — on the Today banner, in the Admin
 * panel — says an SA owns the machines and not the money, and until now that
 * was true of every screen and of no request. This is the rule.
 *
 * It is deliberately NOT a `commercial` dimension. A dimension would have to be
 * taught to the capability table, the session handshake, the audit row and the
 * delete path, and every one of those is a new place for the same mistake. The
 * rule is one question with three fields in it.
 *
 * WHAT IT LEAVES ALONE
 * --------------------
 * Only a changed value is refused. A client re-sends the whole row on every
 * save, so a row that arrives identical was not an edit — comparing against
 * the disk copy is what keeps an ordinary BD save, and an SA save that touches
 * nothing but the estate, from being refused for rows it did not change.
 *
 * An `admin`, a `bd`, and a caller with no account at all (`WB_OPEN`, and the
 * first-run setup where the person at the keyboard is the owner) are untouched.
 * `manager` and `viewer` never reach here: `WRITE_ROLES` refuses them earlier.
 *
 * Returns null when the rule holds, or the reason it does not.
 */
const SA_LOCKED_FIELDS = ['owner', 'onboard', 'health'];
function saCommercialGuard(disk, incoming, user) {
  /* No account means no role to hold to, and the open copy has exactly one
     person in it who is the owner of everything. A role that is not `sa` has
     nothing to be stopped from here. */
  if (!user || user.role !== 'sa') return null;
  const diskRows = Array.isArray(disk?.customers) ? disk.customers : [];
  const inRows = Array.isArray(incoming?.customers) ? incoming.customers : [];
  if (!diskRows.length || !inRows.length) return null;
  const byId = new Map();
  for (const c of diskRows) if (c && c.id != null) byId.set(String(c.id), c);
  for (const row of inRows) {
    if (!row || row.id == null) continue;
    const was = byId.get(String(row.id));
    /* A row the disk has never seen is a creation, and creation is already
       gated by `WRITE_ROLES` — an SA is not in the business of adding
       accounts, and refusing here would be a second rule saying a weaker
       version of the first. */
    if (!was) continue;
    for (const f of SA_LOCKED_FIELDS) {
      /* Rows written before `onboard` existed carry nothing there, while the
         new client always sends a boolean. Absent means false — otherwise every
         legacy row reads as changed on an SA's first save after the upgrade. */
      const a = row[f] ?? (f === 'onboard' ? false : '');
      const b = was[f] ?? (f === 'onboard' ? false : '');
      if (String(a) === String(b)) continue;
      const label = f === 'owner' ? 'the Owner' : (f === 'onboard' ? 'Onboard status' : 'the Health');
      return `An SA cannot change ${label} of ${String(was.name ?? row.id)}. `
        + `§5: a BD owns the money — value, stage, close date, who owns what — `
        + `and an SA owns the machines. Ask the account's Primary BD `
        + `(${String(was.owner || 'unset')}) to change it.`;
    }
  }
  return null;
}

/* ------------------------------------------------------------ static (dist) */

async function serveStatic(req, res, pathname, cors) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    // A malformed escape (`/%zz`) is a bad request, not a server fault.
    res.writeHead(400, { 'Content-Type': 'text/plain', ...cors });
    res.end('Bad request');
    return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.resolve(DIST_DIR, '.' + path.posix.normalize(rel));
  // Never escape dist/. `startsWith(DIST_DIR)` alone is not enough: it also
  // accepts a sibling like `<root>/dist-other`, because that string merely
  // begins with `<root>/dist`. Compare against the directory plus a separator.
  if (target !== DIST_DIR && !target.startsWith(DIST_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain', ...cors });
    res.end('Forbidden');
    return;
  }
  try {
    const buf = await fsp.readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...cors,
    });
    res.end(buf);
  } catch {
    const html = `\
<!doctype html><meta charset="utf-8"><title>Workbench</title>
<style>body{font:14px/1.6 -apple-system,Segoe UI,sans-serif;margin:48px;color:#111;max-width:36em}
code{background:#f4f4f5;padding:2px 6px;border-radius:4px}</style>
<h1>Data server is running</h1>
<p>Your work is stored in <code>${DATA_FILE}</code>.</p>
<p>The app has not been built yet, so there is nothing to serve here.</p>
<p>Run <code>npm run build</code>, then reload.</p>`;
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', ...cors });
    res.end(html);
  }
}

/* ------------------------------------------------------------------ routing */

const handler = async (req, res, secure) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  /* On every response, before anything can return early: see securityHeaders
     for what the CSP does and does not promise. */
  for (const [k, v] of Object.entries(securityHeaders(secure))) res.setHeader(k, v);

  /* The one gate that keeps a random web page out of the customer data. */
  const cors = corsFor(req);
  if (!cors) {
    /* Diagnostics for a hosted deployment, off unless asked for. A reverse
       proxy that forwards neither `Host` nor `X-Forwarded-Host` leaves the
       server unable to name itself, and the only way to find out what the
       browser is actually arriving with is to look. One line per refusal. */
    if (process.env.WB_ORIGIN_DEBUG) {
      try {
        fsSync.appendFileSync(
          process.env.WB_ORIGIN_DEBUG,
          `${stamp()} refused  origin=${req.headers.origin ?? '-'}  host=${req.headers.host ?? '-'}` +
            `  x-forwarded-host=${req.headers['x-forwarded-host'] ?? '-'}` +
            `  via=${req.headers['via'] ?? '-'}\n`,
        );
      } catch {
        /* Diagnostics must never break the request they are describing. */
      }
    }
    /* No CORS headers at all: the browser then refuses to hand even this
       error back to the page, which is the honest answer to a stranger. */
    send(res, 403, { ok: false, error: 'Cross-origin requests are not allowed.' }, {});
    return;
  }

  if (pathname.startsWith('/api/')) {
    const retry = apiThrottle(req);
    if (retry) {
      send(res, 429, { ok: false, error: `Too many requests. Try again in ${retry}s.`, code: 'throttled' },
        cors, { 'Retry-After': String(retry) });
      return;
    }
  }

  /* Every write has to say where it came from. */
  if (!csrfOk(req)) {
    send(res, 403, {
      ok: false,
      error: 'This request did not say where it came from. Reload the app and try again.',
      code: 'csrf',
    }, cors);
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  try {
    /* ---------------------------------------------------------- health */
    /* Deliberately open: the top bar needs to know whether the server is
       there, and the answer reveals nothing but a file size. */
    if (pathname === '/api/health') {
      const info = await statFile();
      send(res, 200, { ok: true, file: DATA_FILE, ...info, rev: await readRev() }, cors);
      return;
    }

    /* -------------------------------------------------- company lookup */
    /* Reads a company's own website and the public record about it. Real HTTP
       out, real HTML back — nothing here is written by hand. Requires a signed
       -in user who may create records: an open proxy is not what this is. */
    /* Step one of a lookup: WHO could the typed name mean? The client shows
       the shortlist and the person picks; only then does step two read the
       chosen company. Guessing on their behalf is how a wrong customer gets
       created with a straight face. */
    if (pathname === '/api/company-lookup/choices' && req.method === 'GET') {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      if (who.user && !WRITE_ROLES.has(who.user.role)) {
        send(res, 403, { ok: false, error: 'Your role cannot add customers.', code: 'forbidden' }, cors);
        return;
      }
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) {
        send(res, 400, { ok: false, error: 'Type a company name or their website.', code: 'no-query' }, cors);
        return;
      }
      let out;
      try {
        out = await lookupChoices(q);
      } catch (e) {
        out = { ok: false, code: 'unreachable', error: 'The search failed.', hint: String(e?.message || e) };
      }
      send(res, out.ok ? 200 : (out.code === 'no-query' ? 400 : 502), out, cors);
      return;
    }

    if (pathname === '/api/company-lookup' && req.method === 'GET') {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      if (who.user && !WRITE_ROLES.has(who.user.role)) {
        send(res, 403, { ok: false, error: 'Your role cannot add customers.', code: 'forbidden' }, cors);
        return;
      }
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) {
        send(res, 400, { ok: false, error: 'Type a company name or their website.', code: 'no-query' }, cors);
        return;
      }
      /* An explicit pick from the shortlist pins the record, so the pipeline
         reads exactly the company the person chose — never a re-ranked swap. */
      const pickRaw = (url.searchParams.get('id') || '').trim();
      const pick = /^Q\d{1,12}$/.test(pickRaw) ? pickRaw.toUpperCase() : '';
      let out;
      try {
        out = await lookupCompany(q, { pick });
      } catch (e) {
        out = { ok: false, code: 'unreachable', error: 'The lookup failed.', hint: String(e?.message || e) };
      }
      const status = out.ok ? 200 : (out.code === 'no-query' || out.code === 'invalid' ? 400
        : out.code === 'not-found' ? 404 : 502);
      send(res, status, out, cors);
      return;
    }

    /* -------------------------------------------------------------- AI */
    /* Whether a model is genuinely reachable, and one real call to it.
       The status route exists so the screens can stop claiming "AI" for
       output that no model produced: if nothing is configured, they say so.
       The key never leaves the server — status reports whether one is set. */
    if (pathname === '/api/ai/status' && req.method === 'GET') {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      const st = url.searchParams.get('probe') === '0'
        ? await aiStatus({ probe: false })
        : await aiStatus();
      send(res, 200, st, cors);
      return;
    }

    /* Admin only. Writes data/ai.json — deliberately NOT workbench.json, so a
       key is never inside the state blob that GET /api/data hands out. */
    if (pathname === '/api/ai/config' && (req.method === 'POST' || req.method === 'DELETE')) {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      if (who.user && !isAdminRole(who.user.role)) {
        send(res, 403, { ok: false, error: 'Only an administrator can change the model endpoint.', code: 'forbidden' }, cors);
        return;
      }
      if (process.env.AI_BASE_URL && process.env.AI_API_KEY) {
        send(res, 409, {
          ok: false, code: 'env-managed',
          error: 'This deployment takes its model endpoint from the environment, so it cannot be changed here.',
        }, cors);
        return;
      }
      if (req.method === 'DELETE') {
        await clearAiConfig();
        log('ai: config removed');
        send(res, 200, { ok: true, ...(await aiStatus({ probe: false })) }, cors);
        return;
      }
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { send(res, 400, { ok: false, error: 'Expected JSON.' }, cors); return; }
      const saved = await writeAiConfig(body, who.user ? who.user.name : '');
      if (!saved.ok) { send(res, 400, saved, cors); return; }
      log('ai: endpoint saved');
      send(res, 200, { ok: true, ...(await aiStatus()) }, cors);
      return;
    }

    /* A real call. Any signed-in user may use it; what they are allowed to
       put in the prompt is decided by what their screen can see, and the
       server never adds customer data of its own. */
    /* How much a model is allowed to think. Separate from the endpoint, which
       may be environment-managed and therefore not changeable here. */
    if (pathname === '/api/ai/budget' && req.method === 'POST') {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      if (who.user && !isAdminRole(who.user.role)) {
        send(res, 403, { ok: false, error: 'Only an administrator can change the model budget.', code: 'forbidden' }, cors);
        return;
      }
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { /* fall through to the defaults */ }
      const out = await writeAiBudget(body, who.user ? who.user.name : '');
      send(res, 200, { ok: true, ...out, ...(await aiStatus({ probe: false })) }, cors);
      return;
    }

    /* The legacy door, kept as a shim (task #62). Every ask the page makes is
       meant to go through /api/ai/copilot, where the server assembles the
       context from what the caller may see; this endpoint instead trusts the
       prompt the client wrote, so the caller decides what the model learns.
       It stays ONLY because three legacy call sites still speak it — the
       account brief, the Prepare sheet, the stage-suggest — and the count is
       guarded by verify-copilot-scope, which fails the moment a fourth
       appears. New code must not call it; when the last call site migrates,
       this route retires. */
    if (pathname === '/api/ai/complete' && req.method === 'POST') {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      if (who.user && !WRITE_ROLES.has(who.user.role)) {
        send(res, 403, { ok: false, error: 'Your role cannot ask the model.' , code: 'forbidden' }, cors);
        return;
      }
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { send(res, 400, { ok: false, error: 'Expected JSON.' }, cors); return; }
      const prompt = String(body.prompt || '').slice(0, 12000);
      if (!prompt.trim()) { send(res, 400, { ok: false, error: 'Nothing to ask.', code: 'no-prompt' }, cors); return; }
      try {
        /* The interactive asks (meeting prep, "explain it", palette) go to the
           fast model when one is configured. The reasoning default burns its
           whole 900-token budget thinking and answers with NOTHING — the exact
           "The model returned no text" the Prepare sheet shipped. */
        const out = await aiComplete(prompt, {
          system: String(body.system || '').slice(0, 4000) || undefined,
          temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.2,
          maxTokens: Number.isFinite(Number(body.maxTokens)) ? Math.min(Number(body.maxTokens), 2000) : 900,
          fast: true,
        });
        send(res, 200, { ok: true, ...out }, cors);
      } catch (e) {
        const code = e.code || 'unreachable';
        send(res, code === 'not-configured' ? 503 : 502, { ok: false, code, error: e.message, detail: e.detail || '' }, cors);
      }
      return;
    }

    /* The record-level services. Each one fetches real material and lets the
       model only label or draft over it — the same split the lookup runs on.
       Asking is reading (§17/§18): every role that may see the material may
       ask about it, so the gate is `AI_ROLES_READ`, not `WRITE_ROLES`. What a
       manager still cannot do is confirm a suggested write — that stays with
       the write rules. A viewer is in neither set: even asking spends tokens
       and surfaces data on a screen that role was never meant to work from. */
    const AI_SERVICE_ROLES = AI_ROLES_READ;
    const aiServiceGuard = async () => {
      const who = await identify(req, res, cors, secure);
      if (!who) return null;
      if (who.user && !AI_SERVICE_ROLES.has(who.user.role)) {
        send(res, 403, { ok: false, error: 'Your role cannot use the model on a record.', code: 'forbidden' }, cors);
        return null;
      }
      let body = {};
      try { body = JSON.parse(await readBody(req)); }
      catch { send(res, 400, { ok: false, error: 'Expected JSON.' }, cors); return null; }
      return { who, body };
    };

    if (pathname === '/api/ai/classify' && req.method === 'POST') {
      const ctx = await aiServiceGuard();
      if (!ctx) return;
      try {
        const out = await classifyIndustryPublic(ctx.body);
        send(res, out.ok ? 200 : 400, out, cors);
      } catch (e) {
        send(res, 502, { ok: false, error: e.message || 'The classification did not answer.' }, cors);
      }
      return;
    }

    if (pathname === '/api/ai/brief' && req.method === 'POST') {
      const ctx = await aiServiceGuard();
      if (!ctx) return;
      try {
        const out = await companyBrief(ctx.body);
        send(res, out.ok ? 200 : 400, out, cors);
      } catch (e) {
        send(res, 502, { ok: false, error: e.message || 'The draft did not answer.' }, cors);
      }
      return;
    }

    if (pathname === '/api/ai/news' && req.method === 'POST') {
      const ctx = await aiServiceGuard();
      if (!ctx) return;
      try {
        const out = await collectNews(ctx.body);
        send(res, out.ok ? 200 : 400, out, cors);
      } catch (e) {
        send(res, 502, { ok: false, error: e.message || 'The newsroom could not be read.' }, cors);
      }
      return;
    }

    /* Reading pasted minutes. The server never writes the result — the
       person reads the extraction and decides what becomes a record. */
    if (pathname === '/api/ai/mom' && req.method === 'POST') {
      const ctx = await aiServiceGuard();
      if (!ctx) return;
      try {
        const out = await readMinutes(ctx.body);
        send(res, out.ok ? 200 : 400, out, cors);
      } catch (e) {
        send(res, 502, { ok: false, error: e.message || 'The minutes could not be read.' }, cors);
      }
      return;
    }

    /* "What should we do next?" — the context arrives already anonymised and
       was shown to the user before it was sent; this side only asks the model. */
    if (pathname === '/api/ai/insights' && req.method === 'POST') {
      const ctx = await aiServiceGuard();
      if (!ctx) return;
      try {
        const out = await salesInsights(ctx.body && ctx.body.facts);
        send(res, out.ok ? 200 : 400, out, cors);
      } catch (e) {
        send(res, 502, { ok: false, error: e.message || 'The model could not be asked.' }, cors);
      }
      return;
    }

    /* ------------------------------------------------- the copilot (§4, §21)
       One door for every ask the page makes. The gate runs synchronously —
       signed in, allowed to ask, the target exists in YOUR scope, the target
       is not confidential — and only then is a task created and run behind
       the response. 404 rather than 403 for a customer outside the caller's
       scope: 403 would confirm the customer exists, which is exactly what
       the scoping is there to hide. The executor re-checks everything at
       run time (the deep gate in assembleBrief): a queued task must survive
       the book moving under it, and a task made through the plain task
       route must not dodge the wall either. */
    if (pathname === '/api/ai/copilot' && req.method === 'POST') {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      if (who.user && !AI_ROLES_READ.has(who.user.role)) {
        send(res, 403, { ok: false, error: 'Your role cannot ask the copilot.', code: 'forbidden' }, cors);
        return;
      }
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { send(res, 400, { ok: false, error: 'Expected JSON.' }, cors); return; }
      const action = String(body.action || '').trim().slice(0, 64);
      if (!action) { send(res, 400, { ok: false, error: 'An ask needs an action.', code: 'no-action' }, cors); return; }
      /* #63 — the deterministic first layer (§19.1). "Which Opportunities
         are overdue?" and its kin are answered by the book, not a model, and
         the brief says so in capitals: Do NOT call AI. An 'answer' ask never
         becomes a task — the table exists because an AI answer takes seconds
         and the caller should not have to babysit a spinner, while this
         answer is computed in the same breath as the request. The view is
         the one GET /api/data would hand this very caller (scoped, renamed,
         ages derived), so the rules read exactly what the caller may see;
         and because nothing here reaches a model, the confidential wall
         does not apply — it governs what may be sent to a model, not what
         a person may read, and the owner's screen already shows them the
         same rows.
         #64 — the miss goes to the classifier, as a task. The rules are
         conservative on purpose; a question they do not recognise is not a
         dead end, it is §19.2's second half: one fast, structured call says
         which handler the ask belongs to, and the answer runs behind the
         response where a 90-second model timeout cannot hang an HTTP
         request. No model configured is not an error to hide behind a
         spinner — it comes back as an honest miss with a reason, and the
         page says what it can do without one. */
      if (action === 'answer') {
        const question = String(body.question || '').trim().slice(0, 500);
        if (!question) {
          send(res, 400, { ok: false, error: 'An answer needs a question.', code: 'no-question' }, cors);
          return;
        }
        const scope = visibleAccountIds(who.disk, who.user);
        const view = deriveOppAges(renameCollections(scopeState(who.disk ?? {}, scope)));
        const hit = answerByRule(question, view);
        if (hit.kind === 'rule') {
          send(res, 200, { ok: true, ...hit }, cors);
          return;
        }
        const ai = await readAiConfig();
        if (!ai || !ai.base || !ai.key || !ai.model) {
          send(res, 200, { ok: true, kind: 'unmatched', reason: 'no-model' }, cors);
          return;
        }
        const { task, reused } = await createTask({
          userId: who.user ? who.user.id : 'open', action, kind: 'read', question, contextRev: body.contextRev ?? null,
        });
        if (!reused) runTask(task.id);   /* classify, then answer, behind the response */
        send(res, 200, { ok: true, kind: 'task', task, reused }, cors);
        return;
      }
      /* #66 — the reusable summary. A completed summary of the same record
         at the book's CURRENT revision is the answer already: hand it back
         and spend nothing. The rev is read server-side, at ask time — the
         client's opinion of the revision is not the invalidation key. Every
         scope/confidential check for a summary lives in the executor's deep
         gate (runSummaryTask): one gate, one shape, no drift between the
         customer form and the opportunity form. */
      if (action === 'summary') {
        const targetId = String(body.targetId || '').trim().slice(0, 64);
        if (!targetId) {
          send(res, 400, { ok: false, error: 'A summary needs a record to summarise.', code: 'no-target' }, cors);
          return;
        }
        const ai = await readAiConfig();
        if (!ai || !ai.base || !ai.key || !ai.model) {
          send(res, 400, { ok: false, error: 'The model is not configured, so nothing can be summarised yet.', code: 'no-model' }, cors);
          return;
        }
        const rev = await readRev();
        const cached = await findReusableSummary(
          who.user ? who.user.id : 'open', 'summary', targetId, rev);
        if (cached) {
          send(res, 200, { ok: true, kind: 'task', task: cached, reused: true, cached: true }, cors);
          return;
        }
        const { task, reused } = await createTask({
          userId: who.user ? who.user.id : 'open', action, targetId, kind: 'read', contextRev: rev,
        });
        if (!reused) runTask(task.id);   /* the deep gate, then the model, behind the response */
        send(res, 200, { ok: true, kind: 'task', task, reused }, cors);
        return;
      }
      /* #68 — My Work Copilot (§5, Test 1). No target: the list is the
         caller's whole visible book. The walls — scope and confidential —
         are applied by the assembler from the server's own reading of the
         book, never taken on the caller's word, exactly as the summary's
         deep gate does for one record. No cache: "this week" is a moving
         window and the honest price of asking it again is asking it again. */
      if (action === 'focus-week') {
        const ai = await readAiConfig();
        if (!ai || !ai.base || !ai.key || !ai.model) {
          send(res, 400, { ok: false, error: 'The model is not configured, so nothing can be suggested yet.', code: 'no-model' }, cors);
          return;
        }
        const rev = await readRev();
        const { task, reused } = await createTask({
          userId: who.user ? who.user.id : 'open', action, kind: 'read', contextRev: rev,
        });
        if (!reused) runTask(task.id);   /* assemble, then ask, behind the response */
        send(res, 200, { ok: true, kind: 'task', task, reused }, cors);
        return;
      }
      /* #70 — the opportunity analysis (§7, Test 3). The target is an
         OPPORTUNITY id, so the customer fast gate below is not this
         action's to use — the executor's deep gate checks both walls on
         the scoped view itself (the summary's opportunity shape does the
         same). A reasoning model spends its budget thinking, so this ask
         is exactly the slow kind the task table exists for; the question
         rides the row and no answer is cached, for the same reason the
         customer brief gives: the four focuses are different asks. */
      if (action === 'analyze-opp') {
        const targetId = String(body.targetId || '').trim().slice(0, 64);
        if (!targetId) {
          send(res, 400, { ok: false, error: 'An analysis needs an opportunity to analyse.', code: 'no-target' }, cors);
          return;
        }
        const ai = await readAiConfig();
        if (!ai || !ai.base || !ai.key || !ai.model) {
          send(res, 400, { ok: false, error: 'The model is not configured, so nothing can be analysed yet.', code: 'no-model' }, cors);
          return;
        }
        const rev = await readRev();
        const question = String(body.question || '').trim().slice(0, 300);
        const { task, reused } = await createTask({
          userId: who.user ? who.user.id : 'open', action, targetId, kind: 'read', contextRev: rev, question,
        });
        if (!reused) runTask(task.id);   /* the deep gate, then the sections, behind the response */
        send(res, 200, { ok: true, kind: 'task', task, reused }, cors);
        return;
      }
      /* #74 — controlled product recommendations (§13, §27). The target is
         an opportunity (the card's ask) or a customer (a meeting's reading),
         so the fast gate above — which reads customer ids — cannot judge it;
         the executor's deep gate does, on both shapes, through the same
         assemblers every other ask walks. The reconciliation is the point:
         what comes back may only name the Reference, and the route needs
         no gate of its own for that — the executor enforces it on every
         reply, task or retry. */
      if (action === 'suggest-products') {
        const targetId = String(body.targetId || '').trim().slice(0, 64);
        if (!targetId) {
          send(res, 400, { ok: false, error: 'A recommendation needs a record to read.', code: 'no-target' }, cors);
          return;
        }
        const ai = await readAiConfig();
        if (!ai || !ai.base || !ai.key || !ai.model) {
          send(res, 400, { ok: false, error: 'The model is not configured, so nothing can be recommended yet.', code: 'no-model' }, cors);
          return;
        }
        const rev = await readRev();
        const question = String(body.question || '').trim().slice(0, 300);
        const { task, reused } = await createTask({
          userId: who.user ? who.user.id : 'open', action, targetId, kind: 'read', contextRev: rev, question,
        });
        if (!reused) runTask(task.id);   /* the gate, the Reference, the reconciliation — behind the response */
        send(res, 200, { ok: true, kind: 'task', task, reused }, cors);
        return;
      }
      if (!hasExecutor(action)) {
        send(res, 400, { ok: false, error: `Unknown action "${action}".`, code: 'unknown-action' }, cors);
        return;
      }
      const targetId = String(body.targetId || '').slice(0, 64);
      /* The fast gate — only for asks that name a customer. Actions without
         a target (the echo probe, the global questions later) have nothing
         to check here; the executor's deep gate still holds for everything. */
      if (targetId && who.disk) {
        const ids = visibleAccountIds(who.disk, who.user);
        const customer = ids === null
          ? (who.disk.customers || []).find((c) => c && c.id === targetId)
          : (ids.has(targetId) ? (who.disk.customers || []).find((c) => c && c.id === targetId) : undefined);
        if (!customer) { send(res, 404, { ok: false, error: 'No such customer.', code: 'not-found' }, cors); return; }
        if (customer.confidential) {
          send(res, 403, { ok: false, code: 'confidential',
            error: 'This customer is confidential — their data is never sent to a model. Their records behave exactly the same in every other way.' }, cors);
          return;
        }
      }
      /* #69 — the customer brief (§6, Test 2): one customer, the caller's
         own records, facts and the model's reading kept apart. The question
         travels with the ask — "brief me", "what needs attention" and
         "prepare me for the meeting" focus the same facts differently, so a
         cached row for one wording would answer another wording wrongly.
         No cache, for the same honest reason as focus-week: the price of a
         differently-focused ask is asking it. The branch sits behind the
         fast gate above, so a customer the caller cannot see (or a
         confidential one) is refused before a task is ever created; the
         executor's deep gate re-checks both on its own reading, as every
         assembling action must. */
      if (action === 'brief-customer') {
        if (!targetId) {
          send(res, 400, { ok: false, error: 'A brief needs a customer to brief on.', code: 'no-target' }, cors);
          return;
        }
        const ai = await readAiConfig();
        if (!ai || !ai.base || !ai.key || !ai.model) {
          send(res, 400, { ok: false, error: 'The model is not configured, so nothing can be briefed yet.', code: 'no-model' }, cors);
          return;
        }
        const rev = await readRev();
        const question = String(body.question || '').trim().slice(0, 300);
        const { task, reused } = await createTask({
          userId: who.user ? who.user.id : 'open', action, targetId, kind: 'read', contextRev: rev, question,
        });
        if (!reused) runTask(task.id);   /* the deep gate, then the sections, behind the response */
        send(res, 200, { ok: true, kind: 'task', task, reused }, cors);
        return;
      }
      const kind = body.kind === 'suggest' ? 'suggest' : 'read';
      const { task, reused } = await createTask({
        userId: who.user ? who.user.id : 'open', action, targetId, kind, contextRev: body.contextRev ?? null,
      });
      if (!reused) runTask(task.id);   /* the response leaves; the model runs behind it */
      send(res, 200, { ok: true, task, reused }, cors);
      return;
    }

    /* ------------------------------------------------ copilot tasks (§21–§24)
       The async half of the copilot. A POST here does not wait for the model:
       it creates a task and answers immediately, the model call runs behind
       the response, and the page polls GET until the state lands. The dedupe
       key (userId:action:targetId) makes a double-click cheap — while one ask
       is queued or running, a second identical POST returns THE SAME task
       (§24, Test 12). Asking again after a task finishes is allowed; answers
       go stale. */
    if (pathname === '/api/ai/tasks' && req.method === 'POST') {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      if (who.user && !AI_ROLES_READ.has(who.user.role)) {
        send(res, 403, { ok: false, error: 'Your role cannot ask the copilot.', code: 'forbidden' }, cors);
        return;
      }
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { send(res, 400, { ok: false, error: 'Expected JSON.' }, cors); return; }
      const action = String(body.action || '').trim().slice(0, 64);
      if (!action) { send(res, 400, { ok: false, error: 'An ask needs an action.', code: 'no-action' }, cors); return; }
      const targetId = String(body.targetId || '').slice(0, 64);
      const kind = body.kind === 'suggest' ? 'suggest' : 'read';
      /* The revision the ask was made against — recorded now, not at run
         time, because the book may move between the ask and the answer; the
         context cache (#64) will lean on this field. */
      const { task, reused } = await createTask({
        userId: who.user ? who.user.id : 'open', action, targetId, kind, contextRev: body.contextRev ?? null,
      });
      if (!reused) runTask(task.id);   /* the response is already leaving; the model runs behind it */
      send(res, 200, { ok: true, task, reused }, cors);
      return;
    }

    /* The poll. A session may only ever read its own tasks, so the answer is
       safe for every signed-in role — a viewer with no tasks gets an empty
       list, not a door. */
    if (pathname === '/api/ai/tasks' && req.method === 'GET') {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      const since = Number(url.searchParams.get('since') || 0);
      const uid = who.user ? who.user.id : 'open';
      send(res, 200, { ok: true, tasks: await tasksFor(uid, Number.isFinite(since) ? since : 0) }, cors);
      return;
    }

    /* Retry: bring a FAILED task back as queued, same id. Only the owner's —
       a task that is not yours is not found, the same discipline /api/file
       keeps: the task table must not become a way to probe who asked what. */
    if (pathname.startsWith('/api/ai/tasks/') && pathname.endsWith('/retry') && req.method === 'POST') {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      const id = pathname.slice('/api/ai/tasks/'.length, -'/retry'.length);
      const existing = id ? await findTask(id) : null;
      const uid = who.user ? who.user.id : 'open';
      if (!existing || existing.userId !== uid) {
        send(res, 404, { ok: false, error: 'No such task.', code: 'not-found' }, cors);
        return;
      }
      if (who.user && !AI_ROLES_READ.has(who.user.role)) {
        send(res, 403, { ok: false, error: 'Your role cannot ask the copilot.', code: 'forbidden' }, cors);
        return;
      }
      const r = await retryTask(id);
      if (r.code === 'ok') {
        runTask(id);
        send(res, 200, { ok: true, task: r.task }, cors);
        return;
      }
      if (r.code === 'not-found') {
        send(res, 404, { ok: false, error: 'No such task.', code: 'not-found' }, cors);
        return;
      }
      send(res, 409, {
        ok: false, code: r.code, task: r.task || null,
        error: r.code === 'not-retryable'
          ? 'This task cannot be retried.'
          : 'Only a failed task can be retried.',
      }, cors);
      return;
    }

    /* --------------------------------------------------------- session */
    if (pathname === '/api/session' && req.method === 'GET') {
      const disk = await readState();
      const hasCredentials = !!disk && !!disk.credentials && Object.keys(disk.credentials).length > 0;
      const requiresAuth = hasCredentials && !OPEN_MODE;
      const s = sessionFor(req);
      const user = s && (disk?.users ?? []).find((u) => u.id === s.userId);
      send(res, 200, {
        ok: true,
        requiresAuth,
        setup: !hasCredentials,
        authed: !!user,
        user: user ? PUBLIC_USER_FIELDS(user, !!disk.credentials?.[user.id]) : null,
      }, cors);
      return;
    }

    /* -------------------------------------------------------- directory */
    /* Who can sign in. Needed to draw the sign-in screen, and it names no
       hashes - only whether an account has a password yet. */
    if (pathname === '/api/directory' && req.method === 'GET') {
      const disk = await readState();
      const hasCredentials = !!disk && !!disk.credentials && Object.keys(disk.credentials).length > 0;
      if (OPEN_MODE || !hasCredentials) {
        send(res, 200, { ok: true, setup: true, users: [] }, cors);
        return;
      }
      const users = (disk.users ?? [])
        .filter((u) => !!disk.credentials?.[u.id])
        /* A disabled account is not an option. It has to be filtered HERE and
           not only at the password check, because this list is the sign-in
           screen itself: a name that is offered and then always refused is a
           door drawn on a wall. Removing somebody has to mean they stop
           appearing as a colleague you can sign in as, or offboarding is a
           promise the product does not keep. */
        .filter((u) => u.active !== false)
        .map((u) => PUBLIC_USER_FIELDS(u, true));
      send(res, 200, { ok: true, setup: false, users }, cors);
      return;
    }

    /* ----------------------------------------------------------- login */
    if (pathname === '/api/login' && req.method === 'POST') {
      const raw = await readBody(req);
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { /* handled below */ }
      const userId = String(payload.userId ?? '').trim();
      const password = typeof payload.password === 'string' ? payload.password : '';
      const disk = await readState();

      if (!disk) {
        send(res, 409, { ok: false, error: 'The workspace is not set up yet.' }, cors);
        return;
      }
      const gate = throttleState(req.socket?.remoteAddress ?? '?', userId);
      if (gate.blocked) {
        send(res, 429, { ok: false, error: `Too many failed attempts. Try again in ${gate.retryIn}s.` }, cors);
        return;
      }

      /* The sign-in box says "Work email", so people type their work email —
         and until now only the internal id (`u_teh`) was ever matched, which
         meant a colleague typing their own address was told the password was
         wrong and had to ask an admin for a string of letters. Match the id,
         then the email, then the name, and always settle on one person:
         two colleagues sharing a name is refused rather than guessed at.
         The name is matched on a SQUASHED form (`tehbinshun`) and not only on
         the slug (`teh-bin-shun`), because the address a colleague types is
         built from their name with the separators left out or swapped: the
         same person writes `tehbinshun@…` and `teh.binshun@…` on two different
         days, and both of them are them. Squashing the local part, the name
         and the slug onto one alphabet (`a-z0-9`) makes those one answer while
         still refusing to guess between two genuinely different people. */
      const wanted = userId.toLowerCase();
      const users = disk.users ?? [];
      const squash = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const nameKey = (u) => String(u.name ?? '').trim().toLowerCase();
      const slugKey = (u) => nameKey(u).replace(/\s+/g, '-');
      const localPart = wanted.includes('@') ? wanted.slice(0, wanted.indexOf('@')) : '';
      const wantedSquashed = squash(localPart || wanted);

      const byId = users.find((u) => u.id === userId);
      const byEmail = users.find((u) => String(u.email ?? '').trim().toLowerCase() === wanted);
      /* Everyone the typed string could be. The squashed comparison is what
         makes `tehbinshun@…`, `teh.binshun@…` and `Teh Bin Shun` one person,
         but it is also what makes two DIFFERENT people look like one: squash
         `Teh Bin Shun` and `Teh Binshun` and both answer `tehbinshun`. Deciding
         between them by counting — the old `byName.length === 1` — got that
         backwards in the worst way: a colleague whose name merely collides with
         yours could lock you out of your own account, and an attacker could
         arrange a collision on purpose. So the candidates are not counted, they
         are OFFERED THE PASSWORD, and the one whose credential accepts it is
         the answer. A collision now means "two people who must both type their
         password", not "neither of them may". */
      const candidates = byId ? [byId]
        : byEmail ? [byEmail]
          : users.filter((u) => nameKey(u) === wanted || slugKey(u) === wanted
            || squash(nameKey(u)) === wantedSquashed);

      let user = null, cred = null;
      for (const c of candidates) {
        const cc = disk.credentials?.[c.id];
        /* Locked and inactive are refused BEFORE the password, and the loop
           moves on rather than stopping: the colliding colleague being locked
           is not a reason to answer the real person's attempt with a refusal
           that was about somebody else. */
        if (!cc || c.locked || c.active === false) continue;
        if (await verifyPassword(password, cc)) { user = c; cred = cc; break; }
      }
      const okPw = !!user;
      if (!okPw) {
        noteFailure(gate.key);
        // One message for every failure mode: "no such user" vs "wrong
        // password" is exactly the distinction an attacker is probing for.
        send(res, 401, { ok: false, error: 'Incorrect password.' }, cors);
        return;
      }
      failures.delete(gate.key);
      /* Keyed on the resolved id, not whatever was typed: a session that stored
         an email would be a different person from the one that stored `u_teh`,
         and every ownership check downstream reads that id. */
      const token = createSession(user.id, req);
      /* A starting password handed out by an administrator is known to at least
         two people until it is changed, so sign-in is not finished until it is. */
      const mustChange = cred?.mustChange === true;
      log(`sign in: ${user.name} (${user.role}) from ${req.socket?.remoteAddress ?? '?'}`);
      send(res, 200, { ok: true, user: PUBLIC_USER_FIELDS(user, true), token, mustChange }, cors,
        { 'Set-Cookie': cookieHeader(token, secure) });
      return;
    }

    /* --------------------------------------------- remembered device
       "Keep me signed in on this device" is a token the browser keeps and the
       server honours - by exchanging it for a fresh cookie session. It is the
       same in-memory session store, so a server restart invalidates every
       remembered device at once: the honest behaviour, not a promise of
       forever. A dead or forged token is refused and forgotten. */
    if (pathname === '/api/login/token' && req.method === 'POST') {
      let payload = {};
      try { payload = JSON.parse(await readBody(req) || '{}'); } catch { /* handled below */ }
      const token = String(payload.token || '');
      const st = token ? sessions.get(token) : null;
      if (!st || Date.now() - st.lastSeen > SESSION_TTL_MS) {
        if (token) sessions.delete(token);
        send(res, 401, { ok: false, error: 'This device is no longer remembered — sign in again.' }, cors);
        return;
      }
      const user = ((await readState())?.users ?? []).find((u) => u.id === st.userId);
      if (!user || user.locked || user.active === false) {
        sessions.delete(token);
        send(res, 401, { ok: false, error: 'This device is no longer remembered — sign in again.' }, cors);
        return;
      }
      const fresh = createSession(user.id, req);
      st.lastSeen = Date.now();
      log(`device remembered: ${user.name} (${user.role})`);
      send(res, 200, { ok: true, user: PUBLIC_USER_FIELDS(user, true), token: fresh }, cors,
        { 'Set-Cookie': cookieHeader(fresh, secure) });
      return;
    }

    /* ------------------------------------------------- create an account
       Accounts are made by an administrator and nobody else. There is no
       sign-up page to find, so there is nothing to accept and no invitation
       left hanging in somebody's inbox. The hash is written here — the client
       never sees a password policy it could choose to ignore. */
    if (pathname === '/api/users' && req.method === 'POST') {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      /* An administrator is required — not merely "not a non-administrator".
         `who.user && ...` skips the test entirely for a caller with no
         account, which is who a stranger is. Since `identify` was tightened
         above, `who.open` is now only the two windows that genuinely have
         nobody to ask: a book with no customers and no passwords (the first
         administrator) and `WB_OPEN`, the operator's own choice to run a
         one-person copy with no door. A book full of customers and no
         passwords no longer reaches here at all — it is answered 401. */
      if (!who.open && (!who.user || !isAdminRole(who.user.role))) {
        send(res, 403, { ok: false, error: 'Only an administrator can create an account.', code: 'forbidden' }, cors);
        return;
      }
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); }
      catch { send(res, 400, { ok: false, error: 'Body is not valid JSON.' }, cors); return; }

      const name = String(body?.name ?? '').trim();
      const email = String(body?.email ?? '').trim();
      const role = String(body?.role ?? 'bd').trim();
      const password = typeof body?.password === 'string' ? body.password : '';
      if (!name) { send(res, 400, { ok: false, error: 'A name is required.' }, cors); return; }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        send(res, 400, { ok: false, error: 'That work email is not an email address.' }, cors); return;
      }
      if (!ROLES.has(role)) { send(res, 400, { ok: false, error: `Unknown role "${role}".` }, cors); return; }
      const problems = passwordIssues(password);
      if (problems.length) { send(res, 400, { ok: false, error: problems.join(' · ') }, cors); return; }

      const out = await serialize(async () => {
        const disk = (await readState()) ?? {};
        disk.users = Array.isArray(disk.users) ? disk.users : [];
        disk.credentials = disk.credentials ?? {};
        const clash = disk.users.find((u) => String(u.name ?? '').toLowerCase() === name.toLowerCase()
          || (email && String(u.email ?? '').toLowerCase() === email.toLowerCase()));
        if (clash) return { status: 409, body: { ok: false, error: `${name} already has an account.` } };
        const id = 'u_' + crypto.randomBytes(6).toString('hex');
        const user = {
          id, name,
          email: email || undefined,
          role,
          createdAt: new Date().toISOString(),
          createdBy: who.user?.id ?? null,
          active: true,
        };
        disk.users.push(user);
        disk.credentials[id] = { userId: id, ...hashCredential(password), mustChange: true, updatedAt: user.createdAt };
        disk.setupComplete = true;
        noteAuthEvent(disk, id, `Password issued for ${name} by ${who.user?.name ?? 'the first-run setup'}, with a forced change on first sign-in`);
        await writeState(disk);
        const rev = (await readRev()) + 1;
        const info = await statFile();
        await writeRev(rev, info.savedAt, info.bytes);
        log(`account created: ${name} (${role}) by ${who.user?.name ?? 'setup'}`);
        return { status: 200, body: { ok: true, user: PUBLIC_USER_FIELDS(user, true) } };
      });
      send(res, out.status, out.body, cors);
      return;
    }

    /* -------------------------------------------------- change a role
       The roster the server signs people in with, changed by the same route
       that created it. Without this, an administrator could move somebody from
       BD to Admin on screen while the server — the thing that actually decides
       — went on treating them as BD. */
    if (pathname === '/api/user' && req.method === 'POST') {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      /* Same rule as creating an account above: a role, a lock and a password
         reset are administrator acts, and a caller with no account is not an
         administrator. */
      if (!who.open && (!who.user || !isAdminRole(who.user.role))) {
        send(res, 403, { ok: false, error: 'Only an administrator can change a role.', code: 'forbidden' }, cors);
        return;
      }
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); }
      catch { send(res, 400, { ok: false, error: 'Body is not valid JSON.' }, cors); return; }
      const id = String(body?.id ?? '').trim();
      const out = await serialize(async () => {
        const disk = (await readState()) ?? {};
        const users = Array.isArray(disk.users) ? disk.users : [];
        const user = users.find((u) => u.id === id)
          || users.find((u) => String(u.name ?? '').toLowerCase() === id.toLowerCase());
        /* The roster is server-owned (a save never writes it), so a name whose
           account is already gone has exactly one door left — this one. A
           removal whose account half landed and whose roster half did not used
           to end here as a flat 404, and the row stayed forever. */
        if (!user && body?.remove === true){
          const roster = Array.isArray(disk.team) ? disk.team : [];
          const member = roster.find((t) => String(t.n ?? '').toLowerCase() === id.toLowerCase());
          if (member){
            disk.team = roster.filter((t) => t !== member);
            await writeState(disk);
            const revR0 = (await readRev()) + 1;
            const infoR0 = await statFile();
            await writeRev(revR0, infoR0.savedAt, infoR0.bytes);
            log(`roster name removed: ${member.n} by ${who.user?.name ?? '?'}`);
            return { status: 200, body: { ok: true, removed: member.n, rosterOnly: true } };
          }
        }
        if (!user) return { status: 404, body: { ok: false, error: 'No such person.' } };

        /* Removing an account is not the same as erasing a history: the audit
           trail keeps their name on every act they ever did, because history
           that rewrites itself is not history. What goes is the door. */
        if (body?.remove === true) {
          if (user.id === who.user?.id) {
            return { status: 409, body: { ok: false, error: 'You cannot remove your own account.' } };
          }
          if (isAdminRole(user.role) && users.filter((u) => isAdminRole(u.role)).length <= 1) {
            return { status: 409, body: { ok: false, error: 'The last administrator cannot be removed — there would be nobody left to run the workspace.' } };
          }
          disk.users = users.filter((u) => u.id !== user.id);
          if (disk.credentials && disk.credentials[user.id] !== undefined) delete disk.credentials[user.id];
          /* The roster row goes with the account: the roster is server-owned,
             so leaving it here meant the row outlived the account and no
             later click could ever remove it (the PUT cannot write it). */
          if (Array.isArray(disk.team)){
            const name = String(user.name ?? '').toLowerCase();
            disk.team = disk.team.filter((t) => String(t.n ?? '').toLowerCase() !== name);
          }
          await writeState(disk);
          const revR = (await readRev()) + 1;
          const infoR = await statFile();
          await writeRev(revR, infoR.savedAt, infoR.bytes);
          /* The account is gone, so every session it ever held goes with it —
             including the one it is using. No exception: there is nobody left
             to keep signed in. */
          const killed = killSessions(user.id);
          log(`account removed: ${user.name} (${user.role}) by ${who.user?.name ?? '?'}`);
          if (killed) log(`revoked ${killed} session(s) for ${user.name}`);
          return { status: 200, body: { ok: true, removed: user.id, name: user.name } };
        }

        /* The last administrator may not remove themselves: a workspace with
           nobody who can manage it is a workspace nobody can fix. */
        if (body?.role !== undefined) {
          const role = String(body.role ?? '').trim();
          if (!ROLES.has(role)) return { status: 400, body: { ok: false, error: `Unknown role "${role}".` } };
          if (user.id === who.user?.id && user.role === 'admin' && role !== 'admin') {
            return { status: 409, body: { ok: false, error: 'You cannot demote yourself — there has to be an administrator.' } };
          }
          user.role = role;
        }
        if (body?.active !== undefined) {
          if (user.id === who.user?.id && body.active === false) {
            return { status: 409, body: { ok: false, error: 'You cannot disable your own account.' } };
          }
          user.active = body.active !== false;
        }
        /* The sign-in screen tells a locked-out colleague that their
           administrator resets the password. Until this existed that sentence
           was false — the admin could create a starting password and never
           change it again. A reset always forces a change at next sign-in. */
        if (body?.password !== undefined) {
          const next = String(body.password ?? '');
          const problems = passwordIssues(next);
          if (problems.length) return { status: 400, body: { ok: false, error: problems.join(' · ') } };
          disk.credentials = disk.credentials ?? {};
          disk.credentials[user.id] = {
            userId: user.id, ...hashCredential(next),
            mustChange: true, updatedAt: new Date().toISOString(),
          };
          noteAuthEvent(disk, user.id, `Password reset for ${user.name} by ${who.user?.name ?? 'another admin'}`);
        }
        await writeState(disk);
        const rev = (await readRev()) + 1;
        const info = await statFile();
        await writeRev(rev, info.savedAt, info.bytes);
        /* A new role, a disabled account or a reset password is a change to
           what this person may do, so the sessions already handed out no
           longer speak for them. The caller's own session is spared: an
           administrator is never holding their colleague's token. */
        const killed = killSessions(user.id, who.session?.token);
        log(`account changed: ${user.name} -> ${user.role}${user.active ? '' : ' (disabled)'} by ${who.user?.name ?? '?'}`);
        if (killed) log(`revoked ${killed} session(s) for ${user.name}`);
        return { status: 200, body: { ok: true, user: PUBLIC_USER_FIELDS(user, true) } };
      });
      send(res, out.status, out.body, cors);
      return;
    }

    /* ------------------------------------------- change your own password
       Verifies the current one first, so a session left open on a shared
       machine cannot be used to lock its owner out of their own account. */
    if (pathname === '/api/password' && req.method === 'POST') {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); }
      catch { send(res, 400, { ok: false, error: 'Body is not valid JSON.' }, cors); return; }
      const current = typeof body?.current === 'string' ? body.current : '';
      const next = typeof body?.next === 'string' ? body.next : '';
      const problems = passwordIssues(next);
      if (problems.length) { send(res, 400, { ok: false, error: problems.join(' · ') }, cors); return; }

      const out = await serialize(async () => {
        const disk = (await readState()) ?? {};
        const users = Array.isArray(disk.users) ? disk.users : [];
        const me = users.find((u) => u.id === who.user?.id);
        if (!me) return { status: 404, body: { ok: false, error: 'No such account.' } };
        const cred = disk.credentials?.[me.id];
        if (cred && !await verifyPassword(current, cred)) {
          return { status: 401, body: { ok: false, error: 'The current password is not right.' } };
        }
        disk.credentials = disk.credentials ?? {};
        disk.credentials[me.id] = {
          userId: me.id, ...hashCredential(next),
          mustChange: false, updatedAt: new Date().toISOString(),
        };
        noteAuthEvent(disk, me.id, `Password changed by ${me.name} for their own account`);
        await writeState(disk);
        const rev = (await readRev()) + 1;
        const info = await statFile();
        await writeRev(rev, info.savedAt, info.bytes);
        /* Every other device this account is signed in on is now holding an
           old password. The one that changed it stays: being signed out by
           your own password change would read as a failure. */
        const killed = killSessions(me.id, who.session?.token);
        log(`password changed by ${me.name}`);
        if (killed) log(`revoked ${killed} other session(s) for ${me.name}`);
        return { status: 200, body: { ok: true } };
      });
      send(res, out.status, out.body, cors);
      return;
    }

    /* ---------------------------------------------------------- logout */
    if (pathname === '/api/logout' && req.method === 'POST') {
      const s = sessionFor(req);
      if (s) {
        sessions.delete(s.token);
        /* Signing out is how an operator says "not me, not now" to the empty
           book a reset left behind. Dropping the founder mark with the session
           puts the machine back to the state it was in before the reset — a
           genuinely unset-up deploy, where the window is open to whoever is
           standing at it — instead of leaving a token in `founders` that no
           browser holds and that would keep the window shut forever. */
        founders.delete(s.token);
      }
      /* "Keep me signed in" is the same promise as the session, made to the
         same person. A sign-out that left the remembered device alive would
         let the next reload on this machine exchange the token for a fresh
         cookie and walk straight back in — the door was closed in front of
         the user and reopened behind them. The client hands the token over
         so the server can end it; a body that names no token changes nothing
         (older clients just clear the cookie). */
      try {
        const body = JSON.parse(await readBody(req) || '{}');
        const dt = String(body.deviceToken || '');
        if (dt) sessions.delete(dt);
      } catch { /* no body, or not JSON — nothing remembered to revoke */ }
      send(res, 200, { ok: true }, cors, { 'Set-Cookie': cookieHeader('', secure) });
      return;
    }

    /* --------------------------------------------------- upload a document
       The document itself, not a note saying a document exists. It is stored
       beside the state and only ever served back to a signed-in session — and
       always as an attachment with nosniff, because the fastest way to turn a
       file upload into an XSS hole is to echo someone else's content type. */
    if (pathname === '/api/files' && req.method === 'POST') {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      if (who.user && !WRITE_ROLES.has(who.user.role)) {
        send(res, 403, { ok: false, error: `${who.user.name}'s role is read-only.`, code: 'forbidden' }, cors);
        return;
      }
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); }
      catch { send(res, 400, { ok: false, error: 'Body is not valid JSON.' }, cors); return; }

      const id = String(body?.id ?? '').trim();
      const data = typeof body?.data === 'string' ? body.data : '';
      if (!SAFE_FILE_ID.test(id)) {
        send(res, 400, { ok: false, error: 'That file id is not usable.' }, cors);
        return;
      }
      const b64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
      if (!b64) { send(res, 400, { ok: false, error: 'Nothing was uploaded.' }, cors); return; }
      let buf;
      try { buf = Buffer.from(b64, 'base64'); }
      catch { send(res, 400, { ok: false, error: 'The upload was not readable.' }, cors); return; }
      /* base64 rounds up, and a padded string can decode short; trust the bytes. */
      if (!buf.length) { send(res, 400, { ok: false, error: 'Nothing was uploaded.' }, cors); return; }
      if (buf.length > MAX_FILE_BYTES) {
        send(res, 413, {
          ok: false,
          error: `That file is ${(buf.length / 1048576).toFixed(1)} MB — the limit is ${MAX_FILE_BYTES / 1048576} MB.`
        }, cors);
        return;
      }
      try {
        await writeBlob(id, buf);
      } catch (e) {
        log('could not store an upload:', e.message);
        send(res, 500, { ok: false, error: 'The document could not be stored on the server.' }, cors);
        return;
      }
      log(`file stored: ${id} (${buf.length} bytes) by ${who.user?.name ?? 'unknown'}`);
      send(res, 200, { ok: true, id, bytes: buf.length }, cors);
      return;
    }

    /* ------------------------------------------------- download a document
       Any signed-in role may read it — the same rule as the rest of the book.
       This comment used to SAY "what leaves is scoped by the session, not by
       the URL", and nothing here was scoped: every signed-in member could
       fetch every blob whose id they held, including the id they had just
       seen in somebody else's audit line. Now the file row decides, and when
       the answer is no the answer is the same 404 as a file that never
       existed — "forbidden" would confirm what is behind the id. */
    if (pathname === '/api/file' && req.method === 'GET') {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      const id = String(url.searchParams.get('id') ?? '').trim();
      if (!SAFE_FILE_ID.test(id)) { send(res, 400, { ok: false, error: 'No such document.' }, cors); return; }
      const scopeIds = visibleAccountIds(who.disk, who.user);
      if (scopeIds !== null) {
        const row = (who.disk?.files ?? []).find((f) => f && f.id === id);
        const cid = row ? row.c : undefined;
        if (cid === undefined || cid === null || cid === '' || !scopeIds.has(cid)) {
          send(res, 404, { ok: false, error: 'That document is no longer on the server.' }, cors);
          return;
        }
      }
      const buf = await readBlob(id);
      if (!buf) { send(res, 404, { ok: false, error: 'That document is no longer on the server.' }, cors); return; }
      const name = String(url.searchParams.get('name') ?? '').replace(/[^\w .()\-]+/g, '_').slice(0, 120) || 'document';
      res.writeHead(200, {
        ...cors,
        'Content-Type': 'application/octet-stream',
        'Content-Length': buf.length,
        'Content-Disposition': `attachment; filename="${name}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      res.end(buf);
      return;
    }

    /* ------------------------------------------------------------ read */
    if (pathname === '/api/data' && req.method === 'GET') {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      const info = await statFile();
      const state = who.disk ?? null;
      /* Two filters on the way out, and neither one used to be here.
         - `scopeState` drops the customers this session is not on the team of.
           The browser applied the same rule to the same object, but by then the
           data had already crossed the wire.
         - `stripSecrets` removes the password hashes for EVERY role. They used
           to go to administrators, and nothing in the app needs them: the
           server is the only thing that verifies a password. The marker keeps
           the keys, which is all the client needs to tell "set up" from "first
           run". */
      const scope = visibleAccountIds(state, who.user);
      send(res, 200, {
        ok: true,
        empty: !state,
        state: state ? deriveOppAges(stripSecrets(renameCollections(scopeState(state, scope)))) : null,
        // Tells the client its view is narrowed, so it can stop offering the
        // controls that would only ever come back refused.
        scoped: scope !== null,
        /* Whether this workspace is the seeded sample book. It travels beside
           the state rather than inside it: it is not a row anybody edits, and
           the client's own saves carry no opinion about it (see the PUT). */
        demo: !!(state && state.demo),
        savedAt: info.savedAt,
        bytes: info.bytes,
        rev: await readRev(),
        file: DATA_FILE,
      }, cors);
      return;
    }

    /* ---------------------------------------------------------- export */
    /* Administrator only, and decided here rather than by hiding a button.
       Everything else in the product is scoped by the session; a spreadsheet
       is not — once it is a file on somebody's laptop the account team has no
       say in where it goes, so the server must. */
    if (pathname === '/api/export' && req.method === 'GET') {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      if (!who.user || !isAdminRole(who.user.role)) {
        send(res, 403, {
          ok: false,
          code: 'forbidden',
          error: 'Export is an administrator action. Nothing left the product.',
        }, cors);
        return;
      }
      const kind = (url.searchParams.get('kind') || 'customers').toLowerCase();
      if (kind !== 'customers') {
        send(res, 400, { ok: false, error: `Nothing can be exported as "${kind}".`, code: 'unknown-kind' }, cors);
        return;
      }
      /* Scoped like every other read, even though only an administrator gets
         this far: if that ever changes, the file must narrow with the role. */
      const state = who.disk ? scopeState(who.disk, visibleAccountIds(who.disk, who.user)) : null;
      if (!state || !Array.isArray(state.customers)) {
        send(res, 200, '\uFEFF\r\n', cors, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="waypoint-customers-empty.csv"',
        });
        return;
      }
      const out = customerCsv(state, who.user);
      await recordExport({
        at: new Date().toISOString(),
        userId: who.user.id,
        who: who.user.name,
        role: who.user.role,
        kind,
        rows: out.rows,
      });
      log(`export: ${out.rows} customers by ${who.user.name}`);
      /* Not JSON: `send` is for the API, and this is a file. */
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${out.name}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...cors,
      });
      /* The BOM is what makes Excel read UTF-8 rather than mangling it. */
      res.end('\uFEFF' + out.csv);
      return;
    }

    /* ----------------------------------------------------------- write */
    if (pathname === '/api/data' && req.method === 'PUT') {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        send(res, 400, { ok: false, error: 'Body is not valid JSON.' }, cors);
        return;
      }
      /* Accept both shapes: the new `{ state, baseRev, deleted }` envelope and
         a bare state, so an older open copy of the app still saves. */
      const incoming = body && typeof body === 'object' && !Array.isArray(body) && 'state' in body
        ? body.state
        : body;
      const baseRev = Number(req.headers['x-base-rev'] ?? body?.baseRev);
      const baseSavedAt = String(req.headers['x-base-saved-at'] ?? body?.baseSavedAt ?? '');
      const deleted = body && typeof body === 'object' && body.deleted && typeof body.deleted === 'object'
        ? body.deleted
        : {};

      const problem = validate(incoming);
      if (problem) {
        send(res, 400, { ok: false, error: problem }, cors);
        return;
      }

      /* A read-only role has no business in a write. A viewer may look at the
         book; it may not save into it, however well-formed the request is. */
      if (who.user && !WRITE_ROLES.has(who.user.role)) {
        send(res, 403, {
          ok: false,
          error: `${who.user.name}'s role is read-only.`,
          code: 'forbidden',
        }, cors);
        return;
      }

      /* Everything from here to the write is ONE critical section.
         `identify` already read the file to work out who is calling; that read
         is now stale by however long the body took to arrive. Deciding the
         revision from it is how two simultaneous saves both conclude they are
         the only writer — so the file and the revision are re-read INSIDE the
         lock, immediately before the decision is made. */
      const committed = await serialize(async () => {
        const disk = await readState();
        const hasCredentials = !!disk && !!disk.credentials && Object.keys(disk.credentials).length > 0;
        /* Recomputed from the fresh read, not from `who`: between identify and
           here another request may have created the first administrator. */
        const setup = !hasCredentials;
        const isAdmin = setup || who.open || (who.user && isAdminRole(who.user.role));
        const curRev = await readRev();

        /* The payload is not trustworthy: it is whatever the client chose to
           send, and for most of this product's life that was enough to rewrite
           any customer in the file. Every row this session may not change is put
           back to its disk version, and every delete it may not perform is
           dropped, before any merge or write happens. */
        const auth = disk
          ? authorizeIncoming(disk, incoming, deleted, who.user)
          : { state: incoming, deleted, ids: null, reverted: 0, refused: 0, lost: [] };
        const payload = auth.state;
        const allowedDeleted = auth.deleted;

        let next;
        let mode;
        let conflicts = [];
        if (!disk) {
          next = payload;
          mode = 'create';
        } else if (Number.isFinite(baseRev) && baseRev > 0 && baseRev === curRev) {
          // Nobody else has written since this client read: it genuinely is the
          // whole truth, so take it as-is - which is the only way a delete can
          // ever take effect without a history of every revision.
          next = payload;
          mode = 'replace';
          /* Except the deletes: they are named in their own envelope, and the
             merge path is the only place that ever read it. On a replace it was
             dropped on the floor, so a caller that names what it is removing
             got a 200 and the row back. Same rule on both paths. */
          for (const [key, ids] of Object.entries(allowedDeleted ?? {})) {
            if (!Array.isArray(ids) || !ids.length) continue;
            const gone = new Set(ids);
            if (Array.isArray(next[key])) {
              next[key] = next[key].filter((r) => !gone.has(idOf(r)));
            } else if (next[key] && typeof next[key] === 'object') {
              const map = { ...next[key] };
              for (const id of gone) delete map[id];
              next[key] = map;
            }
          }
        } else {
          const merged = mergeState(disk, payload, allowedDeleted, baseSavedAt);
          next = merged.state;
          conflicts = merged.conflicts;
          mode = 'merge';
        }

        /* The roster and the password hashes are the server's, not the payload's.
           Applied on EVERY path: a wholesale replace would otherwise let a
           colleague's copy - which only ever holds the inert marker - wipe every
           real hash on disk. */
        if (!isAdmin && disk) {
          for (const key of ADMIN_ONLY_KEYS) {
            if (disk[key] !== undefined) next[key] = disk[key];
          }
        }
        /* The hashes are the server's on EVERY path, the administrator's
           included - not just the non-administrator's above.
           The GET now strips them for everybody, so an administrator's client
           only ever holds the inert marker. Writing that back would silently
           wipe every password in the workspace on their next save, and every
           colleague would be locked out by a save that reported success. */
        if (disk && disk.credentials !== undefined) next.credentials = disk.credentials;
      /* `users` is the roster the server signs people in with. A client that
         does not manage it — Waypoint keeps its own `team` and never sends
         one — produces a payload with no `users` key, and on a REPLACE an
         absent key means "delete it". One save and everybody is locked out by
         a save that reported success. Keep the disk roster whenever the
         payload is silent about it; an administrator who genuinely wants to
         change the roster sends it, and everybody else is reverted above. */
      if (disk && disk.users !== undefined && !Array.isArray(payload.users)) {
        next.users = disk.users;
      }
        /* Whether this book is the seeded sample is the server's to say, and
           only the server's. Two ways to get it wrong, both silent:
           a whole-state save takes the payload as the truth, so the mark
           would be dropped and the "SAMPLE DATA" badge that stops somebody
           quoting these figures in a real meeting would go with it — in the
           middle of the demo it exists for; and a client that asserted
           `demo` of its own could label a real book as a sample, or strip
           the label off a sample one. The disk answers, on every path, in
           both directions. */
        if (disk) {
          if (disk.demo !== undefined) next.demo = disk.demo;
          else delete next.demo;
        } else {
          delete next.demo;
        }
        /* The product catalogue is shared reference data, and `perm.ts` gates
           editing it to the administrator alone — a manager's copy of it is
           reverted too. (`ADMIN_ONLY_KEYS` above is the broader guard: it keeps
           the roster and the hashes away from everyone who is neither.) */
        if (disk && !(setup || who.open) && who.user?.role !== 'admin') {
          if (disk.products !== undefined) next.products = disk.products;
        }

        /* The interaction↔customer relationship is checked on the state that
           is about to be written, not on what the client claimed: merges and
           reverts have had their say by now. A refusal here means the file was
           never touched. The code string keeps its old spelling so a client
           that has not been updated still recognises the refusal. */
        const integrity = meetingIntegrity(next);
        if (integrity) return { error: integrity, code: 'orphan-meeting' };

        /* The same relationship for opportunities: a row that names no
         * customer, or one the book does not hold, never reaches the file —
         * whichever role tried to write it. §26's import made this the rule
         * worth having, and it would be a thin rule if it only held for rows
         * that arrived one at a time through a form.
         */
        const oppRule = oppIntegrity(next);
        if (oppRule) return { error: oppRule, code: 'orphan-opportunity' };

        /* §5's other half, on the field where it is a real decision: an SA may
           read the money and may not write it.
         *
         * Checked BEFORE `stepIntegrity`, and the order is the point. Both rules
         * can refuse the same request — an SA moving the Owner usually also
         * strands a step — and whichever runs first is the answer the caller
         * hears. Run the tracker rule first and the reply is about a Next Step:
         * true, useful, and NOT the rule that was actually broken. The person
         * reads it, re-points the step, sends again, and is refused a second
         * time — by this rule, which could have told them at the start. A
         * refusal must name the rule the caller has to satisfy, and the one
         * that decides whether the act is theirs at all comes first. */
        const moneyRule = saCommercialGuard(disk, next, who.user);
        if (moneyRule) return { error: moneyRule, code: 'sa-cannot-change-money' };

        /* §5: every open Next Step must be tracked by its customer's Primary
           BD or Primary SA. Same place, same rule — the file is not touched
           when this fails. */
        const stepRule = stepIntegrity(next);
        if (stepRule) return { error: stepRule, code: 'tracker-not-on-account' };

        /* The roster is the server's table and one person is one row in it —
           see dedupeTeam. Applied on EVERY path: a payload of duplicates, or
           a merge of the id'd and the nameless spellings of one person, must
           not grow the roster on any save. */
        next.team = dedupeTeam(next.team);

        /* Derived on the way to the file as well as on the way out, so a
           workspace opened by any other tool shows what the board shows. */
        next = deriveOppAges(next);
        const bytes = await writeState(next);
        const info = await statFile();
        const rev = curRev + 1;
        await writeRev(rev, info.savedAt, bytes);
        /* A document whose row is gone must not stay on disk: it is still
           somebody's data, and it is now outside every rule that guards it. */
        try { await sweepOrphanBlobs(next); } catch (e) { log('file sweep failed:', e.message); }
        /* Rows this session was not allowed to change were replaced by the disk
           version above, so the merge never saw them and would have reported no
           collision. They are still work somebody typed, so they go to the same
           recovery file - with a reason that says why, because "stale-edit" and
           "you may not edit this customer" need different conversations. */
        for (const l of auth.lost ?? []) {
          conflicts.push({ collection: l.collection, id: l.id, reason: 'out-of-scope', discarded: l.row });
        }
        return { next, mode, conflicts, bytes, rev, savedAt: info.savedAt, reverted: auth.reverted, refused: auth.refused };
      });

      const { next, mode, conflicts, bytes, savedAt, reverted, refused } = committed;
      if (committed.error) {
        /* The code says WHICH relationship was refused. It used to be the
           constant 'orphan-meeting', which meant a client could not tell a
           meeting problem from a tracker problem — and the client needs to,
           because they are fixed in completely different places. */
        send(res, 400, { ok: false, error: committed.error, code: committed.code || 'integrity' }, cors);
        return;
      }
      const rev = committed.rev;
      if (conflicts.length) await appendConflicts(conflicts, who.user?.id ?? null);

      const guard = [
        reverted ? `${reverted} row(s) reverted` : '',
        refused ? `${refused} delete(s) refused` : '',
      ].filter(Boolean).join(', ');
      log(`saved ${(bytes / 1024).toFixed(1)} KB (${mode}${conflicts.length ? `, ${conflicts.length} conflict(s)` : ''}) rev ${rev}`
        + `${who.user ? ` by ${who.user.name}` : ''}${guard ? ` — ${guard}` : ''}`);
      send(res, 200, {
        ok: true,
        savedAt,
        bytes,
        rev,
        mode,
        conflicts: conflicts.length,
        // What the authorization layer took back out. Non-zero is a signal that
        // somebody tried to write outside their scope, so it is worth showing.
        reverted,
        refused,
        file: DATA_FILE,
        /* Hand back the truth whenever the caller's copy is no longer it.
           That was only the merge; it is also true after a revert, when the
           client is still showing an edit the server refused — it would keep
           showing it until the next poll, and a user who sees their words on
           screen believes they were saved. */
        state: (mode === 'merge' || reverted > 0)
          ? stripSecrets(scopeState(next, visibleAccountIds(next, who.user)))
          : undefined,
      }, cors);
      return;
    }

    /* ----------------------------------------------------------- reset */
    if (pathname === '/api/reset' && req.method === 'POST') {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      /* `who.user && ...` skipped the check entirely for a caller with no
         account — which is exactly who an anonymous stranger is, and this
         route deletes the whole file. It is administrator-only: the only
         callers still allowed in without one are the same two windows as
         above (an empty book, or `WB_OPEN`), neither of which has anything
         in it to lose. */
      if (!who.open && (!who.user || !isAdminRole(who.user.role))) {
        send(res, 403, { ok: false, error: 'Only an administrator can clear the workspace.' }, cors);
        return;
      }
      /* Serialised for the same reason a save is: a reset that lands while a
         save is mid-flight would be undone by it, and the administrator would
         be told the workspace was cleared when it was not. */
      const deleted = await serialize(() => deleteData());
      /* Every session dies with the workspace it was opened against.
         A reset is the moment the machine changes hands — the operator clears
         the book to hand it to a new team, or to start again — and sessions
         used to outlive it: the file was gone, the accounts in it were gone,
         and a colleague's cookie was still answered 200. That is not a data
         leak by itself (the book really is empty), but it is the wrong answer
         to "who is signed in": a session is a claim about a user, and after a
         reset there are no users to make that claim about.
         The operator's own session is the single exception, and it is kept for
         a reason that is about the door rather than about them: somebody has
         to be able to create the first administrator again, and the only
         honest way to say WHO that somebody is, is to remember it here. See
         `founders`. */
      const mine = who.session?.token ?? null;
      const killed = killSessions();
      if (mine) {
        /* Re-inserted under the same token the caller is already holding, so
           their browser needs to do nothing — no new cookie, no second sign-in
           for a workspace that no longer has anything to sign in WITH. */
        sessions.set(mine, {
          userId: null, createdAt: Date.now(), lastSeen: Date.now(),
          ip: '', agent: 'founder: workspace reset',
        });
        founders.add(mine);
      }
      log(`reset: data file removed, ${killed} other session(s) ended`);
      send(res, 200, { ok: true, deleted, founder: !!mine }, cors);
      return;
    }

    /* ----------------------------------------------- clear temp/cache */
    if (pathname === '/api/cleanup' && req.method === 'POST') {
      const who = await identify(req, res, cors, secure);
      if (!who) return;
      /* Same as the reset above: a caller with no account is not an
         administrator, and this route deletes files off disk. */
      if (!who.open && (!who.user || !isAdminRole(who.user.role))) {
        send(res, 403, { ok: false, error: 'Only an administrator can clear temp files.' }, cors);
        return;
      }
      const removed = await clearTemp();
      log(`cleanup: removed ${removed} temp file(s)`);
      send(res, 200, { ok: true, removed }, cors);
      return;
    }

    /* --------------------------------------------------------- static */
    if (pathname.startsWith('/api/')) {
      send(res, 404, { ok: false, error: `No such endpoint: ${pathname}` }, cors);
      return;
    }
    await serveStatic(req, res, pathname, cors);
  } catch (e) {
    log('error:', e.message);
    if (res.headersSent) { res.end(); return; }
    if (e instanceof PayloadTooLarge) send(res, 413, { ok: false, error: e.message }, cors);
    else send(res, 500, { ok: false, error: e.message }, cors);
  }
};

/* -------------------------------------------------------------- start-up */

/** Addresses a colleague could plausibly type into their browser. */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      out.push(ni.address);
    }
  }
  return out;
}

async function tlsOptions() {
  if (process.env.WB_TLS === '0') return null;
  try {
    const [key, cert] = await Promise.all([fsp.readFile(KEY_FILE), fsp.readFile(CERT_FILE)]);
    return { key, cert };
  } catch {
    return null;
  }
}

/** 127.0.0.1, ::1, localhost — the machine the server runs on. */
function isLoopback(ip) {
  return !ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

/**
 * One port, both protocols.
 *
 * TLS and plain HTTP cannot normally share a port — the first byte of a TLS
 * handshake (0x16) is not a valid HTTP method — so the listener peeks at that
 * one byte and hands the socket to the right server.
 *
 * Why bother: the office team reaches the app over https, but the
 * double-clicked copy of the app runs from file://, and a file:// page cannot
 * call a self-signed https address it has never visited. Turning TLS on
 * therefore used to kill every save from that copy, silently — the top bar just
 * said "Data server offline". Both now land on the same port, no configuration.
 */
function createPolyglotServer(tls) {
  const httpsServer = tls ? https.createServer(tls, (q, s) => handler(q, s, true)) : null;

  const httpServer = http.createServer((q, s) => {
    /* On the office network, never let a password cross the wire in the clear:
       a colleague who types `http://<lan-ip>:8787` is sent to the https side.
       308 keeps the method and the body, so a PUT still arrives as a PUT.
       This machine itself (loopback) keeps plain http on purpose — that is
       what the file:// copy needs. */
    if (httpsServer && !isLoopback(q.socket?.remoteAddress)) {
      const host = q.headers.host || `localhost:${PORT}`;
      s.writeHead(308, { Location: `https://${host}${q.url || '/'}`, ...securityHeaders(true) });
      s.end('This workspace is only served over https. Use https:// instead.');
      return;
    }
    handler(q, s, false);
  });

  const router = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.once('error', () => socket.destroy());
    socket.once('data', (chunk) => {
      socket.pause();
      socket.unshift(chunk);                       // give the byte back
      const target = httpsServer && chunk[0] === 0x16 ? httpsServer : httpServer;
      target.emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });

  return { router, httpServer, httpsServer };
}

/* ------------------------------------------------ copilot assembling (§4) ---
   The deep gate. The route checks scope and confidentiality when the ask is
   made (§4: BEFORE retrieving context) — but a task may sit queued while the
   book moves under it, and a task created through the plain /api/ai/tasks
   route never met the copilot's gate at all. So the executor re-reads the
   book and re-decides on its own: what the model may be fed is settled at
   run time, from the caller's scope, from the CURRENT book. A refusal here
   is honest and final (not retryable) — the ask was legal to make, and
   asking again cannot move a wall. */
async function assembleBrief(task) {
  const book = await readState();
  const user = (book.users || []).find((u) => u && u.id === task.userId) || null;
  if (!user) throw new RefusedError('The account that asked is no longer in the workspace.');
  const scoped = scopeState(book, visibleAccountIds(book, user)) || {};
  const customer = (scoped.customers || []).find((c) => c && c.id === task.targetId);
  if (!customer) throw new RefusedError('That customer is not in your scope.');
  if (customer.confidential) {
    /* The wall is the DATA, not the role: nobody — owner, manager, anyone —
       may hand a confidential record to a model. Opening the record is a
       different permission entirely and is untouched by this. */
    throw new RefusedError('This customer is confidential — their data is never sent to a model.');
  }
  /* Assembled as literals, never `x.customers = ...`: the copilot-scope
     scanner treats that shape as a write to the book, and it reads like
     one too. The material is exactly what the caller's own screen can
     show, drawn from their scoped view — nothing else exists here. */
  const id = customer.id;
  const material = {
    customer: {
      name: String(customer.name || ''), industry: String(customer.industry || ''),
      onboard: customer.onboard ? 'Onboarded' : 'Not onboarded', health: String(customer.health || ''),
      site: String(customer.site || ''),
      pains: (Array.isArray(customer.pains) ? customer.pains : []).map(String),
    },
    opportunities: Object.values(scoped.opps || {})
      .filter((o) => o && o.c === id)
      .map((o) => ({ name: String(o.t || o.name || ''), stage: String(o.stage || ''), value: o.v ?? null, close: String(o.close || '') })),
    interactions: (Array.isArray(scoped.interactions) ? scoped.interactions : [])
      .filter((m) => m && m.c === id)
      .map((m) => ({ title: String(m.t || ''), when: String(m.d || ''), attendees: String(m.att || ''), outcome: String(m.out || '') })),
    steps: (Array.isArray(scoped.steps) ? scoped.steps : [])
      .filter((s) => s && s.c === id)
      .map((s) => ({ task: String(s.t || ''), due: String(s.due || ''), owner: String(s.o || s.exec || ''), priority: String(s.p || '') })),
  };
  const lines = [
    'Write a short account brief for a salesperson walking into their next meeting with this customer.',
    'Lead with where the relationship stands and what to address; keep it under 200 words; invent nothing.',
    '',
    'Customer: ' + material.customer.name,
    'Industry: ' + material.customer.industry,
    'Onboarded: ' + material.customer.onboard,
    'Health: ' + material.customer.health,
  ];
  if (material.customer.pains.length) lines.push('Pain points: ' + material.customer.pains.join('; '));
  if (material.opportunities.length) {
    lines.push('', 'Opportunities:');
    for (const o of material.opportunities) {
      lines.push('- ' + o.name + (o.stage ? ' (' + o.stage + ')' : '') + (o.value ? ' — value ' + o.value : '') + (o.close ? ', closes ' + o.close : ''));
    }
  }
  if (material.interactions.length) {
    lines.push('', 'Recent meetings:');
    for (const m of material.interactions) {
      lines.push('- ' + (m.when || 'undated') + ' ' + m.title + (m.attendees ? ' with ' + m.attendees : '') + (m.outcome ? ' — ' + m.outcome : ''));
    }
  }
  if (material.steps.length) {
    lines.push('', 'Open steps:');
    for (const s of material.steps) {
      lines.push('- ' + s.task + (s.due ? ' due ' + s.due : '') + (s.owner ? ' (' + s.owner + ')' : '') + (s.priority ? ' [' + s.priority + ']' : ''));
    }
  }
  const out = await aiComplete(lines.join('\n'), { maxTokens: 1200 });
  return { text: out.text, model: out.model, askedAbout: material.customer.name };
}

/* #64/#65 — the executor an unmatched 'answer' becomes. It re-walks the deep
   gate the route already walked (the book moves; a queued ask must survive
   it), classifies with one fast structured call, then answers from the
   smallest context the classification justifies — #65's assemblers in
   copilot.mjs: a retrieval for global asks (the roster shape when nothing
   matches), the §19.4 briefings for a customer or an opportunity, never the
   database (§19.2). The answer carries citations with the record ids it was
   built on, so it can be traced, not just believed. Confidential records
   never reach the classifier's menu nor any assembler's facts; a
   confidential id hallucinated by the model simply is not on the menu, and
   the ask degrades to global. */
async function runAnswerTask(task) {
  const question = String(task.question || '');
  const book = await readState();
  const user = (book.users || []).find((u) => u && u.id === task.userId) || null;
  if (!user) throw new RefusedError('The account that asked is no longer in the workspace.');
  const scoped = deriveOppAges(renameCollections(scopeState(book, visibleAccountIds(book, user)) || {})) || {};
  const cls = await classifyAsk(question, scoped);
  if (!cls.ok) throw new Error('The model did not answer with a routing. Ask again.');

  /* #65: the smallest context the classification justifies, assembled from
     the caller's scoped view — global retrieves what the question names
     (roster when it names nothing), customer and opportunity build the §19.4
     briefings. Every branch answers from records, with citations carrying
     the ids the answer was built on. */
  let ctx;
  if (cls.kind === 'customer') {
    ctx = buildCustomerContext(scoped, cls.targetId);
    if (!ctx.ok) {
      /* The classifier's menu promised this id was offerable; the assembler
         re-checks the wall anyway (a promise from code beats a promise from
         a model). A miss degrades to global — never a 500, never a guess. */
      ctx = buildGlobalContext(scoped, question, cls.entities);
    }
  } else if (cls.kind === 'opportunity') {
    ctx = buildOppContext(scoped, cls.targetId);
    if (!ctx.ok) ctx = buildGlobalContext(scoped, question, cls.entities);
  } else {
    ctx = buildGlobalContext(scoped, question, cls.entities);
    /* #77 (§17/§18): management's global asks arrive with the pipeline
     * picture attached — an admin or manager asking "overview of our
     * pipeline" names no customer, so retrieval alone would answer with
     * nothing. The pipeline facts lead, the keyword hits follow; both are
     * the caller's own scoped view, and nothing here writes (the task is a
     * read; a manager has no write path at all — that is #60's wall, not
     * this prompt's). */
    if (user.role === 'admin' || user.role === 'manager') {
      const pipe = buildPipelineFacts(scoped);
      if (pipe.facts.length) {
        ctx = {
          ...ctx,
          facts: [...pipe.facts, '', ...ctx.facts],
          citations: [...pipe.citations, ...ctx.citations],
        };
      }
    }
  }

  const lines = [
    'Answer the question below for a salesperson, using ONLY the records given. '
    + 'Be specific and brief; cite what you lean on by name; if the records do not '
    + 'support a conclusion, say so rather than inventing one.',
    '',
  ];
  if (ctx.facts.length) {
    lines.push('The caller\u2019s records:');
    for (const f of ctx.facts) lines.push('- ' + f);
  } else {
    lines.push('The caller\u2019s records: none — say so plainly.');
  }
  if (ctx.note) lines.push('', ctx.note);
  lines.push('', `Question: "${question}"`);
  const out = await aiComplete(lines.join('\n'), { maxTokens: 2000 });
  return { classified: cls, answer: out.text, model: out.model, citations: ctx.citations };
}

/* #66 — the reusable business summary. §20 names two shapes — a Customer
   Business Summary (seven fields) and an Opportunity Summary (six) — and
   one rule: "Do not regenerate them unnecessarily." The context comes from
   #65's assemblers (the §19.4 limits ride along for free); the answer is
   stored as a completed task's result with the revision it was generated
   at, and the route reuses it for as long as the book wears that revision.
   Every gate is here, in the executor: a summary the caller cannot see is
   refused the same way whatever shape its id names. */
async function runSummaryTask(task) {
  const book = await readState();
  const user = (book.users || []).find((u) => u && u.id === task.userId) || null;
  if (!user) throw new RefusedError('The account that asked is no longer in the workspace.');
  const scoped = deriveOppAges(renameCollections(scopeState(book, visibleAccountIds(book, user)) || {})) || {};

  /* Which shape does the id name? An opportunity first (its map is keyed),
     then a customer. Anything else is not the caller's to summarise. */
  const opps = scoped.opps && typeof scoped.opps === 'object' && !Array.isArray(scoped.opps) ? scoped.opps : {};
  const opp = opps[String(task.targetId)] || null;
  const customer = opp ? null
    : (Array.isArray(scoped.customers) ? scoped.customers : [])
      .find((c) => c && String(c.id) === String(task.targetId)) || null;
  if (!opp && !customer) throw new RefusedError('That record is not in your scope.');
  const custOf = (cid) => (Array.isArray(scoped.customers) ? scoped.customers : [])
    .find((c) => c && String(c.id) === String(cid)) || null;
  const owner = opp ? custOf(opp.c) : customer;
  if (!owner) throw new RefusedError('That record is not in your scope.');
  if (owner.confidential) {
    throw new RefusedError('This customer is confidential — their data is never sent to a model.');
  }

  const shape = opp ? 'opportunity' : 'customer';
  const ctx = opp ? buildOppContext(scoped, task.targetId) : buildCustomerContext(scoped, task.targetId);
  if (!ctx.ok) throw new RefusedError('That record is not in your scope.');

  const HEADINGS = shape === 'opportunity'
    ? ['Current Situation', 'Customer Need', 'Existing Environment', 'Latest Development', 'Open Risks', 'Next Action']
    : ['Current Situation', 'Key Pain Points', 'Active Opportunities', 'Important People', 'Recent Changes', 'Open Risks', 'Important Decisions'];
  const lines = [
    `Write a business summary of this ${shape} for a salesperson, using ONLY the records given.`,
    'Answer with exactly these headings, one short line each: ' + HEADINGS.join('; ') + '.',
    'Where the records do not support a heading, say "not recorded" — invent nothing.',
    '',
    'The records:',
  ];
  for (const f of ctx.facts) lines.push('- ' + f);
  if (ctx.note) lines.push('', ctx.note);

  const out = await aiComplete(lines.join('\n'), { maxTokens: 1500 });
  /* The generation-time revision — the route compares it against the
     book's current one before ever paying for this again. */
  const rev = await readRev();
  return { summary: out.text, headings: HEADINGS, model: out.model, citations: ctx.citations, contextRev: rev };
}

/* #68 — My Work Copilot: "What should I focus on this week?" (§5). The
   items come from buildFocusWeekItems — computed, not guessed — and this
   executor adds the only thing a model is good for here: one short
   suggested-action line per item. Reconciliation afterwards keeps the model
   in its lane: an action survives only when its item number exists, so a
   model may propose follow-ups but cannot add rows or invent customers
   (§27). A model that does not answer in JSON leaves the facts standing —
   the list is still true, only unadorned. */
async function runFocusWeekTask(task) {
  const book = await readState();
  const user = (book.users || []).find((u) => u && u.id === task.userId) || null;
  if (!user) throw new RefusedError('The account that asked is no longer in the workspace.');
  const scoped = deriveOppAges(renameCollections(scopeState(book, visibleAccountIds(book, user)) || {})) || {};

  const built = buildFocusWeekItems(scoped);
  if (!built.ok) throw new RefusedError('Your book could not be read for this ask.');

  /* A clean book is an honest empty list, not a fabricated paragraph. */
  if (!built.items.length) {
    const rev = await readRev();
    return { items: [], model: null, citations: [], contextRev: rev };
  }

  const lines = [
    'A salesperson asks: "What should I focus on this week?"',
    'The items below were computed from their records. For EACH numbered item, write one short suggested action — one line, based ONLY on the records given. Do not invent customers, opportunities, dates or amounts.',
    'Answer with one JSON object only, with an entry for every item: {"items":[{"n":1,"action":"..."},{"n":2,"action":"..."}]}',
    '',
    'Items:',
    ...built.items.map((it, i) => `${i + 1}. ${it.customer} — ${it.note}`),
  ];
  const out = await aiComplete(lines.join('\n'), { maxTokens: 900 });
  const acts = new Map();
  const m = String(out.text).match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      for (const x of (Array.isArray(j.items) ? j.items : [])) {
        const n = Number(x && x.n);
        if (Number.isInteger(n) && n >= 1 && n <= built.items.length) {
          const a = String(x.action || '').replace(/\s+/g, ' ').trim().slice(0, 200);
          if (a) acts.set(n, a);
        }
      }
    } catch { /* the facts stand without the suggestions */ }
  }
  const items = built.items.map((it, i) => ({ ...it, suggested: acts.get(i + 1) || '' }));
  const rev = await readRev();
  return { items, model: out.model, citations: built.citations, contextRev: rev };
}

/* #69 — the customer brief (§6, Test 2). The facts are the caller's own
   ten sections, computed by buildCustomerFacts; the model is asked for the
   only thing a model is good for here — organising those facts and naming
   what needs attention. The two answers come back as one JSON object, and
   the reconciliation is deliberately forgiving: a model that ignores the
   JSON still has its words kept as the brief (never dropped, never
   fabricated around), and the facts stand whatever it says. Facts and the
   reading are separate fields, so the front end shows them as separate
   things (§11) — a fact is a door into the book, a suggestion is a
   suggestion. */
async function runCustomerBriefTask(task) {
  const book = await readState();
  const user = (book.users || []).find((u) => u && u.id === task.userId) || null;
  if (!user) throw new RefusedError('The account that asked is no longer in the workspace.');
  const scoped = deriveOppAges(renameCollections(scopeState(book, visibleAccountIds(book, user)) || {})) || {};

  /* The deep gate — the executor re-checks the walls on its own reading of
     the book, the same shape and the same words as the summary's. */
  const built = buildCustomerFacts(scoped, task.targetId);
  if (!built.ok) {
    if (built.code === 'confidential') {
      throw new RefusedError('This customer is confidential — their data is never sent to a model.');
    }
    throw new RefusedError('That record is not in your scope.');
  }

  const lines = [
    `A salesperson on this customer's page asks: "${String(task.question || 'Give me a quick briefing and tell me what needs attention.').slice(0, 300)}"`,
    'The FACTS below were computed from the workspace records — every line of them is true.',
    'Write two short sections for this salesperson:',
    '- "brief": a few lines that organise these facts. Use ONLY the facts given.',
    '- "attention": what needs attention — only risks, overdue items, gaps or questions the facts above support. Every point names the fact that drives it (§11: an attention item explains itself, and is never a bare score).',
    'Where the records do not support something, say "not recorded" — invent nothing, add no outside knowledge.',
    'Answer with one JSON object only: {"brief":"...","attention":"..."}',
    '',
    'The facts:',
  ];
  for (const sec of built.sections) {
    lines.push('[' + sec.title + ']');
    for (const l of sec.lines) {
      lines.push('- ' + (l.ref ? l.ref.label + ' — ' : '') + l.text);
    }
  }

  const out = await aiComplete(lines.join('\n'), { maxTokens: 1200 });
  let brief = String(out.text || '').trim().slice(0, 1500);
  let attention = '';
  const m = String(out.text).match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      const b = String(j.brief || '').trim();
      if (b) brief = b.slice(0, 1500);
      attention = String(j.attention || '').trim().slice(0, 800);
    } catch { /* the model's own words stand as the brief */ }
  }
  const rev = await readRev();
  return {
    customerId: built.customerId, facts: built.sections, brief, attention,
    model: out.model, citations: built.citations, contextRev: rev,
  };
}

/* #70 — the opportunity analysis (§7, Test 3). The facts are §7's own
   sections — situation, need, context, risks, the deterministic missing
   information (§15), meetings, steps, people — computed by buildOppFacts
   from the caller's scoped view. The model is asked for the only thing a
   model is good for here: up to five next moves (each with the WHY that
   §11 demands — which fact drives it), its own reading of gaps, and what
   to prepare. The output contract is the insight panel's (moves/gaps/
   prepare) so the front end renders both with one shape; the
   reconciliation is the same forgiving one — a model that ignores the
   JSON leaves the facts standing and its words are never fabricated
   around. maxTokens 6000: measured — smaller budgets come back empty
   after the model spends them thinking. */
async function runAnalyzeOppTask(task) {
  const book = await readState();
  const user = (book.users || []).find((u) => u && u.id === task.userId) || null;
  if (!user) throw new RefusedError('The account that asked is no longer in the workspace.');
  const scoped = deriveOppAges(renameCollections(scopeState(book, visibleAccountIds(book, user)) || {})) || {};

  /* The deep gate — an opportunity outside the caller's scope, or one on a
     confidential account, is refused on the executor's own reading. */
  const built = buildOppFacts(scoped, task.targetId);
  if (!built.ok) {
    if (built.code === 'confidential') {
      throw new RefusedError('This customer is confidential — their data is never sent to a model.');
    }
    throw new RefusedError('That record is not in your scope.');
  }

  const lines = [
    `A salesperson on this opportunity asks: "${String(task.question || 'What are the current risks and what should I do next?').slice(0, 300)}"`,
    'The FACTS below were computed from the workspace records — every line of them is true.',
    'You are coaching the account team. Reply with:',
    '- risks: up to 4 attention items, each one of §11\'s eight kinds — a stalled opportunity, an unresolved',
    '  blocker, a missing owner, a missing next step, a requirement that changed, an important customer',
    '  concern, lack of recent engagement, or inconsistent / incomplete records. Each: what (one line),',
    '  why (one line: which fact above identified it — an item with no why is dropped, and no scores: an',
    '  attention item explains itself, it is never rated), kind (one of opportunity, follow-up, task, meeting,',
    '  proposal, sa, product, validate, prepare). Only what the facts above support.',
    '- moves: up to 5 specific next moves. Each: what (one line, starts with a verb, specific to these facts),',
    '  why (one line: which fact drives it — §11: an attention item explains itself), kind (one of',
    '  opportunity, follow-up, task, meeting, proposal, sa, product, validate, prepare).',
    '- gaps: up to 4 things the records do NOT cover, or information still missing.',
    '- prepare: up to 3 things to prepare before the next meeting.',
    'Be concrete. Use ONLY the facts given — invent no customer, amount, date or product.',
    'If the facts support no move, say so in gaps rather than inventing one.',
    'Answer with one JSON object only: {"risks":[{"what":"...","why":"...","kind":"follow-up"}],',
    ' "moves":[{"what":"...","why":"...","kind":"follow-up"}],"gaps":["..."],"prepare":["..."]}',
    '',
    'The facts:',
  ];
  for (const sec of built.sections) {
    lines.push('[' + sec.title + ']');
    for (const l of sec.lines) {
      lines.push('- ' + (l.ref ? l.ref.label + ' — ' : '') + l.text);
    }
  }

  const out = await aiComplete(lines.join('\n'), { maxTokens: 6000 });
  const KINDS = ['opportunity', 'follow-up', 'task', 'meeting', 'proposal', 'sa', 'product', 'validate', 'prepare'];
  const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  /* §11's rule, made structural: a risk without a why is dropped here, not
     merely discouraged — so every risk that reaches the screen explains
     itself. The whitelist of fields (what/why/kind) is the "no unexplained
     scores" rule: a score the model invented has no field to travel in. */
  const keepItem = (x) => x && typeof x === 'object'
    ? { what: tidy(x.what).slice(0, 240), why: tidy(x.why).slice(0, 240),
        kind: KINDS.includes(x.kind) ? x.kind : 'follow-up' }
    : null;
  let risks = [];
  let moves = [];
  let gaps = [];
  let prepare = [];
  const m = String(out.text).match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      risks = (Array.isArray(j.risks) ? j.risks : [])
        .map(keepItem).filter(Boolean)
        .filter((x) => x.what.length > 3 && x.why.length > 3).slice(0, 4);
      moves = (Array.isArray(j.moves) ? j.moves : [])
        .map(keepItem).filter(Boolean)
        .filter((x) => x.what.length > 3).slice(0, 5);
      gaps = (Array.isArray(j.gaps) ? j.gaps : []).map(tidy).filter(Boolean).slice(0, 4);
      prepare = (Array.isArray(j.prepare) ? j.prepare : []).map(tidy).filter(Boolean).slice(0, 3);
    } catch { /* the facts stand without the coaching */ }
  }
  const rev = await readRev();
  return {
    customerId: built.customerId, oppId: built.oppId, facts: built.sections,
    risks, moves, gaps, prepare, model: out.model, citations: built.citations, contextRev: rev,
  };
}

/* #74 — controlled product recommendations (§13, §27, Test 6). The
   catalogue IS the boundary: every product the model may name is in the
   Product Reference, with its one-line purpose and, where the team has
   recorded one, its Product SA. A name the Reference does not hold is
   dropped, not displayed; a SA the product's own row does not record is
   dropped too. What survives is rewritten in the Reference's own wording
   (name, SA) — the model's paraphrase of a catalogue entry is never what
   renders. Nothing is attached to the opportunity and no SA is contacted:
   a recommendation is a thing a person reads, not a change the model
   makes. The ask arrives from an opportunity's card or from a meeting's
   reading, so the target is an opportunity first and a customer second —
   both assemblers walk the deep gate (scope, and the confidential wall)
   on the executor's own reading. */
async function runProductTask(task) {
  const book = await readState();
  const user = (book.users || []).find((u) => u && u.id === task.userId) || null;
  if (!user) throw new RefusedError('The account that asked is no longer in the workspace.');
  const scoped = deriveOppAges(renameCollections(scopeState(book, visibleAccountIds(book, user)) || {})) || {};

  const opps = scoped.opps && typeof scoped.opps === 'object' && !Array.isArray(scoped.opps) ? scoped.opps : {};
  const opp = opps[String(task.targetId)] || null;
  const built = opp ? buildOppFacts(scoped, task.targetId) : buildCustomerFacts(scoped, task.targetId);
  if (!built.ok) {
    if (built.code === 'confidential') {
      throw new RefusedError('This customer is confidential — their data is never sent to a model.');
    }
    throw new RefusedError('That record is not in your scope.');
  }

  /* The controlled source, in full: every line the model may pick from.
     Products with no recorded SA say so to the model — an empty SA row
     must not be talked into one. */
  const products = (Array.isArray(scoped.products) ? scoped.products : [])
    .filter((p) => p && p.n);
  const lines = [
    `A salesperson asks: "${String(task.question || 'Which products from the Reference fit this account?').slice(0, 300)}"`,
    'The FACTS below were computed from the workspace records — every line of them is true.',
    'Suggest relevant products from the Product Reference below, and ONLY from it:',
    '- up to 5 products, each: p (the name, exactly as the Reference spells it),',
    '  why (one line: what makes it relevant to these facts), support (one line: which fact',
    '  or which part of the ask it leans on), sa (that product\'s Product SA, only if the',
    '  Reference lists one for it — a product with no SA listed must not be given one).',
    'A product the facts do not support is not suggested. Nothing is attached to anything',
    'and nobody is contacted — this is a recommendation a person reads.',
    'Answer with one JSON object only: {"products":[{"p":"...","why":"...","support":"...","sa":"..."}]}',
    '',
    'The facts:',
  ];
  for (const sec of built.sections) {
    lines.push('[' + sec.title + ']');
    for (const l of sec.lines) {
      lines.push('- ' + (l.ref ? l.ref.label + ' — ' : '') + l.text);
    }
  }
  lines.push('', 'The Product Reference — the only products you may name:');
  for (const p of products) {
    lines.push('- ' + p.n + (p.cat ? ' (' + p.cat + ')' : '') + ' — ' + (p.one || '')
      + ((p.by || []).length ? ' · Product SA: ' + (p.by || []).join(', ') : ''));
  }

  const out = await aiComplete(lines.join('\n'), { maxTokens: 2000 });
  const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const byLower = new Map(products.map((p) => [String(p.n).trim().toLowerCase(), p]));
  let kept = [];
  const m = String(out.text).match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      kept = (Array.isArray(j.products) ? j.products : [])
        .map((x) => x && typeof x === 'object' ? x : null).filter(Boolean)
        .map((x) => {
          const ref = byLower.get(tidy(x.p).toLowerCase());
          if (!ref) return null;   /* not in the Reference — dropped, not displayed */
          const sa = (ref.by || []).find((s) => tidy(s).toLowerCase() === tidy(x.sa).toLowerCase()) || '';
          /* The Reference's own spelling is what renders, never the model's. */
          return { p: ref.n, why: tidy(x.why).slice(0, 240), support: tidy(x.support).slice(0, 240), sa };
        })
        .filter(Boolean)
        .filter((x) => x.why.length > 3)   /* §13: a recommendation explains itself */
        .slice(0, 5);
    } catch { /* the Reference stands without the suggestions */ }
  }
  const rev = await readRev();
  return { products: kept, model: out.model, citations: built.citations, contextRev: rev };
}

async function main() {
  if (process.env.WB_REQUIRE_ENCRYPTION === '1' && !dataKey()) {
    console.error(
      '\nWB_REQUIRE_ENCRYPTION=1 but WB_DATA_KEY is not set.\n' +
      'Create one with:  openssl rand -base64 32\n' +
      'Keep it in Secrets Manager (or your password manager), NOT in the repo.\n',
    );
    process.exit(1);
  }
  await ensureDirs();
  /* The assembling action must be registered before any queued task is
     picked back up: a brief that survived a restart would otherwise run
     straight into "Unknown action" — picked up honestly, refused wrongly. */
  registerExecutor('brief', assembleBrief);
  /* Same discipline for the classified answer (#64): the executor an
     unmatched ask becomes must exist before recovery hands queued rows back
     to it. */
  registerExecutor('answer', runAnswerTask);
  registerExecutor('summary', runSummaryTask);
  /* #68 — the My Work list: computed items plus one model-written action
     line each, behind the task table like every other slow ask. */
  registerExecutor('focus-week', runFocusWeekTask);
  /* #69 — the customer brief: ten sections of the caller's own facts,
     plus the model's organising of them, behind the same task table. */
  registerExecutor('brief-customer', runCustomerBriefTask);
  /* #70 — the opportunity analysis: §7's fact sections plus the model's
     coaching on them, behind the same task table (a slow ask by nature —
     the reasoning model spends its budget thinking). */
  registerExecutor('analyze-opp', runAnalyzeOppTask);
  /* #74 — the controlled product recommendation: the Reference is the
     whole menu, and the executor reconciles every reply against it. */
  registerExecutor('suggest-products', runProductTask);
  /* A copilot task left 'processing' by a previous run of this server is not
     running — it died with that process. Say so honestly and let it be
     retried (§23); queued tasks are picked straight back up, because the
     user already asked and a restart is not a reason to drop the ask. */
  const revived = await recoverStuckTasks();
  if (revived) log(`${revived} copilot task(s) were running when the server stopped — marked failed, retryable`);
  const waiting = await queuedTasks();
  if (waiting.length) {
    log(`${waiting.length} copilot task(s) were still queued — resuming`);
    for (const t of waiting) runTask(t.id);   /* fire-and-forget; failures land in the table */
  }
  const info = await statFile();
  const tls = await tlsOptions();
  const secure = !!tls;
  const { router: server, httpServer, httpsServer } = createPolyglotServer(tls);

  server.listen(PORT, HOST, () => {
    const scheme = secure ? 'https' : 'http';
    log(`listening on ${scheme}://${HOST}:${PORT}`);
    if (secure) log(`plain http also accepted from this machine on the same port (file:// copy)`);
    log(`data file: ${DATA_FILE}`);
    if (info.exists) {
      log(`existing data: ${(info.bytes / 1024).toFixed(1)} KB, last saved ${info.savedAt}`);
    } else {
      log('no data file yet — the app will create one on first save');
    }
    if (HOST === '0.0.0.0' || HOST === '::') {
      const addrs = lanAddresses();
      if (addrs.length) {
        log('reachable from the office network at:');
        for (const a of addrs) log(`   ${scheme}://${a}:${PORT}`);
      } else {
        log('no LAN address found - are you on the office network?');
      }
    }
    log(OPEN_MODE
      ? 'open mode: no sign-in required (single user on this machine)'
      : 'sign-in required: only accounts with a password can read or write');
    log(secure ? 'https on (certs/key.pem + certs/cert.pem)' : 'http (no certificate found - run "npm run cert" for https)');
    log(dataKey()
      ? 'encryption at rest: ON (WB_DATA_KEY) - the data file cannot be read without it'
      : 'encryption at rest: OFF - set WB_DATA_KEY before real customer data goes in here');
    log('Ctrl+C to stop');
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\nPort ${PORT} is already in use. Is another copy running?`);
      console.error(`Start on a different port with: PORT=8788 npm run server\n`);
      process.exit(1);
    }
    throw e;
  });

  const shutdown = () => {
    httpServer.close();
    httpsServer?.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
