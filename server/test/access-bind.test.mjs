import './isolate.mjs';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { removeTree, tempDir } from './teardown.mjs';

/**
 * Where the board listens and who it lets in, against the real `index.js`.
 *
 * `access.test.mjs` builds its own express app on 127.0.0.1, so it cannot see the
 * listen address. Here the board runs as a child process (importing it starts the
 * server) with its own config and data dir, and is reached through one of this
 * machine's own non-loopback IPv4 addresses, which is what a client on the LAN does.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const TOKEN = 'secreto-de-bind';

const lanAddress = Object.values(networkInterfaces()).flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
const SKIP = lanAddress ? false : 'no non-loopback IPv4 address on this machine';

const dirs = [];
const children = [];

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

/** Boots the board with or without `access.token`; resolves once 127.0.0.1 answers. */
async function startBoard(token) {
  const dir = tempDir('hfsmon-bind-');
  dirs.push(dir);
  const dataDir = path.join(dir, 'data');
  const port = await freePort();
  const configFile = path.join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    port,
    github: { repo: 'nobody/nothing-at-all', assignee: 'nobody', reviewer: 'nobody' },
    poll: { intervalSeconds: 36000 },
    project: { repoPath: dir, worktreeRoot: `${dir}-wt` },
    limits: { defaultMaxActiveTasks: 1, maxActiveTasksCeiling: 2, maxFixIterations: 1, completedShown: 5 },
    claude: { chatModel: 'sonnet', available: ['sonnet'] },
    ...(token === undefined ? {} : { access: { token, trustedTailscaleUsers: [] } }),
  }));

  const child = spawn(process.execPath, [path.join('server', 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      HFSMON_CONFIG: configFile,
      HFSMON_DATA_DIR: dataDir,
      HFSMON_NO_AUTOSTART: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const log = [];
  child.stdout.on('data', (b) => log.push(String(b)));
  child.stderr.on('data', (b) => log.push(String(b)));
  child.once('exit', (code) => log.push(`[exit ${code}]`));

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/tasks`)).status === 200) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`the board did not start:\n${log.join('')}`);
    await new Promise((r) => { setTimeout(r, 150); });
  }
  return { child, port, output: () => log.join('') };
}

async function stopBoard(board) {
  if (board.child.exitCode === null) {
    board.child.kill();
    await new Promise((r) => board.child.once('exit', r));
  }
}

/** Close code of a WebSocket to `url`, or 'open' when it connected and stayed up. */
const socketOutcome = (url) => new Promise((resolve) => {
  const ws = new WebSocket(url);
  const timer = setTimeout(() => { ws.close(); resolve('timeout'); }, 5000);
  let opened = false;
  ws.addEventListener('open', () => {
    opened = true;
    // A refusal arrives as a close right after the upgrade; give it a moment.
    setTimeout(() => { clearTimeout(timer); ws.close(); resolve('open'); }, 500);
  });
  ws.addEventListener('close', (e) => {
    clearTimeout(timer);
    resolve(opened && e.code === 1000 ? 'open' : e.code);
  });
});

after(async () => {
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
  }
  for (const dir of dirs) await removeTree(dir);
});

test('no token: loopback answers, the LAN address refuses the connection, boot message says how to open it', { skip: SKIP }, async () => {
  const board = await startBoard(undefined);
  try {
    const local = await fetch(`http://127.0.0.1:${board.port}/api/tasks`);
    assert.equal(local.status, 200);

    await assert.rejects(
      fetch(`http://${lanAddress}:${board.port}/api/tasks`),
      'no listener on the non-loopback address',
    );

    const line = board.output().split('\n').find((l) => l.startsWith('acceso:')) ?? '';
    assert.match(line, /SIN TOKEN/);
    assert.match(line, /127\.0\.0\.1/);
    assert.match(line, /config\.local\.json/);
  } finally {
    await stopBoard(board);
  }
});

test('token set: the LAN address needs the token over HTTP and WebSocket, localhost stays exempt', { skip: SKIP }, async () => {
  const board = await startBoard(TOKEN);
  try {
    const base = `http://${lanAddress}:${board.port}`;
    assert.equal((await fetch(`${base}/api/tasks`)).status, 401);
    assert.equal((await fetch(`${base}/api/tasks`, { headers: { 'x-hfsmon-token': TOKEN } })).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${board.port}/api/tasks`)).status, 200);

    assert.equal(await socketOutcome(`ws://${lanAddress}:${board.port}/ws`), 4401);
    assert.equal(await socketOutcome(`ws://${lanAddress}:${board.port}/ws?token=${TOKEN}`), 'open');
  } finally {
    await stopBoard(board);
  }
});
