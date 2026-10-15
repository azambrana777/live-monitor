import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/config.js';
import { shortestPollMinutes } from '../src/poller.js';

const FILE = path.join(DATA_DIR, 'projects.json');
const REMOVED = path.join(DATA_DIR, 'projects-removed.json');
let seq = 0;

function fresh(contents) {
  rmSync(REMOVED, { force: true });
  writeFileSync(FILE, JSON.stringify(contents, null, 2), 'utf8');
  seq += 1;
  return import(`../src/projects.js?removed=${seq}`);
}

const entry = (over = {}) => ({
  id: 'beta', name: 'beta', repoPath: 'C:\\Work\\Beta', worktreeRoot: 'C:\\Work\\Beta-wt',
  repo: null, assignee: 'me', reviewer: 'rev', baseBranch: 'develop', kind: 'node-web', overrides: {},
  ...over,
});

test('removeProject keeps the entry in projects-removed.json, matched by repoPath or id', async () => {
  const m = await fresh([entry({ restricted: true }), entry({ id: 'gamma', repoPath: '/g' })]);
  assert.equal(existsSync(REMOVED), false, 'nothing written before a remove');
  m.removeProject('beta');
  const kept = JSON.parse(readFileSync(REMOVED, 'utf8'));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].reviewer, 'rev');
  assert.equal(kept[0].baseBranch, 'develop');

  assert.equal(m.removedProjectFor({ repoPath: 'c:/work/beta/' }).id, 'beta', 'slashes and case normalised');
  assert.equal(m.removedProjectFor({ id: 'beta' }).kind, 'node-web');
  assert.equal(m.removedProjectFor({ id: 'other', repoPath: '/nowhere' }), undefined);

  m.forgetRemovedProject({ repoPath: 'C:\\WORK\\BETA' });
  assert.deepEqual(JSON.parse(readFileSync(REMOVED, 'utf8')), []);
  rmSync(REMOVED, { force: true });
  rmSync(FILE, { force: true });
});

test('removing twice does not duplicate the removed entry', async () => {
  const m = await fresh([entry()]);
  m.removeProject('beta');
  m.saveProjects([entry({ reviewer: 'new' })]);
  m.removeProject('beta');
  const kept = JSON.parse(readFileSync(REMOVED, 'utf8'));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].reviewer, 'new');
  rmSync(REMOVED, { force: true });
  rmSync(FILE, { force: true });
});

test('the poll timer guard: an empty registry gives no period instead of Infinity', () => {
  assert.equal(shortestPollMinutes([]), null);
  assert.equal(shortestPollMinutes([5, 2, 9]), 2);
  assert.equal(shortestPollMinutes([0]), null);
});
