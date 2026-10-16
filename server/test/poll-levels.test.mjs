import './isolate.mjs';
import { test, before, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let poller; let viewers;
before(async () => {
  poller = await import('../src/poller.js');
  viewers = await import('../src/viewers.js');
});
const ids = ['a', 'b', 'c'];
let stopWatch = null;
beforeEach(() => {
  viewers.resetViewers();
  viewers.setViewerProjectLister(() => ids);
});
afterEach(() => {
  stopWatch?.(); stopWatch = null;
  poller.cancelPoll();
  poller.setPollTestHooks();
  viewers.resetViewers();
  viewers.setViewerProjectLister();
});

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const noop = async () => {};
const idle = async () => { while (poller.pollStatus().running) await sleep(5); };

/** Real runCycle with injected steps; records every step call. */
function harness({ tasks = [], lat = 2 } = {}) {
  const calls = [];
  const rec = (name, fn = noop) => async (...args) => {
    const a = args[0];
    calls.push([name, a && a.issue !== undefined ? a.issue : (a?.id ?? a?.project ?? null)]);
    await sleep(lat);
    return fn(...args);
  };
  const steps = {
    pollProject: rec('listing'),
    sweepClosedIssues: rec('sweep', async () => ({ flipped: 0, settled: 0 })),
    listAllBranches: rec('fetch'),
    refreshClassification: rec('classify'),
    refreshBranchStatus: rec('branches'),
    refreshStackHealth: rec('stack'),
    checkChangeRequests: rec('crs', async () => 0),
    refreshChecks: rec('checks'),
    prefetchChecks: rec('prefetch', async () => new Map()),
    applyChecksForTask: rec('apply'),
    tick: () => { calls.push(['tick', null]); },
    evaluateQuota: noop,
    listTasks: (set) => tasks.filter((t) => set.has(t.project)),
  };
  poller.setPollTestHooks({ steps, projects: () => ids.map((id) => ({ id })) });
  return { calls, has: (name, who) => calls.some(([n, w]) => n === name && (who === undefined || w === who)) };
}
const T = (project, issue, extra = {}) => ({ project, issue, state: 'assigned', ...extra });

test('nobody viewing: every project is light; only listing, classify-new and tick run', async () => {
  const h = harness({ tasks: [T('a', 1), T('a', 2, { classified: true }), T('b', 3, { state: 'done' }), T('c', 4)] });
  await poller.startPoll().promise;
  for (const heavy of ['sweep', 'fetch', 'branches', 'stack', 'crs', 'checks', 'prefetch', 'apply']) {
    assert.equal(h.has(heavy), false, `${heavy} must not run`);
  }
  assert.deepEqual(h.calls.filter(([n]) => n === 'listing').map(([, w]) => w).sort(), ['a', 'b', 'c']);
  assert.deepEqual(h.calls.filter(([n]) => n === 'classify').map(([, w]) => w).sort(), [1, 4]);
  assert.ok(h.has('tick'));
});

test('a viewed project runs the full chain, the others stay light', async () => {
  const h = harness({ tasks: [T('a', 1), T('b', 2)] });
  viewers.setView({}, { project: 'a', visible: true });
  const p = poller.startPoll();
  await sleep(1);
  assert.deepEqual(poller.pollStatus().scope, { full: ['a'], light: ['b', 'c'] });
  await p.promise;
  assert.ok(h.has('sweep', 'a') && h.has('fetch', 'a') && h.has('branches', 1) && h.has('crs', 1));
  assert.equal(h.has('sweep', 'b'), false);
  assert.equal(h.has('fetch', 'b'), false);
  assert.equal(h.has('branches', 2), false);
  assert.ok(h.has('classify', 2));
  assert.deepEqual(poller.pollStatus().scope, { full: [], light: [] });
});

test('light classification skips classified, done and unassigned tasks', async () => {
  const h = harness({ tasks: [T('a', 1, { classified: true }), T('a', 2, { unassigned: true }), T('a', 3, { state: 'done' })] });
  await poller.startPoll({ scheduled: true }).promise;
  assert.equal(h.has('classify'), false);
});

test('request with a project: full for that project only, nothing for the others', async () => {
  const h = harness({ tasks: [T('a', 1), T('b', 2)] });
  await poller.startPoll({ project: 'b' }).promise;
  assert.ok(h.has('sweep', 'b'));
  assert.equal(h.has('listing', 'a'), false);
  assert.equal(h.has('listing', 'c'), false);
});

test('entering the viewed set starts a full cycle for that project only', async () => {
  const h = harness({ tasks: [T('a', 1)] });
  stopWatch = poller.watchViewers();
  viewers.setView({}, { project: 'a', visible: true });
  await sleep(1);
  assert.deepEqual(poller.pollStatus().scope, { full: ['a'], light: [] });
  await idle();
  assert.ok(h.has('fetch', 'a'));
  assert.equal(h.has('listing', 'b'), false);
});

test('requests during a running cycle coalesce into one follow-up, full wins, none lost', async () => {
  const h = harness({ lat: 20 });
  const first = poller.startPoll({ project: 'a' });
  assert.equal(first.started, true);
  assert.equal(poller.startPoll({ project: 'b' }).started, false);
  poller.startPoll({ project: 'c' });
  viewers.setView({}, { project: 'b', visible: true });
  poller.startPoll(); // light request for the rest must not downgrade b or c
  await first.promise;
  await sleep(1);
  assert.equal(poller.pollStatus().running, true, 'the follow-up started');
  const { scope } = poller.pollStatus();
  assert.deepEqual([...scope.full].sort(), ['b', 'c']);
  assert.deepEqual(scope.light, []);
  await idle();
  assert.ok(h.has('fetch', 'b') && h.has('fetch', 'c'));
  assert.equal(h.calls.filter(([n, w]) => n === 'fetch' && w === 'a').length, 1, 'a was not repeated');
  await sleep(40);
  assert.equal(poller.pollStatus().running, false, 'only one follow-up');
});

test('cancel drops the pending follow-up', async () => {
  harness({ lat: 20 });
  const first = poller.startPoll({ project: 'a' });
  poller.startPoll({ project: 'b' });
  poller.cancelPoll();
  await first.promise;
  await sleep(10);
  assert.equal(poller.pollStatus().running, false);
});

test('gitRefreshTick acts only on viewed projects and does nothing when none are viewed', async () => {
  const seen = [];
  const refresh = async (o) => { seen.push(o); };
  assert.equal(await poller.gitRefreshTick(refresh), false);
  assert.deepEqual(seen, []);
  viewers.setView({}, { project: 'b', visible: true });
  viewers.setView({}, { project: 'zzz', visible: true });
  assert.equal(await poller.gitRefreshTick(refresh), true);
  assert.deepEqual(seen, [{ projects: ['b'], force: true }]);
});
