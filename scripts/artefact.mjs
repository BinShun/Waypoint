/**
 * Stage `Waypoint-v1.html` into `dist/` for a deploy.
 *
 * There is exactly ONE app in this repository and one source file for it:
 * `Waypoint-v1.html`, hand-written, no build step. The only thing this script
 * does is copy that file to `dist/index.html`, which is what a deploy uploads
 * and what the server serves. Nothing here transforms the file — if the copy
 * is wrong, the source is wrong.
 *
 * Run from customer-workbench/:  npm run artefact
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'Waypoint-v1.html');

if (!existsSync(SRC)) {
  console.error('[artefact] ✘ Waypoint-v1.html is missing — nothing to stage');
  process.exit(1);
}
const html = readFileSync(SRC, 'utf8');

/* Sanity, not transformation: the shipped app is hand-written and carries its
   sign-in screen. If either check fails, the source has been replaced by a
   build output and staging it would ship the wrong product. */
if (/createRoot/.test(html)) {
  console.error('[artefact] ✘ Waypoint-v1.html looks like a build output — refusing to stage');
  process.exit(1);
}
if (!/Look around/i.test(html)) {
  console.error('[artefact] ✘ Waypoint-v1.html is missing the sign-in screen — refusing to stage');
  process.exit(1);
}

mkdirSync(join(ROOT, 'dist'), { recursive: true });
writeFileSync(join(ROOT, 'dist', 'index.html'), html, 'utf8');
console.log(`[artefact] ✔ dist/index.html  (${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)} KB) staged from Waypoint-v1.html`);
