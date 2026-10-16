import './isolate.mjs';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { removeTree, tempDir } from './teardown.mjs';

/**
 * `POST /api/poll` (non-blocking, 202) and `POST /api/poll/cancel`,
 * against the real board in its own process (same scaffold as
 * `project-settings-route.test.mjs`).
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
let dir;
let dataDir;
let port;
let child;

const url = (p) => `http://127.0.0.1:${port}${p}`;

async function call(method, p, body) {
  const res = await fetch(url(p), {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port: p } = srv.address();
    srv.close(() => resolve(p));
  });
});

const task = (issue, title) => ({
  issue, title, labels: [], url: `https://example.invalid/${issue}`,
  state: 'assigned', log: [{ ts: '2026-09-30T00:00:00.000Z', phase: 'estado', line: title }], chats: [],
});

const project = (id, base) => ({
  id, name: id, repoPath: base, worktreeRoot: `${base}-wt`,
  repo: null, assignee: 'nobody', overrides: {},
});

before(async () => {
  dir = tempDir('hfsmon-pollroute-');
  dataDir = path.join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const one = path.join(dir, 'one');
  const two = path.join(dir, 'docs');
  mkdirSync(one, { recursive: true });
  mkdirSync(two, { recursive: true });

  writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify({ 5: task(5, 'en hfs') }));
  writeFileSync(path.join(dataDir, 'tasks.docs.json'), JSON.stringify({ 5: task(5, 'en docs') }));
  writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project('hfs', one), project('docs', two)]));

  port = await freePort();
  const configFile = path.join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    port,
    github: { repo: 'nobody/nothing-at-all', assignee: 'nobody' },
    poll: { intervalSeconds: 36000 },
    project: { repoPath: one, worktreeRoot: `${one}-wt` },
    stack: { command: 'npm start' },
    limits: { defaultMaxActiveTasks: 1, maxActiveTasksCeiling: 2, maxFixIterations: 1, completedShown: 5 },
    claude: {
      chatModel: 'sonnet', advisorModel: 'opus', fixModel: 'sonnet',
      available: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }],
    },
  }));

  child = spawn(process.execPath, [path.join('server', 'src', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, HFSMON_CONFIG: configFile, HFSMON_DATA_DIR: dataDir, HFSMON_NO_AUTOSTART: '1',
      GIT_CEILING_DIRECTORIES: [dir, tmpdir()].join(path.delimiter) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (b) => log.push(String(b)));
  child.stderr.on('data', (b) => log.push(String(b)));
  child.once('exit', (code) => log.push(`[exit ${code}]`));

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await call('GET', '/api/tasks')).status === 200) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`el tablero no levantó:\n${log.join('')}`);
    await new Promise((r) => { setTimeout(r, 150); });
  }
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
  await removeTree(dir);
});

test('POST /api/poll answers 202 at once with the status, and the cycle ends with a last result', async () => {
  // The startup cycle may still be running: let it end so this click starts its own.
  for (let i = 0; i < 300; i++) {
    if (!(await call('GET', '/api/tasks')).body?.poll?.running) break;
    await new Promise((r) => { setTimeout(r, 200); });
  }
  const t0 = Date.now();
  const first = await call('POST', '/api/poll');
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  assert.equal(first.body.started, true);
  const p = first.body.poll;
  assert.equal(p.stepCount, 7);
  for (const k of ['lastPollAt', 'running', 'startedAt', 'step', 'stepIndex', 'done', 'total', 'project', 'progressAt', 'cancelling', 'last']) {
    assert.ok(k in p, `missing ${k}`);
  }
  assert.ok(Date.now() - t0 < 5_000);

  // While it runs, a second click joins it instead of starting another.
  const second = await call('POST', '/api/poll');
  assert.equal(second.status, 202);
  // A bodyless click is the scheduled-style cycle: with nothing due it ends at once, so a second
  // click may legitimately start its own; no ordering is asserted.
  assert.equal(typeof second.body.started, 'boolean');

  const deadline = Date.now() + 60_000;
  for (;;) {
    const tasks = await call('GET', '/api/tasks');
    const poll = tasks.body?.poll;
    if (poll && !poll.running && poll.last) {
      assert.equal(poll.cancelling, false);
      assert.equal(poll.step, null);
      assert.equal(typeof poll.last.finishedAt, 'string');
      break;
    }
    if (Date.now() > deadline) throw new Error('the cycle never ended');
    await new Promise((r) => { setTimeout(r, 200); });
  }
});

test('POST /api/poll/cancel is ok with nothing running, and ends a running cycle', async () => {
  const idle = await call('POST', '/api/poll/cancel');
  assert.equal(idle.status, 200);
  assert.equal(idle.body.ok, true);

  await call('POST', '/api/poll');
  const res = await call('POST', '/api/poll/cancel');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok('cancelling' in res.body.poll);

  const deadline = Date.now() + 60_000;
  for (;;) {
    const poll = (await call('GET', '/api/tasks')).body?.poll;
    if (poll && !poll.running) { assert.equal(poll.cancelling, false); break; }
    if (Date.now() > deadline) throw new Error('the cancelled cycle never ended');
    await new Promise((r) => { setTimeout(r, 200); });
  }
});
