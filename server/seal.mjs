/**
 * Encryption at rest — the one place the file format is defined.
 *
 * One JSON file is the whole workspace, so "encrypted at rest" has to mean the
 * file itself is unreadable without a key — not merely that it sits on an
 * encrypted disk. This is AES-256-GCM over the whole document.
 *
 * The key comes from `WB_DATA_KEY` ONLY. Nothing is written next to the data on
 * purpose: a key file sitting beside the file it unlocks protects you from a
 * stolen backup and from nothing else, and it turns "the disk died" into "the
 * data is gone" for anyone who did not back the key up separately. In the cloud
 * the value comes from Secrets Manager; on a laptop it comes from the OS
 * keychain or your password manager.
 *
 * Unset  -> the file is stored as plain JSON, exactly as before, and the server
 *          says so out loud at start-up.
 * Set    -> the file is encrypted; an existing plain file is encrypted on the
 *          first save, so this is not a migration step.
 * WB_REQUIRE_ENCRYPTION=1 -> refuse to start without a key. Set this in
 *          production so a missing env var cannot quietly mean "unencrypted".
 *
 * It lives in its own module, with no imports from the server, because the test
 * suites read the file too. Nine of them used to call `JSON.parse(readFileSync
 * (…))`, which is a plain-text assumption written into the harness: the moment
 * encryption is switched on they crash, and "all suites green" quietly stops
 * describing the configuration that actually ships. They import this instead,
 * so a test can never drift from the format the server writes.
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

export const ENC_PREFIX = 'WBENC1.';
export const KEY_BYTES = 32;

let KEY_CACHE;
/** The key from the environment, or null when none is set. */
export function dataKey() {
  if (KEY_CACHE !== undefined) return KEY_CACHE;
  const raw = process.env.WB_DATA_KEY;
  if (!raw) { KEY_CACHE = null; return null; }
  let k = Buffer.from(String(raw).trim(), 'base64');
  if (k.length !== KEY_BYTES) k = Buffer.from(String(raw).trim(), 'hex');
  if (k.length !== KEY_BYTES) {
    console.error(
      `\nWB_DATA_KEY must be ${KEY_BYTES} bytes (base64 or hex) - got ${k.length}.\n` +
      `Make one with:  openssl rand -base64 32\n`,
    );
    process.exit(1);
  }
  KEY_CACHE = k;
  return k;
}

export function seal(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function open(sealed, key) {
  if (sealed.length < 28) throw new Error('Encrypted file is truncated.');
  const iv = sealed.subarray(0, 12);
  const tag = sealed.subarray(12, 28);
  const body = sealed.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);   // throws on a wrong key
}

export const isSealed = (raw) => String(raw).startsWith(ENC_PREFIX);

/**
 * The workspace as an object, from either format.
 *
 * A plain file is still accepted so that switching the key on does not orphan a
 * workspace that was saved before it. The reverse is never allowed — an
 * encrypted file will not fall back to plain text just because the key went
 * missing, because that would turn a lost env var into silently unencrypted
 * customer data.
 */
export function parseWorkspace(raw) {
  if (!String(raw).trim()) return null;
  if (!isSealed(raw)) return JSON.parse(raw);
  const key = dataKey();
  if (!key) {
    throw new Error(
      `the workspace file is encrypted but WB_DATA_KEY is not set. ` +
      `Read it with the same key that wrote it.`,
    );
  }
  try {
    return JSON.parse(open(Buffer.from(String(raw).slice(ENC_PREFIX.length), 'base64'), key).toString('utf8'));
  } catch (e) {
    /* GCM says "unable to authenticate data", which is true and useless. The
       usual cause is the wrong key — a lost env var, not a corrupt file — and
       saying so is the whole difference between a five-minute fix and a panic. */
    throw new Error(
      `Could not decrypt the workspace file: ${e.message}. ` +
      `Almost always this means WB_DATA_KEY is not the key that wrote it.`,
    );
  }
}

/** The same thing straight off the disk. Used by the server and by the suites. */
export function readWorkspaceFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return parseWorkspace(raw);
}
