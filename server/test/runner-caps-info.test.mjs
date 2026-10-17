import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { WebSocket } from 'ws';

import { _throttled, setProcessCaps, getProcessCaps, _processSlots } from '../src/exec.js';
import { createRunner } from '../src/runner/app.js';
import { tempDir } from './teardown.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = 'tok-caps';

function counter(ms = 30) {
  const c = { now: 0, max: 0 };
  c.fn = async () => { c.now++; c.max = Math.max(c.max, c.now); await sleep(ms); c.now--; };
  return c;
}

test('caps of Infinity or 0 never queue or take a slot', async (t) => {
  for (const unlimited of [Infinity, 0]) {
    const prev = setProcessCaps({ gh: unlimited, ghPerRepo: unlimited, git: unlimited });
    t.after(() => setProcessCaps(prev));
    assert.equal(getProcessCaps().git, Infinity);
    const git = counter(); const gh = counter();
    const all = Promise.all([
      ...Array.from({ length: 9 }, () => _throttled('git', ['status'], '/x', git.fn)),
      ...Array.from({ length: 9 }, () => _throttled('gh', ['pr', 'list', '-R', 'o/r'], undefined, gh.fn)),
    ]);
    await sleep(10);
    assert.deepEqual(_processSlots(), { gh: 0, git: 0 });
    await all;
    assert.equal(git.max, 9);
    assert.equal(gh.max, 9);
    setProcessCaps(prev);
  }
});

test('the board default still caps at 8 and restoring works', async () => {
  const prev = setProcessCaps({ gh: Infinity, ghPerRepo: Infinity, git: Infinity });
  setProcessCaps(prev);
  assert.deepEqual(getProcessCaps(), prev);
  const caps = getProcessCaps();
  assert.equal(caps.git, 8);
  const git = counter();
  await Promise.all(Array.from({ length: 12 }, () => _throttled('git', ['status'], '/x', git.fn)));
  assert.equal(git.max, 8);
});

async function startRunner(opts = {}) {
  const root = tempDir('hfsmon-runner-caps-');
  const runner = createRunner({
    token: TOKEN, repoPath: path.join(root, 'repo'), worktreeRoot: path.join(root, 'wt'),
    attachmentsDir: path.join(root, 'att'), monitorDir: root, ...opts,
  });
  const addr = await runner.listen(0, '127.0.0.1');
  return { runner, port: addr.port };
}
const getInfo = async (port) => {
  const r = await fetch(`http://127.0.0.1:${port}/info`, { headers: { 'x-hfsmon-token': TOKEN } });
  return r.json();
};

test('/info answers within its bound while git is saturated, and keeps its shape', async () => {
  const { runner, port } = await startRunner({ infoBoundMs: 300 });
  try {
    const ok = await getInfo(port);
    for (const k of ['pid', 'commit', 'diskCommit', 'monitorDir', 'node', 'platform', 'claude', 'home', 'repoPath', 'worktreeRoot', 'uid']) {
      assert.ok(k in ok, `missing ${k}`);
    }
    assert.equal(ok.pid, process.pid);
    // git that never comes back
    const real = runner.machine.exec.bind(runner.machine);
    runner.machine.exec = (file, ...rest) => (file === 'git' ? new Promise(() => {}) : real(file, ...rest));
    const t0 = Date.now();
    const slow = await getInfo(port);
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
    assert.equal(slow.degraded, true);
    assert.equal(slow.diskCommit, null);
    assert.equal(slow.pid, process.pid);
    assert.equal(slow.node, process.version);
  } finally { await runner.close(); }
});

test('close() finishes promptly with an open ws client and an idle keep-alive connection', async () => {
  const { runner, port } = await startRunner();
  const agent = new http.Agent({ keepAlive: true });
  await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/info', agent, headers: { 'x-hfsmon-token': TOKEN } }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/daemon?token=${TOKEN}`);
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const closed = new Promise((r) => ws.on('close', r));
  const t0 = Date.now();
  await runner.close();
  await closed;
  agent.destroy();
  assert.ok(Date.now() - t0 < 3000, `close took ${Date.now() - t0} ms`);
});
