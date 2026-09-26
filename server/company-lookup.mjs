/**
 * Company lookup — read what a company publishes about itself.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The "Look up" button used to set a flag and render a pre-written block of
 * text about a company that does not exist. It looked exactly like a working
 * feature and taught the reader to trust a number nobody had ever fetched.
 * That is the worst kind of bug in a system of record: not a crash, a lie.
 *
 * This is the real thing. Given a name or a website it:
 *   1. searches Wikidata — a free, keyless, public database — for a real
 *      organisation, and takes the official website it publishes (P856),
 *      its HQ (P159), its industry (P452) and its headcount (P1128);
 *   2. fetches that website and reads its own <title>, description, social
 *      links and logo.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It will not guess. Every field it could not find comes back as null, and the
 * UI says "not published" rather than filling the gap with something plausible.
 * A missing headcount is a fact about the company; an invented one is a defect
 * in us.
 *
 * It also will not be used as a proxy into the network it runs on: every
 * hostname is resolved and rejected if it points anywhere private before a
 * single byte is requested, and redirects are re-checked hop by hop.
 */
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { aiComplete } from './ai.mjs';

const UA = 'Waypoint/1.0 (company lookup; +https://waypoint.app-tencent.workbuddy.host)';
/* How long ONE attempt at ONE address may take. `run()` can make several
   attempts, so this is a per-attempt ceiling, not the ceiling on the lookup —
   that is TOTAL_BUDGET_MS below, and both are needed.
   Nine seconds was too generous for what an attempt can still do usefully: a
   host that has not sent anything in five seconds is a host that is not going
   to answer usefully, and its only effect on the person waiting is to make the
   product feel broken. Real sites answer in well under a second. */
const TIMEOUT_MS = 5000;
const MAX_BYTES = 1_200_000;
const MAX_HOPS = 4;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/* THE CEILING ON THE WHOLE LOOKUP.
 *
 * Every individual fetch here is bounded (`TIMEOUT_MS`), and for a long time
 * that looked like enough. It is not: `run()` tries up to three spellings of
 * the domain in sequence, and when none of them answers it may ask the model
 * twice more. Three 9 s attempts plus two model turns is a worst case of well
 * over a minute — and that is not a rare path, it is what happens whenever a
 * company's site is unreachable from this host.
 *
 * Measured on "Maybank", whose public record lists maybank2u.com.my (refuses
 * the connection) and maybank.com (accepts it, then never sends a byte):
 * search 0.6 s, then 67 s to an answer. The answer was CORRECT — it fell back
 * to the public record and said the site could not be read — so the defect was
 * never the result, it was the wait. A person who clicks "Look up" and watches
 * a spinner for a minute concludes the product is broken, and a test harness
 * with a 9 s budget concludes the same thing. Both are right to.
 *
 * So the work now runs against one deadline for the entire lookup. Nothing is
 * cancelled abruptly mid-write — each stage checks the clock before it starts,
 * and once the deadline passes the remaining stages are skipped and the
 * partial result is returned with a warning that names what was not reached.
 * Honest and bounded, which is the rule the rest of this file already runs on.
 *
 * The budget is generous on purpose: a healthy lookup answers in under two
 * seconds, so this ceiling is only ever reached by something already wrong. */
const TOTAL_BUDGET_MS = 20_000;

/** Milliseconds left before `deadline`, never below zero. */
const left = (deadline) => Math.max(0, deadline - Date.now());

const cache = new Map();

/* Hosts that are never someone's own website — they only ever appear in
   search results about a company. */
const NOT_A_COMPANY_SITE = [
  'wikipedia.org', 'wikidata.org', 'wikimedia.org', 'linkedin.com', 'facebook.com',
  'twitter.com', 'x.com', 'instagram.com', 'youtube.com', 'crunchbase.com',
  'glassdoor.com', 'indeed.com', 'bloomberg.com', 'reuters.com', 'medium.com',
  'github.com', 'play.google.com', 'apps.apple.com', 'amazon.com', 'zoominfo.com',
  'owler.com', 'pitchbook.com', 'sec.gov', 'bbb.org', 'trustpilot.com'
];

/* Only the places a BD or SA actually works from. YouTube and Instagram were
   here once and were removed: nobody opens a telco's channel to prepare a
   meeting, and every chip we show is a chip somebody has to read past.
   The hosts stay in NOT_A_COMPANY_SITE — a link to them is still not a
   company's own website, it just is not a chip either. */
const SOCIAL_HOSTS = [
  { host: 'linkedin.com', label: 'LinkedIn' },
  { host: 'x.com', label: 'X' },
  { host: 'twitter.com', label: 'X' },
  { host: 'facebook.com', label: 'Facebook' }
];

const fail = (code, error, hint) => ({ ok: false, code, error, hint: hint || null });

/* ------------------------------------------------------------------ network */

function isPublicAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return false;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
    if (p[0] === 192 && p[1] === 168) return false;
    if (p[0] === 169 && p[1] === 254) return false;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;
    if (p[0] >= 224) return false;
    return true;
  }
  if (v === 6) {
    const s = ip.toLowerCase().split('%')[0];
    if (s === '::' || s === '::1') return false;
    if (s.startsWith('fc') || s.startsWith('fd')) return false;
    if (s.startsWith('fe80')) return false;
    if (s.startsWith('::ffff:')) return isPublicAddress(s.slice(7));
    return true;
  }
  return false;
}

/**
 * Refuse anything that is not a public web host. This is not paranoia: the
 * server sits inside a network, and "fetch this URL for me" is the classic way
 * to make a server fetch its own metadata service or a neighbour's printer.
 */
async function assertPublicHost(hostname) {
  if (!hostname) throw Object.assign(new Error('No host'), { code: 'blocked' });
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') ||
      h.endsWith('.internal') || h.endsWith('.home.arpa')) {
    throw Object.assign(new Error('Private addresses are not fetched.'), { code: 'blocked' });
  }
  /* A bare IP is allowed only if it is public. */
  if (net.isIP(h)) {
    if (!isPublicAddress(h)) throw Object.assign(new Error('Private addresses are not fetched.'), { code: 'blocked' });
    return;
  }
  let addrs;
  try {
    addrs = await dns.promises.lookup(h, { all: true });
  } catch {
    throw Object.assign(new Error(`Could not resolve ${hostname}.`), { code: 'unreachable' });
  }
  if (!addrs.length) throw Object.assign(new Error(`Could not resolve ${hostname}.`), { code: 'unreachable' });
  for (const a of addrs) {
    if (!isPublicAddress(a.address)) {
      throw Object.assign(new Error('That name points at a private address.'), { code: 'blocked' });
    }
  }
}

async function readCapped(res, max) {
  if (!res.body || !res.body.getReader) return await res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        chunks.push(value.subarray(0, Math.max(0, max - (total - value.length))));
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchHtml(startUrl) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let u;
    try { u = new URL(url); } catch { throw Object.assign(new Error('Not a usable web address.'), { code: 'invalid' }); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw Object.assign(new Error('Only web pages are read.'), { code: 'blocked' });
    }
    if (u.port && u.port !== '80' && u.port !== '443') {
      throw Object.assign(new Error('Only web pages are read.'), { code: 'blocked' });
    }
    await assertPublicHost(u.hostname);

    const r = await fetchOnce(u.href);

    if (r.status >= 300 && r.status < 400 && r.location) {
      url = new URL(r.location, u).href;
      continue;
    }
    if (r.status < 200 || r.status >= 300) {
      throw Object.assign(new Error(`That site answered ${r.status}.`), { code: 'unreachable' });
    }
    /* Feeds are text too. A news search answers application/xml, and refusing
       it would silently lose the one source that actually carries market news. */
    const type = (r.contentType || '').toLowerCase();
    if (type && !/text\/html|application\/xhtml|application\/json|text\/plain|text\/xml|application\/xml|application\/rss\+xml|application\/atom\+xml/.test(type)) {
      throw Object.assign(new Error('That address is not a web page.'), { code: 'not-a-page' });
    }
    return { html: r.body, url: u.href };
  }
  throw Object.assign(new Error('Too many redirects.'), { code: 'unreachable' });
}

/* One hop. fetch first; when fetch gives up, the raw socket below gets a turn.
   The two answers are the same shape: { status, location, contentType, body }. */
async function fetchOnce(url) {
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-encoding': 'identity'
      }
    });
    return {
      status: res.status,
      location: res.headers.get('location') || '',
      contentType: res.headers.get('content-type') || '',
      body: await readCapped(res, MAX_BYTES)
    };
  } catch (e) {
    /* Node's HTTP parser is strict about header tokens, and some real
       servers — Malaysian government sites among them, rtm.gov.my included —
       send malformed ones. A browser reads those pages fine, so refusing them
       here would be a bug wearing a security hat. The raw reader applies the
       same safety rules (the host was already asserted public) with a lenient
       parser.

       A TIMEOUT IS NOT A PARSER COMPLAINT, AND THE RAW READER IS NOT A RETRY.
       This used to hand every failure to `rawOnce`, including a timeout. The
       two readers speak to the same host over the same kind of socket, so a
       host that would not answer the first one will not answer the second
       either — it simply spends the timeout twice. Measured on
       www.maybank.com, which resolves to a WAF endpoint that accepts the TCP
       connection and then never completes the handshake: 5 s wasted on the
       fetch, 5 s wasted again on the raw reader, per spelling of the domain.
       A timeout now ends the attempt, and only a genuine protocol complaint
       gets the lenient parser. */
    if (e && (e.name === 'TimeoutError' || e.code === 'timeout' || e.code === 'ETIMEDOUT')) throw e;
    return await rawOnce(url, e);
  }
}

function dechunk(buf) {
  const out = [];
  let pos = 0;
  for (;;) {
    const nl = buf.indexOf('\r\n', pos);
    if (nl < 0) break;
    const size = parseInt(buf.subarray(pos, nl).toString('latin1').split(';')[0], 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = nl + 2;
    if (start + size > buf.length) { out.push(buf.subarray(start)); break; }
    out.push(buf.subarray(start, start + size));
    pos = start + size + 2;
  }
  return Buffer.concat(out);
}

function decompress(body, encoding) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(body);
    if (enc.includes('gzip')) return zlib.gunzipSync(body);
    if (enc.includes('deflate')) return zlib.inflateSync(body);
  } catch { /* a lie in content-encoding is the site's doing, not ours */ }
  return body;
}

function rawOnce(url, cause) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch {
      reject(Object.assign(new Error('Not a usable web address.'), { code: 'invalid' }));
      return;
    }
    const secure = u.protocol === 'https:';
    const port = u.port ? Number(u.port) : (secure ? 443 : 80);
    const chunks = [];
    let total = 0;
    let settled = false;
    let sock;

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      try { sock.destroy(); } catch { /* already gone */ }
      if (err) reject(err); else resolve(val);
    };

    const parse = () => {
      const buf = Buffer.concat(chunks);
      const sep = buf.indexOf('\r\n\r\n');
      if (sep < 0) return false;
      const head = buf.subarray(0, sep).toString('latin1');
      const lines = head.split('\r\n');
      const status = parseInt((lines[0].match(/HTTP\/\S+\s+(\d+)/) || [])[1] || '0', 10);
      if (!status) return false;
      const headers = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      let body = buf.subarray(sep + 4);
      if ((headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) body = dechunk(body);
      const cl = Number(headers['content-length']);
      if (Number.isFinite(cl) && cl > 0 && body.length >= cl) body = body.subarray(0, cl);
      body = decompress(body, headers['content-encoding']);
      finish(null, {
        status,
        location: headers['location'] || '',
        contentType: headers['content-type'] || '',
        body: body.subarray(0, MAX_BYTES).toString('utf8')
      });
      return true;
    };

    const guard = setTimeout(() => {
      if (!parse()) {
        finish(Object.assign(new Error('The site took too long to answer.'), { code: 'timeout' }));
      }
    }, TIMEOUT_MS + 3000);

    try {
      sock = secure ? tls.connect({ host: u.hostname, port, servername: u.hostname })
                    : net.connect({ host: u.hostname, port });
    } catch {
      finish(cause || Object.assign(new Error('Could not reach that site.'), { code: 'unreachable' }));
      return;
    }
    sock.on('error', () => {
      finish(cause || Object.assign(new Error('Could not reach that site.'), { code: 'unreachable' }));
    });
    const send = () => {
      try {
        sock.write('GET ' + (u.pathname || '/') + (u.search || '') + ' HTTP/1.1\r\n'
          + 'Host: ' + u.hostname + '\r\n'
          + 'User-Agent: ' + UA + '\r\n'
          + 'Accept: text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8\r\n'
          + 'Accept-Encoding: identity\r\n'
          + 'Connection: close\r\n\r\n');
      } catch { /* the error handler reports it */ }
    };
    if (secure) sock.once('secureConnect', send); else sock.once('connect', send);
    sock.on('data', (d) => {
      total += d.length;
      if (total <= MAX_BYTES * 2) {
        chunks.push(d);
        if (parse()) return;
      } else {
        try { sock.end(); } catch { /* closing anyway */ }
      }
    });
    sock.once('close', () => {
      if (!parse()) {
        finish(cause || Object.assign(new Error('That site answered nothing usable.'), { code: 'unreachable' }));
      }
    });
  });
}

/* ------------------------------------------------------------------- parsing */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#x27': "'", '#39': "'" };
function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z#0-9]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function metaContent(html, attr, name) {
  const re = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]*>`, 'i');
  const tag = html.match(re);
  if (!tag) return '';
  const c = tag[0].match(/content=["']([^"']*)["']/i);
  return c ? decodeEntities(c[1]) : '';
}

function parseSite(html, baseUrl) {
  const titleRaw = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const title = decodeEntities(titleRaw).replace(/\s*[|\-–—]\s*$/, '');

  const intro = metaContent(html, 'property', 'og:description')
    || metaContent(html, 'name', 'description')
    || metaContent(html, 'name', 'twitter:description')
    || '';

  const siteName = metaContent(html, 'property', 'og:site_name') || '';
  const ogImage = (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || [])[1]
    || (html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) || [])[1]
    || '';

  let logo = '';
  const iconTag = html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/i);
  if (iconTag) {
    const href = iconTag[0].match(/href=["']([^"']+)["']/i);
    if (href) logo = href[1];
  }

  const abs = (u) => {
    if (!u) return '';
    try { return new URL(u, baseUrl).href; } catch { return ''; }
  };

  /* Social links the company itself publishes. Found, never guessed: a wrong
     profile is worse than no profile, because it looks checked. */
  const found = new Map();
  for (const m of html.matchAll(/https?:\/\/(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})\/([^"'<> )]*)/gi)) {
    const host = m[1].toLowerCase();
    const hit = SOCIAL_HOSTS.find(s => host === s.host || host.endsWith('.' + s.host));
    if (!hit) continue;
    const url = m[0].replace(/[.,;]+$/, '');
    if (!found.has(hit.label)) found.set(hit.label, { label: hit.label, url });
  }

  return {
    title,
    siteName,
    intro,
    ogImage: abs(ogImage),
    logo: abs(logo),
    socials: [...found.values()]
  };
}

/* ------------------------------------------------------------------ Wikidata */

async function wikidata(url) {
  const { html } = await fetchHtml(url);
  try { return JSON.parse(html); } catch { return null; }
}

function claimValue(entity, prop) {
  const list = entity?.claims?.[prop];
  if (!list || !list.length) return null;
  const v = list[0]?.mainsnak?.datavalue?.value;
  return v ?? null;
}

async function searchWikidata(name) {
  const url = 'https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&limit=6&search='
    + encodeURIComponent(name);
  const j = await wikidata(url);
  const hits = (j && j.search) || [];
  return hits.map(h => ({ id: h.id, label: h.label || '', description: h.description || '' }))
    .filter(h => h.id && h.label);
}

async function entityDetails(ids) {
  if (!ids.length) return {};
  const url = 'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&languages=en&props=claims%7Clabels%7Cdescriptions&ids='
    + encodeURIComponent(ids.join('|'));
  const j = await wikidata(url);
  return (j && j.entities) || {};
}

async function labelsFor(ids) {
  if (!ids.length) return {};
  const url = 'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&languages=en&props=labels&ids='
    + encodeURIComponent(ids.join('|'));
  const j = await wikidata(url);
  const out = {};
  for (const [id, e] of Object.entries((j && j.entities) || {})) out[id] = e?.labels?.en?.value || null;
  return out;
}

/* ------------------------------------------------------------------- helpers */

function looksLikeDomain(q) {
  if (/\s/.test(q)) return false;
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/.*)?$/i.test(q.replace(/^https?:\/\//i, ''));
}

function toDomain(q) {
  let s = q.trim().toLowerCase();
  s = s.replace(/^https?:\/\//i, '').replace(/^www\./, '');
  s = s.split(/[/?#]/)[0];
  return s;
}

const source = (label, url) => ({ label, url });

/* A Wikidata class label is written for editors, not for a sales screen —
   "public broadcaster" is what RTM is, but the field the board groups by wants
   the shorter word. The map is a tidy-up of classes we actually see; anything
   unmapped keeps the record's own label, which is still a published fact. */
const INDUSTRY_MAP = [
  [/broadcaster|broadcast|television|radio station|media|news agency|publisher/i, 'Media'],
  [/telecom|telephone|mobile network/i, 'Telecom'],
  [/bank/i, 'Banking'],
  [/insurance/i, 'Insurance'],
  [/payment|fintech|e-?wallet|financial technology/i, 'Fintech'],
  [/airline|aviation|airport/i, 'Aviation'],
  [/electric|power|energy|gas|water utility|utility/i, 'Utilities'],
  [/oil|petroleum|petrochemical/i, 'Oil & gas'],
  [/universit|college|school|education/i, 'Education'],
  [/hospital|healthcare|medical/i, 'Healthcare'],
  [/ministry|government|state agency|federal agency|statutory/i, 'Government'],
  [/retail|department store|supermarket|shopping/i, 'Retail'],
  [/manufactur/i, 'Manufacturing'],
  [/software|information technology|IT company|technology company/i, 'Technology'],
  [/construction|engineering firm|infrastructure/i, 'Construction'],
  [/transport|logistics|railway|shipping line|port operator/i, 'Transport'],
  [/hotel|resort/i, 'Hospitality'],
  [/asset management|investment|holding company/i, 'Investment']
];

/* ------------------------------------------------------------------ AI lead */

/* The public record is large but not complete — "TNG Digital" is real and
   absent from it. When the record has no answer, the model is asked which
   company was meant. What comes back is a LEAD, not a fact: nothing it says
   is shown unless the site it names really answers, and every field still
   comes from that site, never from the model. A model answer taken on trust
   is the exact lie this file was written to remove. */
const AI_SYSTEM = 'You resolve company names to official websites. Reply with JSON only - no markdown, no explanation.';

async function aiSuggestDomain(query, extra) {
  const prompt =
    'A person typed a company name in a business tool: "' + query + '"' +
    (extra ? ' (context: ' + extra + ')' : '') + '.\n' +
    'Name the single organisation they most likely meant and its official website domain.\n' +
    'Answer with JSON only: {"found": true, "name": "...", "domain": "example.com"}\n' +
    'If you are not confident a real organisation matches, answer {"found": false}.';
  /* No budget of its own: the administrator sets it (Admin → Model → Answer
     budget), because what a model needs to think depends on the model. */
  const { text } = await aiComplete(prompt, { system: AI_SYSTEM, temperature: 0 });
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  if (!j || j.found !== true) return null;
  const dom = toDomain(String(j.domain || ''));
  if (!dom || !looksLikeDomain(dom)) return null;
  if (NOT_A_COMPANY_SITE.some((h) => dom === h || dom.endsWith('.' + h))) return null;
  return { domain: dom, name: String(j.name || '').trim() };
}

const CLASSIFY_SYSTEM = 'You classify organisations into one short industry label. Reply with JSON only - no markdown, no explanation.';

async function aiClassifyIndustry(ctx) {
  const material = [
    'Organisation: ' + ctx.name,
    ctx.description ? 'Public record: ' + ctx.description : '',
    ctx.title ? 'Their website title: "' + ctx.title + '"' : '',
    ctx.intro ? 'Their website description: "' + ctx.intro + '"' : ''
  ].filter(Boolean).join('\n');
  if (!material.trim()) return null;
  const prompt = material + '\n'
    + 'Name the ONE industry this organisation belongs to. One or two words, e.g. "Media", "Telecom", "Banking", "Government".\n'
    + 'Answer with JSON only: {"industry":"..."}';
  /* A one-word answer does not need the full answer budget. A reasoning model
     spends the max_tokens budget on thinking BEFORE it answers, so a budget
     sized for prose essays made this one-word call take minutes. */
  const { text } = await aiComplete(prompt, { system: CLASSIFY_SYSTEM, temperature: 0, maxTokens: 3000,
    fast: true });
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const ind = String(j && j.industry || '').replace(/\s+/g, ' ').trim();
  if (ind.length < 2 || ind.length > 40) return null;
  return ind;
}

/* ---------------------------------------------------------------------- main */

/* A name like "Touch" means several organisations, and a lookup that guesses
   one is how a wrong customer gets created with a straight face. So the flow
   is two steps: the client first asks WHO the record could mean, shows the
   shortlist, and only then asks for the fields of the one picked. */
const ORGISH = /company|bank|telco|telecom|telecommunication|airline|group|holding|agency|authority|corporation|operator|provider|platform|service|retailer|conglomerate|enterprise|payment|fintech|insurer|manufacturer|vendor|carrier|operator|utility|publisher|network|brand|subsidiary|state-?owned/i;

export async function lookupChoices(query) {
  const q = String(query || '').trim();
  if (!q) return fail('no-query', 'Type a company name or their website.');

  /* A website needs no shortlist — there is exactly one place it can mean. */
  if (looksLikeDomain(q)) return { ok: true, query: q, choices: [] };

  let candidates;
  try {
    candidates = await searchWikidata(q);
    /* The record matches whole phrases, but people type the way they speak —
       "touch and go digital" — and no record is called that. So shorten from
       the right until something answers; the shortlist, not the search, decides
       which of the matches was meant. */
    const words = q.split(/\s+/);
    for (let n = words.length - 1; !candidates.length && n >= 2; n--) {
      candidates = await searchWikidata(words.slice(0, n).join(' '));
    }
  } catch (e) {
    return fail(e.code || 'unreachable', e.message || 'The public record could not be searched.',
      'Check this server can reach the internet, or type the company website instead.');
  }
  /* Organisations first: a person typing a customer name almost never means
     the song or the film that happens to share it. A nudge, not a filter. */
  candidates.sort((a, b) =>
    (ORGISH.test(b.description || '') ? 1 : 0) - (ORGISH.test(a.description || '') ? 1 : 0));

  return { ok: true, query: q, choices: candidates.slice(0, 6) };
}

export async function lookupCompany(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return fail('no-query', 'Type a company name or their website.');
  const rawPick = String(opts.pick || '').trim();
  const pick = /^Q\d{1,12}$/.test(rawPick) ? rawPick.toUpperCase() : '';

  const key = q.toLowerCase() + '|' + pick;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true };

  const result = await run(q, pick);
  if (result.ok) cache.set(key, { at: Date.now(), value: result });
  return result;
}

async function run(q, pick) {
  /* The clock for the entire lookup, started here so every stage below shares
     one budget instead of each taking a fresh timeout. See TOTAL_BUDGET_MS. */
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let budgetSpent = '';

  const sources = [];
  let domain = '';
  let matched = null;
  let aiNote = '';
  let aiWhy = '';
  let facts = { industry: null, hq: null, employees: null, founded: null };

  if (looksLikeDomain(q)) {
    domain = toDomain(q);
  } else {
    let entity = null;
    let picked = null;

    if (pick) {
      /* The person already chose who they mean. Read exactly that record —
         no searching, no ranking, no chance of a swap. */
      const details = await entityDetails([pick]);
      entity = details[pick];
      if (!entity || !entity.claims) {
        return fail('not-found', `The public record “${pick}” could not be read.`,
          'Pick another result, or type the company website and the lookup will read it directly.');
      }
      picked = {
        id: pick,
        label: (entity.labels && entity.labels.en && entity.labels.en.value) || q,
        description: (entity.descriptions && entity.descriptions.en && entity.descriptions.en.value) || ''
      };
    } else {
      let candidates;
      try {
        candidates = await searchWikidata(q);
      } catch (e) {
        return fail(e.code || 'unreachable', e.message || 'The public record could not be searched.',
          'Check this server can reach the internet, or type the company website instead.');
      }
      if (!candidates.length) {
        /* The record does not know the name — "tng digital" is real and absent.
           Ask the model for a lead before giving up, but nothing it says is
           shown unless the site it names has actually been read. */
        const ai = await aiSuggestDomain(q).catch((e) => { aiWhy = e?.message || 'the model did not answer'; return null; });
        if (ai) {
          domain = ai.domain;
          matched = { name: ai.name || q, description: 'suggested by the model', wikidataId: null };
          aiNote = 'The public record has no entry for “' + q + '”. The model suggested '
            + matched.name + ' at ' + domain + ' and the fields below were read there — confirm every one.';
        } else {
          /* Say what the model did, not just that nothing was found: "the model
             timed out" is a budget problem a person can fix, and silence is not. */
          return fail('not-found', `No public record found for “${q}”.`,
            'Wikidata has no organisation by that name'
            + (aiWhy ? ', and the model could not name one either — ' + aiWhy : '')
            + '. Type their website and the lookup will read it directly.');
        }
      }

      /* Prefer a hit that actually looks like the company: an organisation with
         a description, ideally mentioning the name we searched for. */
      const wanted = q.toLowerCase();
      candidates.sort((a, b) => {
        const sa = (a.label.toLowerCase() === wanted ? 0 : 1) + (a.description ? 0 : 1);
        const sb = (b.label.toLowerCase() === wanted ? 0 : 1) + (b.description ? 0 : 1);
        return sa - sb;
      });

      const details = await entityDetails(candidates.slice(0, 4).map(c => c.id));
      for (const c of candidates) {
        const e = details[c.id];
        if (!e) continue;
        const site = claimValue(e, 'P856');
        if (site && typeof site === 'string') {
          entity = e; picked = c; break;
        }
        if (!entity) { entity = e; picked = c; }
      }
    }

    if (picked) {
      const site = claimValue(entity, 'P856');
      matched = { name: picked.label, description: picked.description, wikidataId: picked.id };
      sources.push(source('Wikidata · ' + picked.id, 'https://www.wikidata.org/wiki/' + picked.id));
      if (site && typeof site === 'string') domain = toDomain(site);

      const hqId = claimValue(entity, 'P159');
      const indId = claimValue(entity, 'P452');
      const labels = await labelsFor([hqId?.id, indId?.id].filter(Boolean));
      if (hqId?.id && labels[hqId.id]) facts.hq = { value: labels[hqId.id], source: 'Wikidata P159' };
      /* A P452 label is written for editors ("telecommunications industry"),
         not for the field the board groups by — the same tidy-up the class
         fallback below gets, so a record that HAS an industry statement is
         not shown in rawer words than one that fell back to its class. */
      if (indId?.id && labels[indId.id]) {
        const rawInd = String(labels[indId.id]);
        const mappedInd = INDUSTRY_MAP.find(([re]) => re.test(rawInd));
        facts.industry = { value: mappedInd ? mappedInd[1]
          : rawInd.charAt(0).toUpperCase() + rawInd.slice(1), source: 'Wikidata P452' };
      }

      /* Most organisations publish no P452 industry at all — the public record
         says what they ARE (instance of), not what industry they sell to. The
         class label is still a published fact, and it classifies better than
         nothing: "public broadcaster" is exactly what RTM is. */
      if (!facts.industry) {
        const classIds = (entity?.claims?.P31 || [])
          .map((s) => s?.mainsnak?.datavalue?.value?.id).filter(Boolean).slice(0, 3);
        const classLabels = await labelsFor(classIds);
        /* Prefer a class the map recognises — a record can be several things
           ("business" AND "public broadcaster"), and only one of them is the
           word the board groups customers by. */
        let fallback = null;
        for (const id of classIds) {
          const label = classLabels[id];
          if (!label) continue;
          const mapped = INDUSTRY_MAP.find(([re]) => re.test(label));
          if (mapped) { facts.industry = { value: mapped[1], source: 'Wikidata P31' }; break; }
          if (!fallback) fallback = label;
        }
        if (!facts.industry && fallback) {
          facts.industry = { value: fallback.charAt(0).toUpperCase() + fallback.slice(1), source: 'Wikidata P31' };
        }
      }

      const emp = claimValue(entity, 'P1128');
      if (emp && emp.amount != null) {
        const n = Number(String(emp.amount).replace(/^\+/, ''));
        if (Number.isFinite(n) && n > 0) {
          facts.employees = { value: n, source: 'Wikidata P1128', asOf: (emp.pointInTime || '').slice(0, 10) || null };
        }
      }
      const founded = claimValue(entity, 'P571');
      if (founded && founded.time) {
        const y = String(founded.time).replace(/^\+/, '').slice(0, 4);
        if (/^\d{4}$/.test(y)) facts.founded = { value: y, source: 'Wikidata P571' };
      }
    }

    if (!domain) {
      /* The record exists but publishes no site. A model lead is tried the
         same way — suggested, then confirmed by reading it — before the
         honest dead end. */
      const ai = await aiSuggestDomain(matched ? matched.name : q,
        matched ? matched.description : '').catch((e) => { aiWhy = e?.message || 'the model did not answer'; return null; });
      if (ai) {
        domain = ai.domain;
        aiNote = (matched ? matched.name : q) + ' publishes no website in the public record. The model '
          + 'suggested ' + domain + ' and the fields below were read there — confirm every one.';
      } else {
        return fail('not-found', `Found “${matched ? matched.name : q}” but it publishes no website.`,
          'Type the company website and the lookup will read it directly'
          + (aiWhy ? ' — the model could not name it either (' + aiWhy + ')' : '') + '.');
      }
    }
  }

  if (NOT_A_COMPANY_SITE.some(h => domain === h || domain.endsWith('.' + h))) {
    return fail('invalid', 'That is not a company website.', 'Type the address of the company’s own site.');
  }

  let site = null;
  let siteUrl = '';
  let siteError = null;
  for (const candidate of ['https://' + domain, 'https://www.' + domain, 'http://' + domain]) {
    /* Each spelling is a fresh chance for the host to hang. Stop trying
       spellings once the lookup as a whole has run out of time: the next one
       would just spend another 9 s to reach the same conclusion. */
    if (left(deadline) <= 0) {
      budgetSpent = 'Ran out of time before their site could be read.';
      break;
    }
    try {
      const got = await fetchHtml(candidate);
      site = parseSite(got.html, got.url);
      siteUrl = got.url;
      /* The record of RTM points at rtm.gov.my, and rtm.gov.my has no DNS —
         only www.rtm.gov.my answers. The domain on the customer card must be
         the address that actually worked, never the one that did not. */
      domain = new URL(siteUrl).hostname;
      break;
    } catch (e) {
      siteError = e;
    }
  }

  if (!site) {
    /* The public record is still worth showing: the name, HQ and headcount are
       real even when the website is unreachable from here. An AI-led domain
       without a site behind it is NOT shown — a suggestion nothing confirmed
       is exactly what must not become a customer record. */
    if (matched && matched.wikidataId) {
      const result = { ok: true, query: q, domain, url: null, matched,
        site: null, socials: [], facts, sources,
        warning: `Found the public record, but their site could not be read from this server (${siteError?.message || 'unreachable'}).`,
        fetchedAt: new Date().toISOString()
      };
      /* No website and no industry claim: the model gets one more turn, and its
         answer is labelled as a suggestion the person must confirm — the same
         honesty rule the rest of this file runs on. Skipped when the budget is
         gone, and the warning then says so rather than leaving a silent gap. */
      if (!facts.industry && left(deadline) > 0) {
        const ind = await aiClassifyIndustry({ name: matched.name, description: matched.description }).catch(() => null);
        if (ind) {
          facts.industry = { value: ind, source: 'Model suggestion' };
          result.warning += ' The industry is the model\u2019s suggestion \u2014 confirm it.';
        }
      }
      if (budgetSpent) result.warning += ' ' + budgetSpent;
      return result;
    }
    return fail(siteError?.code || 'unreachable', siteError?.message || 'Could not read that site.',
      'Check the address, or create the customer without a lookup.');
  }

  if (siteUrl) sources.push(source('Their own site', siteUrl));

  const name = (site.siteName || site.title || matched?.name || q).replace(/\s*\|\s*.*$/, '').trim();

  /* Still no industry anywhere — the record, the classes, nothing. The model
     reads the site's own words and proposes one, labelled a suggestion. */
  if (!facts.industry && left(deadline) > 0) {
    const ind = await aiClassifyIndustry({
      name, description: matched?.description || '', title: site.title || '', intro: site.intro || ''
    }).catch(() => null);
    if (ind) {
      facts.industry = { value: ind, source: 'Model suggestion' };
      aiNote = (aiNote ? aiNote + ' ' : '')
        + 'The industry is the model\u2019s suggestion from their site \u2014 confirm it.';
    }
  }

  return {
    ok: true,
    query: q,
    domain,
    url: siteUrl,
    matched,
    site: {
      title: site.title || null,
      intro: site.intro || null,
      logo: site.logo || null,
      ogImage: site.ogImage || null
    },
    socials: site.socials,
    facts,
    sources,
    ...(aiNote ? { warning: aiNote } : {}),
    fetchedAt: new Date().toISOString()
  };
}

/* ------------------------------------------------- services for the client */

/* An industry for a customer that already exists and was never classified.
   The model answers from the site's own words when the site answers, and is
   labelled a suggestion either way — the person confirms, the record stays
   honest. */
export async function classifyIndustryPublic(ctx) {
  const name = String(ctx.name || '').trim();
  const domain = toDomain(String(ctx.domain || ctx.site || ''));
  if (!name && !domain) return fail('no-name', 'Nothing to classify — this customer has no name.');
  let title = '', intro = '';
  if (domain && looksLikeDomain(domain)) {
    for (const c of ['https://' + domain, 'https://www.' + domain]) {
      try {
        const got = await fetchHtml(c);
        const s = parseSite(got.html, got.url);
        title = s.title; intro = s.intro;
        break;
      } catch { /* the model still gets its turn */ }
    }
  }
  const ind = await aiClassifyIndustry({ name: name || domain, description: '', title, intro }).catch(() => null);
  if (!ind) return fail('no-class', 'The model could not name an industry.',
    'Type one in the Edit form — a word you know is better than one nobody confirmed.');
  return {
    ok: true,
    industry: ind,
    basedOn: title ? 'their site — \u201c' + title + '\u201d' : 'the model\u2019s own knowledge',
    note: 'Model suggestion — confirm it.'
  };
}

const BRIEF_SYSTEM = 'You write short, factual company briefs and call plans for a cloud sales team. '
  + 'You never invent facts, names, contracts, vendors or URLs. '
  + 'You keep what an organisation publishes about itself separate from what our own record says. '
  + 'Reply with JSON only - no markdown, no explanation.';

/* A draft of who the company is, what is happening, where Tencent Cloud could
   matter, and what to ask on the next call.

   Fed from two kinds of material, and the prompt names which is which: what
   THEIR SITE publishes, and what OUR RECORD holds — the pains somebody wrote
   down, the systems they run, the people we have met, how far our deals have
   got. The second kind is the one that makes this worth reading: a brief fed
   only a homepage is a paraphrase of marketing copy, which is what the old
   two-paragraph version was. The draft is labelled a draft in the UI. */
/* Where a company advertises for engineers. Not crawled exhaustively — two
   guesses at most, and the first page that answers with real prose wins. */
const CAREER_PATHS = ['/careers', '/careers/', '/jobs', '/join-us', '/career', '/en/careers'];

/* Enough text to read, not enough to drown the prompt. Strips the parts of a
   page that are chrome rather than content. */
function readableText(html, max) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(s).replace(/\s+/g, ' ').trim().slice(0, max);
}

/* What a company asks for in a job advert is the most honest thing it
   publishes about what it actually runs — far more than its homepage, which
   is written for customers. This is the one signal on this page that an SA
   cannot get anywhere else in the app. */
/* A URL that names its own failure — /404-error.page, /not-found — is not a
   source. The body check below misses the ones that say it in the address
   instead of the text, and a cited source that opens an error page is worse
   than no source at all, because it looks checked. */
const ERR_URL = /(404|not[-_]?found)/i;

async function readCareers(domain) {
  if (!domain || !looksLikeDomain(domain)) return null;
  /* A single-page-app site answers 200 with a "Page Not Found" body for every
     path it does not know — which would hand the model a page of nothing and
     come back as a signal about nothing. Refuse the soft 404 and keep looking. */
  const SOFT_404 = /(page not found|404\b|not found|no longer exists|we can'?t find|couldn'?t find)/i;
  for (const p of CAREER_PATHS.slice(0, 3)) {
    for (const base of ['https://' + domain, 'https://www.' + domain]) {
      try {
        const got = await fetchHtml(base + p);
        if (ERR_URL.test(got.url)) continue;
        const text = readableText(got.html, 6000);
        if (text.length < 400) continue;
        if (SOFT_404.test(text.slice(0, 600))) continue;
        return { url: got.url, text: text.slice(0, 2500) };
      } catch { /* no careers page there — try the next one */ }
    }
  }
  return null;
}

/* Two more pages worth reading before asking a model about a company. The
   homepage is written for the people who buy from them; the about page is the
   closest thing to how they would describe themselves in a room, and their own
   newsroom is the only place a dated fact about them lives. */
const ABOUT_PATHS = ['/about', '/about-us', '/company', '/who-we-are', '/corporate', '/our-company'];

async function readAbout(domain) {
  if (!domain || !looksLikeDomain(domain)) return null;
  const SOFT_404 = /(page not found|404\b|not found|no longer exists|we can'?t find|couldn'?t find)/i;
  for (const p of ABOUT_PATHS.slice(0, 4)) {
    for (const base of ['https://' + domain, 'https://www.' + domain]) {
      try {
        const got = await fetchHtml(base + p);
        if (ERR_URL.test(got.url)) continue;
        const text = readableText(got.html, 6000);
        if (text.length < 400) continue;
        if (SOFT_404.test(text.slice(0, 600))) continue;
        return { url: got.url, text: text.slice(0, 1800) };
      } catch { /* no about page there — try the next one */ }
    }
  }
  return null;
}

/* Their newsroom, as fetched — a feed if they publish one, otherwise headlines
   off the usual paths. No model touches this: the lines handed to the prompt
   are the lines the page printed. */
async function readNewsroom(domain, homeHtml, homeUrl) {
  if (!domain || !looksLikeDomain(domain)) return null;
  const base = homeUrl || ('https://' + domain);
  if (homeHtml) {
    for (const cand of [...discoverFeeds(homeHtml, base), ...FEED_PATHS.map((p) => 'https://' + domain + p)]
      .slice(0, 5)) {
      try {
        const got = await fetchHtml(cand);
        const items = ERR_URL.test(got.url) ? [] : parseFeed(got.html, got.url);
        if (items.length) return { url: got.url, items: items.slice(0, 8) };
      } catch { /* the next candidate */ }
    }
  }
  for (const p of NEWS_PATHS.slice(0, 6)) {
    for (const b of ['https://' + domain, 'https://www.' + domain]) {
      try {
        const got = await fetchHtml(b + p);
        const items = ERR_URL.test(got.url) ? [] : extractHeadlines(got.html, got.url);
        if (items.length) return { url: got.url, items: items.slice(0, 8) };
      } catch { /* the next candidate */ }
    }
  }
  return null;
}

export async function companyBrief(ctx) {
  const name = String(ctx.name || '').trim();
  if (!name) return fail('no-name', 'The customer has no name to ask about.');
  const domain = toDomain(String(ctx.domain || ctx.site || ''));
  let title = '', intro = '', siteUrl = '', homeHtml = '', homeUrl = '';
  if (domain && looksLikeDomain(domain)) {
    for (const c of ['https://' + domain, 'https://www.' + domain]) {
      try {
        const got = await fetchHtml(c);
        const s = parseSite(got.html, got.url);
        title = s.title; intro = s.intro; siteUrl = got.url;
        homeHtml = got.html; homeUrl = got.url;
        break;
      } catch { /* brief without the site below */ }
    }
  }
  /* A public news search is the only source here that says what is happening
     rather than what they want said — their own pages are written for the
     people who buy from them. A plain fetch, no model call of its own. */
  const marketP = (async () => {
    try {
      const got = await marketNews(name);
      if (got.items && got.items.length) return { url: got.from, items: got.items.slice(0, 8) };
    } catch { /* a blocked news search must not lose the rest of the brief */ }
    return null;
  })();

  /* Four reads in parallel — hiring, self-description, their announcements,
     and what the market says. Each is optional; none holds up the others. */
  const [careers, about, newsroom, market] = await Promise.all([
    readCareers(domain), readAbout(domain), readNewsroom(domain, homeHtml, homeUrl), marketP]);
  const newsItems = (newsroom && newsroom.items) || [];
  const published = [
    'Organisation: ' + name,
    ctx.description ? 'Public record: ' + ctx.description : '',
    ctx.industry ? 'Industry on the record: ' + ctx.industry : '',
    ctx.hq ? 'Headquarters: ' + ctx.hq : '',
    ctx.people ? 'Headcount on the record: ' + ctx.people : '',
    title ? 'Their website title: "' + title + '"' : '',
    intro ? 'Their website description: "' + intro + '"' : ''
  ].filter(Boolean);
  /* Our own record, kept as its own block so the model can tell the two apart
     and so it never dresses up something we never wrote down as a fact. */
  const rec = [];
  if (Array.isArray(ctx.pains) && ctx.pains.length) rec.push('Pain points: ' + ctx.pains.join('; '));
  if (Array.isArray(ctx.systems) && ctx.systems.length) rec.push('Systems they run: ' + ctx.systems.join('; '));
  if (Array.isArray(ctx.contacts) && ctx.contacts.length)
    rec.push('People we know there: ' + ctx.contacts.map(x => [x && x.n, x && x.t].filter(Boolean).join(' - ')).join('; '));
  if (Array.isArray(ctx.opps) && ctx.opps.length)
    rec.push('Our open deals: ' + ctx.opps.map(o => [o && o.t, o && o.stage, o && o.v].filter(Boolean).join(' / ')).join('; '));
  if (Array.isArray(ctx.timeline) && ctx.timeline.length)
    rec.push('Recent entries on our timeline: ' + ctx.timeline.map(t => [t && t.d, t && t.t].filter(Boolean).join(' ')).join('; '));

  const material = published.join('\n')
    + (about ? '\n\nTHEIR ABOUT PAGE (how they describe themselves):\n' + about.text : '')
    + (careers ? '\n\nTHEIR CAREERS PAGE (what they advertise to the engineers they hire):\n' + careers.text : '')
    + (newsItems.length ? '\n\nTHEIR OWN NEWSROOM (headlines they published, newest first):\n'
      + newsItems.map(n => [n && n.d, n && n.h].filter(Boolean).join(' ')).join('\n') : '')
    + (market && market.items.length ? '\n\nPUBLIC NEWS (headlines about this name from a public news '
      + 'search - written about them, not by them; use only the ones that are clearly this '
      + 'organisation, and drop the rest):\n'
      + market.items.map(n => [n && n.d, n && n.h].filter(Boolean).join(' ')).join('\n') : '')
    + (rec.length ? '\n\nOUR OWN RECORD (what we have learned, not what they publish):\n' + rec.join('\n') : '');
  if (!intro && !title && !ctx.description && !rec.length && !careers && !about && !newsItems.length) {
    return fail('no-material', 'Nothing could be read about them — their site did not answer, the public record has no entry, and our own record is empty.',
      'Add a word or two in Edit first, or try again when their site is reachable.');
  }
  const prompt = material + '\n'
    + 'Write a research brief and a call plan for a cloud account team.\n'
    + '"who": what this organisation is - at most 2 short sentences, from the published material only.\n'
    + '"signals": an array of at most 4 objects, newest first, each {"t": the fact in one short line '
    + 'under 25 words, dated where the material gives a date ("2026-05: network rollout announced"), '
    + '"s": where it came from in two or three words - "public news", "their newsroom", "their '
    + 'careers page", "our timeline", "our open deals", "their own site"}. One event per line, and '
    + 'prefer a dated event from public news or our own record over anything their homepage claims '
    + 'about itself - and only an event a cloud provider could act on: infrastructure, technology, '
    + 'expansion, M&A, regulation, leadership. A sponsorship, a brand campaign or an award is not a '
    + 'signal, however recent. Return an empty array '
    + 'when nothing is supported - never an essay about nothing.\n'
    + '"tech": an array of at most 5 short strings - engineering, platform, infrastructure or data '
    + 'signals readable from their careers page or published material, each naming what was actually '
    + 'said (for example "Hiring: Kubernetes engineer", "Job posts mention Kafka and Terraform"). '
    + 'Never list a product they sell or a marketing name - a consumer plan is not a tech signal. '
    + 'Return an empty array when nothing in the material supports one. Never infer a product or vendor '
    + 'from the industry - only from words that are actually there.\n'
    + '"hurt": an array of at most 3 hypotheses about where this account hurts, each an object '
    + '{"h": one short sentence naming the likely pain, "why": a short clause naming what in the material '
    + 'supports it - a recorded pain point, a system they run, a role we have met, a deal stage, something '
    + 'their careers page says}. Every "why" must point at something actually in the material. Where the '
    + 'material supports no hypothesis, return an empty array - never a pain generic to the industry.\n'
    + '"fit": where Tencent Cloud could plausibly matter - at most 3 short sentences, grounded in the '
    + 'systems they run and the pain points on OUR OWN RECORD where those exist; written as '
    + 'possibilities ("could", "may"), never as claims about existing contracts or named vendors. If the '
    + 'material does not support a cloud angle, say in one sentence what you would need to know.\n'
    + '"opener": one sentence the seller could open the next meeting with, tied to one specific fact above.\n'
    + '"questions": exactly 3 discovery questions, each aimed at a gap in what we know. If no systems are '
    + 'on the record, ask what they run; if no pains are recorded, ask what hurts; if nobody has been met, '
    + 'ask who owns the decision. Never a question a seller could ask anyone. '
    + 'When our open deals name a stage, pitch them at that stage; with no open deal, pitch them at a '
    + 'first meeting - a question about renewal pricing is useless before anyone has met.\n'
    + '"objection": one objection they are likely to raise, and a one-line response to it. One string.\n'
    + 'Never invent a URL, a person, a contract or a vendor. When OUR OWN RECORD is absent for something, '
    + 'say it is not on the record rather than implying we know it.\n'
    + 'Answer with JSON only: {"who":"...","signals":["..."],"tech":["..."],'
    + '"hurt":[{"h":"...","why":"..."}],"fit":"...","opener":"...",'
    + '"questions":["...","...","..."],"objection":"..."}';
  /* A brief, not an essay: a bounded budget keeps the answer inside the
     timeout ceiling. Raised from 6000 now that a call plan rides along. */
  const { text } = await aiComplete(prompt, { system: BRIEF_SYSTEM, temperature: 0.3, maxTokens: 8000 });
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return fail('no-brief', 'The model did not answer with a draft.', 'Try again.');
  let j;
  try { j = JSON.parse(m[0]); } catch { return fail('no-brief', 'The model did not answer with a draft.', 'Try again.'); }
  const who = String(j.who || '').trim();
  const fit = String(j.fit || '').trim();
  if (who.length < 20 || fit.length < 20) return fail('no-brief', 'The draft came back too thin to use.', 'Try again.');
  /* A model that answers a list field with a sentence still gets a list — one
     long line is worth reading, a lost field is not. */
  /* A signal is worth as much as its source. Accepts the object the prompt asks
     for, the bare string an older draft stored, and anything a model might call
     the text field — a lost source costs less than a lost signal. */
  const sources = [siteUrl ? source('Their own site', siteUrl) : null,
    about ? source('Their about page', about.url) : null,
    newsroom ? source('Their newsroom', newsroom.url) : null,
    market ? source('Public news', market.url) : null,
    careers ? source('Their careers page', careers.url) : null,
    rec.length ? source('Our own record', null) : null].filter(Boolean);
  /* The "s" on a signal is a few words the model chose; the page behind it is
     already in `sources`. Matching the two turns a claim of provenance into a
     link the seller can open — "public news" is an assertion, the URL is the
     thing they can check before repeating it in a meeting. Words common to
     every label ("their", "page", "own") match nothing, so the pairing rests
     on the word that actually distinguishes a source. */
  const srcUrlFor = (label) => {
    const words = String(label || '').toLowerCase().split(/[^a-z]+/)
      .filter(w => w.length > 3 && !['their', 'page', 'from', 'posts'].includes(w));
    let best = null, bestN = 0;
    for (const s of sources){
      const n = words.filter(w => s.label.toLowerCase().includes(w)).length;
      if (n > bestN){ best = s; bestN = n; }
    }
    return bestN ? (best.url || null) : null;
  };
  const signals = (Array.isArray(j.signals) ? j.signals : [j.signals])
    .map(s => (s && typeof s === 'object')
      ? { t: String(s.t ?? s.text ?? s.line ?? s.h ?? '').trim().slice(0, 200),
          s: String(s.s ?? s.src ?? s.source ?? '').trim().slice(0, 60) }
      : { t: String(s || '').trim().slice(0, 200), s: '' })
    .filter(x => x.t).slice(0, 4)
    .map(x => ({ t: x.t, s: x.s, u: srcUrlFor(x.s) }));
  /* A hypothesis with no reason attached is just an assertion wearing a
     question mark — the "why" is what lets the seller judge it. */
  const hurt = (Array.isArray(j.hurt) ? j.hurt : [])
    .map(x => x && typeof x === 'object'
      ? { h: String(x.h || '').trim().slice(0, 200), why: String(x.why || '').trim().slice(0, 200) }
      : { h: String(x || '').trim().slice(0, 200), why: '' })
    .filter(x => x.h).slice(0, 3);
  return {
    ok: true,
    who: who.slice(0, 400),
    signals,
    hurt,
    tech: (Array.isArray(j.tech) ? j.tech : [])
      .map(t => String(t || '').trim()).filter(Boolean).slice(0, 5).map(t => t.slice(0, 200)),
    fit: fit.slice(0, 500),
    opener: String(j.opener || '').trim().slice(0, 300),
    questions: (Array.isArray(j.questions) ? j.questions : [])
      .map(q => String(q || '').trim()).filter(Boolean).slice(0, 3).map(q => q.slice(0, 200)),
    objection: String(j.objection || '').trim().slice(0, 400),
    basedOn: siteUrl || null,
    sources,
    note: 'Drafted by the model — not verified. Confirm anything you present.'
  };
}

/* ------------------------------------------------------------ market news */

const NEWS_PATHS = ['/news', '/newsroom', '/press', '/media', '/press-releases',
  '/media-centre', '/announcements', '/whats-new', '/updates'];
const FEED_PATHS = ['/feed', '/rss', '/feed/rss', '/rss.xml', '/feed.xml', '/atom.xml',
  '/news/feed', '/news/rss', '/en/feed', '/media/feed'];
/* The seller asked for the whole surface of business signals, not just the
   obvious four. A product launch or a digital-transformation programme is
   often the earliest signal there is. */
const NEWS_KINDS = ['ai', 'cloud', 'transformation', 'product', 'expansion', 'strategy',
  'investment', 'partnership', 'regulatory', 'competitor', 'people', 'security',
  'tender', 'funding', 'note'];

/* A menu link is not a headline. "Our Sustainability Journey" is navigation that
   happens to be thirty characters long; scraping it and presenting it as market
   news is worse than returning nothing. So a link has to earn its place: a printed
   date, a news-shaped path, or a news-shaped container — and never a nav or footer. */
const NEWS_HINT = /(news|press|media|article|berita|blog|story|release|announcement|update|pengumuman)/i;
const NAV_HINT = /(nav|menu|footer|header|breadcrumb|sitemap|skip-?link|topbar|mega-?menu|copyright)/i;
const p2 = (n) => String(Number(n)).padStart(2, '0');

/* A date printed near the headline is taken as printed; nothing is inferred.
   long = [month, day, year] — writing it any other way stores a date that is
   not the one on the page, and a wrong date is worse than no date. */
function dateNear(text) {
  const iso = text.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (iso) return iso[1] + '-' + p2(iso[2]) + '-' + p2(iso[3]);
  const long = text.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(20\d{2})/i);
  if (long) {
    const mo = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
      .indexOf(long[1].slice(0, 3).toLowerCase()) + 1;
    if (mo > 0) return long[3] + '-' + p2(mo) + '-' + p2(long[2]);
  }
  return '';
}

function isoTry(anyDate) {
  const s = String(anyDate || '').trim();
  if (!s) return '';
  const near = dateNear(s);
  if (near) return near;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    if (d.getUTCFullYear() >= 2000 && d.getUTCFullYear() <= 2100) return d.toISOString().slice(0, 10);
  }
  return '';
}

function extractHeadlines(html, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi)) {
    let u;
    try { u = new URL(m[1], baseUrl); } catch { continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    const text = decodeEntities(m[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (text.length < 25 || text.length > 180) continue;
    if (/^(read more|more|view all|see all|click here|home|contact us|about us|privacy|copyright)/i.test(text)) continue;
    const key = u.origin + u.pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    /* What surrounds the link is the only evidence of which it is. */
    const own = m[0].slice(0, 400);
    const before = html.slice(Math.max(0, m.index - 400), m.index).slice(-280);
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 260);
    if (NAV_HINT.test(own) || NAV_HINT.test(before)) continue;
    const d = dateNear(own + ' ' + after) || dateNear(before);
    const newsHref = NEWS_HINT.test(u.pathname + ' ' + u.search) || /\/(19|20)\d{2}\b/.test(u.pathname);
    const newsRegion = NEWS_HINT.test(own) || NEWS_HINT.test(before);
    if (!d && !newsHref && !newsRegion) continue;
    out.push({ h: text, u: u.href, d });
    if (out.length >= 24) break;
  }
  return out;
}

/* A syndication feed is the best source there is: the site publishes the headline,
   the link and the date itself, so nothing here has to guess which anchor is news. */
function discoverFeeds(html, baseUrl) {
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel=["'][^"']*alternate/i.test(tag)) continue;
    if (!/type=["'][^"']*(rss|atom)/i.test(tag)) continue;
    const h = tag.match(/href=["']([^"']+)["']/i);
    if (!h) continue;
    try { out.push(new URL(h[1], baseUrl).href); } catch { /* not a URL */ }
  }
  return out.slice(0, 4);
}

function parseFeed(xml, baseUrl) {
  const out = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const t = b.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!t) continue;
    let title = decodeEntities(
      String(t[1]).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' '),
    ).replace(/\s+/g, ' ').trim();
    if (title.length < 12 || title.length > 220) continue;
    /* News aggregators print "Headline - Publisher". The publisher is only taken
       off the headline when the feed also states it, so a title that genuinely
       ends in a dash is never mangled. */
    const sm = b.match(/<source\b[^>]*>([\s\S]*?)<\/source>/i);
    const srcName = sm ? decodeEntities(String(sm[1]).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim() : '';
    let src = srcName;
    if (srcName && title.endsWith(' - ' + srcName)) {
      title = title.slice(0, -(srcName.length + 3)).trim();
    }
    const l = b.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)
      || b.match(/<link\b[^>]*href=["']([^"']+)["']/i);
    let href = '';
    if (l) {
      const raw = String(l[1] || '').trim();
      if (raw) { try { href = new URL(raw, baseUrl).href; } catch { href = ''; } }
    }
    if (!href) continue;
    const dt = b.match(/<(pubDate|updated|published|dc:date)\b[^>]*>([\s\S]*?)<\/\1>/i);
    out.push({ h: title, u: href, d: isoTry(dt ? dt[2] : ''), src });
    if (out.length >= 24) break;
  }
  return out;
}

/* What a seller actually asked for: news about this company from the market —
   competitors named alongside them, funding, regulation, a new appointment.
   Their own website only ever publishes what they want said about themselves,
   and most corporate sites build their pages in the browser where a server
   cannot read them. A public news search is a real source with real dates. */
const MARKET_NEWS = 'https://news.google.com/rss/search';

async function marketNews(q) {
  const url = MARKET_NEWS + '?q=' + encodeURIComponent(q) + '&hl=en-MY&gl=MY&ceid=MY:en';
  const got = await fetchHtml(url);
  const items = parseFeed(got.html, got.url);
  return { items, from: got.url };
}

const TRIAGE_SYSTEM = 'You triage news headlines for a cloud sales team. Reply with JSON only - no markdown, no explanation.';

async function aiTriageNews(name, items) {
  const list = items.map((it, i) => i + '. ' + it.h).join('\n');
  const prompt = 'Customer: ' + name + '\n'
    + 'Headlines from a public news search for this name, and from their own site:\n' + list + '\n'
    + 'For each headline that could matter to a cloud seller, give: i (the index), kind '
    + '(one of ' + NEWS_KINDS.join(', ') + '), and why (one short sentence on the concrete '
    + 'reason a cloud provider should care - an opportunity, a risk, a conversation opener). '
    + 'Look beyond the obvious: AI or cloud adoption, digital transformation, new products or '
    + 'services, expansion into new markets, business strategy, technology investment, '
    + 'partnerships, regulation, leadership changes, competitor or vendor movements, funding, '
    + 'cybersecurity and infrastructure. Prefer the 8 most useful; drop pure marketing. '
    + 'Never use an index that is not in the list.\n'
    + 'Answer with JSON only: {"items":[{"i":0,"kind":"ai","why":"..."}]}';
  /* Index, kind, one sentence — the answer is small, so the budget is small.
     At the workspace default this call ran to the 240 s timeout ceiling and
     past it; bounded reasoning brings it back to practical use. */
  const { text } = await aiComplete(prompt, { system: TRIAGE_SYSTEM, temperature: 0, maxTokens: 3000,
    fast: true });
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  return Array.isArray(j && j.items) ? j.items : null;
}

/* The one place the app reaches past a single record into the market — so it
   is built on the same rule as the rest: everything shown was fetched from a
   real page, and the model only labels what the fetch already brought back.
   A headline the model invents has no index, so it cannot survive. */
export async function collectNews(ctx) {
  const name = String(ctx.name || '').trim();
  const domain = toDomain(String(ctx.domain || ctx.site || ''));
  if (!name && (!domain || !looksLikeDomain(domain))) {
    return fail('no-name', 'Nothing to search for — this customer has no name.');
  }

  /* The market first: what is being said about them, which is what a seller
     asked for. Competitors named in the same breath, a new appointment, a
     regulator, funding — none of that is on their own website. */
  let marketItems = [];
  let marketUrl = '';
  if (name) {
    try {
      const got = await marketNews(name);
      marketItems = got.items;
      marketUrl = got.from;
    } catch { /* a blocked news search must not lose their own newsroom too */ }
  }

  /* Their own website second. A feed if they publish one, otherwise a newsroom
     page — and both are optional now, because the market search stands alone. */
  let homeHtml = '';
  let homeUrl = '';
  if (domain && looksLikeDomain(domain)) {
    for (const c of ['https://' + domain, 'https://www.' + domain]) {
      try { const got = await fetchHtml(c); homeHtml = got.html; homeUrl = got.url; break; } catch { /* next */ }
    }
  }
  /* A syndication feed beats scraping: the site itself states the headline, the
     link and the date, so nothing here has to decide which anchor is news. */
  const homeBase = homeUrl || ('https://' + domain);
  let feedItems = [];
  let feedUrl = '';
  if (homeHtml) {
    const feedTries = [...discoverFeeds(homeHtml, homeBase),
      ...FEED_PATHS.map((p) => 'https://' + domain + p)];
    for (const cand of feedTries.slice(0, 6)) {
      try {
        const got = await fetchHtml(cand);
        const parsed = parseFeed(got.html, got.url);
        if (parsed.length) { feedItems = parsed; feedUrl = got.url; break; }
      } catch { /* the next candidate */ }
    }
  }

  /* Newsroom next: links on their own home page whose path smells like news.
      No such link, and the usual paths get a try — some sites bury it. */
  const pages = [];
  const seen = new Set();
  try {
    const base = new URL(homeUrl || ('https://' + domain));
    for (const m of homeHtml.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
      let u;
      try { u = new URL(m[1], base); } catch { continue; }
      if (u.hostname !== base.hostname && !u.hostname.endsWith('.' + domain)) continue;
      if (!/news|press|media|announce|story|update/i.test(u.pathname)) continue;
      if (/\.pdf($|\?)|javascript:|mailto:|#/i.test(u.href)) continue;
      const key = u.origin + u.pathname;
      if (seen.has(key)) continue;
      seen.add(key);
      pages.push(u.href);
      if (pages.length >= 3) break;
    }
  } catch { /* fall through to the usual paths */ }
  if (homeHtml && !feedItems.length && !pages.length) {
    for (const p of NEWS_PATHS) pages.push('https://' + domain + p);
  }

  let newsHtml = '', newsUrl = '';
  for (const cand of (feedItems.length ? [] : pages.slice(0, 5))) {
    try {
      const got = await fetchHtml(cand);
      const gotItems = extractHeadlines(got.html, got.url);
      if (gotItems.length) { newsHtml = got.html; newsUrl = got.url; break; }
    } catch { /* the next candidate */ }
  }
  const ownItems = feedItems.length ? feedItems
    : (newsHtml ? extractHeadlines(newsHtml, newsUrl)
      : (homeHtml ? extractHeadlines(homeHtml, homeUrl || ('https://' + domain)) : []));
  /* Market first: it is what was asked for, and it carries its own dates. */
  const items = [...marketItems, ...ownItems].slice(0, 24);
  if (!items.length) {
    return { ok: true, items: [], from: marketUrl || feedUrl || newsUrl || homeUrl,
      note: 'No news was found for this name, and nothing news-shaped on their own site either — no feed, and no dated or newsroom links. Some sites build their pages in the browser, where a server cannot read them. Record what you saw by hand.' };
  }
  let triaged = null;
  try { triaged = await aiTriageNews(name || domain, items); } catch { triaged = null; }
  if (triaged && triaged.length) {
    const out = [];
    for (const t of triaged) {
      const i = Number(t && t.i);
      if (!Number.isInteger(i) || i < 0 || i >= items.length) continue;
      const kind = NEWS_KINDS.includes(t.kind) ? t.kind : 'note';
      out.push({ ...items[i], kind, why: String(t.why || '').slice(0, 300) || 'No reason recorded.' });
      if (out.length >= 10) break;
    }
    if (out.length) {
      return { ok: true, items: out, from: marketUrl || feedUrl || newsUrl || homeUrl,
        note: 'Headlines, links and dates are what the source published; the kind and the why are the model\u2019s read — every one stays unverified until somebody opens the link.' };
    }
  }
  return { ok: true, items: items.slice(0, 10).map((it) => ({ ...it, kind: 'note', why: 'No read on why this matters yet — the model did not answer.' })),
    from: marketUrl || feedUrl || newsUrl || homeUrl,
    note: 'The model did not triage them, so every one is marked "note". Headlines, links and dates are exactly what the source published.' };
}

/* ------------------------------------------------------------ meeting minutes
   A pasted MOM is the richest source in the whole product — and the easiest to
   waste: dumping the raw text into a record nobody re-reads helps nobody. The
   model's job here is extraction, not authorship: every concern, decision and
   commitment it returns must be traceable to the text, next steps are proposed
   for a person to accept or drop, and the caller sees all of it before
   anything is written. Dates are validated to ISO or dropped — a date the
   model half-remembered is worse than none. */
const MOM_SYSTEM = 'You read meeting minutes for a cloud account team. Reply with JSON only - no markdown, no explanation.';

export async function readMinutes(ctx) {
  const text = String(ctx.text || '').trim();
  if (text.length < 40) return fail('too-short', 'Paste the minutes first — a couple of lines is not enough to read.');
  if (text.length > 20000) return fail('too-long', 'That is more than 20,000 characters — paste the relevant part of the minutes.');
  const prompt = 'These are minutes from a customer meeting:\n\n' + text.slice(0, 20000) + '\n\n'
    + 'Extract, strictly from the text:\n'
    + '- summary: what the meeting was about, 1-2 sentences.\n'
    + '- outcome: what changed or was agreed, 1 sentence.\n'
    + '- digest: the meeting in one line of at most 20 words for an activity timeline - '
    + 'the subject and the headline; no attendee names, no dates, no preamble.\n'
    + '- concerns: the customer\'s concerns and pain points, each one short line.\n'
    + '- requirements: requirements the customer stated, each one short line.\n'
    + '- decisions: decisions that were taken, each one short line.\n'
    + '- commitments: commitments people made, each one short line with who made it when the text says.\n'
    + '- steps: up to 6 next steps worth recording. Each: t (what to do, one line, starts with a verb), '
    + 'from ("us" if it is our move, "customer" if we wait on them), due (ISO date 2026-10-05 only if the text '
    + 'states one, else ""), kind (one of opportunity, follow-up, task, meeting, proposal, sa, product, validate, prepare), '
    + 'exec (the person or role the minutes put this step on, only if the text names one, else ""), '
    + 'opp (the title of the opportunity this step relates to, only if the minutes name one, else "").\n'
    + '- opps: up to 3 potential opportunities you can see in the text. Each: t (a short title), '
    + 'why (one line: which sentence in the minutes suggests it). Only what the text supports - '
    + 'do not present speculation as confirmed customer demand.\n'
    + '- pains: up to 4 pain points the customer stated, in their own words, each one short line. '
    + 'Only troubles the text names - never one you inferred.\n'
    + 'Never invent a concern, a requirement, a decision, a date or a commitment the text does not contain.\n'
    + 'Answer with JSON only: {"summary":"...","outcome":"...","digest":"...","concerns":["..."],"requirements":["..."],'
    + '"decisions":["..."],"commitments":["..."],"steps":[{"t":"...","from":"us","due":"","kind":"follow-up",'
    + '"exec":"","opp":""}],"opps":[{"t":"...","why":"..."}],"pains":["..."]}';
  const { text: out } = await aiComplete(prompt, { system: MOM_SYSTEM, temperature: 0, maxTokens: 6000,
    fast: true });
  const m = String(out).match(/\{[\s\S]*\}/);
  if (!m) return fail('no-read', 'The model did not answer with a reading of the minutes.', 'Try again.');
  let j;
  try { j = JSON.parse(m[0]); } catch { return fail('no-read', 'The model did not answer with a reading of the minutes.', 'Try again.'); }
  const lines = (a, n) => (Array.isArray(a) ? a : [])
    .map((s) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, n);
  const steps = (Array.isArray(j.steps) ? j.steps : [])
    .map((s) => s && typeof s === 'object' ? s : null).filter(Boolean)
    .map((s) => ({
      t: String(s.t || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      from: s.from === 'customer' ? 'customer' : 'us',
      due: /^\d{4}-\d{2}-\d{2}$/.test(String(s.due || '')) ? String(s.due) : '',
      kind: String(s.kind || 'follow-up'),
      /* §9: the minutes may name an execution owner and a related deal. Both
         are free text the model copies from the paste — the page is the one
         that matches the deal title against the account's own book, and an
         unmatched title is dropped rather than guessed at. */
      exec: String(s.exec || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      opp: String(s.opp || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    }))
    .filter((s) => s.t.length > 3).slice(0, 6);
  /* §10: a potential opportunity is the model noticing a sentence, not the
     customer confirming demand — the why is mandatory so the reader can
     check it against the text they pasted. */
  const opps = (Array.isArray(j.opps) ? j.opps : [])
    .map((x) => x && typeof x === 'object' ? x : null).filter(Boolean)
    .map((x) => ({ t: String(x.t || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      why: String(x.why || '').replace(/\s+/g, ' ').trim().slice(0, 300) }))
    .filter((x) => x.t.length > 3).slice(0, 3);
  return { ok: true,
    summary: String(j.summary || '').replace(/\s+/g, ' ').trim().slice(0, 600),
    outcome: String(j.outcome || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    /* The timeline's one line — shorter than a summary, never a name roll. */
    digest: String(j.digest || '').replace(/\s+/g, ' ').trim().slice(0, 220),
    concerns: lines(j.concerns, 8),
    requirements: lines(j.requirements, 8),
    decisions: lines(j.decisions, 8),
    commitments: lines(j.commitments, 8),
    steps,
    opps,
    /* §14: the paste may carry pain points in the customer's own words —
       they become the account's recorded pains only through the tick-and-
       add flow, never on the reading itself. */
    pains: lines(j.pains, 4),
    note: 'Read from the minutes you pasted. Nothing is written until you save; every suggestion stays yours to accept or drop.' };
}

/* ------------------------------------------------------------ sales insights
   "What should we do next?" is the question a BD actually brings to a screen.
   The caller builds the context and SHOWS it to the user before sending — the
   model receives exactly what the panel says, no more — and the answer must be
   moves a person can accept, not an essay. Anonymity is the caller's job; this
   side only guarantees the model is asked with a bounded budget and that its
   kinds are validated before anything reaches a record. */
const INSIGHT_SYSTEM = 'You are a cloud account coach. You give specific, actionable next moves for the account team. Reply with JSON only - no markdown, no explanation.';

export async function salesInsights(ctx) {
  const facts = ctx && typeof ctx === 'object' ? ctx : {};
  const parts = Object.entries(facts)
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => k + ': ' + (Array.isArray(v) ? v.join(' | ') : String(v)));
  if (!parts.length) return fail('empty', 'There is nothing to read yet — record a meeting, a pain point or an opportunity first.');
  const prompt = 'Facts about one customer account (anonymised - no person or company names):\n'
    + parts.join('\n') + '\n\n'
    + 'You are coaching the account team. Reply with:\n'
    + '- moves: up to 5 specific next moves. Each: what (one line, starts with a verb, specific to these facts), '
    + 'why (one line: which fact drives it), kind (one of opportunity, follow-up, task, meeting, proposal, sa, '
    + 'product, validate, prepare).\n'
    + '- gaps: up to 4 things the team has NOT followed up on, or information still missing (short lines).\n'
    + '- prepare: up to 3 things to prepare before the next meeting (short lines).\n'
    + 'Be concrete. If the facts support no move, say so in gaps rather than inventing one.\n'
    + 'Answer with JSON only: {"moves":[{"what":"...","why":"...","kind":"follow-up"}],'
    + '"gaps":["..."],"prepare":["..."]}';
  /* Five moves with a why each is a multi-part structured answer: this
     reasoning model spends small budgets entirely on thinking and returns
     empty. Measured: 4000 and 6000 both came back empty after 90-160 s;
     the workspace default (12000) is what actually answers. */
  const { text } = await aiComplete(prompt, { system: INSIGHT_SYSTEM, temperature: 0.2,
    fast: true, maxTokens: 6000 });
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return fail('no-read', 'The model did not answer with insights.', 'Try again.');
  let j;
  try { j = JSON.parse(m[0]); } catch { return fail('no-read', 'The model did not answer with insights.', 'Try again.'); }
  const KINDS = ['opportunity', 'follow-up', 'task', 'meeting', 'proposal', 'sa', 'product', 'validate', 'prepare'];
  const line = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const moves = (Array.isArray(j.moves) ? j.moves : [])
    .map((x) => x && typeof x === 'object' ? x : null).filter(Boolean)
    .map((x) => ({ what: line(x.what).slice(0, 240), why: line(x.why).slice(0, 240),
      kind: KINDS.includes(x.kind) ? x.kind : 'follow-up' }))
    .filter((x) => x.what.length > 3).slice(0, 5);
  return { ok: true, moves,
    gaps: (Array.isArray(j.gaps) ? j.gaps : []).map(line).filter(Boolean).slice(0, 4),
    prepare: (Array.isArray(j.prepare) ? j.prepare : []).map(line).filter(Boolean).slice(0, 3),
    note: 'Built only from the facts shown in the panel. Every move is a suggestion — nothing is written until you accept it.' };
}
