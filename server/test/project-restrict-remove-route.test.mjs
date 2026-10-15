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
 * `POST /api/projects/:project/restricted` and `DELETE /api/projects/:project`,
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
  dir = tempDir('hfsmon-prestrict-');
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

const read = (f) => readFileSync(path.join(dataDir, f), 'utf8');

test('restrict and unrestrict: 200 with the entry, 404 unknown, 400 bad body', async () => {
  const on = await call('POST', '/api/projects/docs/restricted', { restricted: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.id, 'docs');
  assert.equal(on.body.restricted, true);
  assert.equal((await call('POST', '/api/projects/ghost/restricted', { restricted: true })).status, 404);
  assert.equal((await call('POST', '/api/projects/docs/restricted', { restricted: 'yes' })).status, 400);
  assert.equal((await call('POST', '/api/projects/docs/restricted', {})).status, 400);

  const snap = (await call('GET', '/api/tasks')).body;
  assert.deepEqual(snap.projects.map((p) => p.id), ['hfs', 'docs'], 'restricted stays listed');
  assert.equal(snap.projects[1].restricted, true);
  assert.ok(snap.tasks.some((t) => t.project === 'docs'));
  assert.equal(snap.activeProject, 'hfs');

  const off = await call('POST', '/api/projects/docs/restricted', { restricted: false });
  assert.equal(off.status, 200);
  assert.equal(Object.hasOwn(off.body, 'restricted'), false);
});

test('the opening project skips restricted projects, null when all are', async () => {
  await call('POST', '/api/projects/hfs/restricted', { restricted: true });
  assert.equal((await call('GET', '/api/tasks')).body.activeProject, 'docs');
  await call('POST', '/api/projects/docs/restricted', { restricted: true });
  assert.equal((await call('GET', '/api/tasks')).body.activeProject, null);
  await call('POST', '/api/projects/hfs/restricted', { restricted: false });
  await call('POST', '/api/projects/docs/restricted', { restricted: false });
});

test('DELETE removes the entry only; data stays and comes back on re-import', async () => {
  await call('POST', '/api/projects/docs/settings', { approvePlan: true });
  const tasksBefore = read('tasks.docs.json');

  assert.equal((await call('DELETE', '/api/projects/ghost')).status, 404);
  const del = await call('DELETE', '/api/projects/docs');
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { ok: true });
  assert.equal((await call('DELETE', '/api/projects/docs')).status, 404);

  const snap = (await call('GET', '/api/tasks')).body;
  assert.deepEqual(snap.projects.map((p) => p.id), ['hfs']);
  assert.equal(snap.tasks.some((t) => t.project === 'docs'), false, 'its tasks are not sent');
  assert.equal(snap.projectChats.some((h) => h.project === 'docs'), false);
  assert.ok(snap.tasks.some((t) => t.project === 'hfs'));
  assert.equal((await call('GET', '/api/projects/docs/tasks')).status, 404);

  assert.equal(existsSync(path.join(dataDir, 'tasks.docs.json')), true);
  assert.equal(read('tasks.docs.json'), tasksBefore, 'tasks file untouched');
  assert.deepEqual(JSON.parse(read('projects.json')).map((p) => p.id), ['hfs']);
  assert.ok(existsSync(path.join(dir, 'docs')), 'the repo is untouched');
  assert.equal((await call('GET', '/api/settings')).body.projects.docs?.approvePlan, true, 'settings overlay kept');

  const again = await call('POST', '/api/projects', { repoPath: path.join(dir, 'docs'), assignee: 'nobody' });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.id, 'docs');
  const back = (await call('GET', '/api/tasks')).body;
  assert.ok(back.projects.some((p) => p.id === 'docs'));
  assert.ok(back.tasks.some((t) => t.project === 'docs' && t.title === 'en docs'), 'tasks visible again');
  assert.equal(back.settings.projects.docs?.approvePlan, true);
});

test('re-import restores the removed project settings; body fields win; restricted stays cleared', async () => {
  const docs = path.join(dir, 'docs');
  await call('POST', '/api/projects/docs/restricted', { restricted: true });
  await call('POST', '/api/projects/docs/reviewer', { reviewer: 'some-reviewer' });
  assert.equal((await call('DELETE', '/api/projects/docs')).status, 200);
  const removed = JSON.parse(read('projects-removed.json'));
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, 'docs');

  const again = await call('POST', '/api/projects', { repoPath: docs.toUpperCase().split(path.sep).join('/'), assignee: 'nobody' });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.id, 'docs');
  assert.equal(again.body.reviewer, 'some-reviewer');
  assert.equal(Object.hasOwn(again.body, 'restricted'), false);
  assert.deepEqual(JSON.parse(read('projects-removed.json')), []);
});

test('removing every project leaves a usable board', async () => {
  assert.equal((await call('DELETE', '/api/projects/docs')).status, 200);
  assert.equal((await call('DELETE', '/api/projects/hfs')).status, 200);
  const snap = (await call('GET', '/api/tasks')).body;
  assert.deepEqual(snap.projects, []);
  assert.equal(snap.activeProject, null);
  assert.deepEqual(snap.tasks, []);
  assert.equal((await call('GET', '/api/tuning')).status, 200);
});
