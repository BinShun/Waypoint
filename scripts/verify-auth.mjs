/**
 * One identity for every verification suite.
 *
 * WHY THIS EXISTS
 * ---------------
 * The anonymous setup window used to be "nobody has a password yet", which
 * meant a suite could seed a workspace and then keep writing to it as nobody
 * at all. Tightening that window (P0-2) closed it: once the book holds rows,
 * every read and write needs a signed-in account. Six suites had been leaning
 * on the window and went red — not because the app broke, but because they
 * were driving it as a user that no longer exists.
 *
 * So the suites now sign in. This module is the shared half of that: the one
 * administrator every throwaway workspace is seeded with, and one `signIn`
 * that returns the cookie the suite then sends on every request.
 *
 * It deliberately does NOT relax the server (`WB_OPEN=1`) — a suite that runs
 * against a configuration production never uses is a suite that proves nothing
 * about the guards this project actually ships.
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto';

export const ADMIN = {
  id: 'u_teh',
  name: 'Teh Bin Shun',
  email: 'tehbinshun@global.tencent.com',
  role: 'admin',
  title: 'Senior Solution Architect',
};

export const ADMIN_PASS = 'Waypoint#2026';

/** The same derivation as the server's verifyPassword: pbkdf2-sha256,
    16-byte salt, 32-byte key, 150k iterations, base64. */
export function credentialFor(userId, password = ADMIN_PASS) {
  const salt = randomBytes(16);
  return {
    userId,
    algo: 'pbkdf2-sha256',
    iterations: 150_000,
    salt: salt.toString('base64'),
    hash: pbkdf2Sync(password, salt, 150_000, 32, 'sha256').toString('base64'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** `users` + `credentials` + the setup log, ready to spread into a seed. */
export function adminSeed() {
  const at = new Date().toISOString();
  return {
    users: [{
      id: ADMIN.id, name: ADMIN.name, email: ADMIN.email, role: ADMIN.role,
      title: ADMIN.title, locked: false, createdAt: at, updatedAt: at,
    }],
    credentials: { [ADMIN.id]: credentialFor(ADMIN.id) },
    logs: [{
      id: 'l_seed', at, action: 'create', entityType: 'auth',
      entityId: ADMIN.id, summary: 'Workspace created for Waypoint',
    }],
  };
}

/**
 * Sign in and hand back the cookie header value, or `''` on failure.
 * The workspace must already exist on disk; call this after the first seed.
 */
export async function signIn(base, { password = ADMIN_PASS, userId = ADMIN.id } = {}) {
  try {
    const res = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ userId, password }),
    });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    return { ok: res.ok, status: res.status, cookie: set.map((s) => s.split(';')[0]).join('; ') };
  } catch (e) {
    return { ok: false, status: 0, cookie: '', error: e.message };
  }
}

/** Build a `fetch`-shaped helper that always carries the cookie. */
export function authed(base, jar) {
  return (path, init = {}) => fetch(base + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Origin: base,
      ...(jar.v ? { cookie: jar.v } : {}),
      ...(init.headers || {}),
    },
  });
}
