/* verify:copilot-scope — the AI layer never sees what the caller cannot.
 *
 * WHY THIS EXISTS
 * ---------------
 * Phase 3 asks the server to assemble the model's context itself: the page
 * hands over an intent, and the server decides which customers, opportunities
 * and minutes the model gets to read. That move — from "the page pastes facts
 * at the model" to "the server assembles them" — is exactly where a scope
 * leak would live. §4 of the brief is a hard wall:
 *
 *   "Permission checks must happen BEFORE retrieving context for AI.
 *    Do not rely on the AI model itself to enforce permissions."
 *
 * So this suite does the one thing an inspection cannot: it watches what the
 * model is actually handed. It stands a stub endpoint in for the vendor,
 * seeds a book with one customer the BD owns and one they must not know
 * exists, asks the copilot about both, and then reads every prompt the stub
 * received. The needle strings are the proof: if any of them arrive at the
 * model, the wall has a hole — whatever the UI said.
 *
 * The 404 discipline matters as much as the data: a scope answer that says
 * "you may not see that customer" confirms the customer exists. The product
 * answers the way /api/file already does — not found is not found.
 *
 * Alongside the scope contract, the suite holds three hard rules from the
 * brief, each with a self-proof so a green run means the guard is alive:
 *   - no AI code writes customers/opps/steps/interactions (§26) — a static
 *     scan of the AI modules, plus a whole-book snapshot taken around a real
 *     AI request, which does not care where the code lives;
 *   - the model is asked only when somebody asks (§2/§27) — setInterval is
 *     banned outright, and an idle server with a model configured must send
 *     nothing;
 *   - a customer marked confidential is never sent to a model, by anyone,
 *     including its owner (Phase 2's own wording, now enforced server-side).
 *
 * THE ENDPOINT IS NOT BUILT YET (task #56 runs before #61 builds it). Until
 * /api/ai/copilot answers, the contract below stands aside and says so — the
 * same way verify:ai steps aside for a real endpoint. A suite that is red
 * from the day it is written teaches people to ignore red. The static scans,
 * the idle watch and the self-proofs are live from day one; the moment the
 * endpoint exists, every assertion here is live, and verify:all cannot go
 * green again through a scope hole.
 *
 * Run from customer-workbench/:  WP_PASS=… npm run verify:copilot-scope
 */
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { startServer } from './harness.mjs';
import { ADMIN, adminSeed, credentialFor, signIn, authed } from './verify-auth.mjs';
import { answerByRule, buildCustomerContext, buildOppContext, buildGlobalContext } from '../server/copilot.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8890;
const STUB_PORT = 8891;
const ORIGIN = 'http://127.0.0.1:' + PORT;
const STUB = 'http://127.0.0.1:' + STUB_PORT + '/v1';
const KEY = 'sk-waypoint-copilot-test-0002';

/* Needles. Everything the BD must never reach the model through lives under
   the Zenith name; the visible book carries its own needle so the suite can
   prove the stub was fed the RIGHT book, not no book at all. */
const SECRET_NAME = 'Zenith Secret Holdings';
const SECRET_NEEDLE = 'zenith-needle';
const MINE_NAME = 'Visible Retail Sdn Bhd';
const MINE_NEEDLE = 'visible-needle';
/* The third wall is not about who may read — it is about the model. A customer
   marked confidential behaves exactly the same in every other way (the
   product's own wording, on the Confidential screen), but nothing about it is
   sent to a model, by anyone, including its owner. */
const CONF_NAME = 'Straits Confidential Bank';
const CONF_NEEDLE = 'classified-needle';
/* The tables an AI answer is never allowed to write behind the caller's back. */
const GUARDED_TABLES = ['customers', 'opps', 'steps', 'interactions'];

let pass = 0, fail = 0, skipped = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const skip = (name, why) => { skipped++; console.log('SKIP  ' + name + '  ' + why); };

/* ------------------------------------------------------------ the stand-in */
const seen = { requests: 0, prompts: [] };
/* A scriptable stub: #64's tests need the model to answer a routing call
   with a chosen JSON and the answer call with chosen text, in order. Each
   chat request shifts one entry off the queue; when the queue is empty the
   stub answers with the least-committal JSON it always did, so every check
   written before #64 behaves exactly as it did. */
const stubScript = [];
const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url.endsWith('/models')) return send(200, { data: [{ id: 'waypoint-copilot-test-model' }] });
    if (req.url.endsWith('/chat/completions')) {
      seen.requests++;
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch { /* recorded below as empty */ }
      seen.prompts.push(String((j.messages || []).map((m) => m.content).join('\n') || ''));
      /* The suite asserts on the REQUEST side — what the model was handed.
         The reply shape is Wave 1's decision, so the stub answers with the
         least committal JSON a client could still display — unless a test
         scripted what the "model" should say (see stubScript above). */
      const scripted = stubScript.length ? String(stubScript.shift()) : null;
      return send(200, {
        choices: [{ message: { content: scripted ?? JSON.stringify({ note: 'stub answer — scope suite only proves the request side' }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    }
    send(404, { error: 'not found' });
  });
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

/* ------------------------------------------------------------- the fixture */
const dir = mkdtempSync(join(tmpdir(), 'wp-copilot-scope-'));
copyFileSync(join(ROOT, 'data', 'workbench.json'), join(dir, 'workbench.json'));
/* The #63 rules read day keys, so the fixture plants its "due tomorrow"
   row on the day the suite computes, not on a date hard-coded months ago. */
const TOMORROW = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
{
  const skeleton = JSON.parse(readFileSync(join(dir, 'workbench.json'), 'utf8'));
  const at = new Date().toISOString();
  /* The suite's own people — the live book's accounts are not a fixture. */
  const seed = adminSeed();
  const bdId = 'u_ahmad', mgrId = 'u_siti';
  skeleton.users = seed.users.concat([
    { id: bdId, name: 'Ahmad Faiz', email: '', role: 'bd', title: 'Account Manager', locked: false, createdAt: at, updatedAt: at },
    { id: mgrId, name: 'Siti Nurhaliza', email: '', role: 'manager', title: 'BD Manager', locked: false, createdAt: at, updatedAt: at },
  ]);
  skeleton.credentials = Object.assign({}, seed.credentials, {
    [bdId]: credentialFor(bdId),
    [mgrId]: credentialFor(mgrId),
  });
  /* Two customers. c_mine is Ahmad's book; c_secret belongs to the admin and
     Ahmad is not on it in any capacity. Its rows carry the needle so that a
     leak is a string match, not a judgement call. */
  skeleton.customers = [
    {
      id: 'c_mine', name: MINE_NAME, industry: 'Retail', hq: 'Kuala Lumpur',
      owner: 'Ahmad Faiz', stance: 'With us', health: 'Healthy', since: 'Mar 2026',
      pains: [MINE_NEEDLE + ' renewal quote is the blocker'],
      contacts: [{ n: 'Ravi Chandran', t: 'CIO', s: 'With us', o: 'Ahmad Faiz', b: 'Decision maker', note: '' }],
      opps: ['o_mine', 'o_late'], timeline: [], updatedAt: at,
    },
    {
      id: 'c_secret', name: SECRET_NAME, industry: 'Logistics', hq: 'Johor Bahru',
      owner: ADMIN.name, stance: 'Exploring', health: 'Watch', since: 'Aug 2026',
      pains: [SECRET_NEEDLE + ' platform migration is confidential'],
      contacts: [{ n: 'Hidden Contact', t: 'CEO', s: 'With us', o: ADMIN.name, b: 'Decision maker', note: SECRET_NEEDLE + ' note' }],
      opps: [], timeline: [], confidential: false, updatedAt: at,
    },
    /* c_conf is readable by its owner and by every see-all role — confidential
       narrows what goes to a model, not who may open the record. Its rows
       carry their own needle so this, too, is a string match, not a judgement. */
    {
      id: 'c_conf', name: CONF_NAME, industry: 'Banking', hq: 'Kuala Lumpur',
      owner: ADMIN.name, stance: 'Exploring', health: 'Healthy', since: 'Sep 2026',
      pains: [CONF_NEEDLE + ' central bank audit is private'],
      contacts: [], opps: [], timeline: [], confidential: true, updatedAt: at,
    },
    /* c_lapsed is Ahmad's too, but a quiet one: no interaction ever recorded,
       and its one deal has sat untouched since May. It is the row the
       no-activity AND the no-follow-up rules must both name, while c_mine —
       fresh deal, interaction 18 days ago — must stay off both lists. That
       contrast is what tells the two rules apart. */
    {
      id: 'c_lapsed', name: 'Lapsed Trading Sdn Bhd', industry: 'Manufacturing', hq: 'Shah Alam',
      owner: 'Ahmad Faiz', stance: 'With us', health: 'Watch', since: 'Jan 2026',
      pains: [], contacts: [], opps: ['o_lapsed'], timeline: [], updatedAt: '2026-05-01T00:00:00.000Z',
    },
  ];
  skeleton.interactions = [
    { id: 'm_mine', c: 'c_mine', t: MINE_NEEDLE + ' workshop', d: '2026-09-01', loc: '', att: 'Ravi Chandran', ours: 'Ahmad Faiz', sum: '', out: '' },
    { id: 'm_secret', c: 'c_secret', t: SECRET_NEEDLE + ' strategy session', d: '2026-09-02', loc: '', att: 'Hidden Contact', ours: ADMIN.name, sum: SECRET_NEEDLE + ' summary', out: '' },
  ];
  skeleton.opps = {
    o_mine: { id: 'o_mine', c: 'c_mine', t: MINE_NEEDLE + ' billing migration', v: 500000, stage: 'Interested', close: '2026-12-01', desc: '', updatedAt: at },
    /* o_late: open, close date already past — the overdue rule's row. Its own
       record is untouched since June, so no-activity names it too, but its
       customer WAS followed up with 18 days ago, so no-follow-up must not. */
    o_late: { id: 'o_late', c: 'c_mine', t: MINE_NEEDLE + ' overdue migration', v: 300000, stage: 'Interested', close: '2026-09-10', desc: '', updatedAt: '2026-06-01T00:00:00.000Z' },
    /* o_lapsed: the oldest open deal in Ahmad's view — the stalled rule's
       "sat longest" — and quiet on every axis. */
    o_lapsed: { id: 'o_lapsed', c: 'c_lapsed', t: MINE_NEEDLE + ' lapsed platform deal', v: 120000, stage: 'Evaluating', close: '2026-12-15', desc: '', updatedAt: '2026-05-01T00:00:00.000Z' },
    o_secret: { id: 'o_secret', c: 'c_secret', t: SECRET_NEEDLE + ' platform deal', v: 900000, stage: 'Interested', close: '2026-11-01', desc: SECRET_NEEDLE },
    o_conf: { id: 'o_conf', c: 'c_conf', t: CONF_NEEDLE + ' audit support', v: 250000, stage: 'Interested', close: '2027-01-01', desc: CONF_NEEDLE },
  };
  skeleton.steps = [
    { id: 's_conf', c: 'c_conf', o: 'o_conf', t: CONF_NEEDLE + ' briefing pack', exec: ADMIN.name, track: ADMIN.name, due: '2026-10-01', from: 'us', p: 'p2', createdAt: at, updatedAt: at },
    /* s_wait is in the customer's court and not done — the waiting rule's
       row. s_tom is ours and due tomorrow — the due-tomorrow rule's row. */
    { id: 's_wait', c: 'c_mine', o: 'o_mine', t: MINE_NEEDLE + ' countersigned SOW', exec: 'Ravi Chandran', track: 'Ahmad Faiz', due: '2026-09-25', from: 'customer', p: 'p2', createdAt: at, updatedAt: at },
    { id: 's_tom', c: 'c_mine', o: 'o_mine', t: MINE_NEEDLE + ' demo prep', exec: 'Ahmad Faiz', track: 'Ahmad Faiz', due: TOMORROW, from: 'us', p: 'p1', createdAt: at, updatedAt: at },
  ];
  skeleton.team = [];
  skeleton.audit = [];
  skeleton.files = [];
  skeleton.watch = [];
  writeFileSync(join(dir, 'workbench.json'), JSON.stringify(skeleton));
}

/* The .env in a working checkout carries a REAL model endpoint, and a server
   started with it is env-managed: /api/ai/config answers 409 and the stub can
   never be pointed at. This suite strips the AI_* variables from the child's
   environment — the data/ai.json it then writes is the only model the server
   knows, which is exactly what the request-side assertions need. */
const SPAWN_ENV = { ...process.env };
for (const k of Object.keys(SPAWN_ENV)) if (k.startsWith('AI_')) delete SPAWN_ENV[k];

const srv = await startServer({
  spawnBin: process.execPath,
  args: [join(ROOT, 'server', 'server.mjs')],
  env: {
    ...SPAWN_ENV,
    WB_DATA_DIR: dir,
    PORT: String(PORT),
    WB_TLS: '0',
    WB_ORIGINS: ORIGIN,
    /* The one seam: loopback only, and only for this process. See server/ai.mjs. */
    WB_TEST_AI: '1',
  },
  port: PORT,
});

/* ---------------------------------------------------------------- sessions */
async function sessionAs(userId) {
  const r = await signIn(ORIGIN, { userId });
  return { jar: { v: r.cookie }, api: authed(ORIGIN, { v: r.cookie }) };
}

/* Point the server's model at the stub, as an admin does in the product. */
{
  const r = await signIn(ORIGIN);
  const api = authed(ORIGIN, { v: r.cookie });
  const cfg = await api('/api/ai/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: STUB, model: 'waypoint-copilot-test-model', key: KEY }),
  });
  check('the stub endpoint is configured for this server', cfg.status === 200, 'status ' + cfg.status);
}

/* ------------------------------------------- #57 the static rules (§2, §26) */
/* These scans read the server's own source, because the shape of the rule is
   easier to hold onto than the shape of every future implementation:
   an AI module may not write the business tables, and no server file may
   start an interval. Both scans are proven against a deliberately guilty
   sample first — a guard that cannot see a violation is a guard that proves
   nothing. Three known limits, stated plainly:
   - a copilot implemented inside server.mjs is invisible to the first scan;
     the runtime book-snapshot check below does not care where the code lives.
   - setTimeout is NOT banned: company-lookup.mjs uses one legitimately as an
     abort guard. setInterval is the shape a background scanner must take; a
     sleep-loop is caught at runtime by the idle watch below.
   - the write scan pattern matches ANY `something.customers =` — including
     the legitimate kind that BUILDS the model's context object. The copilot
     is therefore written to construct its context as a literal
     (`const ctx = { customers: [...] }`), never as field assignments; that
     convention is part of task #61's contract. */
const scanForDirectWrites = (source) => GUARDED_TABLES.flatMap((t) => {
  const hits = [];
  if (new RegExp('\\.' + t + '\\s*\\.(push|splice|unshift|shift|pop)\\s*\\(').test(source)) hits.push(t + ' mutated');
  if (new RegExp('\\.' + t + '\\s*=\\s*[^=]').test(source)) hits.push(t + ' reassigned');
  if (new RegExp('\\.' + t + '\\s*\\[[^\\]]*\\]\\s*=[^=]').test(source)) hits.push(t + ' keyed-write');
  if (new RegExp('delete\\s+[^;]*\\.' + t + '\\b').test(source)) hits.push(t + ' deleted');
  return hits;
});
const scanForSchedulers = (source) => (/\bsetInterval\s*\(/.test(source) ? ['setInterval'] : []);
{
  const SAMPLE = `
    function invented(copilot, state) {
      state.customers.push(copilot.dreamed.customer);
      state.opps['o_new'] = { id: 'o_new' };
      state.steps = state.steps.concat(copilot.dreamed.steps);
      delete state.interactions[0];
    }
    setInterval(scanBookForInsights, 60000);
  `;
  const w = scanForDirectWrites(SAMPLE);
  check('the direct-write scan can see a violation (self-proof)', w.length >= 4, w.join(', '));
  check('the scheduler scan can see a violation (self-proof)', scanForSchedulers(SAMPLE).length === 1);
}
{
  const AI_MODULES = ['ai.mjs', 'company-lookup.mjs', 'copilot.mjs']
    .filter((f) => existsSync(join(ROOT, 'server', f)));
  const writes = [], intervals = [];
  for (const f of AI_MODULES) {
    const src = readFileSync(join(ROOT, 'server', f), 'utf8');
    writes.push(...scanForDirectWrites(src).map((h) => f + ': ' + h));
    intervals.push(...scanForSchedulers(src).map((h) => f + ': ' + h));
  }
  check('no AI module writes the business tables', writes.length === 0,
    writes.length ? writes.join(' | ') : AI_MODULES.join(', ') + ' clean');
  check('no AI module starts an interval', intervals.length === 0,
    intervals.length ? intervals.join(' | ') : 'clean');
  /* The whole server directory, because a scheduler could live anywhere. */
  const all = readdirSync(join(ROOT, 'server')).filter((f) => f.endsWith('.mjs'));
  const offenders = all.filter((f) => scanForSchedulers(readFileSync(join(ROOT, 'server', f), 'utf8')).length);
  check('no server file starts an interval', offenders.length === 0,
    offenders.length ? offenders.join(', ') : all.length + ' files clean');
}

/* ------------------------------------- #62 one transport, and it shrinks */
/* /api/ai/complete is the legacy door: it trusts the prompt the client
   wrote, where the copilot's door assembles the context from what the
   caller may see. The three asks that still speak it are allowed to — the
   account brief, the Prepare sheet, the stage-suggest — and the guard here
   is that no fourth one appears: the count only ever goes DOWN. Both
   shipped copies of the page are scanned, because a fix applied to the
   working file and not to dist ships half a product; and the counters are
   proven against a deliberately guilty sample first, because a guard that
   cannot count proves nothing. When a call site migrates to the copilot,
   its anchor below is retired with it — on purpose, so the migration is a
   change somebody made, never a slow drift. */
{
  const countOf = (src, needle) => src.split(needle).length - 1;
  const SAMPLE = `
    async function askModel(p){ const r = await fetch('/api/ai/complete', {}); return r; }
    await askModel('one'); text = await askModel('two');
  `;
  check('the transport counter counts (self-proof)', countOf(SAMPLE, "fetch('/api/ai/complete'") === 1);
  check('the call-site counter counts (self-proof)', countOf(SAMPLE, 'await askModel(') === 2);
  const PAGES = ['Waypoint-v1.html', 'dist/index.html'].filter((f) => existsSync(join(ROOT, f)));
  for (const f of PAGES) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    const transports = countOf(src, "fetch('/api/ai/complete'");
    const calls = countOf(src, 'await askModel(');
    check(f + ' reaches the model through exactly one transport', transports === 1,
      transports + ' fetch(es) of /api/ai/complete');
    check(f + ' holds the legacy ask sites at a maximum of three', calls <= 3,
      calls + ' askModel call site(s)');
    check(f + ' still names the account-brief ask it shipped with',
      src.includes('Write a brief of at most 90 words'));
    check(f + ' still names the stage-suggest ask it shipped with',
      src.includes('which stage should the opportunity move to'));
  }
}

/* ------------------------------------------ #57 only when asked (§2, §27) */
{
  /* Self-proof first: an idle count of zero only means something if the
     counter counts. Send one request straight at the stub and watch it tick. */
  const t0 = seen.requests;
  await fetch(STUB + '/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  check('the stub counter counts (self-proof)', seen.requests === t0 + 1, t0 + ' -> ' + seen.requests);
  /* Then the real question: a server with a model configured and nobody
     asking must send nothing. 2.5s covers a poll cycle in the 1–5s band the
     brief contemplates for page-side polling (§21); setInterval is banned
     outright by the static scan above, so what this window catches is the
     sleep-loop and anything else that reaches for the model uninvited. */
  const i0 = seen.requests;
  await new Promise((r) => setTimeout(r, 2500));
  check('an idle server sends nothing to the model', seen.requests === i0,
    (seen.requests - i0) + ' call(s) during 2.5s idle');
}

/* The book-snapshot comparator, proven before it is trusted: mutate one
   field in each guarded table of an in-memory copy and demand all four be
   named. Without this, "nothing changed" could just mean the comparator
   cannot see. */
const diffTables = (a, b) => GUARDED_TABLES.filter((t) => JSON.stringify(a?.[t]) !== JSON.stringify(b?.[t]));
{
  const base = JSON.parse(readFileSync(join(dir, 'workbench.json'), 'utf8'));
  const copy = JSON.parse(JSON.stringify(base));
  copy.customers.find((c) => c.id === 'c_mine').stance = 'Exploring';
  copy.opps.o_mine.v = 1;
  copy.steps.push({ id: 's_x', c: 'c_mine', t: 'invented by a model' });
  copy.interactions.push({ id: 'm_x', c: 'c_mine', t: 'invented by a model' });
  const moved = diffTables(base, copy);
  check('the book-snapshot comparator can see a change (self-proof)',
    moved.length === GUARDED_TABLES.length, 'named: ' + moved.join(', '));
}

/* ------------------------------------------------------- does it exist yet? */
const bdSession = await sessionAs('u_ahmad');
const probe = await bdSession.api('/api/ai/copilot', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'brief', targetId: 'c_mine' }),
});
const BUILT = probe.status !== 404;
if (!BUILT) {
  console.log('NOTE  /api/ai/copilot is not built yet (task #61 builds it).');
  console.log('      The scope contract below activates the moment the endpoint answers.');
}

/* ------------------------------------- #63 the deterministic first layer */
/* §19.1: "These should be answered directly by application/database logic.
   Do NOT call AI." A promise about a model can only be proven where the
   model can be counted, so this block lives here beside the stub: every
   deterministic ask must answer synchronously, spend ZERO model calls,
   create ZERO tasks, and cite the real rows it read — the needles are the
   rows. A miss must say so, because a half-guessed match would route the
   caller away from the classifier that actually knows (#64). */
{
  /* The engine itself, proven awake without a server in the way — if this
     fails, a red HTTP check says nothing about the route. */
  {
    const awake = answerByRule('What am I waiting for?', {
      customers: [{ id: 'c1', name: 'Acme' }],
      opps: {}, interactions: [], config: { stages: ['Interested'] },
      steps: [{ c: 'c1', t: 'the countersign', from: 'customer', due: '' }],
    });
    check('the rule engine answers on its own (self-proof)',
      awake?.kind === 'rule' && Array.isArray(awake.citations) && awake.citations.length === 1,
      'kind ' + (awake && awake.kind) + ', ' + (awake ? awake.citations.length : '?') + ' citation(s)');
    check('and it stays quiet for a question it does not know (self-proof)',
      answerByRule('tell me a joke', { customers: [], opps: {}, interactions: [], steps: [] })?.kind === 'unmatched');
  }
  /* The one-call guard: the copilot module names the model transport from
     exactly two places — the import, and the echo probe that exists to
     prove the pipeline. A rule that reached for the model would make it
     three, and the counter is proven against a guilty sample first because
     a counter that cannot count proves nothing. */
  {
    const countOf = (s, n) => s.split(n).length - 1;
    const GUILTY = "import { aiComplete } from './ai.mjs';\nawait aiComplete('a'); await aiComplete('b');";
    check('the aiComplete counter counts (self-proof)', countOf(GUILTY, 'aiComplete') === 3);
    const src = readFileSync(join(ROOT, 'server', 'copilot.mjs'), 'utf8');
    /* Three, and only three: the import, the echo probe that proves the
       transport, and the classifier's single call (#64). Every other model
       reach lives behind classifyAsk — a rule answer (#63) still costs
       zero, and the fallback answer call lives in server.mjs where the
       executor runs. */
    check('the copilot reaches the model from the import, the echo probe and the classifier alone',
      countOf(src, 'aiComplete') === 3, countOf(src, 'aiComplete') + ' reference(s) — the import, the echo probe and the classifier are the only ones');
  }

  const ask = (question, api) => (api || bdSession.api)('/api/ai/copilot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'answer', question }),
  });
  /* The BUILT probe above fires a brief task whose model call is still in
     the air; a snapshot taken now would charge that call to the asks below.
     Drain the task table first — every ask this block makes must be the
     ONLY thing moving the two counters, or the zeros prove nothing. */
  for (let i = 0; i < 30; i++) {
    const tasks = (await (await bdSession.api('/api/ai/tasks?since=0')).json()).tasks;
    if (!tasks.some((t) => t.state === 'queued' || t.state === 'processing')) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  /* The two counters this whole block exists to hold at zero. */
  const prompts0 = seen.prompts.length;
  const tasks0 = (await (await bdSession.api('/api/ai/tasks?since=0')).json()).tasks.length;

  /* waiting — the palette's first question, answered from the customer's
     court, with the step it read cited by its title. */
  {
    const r = await ask('What am I waiting for?');
    const j = await r.json().catch(() => ({}));
    check('waiting answers as a rule, synchronously',
      r.status === 200 && j.ok === true && j.kind === 'rule' && typeof j.answer === 'string' && !('task' in j),
      'status ' + r.status + ', kind ' + j.kind + ('task' in j ? ', but a task came back' : ''));
    check('waiting cites the customer-court step it read',
      (j.citations || []).some((c) => String(c).includes('countersigned SOW')),
      JSON.stringify(j.citations || []));
  }
  /* due tomorrow — §19.1's third example, on a row planted for this day. */
  {
    const r = await ask('Which Next Steps are due tomorrow?');
    const j = await r.json().catch(() => ({}));
    check('due-tomorrow answers as a rule and cites the step due tomorrow',
      r.status === 200 && j.kind === 'rule' && (j.citations || []).some((c) => String(c).includes('demo prep')),
      'kind ' + j.kind + ', ' + JSON.stringify(j.citations || []));
  }
  /* overdue — §19.1's first example. o_late's close date is past; o_mine's
     and o_lapsed's are not. */
  {
    const r = await ask('Which Opportunities are overdue?');
    const j = await r.json().catch(() => ({}));
    const cites = (j.citations || []).map(String).join(' | ');
    check('overdue answers as a rule and names the past-close deal',
      r.status === 200 && j.kind === 'rule' && cites.includes('overdue migration'),
      'kind ' + j.kind + ', ' + cites);
    check('overdue leaves the not-yet-due deals alone',
      !cites.includes('billing migration') && !cites.includes('lapsed platform deal'), cites);
  }
  /* my customers — §19.1's second example, through the scoping: Ahmad hears
     his two, and neither wall's name appears in HIS answer. */
  {
    const r = await ask('Which customers belong to me?');
    const j = await r.json().catch(() => ({}));
    const text = String(j.answer || '');
    check('my-customers answers as a rule with the caller\u2019s own book',
      r.status === 200 && j.kind === 'rule' && text.includes('Visible Retail') && text.includes('Lapsed Trading'),
      'kind ' + j.kind + ', answer: ' + (text || '(none)').slice(0, 120));
    check('a scoped caller\u2019s rule answer names no customer they cannot see',
      !text.includes('Zenith') && !text.includes('Straits'), text.slice(0, 120));
  }
  /* The confidential wall governs models, not readers: the owner asking a
     deterministic question hears about their confidential customer — and
     it still costs no model call, which is the pairing that makes this
     correct rather than a leak. */
  {
    const owner = await signIn(ORIGIN);
    const ownerApi = authed(ORIGIN, { v: owner.cookie });
    const r = await ask('Which customers belong to me?', ownerApi);
    const j = await r.json().catch(() => ({}));
    check('a confidential customer is answered for its owner, deterministically',
      r.status === 200 && j.kind === 'rule' && String(j.answer || '').includes('Straits Confidential Bank'),
      'kind ' + j.kind + (j.kind === 'rule' ? ', answer names it' : ''));
  }
  /* no activity — §19.1's fourth example. Record quietness names both stale
     deals; the fresh one stays off the list. */
  {
    const r = await ask('Which Opportunities have no activity for 30 days?');
    const j = await r.json().catch(() => ({}));
    const cites = (j.citations || []).map(String).join(' | ');
    check('no-activity names both stale deals',
      r.status === 200 && j.kind === 'rule' && cites.includes('overdue migration') && cites.includes('lapsed platform deal'),
      'kind ' + j.kind + ', ' + cites);
    check('no-activity leaves the freshly-touched deal off the list',
      !cites.includes('billing migration'), cites);
  }
  /* no follow-up — Test 7. Only the customer nobody has called: c_mine was
     followed up with 18 days ago, so o_late must NOT appear here even
     though no-activity named it above. That is the two rules told apart. */
  {
    const r = await ask('Which Opportunities have no recent follow-up?');
    const j = await r.json().catch(() => ({}));
    const cites = (j.citations || []).map(String).join(' | ');
    check('no-follow-up names only the customer nobody has called',
      r.status === 200 && j.kind === 'rule' && cites.includes('lapsed platform deal') && !cites.includes('overdue migration') && !cites.includes('billing migration'),
      'kind ' + j.kind + ', ' + cites);
  }
  /* pains — the palette's third question, citing the recorded pain itself. */
  {
    const r = await ask('Show me every recorded pain point');
    const j = await r.json().catch(() => ({}));
    check('pains answers as a rule and cites the recorded pain',
      r.status === 200 && j.kind === 'rule' && (j.citations || []).some((c) => String(c).includes(MINE_NEEDLE)),
      'kind ' + j.kind + ', ' + JSON.stringify((j.citations || []).map(String)).slice(0, 120));
  }
  /* stalled — the palette's second question. Three open deals in Ahmad's
     view; the one sat longest since May is the lapsed platform deal. */
  {
    const r = await ask('Which opportunities have not progressed recently?');
    const j = await r.json().catch(() => ({}));
    const text = String(j.answer || '');
    check('stalled counts the open deals and names the one sat longest',
      r.status === 200 && j.kind === 'rule' && text.includes('3 open opportunit') && text.includes('lapsed platform deal'),
      'kind ' + j.kind + ', answer: ' + text.slice(0, 120));
  }
  /* The door's own discipline: an ask without a question is a 400, and an
     unsigned ask is a 401 — the same door the task pipeline uses. */
  {
    const r = await bdSession.api('/api/ai/copilot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'answer', question: '   ' }),
    });
    check('an answer ask with no question is refused', r.status === 400, 'status ' + r.status);
    const unsigned = await fetch(ORIGIN + '/api/ai/copilot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ action: 'answer', question: 'What am I waiting for?' }),
    });
    check('an unsigned answer ask is refused', unsigned.status === 401, 'status ' + unsigned.status);
  }
  /* The last word is the pair this block exists for: nothing reached the
     model and nothing landed in the task table, across every ask above. */
  check('a deterministic ask never reaches the model', seen.prompts.length === prompts0,
    (seen.prompts.length - prompts0) + ' call(s) across every rule ask');
  {
    const tasks1 = (await (await bdSession.api('/api/ai/tasks?since=0')).json()).tasks.length;
    check('a deterministic ask never becomes a task', tasks1 === tasks0,
      tasks0 + ' task(s) before, ' + tasks1 + ' after');
  }
  /* After the zeros are banked: a question the table does not know is no
     longer a dead end (#64) — it becomes a classified task, asynchronously,
     so it must stop answering synchronously. The task it creates and the
     calls it costs are drained and proven in the #64 block below, where the
     stub can be scripted to answer the routing call. */
  {
    const r = await ask('Tell me a joke about clouds');
    const j = await r.json().catch(() => ({}));
    check('a question no rule covers does not guess synchronously',
      r.status === 200 && j.ok === true && j.kind !== 'rule', 'status ' + r.status + ', kind ' + j.kind);
  }
}

/* --------------------------------------- #64 the classifier behind the miss */
/* §19.2: "determine the user's intent and retrieve relevant data before
   invoking AI." The rules answer what a keyword can place; everything else
   goes to ONE fast structured call that says which handler the ask belongs
   to, and then to the smallest context that classification justifies. The
   promises proven here, with the stub scripted to play the model's part:
     - an unmatched ask becomes a task, and the answer lands in its result;
     - the classifier's menu holds the caller's own targets and NOTHING
       confidential — the wall applies to a menu entry as much as a record;
     - a made-up kind or id degrades to global, never crashes, never routes
       to a record that was never offered;
     - output that is not JSON at all fails the task honestly, retryably;
     - two different questions are two tasks; the same question twice while
       one runs is one task (the dedupe key now carries the question). */
{
  const ask = (question, api) => (api || bdSession.api)('/api/ai/copilot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'answer', question }),
  });
  /* The task poll is per-session by design ("a session may only ever read
     its own tasks") — so the caller who asked must also be the caller who
     waits, hence the api parameter. */
  const myTasks = async (api) => (await (await (api || bdSession.api)('/api/ai/tasks?since=0')).json()).tasks;
  const waitDone = async (id, api) => {
    for (let i = 0; i < 40; i++) {
      const t = (await myTasks(api)).find((x) => x.id === id);
      if (t && (t.state === 'completed' || t.state === 'failed')) return t;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  };
  /* Drain whatever the #63 block's joke ask and the earlier probes left in
     flight, so the counts below measure only what this block asks for. */
  for (let i = 0; i < 40; i++) {
    const inflight = (await myTasks()).filter((t) => t.state === 'queued' || t.state === 'processing');
    if (!inflight.length) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const calls0 = seen.prompts.length;
  /* The admin's own asks (test 2) are one place a prompt may LEGALLY carry
     c_secret — it is the admin's book. #77's manager pipeline ask (4b) is
     the other: the manager reads the same whole book (§17), so its facts
     legally carry the non-confidential needle too. The stub cannot see who
     asked, so the ranges are recorded here and the final sweep steps around
     them. */
  const legalRanges = [];

  /* 1 — the happy path: a global question, routed and answered from the
         roster, with the answer landing in the task's result. */
  {
    stubScript.push(JSON.stringify({ kind: 'global', entities: ['quarter summary'] }));
    stubScript.push('A summarised quarter, from your records only.');
    const r = await ask('Summarise my quarter for the board');
    const j = await r.json().catch(() => ({}));
    check('an unmatched ask becomes a task',
      r.status === 200 && j.ok === true && j.kind === 'task' && j.task && j.task.id,
      'status ' + r.status + ', kind ' + j.kind);
    const done = await waitDone(j.task.id);
    check('the classified ask completes with the model\u2019s answer in its result',
      done?.state === 'completed' && done?.result?.classified?.kind === 'global'
        && String(done?.result?.answer || '').includes('summarised quarter'),
      done?.state + ' / ' + String(done?.result?.answer || '').slice(0, 60));
    check('and the answer carries citations from the roster it read',
      Array.isArray(done?.result?.citations) && done.result.citations.some((c) => String(c).includes('Visible Retail')),
      JSON.stringify((done?.result?.citations || []).map(String)).slice(0, 100));
    /* The classifier call plus the answer call: exactly two, no more. */
    check('a global ask costs exactly the classifier and the answer', seen.prompts.length === calls0 + 2,
      (seen.prompts.length - calls0) + ' call(s)');
  }
  /* 2 — the menu is the caller's own book, and the confidential wall
         covers menu entries. The admin sees c_secret (not confidential) and
         c_conf (confidential): the first may be offered to the model, the
         second may not — not its name, not in a list. */
  {
    const owner = await signIn(ORIGIN);
    const ownerApi = authed(ORIGIN, { v: owner.cookie });
    stubScript.push(JSON.stringify({ kind: 'global' }));
    stubScript.push('A global answer.');
    const adminRange = { from: seen.prompts.length };
    const r = await ask('What is going on across everything I look at?', ownerApi);
    const j = await r.json().catch(() => ({}));
    const done = j.task ? await waitDone(j.task.id, ownerApi) : null;
    adminRange.to = seen.prompts.length;
    legalRanges.push(adminRange);
    check('an admin\u2019s unmatched ask also completes', done?.state === 'completed', done?.state);
    /* The routing prompt is the LAST BUT ONE the stub received (the answer
       call came after it); the roster prompt carries the customer names. */
    const routingPrompt = seen.prompts[seen.prompts.length - 2] || '';
    const rosterPrompt = seen.prompts[seen.prompts.length - 1] || '';
    check('the classifier\u2019s menu offers the caller\u2019s visible targets',
      routingPrompt.includes('Zenith') && routingPrompt.includes(MINE_NAME),
      (routingPrompt.includes('Zenith') ? 'secret-visible; ' : '') + (routingPrompt.includes(MINE_NAME) ? 'mine-visible' : 'mine-missing'));
    check('and a confidential customer never appears in the classifier\u2019s menu',
      !routingPrompt.includes('Straits') && !routingPrompt.includes(CONF_NEEDLE),
      routingPrompt.includes('Straits') ? 'LEAKED: the confidential name was offered' : 'absent');
    check('nor in the roster the fallback answer reads',
      !rosterPrompt.includes('Straits') && !rosterPrompt.includes(CONF_NEEDLE),
      rosterPrompt.includes('Straits') ? 'LEAKED: the confidential name reached the answer call' : 'absent');
  }
  /* 3 — a made-up kind degrades to global, not to a crash. (The question is
         chosen to stay off the keyword rules — "my book" would be answered
         by the my-customers rule and never reach the classifier.) */
  {
    stubScript.push(JSON.stringify({ kind: 'banana', targetId: 'c_mine' }));
    stubScript.push('The degraded global answer.');
    const r = await ask('What is the mood of the portfolio?');
    const j = await r.json().catch(() => ({}));
    const done = j.task ? await waitDone(j.task.id) : null;
    check('a made-up kind degrades to global and still answers',
      done?.state === 'completed' && done?.result?.classified?.kind === 'global'
        && String(done?.result?.answer || '').includes('degraded global'),
      done?.state + ' / kind ' + done?.result?.classified?.kind);
  }
  /* 4 — a hallucinated id is not on the menu, so it is no id at all. (Same
         care with the wording: "tell me … account" would hit the
         my-customers rule before the classifier ever saw it.) */
  {
    stubScript.push(JSON.stringify({ kind: 'customer', targetId: 'c_ghost' }));
    stubScript.push('The ghost-routed global answer.');
    const r = await ask('What is happening with the ghost account?');
    const j = await r.json().catch(() => ({}));
    const done = j.task ? await waitDone(j.task.id) : null;
    check('an id that was never offered degrades to global',
      done?.state === 'completed' && done?.result?.classified?.kind === 'global',
      done?.state + ' / kind ' + done?.result?.classified?.kind);
  }
  /* 4b — #77 (§17/§18): the manager's pipeline ask. Management's global
         questions name no customer, so retrieval alone answers nothing —
         the manager's ask must arrive carrying the pipeline picture. It is
         a read on the whole book the manager can see, and §18's rule rides
         with it: no system or security field travels, business records
         only. The wording again steps around the rule table's "my/me"
         tripwire. */
  {
    const mgrPipe = await sessionAs('u_siti');
    const revBefore = (await (await mgrPipe.api('/api/data')).json()).rev;
    stubScript.push(JSON.stringify({ kind: 'global' }));
    stubScript.push('The pipeline at a glance, from the records only.');
    const mgrRange = { from: seen.prompts.length };
    const r = await ask('What does the current business pipeline look like?', mgrPipe.api);
    const j = await r.json().catch(() => ({}));
    const done = j.task ? await waitDone(j.task.id, mgrPipe.api) : null;
    mgrRange.to = seen.prompts.length;
    legalRanges.push(mgrRange);
    const answerPrompt = seen.prompts[seen.prompts.length - 1] || '';
    check('a manager\u2019s pipeline ask is answered with the pipeline facts',
      done?.state === 'completed'
        && answerPrompt.includes('Pipeline by stage:')
        && answerPrompt.includes(MINE_NAME),
      done?.state + ' / ' + (answerPrompt.includes('Pipeline by stage:') ? 'facts present' : 'no facts in prompt'));
    check('and the picture stays business-only — no system or security field travels',
      !/password|credential|apikey|lockout|session secret/i.test(answerPrompt)
        && !answerPrompt.includes(CONF_NEEDLE),
      '');
    /* §17's "Manager remains read-only", refereed by the revision number:
       the overview came and went, and the book never moved. */
    const revAfter = (await (await mgrPipe.api('/api/data')).json()).rev;
    check('the manager\u2019s overview is strictly read-only',
      revAfter === revBefore,
      'rev ' + revBefore + ' -> ' + revAfter);
  }
  /* 5 — routed to a real customer: with #65's assembler landed, the ask is
         answered from the §19.4 briefing — records, citations with ids,
         and the honest interim state is retired. */
  {
    stubScript.push(JSON.stringify({ kind: 'customer', targetId: 'c_mine' }));
    stubScript.push('A briefing answer, assembled from the records.');
    const routed0 = seen.prompts.length;
    const r = await ask('How do things stand with Visible Retail?');
    const j = await r.json().catch(() => ({}));
    const done = j.task ? await waitDone(j.task.id) : null;
    check('a customer ask is answered from the assembled briefing',
      done?.state === 'completed' && done?.result?.classified?.kind === 'customer'
        && done?.result?.classified?.targetId === 'c_mine'
        && String(done?.result?.answer || '').includes('assembled from the records')
        && (done?.result?.citations || []).some((c) => String(c).includes('(c_mine)')),
      done?.state + ' / ' + String(done?.result?.answer || '').slice(0, 60));
    check('and its citations name the records, with ids',
      (done?.result?.citations || []).some((c) => /^Opportunity · /.test(String(c)) && String(c).includes('(o_mine)')),
      JSON.stringify((done?.result?.citations || []).map(String)).slice(0, 120));
    /* The briefing reached the model too — the second prompt of this ask is
       the answer call, and it must carry the assembled facts. */
    check('the assembled briefing really reached the model',
      (seen.prompts[routed0 + 1] || '').includes('Visible Retail')
        && (seen.prompts[routed0 + 1] || '').includes('Open opportunities'),
      'answer prompt ' + (seen.prompts[routed0 + 1] || '').slice(0, 60));
    /* Routed asks now cost the classification AND the answer — two. */
    check('a customer ask costs the classification and the answer',
      seen.prompts.length === routed0 + 2, (seen.prompts.length - routed0) + ' call(s)');
  }
  /* 6 — output that is not JSON at all: the task fails, honestly and
         retryably, and nothing crashes. */
  {
    stubScript.push('I have no idea what you mean.');
    const r = await ask('What does the future hold?');
    const j = await r.json().catch(() => ({}));
    const done = j.task ? await waitDone(j.task.id) : null;
    check('a model that will not route fails the task honestly',
      done?.state === 'failed' && done?.retryable === true && /rout/i.test(String(done?.error || '')),
      done?.state + ' / ' + String(done?.error || '').slice(0, 60));
  }
  /* 7 — the dedupe key now carries the question: the same question twice
         while one runs is one task; a different question is its own. */
  {
    stubScript.push(JSON.stringify({ kind: 'global' }));
    stubScript.push('A slow answer, part one.');
    const first = await (await ask('What should I read before Monday?')).json().catch(() => ({}));
    const second = await (await ask('What should I read before Monday?')).json().catch(() => ({}));
    check('the same question asked twice is one task',
      first.task?.id && first.task.id === second.task?.id && (first.reused || second.reused),
      String(first.task?.id) + (second.reused ? ' (second ask reused it)' : ''));
    await waitDone(first.task.id);
    stubScript.push(JSON.stringify({ kind: 'global' }));
    stubScript.push('Another answer, for another question.');
    const other = await (await ask('What should I read before Friday?')).json().catch(() => ({}));
    check('a different question is a different task',
      other.task?.id && other.task.id !== first.task.id && !other.reused,
      String(other.task?.id) + ' vs ' + String(first.task?.id));
    await waitDone(other.task.id);
  }
  /* The scoped caller's asks never leaked a wall's name into any prompt
     this block generated. The admin's and manager's own ranges are stepped
     around — c_secret in their facts is the design working, not a leak;
     their prompts were proven clean of the CONFIDENTIAL wall by their own
     tests (the confidential wall holds for every role, whole view or not). */
  {
    const leaks = seen.prompts
      .filter((p, i) => !legalRanges.some((r) => i >= r.from && i < r.to))
      .filter((p) =>
        p.includes(SECRET_NEEDLE) || p.includes(CONF_NEEDLE)
        || p.toLowerCase().includes('zenith-needle') || p.toLowerCase().includes('classified-needle'));
    check('the classifier era never sends a needle to the model (final sweep)',
      leaks.length === 0, leaks.length ? leaks.length + ' prompt(s) leaked' : 'clean');
  }
}

/* --------------------------------------- #65 the three context assemblers */
/* §19.3/§19.4: only what is needed, within the limits the spec names. The
   assemblers are proven directly first — a red HTTP check would say nothing
   about the function — then end-to-end behind the classifier: an
   opportunity ask answered from its briefing, and a global ask whose
   question names a record, answered by retrieval rather than a roster. */
{
  /* A self-contained mini book: 12 open opportunities, 7 meetings, 12 open
     steps under one customer, a confidential neighbour, and a product on
     the first deal — everything the limits and the wall need to prove. */
  const mkOpps = () => {
    const m = {};
    for (let i = 0; i < 12; i++) {
      m['vo' + i] = { id: 'vo' + i, c: 'vc', t: 'deal ' + i, v: 1000 * (i + 1), stage: 'Interested', close: '2026-12-01', items: i === 0 ? ['p1'] : [] };
    }
    m.vo_conf = { id: 'vo_conf', c: 'vconf', t: 'the confidential deal', v: 5, stage: 'Interested' };
    return m;
  };
  const mini = {
    config: { stages: ['Interested', 'Evaluating'] },
    customers: [
      { id: 'vc', name: 'Vista Corp', industry: 'Retail', stance: 'Warm', health: 'Green', hq: 'KL',
        pains: ['renewal cost'], contacts: [{ n: 'Ada', t: 'CTO', s: 'With us' }],
        timeline: [{ d: '2026-09-01', k: 'note', t: 'kicked off' }] },
      { id: 'vconf', name: 'Vault Secret Bank', industry: 'Banking', confidential: true },
    ],
    opps: mkOpps(),
    interactions: Array.from({ length: 7 }, (_, i) => ({ id: 'vm' + i, c: 'vc', t: 'meeting ' + i, d: '2026-08-0' + (i + 1), out: '' })),
    steps: Array.from({ length: 12 }, (_, i) => ({ id: 'vs' + i, c: 'vc', t: 'step ' + i, due: '2026-10-01', from: 'us' })),
    products: [{ id: 'p1', n: 'Cloud Virtual Machine' }],
  };

  const cust = buildCustomerContext(mini, 'vc');
  const oppLines = (cust.facts || []).filter((f) => f.startsWith('- deal '));
  const momLines = (cust.facts || []).filter((f) => f.startsWith('- 2026-08-'));
  const stepLines = (cust.facts || []).filter((f) => f.startsWith('- step '));
  check('the customer context assembles with citations that carry ids',
    cust?.ok === true && (cust.facts || []).some((f) => f.includes('Vista Corp'))
      && (cust.citations || []).some((c) => String(c).includes('(vc)'))
      && (cust.citations || []).some((c) => /^Opportunity · /.test(String(c)) && String(c).includes('(vo0)')),
    (cust.citations || []).slice(0, 2).join(' | ').slice(0, 100));
  check('the §19.4 limits hold (10 opps, 5 MOMs, 10 steps)',
    oppLines.length === 10 && (cust.facts || []).some((f) => f.includes('2 more open opportunities'))
      && momLines.length === 5 && stepLines.length === 10,
    oppLines.length + ' opps, ' + momLines.length + ' moms, ' + stepLines.length + ' steps');
  check('a confidential customer is refused by the assembler itself',
    buildCustomerContext(mini, 'vconf')?.ok === false
      && buildCustomerContext(mini, 'vconf')?.code === 'confidential',
    'code ' + buildCustomerContext(mini, 'vconf')?.code);
  check('an unknown customer is not found',
    buildCustomerContext(mini, 'nope')?.code === 'not-found', '');

  const opp = buildOppContext(mini, 'vo0');
  check('the opportunity context names the deal, the customer and the products',
    opp?.ok === true && (opp.facts || []).some((f) => f.includes('deal 0'))
      && (opp.facts || []).some((f) => f.includes('Vista Corp'))
      && (opp.facts || []).some((f) => f.includes('Cloud Virtual Machine'))
      && (opp.citations || []).some((c) => String(c).includes('(vo0)'))
      && (opp.citations || []).some((c) => String(c).includes('(vc)')),
    (opp.facts || []).slice(0, 2).join(' / ').slice(0, 90));
  check('an opportunity on a confidential customer is refused too',
    buildOppContext(mini, 'vo_conf')?.code === 'confidential', '');

  const retr = buildGlobalContext(mini, 'the renewal cost question', []);
  check('a global ask that names something retrieves it',
    retr?.mode === 'retrieval' && (retr.facts || []).some((f) => f.includes('Vista Corp'))
      && (retr.citations || []).some((c) => String(c).includes('(vc)')),
    'mode ' + retr?.mode + ', ' + (retr.facts || []).length + ' fact(s)');
  const roster = buildGlobalContext(mini, 'What is going on?', []);
  check('a global ask that names nothing falls back to the roster',
    roster?.mode === 'roster' && (roster.facts || []).some((f) => f.startsWith('Vista Corp —')),
    'mode ' + roster?.mode);
  const vault = buildGlobalContext(mini, 'tell me about Vault Secret banking', []);
  check('retrieval never surfaces the confidential customer',
    (vault.facts || []).join(' ').indexOf('Vault') === -1
      && (vault.citations || []).join(' ').indexOf('Vault') === -1,
    'mode ' + vault?.mode);

  /* End to end, behind the classifier: an opportunity ask answered from its
     briefing, and a global ask whose question names a record in the book —
     the o_lapsed title carries 'platform', and its id in the citations is
     proof the retrieval path ran (a roster citation carries no id). */
  const ask65 = (question) => bdSession.api('/api/ai/copilot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'answer', question }),
  });
  const wait65 = async (id) => {
    for (let i = 0; i < 40; i++) {
      const t = (await (await bdSession.api('/api/ai/tasks?since=0')).json())
        .tasks.find((x) => x.id === id);
      if (t && (t.state === 'completed' || t.state === 'failed')) return t;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  };
  {
    stubScript.push(JSON.stringify({ kind: 'opportunity', targetId: 'o_mine' }));
    stubScript.push('An opportunity briefing, from the records.');
    const r = await ask65('How is the migration deal tracking?');
    const j = await r.json().catch(() => ({}));
    const done = j.task ? await wait65(j.task.id) : null;
    check('an opportunity ask is answered from its assembled briefing',
      done?.state === 'completed' && done?.result?.classified?.kind === 'opportunity'
        && done?.result?.classified?.targetId === 'o_mine'
        && String(done?.result?.answer || '').includes('opportunity briefing')
        && (done?.result?.citations || []).some((c) => String(c).includes('(o_mine)'))
        && (done?.result?.citations || []).some((c) => String(c).includes('(c_mine)')),
      done?.state + ' / ' + JSON.stringify((done?.result?.citations || []).map(String)).slice(0, 100));
  }
  {
    stubScript.push(JSON.stringify({ kind: 'global' }));
    stubScript.push('A retrieval answer, from the matching records.');
    const r = await ask65('Where does the platform work stand?');
    const j = await r.json().catch(() => ({}));
    const done = j.task ? await wait65(j.task.id) : null;
    check('a global ask that names a record retrieves it, with its id cited',
      done?.state === 'completed' && done?.result?.classified?.kind === 'global'
        && String(done?.result?.answer || '').includes('retrieval answer')
        && (done?.result?.citations || []).some((c) => String(c).includes('(o_lapsed)')),
      done?.state + ' / ' + JSON.stringify((done?.result?.citations || []).map(String)).slice(0, 100));
  }
}

/* ------------------------------------- #66 the reusable summary (rev cache) */
/* §20: "Do not regenerate them unnecessarily." A summary is stored as a
   completed task with the revision it was generated at; asking again while
   the book still wears that revision must cost NOTHING — same task, no
   model call, no new row. Move the book one revision and the cache misses,
   honestly: a new task, one model call, a new contextRev. */
{
  const ask66 = (body, api) => (api || bdSession.api)('/api/ai/copilot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'summary', ...body }),
  });
  const tasks66 = async (api) => (await (await (api || bdSession.api)('/api/ai/tasks?since=0')).json()).tasks;
  const wait66 = async (id, api) => {
    for (let i = 0; i < 40; i++) {
      const t = (await tasks66(api)).find((x) => x.id === id);
      if (t && (t.state === 'completed' || t.state === 'failed')) return t;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  };

  /* 1 — a customer summary, assembled and stored with its revision. */
  stubScript.push('Current Situation: steady. Key Pain Points: the renewal quote. Everything else: not recorded.');
  const r1 = await ask66({ targetId: 'c_mine' });
  const j1 = await r1.json().catch(() => ({}));
  check('a summary ask becomes a task',
    r1.status === 200 && j1.ok === true && j1.kind === 'task' && j1.task?.id,
    'status ' + r1.status + ', kind ' + j1.kind);
  const d1 = await wait66(j1.task.id);
  const rev1 = Number(d1?.result?.contextRev);
  check('it completes as a §20 seven-field customer summary',
    d1?.state === 'completed' && String(d1?.result?.summary || '').includes('Current Situation')
      && (d1?.result?.headings || []).includes('Important Decisions')
      /* rev 0 is honest here — the fixture book has never been PUT, so the
         revision counter has never moved. The cache still keys on it: 0
         matches 0 until a save moves the book (proven below). */
      && Number.isFinite(rev1)
      && (d1?.result?.citations || []).some((c) => String(c).includes('(c_mine)')),
    d1?.state + ' / rev ' + rev1 + ' / ' + (d1?.result?.headings || []).length + ' headings');

  /* 2 — the book has not moved: asking again must cost nothing. */
  {
    const before = (await tasks66()).length;
    const calls = seen.prompts.length;
    const r2 = await ask66({ targetId: 'c_mine' });
    const j2 = await r2.json().catch(() => ({}));
    check('an unchanged book reuses the stored summary, spending nothing',
      r2.status === 200 && j2.cached === true && j2.task?.id === j1.task.id
        && seen.prompts.length === calls && (await tasks66()).length === before,
      'cached ' + j2.cached + ', task ' + (j2.task?.id === j1.task.id ? 'same' : 'NEW')
        + ', ' + (seen.prompts.length - calls) + ' call(s), '
        + ((await tasks66()).length - before) + ' row(s)');
  }

  /* 3 — move the book one revision (one new step), and the cache misses. */
  {
    const data = await (await bdSession.api('/api/data')).json();
    const at = new Date().toISOString();
    (data.state.steps || []).push({
      id: 's_cache_buster', c: 'c_mine', t: 'cache buster step', exec: 'Ahmad Faiz', track: 'Ahmad Faiz',
      due: '', from: 'us', p: 'p2', createdAt: at, updatedAt: at, done: '',
    });
    const put = await bdSession.api('/api/data', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: data.state, baseRev: data.rev, deleted: {} }),
    });
    const pj = await put.json().catch(() => ({}));
    check('the book moved a revision', put.status === 200 && Number(pj.rev) === Number(data.rev) + 1,
      'rev ' + data.rev + ' -> ' + pj.rev);

    const calls = seen.prompts.length;
    stubScript.push('Current Situation: moved. Next Action: refresh.');
    const r3 = await ask66({ targetId: 'c_mine' });
    const j3 = await r3.json().catch(() => ({}));
    const d3 = j3.task ? await wait66(j3.task.id) : null;
    check('a moved book rebuilds the summary',
      j3.cached !== true && j3.task?.id !== j1.task.id
        && d3?.state === 'completed' && Number(d3?.result?.contextRev) > rev1
        && seen.prompts.length === calls + 1,
      'new task ' + (j3.task?.id !== j1.task.id ? 'yes' : 'NO') + ', rev ' + rev1 + ' -> ' + Number(d3?.result?.contextRev)
        + ', ' + (seen.prompts.length - calls) + ' call(s)');
  }

  /* 4 — the opportunity shape: §20's six fields. */
  {
    stubScript.push('Current Situation: open. Next Action: call.');
    const r = await ask66({ targetId: 'o_mine' });
    const j = await r.json().catch(() => ({}));
    const d = j.task ? await wait66(j.task.id) : null;
    check('an opportunity summary carries the six-field shape',
      d?.state === 'completed' && (d?.result?.headings || []).includes('Next Action')
        && !(d?.result?.headings || []).includes('Important Decisions')
        && (d?.result?.citations || []).some((c) => String(c).includes('(o_mine)')),
      d?.state + ' / ' + (d?.result?.headings || []).length + ' headings');
  }

  /* 5 — the walls: a confidential customer is refused even for its owner,
         an unknown record is not the caller's to summarise, and a summary
         without a target never starts. */
  {
    const owner = await signIn(ORIGIN);
    const ownerApi = authed(ORIGIN, { v: owner.cookie });
    const r = await ask66({ targetId: 'c_conf' }, ownerApi);
    const j = await r.json().catch(() => ({}));
    const d = j.task ? await wait66(j.task.id, ownerApi) : null;
    check('a confidential customer is never summarised, even for its owner',
      d?.state === 'failed' && d?.retryable === false && /confidential/i.test(String(d?.error || '')),
      d?.state + ' / ' + String(d?.error || '').slice(0, 60));

    const r2 = await ask66({ targetId: 'c_ghost' });
    const j2 = await r2.json().catch(() => ({}));
    const d2 = j2.task ? await wait66(j2.task.id) : null;
    check('an unknown record is refused, not summarised',
      d2?.state === 'failed' && /scope/i.test(String(d2?.error || '')),
      d2?.state + ' / ' + String(d2?.error || '').slice(0, 60));

    const r3 = await ask66({});
    check('a summary without a record is refused up front',
      r3.status === 400, 'status ' + r3.status);
  }
}

/* ------------------------------------- #68 My Work Copilot (§5, Test 1) -- */
/* The focus-week list is assembled from the caller's scoped book with the
   confidential wall applied by the assembler itself. The see-all admin can
   OPEN the confidential customer's records — and must still never get them
   into a prompt; the BD must not get a customer that is simply not theirs;
   the manager's ask runs on the same whole read-only view the product
   already hands them. The items are facts from the book: the fixture's
   lapsed account (open deal, no interaction ever, no next step) is the row
   the list has to name. */
{
  const askF = (api) => api('/api/ai/copilot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'focus-week' }),
  });
  const waitF = async (id, api) => {
    for (let i = 0; i < 40; i++) {
      const t = (await (await api('/api/ai/tasks?since=0')).json()).tasks.find((x) => x.id === id);
      if (t && (t.state === 'completed' || t.state === 'failed')) return t;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  };

  /* 1 — the see-all admin: confidential rows stay out of the prompt even
         for the role that can read them on screen. */
  stubScript.push('{"items":[{"n":1,"action":"Call the account."}]}');
  const adminS = await signIn(ORIGIN);
  const adminApi = authed(ORIGIN, { v: adminS.cookie });
  const ra = await askF(adminApi);
  const ja = await ra.json().catch(() => ({}));
  const da = ja.task ? await waitF(ja.task.id, adminApi) : null;
  const promptA = seen.prompts[seen.prompts.length - 1] || '';
  const idsA = (da?.result?.items || []).map((x) => String(x.customerId));
  check('the admin\'s focus list names the lapsed account, never the confidential one',
    da?.state === 'completed' && idsA.includes('c_lapsed') && !idsA.includes('c_conf')
      && !promptA.includes(CONF_NAME) && !promptA.includes(CONF_NEEDLE),
    da?.state + ' / items ' + JSON.stringify(idsA));

  /* 2 — the BD: a customer that is not theirs never enters the assembly. */
  stubScript.push('{"items":[{"n":1,"action":"Revive the stalled deal."}]}');
  const rb = await askF(bdSession.api);
  const jb = await rb.json().catch(() => ({}));
  const db = jb.task ? await waitF(jb.task.id, bdSession.api) : null;
  const promptB = seen.prompts[seen.prompts.length - 1] || '';
  const idsB = (db?.result?.items || []).map((x) => String(x.customerId));
  check('the BD\'s focus list stays inside their scope',
    db?.state === 'completed' && idsB.includes('c_lapsed') && idsB.every((x) => x === 'c_lapsed' || x === 'c_mine')
      && !promptB.includes(SECRET_NAME) && !promptB.includes(SECRET_NEEDLE)
      && !promptB.includes(CONF_NAME) && !promptB.includes(CONF_NEEDLE),
    db?.state + ' / items ' + JSON.stringify(idsB));

  /* 3 — the manager asks on the same whole read-only view (Test 1: "manager
         问则全量只读"): the lapsed account is there, the confidential one
         is still walled. */
  stubScript.push('{"items":[{"n":1,"action":"Review the week."}]}');
  const mgr = await sessionAs('u_siti');
  const rm = await askF(mgr.api);
  const jm = await rm.json().catch(() => ({}));
  const dm = jm.task ? await waitF(jm.task.id, mgr.api) : null;
  const idsM = (dm?.result?.items || []).map((x) => String(x.customerId));
  check('the manager\'s focus list is the whole read-only view, walled the same',
    dm?.state === 'completed' && idsM.includes('c_lapsed') && idsM.includes('c_secret')
      && !idsM.includes('c_conf'),
    dm?.state + ' / items ' + JSON.stringify(idsM));
}

/* ---------------------------------- #69 Customer Copilot (§6, Test 2) ----- */
/* The customer brief assembles its ten sections from the caller's scoped
   view; the deep gate re-checks both walls on the executor's own reading.
   The scope triangle again, one customer at a time: the BD's own account
   is briefed from the BD's own records only; a customer outside the scope
   is not-found before a task exists; the confidential wall holds even for
   the see-all admin who can open the account on screen. And the prompt is
   the internal record set itself — no website, no outside reading (§12:
   internal data stays visibly internal). */
{
  const askB = (api, targetId, question) => api('/api/ai/copilot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'brief-customer', targetId, question }),
  });
  const waitB = async (id, api) => {
    for (let i = 0; i < 40; i++) {
      const t = (await (await api('/api/ai/tasks?since=0')).json()).tasks.find((x) => x.id === id);
      if (t && (t.state === 'completed' || t.state === 'failed')) return t;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  };

  /* 1 — the BD's own account: the facts are the account's own records, in
         sections, and nothing from anyone else's book rides along. */
  stubScript.push(JSON.stringify({ brief: 'Mid-programme on billing.', attention: 'The SOW is unsigned.' }));
  const rb1 = await askB(bdSession.api, 'c_mine', 'What needs attention on this account?');
  const jb1 = await rb1.json().catch(() => ({}));
  const db1 = jb1.task ? await waitB(jb1.task.id, bdSession.api) : null;
  const prompt1 = seen.prompts[seen.prompts.length - 1] || '';
  const factsText = JSON.stringify(db1?.result?.facts || []);
  check('the BD\'s brief is their own account, in sections, from the book',
    db1?.state === 'completed' && factsText.includes(MINE_NEEDLE)
      && prompt1.includes('[Active opportunities]') && prompt1.includes('[Key people]')
      && !prompt1.includes(SECRET_NAME) && !prompt1.includes(SECRET_NEEDLE)
      && !prompt1.includes(CONF_NAME) && !prompt1.includes(CONF_NEEDLE),
    db1?.state + ' / facts ' + (factsText || 'none').slice(0, 60));

  /* 2 — a customer outside the BD's scope: not-found, before a task, at
         zero model cost. */
  const calls2 = seen.requests;
  const rb2 = await askB(bdSession.api, 'c_secret', 'Brief them.');
  const jb2 = await rb2.json().catch(() => ({}));
  check('a customer outside the scope is not briefed, at no model cost',
    rb2.status === 404 && jb2.code === 'not-found' && seen.requests === calls2,
    'HTTP ' + rb2.status + ' / ' + (jb2.code || jb2.error || ''));

  /* 3 — the confidential account: the see-all admin can open it on screen
         and still never briefs it to a model (§4's promise, both gates). */
  const calls3 = seen.requests;
  const adminS2 = await signIn(ORIGIN);
  const adminApi2 = authed(ORIGIN, { v: adminS2.cookie });
  const rb3 = await askB(adminApi2, 'c_conf', 'Brief them.');
  const jb3 = await rb3.json().catch(() => ({}));
  check('the confidential account is never briefed, even for its see-all reader',
    rb3.status === 403 && jb3.code === 'confidential' && seen.requests === calls3,
    'HTTP ' + rb3.status + ' / ' + (jb3.code || jb3.error || ''));

  /* 4 — the manager briefs the same account on the whole read-only view,
         and the sections carry the account the BD owns (scope widens, the
         confidential wall does not move). */
  stubScript.push(JSON.stringify({ brief: 'Renewal at risk.', attention: 'No recent meeting.' }));
  const mgr2 = await sessionAs('u_siti');
  const rb4 = await askB(mgr2.api, 'c_mine', 'Prepare me for the next meeting with this customer.');
  const jb4 = await rb4.json().catch(() => ({}));
  const db4 = jb4.task ? await waitB(jb4.task.id, mgr2.api) : null;
  const prompt4 = seen.prompts[seen.prompts.length - 1] || '';
  check('the manager briefs on the read-only whole, with the question carried',
    db4?.state === 'completed' && (db4?.question || '').includes('next meeting')
      && prompt4.includes(MINE_NAME) && !prompt4.includes(CONF_NAME),
    db4?.state + ' / q ' + (db4?.question || '').slice(0, 40));
}

/* --------------------------------- #70 Opportunity Copilot (§7, Test 3) --- */
/* The opportunity analysis names an OPPORTUNITY, not a customer — the
   customer fast gate is not this action's, and the deep gate in the
   executor is the wall: a deal outside the caller's scope (or on a
   confidential account) is refused there, before any assembly and at no
   model cost. The BD's own deal is analysed from their own records, in
   §7's sections; the manager reads the same deal on the whole view. */
{
  const askA = (api, targetId, question) => api('/api/ai/copilot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'analyze-opp', targetId, question }),
  });
  const waitA = async (id, api) => {
    for (let i = 0; i < 40; i++) {
      const t = (await (await api('/api/ai/tasks?since=0')).json()).tasks.find((x) => x.id === id);
      if (t && (t.state === 'completed' || t.state === 'failed')) return t;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  };

  /* 1 — the BD's own deal: §7's sections from the caller's own book, and
         nothing from anyone else's rides along. */
  stubScript.push(JSON.stringify({
    moves: [{ what: 'Chase the countersigned SOW.', why: 'The open step is waiting on them.', kind: 'follow-up' }],
    gaps: [], prepare: [],
  }));
  const ra1 = await askA(bdSession.api, 'o_mine', 'What should I do next on this opportunity?');
  const ja1 = await ra1.json().catch(() => ({}));
  const da1 = ja1.task ? await waitA(ja1.task.id, bdSession.api) : null;
  const promptA1 = seen.prompts[seen.prompts.length - 1] || '';
  const factsA1 = JSON.stringify(da1?.result?.facts || []);
  check('the BD\'s analysis is their own deal, in §7\'s sections',
    da1?.state === 'completed' && factsA1.includes(MINE_NEEDLE)
      && promptA1.includes('[Current situation]') && promptA1.includes('[Missing information]')
      && !promptA1.includes(SECRET_NAME) && !promptA1.includes(SECRET_NEEDLE)
      && !promptA1.includes(CONF_NAME) && !promptA1.includes(CONF_NEEDLE),
    da1?.state + ' / facts ' + (factsA1 || 'none').slice(0, 60));

  /* 2 — a deal outside the BD's scope: refused by the deep gate, in the
         task, at zero model cost. */
  const callsA2 = seen.requests;
  const ra2 = await askA(bdSession.api, 'o_secret', 'Analyse it.');
  const ja2 = await ra2.json().catch(() => ({}));
  const da2 = ja2.task ? await waitA(ja2.task.id, bdSession.api) : null;
  check('a deal outside the scope is refused in the task, at no model cost',
    ra2.status === 200 && da2?.state === 'failed' && /not in your scope/i.test(da2?.error || '')
      && seen.requests === callsA2,
    da2?.state + ' / ' + (da2?.error || '').slice(0, 50));

  /* 3 — a deal on the confidential account: the same wall, the same
         honest words. */
  const callsA3 = seen.requests;
  const adminS3 = await signIn(ORIGIN);
  const adminApi3 = authed(ORIGIN, { v: adminS3.cookie });
  const ra3 = await askA(adminApi3, 'o_conf', 'Analyse it.');
  const ja3 = await ra3.json().catch(() => ({}));
  const da3 = ja3.task ? await waitA(ja3.task.id, adminApi3) : null;
  check('a deal on the confidential account is refused, even for its see-all reader',
    ra3.status === 200 && da3?.state === 'failed' && /confidential/i.test(da3?.error || '')
      && seen.requests === callsA3,
    da3?.state + ' / ' + (da3?.error || '').slice(0, 50));

  /* 4 — the manager analyses the BD's deal on the whole read-only view. */
  stubScript.push(JSON.stringify({ moves: [], gaps: ['Nothing recorded on the decision maker.'], prepare: [] }));
  const mgr3 = await sessionAs('u_siti');
  const ra4 = await askA(mgr3.api, 'o_mine', 'Find the risks on this opportunity.');
  const ja4 = await ra4.json().catch(() => ({}));
  const da4 = ja4.task ? await waitA(ja4.task.id, mgr3.api) : null;
  const promptA4 = seen.prompts[seen.prompts.length - 1] || '';
  check('the manager analyses on the read-only whole, with the question carried',
    da4?.state === 'completed' && (da4?.question || '').includes('risks')
      && promptA4.includes(MINE_NAME) && !promptA4.includes(CONF_NAME),
    da4?.state + ' / q ' + (da4?.question || '').slice(0, 40));
}

/* ------------------------------------------------------- the scope contract */
if (!BUILT) {
  skip('an unsigned request is refused', 'endpoint not built yet');
  skip('a customer outside the caller\'s scope is not found, not forbidden', 'endpoint not built yet');
  skip('the forbidden customer\'s data never reaches the model', 'endpoint not built yet');
  skip('a customer inside the caller\'s scope is answered', 'endpoint not built yet');
  skip('the model is fed the caller\'s own book', 'endpoint not built yet');
  skip('a manager may read through the copilot', 'endpoint not built yet');
  skip('an AI request writes nothing to the book', 'endpoint not built yet');
  skip('a confidential customer is refused for the owner too', 'endpoint not built yet');
  skip('refusing it costs no model call', 'endpoint not built yet');
  skip('a confidential customer is refused for a manager who can read it', 'endpoint not built yet');
  skip('refusing it costs no model call (manager)', 'endpoint not built yet');
  skip('the forbidden and confidential data never reaches any model prompt (final sweep)', 'endpoint not built yet');
  skip('a non-confidential customer still reaches the model', 'endpoint not built yet');
} else {
  /* Everything before this block was asked by the bd session (and the one
     admin ask the #64 block scripted, whose book legitimately includes
     c_secret). The walls below are proven on THIS block's prompts — every
     caller in here is scoped the same way the checks assume. */
  const scopeAnchor = seen.prompts.length;

  /* 1 — no session, no AI. */
  {
    const r = await fetch(ORIGIN + '/api/ai/copilot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ action: 'brief', targetId: 'c_mine' }),
    });
    check('an unsigned request is refused', r.status === 401, 'status ' + r.status);
  }

  /* 2 — a customer the BD is not on does not exist, as far as they can tell.
         403 would confirm it exists; only 404 keeps the secret. */
  {
    const r = await bdSession.api('/api/ai/copilot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'brief', targetId: 'c_secret' }),
    });
    check('a customer outside the caller\'s scope is not found, not forbidden',
      r.status === 404, 'status ' + r.status);
  }

  /* 3 — everything the model was handed so far, read at the stub. */
  {
    const leaked = seen.prompts.slice(scopeAnchor).filter((p) =>
      p.toLowerCase().includes('zenith') || p.includes(SECRET_NEEDLE));
    check('the forbidden customer\'s data never reaches the model',
      leaked.length === 0, leaked.length ? 'leaked in ' + leaked.length + ' prompt(s)' : 'stub saw ' + seen.prompts.length + ' prompt(s)');
  }

  /* 4 — the same BD, their own customer: answered, and the stub really was
         fed that book — proving the suite can see a full book, not a starved
         one that would make check 3 trivially true. The endpoint answers the
         moment the task is QUEUED (#61); the model call happens behind the
         response, so the needle is waited for, not assumed — a fixed sleep
         could only be wrong twice. */
  {
    const before = seen.prompts.length;
    const r = await bdSession.api('/api/ai/copilot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'brief', targetId: 'c_mine' }),
    });
    check('a customer inside the caller\'s scope is answered', r.status === 200, 'status ' + r.status);
    let fed = false;
    for (let i = 0; i < 20 && !fed; i++) {
      await new Promise((r2) => setTimeout(r2, 200));
      fed = seen.prompts.slice(before).some((p) => p.includes(MINE_NEEDLE) || p.includes(MINE_NAME));
    }
    check('the model is fed the caller\'s own book', fed,
      fed ? 'stub received the visible book' : 'stub was not fed the customer — the negative checks above prove less than they appear to');
  }

  /* 5 — the manager partition (#60): reading through the copilot is not a
         write; a manager stays read-only but is not locked out of insight. */
  {
    const mgr = await sessionAs('u_siti');
    const r = await mgr.api('/api/ai/copilot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'brief', targetId: 'c_mine' }),
    });
    check('a manager may read through the copilot', r.status === 200, 'status ' + r.status);
  }

  /* 6 — §26: an AI answer is a suggestion on a screen. If the copilot wrote
         rows behind the caller's back, this is where it would show — the
         whole book, read off the disk, before and after. The 400ms of slack
         is for an async executor: a task-based copilot may return before its
         model call finishes, and a late write is still a write. */
  {
    const readTables = () => {
      const s = JSON.parse(readFileSync(join(dir, 'workbench.json'), 'utf8'));
      return Object.fromEntries(GUARDED_TABLES.map((t) => [t, s[t]]));
    };
    const before = readTables();
    await bdSession.api('/api/ai/copilot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'brief', targetId: 'c_mine' }),
    });
    await new Promise((r) => setTimeout(r, 400));
    const moved = diffTables(before, readTables());
    check('an AI request writes nothing to the book', moved.length === 0,
      moved.length ? 'changed: ' + moved.join(', ') : 'customers/opps/steps/interactions untouched');
  }

  /* 7 — the confidential wall. Not who may read — who may be sent to a
         model: nobody, including the owner. The refusal must be designed
         (any 2xx-with-explanation or 4xx; a 500 would be a crash, not a
         policy), and it must cost no model call at all. */
  {
    const owner = await signIn(ORIGIN);
    const api = authed(ORIGIN, { v: owner.cookie });
    const before = seen.prompts.length;
    const r = await api('/api/ai/copilot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'brief', targetId: 'c_conf' }),
    });
    check('a confidential customer is refused for the owner too',
      r.status >= 200 && r.status < 500, 'status ' + r.status);
    check('refusing it costs no model call', seen.prompts.length === before,
      seen.prompts.length === before ? 'no traffic' : (seen.prompts.length - before) + ' call(s)');
  }
  {
    /* The manager can open c_conf's record — see-all roles read everything —
       so this is the sharpest form of the rule: sight is not the same as
       being allowed to hand the record to a model. */
    const mgr = await sessionAs('u_siti');
    const before = seen.prompts.length;
    const r = await mgr.api('/api/ai/copilot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'brief', targetId: 'c_conf' }),
    });
    check('a confidential customer is refused for a manager who can read it',
      r.status >= 200 && r.status < 500, 'status ' + r.status);
    check('refusing it costs no model call (manager)', seen.prompts.length === before,
      seen.prompts.length === before ? 'no traffic' : (seen.prompts.length - before) + ' call(s)');
  }

  /* 8 — the contrast that keeps the checks above honest: a NON-confidential
         customer really did reach the model. A wall that blocks everything
         would pass every leak test and mean the feature is dead. */
  {
    const reached = seen.prompts.some((p) => p.includes(MINE_NEEDLE));
    check('a non-confidential customer still reaches the model', reached,
      reached ? 'the visible book did reach the stub' : 'nothing ever reached the model — the leak checks above prove less than they appear to');
  }

  /* 9 — after everything: no needle has ever arrived, on either wall. The
         last word belongs to the walls, not to the order the checks ran in. */
  {
    await new Promise((r) => setTimeout(r, 500));   /* a late async call is still a leak */
    const leak = (p) =>
      p.toLowerCase().includes('zenith') || p.includes(SECRET_NEEDLE) ||
      p.toLowerCase().includes('straits confidential') || p.includes(CONF_NEEDLE);
    const leaked = seen.prompts.slice(scopeAnchor).filter(leak);
    check('the forbidden and confidential data never reaches any model prompt (final sweep)',
      leaked.length === 0, leaked.length ? 'leaked in ' + leaked.length + ' prompt(s)' : 'clean across ' + (seen.prompts.length - scopeAnchor) + ' prompt(s)');
  }
}

/* ------------------------------------------------------------------- teardown */
srv.kill();
stub.close();
try { srv.kill && await new Promise((r) => setTimeout(r, 200)); } catch { /* already gone */ }

const total = pass + fail;
console.log('');
console.log((fail ? 'RESULT: FAIL' : 'RESULT: PASS') + '  ' + pass + ' passed, ' + fail + ' failed' +
  (skipped ? ', ' + skipped + ' skipped' : '') + '  (' + total + ' checks)');
process.exit(fail ? 1 : 0);
