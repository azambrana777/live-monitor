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
 * `POST /api/git/refresh`,
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
  dir = tempDir('hfsmon-gitrefresh-');
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

test('POST /api/git/refresh: ok with counts, 400 for an unknown project', async () => {
  const all = await call('POST', '/api/git/refresh', {});
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(all.body.ok, true);
  assert.equal(typeof all.body.tasks, 'number');
  assert.equal(typeof all.body.fetched, 'number');

  const none = await call('POST', '/api/git/refresh');
  assert.equal(none.status, 200);

  const one = await call('POST', '/api/git/refresh', { project: 'docs' });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.ok, true);

  const bad = await call('POST', '/api/git/refresh', { project: 'ghost' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /ghost/);
});

test('gitRefreshSeconds is a project override with the 0 / 15..3600 validator', async () => {
  const ok = await call('POST', '/api/projects/hfs/settings', { gitRefreshSeconds: 0 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.projects.hfs.gitRefreshSeconds, 0);
  assert.equal((await call('POST', '/api/projects/hfs/settings', { gitRefreshSeconds: 14 })).status, 400);
  assert.equal((await call('POST', '/api/projects/hfs/settings', { gitRefreshSeconds: 3601 })).status, 400);
  assert.equal((await call('POST', '/api/projects/hfs/settings', { gitRefreshSeconds: 15 })).status, 200);
  assert.equal((await call('POST', '/api/projects/hfs/settings', { gitRefreshSeconds: null })).status, 200);
});
