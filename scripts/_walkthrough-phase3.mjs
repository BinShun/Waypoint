/* _walkthrough-phase3.mjs — §31's twelve acceptance tests, walked as four
 * people, and what they found.
 *
 * WHY THIS IS NOT `verify:copilot`
 * ---------------------------------
 * The suites already machine-assert every line of §31: `copilot` walks Test
 * 1–6 with the spec's own questions, `copilot-scope` holds the three walls
 * of Test 7 and 8, `ai` presses the pipeline, the palette and the task
 * center for Test 9–12, `ai-tasks` tortures the table. A green tally there
 * says "nothing is broken". §33 asks a different question before Phase 3
 * may be called complete —
 *
 *     "Test the complete experience as Admin, Manager, Primary BD and
 *      Primary SA. Business usefulness, permission enforcement, AI
 *      accuracy, processing experience… Do not declare Phase 3 complete
 *      merely because the AI interface renders or produces demo
 *      responses."
 *
 * So this script does what `verify:all` cannot: it signs in as four real
 * people in four real browser sessions, walks the twelve tests in a
 * person's order — ask, read, walk away, come back, press confirm — and at
 * every step writes down the one sentence a suite never writes:
 *
 *     "The product promises X here. A person just did Y.
 *      Did they get X, or did they get something else?"
 *
 * There is no pass count, by the same argument as the Phase 2 walkthrough:
 * a tally would let "nothing threw" read as "the promise was kept". The
 * output is a document (walkthrough/WALKTHROUGH-31.md), not a green tick.
 *
 * THE STAND-IN, AND WHAT IT CAN HONESTLY PROVE
 * --------------------------------------------
 * The model is a scripted stand-in, so nothing here measures whether a
 * model was clever — no script can. What it can prove, and does, is the
 * plumbing the spec actually demands of Phase 3 (§4, §16, §26): the prompt
 * carried the person's own records (read from the stand-in's transcript),
 * the screen showed what came back, and nothing reached the book except
 * through a person's confirm press. "AI accuracy" in the §33 list is
 * walked as its machine-checkable half — the answer used the book, named
 * the records it leaned on, and dropped what the Product Reference does
 * not hold — which is the half the product is responsible for.
 *
 * THE FOUR PEOPLE (§33 names them)
 * --------------------------------
 *   Admin       Teh Bin Shun   — connects the model, asks for the pipeline
 *                                (Test 9), and finds the confidential wall
 *                                applies to the keys' holder too (Test 8).
 *   Primary BD  Jason Lim      — owns NusaTel Berhad; walks Tests 1, 2, 3,
 *                                4, 5, 11 and 12 start to finish, and both
 *                                faces of Test 8 (a customer not in his
 *                                book; a confidential one that is).
 *   Primary SA  Priya Nair     — the same account from the machines' side:
 *                                the same briefing (Test 2), the product
 *                                question (Test 6), and a paste of hallway
 *                                notes that never was a meeting.
 *   Manager     Tan Wei Ming   — the whole book and not one pen: the
 *                                pipeline question (Test 10), the write
 *                                doors that are not there, and the
 *                                deterministic question (Test 7) the model
 *                                never hears.
 *
 * RUN:  cd customer-workbench && WP_PASS=… node scripts/_walkthrough-phase3.mjs
 * Needs no running server: this script starts its own on a free port,
 * against its own temp workspace, over the real Product Reference.
 */
import { spawn } from 'node:child_process';
import { claimPort } from './harness.mjs';
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { readWorkspaceFile } from './disk.mjs';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.WALK3_PORT || 8866);
const STUB_PORT = Number(process.env.WALK3_STUB_PORT || 8867);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const STUB = 'http://127.0.0.1:' + STUB_PORT + '/v1';
const PASSWORD = process.env.WP_PASS || '';
const HTML = process.env.WALK_HTML || join(ROOT, 'Waypoint-v1.html');
const SOURCE = readFileSync(HTML, 'utf8');

const OUTDIR = process.argv[2] || join(ROOT, '..', 'walkthrough');
mkdirSync(OUTDIR, { recursive: true });

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const now = new Date().toISOString();
const iso = (days) => {
  const d = new Date(); d.setDate(d.getDate() + days);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

if (!PASSWORD) {
  console.log('FAIL  no WP_PASS in the environment — the four people cannot sign in.');
  process.exit(1);
}

/* ---------------------------------------------------------------- the log
   Same shape as the Phase 2 walkthrough: every entry one sentence about
   what happened, tagged works / promise / friction / gap, and no tally at
   the end — a count would let "nothing threw" read as "kept". */
const LOG = [];
let step = 0;
function note(kind, role, screen, what, detail = '') {
  step++;
  LOG.push({ n: step, kind, role, screen, what, detail, at: new Date().toISOString() });
  const tag = { promise: 'PROMISE ', gap: 'GAP     ', works: 'WORKS   ', friction: 'FRICTION' }[kind] || kind;
  console.log(`\n[${step}] ${tag}  ${role} · ${screen}`);
  console.log('    ' + what);
  if (detail) console.log('    → ' + detail);
}

/* --------------------------------------------------------- the stand-in
   Scripted, in order, push-only: an ask this script did not plan for gets
   no reply (the product will fail the task honestly), and is recorded as
   an unplanned hop — a finding about the script's own plan, not a pass. */
const stubScript = [];
const seen = { requests: 0, prompts: [] };
const unplanned = [];
const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url.endsWith('/models')) return send(200, { data: [{ id: 'waypoint-test-model' }] });
    if (req.url.endsWith('/chat/completions')) {
      seen.requests++;
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch { /* recorded empty below */ }
      const prompt = String((j.messages || []).map((m) => m.content).join('\n') || '');
      seen.prompts.push(prompt);
      const scripted = stubScript.length ? stubScript.shift() : null;
      if (scripted == null) { unplanned.push(prompt.slice(0, 100)); return send(200, { choices: [{ message: { content: '' } }] }); }
      if (scripted && scripted.status) return send(scripted.status, { error: scripted.error || 'stub failure' });
      const reply = (scripted && scripted.reply) != null ? String(scripted.reply) : String(scripted);
      if (scripted && scripted.delay) {
        setTimeout(() => send(200, { choices: [{ message: { content: reply } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }), scripted.delay);
        return;
      }
      return send(200, { choices: [{ message: { content: reply } }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
    }
    send(404, { error: 'not found' });
  });
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

/* --------------------------------------------------------------- the book
   The real `data/workbench.json` underneath — the Product Reference is the
   shipped one, so Test 6 asks against real rows — with the four people and
   a book shaped for the twelve tests laid over it:
     c1 NusaTel Berhad  — owner Jason (BD), sa Priya (SA): the whole chain.
     c2 Rengit Engineering — owner the manager: outside the BD's and the
        SA's book entirely (Test 8's missing face), and its one deal has
        never had an interaction (Test 7's witness).
     c3 Gamma Defence Systems — confidential, owned by the BD himself: on
        his screen, never to a model, not even for the admin (Test 8's
        confidential face, both sides). */
const dir = mkdtempSync(join(tmpdir(), 'wp-walk3-'));
copyFileSync(join(ROOT, 'data', 'workbench.json'), join(dir, 'workbench.json'));
{
  const skeleton = JSON.parse(readFileSync(join(dir, 'workbench.json'), 'utf8'));
  const at = now;
  const PEOPLE = [
    { id: 'u_teh', name: 'Teh Bin Shun', role: 'admin', title: 'Senior Solution Architect', email: 'tehbinshun@global.tencent.com' },
    { id: 'u_mgr', name: 'Tan Wei Ming', role: 'manager', title: 'Head of Cloud Business', email: 'tanweiming@global.tencent.com' },
    { id: 'u_bd', name: 'Jason Lim', role: 'bd', title: 'Account Manager', email: 'jasonlim@global.tencent.com' },
    { id: 'u_sa', name: 'Priya Nair', role: 'sa', title: 'Solution Architect', email: 'priyanair@global.tencent.com' },
  ];
  skeleton.users = PEOPLE.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, title: u.title, locked: false, createdAt: at, updatedAt: at }));
  skeleton.credentials = {};
  for (const u of PEOPLE) {
    const salt = randomBytes(16);
    skeleton.credentials[u.id] = { userId: u.id, algo: 'pbkdf2-sha256', iterations: 150_000,
      salt: salt.toString('base64'),
      hash: pbkdf2Sync(PASSWORD, salt, 150_000, 32, 'sha256').toString('base64'),
      createdAt: at, updatedAt: at };
  }
  skeleton.logs = [];
  skeleton.audit = [];
  skeleton.customers = [
    { id: 'c1', name: 'NusaTel Berhad', industry: 'Telecom', hq: 'Kuala Lumpur',
      owner: 'Jason Lim', sa: 'Priya Nair', stance: 'With us', health: 'Healthy',
      since: 'Mar 2026', site: 'nusatel.example', people: 4200, brief: '',
      pains: ['Billing runs on Exadata — renewal quote came back 40% higher'],
      contacts: [{ n: 'Dr Amir Rashid', t: 'Group CTO', s: 'With us', o: 'Jason Lim', b: 'Decision maker', note: '' }],
      apps: [], opps: ['o1'], timeline: [], confidential: false,
      /* Being put on a customer by its owner is how the SA was brought into
         the account (visibleAccountIds' team rule) — c.sa names the Primary
         SA, it does not by itself grant sight. */
      team: ['Priya Nair'], updatedAt: at },
    { id: 'c2', name: 'Rengit Engineering', industry: 'Manufacturing', hq: 'Johor Bahru',
      owner: 'Tan Wei Ming', sa: '', stance: 'Undecided', health: 'Watch',
      since: 'Jun 2026', site: 'rengit.example', people: 800, brief: '',
      pains: [], contacts: [], apps: [], opps: ['o2'], timeline: [], confidential: false, updatedAt: at },
    { id: 'c3', name: 'Gamma Defence Systems', industry: 'Defence', hq: 'Kuala Lumpur',
      owner: 'Jason Lim', sa: '', stance: 'With us', health: 'Healthy',
      since: 'Jan 2026', site: 'gamma-defence.example', people: 1200, brief: '',
      pains: ['Submarine combat system refresh is classified'],
      contacts: [], apps: [], opps: [], timeline: [], confidential: true, updatedAt: at },
  ];
  skeleton.opps = {
    o1: { id: 'o1', c: 'c1', cust: 'NusaTel Berhad', t: 'Cloud migration platform deal', v: 480000, p: 25,
      stage: 'Interested', close: '', desc: 'They are evaluating a phased migration of the billing stack off Exadata.',
      blockers: 'The CFO has not released the budget line',
      owner: 'Jason Lim', comp: '-', items: ['p1'], soln: '', whylost: '',
      stageAt: iso(-10), updatedAt: at },
    o2: { id: 'o2', c: 'c2', cust: 'Rengit Engineering', t: 'Perak factory automation', v: 90000, p: 15,
      stage: 'Interested', close: '', desc: 'They want to automate two assembly lines in the Perak plant.',
      blockers: '', owner: 'Tan Wei Ming', comp: '-', items: [], soln: '', whylost: '',
      stageAt: iso(-120), updatedAt: iso(-150) },
  };
  skeleton.interactions = [{ id: 'm1', c: 'c1', t: 'Billing migration workshop', d: iso(-1),
    loc: 'Kuala Lumpur', att: 'Dr Amir Rashid', ours: 'Jason Lim', sum: '', out: '' }];
  skeleton.steps = [{ id: 's1', c: 'c1', t: 'Send the sizing sheet before Friday', exec: 'Jason Lim',
    track: 'Jason Lim', due: iso(-3), w: '', from: 'us', p: 'p1', kind: 'proposal', o: 'o1',
    done: '', doneBy: '', doneNote: '' }];
  skeleton.team = []; skeleton.files = []; skeleton.watch = [];
  skeleton.products = (skeleton.products || []).map((p) =>
    p && (p.id === 'p1' || p.id === 'p10') ? { ...p, by: ['Sarah Kwan'] } : p);
  writeFileSync(join(dir, 'workbench.json'), JSON.stringify(skeleton));
}
const disk = () => readWorkspaceFile(join(dir, 'workbench.json'));

/* --------------------------------------------------------------- the server
   WB_DATA_KEY is cleared on purpose (the Phase 2 walkthrough's lesson:
   `verify:all` passes one down, and an inherited key seals the workspace). */
const srv = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
  env: { ...process.env, WB_DATA_KEY: '', WB_DATA_DIR: dir, PORT: String(PORT),
    HOST: '127.0.0.1', WB_TLS: '0', WB_ORIGINS: ORIGIN, WB_TEST_AI: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await claimPort(PORT);
let srvLog = '';
srv.stderr.on('data', d => { srvLog += d; });
srv.stdout.on('data', d => { srvLog += d; });
const bye = () => { try { srv.kill(); } catch { /* already gone */ } try { stub.close(); } catch { /* already gone */ } };
process.on('exit', bye);
process.on('SIGINT', () => { bye(); process.exit(1); });
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(ORIGIN + '/api/health')).ok) break; } catch { /* not yet */ }
  await wait(150);
}
if (!(await fetch(ORIGIN + '/api/health')).ok) {
  console.log('FAIL  the walkthrough server never answered'); process.exit(1);
}

/* --------------------------------------------------------------- sessions
   One browser session per person, each with its own cookie jar — the four
   people are four tabs, not one person switching hats. */
const pageErrors = [];
async function open(email) {
  const jar = { v: '' };
  const api = async (path, opts = {}) => {
    const res = await fetch(ORIGIN + path, {
      ...opts, redirect: 'manual', signal: AbortSignal.timeout(120000),
      headers: { ...(opts.headers || {}), Origin: ORIGIN, ...(jar.v ? { cookie: jar.v } : {}) }
    });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (sc.length) jar.v = sc.map(s => s.split(';')[0]).join('; ');
    return res;
  };
  const mk = () => {
    const vc = new VirtualConsole();
    vc.on('jsdomError', e => pageErrors.push(String(e.message)));
    const dom = new JSDOM(SOURCE, {
      url: ORIGIN + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
      beforeParse: (w) => {
        w.scrollTo = () => {};
        w.URL.createObjectURL = () => 'blob:stub';
        w.URL.revokeObjectURL = () => {};
        w.fetch = (u, o) => api(String(u).replace(ORIGIN, ''), o);
      }
    });
    return dom.window;
  };
  const win = mk();
  await wait(900);
  const doc = win.document;
  const e = doc.getElementById('lgE'), p = doc.getElementById('lgP');
  if (e && p) {
    e.value = email; p.value = PASSWORD;
    p.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await wait(1700);
  }
  const sess = {
    win, api, jar, who: email,
    get doc() { return sess.win.document; },
    $: (s) => sess.win.document.querySelector(s),
    $$: (s) => [...sess.win.document.querySelectorAll(s)],
    text: () => (sess.win.document.getElementById('page') || sess.win.document.body).textContent,
    click: async (el, ms = 340) => {
      if (!el) return false;
      el.dispatchEvent(new sess.win.MouseEvent('click', { bubbles: true }));
      await wait(ms); return true;
    },
    set: async (el, v) => {
      if (!el) return false;
      el.value = v;
      el.dispatchEvent(new sess.win.Event('input', { bubbles: true }));
      el.dispatchEvent(new sess.win.Event('change', { bubbles: true }));
      await wait(90); return true;
    },
    byText: (sel, t) => [...sess.win.document.querySelectorAll(sel)]
      .find(x => (x.textContent || '').includes(t)),
    eval: (code) => sess.win.eval(code),
  };
  return sess;
}
const revOf = async (s) => (await (await s.api('/api/data')).json()).rev;
const openCustomer = async (s, name, ms = 1000) => {
  await s.click(s.$('[data-go="customers"]'), 750);
  const card = s.$$('#page [data-open]').find(x => (x.textContent || '').includes(name));
  if (!card) return false;
  await s.click(card, ms);
  return s.text().includes(name);
};
const tabRe = (s, re) => [...s.doc.querySelectorAll('[data-tab]')].find(b => re.test(b.textContent || ''));
const waitFor = async (fn, ms = 12000) => {
  for (let i = 0; i < Math.floor(ms / 300); i++) { await wait(300); if (fn()) return true; }
  return false;
};
const lastPrompt = (needle) => seen.prompts.slice().reverse().find(p => needle.test(p)) || '';

/* =============================================================== ACT 1 ===
   Admin — Teh Bin Shun. He connects the model (the config door is his),
   asks §31 Test 9's own question, and then walks into the confidential
   wall that holds even for the person holding the keys. */
{
  const s = await open('tehbinshun@global.tencent.com');
  const R = 'Admin — Teh Bin Shun';
  note('works', R, 'sign-in', 'The administrator signs in and lands on the Today screen.',
    s.$('#nav') ? 'nav present' : 'no nav — cannot continue');
  if (!s.$('#nav')) { console.log(srvLog.slice(-600)); process.exit(1); }

  /* The endpoint is connected the way an administrator connects it: after
     sign-in, through the admin's own config door. */
  const cfg = await (await s.api('/api/ai/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: STUB, model: 'waypoint-test-model', key: 'sk-walk3-key' }),
  })).json();
  note('works', R, 'Admin · AI connection', 'The model endpoint is connected by the administrator, through the admin-only config door.',
    cfg.ok === true ? 'connected' : JSON.stringify(cfg).slice(0, 80));
  /* The admin signed in before the endpoint existed, and boot reads the AI
     state once — this session has to be told, the way the product's own
     admin screen tells it after a save. */
  await s.eval('refreshAi()');
  await wait(300);

  /* ---- Test 9: "Give me an overview of the current business pipeline." ----
     §31: admin receives useful business intelligence based on accessible
     data. The walkthrough checks both halves: the pipeline facts reached
     the model, and the answer landed with a door into the account. */
  stubScript.push(JSON.stringify({ kind: 'global', entities: [] }));
  stubScript.push('Two accounts are in play. The CFO-blocked migration at NusaTel Berhad is the largest open deal; the Perak factory automation at Rengit Engineering is early stage.');
  const revA = await revOf(s);
  await s.eval('openPal()');
  await s.set(s.$('#palI'), 'What does the current business pipeline look like?');
  s.$('#palI').dispatchEvent(new s.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const palA = () => (s.$('#palA') || { textContent: '' }).textContent;
  const landed9 = await waitFor(() => /CFO-blocked migration/.test(palA()), 16000);
  const p9 = lastPrompt(/Pipeline by stage:/);
  const door9 = s.$('#palA a[data-open="c1"]');
  const revA2 = await revOf(s);
  const ok9 = landed9 && /Pipeline by stage:/.test(p9)
    && /The CFO has not released the budget line/.test(p9)
    && /Open opportunities with an unresolved blocker:/.test(p9)
    && !!door9 && /NusaTel Berhad/.test((door9 || {}).textContent || '');
  note(ok9 ? 'works' : 'gap', R, 'Palette · Test 9',
    'Test 9 — "Give me an overview of the current business pipeline": the overview is built from the pipeline facts and lands with a door into the account.',
    ok9 ? 'prompt carried the stage board and the recorded blocker; answer landed in the palette' : 'asked, but ' + (landed9 ? 'the facts or the door did not arrive' : 'no answer landed'));
  const ok9ro = revA2 === revA;
  note(ok9ro ? 'works' : 'gap', R, 'Palette · Test 9 (read-only)',
    'A pipeline overview is a read: the book\'s revision did not move.',
    'rev ' + revA + ' -> ' + revA2);
  await s.eval('closePal()');

  /* ---- Test 8, the admin's side: the wall holds for the keys' holder. ----
     §31: AI must not reveal that customer's information. The server side
     (scope 404 / confidential 403 / zero model calls) is asserted by
     verify-copilot-scope; what a person can verify is the UI face — the
     confidential account is fully readable on screen, and the AI doors on
     it are simply not there. */
  const opened3 = await openCustomer(s, 'Gamma Defence Systems');
  /* The ask button is offered like on any other account — the screen does
     not pretend the account is less readable than it is. The wall is the
     server's: the press is refused, in words, and the stand-in's transcript
     never sees the name at all. */
  const door3 = s.$('#custBrief-c3 [data-tb]');
  await s.click(door3, 500);
  const refText3 = () => (s.$('#custBrief-c3') || { textContent: '' }).textContent;
  const refused3 = await waitFor(() => /never sent to a model/.test(refText3()), 6000);
  const leaked3 = seen.prompts.some(p => /Gamma Defence/.test(p));
  const ok8a = opened3 && !!door3 && refused3 && !leaked3
    && /Submarine combat system refresh is classified/.test(s.text());
  note(ok8a ? 'works' : 'gap', R, 'Customer · Gamma Defence (Test 8)',
    'Test 8, admin side — the confidential account is fully readable on screen and its ask button is offered like any other account; the press is refused by the server, in words ("never sent to a model"), and the model never heard the name.',
    ok8a ? 'refused in place; the transcript holds no Gamma Defence' : 'opened=' + opened3 + ' door=' + !!door3 + ' refused=' + refused3 + ' leaked=' + leaked3);
}

/* =============================================================== ACT 2 ===
   Primary BD — Jason Lim. He owns NusaTel Berhad, and walks the heart of
   §31: Tests 1, 2, 3, 4, 5, then both faces of Test 8, then the
   processing experience (11) and the duplicate guard (12). */
{
  const s = await open('jasonlim@global.tencent.com');
  const R = 'Primary BD — Jason Lim';
  note('works', R, 'sign-in', 'The Primary BD signs in; his book holds NusaTel Berhad (owner) and Gamma Defence Systems (owner, confidential).',
    s.$('#nav') ? 'nav present' : 'no nav — cannot continue');
  if (!s.$('#nav')) { console.log(srvLog.slice(-600)); process.exit(1); }

  /* ---- Test 1: "What should I focus on this week?" ---- */
  stubScript.push(JSON.stringify({ items: [{ n: 1, action: 'Send the sizing sheet and book the review call.' }] }));
  await s.click(s.$('[data-go="today"]'), 400);
  await s.click(s.$('#focusWeek [data-tb]'), 300);
  const fw = () => s.$('#focusWeek');
  const fwText = () => (fw() ? fw().textContent : '');
  const t1 = await waitFor(() => /Suggested action/.test(fwText()));
  const p1 = lastPrompt(/What should I focus on this week/);
  const ok1 = t1 && /Next step overdue: "Send the sizing sheet before Friday"/.test(p1)
    && /NusaTel Berhad/.test(p1)
    && /Send the sizing sheet before Friday/.test(fwText())
    && /days past the date set/.test(fwText())
    && !!fw().querySelector('[data-open="c1"]');
  note(ok1 ? 'works' : 'gap', R, 'Today · Test 1',
    'Test 1 — "What should I focus on this week?": the week is read from the BD\'s own book — the overdue step\'s own words reached the model, and the suggestion lands as a row that opens the account.',
    ok1 ? 'prompt carried the overdue step and the customer; the row is a door' : 'asked, but ' + (t1 ? 'the book did not reach the model or the row is not a door' : 'no answer landed'));

  /* ---- Test 2: "Give me a quick briefing and tell me what needs attention." ---- */
  stubScript.push(JSON.stringify({
    brief: 'Mid-programme on the billing migration; the Exadata renewal is the forcing event.',
    attention: 'The renewal quote came back 40% higher and the sizing sheet is still unsent.',
  }));
  const opened2 = await openCustomer(s, 'NusaTel Berhad');
  await s.click(s.$('#custBrief-c1 [data-tb]'), 300);
  const br = () => s.$('#custBrief-c1');
  const brText = () => (br() ? br().textContent : '');
  const t2 = await waitFor(() => /forcing event/.test(brText()));
  const p2 = lastPrompt(/NusaTel Berhad/);
  const cite2 = br() && [...br().querySelectorAll('.tag')]
    .some(t => /The records this answer was built on/.test(t.getAttribute('title') || ''));
  const ok2 = t2 && opened2 && /NusaTel Berhad — Telecom — HQ Kuala Lumpur/.test(p2)
    && /Group CTO/.test(p2) && /Decision maker/.test(p2)
    && /Billing runs on Exadata/.test(p2) && /renewal quote came back 40% higher/.test(p2)
    && /Needs attention/.test(brText()) && /From your records/.test(brText())
    && /Key people/.test(brText()) && /Active opportunities/.test(brText()) && cite2;
  note(ok2 ? 'works' : 'gap', R, 'Customer · NusaTel Berhad · Test 2',
    'Test 2 — "Give me a quick briefing and tell me what needs attention": the briefing is built from the customer\'s own record, and the answer names the records it leaned on.',
    ok2 ? 'name, industry, decision maker and the account\'s own pain all reached the model; citations render' : 'asked, but the record or the citations did not arrive in full');

  /* ---- Test 3: "What are the current risks and what should I do next?" ---- */
  stubScript.push(JSON.stringify({
    risks: [
      { what: 'The deal has no close date.', why: 'The record carries no close date at all.', kind: 'validate' },
      { what: 'The CFO budget line is unresolved.', why: 'The recorded blocker names the CFO.', kind: 'follow-up' },
    ],
    moves: [{ what: 'Send the wave-1 plan with the new quote attached', why: 'The blocker is the budget line, so the plan needs the number on it.', kind: 'proposal' }],
    gaps: ['No close date recorded.'],
    prepare: [],
  }));
  await s.click(tabRe(s, /opportunities/i), 400);
  await s.click(s.$('#analyzeOpp-o1 [data-tb]'), 300);
  const an = () => s.$('#analyzeOpp-o1');
  const anText = () => (an() ? an().textContent : '');
  const t3 = await waitFor(() => /Suggested moves|What the records flag/.test(anText()));
  const p3 = lastPrompt(/phased migration of the billing stack/);
  const ok3 = t3 && /phased migration of the billing stack off Exadata/.test(p3)
    && /with Dr Amir Rashid/.test(p3)
    && /Send the sizing sheet before Friday/.test(p3)
    && /The CFO has not released the budget line/.test(p3)
    && /The CFO budget line is unresolved\./.test(anText())
    && /why: The recorded blocker names the CFO\./.test(anText())
    && /Send the wave-1 plan/.test(anText());
  note(ok3 ? 'works' : 'gap', R, 'Opportunity · Cloud migration platform deal · Test 3',
    'Test 3 — "What are the current risks and what should I do next?": the analysis is fed the deal, the meeting and the step, and every risk on screen explains itself.',
    ok3 ? 'three sources reached the model (deal description, meeting attendee, step title); risks render with their why' : 'asked, but a source did not reach the model or a risk lost its why');

  /* ---- Test 4: MOM — extract, review, select, create, verify relationships ---- */
  stubScript.push(JSON.stringify({
    summary: 'They walked the renewal timeline and agreed a phased approach.',
    outcome: 'Wave 1 will be read-only billing by November.',
    concerns: ['Renewal quote up 40%'],
    requirements: ['Read-only billing view by November'],
    decisions: ['Phased cutover, wave 1 read-only'],
    commitments: ['Their CTO sends the contract end date in writing'],
    steps: [
      { t: 'Send the wave-1 plan to their billing lead', from: 'us', due: '2026-10-01', kind: 'proposal', exec: 'Farah Lim', opp: 'Cloud migration platform deal' },
      { t: 'Get the contract end date in writing', from: 'customer', due: '', kind: 'follow-up', exec: 'Dr Amir Rashid', opp: '' },
    ],
    opps: [{ t: 'Disaster recovery for the billing stack', why: 'Their CTO asked what happens if the primary region fails.' }],
    pains: ['Nightly billing batch overruns its window'],
  }));
  await s.click(s.$('[data-go="interactions"]'), 400);
  await s.click(s.$('[data-act="mom"][data-mid="m1"]'), 400);
  await s.set(s.$('#momT'),
    'Attended: Dr Amir Rashid. The nightly billing batch keeps overrunning its window. The renewal timeline was walked through; '
    + 'the quote is up 40%. We agreed a phased approach: wave 1 read-only billing by November. Their CTO will send the contract '
    + 'end date in writing. He also asked what happens if the primary region fails. We will send the wave-1 plan to their billing lead.');
  await s.click(s.$('#momGo'), 600);
  const sheet = () => s.$('#capBody');
  const stext = () => (sheet() ? sheet().textContent : '');
  const t4 = await waitFor(() => /Suggested next steps/.test(stext()));
  const ok4a = t4 && /Customer concerns/.test(stext()) && /Requirements/.test(stext()) && /Decisions/.test(stext())
    && /Commitments/.test(stext()) && /Suggested next steps/.test(stext())
    && /Potential opportunities/.test(stext()) && /Pain points/.test(stext())
    && !!sheet().querySelector('[data-mchk="0"]') && (sheet().querySelector('[data-mchk="0"]') || {}).checked === true;
  note(ok4a ? 'works' : 'gap', R, 'MOM · Billing migration workshop · Test 4 (the reading)',
    'Test 4, first half — AI extracts the five kinds; every tick starts on, because the reader\'s job is to drop what is not true, not to hunt for what is.',
    ok4a ? 'all five zones render, both steps pre-ticked' : 'the reading did not land complete');

  const revT4 = await revOf(s);
  await s.click(s.$('#momCreate'), 700);
  let stepRows = null, stepAudit = null;
  for (let i = 0; i < 20 && !(stepRows && stepRows.length === 2); i++) {
    await wait(300);
    stepRows = (disk().steps || []).filter(r => r.c === 'c1'
      && (/Send the wave-1 plan/.test(r.t) || /Get the contract end date/.test(r.t)));
    if (stepRows && stepRows.length === 2) stepAudit = (disk().audit || []).find(a => a.what === 'Actions from minutes'
      && /2 next step/.test(a.rec || '') && /accepted from the minutes/.test(a.to || ''));
  }
  const tied = stepRows && stepRows.find(r => /Send the wave-1 plan/.test(r.t));
  const tl = stepRows && (disk().customers.find(c => c.id === 'c1').timeline || [])
    .find(t => /Send the wave-1 plan/.test(t.t || ''));
  const ok4b = !!stepRows && stepRows.length === 2 && !!stepAudit && !!tied
    && tied.o === 'o1' && tied.track === 'Jason Lim' && tied.kind === 'proposal' && !!tl;
  note(ok4b ? 'works' : 'gap', R, 'MOM · Test 4 (the confirm)',
    'Test 4, second half — the BD selects action items and presses Create: the steps land through the hand-typed path, tied to the customer, the deal and the tracker the minutes named.',
    ok4b ? 'rows on disk: o=o1, track=Jason Lim, kind=proposal, timeline line, audit "Actions from minutes"'
      : 'steps ' + (stepRows || []).length + '/2, tied=' + JSON.stringify(tied || {}).slice(0, 90));

  await s.click(s.$('#momPains'), 700);
  let painLanded = false, painAudit = null;
  for (let i = 0; i < 20 && !painLanded; i++) {
    await wait(300);
    const c1row = (disk().customers || []).find(c => c.id === 'c1') || {};
    if ((c1row.pains || []).includes('Nightly billing batch overruns its window')) {
      painLanded = true;
      painAudit = (disk().audit || []).find(a => a.what === 'Pain points from minutes' && /1 pain point/.test(a.rec || ''));
    }
  }
  const ok4c = painLanded && !!painAudit;
  note(ok4c ? 'works' : 'gap', R, 'MOM · Test 4 (the pains)',
    'The ticked pain lands on the account, in the customer\'s own words, with an audit line that says where it came from.',
    ok4c ? 'c.pains + audit "Pain points from minutes"' : 'pain never landed');

  const revT4b = await revOf(s);
  const ok4d = typeof revT4b === 'number' && revT4b > revT4;
  note(ok4d ? 'works' : 'gap', R, 'MOM · Test 4 (who moved the book)',
    'The reading itself moved nothing — only the confirm presses wrote, and the book\'s revision is the referee.',
    'rev ' + revT4 + ' -> ' + revT4b);

  /* ---- Test 5: opportunity discovery — evidence, why, no auto-create ---- */
  const oppCount = () => Object.keys(disk().opps || {}).length;
  const before5 = oppCount();
  const ok5a = /Disaster recovery for the billing stack/.test(stext())
    && /Why this may be an opportunity/.test(stext())
    && /the customer has not confirmed this demand/.test(stext())
    && oppCount() === before5;
  note(ok5a ? 'works' : 'gap', R, 'MOM · Test 5 (the hint)',
    'Test 5 — the hinted opportunity shows its evidence and its why, says plainly the customer has not confirmed the demand, and writes nothing: ' + oppCount() + ' opportunities before and after.',
    ok5a ? 'evidence + caveat render, zero writes' : 'opps ' + oppCount() + '/' + before5);
  await s.click(sheet().querySelector('[data-mopp="0"]'), 400);
  const ocText = s.$('#ocText');
  const ok5b = !!ocText && ocText.value === 'Disaster recovery for the billing stack'
    && /Their CTO asked what happens if the primary region fails/.test((s.$('#ocDesc') || {}).value || '')
    && oppCount() === before5;
  note(ok5b ? 'works' : 'gap', R, 'MOM · Test 5 (the confirm sheet)',
    'Create opens the ordinary confirm sheet with the evidence pre-filled — the hint walks the same door a hand-typed opportunity walks, and until the press nothing exists.',
    ok5b ? 'title and description pre-filled, still zero writes' : 'the sheet did not pre-fill');
  await s.click(s.$('#ocCreate'), 700);
  let diskOpp = null, arow5 = null;
  for (let i = 0; i < 20 && !diskOpp; i++) {
    await wait(300);
    diskOpp = Object.values(disk().opps || {}).find(o => o.t === 'Disaster recovery for the billing stack');
    if (diskOpp) arow5 = (disk().audit || []).find(a => a.what === 'Opportunity created'
      && /Disaster recovery/.test(a.rec || '') && /accepted from the minutes/.test(a.to || ''));
  }
  const c1opps5 = (disk().customers.find(c => c.id === 'c1').opps || []);
  const ok5c = !!diskOpp && diskOpp.c === 'c1' && diskOpp.stage === 'Interested'
    && c1opps5.includes(diskOpp.id) && !!arow5
    && /the customer has not confirmed this demand/.test(diskOpp.desc || '');
  note(ok5c ? 'works' : 'gap', R, 'MOM · Test 5 (the real record)',
    'The confirmed hint becomes a real opportunity on the account, with its caveat riding inside the description and the audit telling the truth about where it came from.',
    ok5c ? 'stage=Interested, linked to c1, caveat in desc, audit "accepted from the minutes"' : diskOpp ? 'landed but incomplete' : 'never created');
  await s.eval('closeCapture()');

  /* ---- Test 8, the BD's two faces: absent, and confidential ---- */
  await s.click(s.$('[data-go="customers"]'), 750);
  const seesRengit = s.$$('#page [data-open]').some(x => (x.textContent || '').includes('Rengit Engineering'));
  note(!seesRengit ? 'works' : 'gap', R, 'Customers · Test 8 (not his)',
    'Test 8, first face — a customer the BD cannot access is not in his book at all: there is nothing to ask about, because there is nothing to see. (The server side — asking anyway returns 404 without a model call — is asserted by verify-copilot-scope.)',
    seesRengit ? 'LEAKED: the account rendered' : 'Rengit Engineering is absent from his list');
  const opened3bd = await openCustomer(s, 'Gamma Defence Systems');
  const door3bd = s.$('#custBrief-c3 [data-tb]');
  await s.click(door3bd, 500);
  const refText3bd = () => (s.$('#custBrief-c3') || { textContent: '' }).textContent;
  const refused3bd = await waitFor(() => /never sent to a model/.test(refText3bd()), 6000);
  const leaked3bd = seen.prompts.some(p => /Gamma Defence/.test(p));
  const ok8bd = opened3bd && !!door3bd && refused3bd && !leaked3bd;
  note(ok8bd ? 'works' : 'gap', R, 'Customer · Gamma Defence (Test 8, confidential)',
    'Test 8, second face — the confidential account IS his: it renders with its pains, the ask button is offered, and the press is refused by the server anyway. Confidentiality governs what may be sent to a model, not what the owner may read.',
    ok8bd ? 'refused in place; the transcript holds no Gamma Defence' : 'opened=' + opened3bd + ' door=' + !!door3bd + ' refused=' + refused3bd + ' leaked=' + leaked3bd);

  /* ---- Test 11: the processing state, walked as a person walks it ---- */
  stubScript.push({ reply: JSON.stringify({
    risks: [{ what: 'The renewal window is closing.', why: 'The blocker has sat unresolved for ten days.', kind: 'follow-up' }],
    moves: [{ what: 'Re-run the pricing model with the revised quote attached', why: 'The blocker is the budget line, so the plan needs the number on it.', kind: 'proposal' }],
    gaps: [], prepare: [],
  }), delay: 2500 });
  await openCustomer(s, 'NusaTel Berhad');
  await s.click(tabRe(s, /opportunities/i), 400);
  const anBtn = () => s.$('#analyzeOpp-o1 [data-tb], #analyzeOpp-o1 [data-tb-again]');
  await s.click(anBtn(), 300);
  const workingShown = await waitFor(() => /Working|Asking the model/.test(anText()), 4000);
  note(workingShown ? 'works' : 'gap', R, 'Opportunity · Test 11 (it says it is working)',
    'Test 11 — a slow model is started, and the processing state appears immediately: the box says the system is working, and the person does not need to refresh.',
    workingShown ? 'the Working state showed on the ask box' : 'no working state appeared');
  await s.click(s.$('[data-go="customers"]'), 500);   /* walk away */
  await wait(3200);                                    /* the slow model lands while away */
  const openedBack = await openCustomer(s, 'NusaTel Berhad');
  await s.click(tabRe(s, /opportunities/i), 400);
  const result11 = await waitFor(() => /Re-run the pricing model/.test(anText()), 6000);
  note(result11 ? 'works' : 'gap', R, 'Opportunity · Test 11 (walked away, came back)',
    'The BD navigated away mid-ask, came back, and the finished result was preserved on the record — no refresh, no lost ask. (opened=' + openedBack + ')',
    result11 ? 'the answer was waiting where the ask was made' : 'the result was not there on return');
  await s.click(s.$('[data-go="aitasks"]'), 500);
  const tasksText = () => (s.$('#aiTasksBody') || { textContent: '' }).textContent;
  const center11 = await waitFor(() => tasksText().length > 0, 6000);
  const ok11c = center11 && /Opportunity analysis/.test(tasksText()) && /NusaTel Berhad/.test(tasksText())
    && /done /.test(tasksText()) && !/Working|Queued/.test(tasksText());
  note(ok11c ? 'works' : 'gap', R, 'AI Tasks · Test 11 (the center)',
    'The AI Tasks screen answers §23\'s one question — "is my request still running, and is the result ready?" — for this finished ask: labelled, named, done, with its summary and where the result lives.',
    ok11c ? 'Finished zone: label, record, done time, summary' : tasksText().slice(0, 90));

  /* ---- Test 12: duplicate protection, both faces ---- */
  stubScript.push({ reply: JSON.stringify({
    risks: [{ what: 'The wave-1 plan is still unsent.', why: 'The step is four days overdue.', kind: 'follow-up' }],
    moves: [{ what: 'Attach the sizing sheet to the wave-1 plan and send both', why: 'The blocker is the budget line, so the plan needs the number on it.', kind: 'proposal' }],
    gaps: [], prepare: [],
  }), delay: 2500 });
  await openCustomer(s, 'NusaTel Berhad');
  await s.click(tabRe(s, /opportunities/i), 400);
  const reqBefore = seen.requests;
  await s.click(anBtn(), 300);                       /* start Analyze Opportunity X */
  const working12 = await waitFor(() => /Working|Asking the model/.test(anText()), 4000);
  const noSecondDoor = working12 && !s.$('#analyzeOpp-o1 [data-tb]') && !s.$('#analyzeOpp-o1 [data-tb-again]');
  note(noSecondDoor ? 'works' : 'gap', R, 'Opportunity · Test 12 (UI face)',
    'Test 12 — while the analysis is processing, the ask box shows the working state and offers no second start button: a person cannot submit the duplicate from the screen.',
    noSecondDoor ? 'no ask button while processing' : 'a start button remained during processing');
  /* The protocol face: the same ask, posted again while the first runs,
     returns the SAME task — not a second AI request. */
  const again = await (await s.api('/api/ai/copilot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'analyze-opp', targetId: 'o1' }),
  })).json();
  const running = (await (await s.api('/api/ai/tasks?since=0')).json());
  const mine = (running.tasks || []).filter(t => t.action === 'analyze-opp' && t.targetId === 'o1'
    && (t.state === 'queued' || t.state === 'processing'));
  const sameId = again && again.task && mine.some(t => t.id === again.task.id);
  const reused = again && again.reused === true;
  note(sameId && reused ? 'works' : 'gap', R, 'Opportunity · Test 12 (protocol face)',
    'The same ask posted again while the first is still processing returns the existing task and creates nothing — the duplicate is prevented at the server, not just hidden in the UI.',
    sameId && reused ? 'same taskId handed back, reused=true' : 'again=' + JSON.stringify(again).slice(0, 90) + ' running=' + mine.length);
  const done12 = await waitFor(() => /Attach the sizing sheet/.test(anText()), 12000);
  const reqDelta = seen.requests - reqBefore;
  note(done12 && reqDelta === 1 ? 'works' : 'gap', R, 'Opportunity · Test 12 (the model\'s bill)',
    'The stand-in\'s transcript is the referee: the whole Test 12 walk — start, re-ask, wait — produced exactly one AI request.',
    'model requests: ' + reqBefore + ' -> ' + seen.requests + (done12 ? '' : '; the answer never landed'));
}

/* =============================================================== ACT 3 ===
   Primary SA — Priya Nair. The same account from the machines' side: the
   same briefing from the same book (Test 2), the product question against
   the real Product Reference (Test 6), and a paste of hallway notes that
   never became a meeting. */
{
  const s = await open('priyanair@global.tencent.com');
  const R = 'Primary SA — Priya Nair';
  note('works', R, 'sign-in', 'The Primary SA signs in; the same account NusaTel Berhad is in her book — one record, two people.',
    s.$('#nav') ? 'nav present' : 'no nav — cannot continue');
  if (!s.$('#nav')) { console.log(srvLog.slice(-600)); process.exit(1); }

  /* ---- Test 2, the SA's side: the same book ---- */
  stubScript.push(JSON.stringify({
    brief: 'The migration is at wave-1 scoping; their engineers want a read-only billing view first.',
    attention: 'Only one engineer still understands the ledger export, and the sizing sheet is unsent.',
  }));
  const opened = await openCustomer(s, 'NusaTel Berhad');
  await s.click(s.$('#custBrief-c1 [data-tb]'), 300);
  const brS = () => (s.$('#custBrief-c1') || { textContent: '' }).textContent;
  const t2s = await waitFor(() => /wave-1 scoping/.test(brS()));
  const p2s = lastPrompt(/NusaTel Berhad/);
  const ok2s = t2s && opened && /NusaTel Berhad — Telecom — HQ Kuala Lumpur/.test(p2s)
    && /Dr Amir Rashid/.test(p2s) && /Billing runs on Exadata/.test(p2s);
  note(ok2s ? 'works' : 'gap', R, 'Customer · NusaTel Berhad · Test 2 (the SA\'s side)',
    'Test 2, the SA\'s half — the SA asks for the same briefing and the model is fed the same record the BD\'s ask was fed: one account, one book, two readers.',
    ok2s ? 'the customer\'s own record reached the model for the SA too' : 'the record did not reach the model in full');

  /* ---- Test 6: "Which Tencent Cloud products may be relevant?" ---- */
  stubScript.push(JSON.stringify({
    products: [
      { p: 'Cloud Virtual Machine', why: 'The billing migration needs elastic compute for the new platform.', support: 'The deal migrates the billing stack.', sa: 'Sarah Kwan' },
      { p: 'Quantum Blockchain Fabric', why: 'A name the Reference does not hold.', support: 'nothing real', sa: 'Ghost Person' },
    ],
  }));
  await s.click(tabRe(s, /opportunities/i), 400);
  await s.click(s.$('#suggestProducts-o1 [data-tb]'), 300);
  const pr = () => s.$('#suggestProducts-o1');
  const prText = () => (pr() ? pr().textContent : '');
  const t6 = await waitFor(() => /Products the Reference can support/.test(prText()));
  const p6 = lastPrompt(/Product Reference/);
  const ok6a = t6 && /The Product Reference — the only products you may name/.test(p6)
    && /Cloud Virtual Machine \(Compute\) — Elastic cloud servers/.test(p6)
    && /Product SA: Sarah Kwan/.test(p6)
    && /phased migration of the billing stack/.test(p6);
  note(ok6a ? 'works' : 'gap', R, 'Opportunity · Test 6 (asked against the Reference)',
    'Test 6 — "Which Tencent Cloud products may be relevant?": the ask is made against the Product Reference, and only against it — the catalogue\'s own rows and its own SA spellings are what the model is given.',
    ok6a ? 'the Reference\'s row and "Product SA: Sarah Kwan" reached the model' : 'the Reference did not reach the model in full');
  const ok6b = t6 && /Cloud Virtual Machine/.test(prText()) && !/Quantum Blockchain Fabric/.test(prText())
    && !/Ghost Person/.test(prText())
    && /Elastic cloud servers - the baseline everything else sits on\./.test(prText())
    && /SA · Sarah Kwan/.test(prText())
    && /why: The billing migration needs elastic compute/.test(prText());
  note(ok6b ? 'works' : 'gap', R, 'Opportunity · Test 6 (only the Reference survives)',
    'A product the Reference does not hold, and an SA it never spelled, are dropped from the answer — the recommendation is explainable because every line of it came from the catalogue.',
    ok6b ? 'the invented name and person are gone; the real one-liner and SA render' : 'something the Reference does not hold survived');

  /* ---- A paste of notes that never was a meeting (§14) ---- */
  stubScript.push(JSON.stringify({
    summary: 'A hallway conversation about their billing pains.',
    outcome: 'Nothing was agreed - they asked for a follow-up.',
    concerns: [], requirements: [], decisions: [], commitments: [],
    steps: [{ t: 'Send the billing migration one-pager', from: 'us', due: '', kind: 'proposal', exec: '', opp: '' }],
    opps: [],
    pains: ['Nightly billing batch overruns its window', 'Only one engineer understands the ledger export'],
  }));
  await s.click(tabRe(s, /brief/i), 400);
  const notesBtn = s.$('[data-act="notes"][data-cid="c1"]');
  await s.click(notesBtn, 400);
  const ntext = () => (s.$('#capBody') ? s.$('#capBody').textContent : '');
  await s.set(s.$('#momT'),
    'Hallway chat with their billing lead after the platform review. The nightly billing batch keeps overrunning its window '
    + 'and only one engineer still understands the ledger export. They asked us to send the migration one-pager before any meeting.');
  await s.click(s.$('#momGo'), 600);
  const readN = await waitFor(() => /I found 1 possible action item, 2 pain points/.test(ntext()));
  const okN1 = readN && !!s.$('[data-pchk="0"]') && (s.$('[data-pchk="0"]') || {}).checked === true
    && /No meeting to save a summary into/.test(ntext());
  note(okN1 ? 'works' : 'gap', R, 'Customer · paste notes (§14)',
    'The SA pastes hallway notes — not a meeting, no date, no attendees — and the reading counts what it found, starts every tick on, and offers no "save to the interaction" that could write nowhere.',
    okN1 ? '"I found 1 possible action item, 2 pain points"; no phantom save button' : ntext().slice(0, 90));
  await s.click(s.$('#momPains'), 700);
  let painN = null;
  for (let i = 0; i < 20 && !painN; i++) {
    await wait(300);
    const c1n = (disk().customers || []).find(c => c.id === 'c1') || {};
    if ((c1n.pains || []).includes('Only one engineer understands the ledger export')) {
      painN = (disk().audit || []).find(a => a.what === 'Pain points from notes' && /accepted from pasted notes/.test(a.to || ''));
    }
  }
  await s.click(s.$('#momCreate'), 700);
  let stepN = null;
  for (let i = 0; i < 20 && !stepN; i++) {
    await wait(300);
    const row = (disk().steps || []).find(r => r.c === 'c1' && /Send the billing migration one-pager/.test(r.t || ''));
    if (row) stepN = (disk().audit || []).find(a => a.what === 'Actions from notes' && /accepted from pasted notes/.test(a.to || ''));
  }
  const okN2 = !!painN && !!stepN;
  note(okN2 ? 'works' : 'gap', R, 'Customer · paste notes (the confirm)',
    'The ticked pains and the accepted action reach the record through one press each, and the audit says "from pasted notes" — the paste became book only where a person said so.',
    okN2 ? 'pains + step on disk, audit lines say notes' : 'painAudit=' + !!painN + ' stepAudit=' + !!stepN);
  await s.eval('closeCapture()');
}

/* =============================================================== ACT 4 ===
   Manager — Tan Wei Ming. The whole book, and not one pen: the pipeline
   question (Test 10), the write doors that are not there, and the
   deterministic question the model never hears (Test 7). */
{
  const s = await open('tanweiming@global.tencent.com');
  const R = 'Manager — Tan Wei Ming';
  note('works', R, 'sign-in', 'The Manager signs in; his book is the whole book, and his pen is none.',
    s.$('#nav') ? 'nav present' : 'no nav — cannot continue');
  if (!s.$('#nav')) { console.log(srvLog.slice(-600)); process.exit(1); }

  /* ---- Test 10: BI visible, strictly read-only ---- */
  stubScript.push(JSON.stringify({ kind: 'global', entities: [] }));
  stubScript.push('Two accounts are in play. The CFO-blocked migration at NusaTel Berhad is the largest open deal; the Perak factory automation at Rengit Engineering is early stage.');
  const revD = await revOf(s);
  await s.eval('openPal()');
  await s.set(s.$('#palI'), 'What does the current business pipeline look like?');
  s.$('#palI').dispatchEvent(new s.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const palM = () => (s.$('#palA') || { textContent: '' }).textContent;
  const landed10 = await waitFor(() => /CFO-blocked migration/.test(palM()), 16000);
  const p10 = lastPrompt(/Pipeline by stage:/);
  const revD2 = await revOf(s);
  const ok10 = landed10 && /Pipeline by stage:/.test(p10) && /The CFO has not released the budget line/.test(p10)
    && revD2 === revD;
  note(ok10 ? 'works' : 'gap', R, 'Palette · Test 10 (sees)',
    'Test 10 — the Manager asks for business intelligence and receives it, built on the pipeline facts his role may see (the whole book).',
    ok10 ? 'prompt carried the stage board; answer landed' : 'asked, but ' + (landed10 ? 'the facts did not arrive' : 'no answer landed'));
  note(revD2 === revD ? 'works' : 'gap', R, 'Palette · Test 10 (cannot write)',
    'The overview is a read: the book\'s revision did not move, and the Manager stays strictly read-only where AI is concerned.',
    'rev ' + revD + ' -> ' + revD2);
  await s.eval('closePal()');

  /* The write doors are simply not drawn for him — on the customers list
     and inside an account. (The server's refusal of a manager write is
     asserted by verify-roles; a person can only verify that the door is
     not even offered.) */
  await s.click(s.$('[data-go="customers"]'), 750);
  const noNewCust = !s.$('[data-act="newCust"]');
  const openedM = await openCustomer(s, 'NusaTel Berhad');
  const noAnalyze = !s.$('#analyzeOpp-o1');
  const noPasteDoor = !s.$('[data-act="notes"][data-cid="c1"]');
  note(noNewCust && openedM && noAnalyze && noPasteDoor ? 'works' : 'gap', R, 'Customer · Test 10 (the doors)',
    'Inside the account, the write doors are not drawn for the Manager — no new-customer button on the list, no opportunity analysis, no paste door. He sees the book; the pens are not offered.',
    'newCust=' + !noNewCust + ' analyze=' + !noAnalyze + ' paste=' + !noPasteDoor);

  /* ---- Test 7: the deterministic question, zero AI ---- */
  await s.click(s.$('[data-go="today"]'), 400);
  const req7 = seen.requests;
  await s.eval('openPal()');
  await s.set(s.$('#palI'), 'Which of my Opportunities have no recent follow-up?');
  s.$('#palI').dispatchEvent(new s.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const pal7 = () => (s.$('#palA') || { textContent: '' }).textContent;
  const rule7 = await waitFor(() => /Perak factory automation/.test(pal7()), 9000);
  const ok7 = rule7 && /no interaction ever recorded/.test(pal7())
    && seen.requests === req7;
  note(ok7 ? 'works' : 'gap', R, 'Palette · Test 7',
    'Test 7 — "Which of my Opportunities have no recent follow-up?": normal business logic answers it — the deal with no interaction ever recorded is named, with its citations, and the model was never asked.',
    ok7 ? 'answered from the book; model requests ' + req7 + ' -> ' + seen.requests
      : (seen.requests === req7 ? 'answered, but the no-interaction deal was not named' : 'THE MODEL WAS ASKED: ' + req7 + ' -> ' + seen.requests));
  await s.eval('closePal()');
}

/* ------------------------------------------------------------ the verdict
   The unplanned hops are the script's own honesty check: an ask nobody
   scripted means the plan and the product disagreed about something. */
if (unplanned.length) {
  note('friction', 'the walk itself', 'stand-in',
    'The stand-in was asked ' + unplanned.length + ' time(s) it had not been scripted for — the plan and the product disagreed about an ask, and the product failed that task honestly.',
    unplanned.join(' | ').slice(0, 200));
} else {
  note('works', 'the walk itself', 'stand-in',
    'Every model call the four people triggered was one this walk had planned and could read back — no ask went unexamined.',
    'model requests total: ' + seen.requests);
}

/* ------------------------------------------------------------ the document */
const KINDS = ['works', 'promise', 'friction', 'gap'];
const head = {
  works: 'Where the promise was kept',
  promise: 'Promises the product makes out loud',
  friction: 'Where a real person slows down',
  gap: 'Where the product does not do what it claims',
};
const esc = (s) => String(s || '').replace(/\|/g, '\\|');
const lines = [];
lines.push('# §31 — The Twelve Acceptance Tests, Walked as Four People: what they found');
lines.push('');
lines.push('> Walked on ' + now.slice(0, 10) + ' against the shipped `Waypoint-v1.html`, driven through four real');
lines.push('> browser sessions (jsdom) at one real server, on an isolated workspace over the real');
lines.push('> Product Reference. The model is a scripted stand-in, so nothing here measures whether');
lines.push('> a model was clever — it measures the plumbing §31/§33 demand: the prompt carried the');
lines.push('> person\'s own records, the screen showed what came back, and nothing reached the book');
lines.push('> except through a person\'s confirm press. This is not a regression run; there is no pass');
lines.push('> count by design. The twelve tests\' machine assertions live in the suites named below.');
lines.push('');
lines.push('## §31 → who walked it, and which suite machine-asserts it');
lines.push('');
lines.push('| Test | §31 asks | Walked by | Machine-asserted by |');
lines.push('|---|---|---|---|');
lines.push('| 1 | My Work focus, from real data | Primary BD | verify-copilot T1, verify-ai 7c |');
lines.push('| 2 | Customer briefing, from the record | Primary BD + Primary SA | verify-copilot T2, verify-ai 7d |');
lines.push('| 3 | Opportunity risks, three sources | Primary BD | verify-copilot T3, verify-ai 7e |');
lines.push('| 4 | MOM extract → select → create, relationships | Primary BD | verify-copilot T4, verify-ai 7f/7g |');
lines.push('| 5 | Discovery: evidence, no auto-create | Primary BD | verify-copilot T5, verify-ai 7j |');
lines.push('| 6 | Products only from the Reference | Primary SA | verify-copilot T6, verify-ai 7i |');
lines.push('| 7 | Deterministic question, zero AI | Manager | verify-copilot-scope #63, verify-ai 7h |');
lines.push('| 8 | Permission: absent + confidential | Primary BD + Admin | verify-copilot-scope walls, verify-ai §5 |');
lines.push('| 9 | Admin pipeline overview | Admin | verify-ai 7l |');
lines.push('| 10 | Manager BI, strictly read-only | Manager | verify-ai 7l/§7, verify-roles |');
lines.push('| 11 | Processing state, no refresh | Primary BD | verify-ai 7o, verify-ai-tasks |');
lines.push('| 12 | Duplicate protection | Primary BD | verify-ai-tasks, verify-ai 7o |');
lines.push('');
lines.push('## Findings');
lines.push('');
for (const k of KINDS) {
  const rows = LOG.filter(e => e.kind === k);
  if (!rows.length) continue;
  lines.push('### ' + head[k] + '  (' + rows.length + ')');
  lines.push('');
  lines.push('| # | Role | Screen | What happened |');
  lines.push('|---|---|---|---|');
  for (const e of rows) {
    lines.push('| ' + e.n + ' | ' + esc(e.role) + ' | ' + esc(e.screen) + ' | ' + esc(e.what)
      + (e.detail ? '<br>' + esc(e.detail) : '') + ' |');
  }
  lines.push('');
}
lines.push('## Every step, in order');
lines.push('');
lines.push('| # | Kind | Role | Screen | Note |');
lines.push('|---|---|---|---|---|');
for (const e of LOG) {
  lines.push('| ' + e.n + ' | ' + e.kind + ' | ' + esc(e.role) + ' | ' + esc(e.screen) + ' | '
    + esc(e.what).slice(0, 170) + ' |');
}
lines.push('');
const md = lines.join('\n');
const mdPath = join(OUTDIR, 'WALKTHROUGH-31.md');
writeFileSync(mdPath, md, 'utf8');
writeFileSync(join(OUTDIR, 'walkthrough-31.json'), JSON.stringify(LOG, null, 2), 'utf8');

console.log('\n══════════════════════════════════════════════════════════════════');
for (const k of KINDS) {
  console.log('  ' + k.padEnd(9) + LOG.filter(e => e.kind === k).length);
}
console.log('  ' + LOG.length + ' conclusions recorded');
const gaps = LOG.filter(e => e.kind === 'gap');
if (gaps.length) {
  console.log('\n  GAPS, in one place — these are the things to decide about:');
  for (const g of gaps) console.log('    · ' + g.role + ' · ' + g.screen + ': ' + g.what.slice(0, 120));
} else {
  console.log('\n  No gap: at every step walked, the product did what §31 claims.');
}
if (pageErrors.length) console.log('  (page errors during the walk: ' + pageErrors.length + ' — see walkthrough-31 run log)');
console.log('  → ' + mdPath);
console.log('══════════════════════════════════════════════════════════════════\n');

bye();
process.exit(0);
