import './isolate.mjs';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { removeTree, tempDir } from './teardown.mjs';

/**
 * `POST /api/projects` when no assignee can be resolved (not in the request, no
 * account detected, no `github.assignee`): a 400 that names the field and how to
 * provide it, and nothing written to the registry. With `github.assignee` set the
 * same import succeeds and uses it. Each board runs in its own process.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const boards = [];

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port: p } = srv.address();
    srv.close(() => resolve(p));
  });
});

async function startBoard(github) {
  const dir = tempDir('hfsmon-import-assignee-');
  const dataDir = path.join(dir, 'data');
  const checkout = path.join(dir, 'checkout');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(checkout, { recursive: true });
  writeFileSync(path.join(dataDir, 'projects.json'), '[]');
  const port = await freePort();
  const configFile = path.join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    port,
    github,
    poll: { intervalSeconds: 36000 },
    project: { repoPath: '', worktreeRoot: '' },
    stack: { command: 'npm start' },
    limits: { defaultMaxActiveTasks: 1, maxActiveTasksCeiling: 2, maxFixIterations: 1, completedShown: 5 },
    claude: {
      chatModel: 'sonnet', advisorModel: 'opus', fixModel: 'sonnet',
      available: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }],
    },
  }));
  const child = spawn(process.execPath, [path.join('server', 'src', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, HFSMON_CONFIG: configFile, HFSMON_DATA_DIR: dataDir, HFSMON_NO_AUTOSTART: '1',
      GIT_CEILING_DIRECTORIES: [dir, tmpdir()].join(path.delimiter) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (b) => log.push(String(b)));
  child.stderr.on('data', (b) => log.push(String(b)));
  child.once('exit', (code) => log.push(`[exit ${code}]`));
  const board = { dir, dataDir, checkout, child, port };
  boards.push(board);

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/tasks`)).status === 200) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`the board did not start:\n${log.join('')}`);
    await new Promise((r) => { setTimeout(r, 150); });
  }
  return board;
}

async function importProject(board, body) {
  const res = await fetch(`http://127.0.0.1:${board.port}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repoPath: board.checkout, ...body }),
  });
  return { status: res.status, body: await res.json() };
}

const registry = (board) => JSON.parse(readFileSync(path.join(board.dataDir, 'projects.json'), 'utf8'));

after(async () => {
  for (const { child, dir } of boards) {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
    await removeTree(dir);
  }
});

test('no assignee anywhere: 400 naming the field and how to set it, registry untouched', async () => {
  const board = await startBoard({ repo: 'nobody/nothing-at-all', reviewer: '' });
  const r = await importProject(board, {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /assignee is required/);
  assert.match(r.body.error, /github\.assignee/);
  assert.doesNotMatch(r.body.error, /expected a non-empty string/);
  assert.deepEqual(r.body.missing, ['assignee']);
  assert.deepEqual(registry(board), []);
});

test('no assignee anywhere: an assignee in the request makes the import succeed', async () => {
  const board = await startBoard({ repo: 'nobody/nothing-at-all', reviewer: '' });
  const r = await importProject(board, { assignee: 'someone' });
  assert.equal(r.status, 201);
  assert.equal(r.body.assignee, 'someone');
});

test('github.assignee configured: an empty assignee falls back to it', async () => {
  const board = await startBoard({ repo: 'nobody/nothing-at-all', assignee: 'board-default' });
  const r = await importProject(board, { assignee: '   ' });
  assert.equal(r.status, 201);
  assert.equal(r.body.assignee, 'board-default');
  assert.equal(registry(board)[0].assignee, 'board-default');
});

test('no assignee configured: the account in the checkout origin URL is used, not a 400', async () => {
  const board = await startBoard({ repo: 'nobody/nothing-at-all', reviewer: '' });
  const git = (...args) => execFileSync('git', ['-C', board.checkout, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://octocat@github.com/octocat/hello.git');
  const r = await importProject(board, {});
  assert.equal(r.status, 201);
  assert.equal(r.body.assignee, 'octocat');
});
