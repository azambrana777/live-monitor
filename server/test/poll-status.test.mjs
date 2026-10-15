import './isolate.mjs';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

let poller;
before(async () => { poller = await import('../src/poller.js'); });
afterEach(() => poller.setPollTestHooks());

test('after a cycle the status is running:false with startedAt null, and the last emit says so', async () => {
  poller.setPollTestHooks({ runCycle: async () => ({}) });
  const seen = [];
  const on = (s) => seen.push(s);
  poller.pollEvents.on('poll', on);
  const p = poller.pollNow();
  assert.equal(poller.pollStatus().running, true);
  assert.equal(typeof poller.pollStatus().startedAt, 'number');
  await p;
  poller.pollEvents.off('poll', on);
  assert.equal(poller.pollStatus().running, false);
  assert.equal(poller.pollStatus().startedAt, null);
  assert.equal(seen.at(-1).running, false);
  assert.equal(seen.at(-1).startedAt, null);
});

test('a hung cycle is released by the watchdog and a new poll can start', async () => {
  poller.setPollTestHooks({ watchdogMs: 30, runCycle: () => new Promise(() => {}) });
  const seen = [];
  const on = (s) => seen.push(s);
  poller.pollEvents.on('poll', on);
  const hung = await poller.pollNow();
  poller.pollEvents.off('poll', on);
  assert.match(hung.error, /watchdog/);
  assert.equal(poller.pollStatus().running, false);
  assert.equal(poller.pollStatus().startedAt, null);
  assert.equal(seen.at(-1).running, false);
  poller.setPollTestHooks({ runCycle: async () => ({ ok: 1 }) });
  assert.deepEqual(await poller.pollNow(), { ok: 1 });
});

test('shortestGitRefreshSeconds ignores 0 and non-numbers; null when nothing is on', () => {
  assert.equal(poller.shortestGitRefreshSeconds([300, 0, 60]), 60);
  assert.equal(poller.shortestGitRefreshSeconds([0, 0]), null);
  assert.equal(poller.shortestGitRefreshSeconds([]), null);
  assert.equal(poller.shortestGitRefreshSeconds([undefined, 120]), 120);
});

test('gitRefreshTick skips while a refresh runs and swallows errors', async () => {
  let release;
  const slow = () => new Promise((r) => { release = r; });
  const first = poller.gitRefreshTick(slow);
  assert.equal(await poller.gitRefreshTick(async () => { throw new Error('no'); }), false);
  release();
  assert.equal(await first, true);
  assert.equal(await poller.gitRefreshTick(async () => { throw new Error('boom'); }), true);
});
