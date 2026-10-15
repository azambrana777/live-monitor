import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextTap, DOUBLE_TAP_MS, DOUBLE_TAP_PX } from '../../web/src/doubleTap.js';

// Source-text pins (there is no web test runner) plus a pure unit test of the
// double-tap decision. The pointer/timer behaviour itself is not run here.
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8').replace(/\r\n/g, '\n');
const card = read('components/TaskCard.jsx');
const css = read('styles/card.css');

test('hover delay comes from the setting, not a constant', () => {
  assert.doesNotMatch(card, /HOVER_OPEN_MS/);
  assert.match(card, /import \{ readHoverDelay, onHoverDelayChange \} from '\.\.\/cardHover\.js'/);
  assert.match(card, /const hoverMs = useRef\(readHoverDelay\(\)\)/);
  assert.match(card, /return onHoverDelayChange\(/);
  assert.match(card, /hoverMs\.current <= 0/);
  assert.match(card, /\}, hoverMs\.current\);/);
});

test('leaving or losing the pointer always collapses a hover-opened card', () => {
  assert.match(card, /onPointerCancel=\{\(e\) => \{ onCardLeave\(e\);/);
  assert.match(card, /const hoverOpened = useRef\(false\)/);
  assert.match(card, /hoverOpened\.current = true;\s*setExpanded\(true\)/);
  assert.match(card, /if \(pinned\.current \|\| !\(hoverOpened\.current \|\| expandedRef\.current\)\) return;/);
  assert.match(card, /useEffect\(\(\) => clearTimers, \[\]\)/);
});

test('double tap on touch/pen toggles like the button', () => {
  assert.match(card, /import \{ nextTap, TAP_SLOP_PX, TAP_IGNORE \} from '\.\.\/doubleTap\.js'/);
  assert.match(card, /onPointerDown=\{onTapDown\} onPointerUp=\{onTapUp\}/);
  assert.match(read('doubleTap.js'), /TAP_IGNORE = 'button, a, input, select, textarea, label/);
  assert.match(card, /if \(r\.double\) toggleExpanded\(\)/);
  assert.equal((card.match(/e\.pointerType === 'mouse'\) return;/g) ?? []).length >= 3, true, 'mouse never double-taps');
  assert.match(css, /\.tc \{[^}]*touch-action: manipulation;/);
});

test('nextTap: two close taps are a double, far or slow ones are not', () => {
  const a = { t: 1000, x: 10, y: 10 };
  assert.deepEqual(nextTap(null, a), { double: false, last: a });
  assert.deepEqual(nextTap(a, { t: 1000 + DOUBLE_TAP_MS, x: 12, y: 11 }), { double: true, last: null });
  const slow = { t: 1000 + DOUBLE_TAP_MS + 1, x: 10, y: 10 };
  assert.equal(nextTap(a, slow).double, false);
  const far = { t: 1100, x: 10 + DOUBLE_TAP_PX, y: 10 };
  assert.equal(nextTap(a, far).double, false);
  assert.equal(nextTap(a, far).last, far);
});
