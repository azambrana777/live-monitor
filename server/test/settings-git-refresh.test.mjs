import './isolate.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let settings;
before(async () => { ({ settings } = await import('../src/settings.js')); });

test('gitRefreshSeconds defaults to 300 and validates 0 or 15..3600', () => {
  assert.equal(settings.gitRefreshSeconds, 300);
  settings.update({ gitRefreshSeconds: 0 });
  assert.equal(settings.gitRefreshSeconds, 0);
  settings.update({ gitRefreshSeconds: 15 });
  settings.update({ gitRefreshSeconds: 3600 });
  for (const bad of [1, 14, 3601, 1.5, 'x', null, -1]) {
    assert.throws(() => settings.update({ gitRefreshSeconds: bad }), /gitRefreshSeconds/, String(bad));
  }
  settings.update({ gitRefreshSeconds: 300 });
});

test('a project overrides it and null goes back to the board value', () => {
  settings.updateProject('proj-a', { gitRefreshSeconds: 45 });
  assert.equal(settings.gitRefreshSecondsFor('proj-a'), 45);
  assert.equal(settings.gitRefreshSecondsFor('other'), settings.gitRefreshSeconds);
  settings.updateProject('proj-a', { gitRefreshSeconds: 0 });
  assert.equal(settings.gitRefreshSecondsFor('proj-a'), 0);
  settings.updateProject('proj-a', { gitRefreshSeconds: null });
  assert.equal(settings.gitRefreshSecondsFor('proj-a'), settings.gitRefreshSeconds);
});
