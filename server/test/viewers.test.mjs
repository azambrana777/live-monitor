import './isolate.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const v = await import('../src/viewers.js');

beforeEach(() => {
  v.resetViewers();
  v.setViewerProjectLister(() => ['a', 'b', 'c']);
});

const sock = () => ({});

test('nobody connected: empty set', () => {
  assert.deepEqual([...v.viewedProjects()], []);
});

test('several connections with different projects all count; hidden ones do not', () => {
  const s1 = sock(); const s2 = sock(); const s3 = sock();
  v.setView(s1, { project: 'a', visible: true });
  v.setView(s2, { project: 'b', visible: true });
  v.setView(s3, { project: 'c', visible: false });
  assert.deepEqual([...v.viewedProjects()].sort(), ['a', 'b']);
  v.setView(s2, { project: 'b', visible: false });
  assert.deepEqual([...v.viewedProjects()], ['a']);
});

test('a project stays viewed while any connection still shows it; drop removes a connection', () => {
  const s1 = sock(); const s2 = sock();
  v.setView(s1, { project: 'a', visible: true });
  v.setView(s2, { project: 'a', visible: true });
  v.drop(s1);
  assert.deepEqual([...v.viewedProjects()], ['a']);
  v.drop(s2);
  assert.deepEqual([...v.viewedProjects()], []);
  v.drop(s2); // idempotent
});

test('a connection reports only its latest view', () => {
  const s = sock();
  v.setView(s, { project: 'a', visible: true });
  v.setView(s, { project: 'b', visible: true });
  assert.deepEqual([...v.viewedProjects()], ['b']);
  v.setView(s, { project: null, visible: true });
  assert.deepEqual([...v.viewedProjects()], []);
});

test('unknown ids and malformed values are ignored', () => {
  const s = sock();
  v.setView(s, { project: 'zzz', visible: true });
  assert.deepEqual([...v.viewedProjects()], []);
  v.setView(s, { project: 'a', visible: 'yes' });
  assert.deepEqual([...v.viewedProjects()], []);
  v.setView(s, { project: 42, visible: true });
  assert.deepEqual([...v.viewedProjects()], []);
});

test('viewed events fire only when a project enters or leaves the set', () => {
  const events = [];
  v.viewerEvents.on('viewed', (e) => events.push(e));
  const s1 = sock(); const s2 = sock();
  v.setView(s1, { project: 'a', visible: true });
  v.setView(s2, { project: 'a', visible: true }); // already viewed: no event
  v.drop(s1); // still viewed by s2: no event
  v.setView(s2, { project: 'b', visible: true }); // a leaves, b enters
  v.drop(s2);
  assert.deepEqual(events, [
    { project: 'a', added: true },
    { project: 'b', added: true },
    { project: 'a', added: false },
    { project: 'b', added: false },
  ]);
});

test('handleViewMessage: only view messages, bad payloads mean not viewing', () => {
  const s = sock();
  assert.equal(v.handleViewMessage(s, { type: 'chat' }), false);
  assert.equal(v.handleViewMessage(s, null), false);
  assert.equal(v.handleViewMessage(s, { type: 'view', project: 'c', visible: true }), true);
  assert.deepEqual([...v.viewedProjects()], ['c']);
  assert.equal(v.handleViewMessage(s, { type: 'view', project: 'c' }), true);
  assert.deepEqual([...v.viewedProjects()], []);
});
