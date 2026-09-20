#!/usr/bin/env node
/**
 * Copilot task table — §21–§23 of the Phase 3 brief.
 *
 * Why a file of its own
 * ---------------------
 * An AI answer takes seconds, and the brief refuses both ways this usually
 * goes wrong: a spinner the user must babysit (leave the screen, lose the
 * answer), and a background job the user never asked for. So asking the
 * copilot creates a TASK — queued, processing, completed or failed — and the
 * page polls for it. Tasks need a home, and that home is NOT
 * `workbench.json`, for two reasons that both bite:
 *
 *   - `GET /api/data` hands the whole state to every browser. Task rows,
 *     with their results and their retry state, would ride along — payload
 *     nobody asked for, on every screen, forever.
 *   - The book's revision counts every write. A task landing would bump the
 *     rev, and every open tab would conclude somebody else saved and go
 *     re-fetch the world.
 *
 * So: `data/ai-tasks.json`, beside the book but not in it, plain JSON at
 * 0600 like `ai.json` (these rows expire by TTL, so the simpler format
 * wins; nothing here needs the sealed format's guarantees).
 *
 * Concurrency
 * -----------
 * Same pattern as the book's `serialize()` in server.mjs — a promise chain
 * is a real lock in a single-threaded process — but a chain of its own, so
 * a slow task write never queues a book save behind it and vice versa.
 *
 * Honesty on restart (§23)
 * ------------------------
 * A task left `processing` by a dead server is not running. It did not
 * pause; it stopped. There is no third state where it "might still finish":
 * on boot, every `processing` row becomes `failed` with `retryable: true`,
 * and the user decides whether to ask again.
 *
 * Retention
 * ---------
 * Every write prunes. Two independent caps, and a task must satisfy BOTH to
 * stay: among the newest KEEP_MAX, and newer than KEEP_DAYS. A quiet
 * workspace keeps a week of answers; a busy one keeps its last hundred; a
 * workspace that was left alone for a month comes back to an empty table —
 * not to a hundred answers nobody remembers asking for.
 *
 * Zero dependencies, like the rest of the server.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { aiComplete } from './ai.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const DATA_DIR = process.env.WB_DATA_DIR ? path.resolve(process.env.WB_DATA_DIR) : path.join(ROOT, 'data');
const TASKS_FILE = path.join(DATA_DIR, 'ai-tasks.json');

const KEEP_MAX = 100;
const KEEP_DAYS = 7;

/* ------------------------------------------------- one writer at a time --- */
let tail = Promise.resolve();
function serialize(job) {
  const run = tail.then(job, job);
  /* A rejected job must not poison the queue for the next caller. */
  tail = run.then(() => {}, () => {});
  return run;
}

/* ------------------------------------------------------------- storage --- */
async function readTasks() {
  try {
    const j = JSON.parse(await fsp.readFile(TASKS_FILE, 'utf8'));
    return Array.isArray(j?.tasks) ? j : { tasks: [] };
  } catch {
    /* not there yet, or not valid — an empty table is the honest start */
    return { tasks: [] };
  }
}

/** Atomic write: sibling temp file, fsync, rename, fsync the directory.
 *  A reader sees the old table or the new one, never a partial one. */
async function writeTasks(tasks) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  /* Unique per write, not just per process: two writers aimed at the same
   * temp path truncate each other and the surviving rename then fails. */
  const tmp = `${TASKS_FILE}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const h = await fsp.open(tmp, 'w', 0o600);
  try {
    await h.writeFile(JSON.stringify({ tasks }, null, 2), 'utf8');
    await h.sync();
  } finally {
    await h.close();
  }
  await fsp.rename(tmp, TASKS_FILE);
  /* A rename is a directory entry; flush the directory or the write can be
   * "there" and gone after a crash. Windows will not open a directory as a
   * file — the rename is still durable there. */
  try {
    const d = await fsp.open(DATA_DIR, 'r');
    await d.sync();
    await d.close();
  } catch { /* not Linux, or a mounted volume */ }
  try { await fsp.chmod(TASKS_FILE, 0o600); } catch { /* Windows */ }
}

const newId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
/* The dedupe key carries the question for answer asks and nothing for the
 * rest. A task row never needed a free-text field until asks became
 * sentences (#64): two different questions from one person must never fold
 * into one task — the second would be handed the first's answer — while the
 * SAME question asked twice while one is still running is a double-click,
 * and the key is exactly what makes it cost one model call, not two. */
const dedupeKey = (userId, action, targetId, question = '') =>
  `${userId}:${action}:${targetId ?? ''}:${action === 'answer' ? String(question || '') : ''}`;

/** Two independent caps, both required to stay: among the newest KEEP_MAX,
 *  and newer than KEEP_DAYS. The OR-shaped rule was tried first and got it
 *  backwards — rank protection let ninety-nine month-old tasks survive a
 *  prune just because the workspace had been quiet. A row whose createdAt
 *  cannot be parsed is dropped: the server always writes ISO stamps, so an
 *  unreadable one is not data to protect. */
function prune(tasks, now = Date.now()) {
  const sorted = [...tasks].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return sorted.filter((t, i) => {
    const made = Date.parse(t.createdAt);
    return i < KEEP_MAX && Number.isFinite(made) && (now - made) < KEEP_DAYS * 864e5;
  });
}

/* ------------------------------------------------------------- the API --- */

/**
 * Create a task, or hand back the one already running for the same ask.
 * The dedupe key is `${userId}:${action}:${targetId}` (§24, Test 12): while
 * a task with that key is queued or processing, a second identical ask
 * returns the SAME task instead of paying for the model twice. Once it has
 * completed or failed, asking again creates a fresh task — "Ask again" is a
 * feature, not a bug (§21).
 */
export async function createTask({ userId, action, targetId = '', kind = 'read', contextRev = null, question = '' }) {
  if (!userId || !action) throw new Error('A task needs a user and an action.');
  /* The question rides in the row (trimmed, capped) and in the key — see
   * `dedupeKey` above for why both halves are load-bearing. */
  const q = String(question || '').trim().slice(0, 500);
  const key = dedupeKey(userId, action, targetId, q);
  return serialize(async () => {
    const { tasks } = await readTasks();
    const existing = tasks.find(
      (t) => (t.state === 'queued' || t.state === 'processing') && dedupeKey(t.userId, t.action, t.targetId, t.question) === key);
    if (existing) return { task: existing, reused: true };
    const task = {
      id: newId(),
      userId, action, targetId: targetId ?? '', kind, question: q,
      state: 'queued',
      result: null, error: '', retryable: false,
      contextRev: contextRev ?? null,
      createdAt: new Date().toISOString(), doneAt: null,
    };
    tasks.push(task);
    await writeTasks(prune(tasks));
    return { task, reused: false };
  });
}

/**
 * #66 — find a completed summary of the same record, generated at the
 * revision the book still wears. "Do not regenerate them unnecessarily"
 * (§20): an unchanged book answers from the stored result and costs no
 * model call at all. The prune window (KEEP_MAX/KEEP_DAYS) is the cache's
 * only expiry — a summary that has fallen off the table is simply rebuilt.
 * The dedupe above stays untouched: it guards double-clicks on a RUNNING
 * ask; this guards paying twice for the same ANSWER.
 */
export async function findReusableSummary(userId, action, targetId, rev) {
  const { tasks } = await readTasks();
  return tasks.find((t) =>
    t && t.userId === userId && t.action === action
    && String(t.targetId || '') === String(targetId || '')
    && t.state === 'completed'
    && t.result && Number(t.result.contextRev) === Number(rev)) || null;
}

/** Move a task to `processing`. Returns the task, or null if it vanished
 *  (pruned while waiting — the caller treats that as "start nothing"). */
export async function markProcessing(id) {
  return serialize(async () => {
    const { tasks } = await readTasks();
    const t = tasks.find((x) => x.id === id);
    if (!t) return null;
    t.state = 'processing';
    await writeTasks(tasks);
    return t;
  });
}

/** Land the answer. `result` is whatever the action's consumer expects. */
export async function markCompleted(id, result) {
  return serialize(async () => {
    const { tasks } = await readTasks();
    const t = tasks.find((x) => x.id === id);
    if (!t) return null;
    t.state = 'completed';
    t.result = result ?? null;
    t.doneAt = new Date().toISOString();
    await writeTasks(prune(tasks));
    return t;
  });
}

/** Fail the task. `retryable` says whether asking again makes sense — a
 *  refused scope is not retryable, a model that timed out is. */
export async function markFailed(id, error, retryable = true) {
  return serialize(async () => {
    const { tasks } = await readTasks();
    const t = tasks.find((x) => x.id === id);
    if (!t) return null;
    t.state = 'failed';
    t.error = String(error || 'The task failed.');
    t.retryable = !!retryable;
    t.doneAt = new Date().toISOString();
    await writeTasks(prune(tasks));
    return t;
  });
}

/** The tasks a user may see: their own, newest first. `since` (epoch ms)
 *  filters to tasks created after it, so the poll can be cheap. */
export async function tasksFor(userId, since = 0) {
  const { tasks } = await readTasks();
  return tasks
    .filter((t) => t.userId === userId && Date.parse(t.createdAt || '') > Number(since || 0))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/**
 * Boot-time honesty pass (§23): a task left `processing` by a previous run
 * of this server is not running. Mark it failed and retryable, and say so
 * once. Queued tasks survive untouched — nobody started them, so nobody
 * stopped them; the executor will pick them up.
 */
export async function recoverStuckTasks() {
  return serialize(async () => {
    const { tasks } = await readTasks();
    let moved = 0;
    const at = new Date().toISOString();
    for (const t of tasks) {
      if (t.state !== 'processing') continue;
      t.state = 'failed';
      t.error = 'The server restarted while this task was running.';
      t.retryable = true;
      t.doneAt = at;
      moved++;
    }
    if (moved) await writeTasks(tasks);
    return moved;
  });
}

/** The tasks waiting to start — the ones main() hands to the executor on
 *  boot, so a restart does not orphan an ask the user already made. */
export async function queuedTasks() {
  const { tasks } = await readTasks();
  return tasks.filter((t) => t.state === 'queued');
}

/** One task by id, or null. Ownership is the route's business, not ours. */
export async function findTask(id) {
  const { tasks } = await readTasks();
  return tasks.find((t) => t.id === id) || null;
}

/**
 * Retry: bring a FAILED task back to `queued`, same id, clean slate. The
 * dedupe key starts holding again the moment the state flips, so a double
 * click on Retry still costs one model call. Only failed-and-retryable
 * tasks qualify — retrying something that is already queued or processing
 * is what the dedupe key exists to prevent, and "ask again" after success
 * is a new task, not a rewrite of history.
 */
export async function retryTask(id) {
  return serialize(async () => {
    const { tasks } = await readTasks();
    const t = tasks.find((x) => x.id === id);
    if (!t) return { code: 'not-found' };
    if (t.state !== 'failed') return { code: 'not-failed', task: t };
    if (!t.retryable) return { code: 'not-retryable', task: t };
    t.state = 'queued';
    t.error = '';
    t.retryable = false;
    t.doneAt = null;
    await writeTasks(tasks);
    return { code: 'ok', task: t };
  });
}

/* ------------------------------------------------------------- executors --- */

/* What each action runs. Registering happens from the outside — the server
 * hands in the assembling actions (#61) as functions of its own, so this
 * module never has to import the book back (the circular import the split
 * exists to avoid). `echo` stays here as the pipeline's self-proof: it is
 * the action #59 shipped to show create → process → model → result works
 * before anything with a book arrived. */
const EXECUTORS = new Map();

/** Register the function an action runs. One action, one executor: a second
 *  registration is a programming error, not a last-wins convenience. */
export function registerExecutor(action, fn) {
  if (typeof fn !== 'function') throw new Error(`An executor for "${action}" must be a function.`);
  if (EXECUTORS.has(action)) throw new Error(`An executor for "${action}" is already registered.`);
  EXECUTORS.set(action, fn);
}

/** Whether an action has an executor — the route's whitelist, live. */
export function hasExecutor(action) {
  return EXECUTORS.has(action);
}

/** A task the copilot must NOT run — a customer out of scope, a confidential
 *  record, an account that vanished. Refusing is an honest answer, not a
 *  failure worth retrying: `runTask` reads `retryable` off the thrown error,
 *  and this is the one that says no. */
export class RefusedError extends Error {
  constructor(message) {
    super(message);
    this.retryable = false;
  }
}

registerExecutor('echo', async () => {
  const out = await aiComplete('Reply with the single word: OK', { maxTokens: 512 });
  return { text: out.text, model: out.model };
});

/**
 * Run one task to its end. Fire-and-forget from the route — the HTTP
 * response has already gone out with `queued`; everything below happens
 * in the background, and every exit lands in the table where the page's
 * poll will find it. A task may not vanish: if the executor itself throws,
 * that is a `failed` row, not a silence.
 */
export async function runTask(id) {
  const t = await markProcessing(id);
  if (!t) return;
  const exec = EXECUTORS.get(t.action);
  try {
    if (!exec) throw new Error(`Unknown action "${t.action}".`);
    const result = await exec(t);
    await markCompleted(id, result);
  } catch (e) {
    /* A refusal (RefusedError) is final — asking again cannot move a wall.
     * Everything else — a model that timed out, a network hiccup — keeps
     * the retry door open. */
    await markFailed(id, e?.message || 'The task failed.', e?.retryable !== false);
  }
}

/* ------------------------------------------ the deterministic first layer (§19.1)
 *
 * "Which Opportunities are overdue?" — "Which Customers belong to me?" —
 * "Which Next Steps are due tomorrow?" — "Which Opportunities have no
 * activity for 30 days?"
 *
 *   These should be answered directly by application/database logic.
 *   Do NOT call AI.            — the brief, §19.1, in its own words
 *
 * And the second half of §19.2's Test 7 asks the same of "Which
 * Opportunities have no recent follow-up?" — retrieve the records, and
 * answer from them when the question is deterministically answerable.
 *
 * Why this is here and not a task
 * --------------------------------
 * The task table above exists for one reason: an AI answer takes seconds,
 * and the caller should not have to babysit a spinner to keep the answer.
 * A rule answer takes no seconds. Queueing it would buy the spinner
 * without the wait, and a poll cycle, and a row in a table — all to hand
 * back a string that was already computed. So `answerByRule` is a plain
 * function: the route calls it in the same breath as the request, and the
 * response carries the answer itself. Nothing is written, no task is
 * created, and the code path never reaches the model transport — the
 * suite counts the calls around it to hold that line (task #63).
 *
 * What the rules are allowed to read
 * ----------------------------------
 * The route hands in the SAME view GET /api/data would hand the caller:
 * scoped to their customers, renamed to the current collection names,
 * with opportunity ages derived. So a rule cannot see past the wall —
 * and because nothing here is sent to a model, the confidential wall
 * (which governs what may be handed to a model, not what a person may
 * read) rightly does not apply: an owner asking "what is overdue?" hears
 * about their confidential customer's overdue deal, exactly as the board
 * on their screen already tells them.
 *
 * Discipline
 * ----------
 * The view is the caller's book, shared with the server's own copy for
 * an unrestricted role. The rules therefore only READ: every sort runs on
 * a slice, nothing appends, nothing is keyed in. This is also the shape
 * the static scan in verify-copilot-scope expects of an AI module — the
 * context is built as a literal, never as field assignments.
 *
 * The matchers are deliberately conservative. A question the table does
 * not recognise comes back as `unmatched`, which the route returns
 * honestly so the fast classifier (#64) can route it — a rule that
 * half-guessed would answer the wrong question with unearned confidence,
 * which is the exact failure §19.1 exists to prevent. The anchors are
 * the English sentences the brief and the product's own palette ask;
 * anything freer belongs to the classifier, not to a keyword table.
 */

const DAY_MS = 86400000;

/* Day key in the same shape the rows keep their dates: YYYY-MM-DD, UTC. */
const dayKey = (d) => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);

/* The palette's own money format, kept identical so a rule answer and the
 * screen it sits beside never disagree about what a deal is worth. */
const money = (n) => 'RM ' + (n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'm' : Math.round(n / 1e3) + 'k');

/* Days since a date string, or -1 when the row never said. An unreadable
 * date is not evidence of anything — least of all of neglect. */
const daysSince = (d) => {
  const t = Date.parse(String(d || ''));
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / DAY_MS) : -1;
};

/* The rule table. `match` is a list of patterns that must ALL be present;
 * `run` receives the prepared context and returns { answer, citations }.
 * Order is priority: the first rule whose patterns all hold wins, so the
 * specific (pains) stands ahead of the broad (my customers). */
const RULES = [
  {
    id: 'pains',
    match: [/\b(pain|problem|issue)s?\b/i],
    /* The palette's third question. A customer named in the question comes
     * first; otherwise the customer with the most recorded problems does. */
    run: (x) => {
      const withPain = x.customers.filter((c) => Array.isArray(c.pains) && c.pains.length);
      const named = withPain.find((c) => c.name && x.q.includes(String(c.name).toLowerCase()));
      const c0 = named || withPain.slice().sort((a, b) => b.pains.length - a.pains.length)[0];
      if (!c0) return { answer: 'No pain points have been recorded on any customer you can see.', citations: [] };
      const oppList = (Array.isArray(c0.opps) ? c0.opps : [])
        .map((id) => x.oppById(id)).filter(Boolean);
      const oppLine = oppList.length
        ? 'The opportunities attached to them: ' + oppList.map((o) => `${o.t} (${money(o.v)}).`.replace(/\).$/, ')')).join(', ') + '.'
        : 'No opportunity has been attached to them yet.';
      return {
        answer: `${c0.name} — ${c0.pains.length} recorded problem${c0.pains.length === 1 ? '' : 's'}: `
          + c0.pains.map((p) => String(p)).join('; ') + '. ' + oppLine,
        citations: c0.pains.map((p) => 'Pain · ' + String(p)),
      };
    },
  },
  {
    id: 'waiting',
    match: [/\bwaiting\b/i],
    /* The palette's first question: everything in the customers' court,
     * soonest first. Mirrors the page's own query exactly — from their
     * side, not done, sorted by due date. */
    run: (x) => {
      const theirs = x.stepRows
        .filter((s) => s.from === 'customer' && !String(s.done || '').trim())
        .slice()
        .sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')));
      if (!theirs.length) {
        return { answer: 'Nothing is waiting on a customer right now. Every open action is ours.', citations: [] };
      }
      const s = theirs[0];
      const line = (st) => `${st.exec || st.o || 'Someone'} at ${x.nameOf(st.c)} — ${st.t}`
        + (st.due ? `, due ${st.due}` : ', no date set');
      let answer = `${theirs.length} thing${theirs.length === 1 ? '' : 's'} in the customer's court. The nearest is ${line(s)}.`;
      if (theirs[1]) answer += ` After that, ${line(theirs[1])}.`;
      return { answer, citations: theirs.slice(0, 3).map((st) => 'Next step · ' + st.t) };
    },
  },
  {
    id: 'steps-due-tomorrow',
    match: [/\btomorrow\b/i, /\b(step|task|action|due|next)\b/i],
    /* §19.1's third example. "Tomorrow" is the next UTC day, which is the
     * same day key the rows already carry. */
    run: (x) => {
      const rows = x.stepRows.filter((s) => !String(s.done || '').trim() && String(s.due || '') === x.tomorrow);
      if (!rows.length) return { answer: 'Nothing is due tomorrow.', citations: [] };
      return {
        answer: `${rows.length} next step${rows.length === 1 ? '' : 's'} due tomorrow: `
          + rows.map((s) => `${s.exec || s.o || 'Someone'} at ${x.nameOf(s.c)} — ${s.t}`).join('; ') + '.',
        citations: rows.slice(0, 5).map((s) => 'Next step · ' + s.t),
      };
    },
  },
  {
    id: 'overdue-opps',
    /* NB: the entity pattern matches the STEM, not the whole word —
     * "opportunities" does not end where "opportunit" does, and a word-end
     * anchor there never matches the plural the brief itself uses. */
    match: [/\b(overdue|past\s+due|late)\b/i, /\b(opportunit|deal)/i],
    /* §19.1's first example: an open deal whose close date has passed. A
     * closed deal (a stage outside the pipeline) is never overdue — it
     * already happened. */
    run: (x) => {
      const rows = x.openOpps
        .filter((o) => /^\d{4}-\d{2}-\d{2}$/.test(String(o.close || '')) && String(o.close) < x.today)
        .slice()
        .sort((a, b) => String(a.close).localeCompare(String(b.close)));
      if (!rows.length) return { answer: 'No open opportunity is past its close date.', citations: [] };
      const worst = rows[0];
      return {
        answer: `${rows.length} overdue opportunit${rows.length === 1 ? 'y' : 'ies'}. The longest past its close date is `
          + `${worst.t} at ${x.nameOf(worst.c)} — was due ${worst.close}, ${money(worst.v)}, still in ${worst.stage}.`,
        citations: rows.slice(0, 5).map((o) => 'Opportunity · ' + o.t),
      };
    },
  },
  {
    id: 'no-activity',
    match: [/\b(no|without|any)\s+(activity|movement)\b/i, /\b(30|thirty)\b/i],
    /* §19.1's fourth example, read as the record's own quietness: an open
     * deal whose row has not been touched for 30 days. Kept distinct from
     * follow-up below — a deal can be freshly edited while nobody has
     * actually spoken to the customer in a month, and both facts are worth
     * their own question. */
    run: (x) => {
      const rows = x.openOpps.filter((o) => daysSince(o.updatedAt) >= 30);
      if (!rows.length) return { answer: 'Every open opportunity has moved in the last 30 days.', citations: [] };
      const listed = rows.slice(0, 5)
        .map((o) => `${o.t} at ${x.nameOf(o.c)} — ${daysSince(o.updatedAt)} days quiet`);
      return {
        answer: `${rows.length} open opportunit${rows.length === 1 ? 'y' : 'ies'} with no activity for 30 days: `
          + listed.join('; ') + '.',
        citations: rows.slice(0, 5).map((o) => 'Opportunity · ' + o.t),
      };
    },
  },
  {
    id: 'no-followup',
    match: [/\bfollow[\s-]?ups?\b|\bfollowed\b/i, /\b(no|without|recent|not|haven'?t|lacking)\b/i],
    /* Test 7 (§19.2): a follow-up is a person talking to the customer —
     * the interactions. The deal row may be fresh while the customer has
     * not heard from anyone in a month; this is the question that catches
     * exactly that. */
    run: (x) => {
      const rows = x.openOpps.filter((o) => {
        const since = x.lastFollowUp.get(o.c);
        return since === undefined || since > 30;
      });
      if (!rows.length) {
        return { answer: 'Every open opportunity\'s customer was followed up with in the last 30 days.', citations: [] };
      }
      const listed = rows.slice(0, 5).map((o) => {
        const since = x.lastFollowUp.get(o.c);
        return `${o.t} at ${x.nameOf(o.c)} — ${since === undefined ? 'no interaction ever recorded' : since + ' days since the last one'}`;
      });
      return {
        answer: `${rows.length} open opportunit${rows.length === 1 ? 'y' : 'ies'} with no recent follow-up: `
          + listed.join('; ') + '.',
        citations: rows.slice(0, 5).map((o) => 'Opportunity · ' + o.t),
      };
    },
  },
  {
    id: 'stalled-opp',
    match: [/\b(progress(ed|ing)?|stall(ed|ing)?|stuck|moved)\b/i, /\b(opportunit|deal|which|what)/i],
    /* The palette's second question: open deals by how long each has sat
     * in its current stage. Age comes off the derived view the route
     * built — the same number the board shows. */
    run: (x) => {
      if (!x.openOpps.length) {
        return { answer: 'There are no open opportunities in the customers you can see.', citations: [] };
      }
      const worst = x.openOpps.slice().sort((a, b) => (b.age || 0) - (a.age || 0))[0];
      const tail = (worst.p ?? 100) <= 25 ? `, and the probability has not moved past ${worst.p}%` : '';
      return {
        answer: `${x.openOpps.length} open opportunit${x.openOpps.length === 1 ? 'y' : 'ies'}. The one that has sat longest is `
          + `${worst.t} at ${x.nameOf(worst.c)} — ${worst.age || 0} days in ${worst.stage}, ${money(worst.v)}${tail}.`,
        citations: ['Opportunity · ' + worst.t, 'Customer · ' + x.nameOf(worst.c)],
      };
    },
  },
  {
    id: 'my-customers',
    match: [/\b(my|mine|me)\b/i, /\b(customer|account|client|book)s?\b/i],
    /* §19.1's second example. The view the route hands in is already the
     * caller's own book, so the answer is the customers in it — no scope
     * arithmetic to repeat, and none to get wrong. */
    run: (x) => {
      if (!x.customers.length) return { answer: 'You have no customers yet.', citations: [] };
      const listed = x.customers.slice(0, 8)
        .map((c) => `${c.name}${c.industry ? ' (' + c.industry + ')' : ''}`);
      return {
        answer: `${x.customers.length} customer${x.customers.length === 1 ? '' : 's'} in your book: `
          + listed.join('; ') + '.',
        citations: x.customers.slice(0, 8).map((c) => 'Customer · ' + c.name),
      };
    },
  },
];

/**
 * The first layer. Feed it a question and the caller's view (the same
 * shape GET /api/data returns); it answers from the records or admits it
 * does not know. It never throws for a strange question — a strange
 * question is simply unmatched, and that is information, not an error.
 */
export function answerByRule(question, view) {
  const q = String(question || '').toLowerCase();
  const src = view && typeof view === 'object' && !Array.isArray(view) ? view : {};
  const stages = Array.isArray(src.config && src.config.stages) && src.config.stages.length
    ? src.config.stages.map(String)
    : ['Interested', 'Evaluating', 'POC / Quoted', 'Submitted'];
  const customers = Array.isArray(src.customers) ? src.customers.filter(Boolean) : [];
  const oppsMap = src.opps && typeof src.opps === 'object' && !Array.isArray(src.opps) ? src.opps : {};
  const oppRows = Object.values(oppsMap).filter(Boolean);
  const stepRows = Array.isArray(src.steps) ? src.steps.filter(Boolean) : [];
  const momRows = Array.isArray(src.interactions) ? src.interactions.filter(Boolean) : [];
  /* Days since each customer's most recent interaction — the smallest
   * gap wins. A row whose date cannot be read is skipped: it is not
   * evidence of a follow-up, and pretending it was one would hide a
   * customer who has genuinely not been called. */
  const lastFollowUp = new Map();
  for (const m of momRows) {
    const d = daysSince(m.d);
    if (d < 0) continue;
    const prev = lastFollowUp.get(m.c);
    if (prev === undefined || d < prev) lastFollowUp.set(m.c, d);
  }
  /* Built as a literal, on purpose: the static scan in verify-copilot-scope
   * holds AI modules to "no field assignments onto the business tables",
   * and a literal is also simply the clearest shape for a read-only
   * context. */
  const ctx = {
    q,
    customers,
    oppRows,
    openOpps: oppRows.filter((o) => stages.includes(String(o.stage ?? ''))),
    stepRows,
    momRows,
    lastFollowUp,
    oppById: (id) => oppsMap[id],
    nameOf: (cid) => String((customers.find((c) => c.id === cid) || {}).name || ''),
    today: dayKey(new Date()),
    tomorrow: dayKey(new Date(Date.now() + DAY_MS)),
  };
  for (const rule of RULES) {
    if (!rule.match.every((re) => re.test(q))) continue;
    const out = rule.run(ctx);
    return { kind: 'rule', rule: rule.id, answer: String(out.answer || ''), citations: out.citations || [] };
  }
  return { kind: 'unmatched' };
}

/* ------------------------------------------- the classifier (#64, §19.2)
 *
 * "When practical, determine the user's intent and retrieve relevant data
 *  before invoking AI." — §19.2
 *
 * The rules above are the practical half: eight questions a keyword can
 * place. This is the rest — one small, fast, STRUCTURED call whose only job
 * is to say which handler the ask belongs to, so the heavy call that answers
 * it can be assembled from the right records and nothing else. It is a
 * router, not an oracle: the model never sees the book, only the menu of
 * targets the caller may name, and its answer is a JSON line we check
 * against a whitelist before anyone acts on it.
 *
 * Why the menu and not the question alone
 * ---------------------------------------
 * An open-ended "which customer?" invites the model to invent one — a
 * hallucinated id routed to a briefing is a briefing about nobody, or worse,
 * about somebody else. So the prompt is a multiple-choice paper: the
 * customers and opportunities the CALLER can see (minus confidential ones —
 * a confidential record is never sent to a model, not even its name in a
 * menu), each with its id, and the model's only degrees of freedom are
 * picking from that list or falling back to `global`. An id that is not on
 * the menu is treated as no id at all and the ask degrades to global — the
 * same mercy the KINDS precedent in company-lookup.mjs extends to a kind the
 * model made up: a wrong guess must never crash the pipeline or route to a
 * record that was never offered.
 *
 * When the model answers with something that is not JSON at all, that is not
 * a guess to forgive — there is nothing to forgive it INTO — so the caller
 * fails the task, retryably, and the person decides whether to ask again.
 */

/* The three kinds, aligned with the three assemblers (#65): a customer, an
 * opportunity, or the caller's book as a whole. */
export const ANSWER_KINDS = ['customer', 'opportunity', 'global'];

const CLASSIFY_SYSTEM = 'You route questions for a sales workspace. You answer with one JSON object and nothing else — no prose, no code fence.';

export async function classifyAsk(question, view) {
  const src = view && typeof view === 'object' && !Array.isArray(view) ? view : {};
  /* The menu: what the caller may name. Confidential customers never appear
   * — the wall is about what is sent to a model, and a menu entry IS a
   * sending — and an opportunity whose customer is confidential follows its
   * customer out. */
  const menuCustomers = (Array.isArray(src.customers) ? src.customers : [])
    .filter((c) => c && c.id && !c.confidential);
  const byId = new Map(menuCustomers.map((c) => [String(c.id), c]));
  const oppsMap = src.opps && typeof src.opps === 'object' && !Array.isArray(src.opps) ? src.opps : {};
  const menuOpps = Object.values(oppsMap)
    .filter((o) => o && o.c !== undefined && byId.has(String(o.c)));
  const oppIds = new Set(menuOpps.map((o) => String(o.id)));

  const lines = [
    'Route this question to one of three handlers. Answer with one JSON object only:',
    '{"kind":"customer"|"opportunity"|"global","targetId":"<an id from the lists below, when kind is customer or opportunity>","entities":["short noun phrases the question is about"]}',
    '',
    'kind customer — the question is about ONE customer from the list below.',
    'kind opportunity — about ONE opportunity from the list below.',
    'kind global — about the caller\'s book as a whole, or none of the above.',
    'A question that mentions no listed customer or opportunity is global. Never invent an id.',
    '',
  ];
  if (menuCustomers.length) {
    lines.push('Customers the caller can see:');
    for (const c of menuCustomers.slice(0, 40)) lines.push(`- ${c.name} (${c.id})`);
  } else {
    lines.push('Customers the caller can see: none.');
  }
  lines.push('');
  if (menuOpps.length) {
    lines.push('Opportunities the caller can see:');
    for (const o of menuOpps.slice(0, 60)) {
      const c = byId.get(String(o.c));
      lines.push(`- ${o.t || '(untitled)'} at ${c ? c.name : 'an unnamed customer'} (${o.id})`);
    }
  } else {
    lines.push('Opportunities the caller can see: none.');
  }
  lines.push('', `Question: "${String(question || '').slice(0, 500)}"`);

  const { text } = await aiComplete(lines.join('\n'), {
    system: CLASSIFY_SYSTEM, fast: true, temperature: 0, maxTokens: 2000,
  });
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, code: 'no-read' };
  let j;
  try { j = JSON.parse(m[0]); } catch { return { ok: false, code: 'no-read' }; }

  /* A made-up kind degrades to global; a made-up (or merely stale) id
   * degrades the ask to global too. Degrade, don't crash, don't route to a
   * record that was never on the menu. */
  let kind = ANSWER_KINDS.includes(j.kind) ? j.kind : 'global';
  let targetId = String(j.targetId || '').slice(0, 64);
  if (kind === 'customer' && !byId.has(targetId)) kind = 'global';
  if (kind === 'opportunity' && !oppIds.has(targetId)) kind = 'global';
  if (kind === 'global') targetId = '';
  const entities = (Array.isArray(j.entities) ? j.entities : [])
    .map((e) => String(e).replace(/\s+/g, ' ').trim().slice(0, 120))
    .filter(Boolean).slice(0, 8);
  return { ok: true, kind, targetId, entities };
}

/* ------------------------------------- the global fallback context (#64)
 *
 * The smallest honest assembly: one line per customer the caller can see,
 * never the book itself ("Do not send the database to AI", §19.2). Names,
 * standing, health, the count of open deals, how long since anyone spoke —
 * enough for a model to answer "what should I look at this quarter?" without
 * being handed a single pain point, contact or minute it does not need
 * (#65's buildGlobalContext upgrades this from a roster to a retrieval; the
 * shape it must fit is already this one). Confidential customers are absent
 * for the same reason they are absent from the classifier's menu.
 */
export function assembleGlobalContext(view) {
  const src = view && typeof view === 'object' && !Array.isArray(view) ? view : {};
  const stages = Array.isArray(src.config && src.config.stages) && src.config.stages.length
    ? src.config.stages.map(String)
    : ['Interested', 'Evaluating', 'POC / Quoted', 'Submitted'];
  const customers = (Array.isArray(src.customers) ? src.customers : [])
    .filter((c) => c && c.id && !c.confidential);
  const oppRows = Object.values(src.opps && typeof src.opps === 'object' && !Array.isArray(src.opps) ? src.opps : {})
    .filter(Boolean);
  const momRows = Array.isArray(src.interactions) ? src.interactions.filter(Boolean) : [];
  const facts = [];
  const citations = [];
  for (const c of customers.slice(0, 12)) {
    const open = oppRows.filter((o) => String(o.c) === String(c.id) && stages.includes(String(o.stage ?? '')));
    const lastMom = momRows
      .filter((m) => String(m.c) === String(c.id) && Date.parse(m.d))
      .map((m) => Date.parse(m.d))
      .sort((a, b) => b - a)[0];
    const quiet = lastMom ? Math.floor((Date.now() - lastMom) / 864e5) : null;
    facts.push(`${c.name} — ${c.industry || 'industry unrecorded'}, ${c.stance || 'stance unrecorded'}, `
      + `health ${c.health || 'unrecorded'}; ${open.length} open opportunit${open.length === 1 ? 'y' : 'ies'}`
      + (quiet === null ? '; no interaction recorded' : `; last interaction ${quiet} days ago`));
    citations.push('Customer · ' + c.name);
  }
  return {
    facts,
    citations,
    note: customers.length > 12
      ? `Showing the first 12 of ${customers.length} customers.`
      : '',
  };
}

/* ------------------------------------- #65 the three context assemblers
 *
 * §19.3/§19.4: when AI is genuinely required, send only what is needed,
 * within the limits the spec names. Every assembler takes the CALLER'S
 * scoped view and returns {ok, facts, citations} — facts are line texts a
 * model can read, citations carry the record id ("Kind · label (id)") so an
 * answer can be traced back to what it was built on (§16: "Allow users to
 * open the source Customer / Opportunity / MOM / Next Step"). None of them
 * call a model; none of them write anything. The field shapes are ported
 * from the shipped front-end prototypes — buildInsightFacts (customer) and
 * oppFacts (opportunity) — which were already assembled answers, just
 * client-side. Confidential records never enter any facts, on any path:
 * the classifier's menu keeps their ids out of a routing, and the
 * assemblers re-check the wall themselves (the menu is a promise from a
 * model; the wall is a promise from the code).
 */

const normView = (view) => (view && typeof view === 'object' && !Array.isArray(view) ? view : {});
const stagesOf = (src) => (Array.isArray(src.config && src.config.stages) && src.config.stages.length
  ? src.config.stages.map(String)
  : ['Interested', 'Evaluating', 'POC / Quoted', 'Submitted']);
const oppRowsOf = (src) => Object.values(
  src.opps && typeof src.opps === 'object' && !Array.isArray(src.opps) ? src.opps : {},
).filter(Boolean);
const stepOpen = (s) => !!s && !String(s.done || '').trim();
const citeInto = (citations) => (kind, label, id) =>
  citations.push(`${kind} · ${String(label).slice(0, 80)} (${id})`);

/** The customer context: the §19.4 limits (≤10 open opps, ≤5 recent MOMs,
 * ≤10 open steps, ≤20 timeline rows) over the §6 summary domains. */
export function buildCustomerContext(view, customerId) {
  const src = normView(view);
  const stages = stagesOf(src);
  const c = (Array.isArray(src.customers) ? src.customers : [])
    .find((x) => x && String(x.id) === String(customerId));
  if (!c) return { ok: false, code: 'not-found' };
  if (c.confidential) return { ok: false, code: 'confidential' };

  const facts = [];
  const citations = [];
  const cite = citeInto(citations);

  facts.push(`Customer: ${c.name || '(unnamed)'}`
    + (c.industry ? ` — ${c.industry}` : '') + (c.hq ? `, HQ ${c.hq}` : ''));
  facts.push(`Stance: ${c.stance || 'unrecorded'}; health ${c.health || 'unrecorded'}`);
  cite('Customer', c.name || c.id, c.id);

  const pains = (Array.isArray(c.pains) ? c.pains : []).map(String).filter(Boolean);
  if (pains.length) facts.push('Pain points: ' + pains.join('; '));

  const contacts = (Array.isArray(c.contacts) ? c.contacts : []).filter(Boolean);
  if (contacts.length) {
    facts.push('People: ' + contacts.slice(0, 10)
      .map((p) => `${p.n || 'unnamed'}${p.t ? ' — ' + p.t : ''}${p.s ? ' (' + p.s + ')' : ''}`)
      .join('; '));
  }

  const opps = oppRowsOf(src).filter((o) => String(o.c) === String(c.id));
  const open = opps.filter((o) => stages.includes(String(o.stage ?? '')));
  if (open.length) {
    facts.push('Open opportunities:');
    for (const o of open.slice(0, 10)) {
      facts.push(`- ${o.t || '(untitled)'} — ${o.stage}${o.v != null ? ', ' + money(o.v) : ''}`
        + (o.p != null ? `, ${o.p}%` : '') + (o.close ? `, closes ${o.close}` : ''));
      cite('Opportunity', o.t || o.id, o.id);
    }
    if (open.length > 10) facts.push(`(${open.length - 10} more open opportunities not listed)`);
  } else {
    facts.push('No open opportunities.');
  }

  const moms = (Array.isArray(src.interactions) ? src.interactions : [])
    .filter((m) => m && String(m.c) === String(c.id))
    .slice()
    .sort((a, b) => String(b.d || '').localeCompare(String(a.d || '')));
  if (moms.length) {
    facts.push('Recent meetings:');
    for (const m of moms.slice(0, 5)) {
      facts.push(`- ${m.d || 'undated'} ${m.t || '(untitled)'}`
        + (m.att ? ` with ${m.att}` : '') + (m.out ? ` — ${m.out}` : ''));
      cite('MOM', m.t || m.d || m.id, m.id);
    }
    if (moms.length > 5) facts.push(`(${moms.length - 5} earlier meetings not listed)`);
  } else {
    facts.push('No meetings recorded.');
  }

  const steps = (Array.isArray(src.steps) ? src.steps : [])
    .filter((s) => String(s.c) === String(c.id) && stepOpen(s));
  if (steps.length) {
    facts.push('Open next steps:');
    for (const s of steps.slice(0, 10)) {
      facts.push(`- ${s.t || '(untitled)'}` + (s.due ? ` due ${s.due}` : '')
        + (s.from === 'customer' ? ' (waiting on them)' : s.from === 'us' ? ' (our move)' : ''));
      cite('Next step', s.t || s.id, s.id);
    }
    if (steps.length > 10) facts.push(`(${steps.length - 10} more open steps not listed)`);
  } else {
    facts.push('No open next steps.');
  }

  const tl = (Array.isArray(c.timeline) ? c.timeline : []).filter(Boolean);
  if (tl.length) {
    facts.push('Recent timeline:');
    for (const t of tl.slice(-20).reverse()) {
      facts.push(`- ${[t.d, t.k, t.t].filter(Boolean).join(' ')}`);
    }
    cite('Timeline', `${tl.length} event(s)`, c.id);
  }

  return { ok: true, facts, citations };
}

/* ------------------------------------- #69 the customer brief, in sections
 *
 * §6 names ten things a customer brief may summarise. This assembler turns
 * the CALLER'S scoped view of one customer into those ten sections, each
 * line carrying an optional ref to the record it came from — the front end
 * renders the ref as a door (§16: "Allow users to open the source Customer
 * / Opportunity / MOM / Next Step"), so every important fact is traceable.
 * Facts and the model's reading stay apart by construction: this returns
 * what the book says, the executor asks the model only to organise and
 * point at what matters (§11: facts vs suggestions, visibly separated).
 * Nothing here calls a model or writes anything; the confidential wall is
 * checked before a single line is assembled. */
export function buildCustomerFacts(view, customerId) {
  const src = normView(view);
  const stages = stagesOf(src);
  const c = (Array.isArray(src.customers) ? src.customers : [])
    .find((x) => x && String(x.id) === String(customerId));
  if (!c) return { ok: false, code: 'not-found' };
  if (c.confidential) return { ok: false, code: 'confidential' };

  const citations = [];
  const cite = citeInto(citations);
  const sections = [];
  const section = (key, title, lines) => sections.push({ key, title, lines });
  const line = (text, ref) => ({ text, ref });
  const plain = (text) => ({ text });
  const NONE = 'None recorded.';

  /* 1 — overview. */
  {
    const bits = [];
    if (c.industry) bits.push(c.industry);
    if (c.hq) bits.push('HQ ' + c.hq);
    if (c.people) bits.push(c.people + ' people');
    if (c.since) bits.push('customer since ' + c.since);
    section('overview', 'Customer', [
      line([c.name || '(unnamed customer)'].concat(bits).join(' — '),
        { kind: 'customer', id: c.id, label: c.name || c.id }),
    ]);
    cite('Customer', c.name || c.id, c.id);
  }

  /* 2 — current relationship: the account team the book names, and the
     two words the health board lives by. */
  {
    const bits = [];
    if (c.owner) bits.push('Primary BD ' + c.owner);
    if (c.sa) bits.push('Primary SA ' + c.sa);
    bits.push('stance ' + (c.stance || 'unrecorded'));
    bits.push('health ' + (c.health || 'unrecorded'));
    section('relationship', 'Relationship', [plain(bits.join(' · '))]);
  }

  /* 3 — key people (§6 "Key People"): who they are, not what they think. */
  {
    const contacts = (Array.isArray(c.contacts) ? c.contacts : []).filter(Boolean);
    section('people', 'Key people', contacts.length
      ? contacts.slice(0, 10).map((p) => line(
        [p.t || '', p.s ? p.s : '', p.b || ''].filter(Boolean).join(' · ') || 'role unrecorded',
        { kind: 'customer', id: c.id, label: p.n || 'unnamed' }))
      : [plain(NONE)]);
  }

  /* 4 — active opportunities (open stages only; parked deals park). */
  const opps = oppRowsOf(src).filter((o) => String(o.c) === String(c.id));
  const open = opps.filter((o) => stages.includes(String(o.stage ?? '')));
  section('opportunities', 'Active opportunities', open.length
    ? open.slice(0, 10).map((o) => {
      cite('Opportunity', o.t || o.id, o.id);
      return line([
        o.stage || 'stage unrecorded',
        o.v != null ? money(o.v) : '',
        o.p != null ? o.p + '%' : '',
        o.close ? 'closes ' + o.close : '',
      ].filter(Boolean).join(' · '), { kind: 'opp', id: o.id, label: o.t || '(untitled)' });
    })
    : [plain('No open opportunities.')]);

  /* 5 — recent MOM (§6 "Recent MOM"), newest first, the same five the
     summary context reads. */
  const moms = (Array.isArray(src.interactions) ? src.interactions : [])
    .filter((m) => m && String(m.c) === String(c.id))
    .slice()
    .sort((a, b) => String(b.d || '').localeCompare(String(a.d || '')));
  section('meetings', 'Recent meetings', moms.length
    ? moms.slice(0, 5).map((m) => {
      cite('MOM', m.t || m.d || m.id, m.id);
      return line([m.d || 'undated', m.att ? 'with ' + m.att : '', m.out || '']
        .filter(Boolean).join(' · '), { kind: 'mom', id: m.id, label: m.t || '(untitled)' });
    })
    : [plain('No meetings recorded.')]);

  /* 6 — open next steps, with whose move it is. */
  const steps = (Array.isArray(src.steps) ? src.steps : [])
    .filter((s) => String(s.c) === String(c.id) && stepOpen(s));
  section('steps', 'Open next steps', steps.length
    ? steps.slice(0, 10).map((s) => {
      cite('Next step', s.t || s.id, s.id);
      return line([
        s.due ? 'due ' + s.due : 'undated',
        s.from === 'customer' ? 'waiting on them' : s.from === 'us' ? 'our move' : '',
      ].filter(Boolean).join(' · '), { kind: 'step', id: s.id, label: s.t || '(untitled)' });
    })
    : [plain('No open next steps.')]);

  /* 7 — pain points, verbatim from the record. */
  {
    const pains = (Array.isArray(c.pains) ? c.pains : []).map(String).filter(Boolean);
    section('pains', 'Pain points', pains.length ? pains.map((p) => plain(p)) : [plain(NONE)]);
  }

  /* 8 — existing environment (§6): the products the open deals actually
     discuss — §13's controlled reference, never a guess about their
     datacentre. */
  {
    const names = new Set();
    for (const o of open) {
      for (const id of (Array.isArray(o.items) ? o.items : [])) {
        const p = (Array.isArray(src.products) ? src.products : [])
          .find((x) => x && String(x.id) === String(id));
        if (p && p.n) names.add(p.n);
      }
    }
    section('environment', 'Existing environment',
      names.size ? [plain([...names].join('; '))] : [plain(NONE)]);
  }

  /* 9 — risks / blockers: only what the book records — a blocker string on
     an open deal. An empty section is an honest "none recorded", not an
     all-clear the data cannot support. */
  {
    const risks = open
      .filter((o) => String(o.blockers || '').trim())
      .map((o) => line('Blocker — ' + String(o.blockers).trim(),
        { kind: 'opp', id: o.id, label: o.t || '(untitled)' }));
    section('risks', 'Risks / blockers', risks.length ? risks : [plain(NONE)]);
  }

  /* 10 — recent timeline, the same twenty the summary context reads. */
  {
    const tl = (Array.isArray(c.timeline) ? c.timeline : []).filter(Boolean);
    if (tl.length) cite('Timeline', tl.length + ' event(s)', c.id);
    section('timeline', 'Recent timeline', tl.length
      ? tl.slice(-20).reverse().map((t) => plain([t.d, t.k, t.t, t.x].filter(Boolean).join(' — ')))
      : [plain('No timeline events.')]);
  }

  return { ok: true, customerId: c.id, sections, citations };
}

/* ------------------------------------- #70 the opportunity analysis, in sections
 *
 * §7 names what an opportunity analysis may include — situation, need,
 * technical context, risks, missing information, recommended next action.
 * This assembler carries the first five as facts from the CALLER'S scoped
 * view, one section each, every line optionally a door into its record
 * (§16). "Missing information" is deterministic here (§15): the gaps it
 * lists are absences the book itself can prove — no close date, no
 * description, no recorded pain, no meeting, no open step. The model's
 * half (§7's Recommended Next Action, and its own reading of gaps) is the
 * executor's to ask for, and the two halves never blend (§11). */
export function buildOppFacts(view, oppId) {
  const src = normView(view);
  const stages = stagesOf(src);
  const o = oppRowsOf(src).find((x) => x && String(x.id) === String(oppId));
  if (!o) return { ok: false, code: 'not-found' };
  const c = (Array.isArray(src.customers) ? src.customers : [])
    .find((x) => x && String(x.id) === String(o.c));
  if (!c) return { ok: false, code: 'not-found' };
  if (c.confidential) return { ok: false, code: 'confidential' };

  const citations = [];
  const cite = citeInto(citations);
  const sections = [];
  const section = (key, title, lines) => sections.push({ key, title, lines });
  const line = (text, ref) => ({ text, ref });
  const plain = (text) => ({ text });
  const NONE = 'None recorded.';
  const oppRef = { kind: 'opp', id: o.id, label: o.t || '(untitled)' };
  cite('Opportunity', o.t || o.id, o.id);
  cite('Customer', c.name || c.id, c.id);

  /* 1 — current situation: the deal's own row, the age the board reads. */
  {
    const bits = [
      o.stage || 'stage unrecorded',
      Number.isFinite(o.age) ? o.age + ' day' + (o.age === 1 ? '' : 's') + ' in stage' : '',
      o.v != null ? money(o.v) : '',
      o.p != null ? o.p + '%' : '',
      o.close ? 'closes ' + o.close : '',
      o.comp && o.comp !== '—' ? 'competitor ' + o.comp : '',
    ].filter(Boolean);
    section('situation', 'Current situation', [
      line(bits.join(' · '), oppRef),
      line(o.owner ? 'Owner ' + o.owner : 'No owner recorded', oppRef),
    ]);
  }

  /* 2 — customer need: the pains on the account and the deal's own words. */
  {
    const pains = (Array.isArray(c.pains) ? c.pains : []).map(String).filter(Boolean);
    const lines = [];
    if (String(o.desc || '').trim()) lines.push(line(String(o.desc).trim(), oppRef));
    if (pains.length) lines.push(line('Recorded pains: ' + pains.join('; '),
      { kind: 'customer', id: c.id, label: c.name || c.id }));
    section('need', 'Customer need', lines.length ? lines : [plain(NONE)]);
  }

  /* 3 — technical context (§7 "Technical Context"): the products the deal
     actually discusses — §13's controlled reference, never a guess. */
  {
    const names = (Array.isArray(o.items) ? o.items : [])
      .map((id) => (Array.isArray(src.products) ? src.products : [])
        .find((p) => p && String(p.id) === String(id)))
      .filter(Boolean).map((p) => p.n || p.id);
    section('context', 'Technical context',
      names.length ? [line(names.join('; '), oppRef)] : [plain(NONE)]);
  }

  /* 4 — risks / blockers: only the blocker string the book holds. */
  {
    const bl = String(o.blockers || '').trim();
    section('risks', 'Risks / blockers',
      bl ? [line(bl, oppRef)] : [plain(NONE)]);
  }

  /* 5 — missing information (§15, deterministic): each gap listed here is
     an absence the records themselves prove. Nothing is inferred — §15's
     last two examples (a requirement with no action, a MOM hinting the
     stage needs review) are crosses the MODEL may draw from these facts,
     not lines this book can prove, and §15's last line warns against a
     rigid checklist. The tone stays a plain sentence: a suggestion the
     reader weighs, never a warning light. */
  {
    const gaps = [];
    if (!o.close) gaps.push('No close date recorded.');
    if (!String(o.desc || '').trim()) gaps.push('The opportunity has no description.');
    if (!(Array.isArray(c.pains) ? c.pains : []).filter(Boolean).length) gaps.push('No pain point recorded on the customer.');
    const moms = (Array.isArray(src.interactions) ? src.interactions : [])
      .filter((m) => m && String(m.c) === String(c.id));
    if (!moms.length) gaps.push('No meeting recorded with the customer.');
    else {
      /* §15's "no recent MOM": the last one sits further back than a
       * working relationship explains. */
      const latest = moms
        .map((m) => Date.parse(String(m.d || '')))
        .filter(Number.isFinite).sort((a, b) => b - a)[0];
      if (latest != null && (Date.now() - latest) > 45 * 864e5) {
        gaps.push('No meeting recorded in the last 45 days.');
      }
    }
    const oSteps = (Array.isArray(src.steps) ? src.steps : [])
      .filter((s) => String(s.c) === String(c.id) && String(s.o || '') === String(o.id) && stepOpen(s));
    if (!oSteps.length) gaps.push('No open next step on this opportunity.');
    if (stages.includes(String(o.stage ?? '')) && !o.owner) gaps.push('No owner recorded.');
    /* §15's "customer has no identified decision maker": the contact list
     * holds nobody the book has classified as one. */
    const hasDecider = (Array.isArray(c.contacts) ? c.contacts : [])
      .some((p) => p && String(p.b || '').trim().toLowerCase() === 'decision maker');
    if (!hasDecider) gaps.push('No decision maker identified on the customer.');
    /* §15's "existing environment is incomplete": nothing the account runs
     * today has been written down. */
    if (!(Array.isArray(c.apps) ? c.apps : []).filter(Boolean).length) {
      gaps.push('No system recorded on the customer.');
    }
    section('gaps', 'Missing information', gaps.length ? gaps.map((g) => plain(g)) : [plain('Nothing obvious is missing.')]);
  }

  /* 6 — recent development: the account's latest MOMs, the three the
     opportunity context reads. */
  {
    const moms = (Array.isArray(src.interactions) ? src.interactions : [])
      .filter((m) => m && String(m.c) === String(c.id))
      .slice()
      .sort((a, b) => String(b.d || '').localeCompare(String(a.d || '')));
    section('meetings', 'Recent meetings', moms.length
      ? moms.slice(0, 3).map((m) => {
        cite('MOM', m.t || m.d || m.id, m.id);
        return line([m.d || 'undated', m.att ? 'with ' + m.att : '', m.out || '']
          .filter(Boolean).join(' · '), { kind: 'mom', id: m.id, label: m.t || '(untitled)' });
      })
      : [plain('No meetings recorded.')]);
  }

  /* 7 — open next steps on THIS deal (s.o is the modern opp link). */
  {
    const steps = (Array.isArray(src.steps) ? src.steps : [])
      .filter((s) => String(s.c) === String(c.id) && String(s.o || '') === String(o.id) && stepOpen(s));
    section('steps', 'Open next steps', steps.length
      ? steps.slice(0, 10).map((s) => {
        cite('Next step', s.t || s.id, s.id);
        return line([
          s.due ? 'due ' + s.due : 'undated',
          s.from === 'customer' ? 'waiting on them' : s.from === 'us' ? 'our move' : '',
        ].filter(Boolean).join(' · '), { kind: 'step', id: s.id, label: s.t || '(untitled)' });
      })
      : [plain('No open next steps on this opportunity.')]);
  }

  /* 8 — key people: the account's contacts, the decision makers first. */
  {
    const contacts = (Array.isArray(c.contacts) ? c.contacts : []).filter(Boolean);
    section('people', 'Key people', contacts.length
      ? contacts.slice(0, 8).map((p) => line(
        [p.t || '', p.s ? p.s : '', p.b || ''].filter(Boolean).join(' · ') || 'role unrecorded',
        { kind: 'customer', id: c.id, label: p.n || 'unnamed' }))
      : [plain(NONE)]);
  }

  return { ok: true, customerId: c.id, oppId: o.id, sections, citations };
}

/** The opportunity context: §19.3's list for one deal — the opportunity
 * itself, the relevant customer summary, pain points, the products actually
 * discussed (§13's controlled reference), the latest 3–5 MOMs, open steps
 * and the people on the account. */
export function buildOppContext(view, oppId) {
  const src = normView(view);
  const o = oppRowsOf(src).find((x) => x && String(x.id) === String(oppId));
  if (!o) return { ok: false, code: 'not-found' };
  const c = (Array.isArray(src.customers) ? src.customers : [])
    .find((x) => x && String(x.id) === String(o.c));
  if (!c) return { ok: false, code: 'not-found' };
  if (c.confidential) return { ok: false, code: 'confidential' };

  const facts = [];
  const citations = [];
  const cite = citeInto(citations);
  const age = Number.isFinite(o.age) ? o.age : null;

  facts.push(`Opportunity: ${o.t || '(untitled)'} — ${o.stage || 'stage unrecorded'}`
    + (age != null ? `, ${age} day${age === 1 ? '' : 's'} in stage` : ''));
  facts.push(`Value: ${o.v != null ? money(o.v) : 'unrecorded'}`
    + (o.p != null ? ` at ${o.p}%` : '') + (o.close ? `, closes ${o.close}` : '')
    + (o.comp && o.comp !== '—' ? `, competitor ${o.comp}` : ''));
  cite('Opportunity', o.t || o.id, o.id);
  facts.push(`Customer: ${c.name || '(unnamed)'}`
    + (c.industry ? ` — ${c.industry}` : '')
    + `; stance ${c.stance || 'unrecorded'}, health ${c.health || 'unrecorded'}`);
  cite('Customer', c.name || c.id, c.id);

  const pains = (Array.isArray(c.pains) ? c.pains : []).map(String).filter(Boolean);
  if (pains.length) facts.push('Pain points: ' + pains.join('; '));

  const prods = (Array.isArray(o.items) ? o.items : [])
    .map((id) => (Array.isArray(src.products) ? src.products : [])
      .find((p) => p && String(p.id) === String(id)))
    .filter(Boolean);
  if (prods.length) facts.push('Products discussed: ' + prods.map((p) => p.n || p.id).join('; '));

  const moms = (Array.isArray(src.interactions) ? src.interactions : [])
    .filter((m) => m && String(m.c) === String(c.id))
    .slice()
    .sort((a, b) => String(b.d || '').localeCompare(String(a.d || '')));
  if (moms.length) {
    facts.push('Latest meetings:');
    for (const m of moms.slice(0, 3)) {
      facts.push(`- ${m.d || 'undated'} ${m.t || '(untitled)'}`
        + (m.att ? ` with ${m.att}` : '') + (m.out ? ` — ${m.out}` : ''));
      cite('MOM', m.t || m.d || m.id, m.id);
    }
    if (moms.length > 3) facts.push(`(${moms.length - 3} earlier meetings not listed)`);
  } else {
    facts.push('No meetings recorded.');
  }

  const steps = (Array.isArray(src.steps) ? src.steps : [])
    .filter((s) => String(s.c) === String(c.id) && stepOpen(s));
  if (steps.length) {
    facts.push('Open next steps:');
    for (const s of steps.slice(0, 10)) {
      facts.push(`- ${s.t || '(untitled)'}` + (s.due ? ` due ${s.due}` : '')
        + (s.from === 'customer' ? ' (waiting on them)' : s.from === 'us' ? ' (our move)' : ''));
      cite('Next step', s.t || s.id, s.id);
    }
  } else {
    facts.push('No open next steps.');
  }

  const contacts = (Array.isArray(c.contacts) ? c.contacts : []).filter(Boolean);
  if (contacts.length) {
    facts.push('People: ' + contacts.slice(0, 10)
      .map((p) => `${p.n || 'unnamed'}${p.t ? ' — ' + p.t : ''}${p.s ? ' (' + p.s + ')' : ''}`)
      .join('; '));
  }

  return { ok: true, facts, citations };
}

/** The global context: §19.4's "only retrieve records relevant to the
 * user's query" — a small token-overlap retrieval over the caller's own
 * book (no vectors, no new dependencies), falling back to the roster shape
 * #64 shipped when nothing matches. Either way the confidential wall holds:
 * a row whose customer is confidential is not scored, not listed, not
 * mentioned. */
export function buildGlobalContext(view, question, entities) {
  const src = normView(view);
  const customers = (Array.isArray(src.customers) ? src.customers : [])
    .filter((c) => c && c.id && !c.confidential);
  const byId = new Map(customers.map((c) => [String(c.id), c]));
  const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'which', 'who', 'how', 'are',
    'was', 'were', 'has', 'have', 'had', 'not', 'any', 'all', 'our', 'their', 'this',
    'that', 'from', 'into', 'about', 'should', 'would', 'could', 'need', 'needs',
    'attention', 'recent', 'recently', 'summary', 'summarise', 'summarize', 'tell',
    'going', 'happening', 'when', 'where', 'why', 'does', 'did', 'doing', 'them']);
  const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/);
  const tokens = [
    ...words(question),
    ...(Array.isArray(entities) ? entities : []).flatMap((e) => words(e)),
  ].filter((w) => w.length >= 3 && !STOP.has(w));
  if (!tokens.length) return { ok: true, mode: 'roster', ...assembleGlobalContext(src) };

  const hits = (text) => {
    const bag = new Set(words(text));
    let n = 0;
    for (const t of tokens) if (bag.has(t)) n++;
    return n;
  };
  const facts = [];
  const citations = [];
  const cite = citeInto(citations);

  const opps = oppRowsOf(src)
    .filter((o) => byId.has(String(o.c)))
    .map((o) => ({ o, s: hits(o.t) + hits(o.desc) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 6);
  if (opps.length) {
    facts.push('Opportunities matching the question:');
    for (const { o } of opps) {
      const cust = byId.get(String(o.c));
      facts.push(`- ${o.t || '(untitled)'} at ${cust.name} — ${o.stage}`
        + (o.v != null ? `, ${money(o.v)}` : '') + (o.close ? `, closes ${o.close}` : ''));
      cite('Opportunity', o.t || o.id, o.id);
    }
  }

  const steps = (Array.isArray(src.steps) ? src.steps : [])
    .filter((s) => s && stepOpen(s) && byId.has(String(s.c)))
    .map((s) => ({ s, sc: hits(s.t) }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 5);
  if (steps.length) {
    facts.push('Open next steps matching the question:');
    for (const { s } of steps) {
      const cust = byId.get(String(s.c));
      facts.push(`- ${s.t || '(untitled)'}${cust ? ' at ' + cust.name : ''}`
        + (s.due ? ` due ${s.due}` : ''));
      cite('Next step', s.t || s.id, s.id);
    }
  }

  const moms = (Array.isArray(src.interactions) ? src.interactions : [])
    .filter((m) => m && byId.has(String(m.c)))
    .map((m) => ({ m, sc: hits(m.t) + hits(m.sum) + hits(m.out) }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 5);
  if (moms.length) {
    facts.push('Meetings matching the question:');
    for (const { m } of moms) {
      const cust = byId.get(String(m.c));
      facts.push(`- ${m.d || 'undated'} ${m.t || '(untitled)'}${cust ? ' at ' + cust.name : ''}`
        + (m.out ? ` — ${m.out}` : ''));
      cite('MOM', m.t || m.d || m.id, m.id);
    }
  }

  const custs = customers
    .map((c) => ({ c, sc: hits(c.name) + hits(c.industry)
      + (Array.isArray(c.pains) ? c.pains : []).reduce((a, p) => a + hits(p), 0) }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 4);
  if (custs.length) {
    facts.push('Customers matching the question:');
    for (const { c } of custs) {
      facts.push(`- ${c.name}${c.industry ? ' — ' + c.industry : ''}`
        + `; stance ${c.stance || 'unrecorded'}, health ${c.health || 'unrecorded'}`);
      cite('Customer', c.name || c.id, c.id);
    }
  }

  if (!facts.length) return { ok: true, mode: 'roster', ...assembleGlobalContext(src) };
  return { ok: true, mode: 'retrieval', facts, citations };
}

/* --------------------------------------- #77 the management picture (§17)
 *
 * Admin and manager ask pipeline-level questions ("Give me an overview of
 * our current business pipeline") and keyword retrieval answers them with
 * nothing — no customer is named, so no row matches. This assembler is the
 * §18 list as facts: the stage board, who carries the open work, what has
 * gone stale, what follow-up is owed, which pains two or more accounts
 * record in the same words, which products the open deals carry, and which
 * deals say why they are stuck. Every line is a count or a quote from the
 * caller's scoped view — no ranking, no score, no inference: "expansion
 * opportunities" are read OUT of these facts by the model, never invented
 * into them (§17: actionable understanding, not a dashboard of KPI cards;
 * §18: no system or security fields are touched, business records only).
 * The caller's scope IS the wall: an admin sees the whole book, a manager
 * the same (read-only), a BD only their accounts — and nothing here writes.
 */
export function buildPipelineFacts(view) {
  const src = normView(view);
  const stages = stagesOf(src);
  const customers = (Array.isArray(src.customers) ? src.customers : [])
    .filter((c) => c && c.id && !c.confidential);
  const byId = new Map(customers.map((c) => [String(c.id), c]));
  const opps = oppRowsOf(src).filter((o) => o && byId.has(String(o.c)));
  const facts = [];
  const citations = [];
  const cite = citeInto(citations);

  /* §18 "Overall pipeline": the stage board as it stands. */
  const byStage = new Map();
  for (const o of opps) {
    const st = String(o.stage || 'unrecorded');
    const row = byStage.get(st) || { n: 0, v: 0 };
    row.n += 1; row.v += Number(o.v) || 0;
    byStage.set(st, row);
  }
  if (byStage.size) {
    facts.push('Pipeline by stage:');
    for (const [st, row] of byStage) {
      facts.push(`- ${st}: ${row.n} opportunit${row.n === 1 ? 'y' : 'ies'}, value ${money(row.v)}`);
    }
  }

  /* "Customer activity": who carries the open work. */
  const active = customers
    .map((c) => ({ c, n: opps.filter((o) => String(o.c) === String(c.id)
      && stages.includes(String(o.stage ?? ''))).length }))
    .filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 5);
  if (active.length) {
    facts.push('Customers with the most open opportunities:');
    for (const { c, n } of active) {
      facts.push(`- ${c.name}: ${n} open`);
      cite('Customer', c.name, c.id);
    }
  }

  /* "Stale business": nothing in an open stage has moved for 60 days. */
  const stale = opps
    .filter((o) => stages.includes(String(o.stage ?? '')) && Number(o.age) > 60)
    .sort((a, b) => Number(b.age) - Number(a.age)).slice(0, 5);
  if (stale.length) {
    facts.push('Opportunities with no stage movement for over 60 days:');
    for (const o of stale) {
      const cust = byId.get(String(o.c));
      facts.push(`- ${o.t || '(untitled)'}${cust ? ' at ' + cust.name : ''} — ${o.stage}, ${o.age} days in stage`);
      cite('Opportunity', o.t || o.id, o.id);
    }
  }

  /* "Follow-up situation": what is owed and what is late. */
  const today = new Date().toISOString().slice(0, 10);
  const openSteps = (Array.isArray(src.steps) ? src.steps : [])
    .filter((s) => s && stepOpen(s) && byId.has(String(s.c)));
  const late = openSteps.filter((s) => s.due && String(s.due) < today);
  if (openSteps.length) {
    facts.push(`Open next steps: ${openSteps.length} across the book, ${late.length} past their due date.`);
  }

  /* "Common customer needs": a pain two or more accounts record in the same
   * words. Freely-worded pains rarely collide, so this stays honest — no
   * paraphrase aggregation, only what the records say twice. */
  const painCount = new Map();
  for (const c of customers) {
    for (const p of (Array.isArray(c.pains) ? c.pains : []).map(String).filter(Boolean)) {
      painCount.set(p, (painCount.get(p) || 0) + 1);
    }
  }
  const common = [...painCount.entries()].filter(([, n]) => n >= 2).slice(0, 5);
  if (common.length) {
    facts.push('Pain points recorded on more than one customer: '
      + common.map(([p, n]) => `${p} (${n})`).join('; '));
  }

  /* "Product demand patterns": what the open deals carry. */
  const prodCount = new Map();
  for (const o of opps) {
    if (!stages.includes(String(o.stage ?? ''))) continue;
    for (const id of (Array.isArray(o.items) ? o.items : [])) {
      const p = (Array.isArray(src.products) ? src.products : [])
        .find((x) => x && String(x.id) === String(id));
      const n = p ? String(p.n) : String(id);
      prodCount.set(n, (prodCount.get(n) || 0) + 1);
    }
  }
  const hot = [...prodCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (hot.length) {
    facts.push('Products on open opportunities: ' + hot.map(([n, c]) => `${n} (${c})`).join('; '));
  }

  /* "Unresolved blockers": the deals that say why they are stuck. */
  const blocked = opps
    .filter((o) => String(o.blockers || '').trim() && stages.includes(String(o.stage ?? '')))
    .slice(0, 5);
  if (blocked.length) {
    facts.push('Open opportunities with an unresolved blocker:');
    for (const o of blocked) {
      const cust = byId.get(String(o.c));
      facts.push(`- ${o.t || '(untitled)'}${cust ? ' at ' + cust.name : ''} — ${String(o.blockers).trim()}`);
      cite('Opportunity', o.t || o.id, o.id);
    }
  }

  return { ok: true, facts, citations };
}

/* ---------------------------------- #68 the focus-week list (§5, Test 1)
 *
 * "What should I focus on this week?" is answered from the book before it
 * is answered by a model. The ITEMS are computed, not guessed: overdue next
 * steps first, then open opportunities whose account has gone quiet with
 * nothing scheduled — the §5 example, "No activity for 18 days and no
 * upcoming Next Step" — then steps waiting on the customer. The model's only
 * job (in the executor) is the one-line suggested action on each item, so
 * every id, every fact and the order come from the records and a model may
 * propose a follow-up but cannot invent a customer (§27). Confidential
 * customers are absent for the same reason they are absent from every other
 * assembly: the wall is the data, not the role. Nothing here calls a model
 * and nothing here writes anything — a suggestion becomes a next step only
 * through the confirm-then-create flow a human click starts (§25).
 */
export function buildFocusWeekItems(view) {
  const src = normView(view);
  const customers = (Array.isArray(src.customers) ? src.customers : [])
    .filter((c) => c && c.id && !c.confidential);
  const byId = new Map(customers.map((c) => [String(c.id), c]));
  const stages = new Set(stagesOf(src).map(String));
  const now = Date.now();
  const daysSince = (iso) => {
    const t = Date.parse(String(iso || ''));
    return Number.isFinite(t) ? Math.floor((now - t) / 864e5) : null;
  };
  /* The customer's last interaction age — the "no activity for N days" of
     the §5 example is this number, or 'no interaction recorded'. */
  const quietOf = new Map();
  for (const c of customers) {
    let best = null;
    for (const m of (Array.isArray(src.interactions) ? src.interactions : [])) {
      if (!m || String(m.c) !== String(c.id)) continue;
      const t = Date.parse(String(m.d || ''));
      if (Number.isFinite(t) && (best === null || t > best)) best = t;
    }
    quietOf.set(String(c.id), best === null ? null : Math.floor((now - best) / 864e5));
  }

  const items = [];
  const citations = [];
  const cite = citeInto(citations);
  const push = (kind, c, note, opp) => {
    items.push({
      kind, customer: c.name, customerId: c.id,
      oppTitle: opp ? String(opp.t || '') : '', oppId: opp ? opp.id : '',
      note,
    });
    if (opp) cite('Opportunity', opp.t || opp.id, opp.id);
  };

  /* 1. Overdue next steps — the work that is already late goes first. */
  const overdue = (Array.isArray(src.steps) ? src.steps : [])
    .filter((s) => s && stepOpen(s) && byId.has(String(s.c)) && s.due)
    .map((s) => ({ s, late: daysSince(s.due) }))
    .filter((x) => x.late !== null && x.late > 0)
    .sort((a, b) => b.late - a.late)
    .slice(0, 4);
  for (const { s, late } of overdue) {
    const c = byId.get(String(s.c));
    push('overdue', c,
      `Next step overdue: "${s.t || '(untitled)'}" — ${late} day${late === 1 ? '' : 's'} past the date set.`);
    cite('Next step', s.t || s.id, s.id);
  }

  /* 2. Open opportunities on quiet accounts. Only a deal that is still
     live (its stage is one of the open stages) whose customer has heard
     nothing from us for two weeks AND has no next step scheduled counts —
     a quiet account with work booked is simply waiting its turn. */
  const quiet = oppRowsOf(src)
    .filter((o) => byId.has(String(o.c)) && stages.has(String(o.stage)))
    .map((o) => ({ o, q: quietOf.get(String(o.c)) }))
    .filter((x) => (x.q === null || x.q >= 14)
      && !(Array.isArray(src.steps) ? src.steps : [])
        .some((s) => s && stepOpen(s) && String(s.c) === String(x.o.c)))
    .sort((a, b) => (b.q === null ? 999 : b.q) - (a.q === null ? 999 : a.q))
    .slice(0, 4);
  for (const { o, q } of quiet) {
    const c = byId.get(String(o.c));
    push('quiet', c,
      `${o.t || '(untitled)'} — open at ${o.stage}`
      + (o.v != null ? `, value ${money(o.v)}` : '')
      + (q === null ? '; no interaction recorded' : `; no activity for ${q} days`)
      + ', and no upcoming next step.', o);
  }

  /* 3. Waiting on the customer — an ask we sent that nobody answered yet.
     Undated only: a dated wait is already in the overdue list above. */
  const waiting = (Array.isArray(src.steps) ? src.steps : [])
    .filter((s) => s && stepOpen(s) && byId.has(String(s.c))
      && s.from === 'customer' && !s.due)
    .slice(0, 3);
  for (const s of waiting) {
    const c = byId.get(String(s.c));
    push('waiting', c,
      `Waiting on the customer: "${s.t || '(untitled)'}" — no date set, so nothing is chasing it.`);
    cite('Next step', s.t || s.id, s.id);
  }

  /* §19.4's spirit: a list is only a focus if it is short. */
  items.splice(8);
  return { ok: true, items, citations };
}
