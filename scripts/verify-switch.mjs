/* verify:switch — an identity change leaves nothing of the last one behind.
 *
 * WHY THIS EXISTS
 * ---------------
 * The app is a single page that outlives its users. Sign out, hand the
 * machine to a guest, sign in as somebody else — the DOM, the module-level
 * maps and the remembered-device storage all remember what the LAST person
 * did unless the code sweeps them. A screenshot showed exactly that: an
 * answer the administrator generated on Today, still standing on the guest
 * screen, quoting the administrator's book. The server was innocent — its
 * answers are scoped to the caller — the leak was state the page kept.
 *
 * So this suite does what the report asked for, not just the one case:
 *
 *   Admin → guest            the Today answer, its box and the dock must reset
 *   Admin → user B           same, plus B's own book must not grow admin rows
 *   sign out → reload        a remembered device must die at sign-out, both
 *                            in the browser and on the server, and a reload
 *                            must stop at the login screen — while a reload
 *                            WITHOUT a sign-out still signs the owner back in
 *                            (a fix that broke "remember this device" would
 *                            be its own bug)
 *   module switching         the same identity keeps its own answers; only a
 *                            change of identity sweeps them
 *   a stale deep link        admin's #/customers/c1 under user B must render
 *                            B's book, not reach back for admin's
 *
 * The model is the same stand-in as verify-ai: every reply carries a marker
 * string that never appears in the app's own copy, so any screen that shows
 * it is showing a model's answer — and any screen held by the wrong identity
 * that shows it is a leak. Run from waypoint/:  WP_PASS=… npm run verify:switch
 */
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { claimPort } from './harness.mjs';
import { adminSeed, credentialFor, ADMIN, ADMIN_PASS } from './verify-auth.mjs';
import { createServer } from 'node:http';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8859;
const STUB_PORT = 8860;
const ORIGIN = 'http://127.0.0.1:' + PORT;
const STUB = 'http://127.0.0.1:' + STUB_PORT + '/v1';
const PASS = process.env.WP_PASS || ADMIN_PASS;
const MARK = 'RESIDUE-MARKER-X7';
const ADMIN_BOOK = 'NusaTel Berhad — ADMIN BOOK';
const PROBE = 'Residue probe opportunity';
const USER_B = { id: 'u_far', name: 'Farah Lim', email: 'farahlim@global.tencent.com', role: 'bd', title: 'BD' };

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 12000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(step); }
  return !!fn();
}

/* --------------------------------------------------------------- the model ----
   Every reply carries the marker. The focus-week executor builds its items
   from the CALLER's book on the server and asks the model only for the
   suggestion line, so the marker itself may not reach a Today box — the box
   still names the caller's customer and opportunity, and that is what the
   wrong identity must never see. Free-form dock answers show the marker
   verbatim, which is what the dock assertions read. */
const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url.endsWith('/models')) return send(200, { data: [{ id: 'waypoint-test-model' }] });
    if (req.url.endsWith('/chat/completions')) return send(200, {
      choices: [{ message: { content: MARK + ' — this answer belongs to the session that asked.' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    send(404, { error: 'not found' });
  });
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

/* --------------------------------------------------------------- the server ----
   A workspace with exactly one customer and one opportunity, owned by the
   administrator. User B (a BD) owns nothing, so B's scoped book is empty:
   anything from the admin's book that reaches B's screen came from residue,
   not from the server. */
const dir = mkdtempSync(join(tmpdir(), 'wp-switch-'));
copyFileSync(join(ROOT, 'data', 'workbench.json'), join(dir, 'workbench.json'));
{
  const skeleton = JSON.parse(readFileSync(join(dir, 'workbench.json'), 'utf8'));
  const seed = adminSeed();
  const at = new Date().toISOString();
  skeleton.users = [seed.users[0], { ...USER_B, locked: false, createdAt: at, updatedAt: at }];
  skeleton.credentials = { [ADMIN.id]: credentialFor(ADMIN.id, PASS), [USER_B.id]: credentialFor(USER_B.id, PASS) };
  skeleton.customers = [{
    id: 'c1', name: ADMIN_BOOK, industry: 'Telecom', hq: 'Kuala Lumpur',
    owner: ADMIN.name, stance: 'With us', health: 'Healthy', since: 'Mar 2026',
    brief: '', pains: [], contacts: [], apps: [], opps: [], timeline: [], updatedAt: at,
  }];
  skeleton.opps = { o_res1: { id: 'o_res1', c: 'c1', t: PROBE, v: 100000, p: 50, stage: 'Interested', owner: ADMIN.name } };
  skeleton.steps = []; skeleton.team = []; skeleton.audit = []; skeleton.files = [];
  skeleton.watch = []; skeleton.interactions = []; skeleton.logs = seed.logs;
  writeFileSync(join(dir, 'workbench.json'), JSON.stringify(skeleton));
}

const srv = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
  env: {
    ...process.env,
    WB_DATA_DIR: dir,
    PORT: String(PORT),
    WB_TLS: '0',
    WB_ORIGINS: ORIGIN,
    WB_TEST_AI: '1',
    AI_BASE_URL: STUB,
    AI_API_KEY: 'sk-waypoint-test-key-0001',
    AI_MODEL: 'waypoint-test-model',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
/* Wait for a port this process has PROVEN is free — see scripts/harness.mjs. */
await claimPort(PORT);
let srvLog = '';
srv.stderr.on('data', (d) => { srvLog += d; });
srv.stdout.on('data', (d) => { srvLog += d; });
check('the server is up',
  await waitFor(() => { try { return fetch(ORIGIN + '/api/health').then((r) => r.ok).catch(() => false); } catch { return false; } }, 9000));

/* The browser cookie jar, shared by every page instance below — the way one
   real browser tab carries its cookies through sign-outs and reloads. */
let cookie = '';
async function api(path, opts = {}) {
  const res = await fetch(ORIGIN + path, {
    ...opts,
    redirect: 'manual',
    signal: AbortSignal.timeout(120000),
    headers: { ...(opts.headers || {}), Origin: ORIGIN, ...(cookie ? { cookie } : {}) },
  });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map((s) => s.split(';')[0]).join('; ');
  return res;
}

/* A page. `storage` seeds localStorage before any script runs — an empty
   object is a machine with nothing remembered; a dump from a previous page
   is what a reload inherits. `beforeParse` also takes over fetch, so the
   boot sequence itself (session check, device re-login) runs through the
   same cookie jar a real tab would. */
const HTML = readFileSync(join(ROOT, 'Waypoint-v1.html'), 'utf8');
function bootPage(storage = {}) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});
  const dom = new JSDOM(HTML, {
    url: ORIGIN + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      for (const [k, v] of Object.entries(storage)) { try { window.localStorage.setItem(k, v); } catch { /* refused */ } }
      window.fetch = (u, o) => api(String(u).replace(ORIGIN, ''), o);
      window.scrollTo = () => {};
    },
  });
  return dom;
}
const storageDump = (win) => {
  const out = {};
  for (let i = 0; i < win.localStorage.length; i++) {
    const k = win.localStorage.key(i);
    out[k] = win.localStorage.getItem(k);
  }
  return out;
};
async function click(doc, el, ms = 300) {
  if (!el) return false;
  el.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  await wait(ms);
  return true;
}
async function setVal(doc, el, v) {
  if (!el) return false;
  el.value = v;
  el.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
  el.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  await wait(120);
  return true;
}
/* jsdom puts the script source in textContent, so strip script and style
   before reading what a person would actually see. */
const bodyText = (doc) => {
  const c = doc.body.cloneNode(true);
  c.querySelectorAll('script,style').forEach((n) => n.remove());
  return c.textContent;
};
const dismissTour = async (doc) => {
  /* The tour follows enterApp closely, but not synchronously in jsdom —
     wait for it (or for its absence) before touching anything else. */
  await waitFor(() => !!doc.querySelector('[data-tour-dismiss]'), 1500);
  const b = doc.querySelector('[data-tour-dismiss]');
  if (b) { b.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true })); await wait(300); }
};
/* The sign-in screen (#lgE) is REMOVED from the DOM by enterApp — the nav,
   beware, is present (hidden) already on the login screen, so waiting for
   #nav would pass before the first fetch resolves. #lgE going away is the
   honest signal that this identity is actually in. */
const signInAs = async (doc, email, { keep = false } = {}) => {
  await waitFor(() => !!doc.querySelector('#lgE'), 6000);
  await setVal(doc, doc.querySelector('#lgE'), email);
  await setVal(doc, doc.querySelector('#lgP'), PASS);
  if (keep && doc.querySelector('#lgKeep')) doc.querySelector('#lgKeep').checked = true;
  await click(doc, doc.querySelector('.lg-go'), 600);
  return waitFor(() => !!doc.querySelector('#nav') && !doc.querySelector('#lgE'));
};
const signOut = async (doc) => {
  await click(doc, doc.querySelector('#meBtn'), 350);
  await click(doc, doc.querySelector('#meMenu [data-act="endsession"]'), 700);
  return waitFor(() => !!doc.querySelector('#lgE'));
};
const dockText = (doc) => {
  const el = doc.getElementById('palA');
  return el ? el.textContent : '';
};

/* =========================================================== act 1 ============
   The reported case, and every neighbour of it, inside ONE page: admin asks
   the model, then hands the same page to a guest, then to user B. Nothing
   the admin generated may survive either handover. */
{
  const dom = bootPage();
  const doc = dom.window.document;
  const win = dom.window;

  check('signed in as the administrator', await signInAs(doc, ADMIN.email));
  await dismissTour(doc);

  /* The administrator's own view of the book — the baseline every residue
     assertion below is measured against. */
  await click(doc, doc.querySelector('[data-go="customers"]'), 400);
  check('the admin book is visible to its owner',
    await waitFor(() => bodyText(doc).includes(ADMIN_BOOK), 8000));

  /* Ask the model on Today, and wait for the answer to land. */
  await click(doc, doc.querySelector('[data-go="today"]'), 600);
  await waitFor(() => !!doc.querySelector('[data-tb="focusWeek"]'), 8000);
  await click(doc, doc.querySelector('[data-tb="focusWeek"]'), 400);
  const answered = await waitFor(() => bodyText(doc).includes('Ask again'), 20000);
  check('the copilot answered on Today', answered && bodyText(doc).includes(PROBE));

  /* Module switching is NOT a change of identity: the same person's answer
     stays. (A sweep this broad has a failure mode of its own — clearing a
     user's screen because they walked to another module. This is the trip
     wire for that.) */
  await click(doc, doc.querySelector('[data-go="customers"]'), 600);
  await click(doc, doc.querySelector('[data-go="today"]'), 600);
  check('switching modules keeps the same session\'s answer', bodyText(doc).includes('Ask again'));

  /* Admin → guest, in the same page, without a reload. */
  check('signing out returns to the login screen', await signOut(doc));
  await click(doc, doc.querySelector('[data-act="demo"]'), 900);
  await dismissTour(doc);
  const gText = bodyText(doc);
  check('the guest screen shows none of the admin book',
    !gText.includes(ADMIN_BOOK) && !gText.includes(PROBE) && !gText.includes(MARK),
    gText.includes(ADMIN_BOOK) ? 'the customer leaked' : gText.includes(PROBE) ? 'the opportunity leaked' : gText.includes(MARK) ? 'the model text leaked' : '');
  check('the guest Today task box starts clean',
    !gText.includes('Ask again') && !gText.includes('Thinking'));
  await click(doc, doc.querySelector('#aiBtn'), 500);
  check('the guest dock carries no admin answer', !dockText(doc).includes(MARK));
  try { win.eval('closePal()'); } catch { /* already closed */ }
  await wait(200);

  /* Guest → user B, still the same page. */
  await click(doc, doc.querySelector('.rban [data-act="endsession"]'), 900);
  check('user B can sign in after the guest', await signInAs(doc, USER_B.email, { keep: true }));
  await dismissTour(doc);
  const bText = bodyText(doc);
  check('user B sees none of admin\'s book',
    !bText.includes(ADMIN_BOOK) && !bText.includes(PROBE) && !bText.includes(MARK));
  await click(doc, doc.querySelector('#aiBtn'), 500);
  check('user B\'s dock carries no admin answer', !dockText(doc).includes(MARK));
  try { win.eval('closePal()'); } catch { /* already closed */ }
  await wait(200);

  /* B chose "remember this device" — the fix must not have broken that. */
  const deviceToken = win.localStorage.getItem('cwb-device') || '';
  check('remembering the device stores a token', deviceToken !== '');

  /* ---- reload as B (fresh page, same storage, same cookies): back in ---- */
  const dom2 = bootPage(storageDump(win));
  const doc2 = dom2.window.document;
  check('a reload signs the remembered owner back in',
    await waitFor(() => !!doc2.querySelector('#nav'), 12000) && !doc2.querySelector('#lgE'));
  await dismissTour(doc2);
  const b2Text = bodyText(doc2);
  check('the reload still shows no admin residue',
    !b2Text.includes(ADMIN_BOOK) && !b2Text.includes(PROBE) && !b2Text.includes(MARK));

  /* ---- B signs out: the token must die in the page AND on the server ---- */
  check('signing out returns B to the login screen', await signOut(doc2));
  const tokenAfterSignout = doc2.defaultView.localStorage.getItem('cwb-device');
  check('signing out clears the remembered device', !tokenAfterSignout);
  const storageAfterSignout = storageDump(doc2.defaultView);

  /* ---- reload after sign-out: the door must stay shut ----
     The boot may still be mid-flight here — session check, then the
     remembered-device branch — so give the automatic re-login path its
     full runway before declaring the screen settled: if a stale token
     walks back in, THAT is exactly the bug this check exists to catch. */
  const dom3 = bootPage(storageAfterSignout);
  const doc3 = dom3.window.document;
  await waitFor(() => { try { return dom3.window.eval('view.s') === 'login' || !doc3.querySelector('#lgE'); } catch { return false; } }, 5000);
  /* The buffer is the point: it is the runway a stale remembered-device
     token would need to walk back in. If one does, #lgE is gone by now. */
  await wait(2000);
  check('a reload after sign-out stops at the login screen', !!doc3.querySelector('#lgE'));

  /* The page can lie about clearing localStorage; the server cannot. The
     old token, replayed the way a boot would replay it, must be refused. */
  const replay = await api('/api/login/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: deviceToken }),
  });
  check('the signed-out device token is dead on the server', replay.status === 401, 'status ' + replay.status);
}

/* =========================================================== act 2 ============
   The address bar survives its users too. Admin's deep link, revisited under
   user B (the back-button case), must render B's book — or a not-found —
   never reach back into admin's. */
{
  const dom = bootPage();
  const doc = dom.window.document;
  const win = dom.window;

  check('admin signs in for the deep-link walk', await signInAs(doc, ADMIN.email));
  await dismissTour(doc);
  await click(doc, doc.querySelector('[data-go="customers"]'), 400);
  await waitFor(() => doc.querySelectorAll('#page [data-open]').length > 0, 8000);
  await click(doc, doc.querySelector('#page [data-open]'), 900);
  const deepLinked = await waitFor(() => win.location.hash.includes('#/customers/c1'), 6000);
  check('the admin deep link is real', deepLinked && bodyText(doc).includes(ADMIN_BOOK));

  /* Hand the very same address to user B. */
  await signOut(doc);
  check('user B signs in on the same address', await signInAs(doc, USER_B.email));
  await dismissTour(doc);
  /* Whatever the login did to the hash, force the admin deep link back —
     this is what the browser's back button does to a hash route. */
  win.location.hash = '#/today';
  await wait(400);
  win.location.hash = '#/customers/c1';
  await wait(900);
  const afterBack = bodyText(doc);
  check('the admin deep link under user B shows no admin data', !afterBack.includes(ADMIN_BOOK) && !afterBack.includes(PROBE));
}

/* --------------------------------------------------------------- the end ---- */
try { srv.kill(); } catch { /* already gone */ }
stub.close();
console.log('');
if (fail) {
  console.log('switch: ' + pass + ' passed, ' + fail + ' FAILED' + (srvLog ? '\n--- server log tail ---\n' + srvLog.slice(-2000) : ''));
  process.exit(1);
}
console.log('switch: ' + pass + ' passed, 0 failed');
process.exit(0);
