import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir } from './teardown.mjs';

import { config } from '../src/config.js';
import { store } from '../src/store.js';
import {
  refreshBranchStatus, refreshGitNow, refreshGitDeps, refreshAfterChat, gitBusyReason,
} from '../src/pipeline.js';

const git = (args, cwd) => execFileSync(
  'git', ['-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' },
).trim();

/** Real repo + a worktree on a branch with one local commit (so unpushed = 1). */
function fixture() {
  const root = tempDir('hfsmon-gitrefresh-');
  const repo = path.join(root, 'repo');
  const origin = path.join(root, 'origin.git');
  const wt = path.join(root, 'wt', 'task');
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
  git(['worktree', 'add', '-q', '-b', 'feat/1-x', wt, 'main'], repo);
  writeFileSync(path.join(wt, 'b.txt'), 'dos\n');
  git(['add', '.'], wt);
  git(['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-m', 'work'], wt);
  return { repo, wt };
}

function withRepo(f, fn) {
  const saved = config.project.repoPath;
  config.project.repoPath = f.repo;
  return Promise.resolve().then(fn).finally(() => { config.project.repoPath = saved; });
}

const taskFor = (f, extra = {}) => ({
  id: 't1', issue: 1, project: 'hfs', branch: 'feat/1-x', worktreePath: f.wt, state: 'worktree', ...extra,
});

test('a working task is skipped by default and measured with includeBusy', async () => {
  const f = fixture();
  await withRepo(f, async () => {
    const task = taskFor(f);
    assert.ok(gitBusyReason(task));
    const touched = [];
    const orig = store.touch;
    store.touch = (t) => touched.push(t);
    try {
      await refreshBranchStatus(task);
      assert.equal(task.branchStatus, undefined, 'busy: nothing measured');
      await refreshBranchStatus(task, { includeBusy: true });
      assert.ok(task.branchStatus, 'measured');
      assert.equal(touched.length, 1);
    } finally { store.touch = orig; }
  });
});

test('a moving task is skipped even with includeBusy', async () => {
  const f = fixture();
  await withRepo(f, async () => {
    const task = taskFor(f, { moving: { step: 'x' } });
    await refreshBranchStatus(task, { includeBusy: true });
    assert.equal(task.branchStatus, undefined);
  });
});

test('branchStatus.at advances on every check; touch only on changes or after 30 s', async () => {
  const f = fixture();
  await withRepo(f, async () => {
    const task = taskFor(f, { state: 'in_review' });
    let touches = 0;
    const orig = store.touch;
    store.touch = () => { touches++; };
    try {
      await refreshBranchStatus(task);
      assert.equal(touches, 1);
      const first = task.branchStatus.at;
      await new Promise((r) => setTimeout(r, 15));
      await refreshBranchStatus(task);
      assert.ok(task.branchStatus.at > first, 'at moved');
      assert.equal(touches, 1, 'no touch for an at-only change');
      task.branchStatus.at = new Date(Date.now() - 60_000).toISOString();
      await refreshBranchStatus(task);
      assert.equal(touches, 2, 'touched after 30 s');
      writeFileSync(path.join(f.wt, 'c.txt'), 'dirty');
      await refreshBranchStatus(task);
      assert.equal(task.branchStatus.dirty, 1);
      assert.equal(touches, 3, 'a real change touches');
    } finally { store.touch = orig; }
  });
});

function withDeps(over, fn) {
  const saved = { ...refreshGitDeps };
  Object.assign(refreshGitDeps, over);
  return Promise.resolve().then(fn).finally(() => Object.assign(refreshGitDeps, saved));
}

const mk = (id, extra = {}) => ({ id, project: 'hfs', branch: `b${id}`, worktreePath: `/w/${id}`, state: 'in_review', ...extra });

test('refreshGitNow fetches once per project, filters tasks and limits concurrency to 4', async () => {
  const tasks = [
    ...Array.from({ length: 10 }, (_, i) => mk(String(i))),
    mk('u', { unassigned: true }), mk('d', { state: 'done' }), mk('m', { moving: {} }),
    mk('nb', { branch: null }), mk('o', { project: 'other' }),
  ];
  let active = 0; let max = 0; const fetched = []; const seen = [];
  await withDeps({
    tasks: () => tasks,
    listAllBranches: async (o) => { fetched.push(o); },
    refreshBranchStatus: async (t, o) => {
      assert.equal(o.includeBusy, true);
      seen.push(t.id); active++; max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    },
  }, async () => {
    const r = await refreshGitNow();
    assert.deepEqual(r, { tasks: 11, fetched: 2 });
    assert.equal(fetched.length, 2);
    assert.ok(fetched.every((o) => o.force === true));
    assert.ok(max <= 4 && max > 1, `max concurrency ${max}`);
    assert.ok(!['u', 'd', 'm', 'nb'].some((id) => seen.includes(id)));
    fetched.length = 0;
    const r2 = await refreshGitNow({ project: 'other', force: false });
    assert.deepEqual(r2, { tasks: 1, fetched: 1 });
    assert.deepEqual(fetched, [{ project: 'other', force: false }]);
  });
});

test('refreshGitNow isolates per-task and fetch errors and never rejects', async () => {
  const tasks = [mk('1'), mk('2'), mk('3')];
  const origErr = console.error; console.error = () => {};
  try {
    await withDeps({
      tasks: () => tasks,
      listAllBranches: async () => { throw new Error('offline'); },
      refreshBranchStatus: async (t) => { if (t.id === '2') throw new Error('boom'); },
    }, async () => {
      assert.deepEqual(await refreshGitNow(), { tasks: 2, fetched: 0 });
    });
  } finally { console.error = origErr; }
});

test('refreshGitNow shares the in-flight run for the same project', async () => {
  let calls = 0; let release;
  const gate = new Promise((r) => { release = r; });
  await withDeps({
    tasks: () => [mk('1')],
    listAllBranches: async () => { calls++; await gate; },
    refreshBranchStatus: async () => {},
  }, async () => {
    const a = refreshGitNow({ project: 'hfs' });
    const b = refreshGitNow({ project: 'hfs' });
    assert.equal(a, b);
    release();
    await a;
    assert.equal(calls, 1);
  });
});

test('refreshAfterChat measures with includeBusy, no fetch, and swallows errors', async () => {
  const calls = [];
  const logs = [];
  const origLog = store.addLog; store.addLog = (...a) => logs.push(a);
  try {
    await withDeps({
      listAllBranches: async () => { throw new Error('must not fetch'); },
      refreshBranchStatus: async (t, o) => { calls.push([t.id, o]); throw new Error('x'); },
    }, async () => {
      refreshAfterChat({ id: 'z' });
      await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(calls, [['z', { includeBusy: true }]]);
      assert.equal(logs.length, 1);
    });
  } finally { store.addLog = origLog; }
});
