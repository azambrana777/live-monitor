import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Icon.jsx is JSX, so node cannot import it: read it as text.
const src = readFileSync(
  fileURLToPath(new URL('../../web/src/components/Icon.jsx', import.meta.url)),
  'utf8',
);
const importBlock = src.match(/import \{([^}]*)\} from 'lucide-react';/)[1];
const imported = new Set(importBlock.split(',').map((s) => s.trim()).filter(Boolean));
const mapBody = src.match(/const ICONS = \{([\s\S]*?)\n\};/)[1];
const entries = [...mapBody.matchAll(/^\s*(?:'([^']+)'|([\w]+)):\s*(\w+),/gm)].map((m) => ({
  key: m[1] || m[2],
  comp: m[3],
}));
const byKey = new Map(entries.map((e) => [e.key, e.comp]));

const ADDED = {
  layers: 'Layers',
  minimize: 'Minimize2',
  palette: 'Palette',
  puzzle: 'Puzzle',
  'pull-request': 'GitPullRequest',
  'circle-minus': 'CircleMinus',
  'chart-column': 'ChartColumn',
  'chart-line': 'ChartLine',
  more: 'Ellipsis',
  sliders: 'SlidersHorizontal',
  moon: 'Moon',
};

test('the eleven new icon names map to their Lucide component', () => {
  for (const [key, comp] of Object.entries(ADDED)) {
    assert.equal(byKey.get(key), comp, `ICONS.${key} should be ${comp}`);
    assert.ok(imported.has(comp), `${comp} must be imported from lucide-react`);
  }
});

test('stop is CircleStop and Square is no longer imported', () => {
  assert.equal(byKey.get('stop'), 'CircleStop');
  assert.ok(imported.has('CircleStop'));
  assert.ok(!imported.has('Square'));
});

test('every mapped component is imported', () => {
  for (const { key, comp } of entries) {
    assert.ok(imported.has(comp), `${key} uses ${comp}, which is not imported`);
  }
});

test('no two names share a Lucide component, except dot/circle', () => {
  const seen = new Map();
  for (const { key, comp } of entries) {
    if (seen.has(comp)) {
      assert.deepEqual([seen.get(comp), key].sort(), ['circle', 'dot'], `${comp} is shared by ${seen.get(comp)} and ${key}`);
    }
    seen.set(comp, key);
  }
});

test('eye-off and grid are mapped, one concept one name', () => {
  assert.equal(byKey.get('eye-off'), 'EyeOff');
  assert.equal(byKey.get('grid'), 'LayoutGrid');
  assert.ok(imported.has('EyeOff') && imported.has('LayoutGrid'));
});
