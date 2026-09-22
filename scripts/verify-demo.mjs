/* verify:demo — the sample book says it is the sample book.
 *
 * WHY THIS EXISTS
 * ---------------
 * The book people are shown at a demo has to be distinguishable from a book
 * somebody works in. The seeder (scripts/seed-demo.mjs) now writes NO
 * business data at all — the four-company demo book lives client-side in the
 * guest posture — so the only producer of the `demo` mark is an operator
 * marking a workspace on disk by hand. Every one of those numbers still looks
 * exactly like a real number on screen, and the screen used to say nothing
 * about which book you were reading. Somebody quotes RM450k in a meeting and
 * nobody in the room can tell whether it came from a customer or from a
 * fixture.
 *
 * So the workspace carries a mark, the server owns it, and the rail says it:
 * `SAMPLE DATA`, in neutral grey. Neutral on purpose — sample data is not a
 * warning about the data, it is a fact about the book, and amber here would
 * say "this needs your attention" about a workspace that is merely not real.
 *
 * The mark is the server's to keep, not the client's to assert. A save that
 * replaces the whole state would otherwise drop the key on the floor and take
 * the badge with it — the badge then vanishes in the middle of the very demo
 * it exists to protect. And a client that sent `demo: true` of its own would
 * be marking somebody else's real book as a sample.
 *
 * Two workspaces, two servers: one marked on disk, and a copy with the mark
 * removed, which stands in for a real book somebody is working in.
 *
 * Run from customer-workbench/:  npm run verify:demo
 */
import { spawn, spawnSync } from 'node:child_process';
import { claimPort } from './harness.mjs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readWorkspaceFile } from './disk.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT_A = Number(process.env.DEMO_PORT || 8881);
const PORT_B = Number(process.env.DEMO_REAL_PORT || 8882);
const PASSWORD = process.env.WP_PASS || 'Waypoint#2026';
const EMAIL = 'tehbinshun@global.tencent.com';
const SOURCE = readFileSync(join(ROOT, 'Waypoint-v1.html'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------- the books */

const dirA = mkdtempSync(join(tmpdir(), 'wp-demo-'));
const dirB = mkdtempSync(join(tmpdir(), 'wp-demo-real-'));

/* Seeded into a throwaway directory rather than copied out of data/: the
   claim under test starts from what the seeding tool writes. */
{
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'seed-demo.mjs')], {
    cwd: ROOT, env: { ...process.env, WB_DATA_DIR: dirA }, encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.log('FAIL  the seeder would not run:\n' + (r.stdout || '') + (r.stderr || ''));
    process.exit(1);
  }
}
/* The mark is written ON DISK by hand — the only producer now that the
   seeder writes no business data. This stands in for an operator marking a
   workspace; what is under test is the server's keeping of the mark, not
   the writing of it. */
{
  const book = JSON.parse(readFileSync(join(dirA, 'workbench.json'), 'utf8'));
  book.demo = true;   /* the mark, as an operator writes it */
  writeFileSync(join(dirA, 'workbench.json'), JSON.stringify(book));
  const real = JSON.parse(readFileSync(join(dirA, 'workbench.json'), 'utf8'));
  delete real.demo;   /* a real workspace: nothing was seeded into it */
  writeFileSync(join(dirB, 'workbench.json'), JSON.stringify(real));
  writeFileSync(join(dirB, 'workbench.rev.json'), JSON.stringify({ rev: 1, savedAt: new Date().toISOString() }));
}

const diskA = () => readWorkspaceFile(join(dirA, 'workbench.json'));
const diskB = () => readWorkspaceFile(join(dirB, 'workbench.json'));

/* ------------------------------------------------------------ the servers */

const servers = [];
async function serve(port, dir) {
  const origin = 'http://127.0.0.1:' + port;
  const srv = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
    env: { ...process.env, WB_DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1',
           WB_TLS: '0', WB_ORIGINS: origin, WB_DATA_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await claimPort(port);
  srv.stderr.on('data', d => { const s = String(d); if (/Error/.test(s)) console.log('[server] ' + s.trim()); });
  servers.push(srv);
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(origin + '/api/health')).ok) return origin; } catch { /* not yet */ }
    await wait(150);
  }
  console.log(`FAIL  the test server on ${port} never answered`);
  process.exit(1);
}
const bye = () => { for (const s of servers) { try { s.kill(); } catch { /* already gone */ } } };
process.on('exit', bye);

const ORIGIN_A = await serve(PORT_A, dirA);
const ORIGIN_B = await serve(PORT_B, dirB);

/* One signed-in caller per workspace, cookie jar and all. */
function caller(origin) {
  const jar = { v: '' };
  return async (path, opts = {}) => {
    const res = await fetch(origin + path, {
      ...opts, redirect: 'manual',
      headers: { ...(opts.headers || {}), Origin: origin, ...(jar.v ? { cookie: jar.v } : {}) },
    });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (sc.length) jar.v = sc.map(s => s.split(';')[0]).join('; ');
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    return { status: res.status, body };
  };
}
const apiA = caller(ORIGIN_A);
const apiB = caller(ORIGIN_B);

/* Signed in by id: the page resolves the typed address against the directory
   first, and a caller that posts the address straight at /api/login is
   matching it against the email column, which the seeder only fills for one
   account. */
const signedIn = await apiA('/api/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ userId: 'u_teh', password: PASSWORD }),
});
check('the seeded book signs its own administrator in',
  signedIn.status === 200 && signedIn.body?.user?.role === 'admin',
  'status ' + signedIn.status + ' role=' + signedIn.body?.user?.role);
await apiB('/api/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ userId: 'u_teh', password: PASSWORD }),
});

/* ======================================================================= */
console.log('\n— the mark belongs to the book, and the server keeps it —');

check('the book marked on disk is the sample book', diskA().demo === true,
  'demo=' + JSON.stringify(diskA().demo));
check('a workspace nobody marked carries no mark', !('demo' in diskB()));

const readA = await apiA('/api/data');
check('the read says which book this is', readA.body?.demo === true,
  'demo=' + JSON.stringify(readA.body?.demo));
const readB = await apiB('/api/data');
check('the real book says nothing about being a sample',
  readB.body?.demo === false || readB.body?.demo === undefined,
  'demo=' + JSON.stringify(readB.body?.demo));

/* The whole-state save: the path that takes the payload as the truth. If the
   mark is not the server's to keep, this is where it is lost — mid-demo, with
   no error and no trace. */
{
  const before = await apiA('/api/data');
  const rev = before.body.rev;
  const state = before.body.state;
  const put = await apiA('/api/data', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-base-rev': String(rev) },
    body: JSON.stringify({ state, baseRev: rev }),
  });
  check('a save is accepted', put.status === 200,
    'status ' + put.status + ' ' + JSON.stringify(put.body?.error || ''));
  check('a save does not quietly unmark the book', diskA().demo === true,
    'demo=' + JSON.stringify(diskA().demo));
  const after = await apiA('/api/data');
  check('the next read still says so', after.body?.demo === true,
    'demo=' + JSON.stringify(after.body?.demo));
}

/* And the other direction: a client asserting the mark gets nowhere. This is
   the one that would let anybody label a real book as a sample — or, worse,
   quietly launder sample figures as somebody's real pipeline. */
{
  const before = await apiB('/api/data');
  const rev = before.body.rev;
  const state = { ...before.body.state, demo: true };
  const put = await apiB('/api/data', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-base-rev': String(rev) },
    body: JSON.stringify({ state, baseRev: rev }),
  });
  check('the forged save is answered', put.status === 200, 'status ' + put.status);
  check('a client cannot mark a real book as a sample', !('demo' in diskB()),
    'demo=' + JSON.stringify(diskB().demo));
  const after = await apiB('/api/data');
  check('and the read does not repeat the claim', !after.body?.demo,
    'demo=' + JSON.stringify(after.body?.demo));
}

/* ======================================================================= */
console.log('\n— and the rail says it out loud —');

const pageErrors = [];

/** A signed-in page. `reload()` throws the DOM away and keeps the session. */
async function open(origin) {
  const jar = { v: '' };
  const api = async (path, opts = {}) => {
    const res = await fetch(origin + path, {
      ...opts, redirect: 'manual',
      headers: { ...(opts.headers || {}), Origin: origin, ...(jar.v ? { cookie: jar.v } : {}) },
    });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (sc.length) jar.v = sc.map(s => s.split(';')[0]).join('; ');
    return res;
  };
  const build = async () => {
    const vc = new VirtualConsole();
    vc.on('jsdomError', e => pageErrors.push(String(e.message)));
    const win = new JSDOM(SOURCE, {
      url: origin + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
      beforeParse: (w) => {
        w.scrollTo = () => {};
        w.URL.createObjectURL = () => 'blob:stub';
        w.URL.revokeObjectURL = () => {};
        w.fetch = (u, o) => api(String(u).replace(origin, ''), o);
      },
    }).window;
    await wait(900);
    const doc = win.document;
    const e = doc.getElementById('lgE'), p = doc.getElementById('lgP');
    if (e && p) {
      e.value = EMAIL; p.value = PASSWORD;
      doc.querySelector('[data-act="signin"]')
        .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await wait(1700);
    }
    return win;
  };
  const win = await build();
  const s = {
    win,
    get doc() { return win.document; },
    $: (sel) => win.document.querySelector(sel),
    $$: (sel) => [...win.document.querySelectorAll(sel)],
    text: () => (win.document.getElementById('page') || win.document.body).textContent,
    railText: () => (win.document.querySelector('.rail') || win.document.body).textContent,
    badge: () => win.document.querySelector('.sample-tag'),
    click: async (el, ms = 400) => {
      if (!el) return false;
      el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await wait(ms); return true;
    },
    reload: async (ms = 1700) => { s.win = await build(); await wait(ms); return s.win; },
  };
  return s;
}

const s = await open(ORIGIN_A);
check('the administrator reaches the workspace', /Good (morning|afternoon|evening)|Today|Customers/.test(s.text()),
  s.text().slice(0, 40));

const badge = s.badge();
check('the rail names the book as sample data', !!badge && /sample data/i.test(badge.textContent || ''),
  badge ? JSON.stringify(badge.textContent) : 'no badge in the rail');
check('it is in the rail, not floating in the page',
  !!badge && !!badge.closest('.rail') && !badge.closest('#page'));
check('there is exactly one of them', s.$$('.sample-tag').length === 1,
  s.$$('.sample-tag').length + ' found');

/* Neutral, not a warning: the one colour rule this badge has. */
{
  const rule = /\.sample-tag\{([^}]*)\}/.exec(SOURCE);
  check('the badge is styled from the neutral tokens',
    !!rule && !/--warn|--risk|--ok|--blue/.test(rule[1]),
    rule ? rule[1].slice(0, 60) : 'no .sample-tag rule in the stylesheet');
  check('the badge is not carrying a warning class',
    !!badge && !/t-warn|t-risk|t-ok/.test(badge.className || ''), badge?.className);
}

const afterReload = await s.reload();
check('the badge is there again after a reload',
  !!afterReload.document.querySelector('.sample-tag'));

/* ------------------------------------------------- the administrator's say */
await s.click(s.$('[data-go="admin"]'), 900);
await s.click(s.$('[data-atab="roles"]'), 800);   /* the badge is an act on the workspace, and the Roles tab is where the workspace's own switches live */
const adminText = s.text();
check('the administrator is offered the switch',
  /sample data/i.test(adminText) || /sample/i.test(adminText),
  adminText.slice(0, 60));

const button = s.$$('[data-act="demobadge"]')[0];
check('the switch is on the screen', !!button);
await s.click(button, 1600);
check('the badge goes when the administrator says so', !s.badge(),
  s.badge() ? 'still there' : 'gone');
await wait(900);   /* one debounce window for the save to leave */
check('and the choice is kept on the server',
  (diskA().config || {}).hideDemoBadge === true,
  'config=' + JSON.stringify(diskA().config));
const reloaded = await s.reload();
check('and it stays gone on a fresh load', !reloaded.document.querySelector('.sample-tag'));

await s.click(s.$('[data-go="admin"]'), 900);
await s.click(s.$('[data-atab="roles"]'), 800);
await s.click(s.$$('[data-act="demobadge"]')[0], 1600);
check('the administrator can ask for it back', !!s.badge());
await wait(900);
check('and that choice is kept too', (diskA().config || {}).hideDemoBadge === false,
  'config=' + JSON.stringify(diskA().config));

/* ------------------------------------------------- a real book says nothing */
const real = await open(ORIGIN_B);
check('a workspace nobody seeded shows no badge', !real.badge(),
  real.badge() ? JSON.stringify(real.badge().textContent) : 'no badge');
check('and its administrator is not offered the switch either',
  !real.$('[data-act="demobadge"]'));

check('the page threw nothing while being read', pageErrors.length === 0,
  pageErrors.slice(0, 2).join(' | '));

console.log('\n' + (fail ? `${fail} FAILED, ` : '') + `${pass} passed`);
bye();
process.exit(fail ? 1 : 0);
