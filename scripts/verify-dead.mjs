/**
 * Mechanical "is it actually wired?" sweep of the shipped single-file app.
 *
 * WHY THIS EXISTS
 * ---------------
 * A button that renders and does nothing is worse than no button: the user
 * believes the product can do something it cannot. Reading 6 000 lines of
 * template strings does not find those; this does, in a second, and it is the
 * only kind of check that does not depend on remembering to look.
 *
 * It answers five questions:
 *   1. Is every `data-act` that gets rendered actually handled?
 *   2. Is every `data-*` attribute that gets rendered actually read?
 *   3. Is every function that gets called actually declared?
 *   4. Is there a literal date in the source that will silently back-date
 *      every record created after it?
 *   5. Does any toast draw an action it has no handler for?
 *
 * False positives are possible (a name that is also prose, a CSS function).
 * The output is a list to triage, not a verdict — but every one of the four
 * has found a real bug in this app.
 *
 * Run from customer-workbench/:  npm run verify:dead
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, '..', 'Waypoint-v1.html');
const html = readFileSync(FILE, 'utf8');

let ran = 0, bad = false;
const check = (name, cond, detail) => {
  ran++;
  if (!cond) bad = true;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${detail}` : ''}`);
};

/* Everything interesting is in the biggest <script> block. */
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const src = blocks.sort((a, b) => b.length - a.length)[0] || '';
check('the app script was found', src.length > 50_000, `${(src.length / 1024).toFixed(0)} KB`);

/* ---------------------------------------------------- 1. dead actions ---- */

const acts = new Set();
for (const m of src.matchAll(/data-act=["']([a-zA-Z0-9_-]+)["']/g)) acts.add(m[1]);
const handled = new Set();
for (const m of src.matchAll(/a\s*===\s*['"]([a-zA-Z0-9_-]+)['"]/g)) handled.add(m[1]);
for (const m of src.matchAll(/case\s+['"]([a-zA-Z0-9_-]+)['"]/g)) handled.add(m[1]);
const deadActs = [...acts].filter((a) => !handled.has(a)).sort();
check('every rendered data-act has a handler', deadActs.length === 0,
  deadActs.length ? `unhandled: ${deadActs.join(', ')}` : `${acts.size} actions, all handled`);

/* ------------------------------------------------- 2. unread attributes -- */

const attrs = new Set();
for (const m of src.matchAll(/\sdata-([a-z0-9-]+)=/g)) attrs.add(m[1]);
const readAttrs = new Set();
for (const m of src.matchAll(/dataset\.([a-zA-Z0-9_]+)/g)) readAttrs.add(dash(m[1]));
for (const m of src.matchAll(/getAttribute\(\s*['"]data-([a-z0-9-]+)['"]/g)) readAttrs.add(m[1]);
for (const m of src.matchAll(/\[data-([a-z0-9-]+)[\]=]/g)) readAttrs.add(m[1]);
for (const m of src.matchAll(/\.attr\(\s*['"]([a-z0-9-]+)['"]/g)) readAttrs.add(m[1]);
function dash(s) { return s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()); }
const unread = [...attrs].filter((a) => !readAttrs.has(a)).sort();
check('every rendered data-* attribute is read somewhere', unread.length === 0,
  unread.length ? `never read: ${unread.join(', ')}` : `${attrs.size} attributes, all read`);

/* ---------------------------------------------- 3. called but undeclared -- */

/* Anything the host provides, or that is a method call rather than a function
   call, is not our problem. The point is to catch `someButton()` where
   `someButton` was never written — which is exactly the bug this found. */
const BUILTIN = new Set(('' + `
  if for while switch catch return typeof new delete void await async function const let var
  Math JSON Date String Number Boolean Array Object Promise Set Map Error RegExp parseInt
  parseFloat isNaN isFinite encodeURIComponent decodeURIComponent setTimeout setInterval
  clearTimeout clearInterval fetch alert confirm prompt toast esc money cm cust opp can
  requestAnimationFrame structuredClone atob btoa console Symbol BigInt Intl URL Blob
  File FormData Intl setTimeout queueMicrotask crypto performance require import export
  calc translateX translateY translateZ rotate scale rgba rgb var min max clamp
  FileReader File FileList DataTransfer URLSearchParams AbortController Headers Request
  Response TextDecoder TextEncoder MutationObserver IntersectionObserver ResizeObserver
`).split(/\s+/).filter(Boolean));

/* English words that sit next to a bracket inside prose ("3 days ago (12 Sep)").
   The string-stripper handles nesting heuristically and can leak these. They
   are listed here rather than weakening the check: a name that is really a
   missing function is never a common English word. */
const PROSE = new Set(['ago', 'url', 'and', 'or', 'the', 'with', 'from', 'into']);

const declared = new Set();
for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) declared.add(m[1]);
for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function/g)) declared.add(m[1]);
/* Named function arguments: they are declared, just not at the top level. */
for (const m of src.matchAll(/\(([^()]{0,200})\)\s*=>/g)) {
  for (const p of m[1].split(',')) {
    const n = p.trim().split('=')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n);
  }
}

/* Only look at CODE. Prose like "Billing (BSCS)" or "Confirm (or dismiss)"
   matches a call shape and drowned the real findings, so string literals are
   removed first — keeping the `${…}` parts of template strings, which are code. */
function stripStrings(s) {
  let out = '';
  let i = 0;
  const blank = (n) => { out += ' '.repeat(n); };
  while (i < s.length) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') {
      const start = i;
      while (i < s.length && s[i] !== '\n') i++;
      blank(i - start); continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const start = i;
      i = s.indexOf('*/', i + 2);
      i = i < 0 ? s.length : i + 2;
      blank(i - start); continue;
    }
    if (c === '"' || c === "'") {
      const q = c, start = i; i++;
      while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
      i++;
      blank(i - start); continue;
    }
    if (c === '`') {
      out += ' '; i++;                       /* the opening backtick */
      /* Templates nest: a `${}` can hold another template, whose own text is
         literal again. Track the enclosing interpolation depth on a stack.

         Two things inside `${…}` need their own handling or the depth lies:
           — balanced braces. An object or block `}` inside the interpolation
             is not the interpolation's `}`. `${factRows(x ? y : [{ t: z }])}`
             used to close the interpolation at the first object's `}`: depth
             hit 0 early, the NEXT nested template's opening backtick was then
             read as the outer template's closing one, and everything after it
             leaked into the scan surface as if it were plain code — which is
             how "open action(s)" prose became an `action(` ghost. So `}` only
             ends the interpolation when the brace counter is back to zero.
           — strings and comments. A quote inside `${…}` starts a string
             literal, kept verbatim — the ghost scan has always seen those and
             its PROSE list is tuned for them. `//` and `/* … * /` inside
             `${…}` are comments like any other and are blanked, because a
             comment is not code and "the local nextStep() this replaced"
             prose inside one is not a call. */
      const stack = [];
      let depth = 0;
      let brace = 0;
      while (i < s.length) {
        if (depth > 0 && s[i] === '/' && s[i + 1] === '/') {
          const start = i;
          while (i < s.length && s[i] !== '\n') i++;
          blank(i - start); continue;
        }
        if (depth > 0 && s[i] === '/' && s[i + 1] === '*') {
          const start = i;
          i = s.indexOf('*/', i + 2);
          i = i < 0 ? s.length : i + 2;
          blank(i - start); continue;
        }
        if (depth > 0 && (s[i] === '"' || s[i] === "'")) {
          const q = s[i], start = i; i++;
          while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
          i++;
          out += s.slice(start, i); continue;
        }
        if (s[i] === '\\') { out += '  '; i += 2; continue; }
        if (s[i] === '$' && s[i + 1] === '{') { depth++; out += '  '; i += 2; continue; }
        if (s[i] === '{' && depth > 0) { brace++; out += '{'; i++; continue; }
        if (s[i] === '}') {
          if (depth > 0 && brace > 0) { brace--; out += '}'; i++; continue; }
          if (depth > 0) { depth--; out += ' '; i++; continue; }
          out += ' '; i++; continue;         /* a } in literal text */
        }
        if (s[i] === '`') {
          out += ' '; i++;
          if (depth > 0) { stack.push({ depth, brace }); depth = 0; brace = 0; continue; }
          if (stack.length) { ({ depth, brace } = stack.pop()); continue; }
          break;
        }
        out += depth > 0 ? s[i] : ' ';       /* only ${…} is code */
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}
const code = stripStrings(src);

const called = new Map();
for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]{2,})\s*\(/g)) {
  const name = m[2];
  if (BUILTIN.has(name) || declared.has(name) || PROSE.has(name)) continue;
  const ctx = code.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ').trim();
  const prev = called.get(name) || { n: 0, ctx };
  prev.n++;
  called.set(name, prev);
}
const ghosts = [...called.entries()].sort((a, b) => a[0].localeCompare(b[0]));
check('every function called is declared', ghosts.length === 0,
  ghosts.length
    ? ghosts.map(([n, v]) => `\n        ${n} — …${v.ctx}…`).join('')
    : `${declared.size} declarations, no orphans`);

/* --------------------------------------------------- 4. literal "today" -- */

/* A date written into the source is a date that stops being true. It is the
   quietest possible bug: nothing errors, every record is just wrong. */
const todayIsh = [];
for (const m of src.matchAll(/['"](\d{4}-\d{2}-\d{2})['"]/g)) todayIsh.push(m[1]);
const years = [...new Set(todayIsh.map((d) => d.slice(0, 4)))].sort();
check('no hardcoded calendar date is used as "now"',
  !/\bTODAY\b\s*=/.test(src) && !/const\s+TODAY/.test(src),
  years.length ? `literal dates present: ${years.join(', ')} — allowed only as seed history, never as today` : 'none');

/* ------------------------------------------------- 5. inline onclick ----- */
/* One dispatcher is easier to keep honest than handlers scattered through
   templates. `onclick="event.stopPropagation()"` is allowed: a link inside a
   clickable card has to stop the click reaching the card, and that is a
   property of the markup, not application logic. */
const inline = [...html.matchAll(/\son(?:click|change|input|submit)=["']([^"']*)["']/g)]
  .map((m) => m[1])
  .filter((v) => !/^\s*event\.stopPropagation\(\)\s*$/.test(v));
check('no inline handlers carrying app logic', inline.length === 0,
  inline.length ? inline.map((v) => v.slice(0, 60)).join(' | ') : 'only stopPropagation, which is markup');

/* --------------------------------------- 6. a CSS class defined twice ----- */

/* Two rules, one name: the second silently wins for every property it sets.
   There is no error for this, and it is exactly how `.pchip` — a three-line
   row — became a pill with 5px of vertical padding, so every field in the
   lookup sheet read as wording spilling out of its box.

   Only bare single-class rules count (`.x{`), and only outside `@media`:
   a responsive override of the same class is a legitimate second definition,
   a second definition at the top level is a collision. */
function outsideAtRules(css) {
  let out = '', i = 0;
  while (i < css.length) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const e = css.indexOf('*/', i + 2); i = e < 0 ? css.length : e + 2; continue;
    }
    if (css[i] === '@') {
      let j = i;
      while (j < css.length && css[j] !== '{' && css[j] !== ';') j++;
      if (css[j] === ';') { i = j + 1; continue; }
      let d = 0;
      for (; j < css.length; j++) {
        if (css[j] === '{') d++;
        else if (css[j] === '}') { d--; if (d === 0) { j++; break; } }
      }
      out += '\n'; i = j; continue;
    }
    out += css[i]; i++;
  }
  return out;
}
const cssText = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
const seenClass = new Map();
for (const m of outsideAtRules(cssText).matchAll(/^[ \t]*(\.[A-Za-z][\w-]*)[ \t]*\{/gm)) {
  seenClass.set(m[1], (seenClass.get(m[1]) || 0) + 1);
}
const dupes = [...seenClass.entries()].filter(([, n]) => n > 1).map(([c, n]) => `${c} ×${n}`).sort();
check('no CSS class is defined twice at the top level', dupes.length === 0,
  dupes.length ? dupes.join(', ') : `${seenClass.size} classes, each defined once`);

/* Two functions, one name. The later declaration wins, silently — no error,
   no warning, and every call site gets the wrong one. This shipped: `teamCard`
   named both the card listing one customer's team and the company roster on
   the Admin screen, so every customer page quietly drew the roster instead,
   and the team card was never drawn at all. */
const fnSeen = new Map();
for (const m of src.matchAll(/^[ \t]*function[ \t]+([A-Za-z_$][\w$]*)[ \t]*\(/gm)) {
  fnSeen.set(m[1], (fnSeen.get(m[1]) || 0) + 1);
}
const fnDupes = [...fnSeen.entries()].filter(([, n]) => n > 1).map(([f, n]) => `${f} ×${n}`).sort();
check('no function is declared twice at the top level', fnDupes.length === 0,
  fnDupes.length ? fnDupes.join(', ') : `${fnSeen.size} functions, each declared once`);

/* --------------------------------------- 7. an edit form missing a field -- */

/* `edForm` renders the fields of EDIT_SPEC and pre-fills them from the row;
   `saveEdit` writes every field back unconditionally. A call site that passes
   fewer values than its kind has fields renders the missing ones BLANK, and
   saving erases real data. This shipped three ways: a person's email and
   phone, a meeting's type, and an opportunity's close date / competitor /
   description when edited from the pipeline card. Mechanical rule: every
   `edForm(` call passes exactly as many values as its kind declares. */
const specSrc = (src.match(/const EDIT_SPEC = \{([\s\S]*?)\n\};/) || [])[1] || '';
const specSizes = {};
for (const m of specSrc.matchAll(/^  (\w+): \[([\s\S]*?)^  \]/gm)) {
  specSizes[m[1]] = (m[2].match(/\{ k:'ed/g) || []).length;
}
check('EDIT_SPEC kinds were parsed for the form check', Object.keys(specSizes).length >= 6,
  Object.entries(specSizes).map(([k, n]) => `${k}:${n}`).join(' '));

/* Scan a balanced `(...)` group that opens at index i. */
function balancedArgs(s, i) {
  let d = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '(') d++;
    else if (c === ')') { d--; if (d === 0) return s.slice(i + 1, j); }
  }
  return '';
}
/* Top-level comma count of the first `[…]` group in the args (the vals array).
   A one-element array has no comma — that is 1 value, not a parse failure. */
function valCount(args) {
  const open = args.indexOf('[');
  if (open < 0) return -1;
  let d = 0, p = 0, items = 1, inner = false;
  for (let j = open; j < args.length; j++) {
    const c = args[j];
    if (c === '[') { d++; continue; }
    if (c === ']') { d--; if (d === 0) return inner ? items : 0; continue; }
    if (d === 1) {
      if (c === '(') p++;
      else if (c === ')') p--;
      else if (c === ',' && p === 0) items++;
      else if (!/\s/.test(c)) inner = true;
    }
  }
  return -1;
}
/* The vals argument may now be an object keyed by field id — `{ ed1: … }` —
   which is the shape that cannot drift when a field moves. Counting it is a
   STRONGER check than counting an array, because the keys can be compared
   against the ids the spec actually declares: an array with the right length
   and the wrong order still passes the old rule, and a keyed object with a
   key the spec does not have is caught here and nowhere else.
   Returns `null` when the argument is not an object literal at all. */
function keyedVals(args) {
  let d = 0, start = -1, end = -1;
  for (let j = 0; j < args.length; j++) {
    const c = args[j];
    if (c === '(' || c === '[') d++;
    else if (c === ')' || c === ']') d--;
    else if (c === '{' && d === 0) { start = j; break; }
  }
  if (start < 0) return null;
  /* Walk to the brace that closes this one. It is not always present: these
     calls sit inside `${}` of a template literal, and the analyser runs on
     source whose strings AND template text have been blanked — which takes
     the closing brace with it. So an unterminated object is read to the end
     of the slice, which is exactly where its remaining keys are. */
  for (let j = start + 1; j < args.length; j++) {
    const c = args[j];
    if (c === '{' || c === '(' || c === '[') d++;
    else if (c === '}' || c === ')' || c === ']') {
      if (c === '}' && d === 0) { end = j; break; }
      d--;
    }
  }
  const body = args.slice(start + 1, end < 0 ? args.length : end);
  const keys = [];
  for (const m of body.matchAll(/(?:^|[,{\s])(\w+)\s*:/g)) keys.push(m[1]);
  return keys;
}
/* The field ids an EDIT_SPEC kind declares, in order. */
const specKeys = {};
for (const m of specSrc.matchAll(/^  (\w+): \[([\s\S]*?)^  \]/gm)) {
  specKeys[m[1]] = [...m[2].matchAll(/\{ k:'(\w+)'/g)].map((x) => x[1]);
}
function kindOf(firstArg) {
  const lit = firstArg.match(/^\s*['"](\w+)\|/);
  if (lit) return lit[1];
  const rk = firstArg.match(/^\s*rmKey\.(\w+)\s*\(/);
  if (rk) return rk[1];
  return null;
}
const formBad = [];
let formSites = 0;
for (const m of code.matchAll(/edForm\s*\(/g)) {
  const args = balancedArgs(code, m.index + m[0].length - 1);
  const topComma = (() => {   /* first comma at depth 0 of the args = first/second arg boundary */
    let d = 0;
    for (let j = 0; j < args.length; j++) {
      const c = args[j];
      if (c === '(' || c === '[') d++;
      else if (c === ')' || c === ']') d--;
      else if (c === ',' && d === 0) return j;
    }
    return -1;
  })();
  if (topComma < 0) continue;
  const kind = kindOf(args.slice(0, topComma));
  if (!kind || specSizes[kind] === undefined) continue;   // kind not resolvable statically
  formSites++;
  const valsArg = args.slice(topComma + 1);
  /* A call site may hand the values over through a helper that builds the
     object once — `edForm(k, oppFormValues(o))` — because the same values are
     needed at more than one site and two hand-written copies drift apart. Such
     a helper is resolved to its `return { … }` literal so the check still sees
     real keys. Skipping it instead would quietly drop the strongest assertion
     in this file, which is the failure mode this whole script exists to catch. */
  const helper = (valsArg.trim().match(/^(\w+)\s*\(/) || [])[1];
  if (helper && !keyedVals(valsArg)) {
    /* Read the helper from the RAW source, not `code`. This function sits below
       a block of template literals, and `stripStrings` blanks template text —
       which takes the helper's body with it, leaving nothing to parse. The
       `toast` check below reads raw for the same reason. */
    const hsrc = (src.match(new RegExp(`function ${helper}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`)) || [])[1];
    if (hsrc) {
      const ret = (hsrc.match(/return\s*\{([\s\S]*?)\n\s*\};/) || [])[1];
      if (ret) {
        const keys = [...ret.matchAll(/(?:^|\n)\s*(\w+)\s*:/g)].map((m) => m[1]);
        const want = specKeys[kind] || [];
        const missing = want.filter((k) => !keys.includes(k));
        const extra = keys.filter((k) => !want.includes(k));
        if (missing.length || extra.length) {
          formBad.push(`${kind}: ${helper}() is missing [${missing.join(',')}] and invents [${extra.join(',')}]`);
        }
        continue;
      }
    }
  }
  const keys = keyedVals(valsArg);
  if (keys) {
    const want = specKeys[kind] || [];
    /* Every field the spec declares must be given a value, or the form draws
       an empty box where a saved value exists and Save writes the blank back
       over it. Extra keys are equally wrong: they name fields that do not
       exist, so their value reaches nothing at all. */
    const missing = want.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !want.includes(k));
    if (missing.length || extra.length) {
      formBad.push(`${kind}: keyed form is missing [${missing.join(',')}] and invents [${extra.join(',')}]`);
    }
    continue;
  }
  const n = valCount(valsArg);
  if (n !== specSizes[kind]) formBad.push(`${kind}: ${n} values for ${specSizes[kind]} fields`);
}
check('every edit form renders every field its save writes', formBad.length === 0,
  formBad.length ? formBad.join(' · ') : `${formSites} edit forms, all complete`);

/* ------------------------------------------- 5. an offer with no action ---
   `toast(msg, act)` drew a button — "Undo", on two screens — and nothing ever
   answered the click: the element is built, shown for four seconds and
   dropped. The offer was on screen and the action did not exist, which is
   precisely the thing this file exists to catch, and precisely the thing the
   four checks above could not see because the button carries no `data-act`.
   `toast` takes one argument now, so a second one is a promise the app cannot
   keep — and this fails the moment somebody hands it one again.
   Scanning the raw source, not `code`: the whole point is to see the literal. */
function topCommaAware(s) {
  let d = 0, q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d--;
    else if (c === ',' && d === 0) return i;
  }
  return -1;
}
const toastBad = [];
let toastSites = 0;
src.split('\n').forEach((line, i) => {
  const m = line.match(/\btoast\s*\((.*)\)\s*;?\s*$/);
  if (!m) return;
  toastSites++;
  const at = topCommaAware(m[1]);
  if (at < 0) return;
  const rest = m[1].slice(at + 1).trim();
  /* A literal label is a promise; a variable that happens to be undefined
     is only untidy, so only the literal fails. */
  if (/^(['"`])/.test(rest)) toastBad.push(`line ${i + 1}: ${rest.slice(0, 36)}`);
});
check('a toast never draws an action it cannot perform', toastBad.length === 0,
  toastBad.length ? toastBad.join(' · ') : `${toastSites} toasts, none promising an action`);

/* --------------------------------------- 6. shapes and edges stay on the tokens ---
   The radius ladder and the chip borders are the two places where a bare
   pixel or a hex quietly walks back into the system. The worst case is a
   value that LOOKS like its token twin (a #F2C6C9 beside --risk-100): it
   passes every eyeball, and then the token changes and the twin does not.
   Radii that are shapes rather than sizes are exempt on purpose: the 50%
   circle, the 999px pill, sub-5px hairline rounds, compound corners that
   begin with 0, and radii computed FROM the size of the thing they round
   (the logo() helper) — a token per literal is its own kind of noise. */
const radii = [...html.matchAll(/border-radius:\s*([^;}"']+)/g)].map((m) => m[1].trim());
const looseRadii = radii.filter((v) => !/^var\(/.test(v) && !/\$\{/.test(v)
  && !/^(0|50%|999px|[1-4]px)(\s|$)/.test(v) && !/^0\s/.test(v));
check('every radius that sizes a panel or control comes from a token', looseRadii.length === 0,
  looseRadii.length ? `bare radii: ${[...new Set(looseRadii)].slice(0, 8).join(', ')}`
    : `${radii.length} radii, all token or shape`);
/* Chip borders are checked rule by rule, not by hunting hexes: the tokens
   themselves define those hexes, and a check that cannot tell a definition
   from a use would be red forever. */
const chipRules = [...html.matchAll(/\.t-[a-z]+\{[^}]*\}/g)].map((m) => m[0]);
const looseBorders = chipRules.filter((r) => /border-color:\s*#/.test(r));
check('chip borders are token values, not near-token hex twins', looseBorders.length === 0,
  looseBorders.length ? looseBorders[0].slice(0, 70) : `${chipRules.length} chips, borders on var(--*-100)`);
check('no style reads a token that was never defined', !/var\(--bg-1\b/.test(html),
  /var\(--bg-1\b/.test(html) ? 'var(--bg-1…) is still referenced' : 'every var() has a definition');

/* --------------------------------------------- 7. the page carries its own type ---
   The fonts came from a CDN, which means the one thing the product is —
   a single file that works wherever it is opened — was quietly false the
   moment the network was gone: every heading fell to Helvetica and the
   wordmark to the browser default. The face files are embedded now, and
   this keeps them embedded: no stylesheet request to a domain that may not
   answer, and one data-URI face per family-and-weight the tokens name. */
const cdnFontRefs = (html.match(/fonts\.(googleapis|gstatic)\.com/g) || []);
check('no font is fetched from a domain that may not answer', cdnFontRefs.length === 0,
  cdnFontRefs.length ? `${cdnFontRefs.length} CDN font reference(s) remain` : 'type ships inside the file');
const embeddedFaces = (html.match(/data:font\/woff2;base64,/g) || []).length;
check('every family the tokens name has an embedded face', embeddedFaces >= 4,
  `${embeddedFaces} embedded woff2 face(s)`);

/* --------------------------------------- 8. a card's density is named, not inline ---
   K2: the Customers card set its padding in a style attribute, so the one
   number that decides how dense a list reads was invisible to the
   stylesheet and different from its neighbours by memory alone. The step
   rows in "What needs you" hid theirs the same way, so they were collected
   into the same net rather than given an exemption.
   K3: an empty Insights card used to be a full-size card with a hairline
   through the middle of nothing — sixty percent blank, standing exactly as
   tall as the card beside it that had something to say. */
const cardRowDef = /\.card--row\{[^}]*\}/.exec(html)?.[0] || '';
const stepRowDef = /\.step-row\{[^}]*\}/.exec(html)?.[0] || '';
check('list-card density is a class, not a style attribute',
  !/style="[^"]*padding:13px/.test(html)
    && /padding:13px var\(--s4\)/.test(cardRowDef)
    && /class="card card--row/.test(html)
    && /padding:13px var\(--s5\)/.test(stepRowDef)
    && /class="row step-row/.test(html),
  stepRowDef ? cardRowDef.slice(0, 46) + ' · ' + stepRowDef.slice(0, 42) : '.card--row / .step-row are not defined');
const pchipPad = /\.pchip\{[^}]*padding:([^;]+);/.exec(html)?.[1] || '';
const oppPad = /\.opp\{[^}]*padding:([^;]+);/.exec(html)?.[1] || '';
check('the row cards share one density band (12–13px)', /^1[23]px/.test(pchipPad) && /^1[23]px/.test(oppPad),
  `.pchip ${pchipPad} · .opp ${oppPad}`);
const noneBody = /const none = \(tag, cls, what\) =>([\s\S]*?\n\s*`)/.exec(src)?.[1] || '';
check('the empty insight is two lines, not a full card with a line through it',
  noneBody.includes('card--recessed') && !/class="hr"/.test(noneBody) && !noneBody.includes('Nothing here'),
  noneBody ? 'compact and recessed' : 'the none() helper was not found');
check('a quiet insight may stand shorter than a loud one',
  /grid g3" style="[^"]*align-items:start/.test(html),
  'the six-card grid starts its rows at the top');

/* --------------------------------------- 9. the bar keeps its three jobs ---
   L1: "Quick tour" sat in the top bar as a permanent button — spending the
   scarcest pixels in the product on an action you take once, then only
   occasionally. The bar is left to its three jobs (ask, status, identity);
   the tour lives on a corner float, and its menu opens upward from there,
   because below a bottom-corner button there is no room left. */
const topBar = /<header class="top">[\s\S]*?<\/header>/.exec(html)?.[0] || '';
const fabDef = /\.tour-fab\{[^}]*\}/.exec(html)?.[0] || '';
check('the top bar spends its pixels on ask, status and identity — not on the tour',
  topBar.includes('id="cmdOpen"') && topBar.includes('id="meAv"')
    && !topBar.includes('tourOpen')
    && /class="tour-fab" id="tourOpen"/.test(html)
    && fabDef.includes('position:fixed') && fabDef.includes('border-radius:50%'),
  topBar.includes('tourOpen') ? 'the tour button is still in the top bar' : 'the tour is a corner float');
const anchorSrc = /function anchorTourMenu\(\)\{[\s\S]*?\n\}/.exec(src)?.[0] || '';
check('the tour menu opens upward from the corner float',
  /let top = Math\.round\(r\.top\s*-\s*h/.test(anchorSrc),
  anchorSrc ? 'the menu is anchored above the float' : 'anchorTourMenu was not found');

console.log(`\n${ran} checks run.${bad ? '  *** FAILURES ***' : '  all passed'}`);
process.exit(bad ? 1 : 0);
