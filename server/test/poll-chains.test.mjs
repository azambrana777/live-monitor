import './isolate.mjs';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

let poller;
before(async () => { poller = await import('../src/poller.js'); });
afterEach(() => poller.setPollTestHooks());

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const projects = (...ids) => ids.map((id) => ({ id }));
const noop = async () => {};
const T = (project, issue) => ({ project, issue });

/** A timeline: every step logs `start:`/`end:` entries in the order they happen. */
function harness({ taskList, lat = {} }) {
  const log = [];
  const at = (name) => log.indexOf(name);
  const label = (t) => `${t.project}#${t.issue}`;
  const wrap = (name, fn = noop) => async (task) => {
    log.push(`start:${name}:${label(task)}`);
    await sleep(lat[name] ?? 2);
    const r = await fn(task);
    log.push(`end:${name}:${label(task)}`);
    return r;
  };
  const steps = {
    pollProject: async (p) => { log.push(`start:listing:${p.id}`); await sleep(lat.listing ?? 2); log.push(`end:listing:${p.id}`); },
    sweepClosedIssues: async (p) => { log.push(`start:sweep:${p.id}`); await sleep(lat.sweep ?? 2); log.push(`end:sweep:${p.id}`); return { flipped: 0, settled: 0 }; },
    listAllBranches: async ({ project }) => { log.push(`start:fetch:${project}`); await sleep(lat.fetch ?? 2); log.push(`end:fetch:${project}`); },
    refreshClassification: wrap('classify'),
    refreshBranchStatus: wrap('branches'),
    refreshStackHealth: noop,
    checkChangeRequests: wrap('crs', async () => 0),
    prefetchChecks: async (id) => { log.push(`start:prefetch:${id}`); await sleep(lat.prefetch ?? 2); log.push(`end:prefetch:${id}`); return new Map(); },
    applyChecksForTask: wrap('apply'),
    refreshChecks: noop,
    tick: () => { log.push('tick'); },
    evaluateQuota: () => { log.push('quota'); },
    listTasks: (set) => taskList.filter((t) => set.has(t.project)),
  };
  return { log, steps, at };
}

function run(due, steps, hooks = {}) {
  poller.setPollTestHooks({ steps, runCycle: (_d, token) => poller.runCycle(due, token), ...hooks });
  return poller.startPoll();
}

test('classify never starts before its own project sweep ends; fetch starts at t=0 before any listing ends', async () => {
  const h = harness({ taskList: [T('a', 1), T('b', 2)], lat: { listing: 10 } });
  await run(projects('a', 'b'), h.steps).promise;
  assert.ok(h.at('start:fetch:a') < h.at('end:listing:a'));
  assert.ok(h.at('start:fetch:b') < h.at('end:listing:a'));
  assert.ok(h.at('start:prefetch:a') < h.at('end:listing:a'));
  assert.ok(h.at('end:sweep:a') < h.at('start:classify:a#1'));
  assert.ok(h.at('end:sweep:b') < h.at('start:classify:b#2'));
  assert.ok(h.at('end:fetch:a') < h.at('start:classify:a#1'));
  assert.ok(h.at('end:sweep:a') < h.at('start:branches:a#1'));
});

test('two projects overlap in time: a slow project does not hold the other', async () => {
  const h = harness({ taskList: [T('slow', 1), T('fast', 2)] });
  h.steps.pollProject = async (p) => { h.log.push(`start:listing:${p.id}`); await sleep(p.id === 'slow' ? 60 : 2); h.log.push(`end:listing:${p.id}`); };
  await run(projects('slow', 'fast'), h.steps).promise;
  assert.ok(h.at('end:crs:fast#2') < h.at('end:listing:slow'), 'fast project finished everything before slow listing ended');
});

test('classify and branches of one task run concurrently', async () => {
  const h = harness({ taskList: [T('a', 1)], lat: { classify: 20, branches: 20 } });
  await run(projects('a'), h.steps).promise;
  assert.ok(h.at('start:branches:a#1') < h.at('end:classify:a#1'));
  assert.ok(h.at('start:classify:a#1') < h.at('end:branches:a#1'));
});

test('applyChecks waits for classify AND branches of the same task; crs waits only for classify', async () => {
  for (const [slow, fast] of [['classify', 'branches'], ['branches', 'classify']]) {
    const h = harness({ taskList: [T('a', 1)], lat: { [slow]: 30, [fast]: 2 } });
    await run(projects('a'), h.steps).promise;
    assert.ok(h.at('start:apply:a#1') > h.at('end:classify:a#1'));
    assert.ok(h.at('start:apply:a#1') > h.at('end:branches:a#1'));
    assert.ok(h.at('start:crs:a#1') > h.at('end:classify:a#1'));
    if (slow === 'branches') assert.ok(h.at('start:crs:a#1') < h.at('end:branches:a#1'), 'crs does not wait for branches');
  }
});

test('early tick after all classify of all projects; final tick after everything; then quota', async () => {
  const h = harness({ taskList: [T('a', 1), T('b', 2)], lat: { crs: 30, apply: 30 } });
  await run(projects('a', 'b'), h.steps).promise;
  const ticks = h.log.map((e, i) => (e === 'tick' ? i : -1)).filter((i) => i >= 0);
  assert.equal(ticks.length, 2);
  const lastClassify = Math.max(h.at('end:classify:a#1'), h.at('end:classify:b#2'));
  assert.ok(ticks[0] > lastClassify);
  assert.ok(ticks[0] < h.at('end:crs:a#1'), 'early tick does not wait for crs');
  assert.ok(ticks[1] > h.at('end:crs:a#1') && ticks[1] > h.at('end:apply:b#2'));
  assert.equal(h.log.at(-1), 'quota');
});

test('a failing project listing does not hold the early tick', async () => {
  const h = harness({ taskList: [T('a', 1), T('b', 2)] });
  h.steps.pollProject = async (p) => { if (p.id === 'b') throw new Error('gh down'); };
  const res = await run(projects('a', 'b'), h.steps).promise;
  assert.match(res.error, /gh down/);
  assert.equal(h.log.filter((e) => e === 'tick').length, 2);
});

test('cancel mid-chain stops further phases and tasks; ends cancelled with only the final tick', async () => {
  const taskList = Array.from({ length: 30 }, (_, i) => T('a', i + 1));
  const h = harness({ taskList, lat: { classify: 15, branches: 15 } });
  const { promise } = run(projects('a'), h.steps);
  await sleep(40);
  poller.cancelPoll();
  const res = await promise;
  assert.equal(res.error, 'cancelled');
  const starts = h.log.filter((e) => e.startsWith('start:classify')).length;
  assert.ok(starts >= 1 && starts < 30, `started ${starts}`);
  assert.equal(starts, h.log.filter((e) => e.startsWith('end:classify')).length);
  assert.equal(h.log.filter((e) => e === 'tick').length, 1);
  const st = poller.pollStatus();
  assert.deepEqual([st.running, st.cancelling, st.last.error], [false, false, 'cancelled']);
});

test('cancel during listing: sweep and tasks never start', async () => {
  const h = harness({ taskList: [T('a', 1)], lat: { listing: 30 } });
  const { promise } = run(projects('a'), h.steps);
  await sleep(10);
  poller.cancelPoll();
  await promise;
  assert.ok(!h.log.some((e) => e.startsWith('start:sweep') || e.startsWith('start:classify')));
});

test('phase counters: totals grow as work is discovered, step is the lowest unfinished started phase', async () => {
  const h = harness({ taskList: [T('a', 1), T('a', 2), T('a', 3)], lat: { listing: 20 } });
  const seen = [];
  const on = (s) => seen.push(JSON.parse(JSON.stringify(s)));
  poller.pollEvents.on('poll', on);
  await run(projects('a', 'b'), h.steps, { throttleMs: 0 }).promise;
  poller.pollEvents.off('poll', on);
  const early = seen.find((s) => s.running && s.phases.fetch.total === 2);
  assert.ok(early, 'fetch totals are known at t=0');
  assert.equal(early.phases.classify.total, 0, 'classify total not known before listing');
  assert.equal(early.step, 'listing');
  const last = seen.filter((s) => s.running).at(-1);
  assert.equal(last.phases.classify.total, 3);
  for (const k of ['listing', 'sweep', 'fetch', 'checks']) assert.deepEqual(last.phases[k], { done: 2, total: 2 });
  assert.equal(last.done, last.total);
  let prev = 0;
  for (const s of seen.filter((x) => x.running)) {
    assert.equal(s.total, Object.values(s.phases).reduce((a, p) => a + p.total, 0));
    assert.ok(s.total >= prev);
    prev = s.total;
  }
});

test('caps: 6 task steps overall, 4 tasks per project, 3 fetches', async () => {
  const taskList = ['a', 'b', 'c', 'd'].flatMap((p) => Array.from({ length: 12 }, (_, i) => T(p, i + 1)));
  const h = harness({ taskList });
  let active = 0;
  let maxActive = 0;
  let fa = 0;
  let fm = 0;
  const inTask = new Map();
  let maxTasksOfProject = 0;
  const gate = async (t) => {
    active++; maxActive = Math.max(maxActive, active);
    await sleep(4);
    active--;
  };
  h.steps.refreshClassification = gate;
  h.steps.refreshBranchStatus = gate;
  h.steps.checkChangeRequests = async () => 0;
  // Tasks of one project in flight = tasks whose classify started and whose apply has not ended.
  h.steps.applyChecksForTask = async () => {};
  h.steps.listAllBranches = async () => { fa++; fm = Math.max(fm, fa); await sleep(4); fa--; };
  const origC = h.steps.refreshClassification;
  h.steps.refreshClassification = async (t) => {
    inTask.set(t.project, (inTask.get(t.project) ?? 0) + 1);
    maxTasksOfProject = Math.max(maxTasksOfProject, inTask.get(t.project));
    await origC(t);
  };
  const origA = h.steps.applyChecksForTask;
  h.steps.applyChecksForTask = async (t) => { await origA(t); inTask.set(t.project, inTask.get(t.project) - 1); };
  await run(projects('a', 'b', 'c', 'd'), h.steps).promise;
  assert.ok(maxActive <= 6 && maxActive >= 5, `maxActive ${maxActive}`);
  assert.ok(maxTasksOfProject <= 4, `per project ${maxTasksOfProject}`);
  assert.ok(fm <= 3 && fm >= 2, `fetch ${fm}`);
});
