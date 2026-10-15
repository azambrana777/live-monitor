// The Settings button and its menu: the five per-project switches are segmented
// controls, the two-valued one is a state button, and the board's own settings
// live in the second column. Source-text checks, like web-card-layout.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import es from '../../web/src/i18n/strings/es.js';
const E = (path) => path.split('.').reduce((o, k) => o[k], es);

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src');
const menu = readFileSync(join(root, 'components', 'topbar', 'SettingsMenu.jsx'), 'utf8');
const css = readFileSync(join(root, 'styles', 'settings-menu.css'), 'utf8');

test('the menu has no legacy Toggle and no emoji label', () => {
  assert.doesNotMatch(menu, /<Toggle[\s>]|Toggle\.jsx/);
  assert.doesNotMatch(menu, /🎨/);
  assert.doesNotMatch(menu, /Diseño/);
  assert.doesNotMatch(JSON.stringify(es.topbar.settings), /Diseño/);
});

test('Skills de UX is a state button carrying the BRIEF tooltip', () => {
  assert.equal(E('topbar.settings.uxName'), 'Skills de UX');
  assert.match(E('topbar.settings.uxTitle'), /^Los chats con una persona delante \(tarea, proyecto y plan\) cargan las skills de UX del tablero\. Las fases sin nadie delante no\./);
  assert.match(menu, /t\.topbar\.settings\.uxName/);
  assert.match(menu, /t\.topbar\.settings\.uxTitle/);
  assert.doesNotMatch(menu, /Skills de UX/, 'no Spanish literal left in the menu');
  assert.match(menu, /<StateButton on=\{designOn\} name=\{t\.topbar\.settings\.uxName\}/);
  assert.match(menu, /saveDesign\(!designOn\)/);
});

test('the five project switches are menu-context segmented controls over the tri-state helpers', () => {
  assert.equal((menu.match(/<SegmentedControl/g) ?? []).length, 3); // once per row of PROJECT_ROWS, once for the hover delay, once for the git refresh
  assert.match(menu, /<SegmentedControl context="menu" size="sm"/);
  for (const key of ['autoStart', 'approvePlan', 'browserQa', 'fixGaps', 'demo']) {
    assert.match(menu, new RegExp(`projectRow\\('${key}'`));
  }
  assert.match(menu, /triToProject\(/);
  assert.match(menu, /projectTriState\(/);
  assert.match(menu, /DUO_OPTIONS/);
});

test('the popover is controlled by open / onOpenChange', () => {
  assert.match(menu, /usePopover\(\{ open, onOpenChange \}\)/);
  assert.match(menu, /<Popover pop=\{pop\}/);
  assert.match(menu, /aria-haspopup="dialog"/);
});

test('the second column and the plugins entry', () => {
  for (const [key, text] of [
    ['boardTitle', 'Todo el tablero'], ['pluginsRequired', 'Plugins requeridos'], ['models', 'Modelos por fase'],
    ['configure', 'Configurar'], ['boardNote', 'Igual para todos los proyectos.'],
  ]) {
    assert.equal(E('topbar.settings.' + key), text);
    assert.ok(menu.includes('t.topbar.settings.' + key), 'menu does not use ' + key);
    assert.ok(!menu.includes(text), 'Spanish literal left in the menu: ' + text);
  }
  assert.match(menu, /<RequiredPluginsDialog onClose=/);
  assert.match(menu, /usePlugins\(\)/);
  assert.match(menu, /onOpenModels\(\)/);
});

test('there is no theme row (dark only)', () => {
  assert.doesNotMatch(menu, /Tema/);
  assert.doesNotMatch(menu, /Oscuro|Claro|Sistema/);
  assert.doesNotMatch(JSON.stringify(es.topbar.settings), /Tema|Oscuro|Claro|Sistema/);
});

test('the language row picks the locale through setLocale, and the project rows name themselves through getters', () => {
  assert.match(menu, /t\.topbar\.settings\.language\b/);
  assert.match(menu, /onChange=\{\(e\) => setLocale\(e\.target\.value\)\}/);
  assert.match(menu, /LOCALES/);
  assert.match(menu, /get name\(\)/);
  assert.match(menu, /get title\(\)/);
  assert.match(menu, /projectRow\('browserQa', 'compass', 'Browser QA'\), \/\/ i18n-ok/);
  assert.match(menu, /projectRow\('demo', 'film', 'Demo'\), \/\/ i18n-ok/);
  for (const key of ['autoStart', 'approvePlan', 'browserQa', 'fixGaps', 'demo']) {
    assert.ok(es.topbar.settings.rows[key].title, 'catalog has a title for ' + key);
  }
});

test('the stylesheet is scoped to sm- and has a phone block', () => {
  assert.match(css, /\.sm-root\b/);
  assert.match(css, /@media \(max-width: 780px\)/);
  assert.doesNotMatch(css, /!important/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
});
