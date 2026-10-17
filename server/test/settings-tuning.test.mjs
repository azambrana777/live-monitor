import './isolate.mjs';

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/config.js';
import { settings, TUNING_ROLES } from '../src/settings.js';

beforeEach(() => {
  settings.updateTuning({ roles: Object.fromEntries(TUNING_ROLES.map((r) => [r, null])), fastMode: null });
});

test('a fresh board has no tuning overrides', () => {
  assert.deepEqual(settings.tuning, { roles: {} });
  assert.deepEqual(settings.snapshot().tuning, { roles: {} });
});

test('updateTuning stores model and effort per role and persists them', () => {
  settings.updateTuning({ roles: { fix: { model: 'sonnet', effort: 'HIGH' } }, fastMode: true });
  assert.deepEqual(settings.tuning, { roles: { fix: { model: 'sonnet', effort: 'high' } }, fastMode: true });
  const onDisk = JSON.parse(readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'));
  assert.equal(onDisk.tuning.roles.fix.effort, 'high');
});

test("effort 'auto' is stored as an explicit override, null removes it", () => {
  settings.updateTuning({ roles: { plan: { effort: 'auto' } } });
  assert.equal(settings.tuning.roles.plan.effort, 'auto');
  settings.updateTuning({ roles: { plan: { effort: null } } });
  assert.deepEqual(settings.tuning.roles, {});
});

test('null on a role or on the knobs clears them', () => {
  settings.updateTuning({ roles: { pr: { model: 'opus' }, demo: { effort: 'low' } }, fastMode: false });
  settings.updateTuning({ roles: { pr: null, demo: { effort: null } }, fastMode: null });
  assert.deepEqual(settings.tuning, { roles: {} });
});

test('invalid patches throw and keep the previous value', () => {
  settings.updateTuning({ roles: { fix: { effort: 'low' } } });
  assert.throws(() => settings.updateTuning({ roles: { nope: { effort: 'low' } } }), /role «nope»/);
  assert.throws(() => settings.updateTuning({ roles: { fix: { effort: 'turbo' } } }), /effort/);
  assert.throws(() => settings.updateTuning({ roles: { fix: { model: 'x' } } }, { isModel: () => false }), /is not available/);
  assert.throws(() => settings.updateTuning({ roles: { fix: { color: 1 } } }), /color/);
  assert.throws(() => settings.updateTuning({ fastMode: 'yes' }), /fastMode/);
  assert.throws(() => settings.updateTuning({ roles: { fix: { thinking: 'sideways' } } }), /thinking/);
  assert.throws(() => settings.updateTuning({ roles: { fix: { thinking: { type: 'enabled' } } } }), /budgetTokens/);
  assert.throws(() => settings.updateTuning({ dismissModel: '' }), /dismissModel/);
  assert.throws(() => settings.updateTuning({ bogus: 1 }), /bogus/);
  assert.throws(() => settings.updateTuning(null), /must be an object/);
  assert.deepEqual(settings.tuning.roles, { fix: { effort: 'low' } });
});

test('a rejected patch is atomic: nothing from it is kept', () => {
  assert.throws(() => settings.updateTuning({ roles: { fix: { effort: 'low' } }, fastMode: 'x' }));
  assert.deepEqual(settings.tuning, { roles: {} });
});

test('thinking is stored per role: auto, a mode, or an enabled budget; null removes it', () => {
  settings.updateTuning({ roles: { fix: { thinking: 'AUTO' }, plan: { thinking: { type: 'adaptive', junk: 1 } }, chat: { thinking: { type: 'enabled', budgetTokens: 2048 } } } });
  assert.deepEqual(settings.tuning.roles, {
    fix: { thinking: 'auto' }, plan: { thinking: { type: 'adaptive' } }, chat: { thinking: { type: 'enabled', budgetTokens: 2048 } },
  });
  const onDisk = JSON.parse(readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'));
  assert.deepEqual(onDisk.tuning.roles.chat.thinking, { type: 'enabled', budgetTokens: 2048 });
  settings.updateTuning({ roles: { fix: { thinking: null }, plan: { thinking: null }, chat: { thinking: null } } });
  assert.deepEqual(settings.tuning.roles, {});
});

test('contextWindow is accepted and ignored', () => {
  settings.updateTuning({ contextWindow: '1m' });
  settings.updateTuning({ contextWindow: 'not even valid' });
  assert.deepEqual(settings.tuning, { roles: {} });
});

test('dismissModel accumulates without duplicates and is kept through other patches', () => {
  settings.updateTuning({ dismissModel: 'claude-opus-5-6' });
  settings.updateTuning({ dismissModel: 'claude-sonnet-5-6' });
  settings.updateTuning({ dismissModel: 'claude-opus-5-6' });
  settings.updateTuning({ fastMode: true });
  assert.deepEqual(settings.tuning.dismissedModels, ['claude-opus-5-6', 'claude-sonnet-5-6']);
  const onDisk = JSON.parse(readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'));
  assert.deepEqual(onDisk.tuning.dismissedModels, ['claude-opus-5-6', 'claude-sonnet-5-6']);
});

test('dismissModel only takes a plain model id', () => {
  for (const bad of ['has space', 'semi;colon', 'x'.repeat(101), '../etc', 'a/b', '<b>']) {
    assert.throws(() => settings.updateTuning({ dismissModel: bad }), /dismissModel/, bad);
  }
  assert.doesNotThrow(() => settings.updateTuning({ dismissModel: 'claude-opus-5-6[1m]' }));
  assert.doesNotThrow(() => settings.updateTuning({ dismissModel: 'a'.repeat(100) }));
});

test('dismissedModels is capped at 50: the oldest drop off', () => {
  for (let i = 0; i < 55; i++) settings.updateTuning({ dismissModel: `model-${i}` });
  const list = settings.tuning.dismissedModels;
  assert.equal(list.length, 50);
  assert.equal(list[0], 'model-5');
  assert.equal(list.at(-1), 'model-54');
});
