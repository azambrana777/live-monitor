import './isolate.mjs';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

let poller;
before(async () => { poller = await import('../src/poller.js'); });
afterEach(() => poller.setPollTestHooks());

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const projects = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}` }));
const tasks = (n) => Array.from({ length: n }, (_, i) => ({ project: 'p0', issue: i + 1 }));
const noop = async () => {};

/** Steps that do nothing; `over` replaces some of them. */
function steps(taskList, over = {}) {
  return {
    pollProject: noop,
    sweepClosedIssues: async () => ({ flipped: 0, settled: 0 }),
    listAllBranches: noop,
    refreshClassification: noop,
    refreshBranchStatus: noop,
    refreshStackHealth: noop,
    refreshChecks: noop,
    prefetchChecks: async () => new Map(),
    applyChecksForTask: noop,
    checkChangeRequests: async () => 0,
    tick: () => {},
    evaluateQuota: () => {},
    listTasks: () => taskList,
    ...over,
  };
}

/** Runs a cycle through startPoll's machinery, with the real runCycle and injected steps. */
function startCycle(due, stepSet, hooks = {}) {
  poller.setPollTestHooks({
    steps: stepSet,
    runCycle: (_d, token) => poller.runCycle(due, token),
    ...hooks,
  });
  return poller.startPoll();
}

test('phases overlap; counters per phase, sums, step = lowest started unfinished; idle afterwards', async () => {
  const seen = [];
  const on = (s) => seen.push(JSON.parse(JSON.stringify(s)));
  poller.pollEvents.on('poll', on);
  const { started, promise } = startCycle(projects(2), steps(tasks(3), {
    pollProject: () => sleep(5),
    refreshClassification: () => sleep(3),
  }), { throttleMs: 0 });
  assert.equal(started, true);
  await promise;
  poller.pollEvents.off('poll', on);

  const running = seen.filter((s) => s.running && s.step);
  assert.ok(running.length > 0);
  let prevTotal = 0;
  for (const s of running) {
    assert.equal(s.stepCount, 7);
    assert.equal(s.stepIndex, ['listing', 'sweep', 'fetch', 'classify', 'branches', 'checks', 'crs'].indexOf(s.step) + 1);
    const sumDone = Object.values(s.phases).reduce((a, p) => a + p.done, 0);
    const sumTotal = Object.values(s.phases).reduce((a, p) => a + p.total, 0);
    assert.equal(s.done, sumDone);
    assert.equal(s.total, sumTotal);
    assert.ok(s.total >= prevTotal, 'total never decreases');
    prevTotal = s.total;
    for (const p of Object.values(s.phases)) assert.ok(p.done <= p.total);
  }
  const final = running.at(-1);
  assert.deepEqual(final.phases.listing, { done: 2, total: 2 });
  assert.deepEqual(final.phases.fetch, { done: 2, total: 2 });
  assert.deepEqual(final.phases.checks, { done: 2, total: 2 });
  // listTasks hands the same 3 tasks (project p0) to each project chain but p1 filters them out.
  assert.deepEqual(final.phases.classify, { done: 3, total: 3 });
  assert.deepEqual(final.phases.branches, { done: 3, total: 3 });
  assert.deepEqual(final.phases.crs, { done: 3, total: 3 });

  const st = poller.pollStatus();
  assert.equal(st.running, false);
  assert.equal(st.cancelling, false);
  assert.equal(st.step, null);
  assert.equal(st.done, 0);
  assert.equal(st.total, 0);
  assert.deepEqual(st.phases.listing, { done: 0, total: 0 });
  assert.equal(seen.at(-1).running, false);
  assert.equal(st.last.error, null);
  assert.equal(typeof st.last.finishedAt, 'string');
  assert.ok(st.lastPollAt);
});

test('inside a loop the event is throttled and the final count is not lost', async () => {
  const seen = [];
  let last = -1;
  const on = (s) => { if (s.running && s.phases.classify.done !== last) { last = s.phases.classify.done; seen.push(last); } };
  poller.pollEvents.on('poll', on);
  const { promise } = startCycle(projects(1), steps(tasks(40), {
    refreshClassification: () => sleep(2),
  }), { throttleMs: 60 });
  await promise;
  poller.pollEvents.off('poll', on);
  // 40 tasks, 4 at a time, ~2 ms each: a short loop, far fewer emits than tasks.
  assert.ok(seen.length <= 12,`too many emits: ${seen.length}`);
  assert.equal(seen.at(-1), 40);
});

test('concurrency: at most 6 task steps overall, per-project fetches 3', async () => {
  let active = 0;
  let max = 0;
  let fActive = 0;
  let fMax = 0;
  const gate = (value) => async () => {
    active++;
    max = Math.max(max, active);
    await sleep(5);
    active--;
    return value;
  };
  const { promise } = startCycle(projects(8), steps(tasks(30), {
    refreshClassification: gate(),
    refreshBranchStatus: gate(),
    checkChangeRequests: gate(0),
    listAllBranches: async () => { fActive++; fMax = Math.max(fMax, fActive); await sleep(5); fActive--; },
  }));
  await promise;
  assert.equal(max, 6);
  assert.equal(fMax, 3);
});

test('an error in one task is isolated: the rest still run', async () => {
  let ran = 0;
  const { promise } = startCycle(projects(1), steps(tasks(6), {
    refreshClassification: async (t) => { ran++; if (t.issue === 2) throw new Error('boom'); },
  }));
  const res = await promise;
  assert.equal(ran, 6);
  assert.equal(res.error, undefined);
});

test('without the split checks exports, refreshChecks is called once per due project', async () => {
  const args = [];
  const { promise } = startCycle(projects(3), steps([], {
    prefetchChecks: undefined, applyChecksForTask: undefined,
    refreshChecks: async (a) => { args.push(a); },
  }));
  await promise;
  assert.deepEqual(args.map((a) => a.projects).sort(), [['p0'], ['p1'], ['p2']]);
});

test('cancel: no new work starts, in-flight finishes, status ends running:false cancelling:false', async () => {
  const stamp = poller.pollStatus().lastPollAt;
  let started = 0;
  let finished = 0;
  const seen = [];
  const on = (s) => seen.push({ running: s.running, cancelling: s.cancelling });
  poller.pollEvents.on('poll', on);
  const { promise } = startCycle(projects(1), steps(tasks(20), {
    refreshClassification: async () => { started++; await sleep(15); finished++; },
  }));
  await sleep(20);
  const mid = poller.cancelPoll();
  assert.equal(mid.running, true);
  assert.equal(mid.cancelling, true);
  const res = await promise;
  poller.pollEvents.off('poll', on);
  assert.equal(res.error, 'cancelled');
  assert.equal(started, finished);
  assert.ok(started >= 1 && started < 20, `started ${started}`);
  const st = poller.pollStatus();
  assert.equal(st.running, false);
  assert.equal(st.cancelling, false);
  assert.equal(st.last.error, 'cancelled');
  assert.equal(st.lastPollAt, stamp);
  assert.ok(seen.some((s) => s.cancelling));
  assert.deepEqual(seen.at(-1), { running: false, cancelling: false });
  // a fresh cycle is not cancelled by the old token
  const next = startCycle(projects(1), steps(tasks(2)));
  assert.equal(next.started, true);
  assert.equal((await next.promise).error, undefined);
});

test('cancelPoll with nothing running is a harmless status read', () => {
  const st = poller.cancelPoll();
  assert.equal(st.running, false);
  assert.equal(st.cancelling, false);
});

test('startPoll while a cycle runs joins it: started:false', async () => {
  let release;
  const a = startCycle(projects(1), steps([], { pollProject: () => new Promise((r) => { release = r; }) }));
  await sleep(5);
  const b = poller.startPoll();
  assert.equal(b.started, false);
  assert.equal(b.promise, a.promise);
  release();
  await a.promise;
});

test('the watchdog cancels the abandoned cycle token, which stops starting work', async () => {
  let tokenSeen;
  let started = 0;
  poller.setPollTestHooks({
    watchdogMs: 30,
    steps: steps(tasks(50), { refreshClassification: async () => { started++; await sleep(10); } }),
    runCycle: (_d, token) => { tokenSeen = token; return poller.runCycle(projects(1), token); },
  });
  const res = await poller.pollNow();
  assert.match(res.error, /watchdog/);
  assert.equal(tokenSeen.cancelled, true);
  assert.equal(poller.pollStatus().running, false);
  await sleep(60);
  const settled = started;
  await sleep(60);
  assert.equal(started, settled, 'the abandoned cycle keeps starting work');
  assert.ok(started < 50);
  // the next cycle is independent
  poller.setPollTestHooks({ steps: steps([]), runCycle: (_d, token) => poller.runCycle(projects(1), token) });
  assert.equal((await poller.pollNow()).error, undefined);
});
