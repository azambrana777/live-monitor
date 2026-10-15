// Poll speed: what a restart must not repeat, and what concurrent callers must
// not multiply. No test here calls `gh` or the network.
import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir } from './teardown.mjs';

import { config } from '../src/config.js';
import { store } from '../src/store.js';
import * as pipeline from '../src/pipeline.js';
import { shared } from '../src/inflight.js';
import { listAllBranches } from '../src/worktree.js';
import { machines } from '../src/machine.js';

let n = 52000;
function freshTask(fields = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.issueClosed = false;
  return Object.assign(task, fields);
}

function github() {
  const calls = [];
  return {
    calls,
    findBranchesForIssue: async () => { calls.push('findBranchesForIssue'); return []; },
    linkedPullRequests: async () => { calls.push('linkedPullRequests'); return []; },
    prsForBranch: async () => { calls.push('prsForBranch'); return []; },
    issueReopenInfo: async () => { calls.push('issueReopenInfo'); return null; },
    prView: async (number) => ({ number, state: 'OPEN', isDraft: false }),
  };
}

// ---------------------------------------------------------------------------
// 1. classifiedAt survives a restart

test('classifying stamps classifiedAt on the task and a restart does not re-ask a quiet task', async () => {
  const task = freshTask({ state: 'done', issueClosed: true, classified: true });
  const gh = github();
  const before = Date.now();
  await pipeline.refreshClassification(task, gh);
  assert.ok(gh.calls.length > 0, 'first time: GitHub is asked');
  assert.ok(task.classifiedAt >= before && task.classifiedAt <= Date.now(), 'stamped on the task');

  // The in-memory map is process-local: a restarted board only has the task as
  // it came back from tasks.json. A task of another number is never in the map.
  const restored = JSON.parse(JSON.stringify(task));
  assert.equal(restored.classifiedAt, task.classifiedAt, 'survives serialisation');
  const again = github();
  const clone = freshTask({ ...restored, issue: n + 1, project: 'hfs' });
  clone.classifiedAt = Date.now() - 5 * 60_000;
  await pipeline.refreshClassification(clone, again);
  assert.deepEqual(again.calls, [], 'quiet and classified 5 min ago: nothing asked');
});

test('quiet rule: a stored classifiedAt older than the window asks again; an open task is never silenced', async () => {
  const stale = freshTask({ state: 'done', issueClosed: true, classified: true, classifiedAt: Date.now() - 61 * 60_000 });
  const gh = github();
  await pipeline.refreshClassification(stale, gh);
  assert.ok(gh.calls.length > 0, 'older than an hour: asked again');

  const fresh = freshTask({ state: 'done', issueClosed: true, classified: true, classifiedAt: Date.now() - 60_000 });
  const gh2 = github();
  await pipeline.refreshClassification(fresh, gh2);
  assert.deepEqual(gh2.calls, []);

  const open = freshTask({ state: 'assigned', classified: true, classifiedAt: Date.now() });
  const gh3 = github();
  await pipeline.refreshClassification(open, gh3);
  assert.ok(gh3.calls.length > 0, 'an open task is classified every cycle');
});

test('quietRecently and lastClassifiedAt', () => {
  const t = freshTask({ state: 'done', issueClosed: true, classified: true, classifiedAt: 1 });
  assert.equal(pipeline.quietRecently(t), false);
  t.classifiedAt = Date.now();
  assert.equal(pipeline.quietRecently(t), true);
  assert.equal(pipeline.quietRecently(t, Date.now() + 61 * 60_000), false);
  assert.ok(pipeline.lastClassifiedAt(t) >= t.classifiedAt);
});

// ---------------------------------------------------------------------------
// 2. refreshBranchStatus skips done

test('refreshBranchStatus leaves a done task alone unless includeBusy or force', async () => {
  const task = freshTask({
    state: 'done', branch: 'feat/x', worktreePath: path.join(tempDir('hfsmon-pollspeed-'), 'wt'),
    branchStatus: { behind: 1, unpushed: 0, dirty: 0, conflicts: 0, mergeStuck: false, at: 'x' },
  });
  await pipeline.refreshBranchStatus(task);
  assert.equal(task.branchStatus.behind, 1, 'kept as it was');
  // With the flags it goes on to measure: the worktree does not exist, which
  // clears the status (proof the early return no longer applies).
  await pipeline.refreshBranchStatus(task, { force: true });
  assert.equal(task.branchStatus, null);

  const t2 = freshTask({ state: 'done', branch: 'feat/y', worktreePath: '/nope/x', branchStatus: { behind: 2 } });
  await pipeline.refreshBranchStatus(t2, { includeBusy: true });
  assert.equal(t2.branchStatus, null);
});

// ---------------------------------------------------------------------------
// 3. refreshChecks project filter

test('refreshChecks({ projects }) only lists PR checks for named projects that have a candidate task', async () => {
  const asked = [];
  const orig = pipeline.refreshChecksDeps.checksForOpenPrs;
  pipeline.refreshChecksDeps.checksForOpenPrs = async ({ project }) => {
    asked.push(project);
    return new Map([[7, { failed: 0, pending: 0, passed: 1, total: 1 }]]);
  };
  try {
    const t = freshTask({ state: 'ready', prNumber: 7 });
    await pipeline.refreshChecks();
    assert.ok(asked.includes('hfs'), 'no-arg call keeps sweeping every project');
    assert.ok(t.checks, 'light set');

    asked.length = 0;
    t.checks = null;
    await pipeline.refreshChecks({ projects: ['other'] });
    assert.deepEqual(asked, [], 'a project not named is not asked');
    assert.equal(t.checks, null, 'and its tasks are left alone');

    await pipeline.refreshChecks({ projects: ['hfs'] });
    assert.deepEqual(asked, ['hfs']);
    assert.ok(t.checks);

    // No candidate task (everything done or without a PR): no call at all.
    for (const task of store.all()) task.state = 'done';
    asked.length = 0;
    await pipeline.refreshChecks({ projects: ['hfs'] });
    assert.deepEqual(asked, [], 'only done tasks: nothing to ask');
  } finally { pipeline.refreshChecksDeps.checksForOpenPrs = orig; }
});

// ---------------------------------------------------------------------------
// 4. in-flight dedupe

test('shared: identical concurrent calls share one promise, a settled one is forgotten', async () => {
  const map = new Map();
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const fn = async () => { calls++; await gate; return calls; };
  const a = shared(map, 'k', fn);
  const b = shared(map, 'k', fn);
  assert.equal(a, b);
  release();
  assert.equal(await a, 1);
  assert.equal(calls, 1);
  assert.equal(map.has('k'), false);
  assert.equal(await shared(map, 'k', fn), 2, 'after settling, a new call runs');
  const bad = shared(map, 'e', async () => { throw new Error('boom'); });
  await assert.rejects(bad, /boom/);
  assert.equal(map.has('e'), false);
});

const git = (args, cwd) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();

test('listAllBranches: concurrent forced calls share one fetch, and a warm cache fetches nothing', async () => {
  const root = tempDir('hfsmon-pollspeed-');
  const repo = path.join(root, 'repo');
  const origin = path.join(root, 'origin.git');
  mkdirSync(repo);
  git(['init', '--bare', '-b', 'main', origin], root);
  git(['init', '-b', 'main', '.'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'T'], repo);
  writeFileSync(path.join(repo, 'a.txt'), 'uno\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'seed'], repo);
  git(['remote', 'add', 'origin', origin], repo);
  git(['push', '-q', 'origin', 'main'], repo);

  const saved = config.project.repoPath;
  config.project.repoPath = repo;
  const machine = machines().local;
  const realExec = machine.exec;
  const fetches = [];
  machine.exec = function exec(file, args, opts) {
    if (file === 'git' && args[0] === 'fetch') fetches.push(args.join(' '));
    return realExec.call(this, file, args, opts);
  };
  try {
    const lists = await Promise.all([1, 2, 3, 4].map(() => listAllBranches({ project: 'hfs', force: true })));
    assert.equal(fetches.length, 1, 'four identical forced calls: one fetch');
    assert.ok(lists.every((l) => l.includes('main')));

    fetches.length = 0;
    await Promise.all([listAllBranches({ project: 'hfs' }), listAllBranches({ project: 'hfs' })]);
    assert.equal(fetches.length, 0, 'cache is warm');

    // Two forced calls racing share one fetch.
    fetches.length = 0;
    await Promise.all([listAllBranches({ project: 'hfs', force: true }), listAllBranches({ project: 'hfs', force: true })]);
    assert.equal(fetches.length, 1);
  } finally {
    machine.exec = realExec;
    config.project.repoPath = saved;
  }
});
