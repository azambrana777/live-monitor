// The «Expandir tarjetas al pasar el cursor» row of the settings menu: five
// choices written through cardHover.js, live, in four languages. Source checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import es from '../../web/src/i18n/strings/es.js';
import en from '../../web/src/i18n/strings/en.js';
import fr from '../../web/src/i18n/strings/fr.js';
import de from '../../web/src/i18n/strings/de.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src');
const menu = readFileSync(join(root, 'components', 'topbar', 'SettingsMenu.jsx'), 'utf8');
const css = readFileSync(join(root, 'styles', 'settings-menu.css'), 'utf8');

test('the row reads, writes and follows the stored delay, and unsubscribes', () => {
  assert.match(menu, /from '\.\.\/\.\.\/cardHover\.js'/);
  assert.match(menu, /useState\(readHoverDelay\)/);
  assert.match(menu, /useEffect\(\(\) => onHoverDelayChange\(/, 'the effect returns the unsubscribe');
  assert.match(menu, /HOVER_DELAY_OPTIONS\.map/);
  assert.match(menu, /onChange=\{writeHoverDelay\}/);
  assert.match(menu, /<Named name=\{t\.topbar\.settings\.hoverName\} sub=\{hoverLabel\(t, hoverMs\)\}/);
});

test('the row sits in the board column, beside the language, not among the project rows', () => {
  const board = menu.indexOf('sm-col-board');
  assert.ok(menu.indexOf('hoverName') > board);
  assert.ok(menu.indexOf('hoverName') > menu.indexOf('settings.language}'));
});

test('strings exist in the four languages, with the touch note and no prose literal in the menu', () => {
  assert.equal(es.topbar.settings.hoverName, 'Expandir tarjetas al pasar el cursor');
  assert.equal(es.topbar.settings.hoverOff, 'Desactivado');
  assert.equal(en.topbar.settings.hoverName, 'Expand cards on hover');
  assert.equal(fr.topbar.settings.hoverName, 'Développer les cartes au survol');
  assert.equal(de.topbar.settings.hoverName, 'Karten beim Überfahren erweitern');
  for (const l of [es, en, fr, de]) {
    const s = l.topbar.settings;
    assert.equal(s.hoverSeconds, '{n} s');
    assert.ok(s.hoverOff && s.hoverTitle);
  }
  assert.match(es.topbar.settings.hoverTitle, /doble toque/);
  assert.match(en.topbar.settings.hoverTitle, /double tap/);
  assert.match(fr.topbar.settings.hoverTitle, /double toucher/);
  assert.match(de.topbar.settings.hoverTitle, /doppeltes Tippen/);
  assert.doesNotMatch(menu, /Expandir|Desactivado/);
});

test('44px targets on phone and touch, tokens only', () => {
  assert.match(css, /\.sm-hover \.ui-seg-btn \{ min-width: 44px; min-height: 44px;/);
  assert.match(css, /\(pointer: coarse\)/);
  assert.doesNotMatch(css, /!important/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
});
