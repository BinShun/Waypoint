#!/usr/bin/env node
/**
 * AI layer — the honest version.
 *
 * Why this file exists
 * --------------------
 * The bundle used to show violet "AI" badges and paragraphs of prose that
 * looked as though a model had written them. Nothing had. That is not a
 * cosmetic bug: a badge that claims a model answered, when no model was ever
 * asked, is a lie in a system of record.
 *
 * So the rule is now enforced here, in one place:
 *
 *   - Either the server has a model endpoint AND that endpoint answers,
 *   - or every screen says plainly that no model is connected.
 *
 * There is no third state where it looks like it worked.
 *
 * Where the key lives
 * -------------------
 * `data/ai.json`, on the server, next to the workspace — never in
 * `workbench.json`, so it is never part of `GET /api/data` and never reaches a
 * browser. `/api/ai/status` reports whether a key is set; it never reports the
 * key itself. Environment variables (`AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`)
 * win over the file, so a deployment can be configured without ever writing a
 * secret to disk.
 *
 * Zero dependencies, like the rest of the server.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const DATA_DIR = process.env.WB_DATA_DIR ? path.resolve(process.env.WB_DATA_DIR) : path.join(ROOT, 'data');
const AI_FILE = path.join(DATA_DIR, 'ai.json');

const PROBE_TIMEOUT_MS = 7000;
/* A reasoning model spends its budget before it answers: asked to name a
   company, the configured endpoint spent 2,179 tokens thinking and returned
   the answer at 2,208 — so a 900-token cap does not get a short answer, it
   gets an EMPTY one. The answer is then read as "the model returned no text",
   which looks like a broken feature rather than a budget problem. Both numbers
   below are set for that behaviour: enough room to think, and long enough to
   finish. Measured on the configured endpoint: a reasoning model spent 2,179
   tokens thinking before it answered one company name, and a call from the
   hosted sandbox ran past 100s. Both numbers are therefore generous by
   default, and both are administrator settings (Admin → Model → budget), with
   environment overrides, because the right value depends on the model that is
   plugged in and nobody should have to redeploy to change it.

   A timeout here is indistinguishable from "no such company" — which is the
   exact failure this fallback exists to remove. */

const DEFAULT_MAX_TOKENS = 12000;
const DEFAULT_TIMEOUT_MS = 240_000;
const MIN_MAX_TOKENS = 256;
const MAX_MAX_TOKENS = 32000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 600_000;

/* ------------------------------------------------------------------ config */

const EMPTY = { base: '', model: '', key: '', savedAt: '', by: '' };

/* The budget is read apart from the endpoint, because a deployment that takes
   its endpoint from the environment must still be able to tune how much the
   model is allowed to think. Environment wins, then the saved file, then a
   default that assumes a reasoning model. */
const clamp = (n, lo, hi, dflt) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(v)));
};

async function readBudget() {
  const envTok = process.env.AI_MAX_TOKENS;
  const envTime = process.env.AI_TIMEOUT_MS;
  let fileTok, fileTime;
  try {
    const raw = JSON.parse(await fs.readFile(AI_FILE, 'utf8'));
    fileTok = raw.maxTokens;
    fileTime = raw.timeoutMs;
  } catch { /* no saved budget — the defaults apply */ }
  return {
    maxTokens: clamp(envTok ?? fileTok, MIN_MAX_TOKENS, MAX_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    timeoutMs: clamp(envTime ?? fileTime, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    budgetSource: envTok || envTime ? 'environment' : (fileTok || fileTime ? 'saved' : 'default'),
  };
}

export async function readAiConfig() {
  const budget = await readBudget();
  const env = {
    base: process.env.AI_BASE_URL || '',
    model: process.env.AI_MODEL || '',
    fastModel: process.env.AI_FAST_MODEL || '',
    key: process.env.AI_API_KEY || '',
    savedAt: '',
    by: 'environment',
  };
  if (env.base && env.key && env.model) return { ...env, ...budget };
  try {
    const raw = JSON.parse(await fs.readFile(AI_FILE, 'utf8'));
    return {
      base: String(raw.base || ''),
      model: String(raw.model || ''),
      key: String(raw.key || ''),
      savedAt: String(raw.savedAt || ''),
      by: String(raw.by || ''),
      ...budget,
    };
  } catch {
    return { ...EMPTY, ...budget };
  }
}

export async function writeAiConfig(next, by) {
  const cfg = {
    base: String(next.base || '').trim(),
    model: String(next.model || '').trim(),
    key: String(next.key || '').trim(),
    savedAt: new Date().toISOString(),
    by: String(by || ''),
  };
  const bad = validate(cfg);
  if (bad) return { ok: false, error: bad, code: 'invalid' };
  /* Refuse a private address at save time, not at call time. Letting one in
     and then failing every request is the kind of thing nobody notices for
     weeks — and a "model endpoint" that points back at this host is a hole. */
  try {
    await assertPublicUrl(cfg.base);
  } catch (e) {
    return { ok: false, error: String(e.message || e), code: 'invalid' };
  }
  /* Keep whatever budget was already set: saving an endpoint is not a reason
     to silently reset how much the model is allowed to think. */
  let existing = {};
  try { existing = JSON.parse(await fs.readFile(AI_FILE, 'utf8')); } catch { /* nothing yet */ }
  const keep = {
    ...(existing.maxTokens != null ? { maxTokens: existing.maxTokens } : {}),
    ...(existing.timeoutMs != null ? { timeoutMs: existing.timeoutMs } : {}),
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${AI_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ ...cfg, ...keep }, null, 2), 'utf8');
  await fs.rename(tmp, AI_FILE);
  try { await fs.chmod(AI_FILE, 0o600); } catch { /* Windows, or a volume that refuses */ }
  return { ok: true };
}

/**
 * Change only the budget. It is a separate call from `writeAiConfig` on
 * purpose: a deployment whose endpoint and key come from the environment
 * refuses endpoint changes with 409, and it must still be able to decide how
 * much a model is allowed to think.
 */
export async function writeAiBudget(next, by) {
  const budget = {
    maxTokens: clamp(next?.maxTokens, MIN_MAX_TOKENS, MAX_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    timeoutMs: clamp(next?.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
  let existing = {};
  try { existing = JSON.parse(await fs.readFile(AI_FILE, 'utf8')); } catch { /* nothing saved yet */ }
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${AI_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({
    ...existing,
    ...budget,
    budgetSavedAt: new Date().toISOString(),
    budgetBy: String(by || ''),
  }, null, 2), 'utf8');
  await fs.rename(tmp, AI_FILE);
  try { await fs.chmod(AI_FILE, 0o600); } catch { /* Windows, or a volume that refuses */ }
  return { ok: true, ...budget };
}

/** Disconnect: drop the endpoint so the screens fall back to rules-only. */
export async function clearAiConfig() {
  try { await fs.unlink(AI_FILE); } catch { /* already gone is the goal state */ }
  return { ok: true };
}

function validate(cfg) {
  if (!cfg.base) return 'A base URL is required.';
  let u;
  try { u = new URL(cfg.base); } catch { return 'That base URL is not a URL.'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The base URL must be http or https.';
  if (!cfg.key) return 'An API key is required.';
  if (!cfg.model) return 'A model name is required.';
  return '';
}

/** What the browser is allowed to know. Note: never the key. */
function publicConfig(cfg) {
  /* The screen needs to tell one key from another — "is this the key I
     rotated?" — and nothing more than that. It used to show the first three
     and last three characters verbatim, which for the short keys this project
     actually uses is a meaningful slice of the secret: `sk-QK70eU…lfjJ` hands
     out six characters and confirms the prefix and suffix of an 18-character
     credential. A fingerprint answers the same question, survives being
     compared across screens, and reveals none of it. */
  const keyId = cfg.key
    ? createHash('sha256').update(String(cfg.key)).digest('hex').slice(0, 8)
    : '';
  return {
    base: cfg.base,
    model: cfg.model,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
    budgetSource: cfg.budgetSource || 'default',
    hasKey: !!cfg.key,
    keyId,                                   /* a fingerprint, not a fragment */
    keyHint: keyId ? 'key ' + keyId : '',    /* kept for the screens that read it */
    savedAt: cfg.savedAt,
    source: cfg.by === 'environment' ? 'environment' : (cfg.savedAt ? 'saved' : 'none'),
  };
}

/* ------------------------------------------------------------------ network */

/* The server is allowed to call out. It is not allowed to be pointed at
   itself, at the metadata service, or at a colleague's laptop. */
function isPublicAddress(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return false;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
    if (p[0] === 192 && p[1] === 168) return false;
    if (p[0] === 169 && p[1] === 254) return false;      /* link-local + 169.254.169.254 */
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false; /* CGNAT */
    if (p[0] >= 224) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return false;
    if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return false;
    if (v.startsWith('::ffff:')) return isPublicAddress(v.slice(7));
    return true;
  }
  return false;
}

/**
 * Test seam, and the only one in the server.
 *
 * `verify:ai` has to prove the whole path — a screen asks, the server calls
 * out, an answer comes back and lands in the record — and it cannot do that
 * against a real vendor without a key nobody should paste into a repo. So it
 * runs a stand-in endpoint on this machine and starts the server with
 * `WB_TEST_AI=1`, which lets ONE thing through that is otherwise refused:
 * loopback. Every other private range, and the cloud metadata address, stay
 * blocked, so the seam cannot be used to reach a neighbour on the network.
 *
 * Nothing in the app sets it, and no deployment configuration sets it.
 */
const loopbackAllowed = () => process.env.WB_TEST_AI === '1';
const isLoopbackHost = (h) => h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';

async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('That is not a URL.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http and https are allowed.');
  if (u.port && u.port !== '80' && u.port !== '443') {
    if (!(loopbackAllowed() && isLoopbackHost(u.hostname.replace(/^\[|\]$/g, '')))) {
      throw new Error('Only ports 80 and 443 are allowed.');
    }
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  /* The seam is a hole exactly one address wide. It must stay that narrow. */
  if (loopbackAllowed() && isLoopbackHost(host)) return u;
  if (/^localhost$/i.test(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('That host is not a public address.');
  }
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new Error('That address is private.');
    return u;
  }
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length) throw new Error('That host does not resolve.');
  for (const a of addrs) if (!isPublicAddress(a.address)) throw new Error('That host points at a private address.');
  return u;
}

/* ------------------------------------------------------------------- status */

/**
 * Actually ask. "Configured" is not the same as "working", and the screen
 * distinguishes them — an endpoint that is set but unreachable is a different
 * problem from one that was never set.
 */
export async function aiStatus({ probe = true } = {}) {
  const cfg = await readAiConfig();
  const pub = publicConfig(cfg);
  if (!cfg.base || !cfg.key || !cfg.model) {
    return {
      ok: true,
      configured: false,
      reachable: false,
      ...pub,
      reason: 'No model endpoint is configured on this server. Everything shown is produced by rules, and screens say so.',
    };
  }
  if (!probe) return { ok: true, configured: true, reachable: null, probed: false, ...pub, reason: '' };

  const started = Date.now();
  try {
    const url = await assertPublicUrl(cfg.base.replace(/\/+$/, ''));
    const res = await fetch(`${url.origin}${url.pathname.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.key}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) {
      let models = null;
      try {
        const j = await res.json();
        models = Array.isArray(j?.data) ? j.data.map((m) => m.id).filter(Boolean).slice(0, 40) : null;
      } catch { /* a 200 that is not JSON still proves it answered */ }
      return {
        ok: true, configured: true, reachable: true,
        ...pub, models, ms: Date.now() - started, probed: true, reason: '',
      };
    }
    return {
      ok: true, configured: true, reachable: false,
      ...pub, ms: Date.now() - started, probed: true,
      reason: `The endpoint answered ${res.status}. Check the base URL and the key.`,
    };
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return {
      ok: true, configured: true, reachable: false,
      ...pub, ms: Date.now() - started, probed: true,
      reason: timeout ? 'The endpoint did not answer in time.' : String(e?.message || e),
    };
  }
}

/* --------------------------------------------------------------------- chat */

/**
 * One real call to the model. Used by the screens that genuinely need one.
 * Throws with a readable message rather than returning a plausible-looking
 * paragraph, because a fabricated paragraph is the failure mode we removed.
 */
export async function aiComplete(prompt, { system, temperature = 0.2, maxTokens, model, fast } = {}) {
  const cfg = await readAiConfig();
  if (!cfg.base || !cfg.key || !cfg.model) {
    const e = new Error('No model endpoint is configured.');
    e.code = 'not-configured';
    throw e;
  }
  const url = await assertPublicUrl(cfg.base.replace(/\/+$/, ''));
  /* A reasoning model spends the budget thinking before it writes. When the
     answer comes back empty the thinking ate everything, so the honest
     response is to ask again with room to answer — once, doubled, capped.
     This is the difference between "the feature sometimes fails" and "the
     feature always answers or says why it could not". */
  let budget = clamp(maxTokens ?? cfg.maxTokens, MIN_MAX_TOKENS, MAX_MAX_TOKENS, DEFAULT_MAX_TOKENS);
  for (let attempt = 0; ; attempt++) {
    try {
      return await askOnce(url, cfg, prompt, system, temperature, budget,
        fast && cfg.fastModel ? cfg.fastModel : model);
    } catch (e) {
      const retryable = e.code === 'empty' && budget * 2 <= MAX_MAX_TOKENS;
      if (!retryable || attempt >= 1) throw e;
      budget = Math.min(budget * 2, MAX_MAX_TOKENS);
    }
  }
}

async function askOnce(url, cfg, prompt, system, temperature, budget, model) {
  const body = {
    model: model || cfg.model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt },
    ],
    temperature,
    max_tokens: budget,
  };
  let res;
  try {
    res = await fetch(`${url.origin}${url.pathname.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(clamp(cfg.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)),
    });
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    const err = new Error(timeout ? 'The model did not answer in time.' : String(e?.message || e));
    err.code = 'unreachable';
    throw err;
  }
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`The model endpoint returned ${res.status}.`);
    err.code = 'endpoint-error';
    err.detail = text.slice(0, 400);
    throw err;
  }
  let j;
  try { j = JSON.parse(text); } catch {
    const err = new Error('The model returned something that was not JSON.');
    err.code = 'bad-response';
    throw err;
  }
  const out = j?.choices?.[0]?.message?.content;
  if (typeof out !== 'string' || !out.trim()) {
    const err = new Error('The model returned no text.');
    err.code = 'empty';
    throw err;
  }
  return { text: out.trim(), model: cfg.model, usage: j?.usage || null };
}

export const __testing = { isPublicAddress, validate, AI_FILE };
