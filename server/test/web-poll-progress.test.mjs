import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  POLL_STEPS, POLL_STALE_MS, stepLabelKey, progressText, stepState, isStale, elapsedClock, finishedOutcome,
} from '../../web/src/pollProgress.js';
import es from '../../web/src/i18n/strings/es.js';
import en from '../../web/src/i18n/strings/en.js';
import fr from '../../web/src/i18n/strings/fr.js';
import de from '../../web/src/i18n/strings/de.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

test('stepLabelKey knows the seven steps and nothing else', () => {
  assert.equal(POLL_STEPS.length, 7);
  for (const s of POLL_STEPS) assert.equal(stepLabelKey(s), s);
  assert.equal(stepLabelKey(null), null);
  assert.equal(stepLabelKey('bogus'), null);
});

test('progressText: done/total of the running step, empty otherwise', () => {
  assert.equal(progressText({ running: true, done: 3, total: 12 }), '3/12');
  assert.equal(progressText({ running: true, done: 20, total: 12 }), '12/12');
  assert.equal(progressText({ running: true, done: 0, total: 5 }), '0/5');
  assert.equal(progressText({ running: true, done: 1, total: 0 }), '');
  assert.equal(progressText({ running: false, done: 3, total: 12 }), '');
  assert.equal(progressText(null), '');
});

test('stepState marks earlier steps done, the current one, and later ones pending', () => {
  const poll = { step: 'classify' };
  assert.deepEqual(POLL_STEPS.map((s) => stepState(s, poll)),
    ['done', 'done', 'done', 'current', 'pending', 'pending', 'pending']);
  assert.equal(stepState('listing', { step: null }), 'pending');
});

test('isStale: ten minutes without progress; progress resets it', () => {
  const now = 10_000_000;
  assert.equal(isStale({ running: false, startedAt: 0 }, now), false);
  assert.equal(isStale({ running: true, startedAt: now - POLL_STALE_MS - 1 }, now), true);
  assert.equal(isStale({ running: true, startedAt: now - POLL_STALE_MS - 1, progressAt: now - 1000 }, now), false);
  assert.equal(isStale({ running: true, startedAt: now - 1000 }, now), false);
  assert.equal(isStale({ running: true }, now), false);
  assert.equal(isStale({ running: true }, now, now - POLL_STALE_MS - 1), true);
});

test('elapsedClock formats m:ss and h:mm:ss', () => {
  assert.equal(elapsedClock(0), '0:00');
  assert.equal(elapsedClock(65_000), '1:05');
  assert.equal(elapsedClock(3_725_000), '1:02:05');
  assert.equal(elapsedClock(-1), '');
  assert.equal(elapsedClock(NaN), '');
});

test('finishedOutcome speaks only on running true -> false with `last`', () => {
  const last = { tasks: 2, changeRequests: 1 };
  assert.deepEqual(finishedOutcome(true, { running: false, last }), { tasks: 2, changeRequests: 1 });
  assert.equal(finishedOutcome(false, { running: false, last }), null);
  assert.equal(finishedOutcome(true, { running: true, last }), null);
  assert.equal(finishedOutcome(true, { running: false, last: null }), null);
  assert.deepEqual(finishedOutcome(true, { running: false, last: { error: 'boom' } }), { error: 'boom' });
  assert.deepEqual(finishedOutcome(true, { running: false, last: { error: 'cancelled' } }), { cancelled: true });
});

test('the catalog has the poll strings in all four languages, same keys', () => {
  const keys = Object.keys(es.topbar.poll).sort();
  for (const l of [en, fr, de]) assert.deepEqual(Object.keys(l.topbar.poll).sort(), keys);
  for (const l of [es, en, fr, de]) {
    assert.deepEqual(Object.keys(l.topbar.poll.steps), POLL_STEPS);
    for (const k of ['progress', 'tooltip']) assert.match(l.topbar.poll[k], /\{done\}.*\{total\}/);
  }
  assert.equal(es.topbar.poll.cancel, 'Cancelar búsqueda');
  assert.equal(es.topbar.poll.cancelling, 'Cancelando…');
});

// Source-pinned: the web has no browser runner.
test('PollProgress wiring is pinned as source', () => {
  const pp = read('web/src/components/topbar/PollProgress.jsx');
  const app = read('web/src/App.jsx');
  const css = read('web/src/styles/poll-progress.css');
  assert.match(pp, /aria-live="polite"/);
  assert.match(pp, /disabled=\{cancelling\}/);
  assert.match(pp, /onClick=\{onCancel\}/);
  assert.match(pp, /usePopover/);
  assert.match(pp, /setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/);
  assert.match(app, /api\.cancelPoll\(\)/);
  assert.match(app, /finishedOutcome\(wasRunning\.current, pollInfo\)/);
  assert.match(app, /info\.progressAt \?\? info\.startedAt/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|!important/);
  assert.match(read('web/src/main.jsx'), /styles\/poll-progress\.css/);
});
