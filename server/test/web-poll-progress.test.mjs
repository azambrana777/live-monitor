import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  POLL_STEPS, POLL_STALE_MS, stepLabelKey, progressText, stepState, phaseState, phaseCounts, overallPercent, isStale, elapsedClock, finishedOutcome,
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

test('progressText: overall done/total, empty otherwise', () => {
  assert.equal(progressText({ running: true, done: 3, total: 12 }), '3/12');
  assert.equal(progressText({ running: true, done: 20, total: 12 }), '12/12');
  assert.equal(progressText({ running: true, done: 0, total: 5 }), '0/5');
  assert.equal(progressText({ running: true, done: 1, total: 0 }), '');
  assert.equal(progressText({ running: false, done: 3, total: 12 }), '');
  assert.equal(progressText(null), '');
});

test('stepState (old server): earlier done, the step active, later pending', () => {
  const poll = { step: 'classify' };
  assert.deepEqual(POLL_STEPS.map((s) => stepState(s, poll)),
    ['done', 'done', 'done', 'active', 'pending', 'pending', 'pending']);
  assert.equal(stepState('listing', { step: null }), 'pending');
});

const ph = (o = {}) => Object.fromEntries(POLL_STEPS.map((k) => [k, { done: 0, total: 0, ...(o[k] || {}) }]));

test('phaseState: several phases can be active at once', () => {
  const phases = ph({ listing: { done: 5, total: 5 }, sweep: { done: 2, total: 9 }, fetch: { done: 1, total: 4 }, classify: { done: 0, total: 6 } });
  const poll = { running: true, step: 'sweep', phases };
  const got = POLL_STEPS.map((k) => phaseState(phases, k, poll));
  assert.deepEqual(got, ['done', 'active', 'active', 'pending', 'pending', 'pending', 'pending']);
  assert.equal(phaseState(phases, 'classify', { running: true, step: 'classify', phases }), 'active');
  assert.equal(phaseState(phases, 'nope', poll), 'pending');
});

test('phaseState: empty and unfinished phases are pending, the step with no total yet is active', () => {
  const phases = ph();
  assert.equal(phaseState(phases, 'listing', { running: true, step: null, phases }), 'pending');
  assert.equal(phaseState(phases, 'listing', { running: true, step: 'listing', phases }), 'active');
});

test('phaseState falls back to the step order when the server sends no phases', () => {
  const poll = { running: true, step: 'fetch' };
  assert.deepEqual(POLL_STEPS.map((k) => phaseState(undefined, k, poll)),
    ['done', 'done', 'active', 'pending', 'pending', 'pending', 'pending']);
  assert.equal(phaseState(null, 'listing', null), 'pending');
});

test('phaseCounts clamps and tolerates garbage', () => {
  assert.deepEqual(phaseCounts({ a: { done: 9, total: 4 } }, 'a'), { done: 4, total: 4 });
  assert.deepEqual(phaseCounts({ a: { done: 'x', total: -1 } }, 'a'), { done: 0, total: 0 });
  assert.equal(phaseCounts({}, 'a'), null);
  assert.equal(phaseCounts(undefined, 'a'), null);
});

test('overallPercent: from the sums, guarded against total 0', () => {
  assert.equal(overallPercent({ running: true, done: 37, total: 210 }), 18);
  assert.equal(overallPercent({ running: true, done: 0, total: 0 }), 0);
  assert.equal(overallPercent({ running: true, done: 300, total: 210 }), 100);
  assert.equal(overallPercent(null), 0);
  assert.equal(overallPercent({ running: true, phases: ph({ fetch: { done: 1, total: 4 } }) }), 25);
});

test('progressText sums phases when the top-level totals are missing', () => {
  assert.equal(progressText({ running: true, phases: ph({ listing: { done: 2, total: 2 }, fetch: { done: 1, total: 4 } }) }), '3/6');
  assert.equal(progressText({ running: true, done: 37, total: 210, phases: ph() }), '37/210');
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
    assert.match(l.topbar.poll.overall, /\{percent\}/);
    assert.match(l.topbar.poll.tooltip, /\{step\} · \{done\}/);
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
  assert.match(pp, /phaseState\(info\?\.phases, s, info\)/);
  assert.match(pp, /role="progressbar"/);
  assert.match(pp, /aria-valuenow=\{percent\}/);
  assert.match(pp, /setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/);
  assert.match(app, /api\.cancelPoll\(\)/);
  assert.match(app, /finishedOutcome\(wasRunning\.current, pollInfo\)/);
  assert.match(app, /info\.progressAt \?\? info\.startedAt/);
  assert.match(css, /\.pp-step \{ min-height: 44px; \}/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|!important/);
  assert.match(read('web/src/main.jsx'), /styles\/poll-progress\.css/);
});
