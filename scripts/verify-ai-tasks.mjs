/* verify:ai-tasks — the copilot task table holds under fire (§21–§23).
 *
 * WHY THIS EXISTS
 * ---------------
 * Task #58 builds the copilot's task table: a home for AI asks that outlives
 * the HTTP request that started them, so a page can poll, a user can leave
 * and come back, and a double-click costs one model call, not two. The brief
 * is explicit about the two ways this goes wrong, and both are tested here:
 *
 *   - two writers at once must not lose a task (the same class of bug the
 *     book's serialize() lock exists for — acid, but for the task table);
 *   - a task left 'processing' by a restarted server must say it FAILED,
 *     because "it might still finish" is the third state the product refuses
 *     to have. A user staring at a spinner that will never end is the exact
 *     dishonesty §23 is about.
 *
 * The unit half of this suite imports server/copilot.mjs directly; the
 * restart half boots the real server, because recovery is main()'s job, not
 * the module's; and since #59 the endpoint half drives the real routes with
 * a stand-in model — create, double-click, poll, retry, and the role
 * partition that decides who may ask at all.
 *
 * Run from customer-workbench/:  npm run verify:ai-tasks
 */
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { startServer } from './harness.mjs';
import { ADMIN, adminSeed, credentialFor, signIn, authed } from './verify-auth.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8893;
const ORIGIN = 'http://127.0.0.1:' + PORT;
const EP_PORT = 8894;
const EP_ORIGIN = 'http://127.0.0.1:' + EP_PORT;
const STUB_PORT = 8895;
const STUB = 'http://127.0.0.1:' + STUB_PORT + '/v1';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

/* ------------------------------------------------------------ the fixture */
const dir = mkdtempSync(join(tmpdir(), 'wp-ai-tasks-'));
process.env.WB_DATA_DIR = dir;                 /* read once, at module load */
const TASKS_FILE = join(dir, 'ai-tasks.json');
const copilot = await import(pathToFileURL(join(ROOT, 'server', 'copilot.mjs')).href);
const readTable = () => JSON.parse(readFileSync(TASKS_FILE, 'utf8')).tasks;

/* ------------------------------------------------------- concurrent writes */
{
  const made = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      copilot.createTask({ userId: 'u_a', action: 'brief', targetId: 'c_' + i })));
  const ids = new Set(made.map((m) => m.task.id));
  check('forty tasks created at once all land', made.length === 40 && readTable().length === 40,
    readTable().length + ' on disk');
  check('every task gets its own id', ids.size === 40, ids.size + ' distinct');
}

/* ----------------------------------------------------------- the dedupe key */
{
  /* The same ask, twice, racing: one model call. The lock serialises them,
     so the second must find the first still queued and hand it back. */
  const two = await Promise.all([
    copilot.createTask({ userId: 'u_a', action: 'mom', targetId: 'c_dup' }),
    copilot.createTask({ userId: 'u_a', action: 'mom', targetId: 'c_dup' }),
  ]);
  check('a double-click creates one task, not two',
    two[0].task.id === two[1].task.id && (two[0].reused || two[1].reused),
    'id ' + two[0].task.id + (two[1].reused ? ', second ask reused it' : ''));
  /* A different target is a different ask — no false dedupe. */
  const other = await copilot.createTask({ userId: 'u_a', action: 'mom', targetId: 'c_other' });
  check('a different target is a different task', other.task.id !== two[0].task.id && !other.reused);
  /* And a different user asking the same thing is their own task. */
  const theirs = await copilot.createTask({ userId: 'u_b', action: 'mom', targetId: 'c_dup' });
  check('another user asking the same thing gets their own task',
    theirs.task.id !== two[0].task.id && theirs.task.userId === 'u_b');
}

/* ------------------------------------------------------ the state machine */
let doneId;
{
  const { task } = await copilot.createTask({ userId: 'u_a', action: 'brief', targetId: 'c_flow', contextRev: 41 });
  const p = await copilot.markProcessing(task.id);
  check('a task moves to processing', p?.state === 'processing');
  const c = await copilot.markCompleted(task.id, { note: 'the answer' });
  const row = readTable().find((t) => t.id === task.id);
  check('completion lands the result and the timestamp',
    c?.state === 'completed' && row?.result?.note === 'the answer' && !!row?.doneAt,
    row?.doneAt || 'no doneAt');
  check('the context revision travels with the task', row?.contextRev === 41);
  doneId = task.id;

  /* Failure, the honest way. */
  const { task: t2 } = await copilot.createTask({ userId: 'u_a', action: 'brief', targetId: 'c_flow2' });
  await copilot.markProcessing(t2.id);
  const f = await copilot.markFailed(t2.id, 'The model did not answer in time.', true);
  const row2 = readTable().find((t) => t.id === t2.id);
  check('failure records why, and that it can be retried',
    f?.state === 'failed' && row2?.retryable === true && /in time/.test(row2?.error || ''),
    row2?.error || 'no error');
}

/* -------------------------------------------------------- ask again (§21) */
{
  /* The dedupe key only holds while a task is queued or processing. Once it
     has completed, asking again is a FEATURE — the answer may be stale. */
  const again = await copilot.createTask({ userId: 'u_a', action: 'brief', targetId: 'c_flow' });
  check('a completed ask can be made again',
    !again.reused && again.task.id !== doneId, 'new task ' + again.task.id);
}

/* ---------------------------------------------------------------- the TTL */
{
  const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
  const seedRows = (rows) => writeFileSync(TASKS_FILE, JSON.stringify({ tasks: rows }));
  const mk = (i, created) => ({
    id: 't_seed_' + i, userId: 'u_a', action: 'brief', targetId: 'c_' + i, kind: 'read',
    state: 'completed', result: null, error: '', retryable: false,
    contextRev: null, createdAt: created, doneAt: created,
  });
  /* 150 tasks from last week: past the rank limit AND past the age limit. */
  seedRows(Array.from({ length: 150 }, (_, i) => mk(i, daysAgo(8))));
  await copilot.createTask({ userId: 'u_a', action: 'brief', targetId: 'c_fresh' });
  check('a write prunes tasks past both limits', readTable().length === 1,
    readTable().length + ' remain');
  /* Three recent rows plus 150 stale ones: the rank limit would drop the
     recent ones, the age limit keeps them. That is the point of the OR. */
  seedRows([
    ...Array.from({ length: 150 }, (_, i) => mk(i, daysAgo(8))),
    ...Array.from({ length: 3 }, (_, i) => mk(1000 + i, daysAgo(1))),
  ]);
  await copilot.createTask({ userId: 'u_a', action: 'brief', targetId: 'c_fresh2' });
  check('recent tasks survive even past the rank limit', readTable().length === 4,
    readTable().length + ' remain');
}

/* ------------------------------------------------------------ whose tasks */
{
  const mine = await copilot.tasksFor('u_a');
  const theirs = await copilot.tasksFor('u_b');
  check('a user sees only their own tasks',
    mine.length > 0 && mine.every((t) => t.userId === 'u_a') && theirs.every((t) => t.userId === 'u_b'),
    mine.length + ' for u_a, ' + theirs.length + ' for u_b');
  check('tasks come back newest first',
    mine.every((t, i) => i === 0 || String(mine[i - 1].createdAt) >= String(t.createdAt)));
  const cut = Date.parse(mine[0].createdAt) - 1;
  const after = await copilot.tasksFor('u_a', cut);
  check('a since filter narrows the poll to what is new',
    after.length >= 1 && after.every((t) => Date.parse(t.createdAt) > cut),
    after.length + ' after the cut');
}

/* ------------------------------------------------------------ file hygiene */
{
  const mode = statSync(TASKS_FILE).mode & 0o777;
  check('the task file is private to this server', mode === 0o600, '0' + mode.toString(8));
}

/* ------------------------------------------------- restart honesty (§23) */
{
  /* A previous run of the server died mid-task. The next boot must say so:
     processing becomes failed-and-retryable, never "still running"; queued
     tasks are untouched — nobody started them, so nobody stopped them. */
  const dir2 = mkdtempSync(join(tmpdir(), 'wp-ai-tasks-boot-'));
  const now = new Date().toISOString();
  writeFileSync(join(dir2, 'ai-tasks.json'), JSON.stringify({ tasks: [
    { id: 't_stuck', userId: 'u_a', action: 'brief', targetId: 'c_1', kind: 'read',
      state: 'processing', result: null, error: '', retryable: false,
      contextRev: null, createdAt: now, doneAt: null },
    { id: 't_waiting', userId: 'u_a', action: 'nonsense', targetId: 'c_2', kind: 'read',
      state: 'queued', result: null, error: '', retryable: false,
      contextRev: null, createdAt: now, doneAt: null },
  ] }));

  const srv = await startServer({
    spawnBin: process.execPath,
    args: [join(ROOT, 'server', 'server.mjs')],
    env: {
      ...process.env,
      WB_DATA_DIR: dir2,
      PORT: String(PORT),
      WB_TLS: '0',
      WB_ORIGINS: ORIGIN,
    },
    port: PORT,
  });
  try {
    await fetch(ORIGIN + '/api/health');
    const stuck = JSON.parse(readFileSync(join(dir2, 'ai-tasks.json'), 'utf8')).tasks
      .find((t) => t.id === 't_stuck');
    check('a task left processing by a dead server is failed, not spinning',
      stuck?.state === 'failed' && stuck?.retryable === true && !!stuck?.doneAt,
      stuck?.state + (stuck?.retryable ? ', retryable' : ''));
    check('the failure says what actually happened', /restarted/.test(stuck?.error || ''), stuck?.error || 'no error');
    /* Since #59, a queued task does NOT sit through a restart — it is picked
       straight back up, because the user already asked. This fixture's action
       has no executor, so the pickup runs straight to an honest failure:
       picked up, tried, and it says why. */
    let waiting = null;
    for (let i = 0; i < 25; i++) {
      waiting = JSON.parse(readFileSync(join(dir2, 'ai-tasks.json'), 'utf8')).tasks
        .find((t) => t.id === 't_waiting');
      if (waiting && waiting.state !== 'queued' && waiting.state !== 'processing') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    check('a queued task is picked back up after the restart',
      waiting?.state === 'failed' && /Unknown action/.test(waiting?.error || ''),
      waiting?.state + ' — ' + (waiting?.error || 'still queued'));
  } finally {
    srv.kill();
  }
}

/* ------------------------------------------------- the endpoints (#59) */
{
  /* A stand-in model, counted. The 300ms pause is deliberate: it holds the
     echo task in `processing` long enough that the double-click below is
     GUARANTEED to land inside the dedupe window, instead of usually —
     "usually" is how a suite goes intermittent under load. */
  const stubSeen = { chat: 0 };
  const stub = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url.endsWith('/models')) return send(200, { data: [{ id: 'stub-model' }] });
      if (req.url.endsWith('/chat/completions')) {
        stubSeen.chat++;
        setTimeout(() => send(200, {
          choices: [{ message: { content: 'OK' } }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }), 300);
        return;
      }
      send(404, { error: 'not found' });
    });
  });
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

  /* A book with one of each role — the task endpoints' guard is a role
     partition, not a login check. */
  const dir3 = mkdtempSync(join(tmpdir(), 'wp-ai-tasks-ep-'));
  const at = new Date().toISOString();
  const seed = adminSeed();
  const people = {
    u_bd: ['Ahmad Faiz', 'bd'], u_mgr: ['Siti Nurhaliza', 'manager'], u_vw: ['Chong Wei', 'viewer'],
  };
  writeFileSync(join(dir3, 'workbench.json'), JSON.stringify({
    users: seed.users.concat(Object.entries(people).map(([id, [name, role]]) =>
      ({ id, name, email: '', role, title: role.toUpperCase(), locked: false, createdAt: at, updatedAt: at }))),
    credentials: Object.assign(
      {}, seed.credentials,
      ...Object.keys(people).map((id) => ({ [id]: credentialFor(id) }))),
    audit: [], customers: [], interactions: [], opps: {}, steps: [], team: [],
    config: { stages: ['Interested', 'Evaluating', 'POC / Quoted', 'Submitted'] },
  }));

  const SPAWN_ENV = { ...process.env };
  for (const k of Object.keys(SPAWN_ENV)) if (k.startsWith('AI_')) delete SPAWN_ENV[k];
  const srv = await startServer({
    spawnBin: process.execPath,
    args: [join(ROOT, 'server', 'server.mjs')],
    env: {
      ...SPAWN_ENV,
      WB_DATA_DIR: dir3,
      PORT: String(EP_PORT),
      WB_TLS: '0',
      WB_ORIGINS: EP_ORIGIN,
      WB_TEST_AI: '1',
    },
    port: EP_PORT,
  });
  const sessionAs = async (userId) => {
    const r = await signIn(EP_ORIGIN, { userId });
    return authed(EP_ORIGIN, { v: r.cookie });
  };
  /** Poll a user's task list until one task reaches a terminal state. */
  const untilState = async (api, id, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) {
      const j = await (await api('/api/ai/tasks')).json();
      const t = (j.tasks || []).find((x) => x.id === id);
      if (t && (t.state === 'completed' || t.state === 'failed')) return t;
      if (Date.now() > end) return t || null;
      await new Promise((r) => setTimeout(r, 120));
    }
  };
  try {
    /* Point the server at the stub, as an admin does in the product. */
    const admin = await sessionAs(ADMIN.id);
    const cfg = await admin('/api/ai/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base: STUB, model: 'stub-model', key: 'sk-tasks-ep' }),
    });
    check('the stub model is configured for the endpoint test', cfg.status === 200, 'status ' + cfg.status);

    /* 1 — no session, no tasks. */
    const anon = await fetch(EP_ORIGIN + '/api/ai/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: EP_ORIGIN },
      body: JSON.stringify({ action: 'echo' }),
    });
    check('an unsigned ask is refused', anon.status === 401, 'status ' + anon.status);

    /* 2 — a viewer watches; it does not ask. */
    const vw = await sessionAs('u_vw');
    const vwAsk = await vw('/api/ai/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'echo' }),
    });
    check('a viewer cannot ask the copilot', vwAsk.status === 403, 'status ' + vwAsk.status);
    const vwList = await vw('/api/ai/tasks');
    check('a viewer polling gets an empty list, not a door',
      vwList.status === 200 && (await vwList.json()).tasks.length === 0);

    /* 3 — the happy path, and the double-click (§24, Test 12). */
    const bd = await sessionAs('u_bd');
    const first = await (await bd('/api/ai/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'echo', targetId: 'c_1' }),
    })).json();
    check('an ask creates a task and answers immediately',
      first.ok && first.task.state === 'queued' && !first.reused, 'state ' + first.task?.state);
    const second = await (await bd('/api/ai/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'echo', targetId: 'c_1' }),
    })).json();
    check('a double-click hands back the SAME task',
      second.reused && second.task.id === first.task.id, 'reused ' + !!second.reused);

    const done = await untilState(bd, first.task.id);
    check('the task completes and the answer lands in the table',
      done?.state === 'completed' && done?.result?.text === 'OK', done?.state + ' · ' + JSON.stringify(done?.result || ''));
    check('one ask, one model call — the double-click cost nothing',
      stubSeen.chat === 1, stubSeen.chat + ' call(s) to the stub');

    /* 4 — retry: a failed task comes back as queued, same id. */
    const boom = await (await bd('/api/ai/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'no-such-action' }),
    })).json();
    const boomDone = await untilState(bd, boom.task.id);
    check('an unknown action fails the task with a readable error',
      boomDone?.state === 'failed' && /Unknown action/.test(boomDone?.error || ''), boomDone?.error || boomDone?.state);
    const retried = await bd('/api/ai/tasks/' + boom.task.id + '/retry', { method: 'POST' });
    const retriedJ = await retried.json();
    check('a failed task can be retried, same id',
      retried.status === 200 && retriedJ.task?.state === 'queued' && retriedJ.task?.id === boom.task.id,
      'status ' + retried.status);
    const boomAgain = await untilState(bd, boom.task.id);
    check('the retried task runs again and lands in the table',
      boomAgain?.state === 'failed' && !!boomAgain?.doneAt, boomAgain?.state);

    /* 5 — retrying what is not failed is a 409, not a new run. */
    const redoDone = await bd('/api/ai/tasks/' + first.task.id + '/retry', { method: 'POST' });
    check('retrying a completed task is refused with the reason',
      redoDone.status === 409 && (await redoDone.json()).code === 'not-failed', 'status ' + redoDone.status);

    /* 6 — whose tasks: the poll only ever answers with your own. */
    const mgr = await sessionAs('u_mgr');
    const mgrList = await (await mgr('/api/ai/tasks')).json();
    check('one user\'s poll never lists another\'s tasks',
      mgrList.tasks.length >= 0 && mgrList.tasks.every((t) => t.userId === 'u_mgr'),
      mgrList.tasks.length + ' task(s), all u_mgr\'s');
    const mgrRetry = await mgr('/api/ai/tasks/' + first.task.id + '/retry', { method: 'POST' });
    check('retrying somebody else\'s task is not-found, not forbidden',
      mgrRetry.status === 404, 'status ' + mgrRetry.status);

    /* 7 — the since filter: a poll after "now" sees nothing new. */
    const after = await (await mgr('/api/ai/tasks?since=' + (Date.now() + 60000))).json();
    check('a poll past the newest task sees nothing', after.tasks.length === 0);
  } finally {
    srv.kill();
    stub.close();
  }
}

/* ----------------------------------------------------------------- teardown */
console.log('');
console.log((fail ? 'RESULT: FAIL' : 'RESULT: PASS') + '  ' + pass + ' passed, ' + fail + ' failed  (' + (pass + fail) + ' checks)');
process.exit(fail ? 1 : 0);
