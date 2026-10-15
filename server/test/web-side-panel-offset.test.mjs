import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The side panel must start below the top bar, or it covers the bar's right
// end (the "More actions" button). Source-text checks, like the other web-*.

const SRC = path.resolve(import.meta.dirname, '..', '..', 'web', 'src');
const read = (...p) => readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const css = read('styles.css');
const tokens = read('tokens.css');
const topbar = read('styles', 'topbar.css');

const block = (source, selector, from = 0) => {
  const at = source.indexOf(`${selector} {`, from);
  assert.ok(at >= 0, `no rule for ${selector}`);
  return source.slice(at, source.indexOf('}', at));
};

test('--tb-h is a token and the top bar height uses it', () => {
  assert.match(tokens, /--tb-h:\s*52px/);
  assert.match(block(topbar, '.tb'), /height:\s*var\(--tb-h\)/);
});

test('the desktop .side starts below the bar, not at top: 0', () => {
  const rule = block(css, '.side');
  assert.match(rule, /top:\s*var\(--tb-h\)/);
  assert.doesNotMatch(rule, /top:\s*0\b/);
});

test('the phone sheet stays full-screen: width 100% and top: 0', () => {
  const media = css.slice(css.indexOf('@media (max-width: 780px)'));
  assert.match(block(media, '.side'), /width:\s*100%;\s*top:\s*0/);
});
