import './isolate.mjs';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

let poller; let pipeline; let viewers;
before(async () => {
  poller = await import('../src/poller.js');
  viewers = await import('../src/viewers.js');
  pipeline = await import('../src/pipeline.js');
});
afterEach(() => poller.setPollTestHooks());

const noop = async () => {};
const settled = (extra = {}) => ({ project: 'p0', issue: 1, state: 'done', issueClosed: true, classified: true, ...extra });

test('settledDone truth table', () => {
  const { settledDone } = pipeline;
  assert.equal(settledDone(settled()), true);
  assert.equal(settledDone(settled({ prs: [{ number: 1, state: 'MERGED' }, { number: 2, state: 'CLOSED' }] })), true);
  for (const extra of [
    { state: 'assigned' }, { issueClosed: false }, { issueClosed: undefined }, { classified: false },
    { forced: true }, { reopenedAt: 123 },
    { prs: [{ number: 3, state: 'OPEN' }] }, { prs: [{ number: 3, state: 'DRAFT' }] },
  ]) assert.equal(settledDone(settled(extra)), false, JSON.stringify(extra));
});

/** One FULL cycle (levels null) over `list`; returns calls per step and the final phase totals. */
async function fullCycle(list) {
  const calls = { classify: [], branches: [], crs: [] };
  const steps = {
    pollProject: noop,
    sweepClosedIssues: async () => ({ flipped: 0, settled: 0 }),
    listAllBranches: noop,
    refreshClassification: async (t) => { calls.classify.push(t.issue); return true; },
    refreshBranchStatus: async (t) => { calls.branches.push(t.issue); return true; },
    refreshStackHealth: noop,
    refreshChecks: noop,
    prefetchChecks: async () => new Map(),
    applyChecksForTask: noop,
    checkChangeRequests: async (t) => { calls.crs.push(t.issue); return 0; },
    tick: () => {},
    evaluateQuota: () => {},
    listTasks: () => list,
  };
  poller.setPollTestHooks({ steps, projects: () => [{ id: 'p0' }] });
  let phases = null;
  const on = (st) => { if (st.running && st.phases?.classify?.total) phases = JSON.parse(JSON.stringify(st.phases)); };
  poller.pollEvents.on('poll', on);
  await poller.startPoll({ project: 'p0' }).promise;
  poller.pollEvents.off('poll', on);
  return { calls, phases };
}

const realistic = () => [
  ...[1, 2, 3, 4, 5].map((i) => settled({ issue: i })),
  { project: 'p0', issue: 6, state: 'assigned' },
  settled({ issue: 7, prs: [{ number: 70, state: 'OPEN' }] }),
  settled({ issue: 8, classified: false }),
  settled({ issue: 9, forced: true }),
  settled({ issue: 10, issueClosed: false }),
];

test('full cycle walks only the non-settled tasks; totals match', async () => {
  const { calls, phases } = await fullCycle(realistic());
  for (const k of ['classify', 'branches', 'crs']) assert.deepEqual(calls[k].sort((a, b) => a - b), [6, 7, 8, 9, 10], k);
  for (const k of ['classify', 'branches', 'crs']) assert.deepEqual(phases[k].total, 5, k);
});

test('a reopened task (issue no longer closed) is walked again', async () => {
  const t = settled({ issue: 1 });
  assert.equal((await fullCycle([t])).calls.classify.length, 0);
  t.issueClosed = false;
  assert.deepEqual((await fullCycle([t])).calls.classify, [1]);
});

test('light cycle is unchanged: classifies only new open tasks, never walks done ones', async () => {
  const classify = [];
  poller.setPollTestHooks({
    steps: {
      pollProject: noop, sweepClosedIssues: noop, listAllBranches: noop, refreshBranchStatus: noop,
      refreshClassification: async (t) => { classify.push(t.issue); return true; },
      tick: () => {}, evaluateQuota: () => {},
      listTasks: () => realistic(),
    },
    projects: () => [{ id: 'p0' }],
  });
  viewers.resetViewers();
  viewers.setViewerProjectLister(() => ['p0']);
  try { await poller.startPoll().promise; } finally { viewers.setViewerProjectLister(); }
  assert.deepEqual(classify.sort((a, b) => a - b), [6]);
});
