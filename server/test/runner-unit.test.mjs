import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createRunner, unitFromCgroup } from '../src/runner/app.js';
import { tempDir } from './teardown.mjs';

const UP = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/';

test('unitFromCgroup finds the user service', () => {
  assert.equal(unitFromCgroup(`${UP}livemon-runner.service\n`), 'livemon-runner.service');
  assert.equal(unitFromCgroup(`${UP}hfsmon-runner.service`), 'hfsmon-runner.service');
  assert.equal(unitFromCgroup(`12:cpu:/\n1:name=systemd:/user.slice/user-1000.slice/user@1000.service/app.slice/x.service\n`), 'x.service');
  assert.equal(unitFromCgroup(`${UP}foo.service/sub`), 'foo.service');
});

test('unitFromCgroup returns null outside a user service', () => {
  assert.equal(unitFromCgroup('0::/user.slice/user-1000.slice/session-3.scope\n'), null);
  assert.equal(unitFromCgroup('0::/init.scope\n'), null);
  assert.equal(unitFromCgroup('0::/system.slice/ssh.service\n'), null);
  assert.equal(unitFromCgroup('0::/user.slice/user-1000.slice/user@1000.service\n'), null);
  assert.equal(unitFromCgroup(`${UP}tmux-spawn-1.scope\n`), null);
  assert.equal(unitFromCgroup(''), null);
  assert.equal(unitFromCgroup('garbage\n::\n'), null);
  assert.equal(unitFromCgroup(undefined), null);
  assert.equal(unitFromCgroup(`${UP}a;rm -rf x.service`), null);
  assert.equal(unitFromCgroup(`${UP}$(x).service`), null);
});

test('/info includes unit and keeps the other fields', async () => {
  const root = tempDir('hfsmon-runner-unit-');
  const runner = createRunner({
    token: 't', repoPath: path.join(root, 'repo'), worktreeRoot: path.join(root, 'wt'),
    attachmentsDir: path.join(root, 'att'), monitorDir: root, infoBoundMs: 1500,
  });
  const { port } = await runner.listen(0, '127.0.0.1');
  try {
    const t0 = Date.now();
    const r = await (await fetch(`http://127.0.0.1:${port}/info`, { headers: { 'x-hfsmon-token': 't' } })).json();
    assert.ok(Date.now() - t0 < 3000);
    assert.ok('unit' in r);
    assert.ok(r.unit === null || /\.service$/.test(r.unit));
    for (const k of ['pid', 'commit', 'diskCommit', 'monitorDir', 'node', 'degraded', 'platform', 'uid']) assert.ok(k in r, k);
    assert.equal(r.pid, process.pid);
  } finally { await runner.close(); }
});
