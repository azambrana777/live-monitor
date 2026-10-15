import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const ap = await import('../../web/src/activeProject.js');
const src = (p) => readFileSync(new URL(`../../web/src/${p}`, import.meta.url), 'utf8');
const P = (id, restricted) => ({ id, ...(restricted ? { restricted: true } : {}) });

test('pick keeps the old order: stored, opensOn, first', () => {
  store.clear();
  const ps = [P('a'), P('b'), P('c')];
  assert.equal(ap.pickActiveProject(ps, 'b', 'c'), 'c');
  assert.equal(ap.pickActiveProject(ps, 'b', 'zzz'), null);   // stored but removed: blank, not opensOn
  store.clear();
  assert.equal(ap.pickActiveProject(ps, 'b', null), 'b');
  assert.equal(ap.pickActiveProject(ps, 'zzz', null), 'a');
  assert.equal(ap.pickActiveProject([], 'x', null), 'x');
  assert.equal(ap.pickActiveProject([], null, null), null);
});

test('pick never falls back to a restricted project, but keeps a stored one', () => {
  store.clear();
  const ps = [P('a', true), P('b'), P('c', true)];
  assert.equal(ap.pickActiveProject(ps, 'a', null), 'b');
  assert.equal(ap.pickActiveProject(ps, null, null), 'b');
  assert.equal(ap.pickActiveProject(ps, 'b', 'c'), 'c');
  assert.equal(ap.pickActiveProject([P('a', true)], 'a', null), null);
});

test('the no-project state survives snapshots until something is picked', () => {
  store.clear();
  const ps = [P('a'), P('b')];
  ap.rememberNoProject();
  assert.equal(ap.readNoProject(), true);
  assert.equal(ap.readActiveProject(), null);
  assert.equal(ap.pickActiveProject(ps, 'a', null), null);
  assert.equal(ap.pickActiveProject(ps, 'a'), null);
  ap.rememberActiveProject('b');
  assert.equal(ap.readNoProject(), false);
  assert.equal(ap.pickActiveProject(ps, 'a', null), 'a');
  assert.equal(ap.pickActiveProject(ps, 'a'), 'b');
});

test('a removed active project lands on the blank state, never another project', () => {
  store.clear();
  const ps = [P('a'), P('b')];
  assert.equal(ap.pickActiveProject(ps, 'a', 'gone'), null);
  assert.equal(ap.readNoProject(), true);
  assert.equal(ap.pickActiveProject(ps, 'a'), null);       // stays blank on later snapshots
  store.clear();
  ap.rememberActiveProject('gone');
  assert.equal(ap.pickActiveProject([], 'x'), null);       // last project removed
  store.clear();
  assert.equal(ap.pickActiveProject(ps, 'b', null), 'b');  // first-ever load unchanged
  assert.equal(ap.readNoProject(), false);
  assert.equal(ap.pickActiveProject(undefined, 'x', 'gone'), 'x');  // no registry sent: not «removed»
});

test('api: restricted and remove', () => {
  const api = src('api.js');
  assert.match(api, /setProjectRestricted: \(id, restricted\) => send\(`\/api\/projects\/\$\{encodeURIComponent\(id\)\}\/restricted`/);
  assert.match(api, /removeProject: \(id\) => send\(`\/api\/projects\/\$\{encodeURIComponent\(id\)\}`, undefined, 'DELETE'\)/);
});

test('App wiring', () => {
  const app = src('App.jsx');
  assert.match(app, /import ManageProjectsDialog from '\.\/components\/ManageProjectsDialog\.jsx'/);
  assert.match(app, /activeProject \? shown\.filter\(\(t\) => t\.project === activeProject\) : \[\]/);
  assert.match(app, /onToggleRestricted=\{toggleRestricted\} onRemoveProject=\{removeProject\} onManageProjects=/);
  assert.match(app, /<NoProjectState onManage=\{\(\) => setManageOpen\(true\)\} onImport=\{\(\) => setImportOpen\(true\)\}/);
  assert.match(app, /\{activeProject \|\| !loaded \? \(\s*<Board/);
  assert.match(app, /await ask\(\{\s*title: fill\(t\.app\.removeProject\.title/);
  assert.match(app, /setActiveProject\(null\);\s*rememberNoProject\(\);[\s\S]*await api\.removeProject\(id\)/);
  assert.match(app, /catch \(e\) \{\s*setProjects\(before\)/);
  assert.match(app, /api\.setProjectRestricted\(id, restricted\)\.catch\(\(e\) => \{ set\(!restricted\)/);
  assert.match(app, /known\.has\(t\.project\)/);
  assert.match(app, /<ManageProjectsDialog[\s\S]*onImport=\{\(\) => setImportOpen\(true\)\}/);
  const tr = app.slice(app.indexOf('const toggleRestricted'), app.indexOf('const removeProject'));
  assert.ok(!/ask\(|setActiveProject|selectProject/.test(tr), 'restricting asks nothing and moves nothing');
});

test('strings in four languages', async () => {
  for (const l of ['es', 'en', 'fr', 'de']) {
    const { default: a } = await import(`../../web/src/i18n/strings/${l}/app.js`);
    assert.deepEqual(Object.keys(a.noProject), ['title', 'hint', 'manage', 'import']);
    assert.deepEqual(Object.keys(a.removeProject), ['title', 'text', 'confirm']);
    assert.match(a.removeProject.title, /\{project\}/);
  }
});
