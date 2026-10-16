import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { viewMessage, shouldSend } from '../../web/src/viewReport.js';

const src = (p) => readFileSync(new URL(`../../web/src/${p}`, import.meta.url), 'utf8');

test('viewMessage: a project or null, and a real boolean', () => {
  assert.deepEqual(viewMessage('a', true), { type: 'view', project: 'a', visible: true });
  assert.deepEqual(viewMessage(null, false), { type: 'view', project: null, visible: false });
  assert.deepEqual(viewMessage('', 1), { type: 'view', project: null, visible: true });
  assert.deepEqual(viewMessage(undefined, undefined), { type: 'view', project: null, visible: false });
});

test('shouldSend: first one always, identical ones never, any change yes', () => {
  const a = viewMessage('a', true);
  assert.equal(shouldSend(null, a), true);
  assert.equal(shouldSend(a, viewMessage('a', true)), false);
  assert.equal(shouldSend(a, viewMessage('b', true)), true);
  assert.equal(shouldSend(a, viewMessage('a', false)), true);
  assert.equal(shouldSend(a, viewMessage(null, true)), true);
});

test('source pins: api.js sends on open and resets the dedupe per socket', () => {
  const api = src('api.js');
  assert.match(api, /export function reportView/);
  assert.match(api, /sentView = null;/);
  assert.match(api, /socket\.onopen = \(\) => \{[^}]*flushView\(\)/);
  assert.match(api, /readyState !== WebSocket\.OPEN/);
});

test('source pins: App.jsx reports project, visibilitychange, pagehide', () => {
  const app = src('App.jsx');
  assert.match(app, /reportView\(activeProject\)/);
  assert.match(app, /addEventListener\('visibilitychange'/);
  assert.match(app, /addEventListener\('pagehide'/);
  assert.match(app, /reportView\(activeProject, false\)/);
});

test('source pins: pollNow sends only the open project', () => {
  assert.match(src('api.js'), /pollNow: \(project\) => send\('\/api\/poll', project \? \{ project \} : undefined, 'POST', POLL_TIMEOUT_MS\)/);
  assert.match(src('App.jsx'), /api\.pollNow\(activeProject\)/);
});
