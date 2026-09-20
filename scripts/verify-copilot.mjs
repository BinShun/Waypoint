/* verify:copilot — §31 Test 1–6, the acceptance walkthrough, machine-made.
 *
 * WHY THIS EXISTS
 * ---------------
 * The other AI suites each answer one question: `ai` presses every feature
 * for what the spec says it must show, `copilot-scope` proves the walls
 * hold, `ai-tasks` tortures the task table. None of them walks the
 * acceptance tests as the acceptance tests are written — six scenes, the
 * spec's own questions, a real click path, and one verdict per scene:
 * did the answer use the book, or did it perform?
 *
 * Every scene asks with the words §31 uses, follows the path a person
 * follows, and asserts the two things the spec demands: the prompt carried
 * the records (checked through the stand-in's transcript), and the screen
 * showed what came back. Scenes 4 and 5 go further — the confirm presses
 * are the acceptance point, so the rows, the relationships and the audit
 * lines are read off the disk.
 *
 * The model is the stand-in, so every answer here is scripted — which is
 * the point: the suite proves the plumbing is honest about what it sent,
 * what it showed, and what it wrote, not that a model was clever.
 *
 * Run from customer-workbench/:  WP_PASS=… npm run verify:copilot
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { claimPort } from './harness.mjs';
import { adminSeed } from './verify-auth.mjs';
import { createServer } from 'node:http';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readWorkspaceFile } from './disk.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8861;
const STUB_PORT = 8862;
const ORIGIN = 'http://127.0.0.1:' + PORT;
const STUB = 'http://127.0.0.1:' + STUB_PORT + '/v1';
const PASS = process.env.WP_PASS || '';
const KEY = 'sk-waypoint-test-key-0002';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* With a real endpoint configured, every answer below is the model's, not
   the script's — the scenes stand aside and say so, the same standing-aside
   `ai` practices. */
const REAL = !!(process.env.AI_BASE_URL && process.env.AI_API_KEY);
let skipped = 0;
const skip = (name, why) => { skipped++; console.log('SKIP  ' + name + '  ' + why); };

/* --------------------------------------------------------- the stand-in ---- */
/* No default routing: this suite scripts every reply it expects to get, so
   an ask it did not plan for sits unanswered and the scene says so, rather
   than quietly passing on an answer it never checked. */
const stubScript = [];
const seen = { requests: 0, prompts: [] };
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
      try { j = JSON.parse(body || '{}'); } catch { /* recorded as empty below */ }
      seen.prompts.push(String((j.messages || []).map((m) => m.content).join('\n') || ''));
      const scripted = stubScript.length ? stubScript.shift() : null;
      const reply = scripted != null ? String(scripted) : '';
      return send(200, {
        choices: [{ message: { content: reply } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });
    }
    send(404, { error: 'not found' });
  });
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

/* --------------------------------------------------------------- server ---- */
/* One customer with everything the six scenes lean on: a deal with a blocker,
 * a meeting from yesterday, a step that went overdue, a pain the account
 * owns, a decision maker on the contact list, and two Reference rows with a
 * recorded Product SA. The names are the needles the prompts are asserted
 * to carry — if a scene's needle stops reaching the model, the scene stops
 * being about the book and the check says so. */
const dir = mkdtempSync(join(tmpdir(), 'wp-copilot-'));
copyFileSync(join(ROOT, 'data', 'workbench.json'), join(dir, 'workbench.json'));
{
  const iso = (days) => {
    const d = new Date(); d.setDate(d.getDate() + days);
    const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };
  const skeleton = JSON.parse(readFileSync(join(dir, 'workbench.json'), 'utf8'));
  const seed = adminSeed();
  skeleton.users = seed.users;
  skeleton.credentials = seed.credentials;
  skeleton.audit = [];
  skeleton.customers = [{
    id: 'c1', name: 'NusaTel Berhad', industry: 'Telecom', hq: 'Kuala Lumpur',
    owner: 'Teh Bin Shun', stance: 'With us', health: 'Healthy', since: 'Mar 2026',
    site: 'nusatel.example', people: 4200,
    brief: '',
    pains: ['Billing runs on Exadata — renewal quote came back 40% higher'],
    contacts: [{ n: 'Dr Amir Rashid', t: 'Group CTO', s: 'With us', o: 'Teh Bin Shun', b: 'Decision maker', note: '' }],
    apps: [], opps: ['o1'], timeline: [],
    updatedAt: new Date().toISOString(),
  }];
  skeleton.opps = {
    o1: { id: 'o1', c: 'c1', cust: 'NusaTel Berhad', t: 'Cloud migration platform deal', v: 480000, p: 25,
      stage: 'Interested', close: '', desc: 'They are evaluating a phased migration of the billing stack off Exadata.',
      blockers: 'The CFO has not released the budget line',
      owner: 'Teh Bin Shun', comp: '-', items: ['p1'], soln: '', whylost: '',
      stageAt: iso(-10), updatedAt: new Date().toISOString() },
  };
  skeleton.interactions = [{ id: 'm1', c: 'c1', t: 'Billing migration workshop', d: iso(-1),
    loc: 'Kuala Lumpur', att: 'Dr Amir Rashid', ours: 'Teh Bin Shun', sum: '', out: '' }];
  skeleton.steps = [{ id: 's1', c: 'c1', t: 'Send the sizing sheet before Friday', exec: 'Teh Bin Shun',
    track: 'Teh Bin Shun', due: iso(-3), w: '', from: 'us', p: 'p1', kind: 'proposal', o: 'o1',
    done: '', doneBy: '', doneNote: '' }];
  skeleton.team = []; skeleton.files = []; skeleton.watch = [];
  skeleton.products = (skeleton.products || []).map((p) =>
    p && (p.id === 'p1' || p.id === 'p10') ? { ...p, by: ['Sarah Kwan'] } : p);
  writeFileSync(join(dir, 'workbench.json'), JSON.stringify(skeleton));
}
const disk = () => readWorkspaceFile(join(dir, 'workbench.json'));

const srv = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
  env: { ...process.env, WB_DATA_DIR: dir, PORT: String(PORT), WB_TLS: '0', WB_ORIGINS: ORIGIN, WB_TEST_AI: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await claimPort(PORT);
let srvLog = '';
srv.stderr.on('data', (d) => { srvLog += d; });
srv.stdout.on('data', (d) => { srvLog += d; });

let cookie = '';
async function api(path, opts = {}) {
  const res = await fetch(ORIGIN + path, {
    ...opts, redirect: 'manual', signal: AbortSignal.timeout(120000),
    headers: { ...(opts.headers || {}), Origin: ORIGIN, ...(cookie ? { cookie } : {}) },
  });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map((s) => s.split(';')[0]).join('; ');
  return res;
}
const json = async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) });

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(ORIGIN + '/api/health')).ok) break; } catch { /* not yet */ }
  await wait(150);
}
check('the server is up', (await fetch(ORIGIN + '/api/health')).ok);

/* ----------------------------------------------------------------- page ---- */
const vc = new VirtualConsole();
vc.on('jsdomError', () => {});
const dom = new JSDOM(readFileSync(join(ROOT, 'Waypoint-v1.html'), 'utf8'), {
  url: ORIGIN + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
});
const win = dom.window;
const doc = win.document;
win.scrollTo = () => {};
win.fetch = (u, o) => api(String(u).replace(ORIGIN, ''), o);
const $ = (s) => doc.querySelector(s);
const strip = (el) => { const c = el.cloneNode(true); c.querySelectorAll('script,style').forEach((n) => n.remove()); return c; };
const pageText = () => strip(doc.getElementById('page') || doc.body).textContent;
async function click(el, ms = 300) { if (!el) return false; el.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); await wait(ms); return true; }
async function setVal(el, v) { if (!el) return false; el.value = v; el.dispatchEvent(new win.Event('input', { bubbles: true })); el.dispatchEvent(new win.Event('change', { bubbles: true })); await wait(120); return true; }

if (!PASS) {
  console.log('FAIL  no WP_PASS in the environment');
  srv.kill(); stub.close(); process.exit(1);
}
await wait(700);
await click($('[data-act="signin"]'), 200);
await setVal($('#lgE'), 'tehbinshun@global.tencent.com');
await setVal($('#lgP'), PASS);
await click($('[data-act="signin"]'), 1400);
check('signed in as the administrator', !!$('#nav'), $('#nav') ? '' : 'no nav');
/* The endpoint is connected the way an administrator connects it — after
   sign-in, because the config route is an admin's door and says so. */
{
  const r = await json(await api('/api/ai/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: STUB, model: 'waypoint-test-model', key: KEY }),
  }));
  check('the model endpoint is connected', r.status === 200 && r.ok === true, 'HTTP ' + r.status);
}
await win.eval('refreshAi()');
await wait(300);

/* The shared waiting shape: an ask becomes a task, the poll lands it, and
   the scene's needle is the thing that only appears when the answer did. */
async function waitFor(needle, ms = 9000){
  for (let i = 0; i < Math.floor(ms / 300); i++){ await wait(300); if (needle()) return true; }
  return false;
}

/* ============================== Test 1 — My Work ============================
   "What should I focus on this week?" — the result should use actual
   accessible business data. The book holds one overdue step; the stand-in
   is handed a suggested action, and the scene checks the PROMPT carried
   the book's own words and the SCREEN carried the book's own row. */
if (REAL) {
  const why = 'a real model\'s reading of the week is not ours to script';
  skip('T1: the week is read from the book the user can see', why);
  skip('T1: the answer lands as rows that open the account', why);
} else {
  stubScript.push(JSON.stringify({ items: [{ n: 1, action: 'Send the sizing sheet and book the review call.' }] }));
  await click($('[data-go="today"]'), 400);
  await click(doc.querySelector('#focusWeek [data-tb]'), 300);
  const fwBox = () => doc.getElementById('focusWeek');
  const fwText = () => (fwBox() ? fwBox().textContent : '');
  const t1 = await waitFor(() => /Suggested action/.test(fwText()));
  /* The one thing §31 demands: the answer used the data. The step title,
     the customer, and the lateness all come from the fixture — if the
     prompt no longer carries them, the "focus" was invented, not read. */
  const t1Prompt = seen.prompts.slice().reverse().find((p) => /What should I focus on this week/.test(p)) || '';
  check('T1: the week is read from the book the user can see',
    t1 && /Next step overdue: "Send the sizing sheet before Friday"/.test(t1Prompt)
      && /NusaTel Berhad/.test(t1Prompt)
      && /Send the sizing sheet before Friday/.test(fwText())
      && /days past the date set/.test(fwText()),
    t1 ? '' : 'the list never landed');
  /* The item is a door into the account it is about — a list you cannot
     act from is a report, not a focus. */
  check('T1: the answer lands as rows that open the account',
    t1 && !!fwBox().querySelector('[data-open="c1"]')
      && /Send the sizing sheet and book the review call\./.test(fwText()),
    t1 ? '' : 'never answered');
}

/* ============================== Test 2 — Customer ===========================
   "Give me a quick briefing and tell me what needs attention." — the answer
   should use actual Customer data: the name and industry, the decision
   maker, and the pain the account carries, verbatim. */
if (REAL) {
  const why = 'a real model\'s briefing is not ours to script';
  skip('T2: the briefing is built from the customer\'s own record', why);
  skip('T2: the answer names the records it leaned on', why);
} else {
  stubScript.push(JSON.stringify({
    brief: 'Mid-programme on the billing migration; the Exadata renewal is the forcing event.',
    attention: 'The renewal quote came back 40% higher and the sizing sheet is still unsent.',
  }));
  await click($('[data-go="customers"]'), 400);
  await click($('[data-open="c1"]'), 500);
  await click(doc.querySelector('#custBrief-c1 [data-tb]'), 300);
  const brBox = () => doc.getElementById('custBrief-c1');
  const brText = () => (brBox() ? brBox().textContent : '');
  const t2 = await waitFor(() => /forcing event/.test(brText()));
  const t2Prompt = seen.prompts.slice().reverse().find((p) => /briefing/.test(p) || /NusaTel Berhad/.test(p)) || '';
  check('T2: the briefing is built from the customer\'s own record',
    t2 && /NusaTel Berhad — Telecom — HQ Kuala Lumpur/.test(t2Prompt)
      && /Group CTO/.test(t2Prompt) && /Decision maker/.test(t2Prompt)
      && /Billing runs on Exadata/.test(t2Prompt)
      && /renewal quote came back 40% higher/.test(t2Prompt),
    t2 ? '' : 'the briefing never landed');
  /* §16: the answer names the records it leaned on — the facts zone with
     its sections, and the citation chips (whose promise lives in the tag's
     title, not its text) are the difference between a briefing and a
     feeling. */
  const citeChip = brBox() && [...brBox().querySelectorAll('.tag')]
    .some((t) => /The records this answer was built on/.test(t.getAttribute('title') || ''));
  check('T2: the answer names the records it leaned on',
    t2 && /Needs attention/.test(brText())
      && /From your records/.test(brText())
      && /Key people/.test(brText()) && /Active opportunities/.test(brText())
      && citeChip,
    t2 ? brText().slice(0, 80) : 'never answered');
}

/* ============================ Test 3 — Opportunity ==========================
   "What are the current risks and what should I do next?" — the answer
   should reference actual Opportunity / MOM / Next Step information. Three
   needles, one per source; the stand-in's risks must render with their why. */
if (REAL) {
  const why = 'a real model\'s risk reading is not ours to script';
  skip('T3: the analysis is fed the deal, the meeting and the step', why);
  skip('T3: the risks show and every one explains itself', why);
} else {
  stubScript.push(JSON.stringify({
    risks: [
      { what: 'The deal has no close date.', why: 'The record carries no close date at all.', kind: 'validate' },
      { what: 'The CFO budget line is unresolved.', why: 'The recorded blocker names the CFO.', kind: 'follow-up' },
    ],
    moves: [{ what: 'Send the wave-1 plan with the new quote attached', why: 'The blocker is the budget line, so the plan needs the number on it.', kind: 'proposal' }],
    gaps: ['No close date recorded.'],
    prepare: [],
  }));
  const oppsTab = () => [...doc.querySelectorAll('[data-tab]')].find((b) => /opportunities/i.test(b.textContent));
  await click(oppsTab(), 400);
  await click(doc.querySelector('#analyzeOpp-o1 [data-tb]'), 300);
  const anBox = () => doc.getElementById('analyzeOpp-o1');
  const anText = () => (anBox() ? anBox().textContent : '');
  const t3 = await waitFor(() => /Suggested moves|What the records flag/.test(anText()));
  /* One needle from each source §31 names: the deal's own description, the
     meeting's attendee, the step's title — all three must have reached the
     model for the answer to be about this deal. */
  const t3Prompt = seen.prompts.slice().reverse().find((p) => /phased migration of the billing stack/.test(p)) || '';
  check('T3: the analysis is fed the deal, the meeting and the step',
    t3 && /phased migration of the billing stack off Exadata/.test(t3Prompt)
      && /with Dr Amir Rashid/.test(t3Prompt)
      && /Send the sizing sheet before Friday/.test(t3Prompt)
      && /The CFO has not released the budget line/.test(t3Prompt),
    t3 ? '' : 'the analysis never landed');
  check('T3: the risks show and every one explains itself',
    t3 && /The CFO budget line is unresolved\./.test(anText())
      && /why: The recorded blocker names the CFO\./.test(anText())
      && /Send the wave-1 plan/.test(anText())
      && /No close date recorded\./.test(anText()),
    t3 ? anText().slice(0, 80) : 'never answered');
}

/* ================================= Test 4 — MOM =============================
   Ask AI to extract the five kinds, review, select several action items,
   create Next Steps, verify all relationships. The confirm press is the
   acceptance point: rows on disk, tied to the customer, the tracker and
   the deal the minutes named; pains onto the account; the audit telling
   the truth about where each row came from. */
if (REAL) {
  const why = 'a real model\'s extraction is not ours to script';
  skip('T4: the five kinds are read out and every tick starts on', why);
  skip('T4: the accepted steps land with their relationships intact', why);
  skip('T4: the accepted pains land on the account, with an audit line', why);
  skip('T4: the presses are what moved the book — twice', why);
} else {
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
  await click($('[data-go="interactions"]'), 400);
  await click(doc.querySelector('[data-act="mom"][data-mid="m1"]'), 400);
  await setVal(doc.getElementById('momT'),
    'Attended: Dr Amir Rashid. The nightly billing batch keeps overrunning its window. The renewal timeline was walked through; '
    + 'the quote is up 40%. We agreed a phased approach: wave 1 read-only billing by November. Their CTO will send the contract '
    + 'end date in writing. He also asked what happens if the primary region fails. We will send the wave-1 plan to their billing lead.');
  await click(doc.getElementById('momGo'), 600);
  const sheet = () => doc.getElementById('capBody');
  const stext = () => (sheet() ? sheet().textContent : '');
  const t4 = await waitFor(() => /Suggested next steps/.test(stext()));
  check('T4: the five kinds are read out and every tick starts on',
    t4 && /Customer concerns/.test(stext()) && /Requirements/.test(stext()) && /Decisions/.test(stext())
      && /Commitments/.test(stext()) && /Suggested next steps/.test(stext())
      && /Potential opportunities/.test(stext()) && /Pain points/.test(stext())
      && !!sheet().querySelector('[data-mchk="0"]') && (sheet().querySelector('[data-mchk="0"]') || {}).checked === true,
    t4 ? '' : 'the reading never landed');
  /* Both steps stay ticked; Create walks them through the same door a
     hand-typed step uses — the relationships are the acceptance point. */
  const revT4 = (await json(await api('/api/data'))).rev;
  await click(doc.getElementById('momCreate'), 700);
  let stepRows = null, stepAudit = null;
  for (let i = 0; i < 20 && !stepRows; i++){
    await wait(300);
    stepRows = (disk().steps || []).filter(s => s.c === 'c1'
      && (/Send the wave-1 plan/.test(s.t) || /Get the contract end date/.test(s.t)));
    if (stepRows && stepRows.length === 2) stepAudit = (disk().audit || []).find(a => a.what === 'Actions from minutes'
      && /2 next step/.test(a.rec || '') && /accepted from the minutes/.test(a.to || ''));
  }
  const tiedRow = stepRows && stepRows.find(s => /Send the wave-1 plan/.test(s.t));
  const tlRow = stepRows && (disk().customers.find((c) => c.id === 'c1').timeline || [])
    .find(t => /Send the wave-1 plan/.test(t.t || ''));
  check('T4: the accepted steps land with their relationships intact',
    !!stepRows && stepRows.length === 2 && !!stepAudit && !!tiedRow
      && tiedRow.o === 'o1' && tiedRow.track === 'Teh Bin Shun' && tiedRow.kind === 'proposal'
      && !!tlRow,
    stepRows ? JSON.stringify(tiedRow || {}).slice(0, 100) : 'steps never landed');
  await click(doc.getElementById('momPains'), 700);
  let painLanded = false, painAudit = null;
  for (let i = 0; i < 20 && !painLanded; i++){
    await wait(300);
    const c1row = (disk().customers || []).find((c) => c.id === 'c1') || {};
    if ((c1row.pains || []).includes('Nightly billing batch overruns its window')){
      painLanded = true;
      painAudit = (disk().audit || []).find(a => a.what === 'Pain points from minutes'
        && /1 pain point/.test(a.rec || ''));
    }
  }
  check('T4: the accepted pains land on the account, with an audit line',
    painLanded && !!painAudit && /· recorded/.test(stext()),
    painLanded ? '' : 'pain never landed');
  /* The reading itself moved nothing: only the presses wrote, and the
     book's revision is the referee for both. */
  const revT4b = (await json(await api('/api/data'))).rev;
  check('T4: the presses are what moved the book — twice',
    typeof revT4b === 'number' && revT4b > revT4,
    'rev ' + revT4 + ' -> ' + revT4b);
}

/* ========================= Test 5 — Opportunity Discovery ===================
   The hint shows its evidence and its why; nothing is created until a
   person says so; the create walks the confirm sheet and lands as a real
   opportunity with the caveat riding inside the description. */
if (REAL) {
  const why = 'a real model\'s hints are not ours to script';
  skip('T5: the hint shows its evidence, and nothing is written yet', why);
  skip('T5: create opens the confirm sheet with the evidence pre-filled', why);
  skip('T5: the confirmed hint becomes a real opportunity, with its caveat', why);
} else {
  /* The panel from T4 is still up, with its hint still uncreated. */
  const sheet5 = () => doc.getElementById('capBody');
  const stext5 = () => (sheet5() ? sheet5().textContent : '');
  const oppCount = () => Object.keys(disk().opps || {}).length;
  const before5 = oppCount();
  check('T5: the hint shows its evidence, and nothing is written yet',
    /Disaster recovery for the billing stack/.test(stext5())
      && /Why this may be an opportunity/.test(stext5())
      && /the customer has not confirmed this demand/.test(stext5())
      && oppCount() === before5,
    'opps on disk ' + oppCount() + '/' + before5);
  await click(sheet5().querySelector('[data-mopp="0"]'), 400);
  const ocText = doc.getElementById('ocText');
  check('T5: create opens the confirm sheet with the evidence pre-filled',
    /Create an opportunity/.test(doc.querySelector('#capVeil .sheet-h').textContent)
      && !!ocText && ocText.value === 'Disaster recovery for the billing stack'
      && /Their CTO asked what happens if the primary region fails/.test((doc.getElementById('ocDesc') || {}).value || '')
      && oppCount() === before5,
    ocText ? '' : 'no confirm sheet');
  await click(doc.getElementById('ocCreate'), 700);
  let diskOpp = null, arow5 = null;
  for (let i = 0; i < 20 && !diskOpp; i++){
    await wait(300);
    diskOpp = Object.values(disk().opps || {}).find(o => o.t === 'Disaster recovery for the billing stack');
    if (diskOpp) arow5 = (disk().audit || []).find(a => a.what === 'Opportunity created'
      && /Disaster recovery/.test(a.rec || '') && /accepted from the minutes/.test(a.to || ''));
  }
  const c1opps5 = (disk().customers.find((c) => c.id === 'c1').opps || []);
  check('T5: the confirmed hint becomes a real opportunity, with its caveat',
    !!diskOpp && diskOpp.c === 'c1' && diskOpp.stage === 'Interested'
      && c1opps5.includes(diskOpp.id) && !!arow5
      && /the customer has not confirmed this demand/.test(diskOpp.desc || '')
      && /· created/.test(stext5()),
    diskOpp ? '' : 'never created');
  await win.eval('closeCapture()');
}

/* ========================= Test 6 — Product Intelligence ====================
   "Which Tencent Cloud products may be relevant?" — from the Product
   Reference, only from it: a name the Reference does not hold is dropped,
   the one-liner is the catalogue's own, and the SA is the Reference's
   spelling or nobody. */
if (REAL) {
  const why = 'a real model\'s product choices are not ours to script';
  skip('T6: the recommendation is asked against the Reference', why);
  skip('T6: only Reference rows survive, in the Reference\'s own words', why);
} else {
  stubScript.push(JSON.stringify({
    products: [
      { p: 'Cloud Virtual Machine', why: 'The billing migration needs elastic compute for the new platform.', support: 'The deal migrates the billing stack.', sa: 'Sarah Kwan' },
      { p: 'Quantum Blockchain Fabric', why: 'A name the Reference does not hold.', support: 'nothing real', sa: 'Ghost Person' },
    ],
  }));
  await click($('[data-go="customers"]'), 400);
  await click($('[data-open="c1"]'), 500);
  const oppsTab6 = () => [...doc.querySelectorAll('[data-tab]')].find((b) => /opportunities/i.test(b.textContent));
  await click(oppsTab6(), 400);
  await click(doc.querySelector('#suggestProducts-o1 [data-tb]'), 300);
  const prBox = () => doc.getElementById('suggestProducts-o1');
  const prText = () => (prBox() ? prBox().textContent : '');
  const t6 = await waitFor(() => /Products the Reference can support/.test(prText()));
  const t6Prompt = seen.prompts.slice().reverse().find((p) => /Product Reference/.test(p)) || '';
  check('T6: the recommendation is asked against the Reference',
    t6 && /The Product Reference — the only products you may name/.test(t6Prompt)
      && /Cloud Virtual Machine \(Compute\) — Elastic cloud servers/.test(t6Prompt)
      && /Product SA: Sarah Kwan/.test(t6Prompt)
      && /phased migration of the billing stack/.test(t6Prompt),
    t6 ? '' : 'never answered');
  check('T6: only Reference rows survive, in the Reference\'s own words',
    t6 && /Cloud Virtual Machine/.test(prText()) && !/Quantum Blockchain Fabric/.test(prText())
      && !/Ghost Person/.test(prText())
      && /Elastic cloud servers - the baseline everything else sits on\./.test(prText())
      && /SA · Sarah Kwan/.test(prText())
      && /why: The billing migration needs elastic compute/.test(prText()),
    t6 ? prText().slice(0, 80) : 'never answered');
}

srv.kill();
stub.close();
console.log(`\n${pass} passed, ${fail} failed${skipped ? ', ' + skipped + ' skipped' : ''}  (${pass + fail} checks)`);
if (REAL) console.log('NOTE  a real endpoint is configured — the stand-in scenes stood aside.');
if (fail && srvLog) console.log('server log tail: ' + srvLog.slice(-600));
process.exit(fail ? 1 : 0);
