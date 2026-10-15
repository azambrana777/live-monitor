// Git refresh button, setting and stale-poll guard. The web has no browser runner:
// UI wiring is pinned as source text (not exercised in a browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const api = read('web/src/api.js');
const app = read('web/src/App.jsx');
const topbar = read('web/src/components/topbar/Topbar.jsx');
const menu = read('web/src/components/topbar/SettingsMenu.jsx');

test('api: refreshGit posts to /api/git/refresh and both calls have a client timeout', () => {
  assert.match(api, /refreshGit: \(project\) => send\('\/api\/git\/refresh'/);
  assert.match(api, /pollNow: \(\) => send\('\/api\/poll', undefined, 'POST', POLL_TIMEOUT_MS\)/);
  assert.match(api, /AbortController/);
  assert.match(api, /POLL_TIMEOUT_MS = 3 \* 60 \* 1000/);
  assert.match(api, /GIT_TIMEOUT_MS = 2 \* 60 \* 1000/);
});

test('App: stale `running` is ignored after 10 min and re-evaluated every 30 s', () => {
  assert.match(app, /POLL_STALE_MS = 10 \* 60 \* 1000/);
  assert.match(app, /setInterval\(\(\) => setNow\(Date\.now\(\)\), 30000\)/);
  assert.match(app, /const buscando = polling \|\| serverRunning/);
  assert.match(app, /gitRefresh=\{\{ busy: refreshingGit, run: runGitRefresh \}\}/);
  assert.match(app, /api\.refreshGit\(activeProject\)/);
});

test('Topbar: the git button is disabled and aria-busy while busy', () => {
  assert.match(topbar, /tb-git/);
  assert.match(topbar, /disabled=\{gitRefresh\.busy\}/);
  assert.match(topbar, /aria-busy=\{gitRefresh\.busy\}/);
});

test('SettingsMenu: the git row saves gitRefreshSeconds, default 300', () => {
  assert.match(menu, /eff\('gitRefreshSeconds'\) \?\? 300/);
  assert.match(menu, /GIT_REFRESH_OPTIONS = \[0, 30, 60, 120, 300, 600\]/);
  assert.match(menu, /saveProjectSetting\(\{ gitRefreshSeconds: s \}\)/);
});
