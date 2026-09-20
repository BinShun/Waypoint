#!/usr/bin/env node
/**
 * `npm run dev` - start BOTH the data server and Vite, in one command.
 *
 * Running them separately is the classic way to end up with two different
 * datasets: the browser on :5173 writes nowhere (localStorage only) while the
 * data server on :8787 sits empty. Starting both from here means the app
 * always has somewhere to save.
 *
 * Ctrl+C stops both.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const children = [];
let shuttingDown = false;

function run(name, cmd, args, color) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  children.push(child);
  const tag = `\x1b[${color}m[${name}]\x1b[0m`;
  const pipe = (stream, out) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      lines.forEach((l) => out.write(`${tag} ${l}\n`));
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(`${tag} exited (${code ?? signal}) - stopping everything\n`);
    shutdown(code ?? 1);
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  children.forEach((c) => { if (!c.killed) c.kill('SIGTERM'); });
  setTimeout(() => process.exit(code), 300).unref();
}

process.on('SIGINT', () => { process.stdout.write('\n'); shutdown(0); });
process.on('SIGTERM', () => shutdown(0));

run('data', process.execPath, ['server/server.mjs'], '36');   // cyan
run('web', process.execPath, [path.join('node_modules', 'vite', 'bin', 'vite.js')], '35'); // magenta
