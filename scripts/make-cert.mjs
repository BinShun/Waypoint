/**
 * Make a self-signed certificate so the shared workspace can be served over
 * https.
 *
 * Why bother: colleagues type real customer notes into this, and plain http on
 * an office LAN puts every one of them on the wire in the clear - along with
 * the sign-in password. https also matters for a practical reason: browsers
 * refuse to load a page that mixes https content with an http fetch, so once
 * the app is served over TLS it can no longer talk to an http API at all.
 *
 * This is a SELF-SIGNED certificate, so browsers will warn the first time and
 * somebody has to click "Advanced -> Proceed". That is expected: a certificate
 * authority will not sign a bare LAN address. The encryption is still real,
 * which is the part that matters on a shared network.
 *
 * Run: npm run cert          (then: npm run server:lan)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { networkInterfaces, hostname } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CERT_DIR = join(ROOT, 'certs');
const KEY_FILE = join(CERT_DIR, 'key.pem');
const CERT_FILE = join(CERT_DIR, 'cert.pem');
const DAYS = 825;   // browsers reject anything longer

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return null;
  if (r.status !== 0) return String(r.stderr ?? '');
  return String(r.stdout ?? '');
}

const addrs = lanAddresses();
if (!addrs.length) {
  console.log('No LAN address found. Connect to the office network and run this again.');
  process.exit(1);
}

const which = sh('which', ['openssl']);
if (which === null || !which.includes('openssl')) {
  console.log('openssl was not found. It ships with macOS - is /usr/bin on your PATH?');
  process.exit(1);
}

const host = hostname().replace(/\.local$/, '');
const san = [
  'DNS:localhost',
  `DNS:${host}.local`,
  'IP:127.0.0.1',
  ...addrs.map((a) => `IP:${a}`),
].join(',');

if (!existsSync(CERT_DIR)) mkdirSync(CERT_DIR, { recursive: true });

console.log(`Making a certificate for ${host} (${addrs.join(', ')})`);
const err = sh('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', KEY_FILE, '-out', CERT_FILE,
  '-days', String(DAYS),
  '-subj', `/CN=${host}.local/O=Tencent Cloud Malaysia/C=MY`,
  '-addext', `subjectAltName=${san}`,
  '-addext', 'basicConstraints=CA:FALSE',
  '-addext', 'keyUsage=digitalSignature,keyEncipherment',
  '-addext', 'extendedKeyUsage=serverAuth',
]);

if (err) {
  console.log('openssl failed:\n' + err);
  process.exit(1);
}

try { chmodSync(KEY_FILE, 0o600); } catch { /* best effort */ }

/* A short note so whoever finds this folder knows what it is and what to do. */
writeFileSync(join(CERT_DIR, 'README.txt'), `\
Self-signed certificate for the Customer Workbench data server.

  Generated: ${new Date().toISOString()}
  Valid for: ${DAYS} days
  Names:     localhost, ${host}.local, 127.0.0.1, ${addrs.join(', ')}

The server picks these up automatically and serves https. Browsers will show
"Not secure" the first time because no certificate authority signed this - that
is unavoidable for a LAN address. Click Advanced -> Proceed.

To make a new one: npm run cert
To serve:           npm run server:lan
`);

console.log(`\nWritten:\n  ${KEY_FILE}\n  ${CERT_FILE}`);
console.log(`\nNow start the server:\n  npm run server:lan\n`);
console.log('Colleagues open the https address it prints. Their browser will warn once');
console.log('about the self-signed certificate - that is expected.');
