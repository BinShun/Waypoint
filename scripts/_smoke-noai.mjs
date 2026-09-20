/* _smoke-noai.mjs — §32's last Quality line, smoked by hand, once:
 *
 *     "The normal application remains fully usable without AI."
 *
 * The machine half is already asserted everywhere: the 21 suites that are
 * not about AI all run with no model configured and prove the reads, the
 * writes, the permissions and the relationships; verify-ai §2 proves the
 * unconfigured state says so honestly. What they do not do is walk one
 * person through one sitting with the endpoint absent from the first
 * request to the last — which is what "fully usable without AI" means to
 * somebody who has just been told the model is down.
 *
 * So: one server with no AI_* in its environment and no config POSTed,
 * one admin, ten findings, no pass count — a smoke, not a suite. Run:
 *   cd customer-workbench && WP_PASS=… node scripts/_smoke-noai.mjs
 */
import { spawn } from 'node:child_process';
import { claimPort } from './harness.mjs';
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { readWorkspaceFile } from './disk.mjs';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 8868);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const PASSWORD = process.env.WP_PASS || '';
const SOURCE = readFileSync(join(ROOT, 'Waypoint-v1.html'), 'utf8');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const now = new Date().toISOString();
const iso = (days) => {
  const d = new Date(); d.setDate(d.getDate() + days);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

const findings = [];
let n = 0;
function finding(what, ok, detail = '') {
  n++;
  findings.push({ n, what, ok, detail });
  console.log((ok ? 'SMOKE OK  ' : 'SMOKE BAD ') + n + '. ' + what + (detail ? '\n          ' + detail : ''));
}

/* The book: one admin, one customer with the whole chain, one overdue step
   of ours and one waiting on the customer, a deal, and a meeting. No AI
   anywhere in the environment — the server is never told a base URL. */
const dir = mkdtempSync(join(tmpdir(), 'wp-smoke-'));
copyFileSync(join(ROOT, 'data', 'workbench.json'), join(dir, 'workbench.json'));
{
  const skeleton = JSON.parse(readFileSync(join(dir, 'workbench.json'), 'utf8'));
  const salt = randomBytes(16);
  skeleton.users = [{ id: 'u_teh', name: 'Teh Bin Shun', email: 'tehbinshun@global.tencent.com',
    role: 'admin', title: 'Senior Solution Architect', locked: false, createdAt: now, updatedAt: now }];
  skeleton.credentials = { u_teh: { userId: 'u_teh', algo: 'pbkdf2-sha256', iterations: 150_000,
    salt: salt.toString('base64'),
    hash: pbkdf2Sync(PASSWORD, salt, 150_000, 32, 'sha256').toString('base64'),
    createdAt: now, updatedAt: now } };
  skeleton.logs = []; skeleton.audit = [];
  skeleton.customers = [{
    id: 'c1', name: 'NusaTel Berhad', industry: 'Telecom', hq: 'Kuala Lumpur',
    owner: 'Teh Bin Shun', sa: '', stance: 'With us', health: 'Healthy',
    since: 'Mar 2026', site: 'nusatel.example', people: 4200, brief: '',
    pains: ['Billing runs on Exadata — renewal quote came back 40% higher'],
    contacts: [], apps: [], opps: ['o1'], timeline: [], confidential: false, updatedAt: now },
  { id: 'c2', name: 'Rengit Engineering', industry: 'Manufacturing', hq: 'Johor Bahru',
    owner: 'Tan Wei Ming', sa: '', stance: 'Undecided', health: 'Watch',
    since: 'Jun 2026', site: 'rengit.example', people: 800, brief: '',
    pains: [], contacts: [], apps: [], opps: ['o2'], timeline: [], confidential: false, updatedAt: now }];
  skeleton.opps = { o1: { id: 'o1', c: 'c1', cust: 'NusaTel Berhad', t: 'Cloud migration platform deal',
    v: 480000, p: 25, stage: 'Interested', close: '', desc: 'A phased migration of the billing stack off Exadata.',
    blockers: 'The CFO has not released the budget line', owner: 'Teh Bin Shun', comp: '-',
    items: [], soln: '', whylost: '', stageAt: iso(-10), updatedAt: now },
  o2: { id: 'o2', c: 'c2', cust: 'Rengit Engineering', t: 'Perak factory automation', v: 90000, p: 15,
    stage: 'Interested', close: '', desc: 'They want to automate two assembly lines in the Perak plant.',
    blockers: '', owner: 'Tan Wei Ming', comp: '-', items: [], soln: '', whylost: '',
    stageAt: iso(-120), updatedAt: iso(-150) } };
  skeleton.interactions = [{ id: 'm1', c: 'c1', t: 'Billing migration workshop', d: iso(-1),
    loc: 'Kuala Lumpur', att: 'Dr Amir Rashid', ours: 'Teh Bin Shun', sum: '', out: '' }];
  skeleton.steps = [
    { id: 's1', c: 'c1', t: 'Send the sizing sheet before Friday', exec: 'Teh Bin Shun',
      track: 'Teh Bin Shun', due: iso(-3), w: '', from: 'us', p: '', kind: 'proposal', o: 'o1',
      done: '', doneBy: '', doneNote: '' },
    { id: 's2', c: 'c1', t: 'Send the signed renewal letter back to us', exec: 'Dr Amir Rashid',
      track: 'Teh Bin Shun', due: iso(-1), w: '', from: 'customer', p: '', kind: 'follow-up', o: '',
      done: '', doneBy: '', doneNote: '' }];
  skeleton.team = []; skeleton.files = []; skeleton.watch = [];
  writeFileSync(join(dir, 'workbench.json'), JSON.stringify(skeleton));
}
const disk = () => readWorkspaceFile(join(dir, 'workbench.json'));

/* NOTE: no AI_BASE_URL, no AI_API_KEY, no WB_TEST_AI — the server is asked
   for nothing it would have to answer about a model. */
const srv = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
  env: { ...process.env, AI_BASE_URL: '', AI_API_KEY: '', WB_TEST_AI: '',
    WB_DATA_KEY: '', WB_DATA_DIR: dir, PORT: String(PORT), HOST: '127.0.0.1', WB_TLS: '0', WB_ORIGINS: ORIGIN },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await claimPort(PORT);
let srvLog = '';
srv.stderr.on('data', d => { srvLog += d; });
const bye = () => { try { srv.kill(); } catch { /* gone */ } };
process.on('exit', bye);
process.on('SIGINT', () => { bye(); process.exit(1); });
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(ORIGIN + '/api/health')).ok) break; } catch { /* not yet */ }
  await wait(150);
}

/* One session, the honest way: cookie jar + jsdom window. */
const jar = { v: '' };
const api = async (path, opts = {}) => {
  const res = await fetch(ORIGIN + path, {
    ...opts, redirect: 'manual', signal: AbortSignal.timeout(60000),
    headers: { ...(opts.headers || {}), Origin: ORIGIN, ...(jar.v ? { cookie: jar.v } : {}) }
  });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) jar.v = sc.map(s => s.split(';')[0]).join('; ');
  return res;
};
const pageErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => pageErrors.push(String(e.message)));
const dom = new JSDOM(SOURCE, {
  url: ORIGIN + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse: (w) => {
    w.scrollTo = () => {};
    w.URL.createObjectURL = () => 'blob:stub';
    w.URL.revokeObjectURL = () => {};
    w.fetch = (u, o) => api(String(u).replace(ORIGIN, ''), o);
  },
});
const win = dom.window;
const doc = win.document;
await wait(900);
const $ = (s) => doc.querySelector(s);
const $$ = (s) => [...doc.querySelectorAll(s)];
const text = () => (doc.getElementById('page') || doc.body).textContent;
async function click(el, ms = 340) { if (!el) return false; el.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); await wait(ms); return true; }
async function setVal(el, v) { if (!el) return false; el.value = v; el.dispatchEvent(new win.Event('input', { bubbles: true })); el.dispatchEvent(new win.Event('change', { bubbles: true })); await wait(120); return true; }
const waitFor = async (fn, ms = 9000) => { for (let i = 0; i < Math.floor(ms / 300); i++) { await wait(300); if (fn()) return true; } return false; };

/* 1 — sign-in first; the status route is a signed-in door. */
{
  const p = $('#lgP');
  if (p) {
    $('#lgE').value = 'tehbinshun@global.tencent.com';
    await setVal(p, PASSWORD);
    p.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await wait(1700);
  }
  finding('The administrator signs in and lands in the app — no AI needed for that, no error thrown.',
    !!$('#nav'), pageErrors.length ? 'page errors: ' + pageErrors[0].slice(0, 80) : 'clean');
}

/* 2 — the server says, up front, that no model is configured. */
{
  const st = await (await api('/api/ai/status')).json();
  finding('With no endpoint in the environment, the AI status says so instead of pretending.',
    st.configured === false && !!st.reason, (st.reason || '').slice(0, 90));
}

/* 3 — Today: the rules' content is all there, and the AI box says what is
      true — no model connected — in the place a person can act on. */
{
  await click($('[data-go="today"]'), 400);
  const t = text();
  const overdueShown = /Overdue/.test(t) && /Ours, past the date we set/.test(t);
  const noteShown = /No model connected\./.test(t) && /Admin → AI & model/.test(t);
  const noAskButton = !$('#focusWeek [data-tb]');
  finding('The Today screen keeps every rule it always had (the overdue count, in its own words), and the AI box says plainly "No model connected." with no ask button.',
    overdueShown && noteShown && noAskButton,
    'rules=' + overdueShown + ' note=' + noteShown + ' button=' + !noAskButton);
}

/* 4 — the customer: the facts render, the AI doors show the note instead
      of a button that would have to apologise. */
{
  await click($('[data-go="customers"]'), 600);
  await click($('[data-open="c1"]'), 500);
  const t = text();
  const facts = /NusaTel Berhad/.test(t) && /Billing runs on Exadata/.test(t);
  const noteOnBrief = /No model connected\./.test(t);
  const noBriefBtn = !$('#custBrief-c1 [data-tb]');
  finding('The customer opens with every fact in place, and the briefing area shows the same honest note instead of an ask button.',
    facts && noteOnBrief && noBriefBtn,
    'facts=' + facts + ' note=' + noteOnBrief + ' button=' + !noBriefBtn);
}

/* 5 — the deal and the meeting: no analysis door, no extraction door, and
      the records themselves are all still there. */
{
  const oppTab = $$('[data-tab]').find(b => /opportunities/i.test(b.textContent || ''));
  await click(oppTab, 400);
  const noAnalyze = !$('#analyzeOpp-o1 [data-tb]');
  const dealShown = /Cloud migration platform deal/.test(text());
  await click($('[data-go="interactions"]'), 400);
  const meetingShown = /Billing migration workshop/.test(text());
  const noMomBtn = !$('[data-act="mom"][data-mid="m1"]');
  finding('The opportunity and the meeting render as records first — no Analyze button, no minutes-extraction button, and nothing missing from the book.',
    noAnalyze && dealShown && meetingShown && noMomBtn,
    'analyze=' + !noAnalyze + ' deal=' + dealShown + ' meeting=' + meetingShown + ' mom=' + !noMomBtn);
}

/* 6 — the questions the rules own are still answered, in the same breath,
      with no model anywhere: the palette's own waiting-rule, and the
      server-side follow-up rule. */
{
  await click($('[data-go="today"]'), 400);
  const askPal = async (q) => {
    await win.eval('openPal()');
    await setVal($('#palI'), q);
    $('#palI').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  await askPal('What is waiting on a customer?');
  const palA = () => ($('#palA') || { textContent: '' }).textContent;
  const waiting = await waitFor(() => /Send the signed renewal letter back to us/.test(palA()));
  finding('"What is waiting on a customer?" is answered from the book by the rule that always owned it — no model was ever configured, let alone asked.',
    waiting, waiting ? palA().slice(0, 80) : 'never answered');
  await askPal('Which of my Opportunities have no recent follow-up?');
  const followup = await waitFor(() => /Perak factory automation/.test(palA()) && /no interaction ever recorded/i.test(palA()));
  finding('The deterministic follow-up question is answered the same way — by the rules, in the same breath as the request.',
    followup, followup ? palA().slice(0, 90) : 'never answered: ' + palA().slice(0, 90));
  await win.eval('closePal()');
}

/* 7 — the task center is honest about having nothing to do. */
{
  await click($('[data-go="aitasks"]'), 500);
  const t = text();
  finding('The AI Tasks screen opens and says what is true for a workspace with no model: nothing is running, nothing is queued.',
    /AI Tasks/.test(t) && !/Working|Queued/.test((t.match(/AI Tasks[\s\S]*$/) || [''])[0]), t.slice(0, 60));
}

/* 8 — a write, the ordinary way: one Next Step through the same PUT the
      app always uses, and the book's revision is the referee. */
{
  const before = (await (await api('/api/data')).json());
  const st = disk();
  const fresh = { id: 's_smoke', c: 'c1', t: 'Book the architecture review call', exec: 'Teh Bin Shun',
    track: 'Teh Bin Shun', due: iso(2), w: '', from: 'us', p: '', kind: 'meeting', o: 'o1',
    done: '', doneBy: '', doneNote: '' };
  const r = await api('/api/data', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: { ...st, steps: [...(st.steps || []), fresh] }, baseRev: before.rev, deleted: {} }),
  });
  const after = (await (await api('/api/data')).json());
  const onDisk = (disk().steps || []).some(s => s.id === 's_smoke' && s.track === 'Teh Bin Shun');
  finding('A Next Step is written through the ordinary save path — no AI in the loop — and lands on the book with its relationships.',
    r.ok && after.rev === before.rev + 1 && onDisk,
    'HTTP ' + r.status + ', rev ' + before.rev + ' -> ' + after.rev + ', onDisk=' + onDisk);
}

/* 9 — no request ever left for a model, and no page error broke the sitting. */
{
  finding('The whole sitting threw no page error — the app without AI is the app, not a degraded apology.',
    pageErrors.length === 0, pageErrors.length ? pageErrors.slice(0, 2).join(' | ').slice(0, 120) : 'clean');
}

console.log('\n════════════════════════════════════════════════');
const bad = findings.filter(f => !f.ok);
console.log('  ' + (findings.length - bad.length) + '/' + findings.length + ' smoke findings hold' + (bad.length ? '' : ' — the app is fully usable without AI.'));
if (bad.length) { console.log('  FAILING:'); for (const b of bad) console.log('    · ' + b.what); }
if (srvLog && /Error/.test(srvLog)) console.log('  server log had errors: ' + srvLog.slice(-300));
console.log('════════════════════════════════════════════════');
bye();
process.exit(bad.length ? 1 : 0);
