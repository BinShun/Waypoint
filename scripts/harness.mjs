/**
 * Shared test-harness helpers.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every suite in this directory starts a server of its own and then waits for
 * it to answer:
 *
 *     for (let i = 0; i < 60; i++) {
 *       try { if ((await fetch(ORIGIN + '/api/health')).ok) break; } catch {}
 *       await wait(150);
 *     }
 *     check('the server is up', (await fetch(ORIGIN + '/api/health')).ok);
 *
 * That check CANNOT FAIL, and so it does not test what it claims to. If a
 * server from an earlier run is still listening on the fixed port, it answers
 * `/api/health` immediately — the wait exits on the first iteration, the check
 * goes green, and the suite then drives SOMEBODY ELSE'S server, against
 * SOMEBODY ELSE'S data directory. The suite passes or fails for reasons that
 * have nothing to do with the code under test.
 *
 * This is not hypothetical. It hid a real sign-in failure for a whole
 * debugging session: the port was occupied by a server seeded with a different
 * roster, so `verify-newflows` kept signing in against a workspace whose admin
 * was `Aisyah Rahman` while the fixture on disk said `Teh Bin Shun`. The test
 * believed it was talking to its own server the entire time.
 *
 * WHAT IS DONE INSTEAD
 * --------------------
 * The port is claimed BEFORE the spawn. `net.createServer().listen()` either
 * binds or raises `EADDRINUSE`, and no two processes can both be listening on
 * loopback:port at once. So a successful bind is proof the port is free, and
 * the check is released immediately afterwards so the real server can take it.
 * That converts a silent, wrong-process run into a loud, immediate failure
 * with the pid that is in the way.
 *
 * The harness then waits for the CHILD to be the thing answering, by watching
 * the child's own output rather than by asking the network who is there.
 */

import net from 'node:net';
import { execFileSync } from 'node:child_process';

/** Whoever is listening on `port`, for an error message that names names. */
export function portOwner(port) {
  try {
    const out = execFileSync('ss', ['-ltnp'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.split('\n').find((l) => l.includes(':' + port + ' '));
    if (!line) return null;
    const m = /pid=(\d+)/.exec(line);
    if (!m) return 'an unidentified process';
    const pid = m[1];
    let cmd = '';
    try { cmd = execFileSync('ps', ['-o', 'args=', '-p', pid], { encoding: 'utf8' }).trim(); } catch { /* gone */ }
    return `pid ${pid}${cmd ? ' (' + cmd + ')' : ''}`;
  } catch {
    return null;
  }
}

/**
 * Prove `port` is free, then hand it back.
 *
 * A successful bind is the only honest proof: two processes cannot listen on
 * the same loopback port simultaneously, so if this succeeds, whatever was
 * holding the port is gone.
 *
 * @returns {Promise<void>} rejects with an actionable message when occupied.
 */
export function claimPort(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (e) => {
      if (e && e.code === 'EADDRINUSE') {
        const owner = portOwner(port);
        reject(new Error(
          `Port ${port} is already taken${owner ? ' by ' + owner : ''}.\n`
          + `  A test suite would have talked to THAT server instead of its own,\n`
          + `  and passed or failed for reasons unrelated to the code.\n`
          + `  Free it with:  ss -ltnp | grep ":${port}"   then kill the pid shown.`
        ));
      } else {
        reject(e);
      }
    });
    probe.once('listening', () => probe.close(() => resolve()));
    probe.listen(port, '127.0.0.1');
  });
}

/**
 * Start a server on a port this process has proven it owns.
 *
 * Drop-in replacement for the `spawn(...)` line the suites already have.
 * Everything about the child is unchanged apart from the guarantee that the
 * port really was free when it was handed over, and that the child has
 * actually bound it before anything is asked of it.
 *
 * @param {object} opts
 * @param {string} opts.spawnBin      executable (usually `process.execPath`)
 * @param {string[]} opts.args        argv
 * @param {object} opts.env           child environment
 * @param {number} opts.port          the port the child will bind
 * @returns {Promise<import('node:child_process').ChildProcess>}
 */
export async function startServer({ spawnBin, args, env, port }) {
  await claimPort(port);
  const { spawn } = await import('node:child_process');
  const srv = spawn(spawnBin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

  /* The child's own exit is the fastest honest signal that it could not bind:
     a server that dies during startup must not be waited for in silence. */
  let died = null;
  srv.once('exit', (code, sig) => { died = `exited early (code ${code}${sig ? ', ' + sig : ''})`; });

  let ready = false;
  for (let i = 0; i < 200 && !died; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) { ready = true; break; }
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 75));
  }
  if (!ready) {
    try { srv.kill(); } catch { /* already gone */ }
    throw new Error(`The test server never answered on port ${port}${died ? ' — it ' + died : ''}.`);
  }

  /* A suite that exits without reaping its server leaves the port occupied,
     and the NEXT run then fails the claim above — a self-inflicted version of
     the very problem this file exists to prevent. So the child is tied to this
     process and goes when it goes, however it goes.
     `unref` is deliberately NOT used: the child does not keep this process
     alive, but it is not detached from its fate either. */
  const reap = () => { try { srv.kill(); } catch { /* already gone */ } };
  process.once('exit', reap);
  process.once('SIGINT', () => { reap(); process.exit(130); });
  process.once('SIGTERM', () => { reap(); process.exit(143); });
  srv.once('exit', () => {
    process.removeListener('exit', reap);
    process.removeListener('SIGINT', reap);
    process.removeListener('SIGTERM', reap);
  });

  return srv;
}
