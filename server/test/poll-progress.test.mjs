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

test('phases are reported in order with done/total, and the status is idle afterwards', async () => {
  const seen = [];
  const on = (s) => seen.push({ ...s });
  poller.pollEvents.on('poll', on);
  const { started, promise } = startCycle(projects(2), steps(tasks(3)), { throttleMs: 0 });
  assert.equal(started, true);
  await promise;
  poller.pollEvents.off('poll', on);

  const order = [];
  for (const s of seen) if (s.step && order.at(-1) !== s.step) order.push(s.step);
  assert.deepEqual(order, ['listing', 'sweep', 'fetch', 'classify', 'branches', 'checks', 'crs']);
  for (const s of seen.filter((x) => x.step)) {
    assert.equal(s.stepCount, 7);
    assert.equal(s.stepIndex, order.indexOf(s.step) + 1);
  }
  const lastOf = (step) => seen.filter((s) => s.step === step).at(-1);
  assert.deepEqual([lastOf('listing').done, lastOf('listing').total], [2, 2]);
  assert.deepEqual([lastOf('classify').done, lastOf('classify').total], [3, 3]);
  assert.deepEqual([lastOf('crs').done, lastOf('crs').total], [3, 3]);

  const st = poller.pollStatus();
  assert.equal(st.running, false);
  assert.equal(st.cancelling, false);
  assert.equal(st.step, null);
  assert.equal(st.done, 0);
  assert.equal(st.total, 0);
  assert.equal(seen.at(-1).running, false);
  assert.equal(st.last.error, null);
  assert.equal(typeof st.last.finishedAt, 'string');
  assert.ok(st.lastPollAt);
});

test('inside a loop the event is throttled and the final count is not lost', async () => {
  const seen = [];
  const on = (s) => { if (s.step === 'classify') seen.push(s.done); };
  poller.pollEvents.on('poll', on);
  const { promise } = startCycle(projects(1), steps(tasks(40), {
    refreshClassification: () => sleep(2),
  }), { throttleMs: 60 });
  await promise;
  poller.pollEvents.off('poll', on);
  // 40 tasks, 4 at a time, ~2 ms each: a short loop, far fewer emits than tasks.
  assert.ok(seen.length <= 6, `too many emits: ${seen.length}`);
  assert.equal(seen.at(-1), 40);
});

test('concurrency of the per-task phases never exceeds 4, and per-project fetches 3', async () => {
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
  assert.equal(max, 4);
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

test('refreshChecks is called with the due project ids', async () => {
  let arg;
  const { promise } = startCycle(projects(3), steps([], { refreshChecks: async (a) => { arg = a; } }));
  await promise;
  assert.deepEqual(arg, { projects: ['p0', 'p1', 'p2'] });
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
