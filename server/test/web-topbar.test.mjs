// The redesigned top bar (zones, search, banner) is fixed as source text: the
// web has no browser runner (see web-card-layout.test.mjs for the pattern).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import es from '../../web/src/i18n/strings/es.js';
const E = (path) => path.split('.').reduce((o, k) => o[k], es);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const topbar = read('web/src/components/topbar/Topbar.jsx');
const picker = read('web/src/components/ProjectPicker.jsx');
const login = read('web/src/components/LoginChips.jsx');
const css = read('web/src/styles/topbar.css');

test('the bar root is the `tb` header, not the old `topbar`', () => {
  assert.match(topbar, /<header className="tb"/);
  assert.doesNotMatch(topbar, /className="[^"]*\btopbar\b/);
});

test('the bar mounts the menus and the chips as components', () => {
  assert.match(topbar, /<SettingsMenu \{\.\.\.settingsMenu\}/);
  assert.match(topbar, /<MoreMenu \{\.\.\.moreMenu\}/);
  assert.match(topbar, /<PluginChips \/>/);
  assert.match(topbar, /<LoginChips \/>/);
  assert.doesNotMatch(topbar, /<KpiStrip/);
});

test('search keeps its ref, its label and its Esc handling', () => {
  assert.match(topbar, /ref=\{searchRef\}/);
  assert.equal(E('topbar.bar.searchTasks'), 'Buscar tareas');
  assert.match(topbar, /aria-label=\{t\.topbar\.bar\.searchTasks\}/);
  assert.doesNotMatch(topbar, /Buscar tareas/, 'no Spanish literal left in the bar');
  assert.match(topbar, /e\.key === 'Escape'/);
  assert.match(topbar, /<Kbd>\/<\/Kbd>/);
});

test('one poll button, busy-aware, with a polite live region', () => {
  const pp = readFileSync(path.join(root, 'web/src/components/topbar/PollProgress.jsx'), 'utf8');
  assert.match(topbar, /<PollProgress running=\{poll\.busy\}/);
  assert.match(topbar, /onStart=\{poll\.run\}/);
  assert.doesNotMatch(topbar, /disabled=\{poll\.busy\}/, 'the poll button is never disabled while a cycle runs');
  assert.doesNotMatch(pp, /disabled=\{running\}/);
  assert.match(topbar, /aria-live="polite"/);
  assert.doesNotMatch(topbar, /Buscar ahora<\/|> Buscar ahora/);
  assert.doesNotMatch(topbar, /Buscar ahora/, 'the poll label lives in the catalog');
  assert.match(E('topbar.bar.pollNow'), /^Buscar ahora/);
  assert.match(pp, /t\.topbar\.bar\.pollNow/);
  assert.equal(E('topbar.bar.polling'), 'buscando…');
  assert.match(pp, /t\.topbar\.bar\.polling/);
  // The short text no longer depends on a Spanish label: poll.short, else whatever follows the first colon.
  assert.ok(topbar.includes(String.raw`const shortPoll = (poll) => poll.short ?? poll.text.replace(/^[^:\d]*:\s*/, '');`), 'shortPoll is language-independent');
  assert.doesNotMatch(topbar, /Buscar cada|Próxima|próxima|Sondeo|sondeo/, 'no Spanish prefix regex in shortPoll');
});

test('the offline banner is a status region shown only when disconnected', () => {
  assert.match(topbar, /\{!connected && \(/);
  assert.match(topbar, /role="status"/);
  assert.equal(E('topbar.bar.offline'), 'Sin conexión con el tablero · reconectando…');
  assert.match(topbar, /t\.topbar\.bar\.offline/);
  assert.doesNotMatch(topbar, /Sin conexión/);
});

test('every piece of the old bar is still reachable', () => {
  assert.match(topbar, /onOpenMetrics/);
  assert.match(topbar, /onOpenUpgrade/);
  assert.match(topbar, /machineStatus\[m\.name\]/);
  assert.equal(E('topbar.bar.connected'), 'conectado');
  assert.equal(E('topbar.bar.reconnecting'), 'reconectando…');
  assert.match(topbar, /t\.topbar\.bar\.connected\b/);
  assert.match(topbar, /t\.topbar\.bar\.reconnecting\b/);
});

test('the project picker is a button + popover, not a select, and never imports projects', () => {
  assert.doesNotMatch(picker, /Importar proyecto/);
  assert.doesNotMatch(picker, /ImportProjectDialog/);
  assert.doesNotMatch(picker, /<select/);
  assert.ok(picker.includes('export default function ProjectPicker('));
  assert.match(picker, /<Popover /);
  assert.match(picker, /onSelect, onToggleRestricted, onRemove, onManage/);
});

test('Topbar forwards the project-management props to the picker', () => {
  assert.match(topbar, /onToggleRestricted, onRemoveProject, onManageProjects/);
  assert.ok(topbar.includes('onRemove={onRemoveProject}'));
  assert.ok(topbar.includes('onManage={onManageProjects}'));
  assert.ok(topbar.includes('onToggleRestricted={onToggleRestricted}'));
});

test('no old layout class survives in the bar files', () => {
  for (const src of [topbar, picker, login]) {
    assert.doesNotMatch(src, /className=\{?[`"][^`"]*(?<![-\w])(setting|machine|topbar)(?![-\w])/);
  }
});

test('login chips stay quiet and storage-free', () => {
  assert.doesNotMatch(login, /console\./);
  assert.doesNotMatch(login, /localStorage|sessionStorage/);
});

test('topbar.css has a phone block and no hex colour', () => {
  assert.match(css, /@media \(max-width: 780px\)/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(css, /!important/);
});

test('on the phone the «Renovar login» button is never hidden', () => {
  const phone = css.slice(css.indexOf('@media (max-width: 780px)'));
  assert.doesNotMatch(phone, /[^{}]*\.tb-chip-action[^{}]*\{[^}]*display:\s*none/);
});
