// A failed `gh` is "unknown", never "nothing": classification and CI lights
// keep what they had. `gh` fails for real here: a fake `gh` first on PATH that
// exits non-zero (node itself on Windows, a script elsewhere), so no network.
import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';

import * as github from '../src/github.js';
import * as pipeline from '../src/pipeline.js';
import { store } from '../src/store.js';
import { config } from '../src/config.js';
import { tempDir } from './teardown.mjs';

const { GhUnavailableError } = github;

function installFailingGh(t) {
  const dir = tempDir('hfsmon-fakegh-');
  if (process.platform === 'win32') copyFileSync(process.execPath, path.join(dir, 'gh.exe'));
  else {
    writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\necho "HTTP 429 rate limited" >&2\nexit 1\n');
    chmodSync(path.join(dir, 'gh'), 0o755);
  }
  const saved = process.env.PATH;
  const savedRepo = config.github.repo;
  process.env.PATH = `${dir}${path.delimiter}${saved}`;
  return () => { process.env.PATH = saved; config.github.repo = savedRepo; github.forgetRepoCache(); };
}

let seq = 0;
function useFailingGh(t) {
  const restore = installFailingGh(t);
  t.after(restore);
  seq += 1;
  config.github.repo = `fake-owner/fail-repo-${seq}`;   // fresh repo: no cache from another test
  github.forgetRepoCache();
}

test('linkedPullRequests throws a typed error when gh fails, not []', async (t) => {
  useFailingGh(t);
  await assert.rejects(github.linkedPullRequests(1, 'hfs'), GhUnavailableError);
});

test('checksForOpenPrs answers null (unknown) when gh fails and nothing is cached', async (t) => {
  useFailingGh(t);
  assert.equal(await github.checksForOpenPrs({ project: 'hfs' }), null);
});

test('prsForBranch failure is the typed error too', async (t) => {
  useFailingGh(t);
  await assert.rejects(github.prsForBranch('feat/x', { project: 'hfs' }), GhUnavailableError);
});

// ---- classification --------------------------------------------------------

let n = 31000;
function freshTask(fields = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.issueClosed = false;
  return Object.assign(task, fields);
}

const steps = (over = {}) => ({
  findBranchesForIssue: async () => [],
  linkedPullRequests: async () => [],
  prsForBranch: async () => [],
  issueReopenInfo: async () => null,
  prView: async (number) => ({ number, state: 'OPEN', isDraft: false }),
  ...over,
});

const guardLines = (task) => task.log.filter((l) => l.phase === 'guard' && /did not answer/.test(l.line));

test('refreshClassification keeps a waiting_approval task when gh fails, and logs once', async () => {
  const task = freshTask({ state: 'waiting_approval', prNumber: 7, prUrl: 'u7', classified: true });
  task.prs = [{ number: 7, url: 'u7', state: 'OPEN', title: 't' }];
  const failing = steps({ linkedPullRequests: async () => { throw new GhUnavailableError('gh issue view failed: 429'); } });
  await pipeline.refreshClassification(task, failing);
  await pipeline.refreshClassification(task, failing);
  assert.equal(task.state, 'waiting_approval');
  assert.equal(task.prNumber, 7);
  assert.deepEqual(task.prs.map((p) => p.number), [7]);
  assert.equal(guardLines(task).length, 1, 'logged once, not every cycle');
});

test('refreshClassification: a failing prsForBranch also keeps the state, and recovery works', async () => {
  const task = freshTask({ state: 'started', branch: 'feat/x' });
  await pipeline.refreshClassification(task, steps({
    prsForBranch: async () => { throw new GhUnavailableError('down'); },
  }));
  assert.equal(task.state, 'started', 'not downgraded to assigned');
  // gh back, with a genuinely empty answer: now the empty list counts
  await pipeline.refreshClassification(task, steps({ findBranchesForIssue: async () => [] }));
  assert.equal(task.state, 'assigned');
});

test('an unrelated error still propagates', async () => {
  const task = freshTask({ state: 'started' });
  await assert.rejects(
    pipeline.refreshClassification(task, steps({ linkedPullRequests: async () => { throw new Error('bug'); } })),
    /bug/,
  );
});

test('a legitimately empty answer still classifies as assigned', async () => {
  const task = freshTask({ state: 'started' });
  await pipeline.refreshClassification(task, steps());
  assert.equal(task.state, 'assigned');
});

// ---- checks ----------------------------------------------------------------

const light = (over = {}) => ({ failed: 0, pending: 0, passed: 3, total: 3, headRefOid: 'abc', isDraft: false, at: 't', ...over });

function checkTask(fields) {
  return freshTask({ state: 'ready', prNumber: 5, ...fields });
}

test('refreshChecks keeps the previous light when gh fails (null) and replaces it when it answers', async (t) => {
  const task = checkTask({ checks: { ...light(), stale: false } });
  const saved = pipeline.refreshChecksDeps.checksForOpenPrs;
  t.after(() => { pipeline.refreshChecksDeps.checksForOpenPrs = saved; });

  pipeline.refreshChecksDeps.checksForOpenPrs = async () => null;
  await pipeline.refreshChecks({ projects: ['hfs'] });
  assert.equal(task.checks.passed, 3, 'kept');

  pipeline.refreshChecksDeps.checksForOpenPrs = async () => { throw new Error('no repo'); };
  await pipeline.refreshChecks({ projects: ['hfs'] });
  assert.equal(task.checks.passed, 3, 'kept on a throw too');

  // a real, empty answer: the PR is gone from the open list -> no light
  pipeline.refreshChecksDeps.checksForOpenPrs = async () => new Map();
  await pipeline.refreshChecks({ projects: ['hfs'] });
  assert.equal(task.checks, null);
});

test('prefetchChecks / applyChecksForTask match refreshChecks', async (t) => {
  const a = checkTask({ prNumber: 11, branchStatus: { unpushed: 2 } });
  const b = checkTask({ prNumber: 12, checks: { ...light({ failed: 9 }), stale: false } });
  const done = checkTask({ prNumber: 11, state: 'done', checks: { ...light(), stale: false } });
  const unassigned = checkTask({ prNumber: 11, unassigned: { settled: true }, checks: { ...light(), stale: false } });
  const open = new Map([[11, light({ passed: 4, total: 4 })]]);
  const saved = pipeline.refreshChecksDeps.checksForOpenPrs;
  t.after(() => { pipeline.refreshChecksDeps.checksForOpenPrs = saved; });
  pipeline.refreshChecksDeps.checksForOpenPrs = async () => open;

  const mine = [a, b, done, unassigned];
  await pipeline.refreshChecks({ projects: ['hfs'] });
  const viaSweep = mine.map((x) => JSON.stringify(x.checks));

  // reset and redo through the split pieces
  a.checks = undefined; b.checks = { ...light({ failed: 9 }), stale: false };
  done.checks = { ...light(), stale: false }; unassigned.checks = { ...light(), stale: false };
  const byProject = new Map([['hfs', await pipeline.prefetchChecks('hfs')]]);
  assert.ok(byProject.get('hfs') instanceof Map);
  const changed = mine.map((x) => pipeline.applyChecksForTask(x, byProject));
  assert.deepEqual(mine.map((x) => JSON.stringify(x.checks)), viaSweep);
  assert.deepEqual(changed, [true, true, true, false]);
  assert.equal(a.checks.stale, true, 'unpushed work -> stale');
  assert.equal(b.checks, null, 'PR no longer open');

  // failure and absent project both leave the task as it is
  const before = JSON.stringify(a.checks);
  pipeline.refreshChecksDeps.checksForOpenPrs = async () => { throw new Error('x'); };
  assert.equal(await pipeline.prefetchChecks('hfs'), null);
  assert.equal(pipeline.applyChecksForTask(a, new Map([['hfs', null]])), false);
  assert.equal(pipeline.applyChecksForTask(a, new Map()), false);
  assert.equal(JSON.stringify(a.checks), before);
});
