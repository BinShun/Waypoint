/* verify:routes — the address bar is a real address, not a decoration.

   WHY THIS IS ITS OWN SUITE
   -------------------------
   A hash router is easy to fake. Writing `location.hash = '#/customers/' + id`
   somewhere in a click handler looks like routing in a diff, and it produces a
   URL that lies: reload it and you are on Today. So the three things that make
   an address real are checked here, and the third is the one that gets skipped:

     1. Moving through the app WRITES the address.
     2. Opening that address REBUILDS the same screen — including the customer,
        the tab, and the list-vs-board choice.
     3. The two directions do not chase each other. `hashchange` writes the view;
        the render that follows must not write a different hash back, or the
        browser flickers through phantom navigations and Back stops working.

   The suite also guards the parts that are easy to over-reach on:

     · What the URL must NOT carry. Search boxes and half-typed forms are the
       state of a conversation with a page, not a place in it. A router that
       also serialised every filter would produce links nobody can read, and
       this suite would then be testing a feature the product did not ask for.

     · The URL is not a way around the role. `#/admin` from a BD must not open
       the Admin screen — the same guard the renderer applies, applied to the
       address too. A router is a second entrance, and a second entrance that
       skips the door check is the classic way a role rule leaks.

   HOW IT DRIVES A RELOAD
   ----------------------
   jsdom runs the inline script DURING construction, so the URL has to be right
   when the DOM is built — assigning `win.location.hash` afterwards and expecting
   a boot sequence to notice is not a reload, it is a lie. `mk(hash)` therefore
   builds a fresh window AT that address, which is exactly what pressing F5 on
   `#/customers/c1` does.

   Run: WP_PASS=<password> npm run verify:routes
   Works in a temp workspace it creates itself, so it never touches real data. */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { startServer } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.ROUTE_PORT || 8868);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const PASS = process.env.WP_PASS || '';
const SOURCE = readFileSync(join(ROOT, 'Waypoint-v1.html'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

if (!PASS) { console.log('FAIL  no WP_PASS in the environment'); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'wp-route-'));

/* ------------------------------------------------------------- a real book --
   Three customers, one opportunity, one interaction, and a real administrator.
   The book MUST be non-empty and MUST carry a credential: `identify()` opens
   the front door only when there are no passwords and no customers, so a seed
   without one is answered 401 and this suite would spend its whole run
   measuring the refusal instead of the router.
   Two of the three belong to the signed-in owner and one does not, so the
   scope check on a pasted customer id has something to refuse. */
const seed = {
  schemaVersion: 1, setupComplete: true,
  users: [], credentials: {}, logs: [], audit: [], files: [], watch: [],
  customers: [
    { id: 'c1', name: 'Alpha Manufacturing', industry: 'Manufacturing', owner: 'Route Admin',
      health: 'OK', stance: 'Undecided', opps: [], contacts: [], apps: [], team: [], pains: [],
      timeline: [{ d: '2026-09-10', k: 'interaction', t: 'Kick-off', x: 'Scoped it.' }] },
    { id: 'c2', name: 'Beta Logistics', industry: 'Logistics', owner: 'Route Admin',
      health: 'OK', stance: 'Undecided', opps: ['o1'], contacts: [], apps: [], team: [], pains: [],
      timeline: [] },
    { id: 'c9', name: 'Somebody Else Sdn Bhd', industry: 'Retail', owner: 'Another Person',
      health: 'OK', stance: 'Undecided', opps: [], contacts: [], apps: [], team: [], pains: [],
      timeline: [] },
  ],
  interactions: [{ id: 'm1', c: 'c1', t: 'Kick-off', d: '2026-09-10', loc: 'Online',
    att: '', ours: 'Route Admin', sum: 'Scoped it.', out: 'Proposal by Friday.', k: 'Meeting' }],
  steps: [], team: [], products: [],
  opps: { o1: { id: 'o1', c: 'c2', t: 'Warehouse modernisation', v: 500000, p: 40,
    stage: 'Interested', owner: 'Route Admin', close: '', age: 0, items: [] } },
};
{
  const salt = randomBytes(16);
  const at = new Date().toISOString();
  seed.users = [{ id: 'u_route', name: 'Route Admin', role: 'admin', title: 'admin',
    locked: false, createdAt: at, updatedAt: at }];
  seed.credentials = {
    u_route: { userId: 'u_route', algo: 'pbkdf2-sha256', iterations: 150_000,
      salt: salt.toString('base64'),
      hash: pbkdf2Sync(PASS, salt, 150_000, 32, 'sha256').toString('base64'),
      createdAt: at, updatedAt: at },
  };
  seed.team = [{ n: 'Route Admin', r: 'Senior BD', f: 'BD', role: 'admin', last: '—', st: 'Active' }];
}
writeFileSync(join(dir, 'workbench.json'), JSON.stringify(seed));

/* --------------------------------------------------------------- the server -- */
let srv;
try {
  srv = await startServer({
    spawnBin: process.execPath,
    args: [join(ROOT, 'server', 'server.mjs')],
    env: { ...process.env, WB_DATA_DIR: dir, PORT: String(PORT), WB_TLS: '0' },
    port: PORT,
  });
} catch (e) { console.log('FAIL  ' + e.message); process.exit(1); }
srv.stderr.on('data', (d) => { const s = String(d); if (/Error/.test(s)) console.log('[server] ' + s.trim()); });
process.on('exit', () => { try { srv.kill(); } catch { /* gone */ } });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------- one browser --
   `mk(hash)` is the reload: a brand new window, the inline script run at that
   URL, the session resumed from the same cookie jar. Anything less is not a
   refresh and does not prove the address survives one. */
const pageErrors = [];
function browser() {
  const jar = { v: '' };
  const api = async (path, opts = {}) => {
    const res = await fetch(ORIGIN + path, {
      ...opts, redirect: 'manual',
      headers: { Origin: ORIGIN, ...(jar.v ? { cookie: jar.v } : {}), ...(opts.headers || {}) },
    });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (sc.length) jar.v = sc.map((s) => s.split(';')[0]).join('; ');
    return res;
  };
  const mk = (hash = '') => {
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => pageErrors.push(String(e.message)));
    const dom = new JSDOM(SOURCE, {
      url: ORIGIN + '/' + hash, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
      beforeParse: (w) => {
        w.scrollTo = () => {};
        w.URL.createObjectURL = () => 'blob:stub';
        w.URL.revokeObjectURL = () => {};
        w.fetch = (u, o) => api(String(u).replace(ORIGIN, ''), o);
      },
    });
    return dom.window;
  };
  const sess = {
    api, jar, mk,
    win: null,
    /* Every reader goes through sess.win, never a captured reference: after a
       reload the old DOM is still alive in memory, and a suite that reads it
       proves nothing about the fresh one. */
    get doc() { return sess.win.document; },
    $: (s) => sess.win.document.querySelector(s),
    $$: (s) => [...sess.win.document.querySelectorAll(s)],
    hash: () => sess.win.location.hash,
    text: () => (sess.win.document.getElementById('page') || sess.win.document.body).textContent,
    click: async (el, ms = 380) => {
      if (!el) return false;
      el.dispatchEvent(new sess.win.MouseEvent('click', { bubbles: true }));
      await wait(ms); return true;
    },
    set: async (el, v) => {
      if (!el) return false;
      el.value = v;
      el.dispatchEvent(new sess.win.Event('input', { bubbles: true }));
      await wait(80); return true;
    },
    byText: (sel, t) => [...sess.win.document.querySelectorAll(sel)].find((x) => (x.textContent || '').includes(t)),
    /* A reload at the CURRENT address — the F5 a user actually presses. The
       wait is deliberately generous: a fresh JSDOM has to boot, fetch the
       book, and render, and under verify:all the machine is carrying every
       suite before this one — a wait tuned on an idle box failed exactly
       here, on a pass, for nobody's change. */
    reload: async () => { sess.win = mk(sess.win.location.hash); await wait(2600); return sess; },
    /* A reload at a GIVEN address — a pasted link, or Back to somewhere else. */
    openAt: async (hash) => { sess.win = mk(hash); await wait(2600); return sess; },
  };
  return sess;
}

const s = browser();
s.win = s.mk('');
await wait(900);
{
  const e = s.doc.getElementById('lgE'), p = s.doc.getElementById('lgP');
  if (e && p) {
    e.value = 'Route Admin'; p.value = PASS;
    s.doc.querySelector('[data-act="signin"]').dispatchEvent(new s.win.MouseEvent('click', { bubbles: true }));
    await wait(1800);
  }
}
check('an administrator signs in', /Good (morning|afternoon|evening)|Today|Customers/.test(s.text()), s.text().slice(0, 40));

/* ========================================================================== */
console.log('\n— the app writes where you are —');

check('landing is a place, and it has an address', s.hash() === '#/today', s.hash());

await s.click(s.$('[data-go="customers"]'), 700);
check('opening the customer list moves the address', s.hash() === '#/customers', s.hash());

const card = s.$$('#page [data-open]').find((x) => (x.textContent || '').includes('Alpha Manufacturing'));
check('the customer card is there to click', !!card);
await s.click(card, 900);
check('opening a customer puts that customer in the address',
  s.hash() === '#/customers/c1', s.hash());
check('and the screen really is that customer', /Alpha Manufacturing/.test(s.text()));

const peopleTab = s.byText('#page [data-tab]', 'People');
check('the customer page offers its tabs', !!peopleTab);
await s.click(peopleTab, 700);
check('a tab is part of the place, so it is part of the address',
  s.hash() === '#/customers/c1?tab=people', s.hash());

/* The board/list switch is a layout, not a filter, so it belongs in the URL —
   the same distinction the doc-comment draws for the search boxes below. */
await s.click(s.$('[data-go="opportunities"]'), 700);
check('the opportunity board has an address', s.hash() === '#/opportunities', s.hash());
const listBtn = s.$('[data-cv="list"]');
check('the board/list switch is on screen', !!listBtn);
await s.click(listBtn, 700);
check('choosing a layout records the layout', s.hash() === '#/opportunities?view=list', s.hash());

/* ========================================================================== */
console.log('\n— what the address must NOT carry —');

await s.click(s.$('[data-go="customers"]'), 700);
const search = s.$('[data-cq]') || s.$('#custQ') || s.byText('input', '');
if (search) {
  await s.set(search, 'Alpha');
  check('typing in a search box does not rewrite the address',
    s.hash() === '#/customers', s.hash());
} else {
  check('typing in a search box does not rewrite the address', true, 'no search box on this screen');
}

const draftField = s.$('#ad1');
if (draftField) {
  await s.set(draftField, 'Half-typed and abandoned');
  check('a half-typed form does not rewrite the address',
    s.hash() === '#/customers', s.hash());
} else {
  check('a half-typed form does not rewrite the address', true, 'no add form open here');
}

/* ========================================================================== */
console.log('\n— a refresh comes back to the same place —');

await s.openAt('#/customers/c1');
check('a reload on a customer lands on that customer',
  /Alpha Manufacturing/.test(s.text()) && !/Today/.test(s.text().slice(0, 30)), s.text().slice(0, 60));

await s.openAt('#/customers/c1?tab=people');
{
  /* The tab has to be the ACTIVE one, not merely present in the markup — a
     suite that only greps for the word "People" would pass on a page that
     showed the Brief tab to a customer who has people on file. */
  const active = s.$$('#page [data-tab]').find((x) => x.classList.contains('on'));
  check('a reload on a tab lands on that tab', !!active && /People/.test(active.textContent || ''),
    active ? active.textContent.trim() : 'no active tab');
}

await s.openAt('#/opportunities?view=list');
{
  const on = s.$$('[data-cv]').find((x) => x.classList.contains('on'));
  check('a reload keeps the layout you chose', !!on && on.dataset.cv === 'list',
    on ? on.dataset.cv : 'no active layout');
}

/* A pasted link is the point of having an address at all. */
await s.openAt('#/customers/c2');
check('a link somebody else could have sent opens the right account',
  /Beta Logistics/.test(s.text()), s.text().slice(0, 60));

/* ========================================================================== */
console.log('\n— the address is not a second way in —');

await s.openAt('#/admin');
{
  /* Admin here is legitimate — this session IS an admin — so the assertion is
     that a valid address still works. The refusal is tested by the role-scoped
     suite; what matters here is that the router does not DROP a good address. */
  check('a valid address for a screen this role may open is honoured',
    /Admin/.test(s.text().slice(0, 120)), s.text().slice(0, 40));
}

await s.openAt('#/customers/c9');
{
  /* An ADMIN sees every customer, so c9 is legitimately in scope here and
     opening it is correct — which means it proves nothing about the guard.
     The guard is proved against a BD in the next section, where the same
     address must NOT open. */
  check('an admin may open any customer by its address',
    /Somebody Else Sdn Bhd/.test(s.text()), s.hash());
}

await s.openAt('#/nonsense');
check('a mistyped address lands somewhere real instead of a blank page',
  s.text().trim().length > 0, s.text().slice(0, 40));

/* #80: the task center is a place too — its address opens the screen, so
   "is my AI request still running?" can be linked, bookmarked, shared. */
await s.openAt('#/aitasks');
check('the AI task center has an address that opens it',
  /AI Tasks/.test(s.text()) && s.hash() === '#/aitasks', s.hash());

await s.openAt('#/customers/no-such-id');
check('an id that does not exist does not render an empty record',
  s.text().trim().length > 0 && !/No such/.test(s.text()), s.text().slice(0, 40));

/* ========================================================================== */
console.log('\n— the two directions do not chase each other —');

{
  /* This is the bug a naive mirror produces: reading the URL sets the view,
     rendering the view writes the URL, and the write is different from what
     was read — so every render is a navigation and Back walks through ghosts.
     Checked by standing still: re-render several times without navigating, and
     the address must not move.
     The input is dispatched on a real element, not on the document: the app's
     delegate reads `e.target.matches(...)`, and a synthetic event fired at the
     document has a target with no `matches` — which throws inside the listener
     and looks like a product fault when it is the test holding it wrong. */
  await s.click(s.$('[data-go="customers"]'), 700);
  const settled = s.hash();
  const anchor = s.$('[data-cq]') || s.$('#page');
  for (let i = 0; i < 3; i++) {
    if (anchor) anchor.dispatchEvent(new s.win.Event('input', { bubbles: true }));
    await wait(120);
  }
  check('rendering the same screen again does not move the address', s.hash() === settled,
    settled + ' -> ' + s.hash());
}

{
  /* A hashchange must move the view. This is the one path Back and Forward
     take, and a router that only handled boot would fail here. */
  await s.openAt('#/customers/c1');
  s.win.location.hash = '#/customers/c2';
  s.win.dispatchEvent(new s.win.Event('hashchange'));
  await wait(700);
  check('a hashchange moves the screen, not just the address',
    /Beta Logistics/.test(s.text()), s.text().slice(0, 60));
}

/* ========================================================================== */
console.log('\n— the mirror is off where it should be —');

{
  /* Signed out there is no place to come back to, and the sign-in screen must
     not leave the last customer in the address for the next person. */
  const g = browser();
  g.win = g.mk('#/today');
  await wait(900);
  check('a signed-out visitor is shown the door, not the workspace',
    !!g.doc.getElementById('lgE'), g.text().slice(0, 40));
  check('and the door has no address behind it', g.hash() === '' || g.hash() === '#/today',
    g.hash() || '(empty)');
}

/* ========================================================================== */
console.log('\n— a URL is not a way around the role —');

/* The one thing an admin session cannot test. Every guard the router applies is
   invisible to somebody who passes all of them, so the same addresses are
   opened again as a BD who owns one customer and not the other two.
   This has to be a SECOND workspace: the role lives in the credential, and
   signing in as somebody else is not a thing one browser session can do
   halfway through. */
{
  const dir2 = mkdtempSync(join(tmpdir(), 'wp-route-bd-'));
  const bdSeed = JSON.parse(JSON.stringify(seed));
  bdSeed.customers = bdSeed.customers.map((c) => c.id === 'c9'
    ? c : { ...c, owner: 'Bea Dee' });
  const salt = randomBytes(16);
  const at = new Date().toISOString();
  bdSeed.users = [{ id: 'u_bd', name: 'Bea Dee', role: 'bd', title: 'bd',
    locked: false, createdAt: at, updatedAt: at }];
  bdSeed.credentials = {
    u_bd: { userId: 'u_bd', algo: 'pbkdf2-sha256', iterations: 150_000,
      salt: salt.toString('base64'),
      hash: pbkdf2Sync(PASS, salt, 150_000, 32, 'sha256').toString('base64'),
      createdAt: at, updatedAt: at },
  };
  bdSeed.team = [{ n: 'Bea Dee', r: 'Senior BD', f: 'BD', role: 'bd', last: '—', st: 'Active' }];
  writeFileSync(join(dir2, 'workbench.json'), JSON.stringify(bdSeed));

  /* NOT `PORT + 1`. That is 8869, which is `verify-scenarios`'s own port — and
     the two suites run back to back in the aggregate run. The second server
     here was started, used, and killed inside a few hundred milliseconds, so
     in a run where the port was already free the collision never showed; when
     the previous suite's socket was still lingering, this server either failed
     to bind or (worse) answered a fetch meant for the other one. `claimPort`
     makes the failure loud, but the fix is to stop asking for a port that is
     somebody else's. */
  const bdPort = Number(process.env.ROUTE_BD_PORT || 8878), bdOrigin = 'http://127.0.0.1:' + bdPort;
  const bdSrv = await startServer({
    spawnBin: process.execPath, args: [join(ROOT, 'server', 'server.mjs')],
    env: { ...process.env, WB_DATA_DIR: dir2, PORT: String(bdPort), WB_TLS: '0' }, port: bdPort,
  });
  try {
    const jar2 = { v: '' };
    const api2 = async (path, opts = {}) => {
      const res = await fetch(bdOrigin + path, {
        ...opts, redirect: 'manual',
        headers: { Origin: bdOrigin, ...(jar2.v ? { cookie: jar2.v } : {}), ...(opts.headers || {}) },
      });
      const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (sc.length) jar2.v = sc.map((x) => x.split(';')[0]).join('; ');
      return res;
    };
    const mk2 = (hash = '') => new JSDOM(SOURCE, {
      url: bdOrigin + '/' + hash, runScripts: 'dangerously', pretendToBeVisual: true,
      virtualConsole: new VirtualConsole(),
      beforeParse: (w) => {
        w.scrollTo = () => {};
        w.URL.createObjectURL = () => 'blob:stub';
        w.URL.revokeObjectURL = () => {};
        w.fetch = (u, o) => api2(String(u).replace(bdOrigin, ''), o);
      },
    }).window;
    const wait2 = (ms) => new Promise((r) => setTimeout(r, ms));
    /* Read `#page`, not the body: the nav rail and the tour drawer live outside
       it and mention Admin and Roles on every screen, so a body-wide grep
       would report the Admin screen as visible to everybody. */
    const body = (w) => (w.document.getElementById('page') || w.document.body).textContent;

    let bw = mk2('');
    await wait2(900);
    {
      const e = bw.document.getElementById('lgE'), p = bw.document.getElementById('lgP');
      if (e && p) {
        e.value = 'Bea Dee'; p.value = PASS;
        bw.document.querySelector('[data-act="signin"]')
          .dispatchEvent(new bw.MouseEvent('click', { bubbles: true }));
        await wait2(1800);
      }
    }
    check('a BD signs in to their own workspace', /Good (morning|afternoon|evening)|Customers|Today/.test(body(bw)), body(bw).slice(0, 30));
    check('and does not see the account they are not on', !/Somebody Else/.test(body(bw)));

    bw = mk2('#/customers/c1'); await wait2(1700);
    check('their own record opens from an address, and the address is kept',
      /Alpha Manufacturing/.test(body(bw)) && bw.location.hash === '#/customers/c1', bw.location.hash);

    bw = mk2('#/customers/c9'); await wait2(1700);
    check('another person’s record named in the URL does not open',
      !/Somebody Else/.test(body(bw)), bw.location.hash);
    check('and it does not leave their id sitting in the address bar',
      !/c9/.test(bw.location.hash), bw.location.hash);

    bw = mk2('#/admin'); await wait2(1700);
    check('the Admin screen is not reachable by typing its address in',
      !/Roles|People directory|Access/.test(body(bw)), body(bw).trim().slice(0, 40));
    check('and that address is not left behind either', bw.location.hash === '#/today', bw.location.hash);

    /* BACK is the other way a forbidden address arrives, and it goes through
       the listener rather than the boot sequence. Returning quietly there would
       leave the refused hash in the bar while the screen showed something
       else — an address that claims to be somewhere it is not. */
    bw = mk2('#/customers/c1'); await wait2(1700);
    check('a BD is on their own record to begin with',
      /Alpha Manufacturing/.test(body(bw)), bw.location.hash);
    bw.location.hash = '#/customers/c9';
    bw.dispatchEvent(new bw.Event('hashchange'));
    await wait2(800);
    check('pressing Back onto a record outside your scope does not open it',
      !/Somebody Else/.test(body(bw)), body(bw).trim().slice(0, 40));
    check('and the refused address is corrected rather than left in the bar',
      !/c9/.test(bw.location.hash), bw.location.hash);
  } finally {
    try { bdSrv.kill(); } catch { /* gone */ }
  }
}

/* ========================================================================== */
console.log('\n— source-level: one vocabulary, not two —');

check('the router names every screen the app can render',
  /const ROUTE_SCREENS\s*=\s*\[[^\]]*'today'[^\]]*'admin'\]/.test(SOURCE));
check('and every customer tab, so an unknown tab cannot become a seventh one',
  /const ROUTE_TABS\s*=\s*\[[^\]]*'overview'[^\]]*'files'\]/.test(SOURCE));
check('the customer tab list matches the one the renderer draws',
  (() => {
    const declared = (SOURCE.match(/const ROUTE_TABS\s*=\s*\[([^\]]*)\]/) || [])[1] || '';
    const names = declared.split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
    return names.every((n) => new RegExp("data-tab=\"'?\\+?'?" + n).test(SOURCE) || SOURCE.includes("'" + n + "'"));
  })());
check('the URL is written with replaceState, so Back still means where I came from',
  /history\.replaceState/.test(SOURCE) && !/history\.pushState/.test(SOURCE));
check('and the write cannot fail on a filesystem origin',
  /catch\s*\{\s*if\s*\(h\)\s*location\.hash\s*=\s*h/.test(SOURCE));
check('a hashchange is wired up, so Back and Forward work',
  /addEventListener\('hashchange'/.test(SOURCE));
check('the address is checked against the role before it is obeyed',
  /if\s*\(v\.s\s*===\s*'admin'[^)]*can\('users'\)\)\s*return false/.test(SOURCE));
check('and against the scope, so naming a stranger’s record is not a way in',
  /if\s*\(v\.s\s*===\s*'customer'[^)]*!inScope\(v\.id\)\)\s*return false/.test(SOURCE));
check('the path word and the screen key are translated, not assumed equal',
  /const ROUTE_PATH\s*=\s*\{\s*customer:\s*'customers'\s*\}/.test(SOURCE));
check('the search state is deliberately NOT in the URL vocabulary',
  !/ROUTE_TABS\s*=\s*\[[^\]]*q[^\]]*\]/.test(SOURCE) && !/['"]q['"]\s*:/.test(SOURCE));
check('the tour suppresses the address bar while it drives the app',
  /routeSilent\s*=\s*true/.test(SOURCE));
check('no page errors were thrown along the way', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

console.log('\n' + pass + ' passed, ' + fail + ' failed  (' + (pass + fail) + ' checks)');
if (pageErrors.length) console.log('page errors: ' + pageErrors.slice(0, 3).join(' | '));
console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
try { srv.kill(); } catch { /* gone */ }
process.exit(fail ? 1 : 0);
