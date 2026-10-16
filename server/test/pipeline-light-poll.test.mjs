import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { store } from '../src/store.js';
import {
  refreshGitNow, refreshGitDeps, needsClassification, classifyNewTask, refreshClassification,
  refreshBranchStatus, refreshChecks, refreshChecksDeps, checkChangeRequests, applyChecksForTask,
} from '../src/pipeline.js';

function withDeps(over, fn) {
  const saved = { ...refreshGitDeps };
  Object.assign(refreshGitDeps, over);
  return Promise.resolve().then(fn).finally(() => Object.assign(refreshGitDeps, saved));
}
const mk = (id, extra = {}) => ({ id, project: 'a', branch: `b${id}`, worktreePath: `/w/${id}`, state: 'started', ...extra });

test('refreshGitNow: projects array filters, wins over project, empty is a no-op', async () => {
  const tasks = [mk('1'), mk('2', { project: 'b' }), mk('3', { project: 'c' })];
  const fetched = []; const seen = [];
  await withDeps({
    tasks: () => tasks,
    listAllBranches: async (o) => { fetched.push(o.project); },
    refreshBranchStatus: async (t) => { seen.push(t.id); },
  }, async () => {
    assert.deepEqual(await refreshGitNow({ projects: [] }), { tasks: 0, fetched: 0 });
    assert.deepEqual(fetched, []);
    assert.deepEqual(await refreshGitNow({ projects: ['a', 'c'], project: 'b' }), { tasks: 2, fetched: 2 });
    assert.deepEqual(fetched.sort(), ['a', 'c']);
    assert.deepEqual(seen.sort(), ['1', '3']);
    fetched.length = 0;
    assert.deepEqual(await refreshGitNow({ projects: null, project: 'b' }), { tasks: 1, fetched: 1 });
    assert.deepEqual(await refreshGitNow({ projects: undefined }), { tasks: 3, fetched: 3 });
  });
});

test('refreshGitNow: same project set shares the in-flight run whatever the order', async () => {
  let calls = 0; let release;
  const gate = new Promise((r) => { release = r; });
  await withDeps({
    tasks: () => [mk('1'), mk('2', { project: 'b' })],
    listAllBranches: async () => { calls++; await gate; },
    refreshBranchStatus: async () => {},
  }, async () => {
    const a = refreshGitNow({ projects: ['a', 'b'] });
    const b = refreshGitNow({ projects: ['b', 'a'] });
    const c = refreshGitNow({ projects: ['a'] });
    assert.equal(a, b);
    assert.notEqual(a, c);
    release();
    await Promise.all([a, c]);
    assert.equal(calls, 3);
  });
});

test('needsClassification truth table', () => {
  const base = { state: 'assigned', classified: false };
  assert.equal(needsClassification(base), true);
  assert.equal(needsClassification({ state: 'started' }), true);
  assert.equal(needsClassification({ ...base, classified: true }), false);
  assert.equal(needsClassification({ ...base, state: 'done' }), false);
  assert.equal(needsClassification({ ...base, unassigned: { settled: false } }), false);
  assert.equal(needsClassification({ ...base, issueClosed: true }), false);
  assert.equal(needsClassification({ ...base, moving: {} }), false);
  assert.equal(needsClassification(null), false);
});

test('classifyNewTask classifies a new task and ignores classified or done ones', async () => {
  let calls = 0;
  const steps = {
    issueReopenInfo: async () => null,
    findBranchesForIssue: async () => { calls++; return []; },
    linkedPullRequests: async () => [],
    prsForBranch: async () => [],
    prView: async () => null,
  };
  const fresh = { id: 'n1', issue: 901, project: 'a', state: 'assigned', classified: false };
  const origTouch = store.touch; const origSet = store.setState; const origLog = store.addLog;
  store.touch = () => {}; store.setState = (t, s) => { t.state = s; }; store.addLog = () => {};
  try {
    await classifyNewTask(fresh, steps);
    assert.equal(fresh.classified, true);
    const after = calls;
    assert.ok(after > 0);
    await classifyNewTask(fresh, steps);
    await classifyNewTask({ id: 'd', issue: 902, project: 'a', state: 'done', classified: false }, steps);
    await classifyNewTask({ id: 'c', issue: 903, project: 'a', state: 'assigned', classified: true }, steps);
    assert.equal(calls, after);
  } finally { store.touch = origTouch; store.setState = origSet; store.addLog = origLog; }
});

test('done tasks get no gh/git from the heavy refreshers', async () => {
  const boom = async () => { throw new Error('must not be called'); };
  const steps = { issueReopenInfo: boom, findBranchesForIssue: boom, linkedPullRequests: boom, prsForBranch: boom, prView: boom };
  const done = { id: 'x', issue: 910, project: 'a', state: 'done', issueClosed: true, classified: true, classifiedAt: Date.now(), prNumber: 5, branch: 'b', worktreePath: '/w/x' };
  await refreshClassification(done, steps);          // quiet rule
  await refreshBranchStatus(done);                   // done skipped without force
  assert.equal(await checkChangeRequests(done), 0);  // state gate
  const calls = [];
  const saved = refreshChecksDeps.checksForOpenPrs;
  refreshChecksDeps.checksForOpenPrs = async (o) => { calls.push(o.project); return new Map([[5, { state: 'success' }]]); };
  const origAll = store.all;
  store.all = () => [done];
  try {
    await refreshChecks({ projects: ['a'] });
    assert.deepEqual(calls, []);
    assert.equal(applyChecksForTask({ ...done, checks: null }, new Map([['a', new Map([[5, { state: 'success' }]])]])), false);
  } finally { refreshChecksDeps.checksForOpenPrs = saved; store.all = origAll; }
  await withDeps({
    tasks: () => [done],
    listAllBranches: boom,
    refreshBranchStatus: boom,
  }, async () => {
    assert.deepEqual(await refreshGitNow(), { tasks: 0, fetched: 0 });
  });
});

test('a completed card whose issue is still open is quiet inside the hour and asked again after it', async () => {
  const { quietRecently } = await import('../src/pipeline.js');
  const base = { project: 'p', issue: 9001, state: 'done', classified: true, issueClosed: false };
  const now = Date.now();
  assert.equal(quietRecently({ ...base, classifiedAt: now - 5 * 60_000 }, now), true, 'classified minutes ago: not asked');
  assert.equal(quietRecently({ ...base, classifiedAt: now - 2 * 3_600_000 }, now), false, 'older than the hour: asked again');
  assert.equal(quietRecently({ ...base, state: 'waiting_approval', classifiedAt: now }, now), false, 'a live card is never quiet');
});
