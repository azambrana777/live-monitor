// What the CLI says each model can do: the cross-referencing in
// capabilities.js and the read that rides the usage probe (usage.js#readCaps).
import './isolate.mjs';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  liveCapabilities, fastModeStatus, cliModels, capabilitiesProbedAt,
  recordCapabilities, setCapabilitiesForTest,
} from '../src/capabilities.js';
import { usageHooks, refreshUsage, usageState, resetUsageForTests } from '../src/usage.js';

const AVAILABLE = [{ id: 'opus' }, { id: 'sonnet' }, { id: 'haiku' }];
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// The catalog the CLI 2.1.286 gave on 2026-10-01 (trimmed to what is read).
const MODELS = [
  { value: 'default', displayName: 'Default', resolvedModel: 'claude-opus-5-5', supportsEffort: true, supportedEffortLevels: ['low'], supportsFastMode: false },
  { value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-5-5', supportsEffort: true, supportedEffortLevels: LEVELS, supportsFastMode: true, supportsAdaptiveThinking: true },
  { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5-5', supportsEffort: true, supportedEffortLevels: LEVELS, supportsAdaptiveThinking: true },
  { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
  { value: 'claude-fable-5-1', displayName: 'Fable', resolvedModel: 'claude-fable-5-1', supportsEffort: true, supportedEffortLevels: LEVELS },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6', resolvedModel: 'claude-opus-4-6', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
];

beforeEach(() => { setCapabilitiesForTest(null); });
after(() => { setCapabilitiesForTest(null); resetUsageForTests(); });

test('without a probe every reader says unknown', () => {
  assert.equal(liveCapabilities('opus', AVAILABLE), null);
  assert.equal(fastModeStatus(), null);
  assert.equal(cliModels(), null);
  assert.equal(capabilitiesProbedAt(), null);
});

test('crosses by value first', () => {
  setCapabilitiesForTest({ models: MODELS, init: {}, at: 1 });
  assert.deepEqual(liveCapabilities('opus', AVAILABLE), { efforts: LEVELS, fastMode: true, adaptiveThinking: true });
  assert.deepEqual(liveCapabilities('claude-opus-4-6', AVAILABLE).efforts, ['low', 'medium', 'high', 'max']);
});

test('crosses by the family of resolvedModel when no value matches', () => {
  setCapabilitiesForTest({ models: MODELS, init: {}, at: 1 });
  // A full id the catalog lists only as a resolvedModel.
  assert.deepEqual(liveCapabilities('claude-sonnet-5-5', AVAILABLE),
    { efforts: LEVELS, fastMode: false, adaptiveThinking: true });
  // An id nobody lists: the family's first row answers.
  assert.equal(liveCapabilities('claude-sonnet-9-9', AVAILABLE).efforts.length, 5);
  assert.equal(liveCapabilities('claude-sonnet-9-9', []), null);
  assert.equal(liveCapabilities('gpt-9', AVAILABLE), null);
});

test('a model without effort fields has no efforts', () => {
  setCapabilitiesForTest({ models: MODELS, init: {}, at: 1 });
  assert.deepEqual(liveCapabilities('haiku', AVAILABLE), { efforts: [], fastMode: false, adaptiveThinking: false });
});

test('the default row is ignored', () => {
  setCapabilitiesForTest({ models: [MODELS[0]], init: {}, at: 1 });
  assert.equal(liveCapabilities('default', AVAILABLE), null);
  assert.equal(liveCapabilities('opus', AVAILABLE), null, 'opus must not borrow the default row');
  assert.deepEqual(cliModels(), []);
});

test('Fable is exposed like any other model; only the default row is dropped', () => {
  setCapabilitiesForTest({ models: MODELS, init: {}, at: 1 });
  assert.ok(liveCapabilities('claude-fable-5-1', AVAILABLE));
  assert.ok(liveCapabilities('fable', [...AVAILABLE, { id: 'fable' }]));
  const list = cliModels();
  assert.ok(list.length > 0);
  assert.ok(list.some((m) => /fable/i.test(m.value + m.resolvedModel)));
  assert.ok(list.every((m) => m.value !== 'default'));
  assert.deepEqual(list[0], { value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-5-5' });
});

test('fast mode: pending and missing data are unknown, a reason is a refusal', () => {
  setCapabilitiesForTest({ models: [], init: { fast_mode_state: 'off', fast_mode_disabled_reason: 'pending' }, at: 5 });
  assert.deepEqual(fastModeStatus(), { available: null, reason: null, at: 5 });
  setCapabilitiesForTest({ models: [], init: {}, at: 6 });
  assert.deepEqual(fastModeStatus(), { available: null, reason: null, at: 6 });
  setCapabilitiesForTest({ models: [], init: { fast_mode_state: 'off', fast_mode_disabled_reason: 'extra_usage_disabled' }, at: 7 });
  assert.deepEqual(fastModeStatus(), { available: false, reason: 'extra_usage_disabled', at: 7 });
  setCapabilitiesForTest({ models: [], init: { fast_mode_state: 'off', fast_mode_disabled_reason: 'network_error' }, at: 8 });
  assert.equal(fastModeStatus().reason, 'network_error');
  setCapabilitiesForTest({ models: [], init: { fast_mode_state: 'on' }, at: 9 });
  assert.deepEqual(fastModeStatus(), { available: true, reason: null, at: 9 });
  setCapabilitiesForTest({ models: [], init: { fast_mode_state: 'cooldown' }, at: 10 });
  assert.deepEqual(fastModeStatus(), { available: true, reason: 'cooldown', at: 10 });
  // A refusal reason still wins over the state.
  setCapabilitiesForTest({ models: [], init: { fast_mode_state: 'cooldown', fast_mode_disabled_reason: 'network_error' }, at: 11 });
  assert.deepEqual(fastModeStatus(), { available: false, reason: 'network_error', at: 11 });
});

test('recordCapabilities and capabilitiesProbedAt', () => {
  recordCapabilities({ models: MODELS, init: {}, at: 42 });
  assert.equal(capabilitiesProbedAt(), 42);
  recordCapabilities(null);
  assert.equal(capabilitiesProbedAt(), null);
});

// ---- the read inside the usage probe (seams: usageHooks) -------------------

const USAGE = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    limits: [
      { kind: 'session', group: 'session', percent: 2, severity: 'normal', resets_at: '2026-09-21T09:00:00+00:00', scope: null, is_active: false },
    ],
  },
};
const original = { ...usageHooks };

function fakeQuery(extra = {}) {
  const seen = { options: null };
  usageHooks.query = ({ options }) => {
    seen.options = options;
    return {
      close: () => {},
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise.resolve(structuredClone(USAGE)),
      ...extra,
    };
  };
  return seen;
}

function resetUsage() {
  resetUsageForTests();
  Object.assign(usageHooks, original);
  usageHooks.paused = () => false;
}

test('the usage probe records capabilities and asks for fast mode', async () => {
  resetUsage();
  const seen = fakeQuery({
    supportedModels: async () => structuredClone(MODELS),
    initializationResult: async () => ({ fast_mode_state: 'off', fast_mode_disabled_reason: 'extra_usage_disabled' }),
  });
  const u = await refreshUsage({ force: true });
  assert.deepEqual(seen.options.settings, { fastMode: true });
  assert.deepEqual(seen.options.settingSources, []);
  assert.equal(u.lastError ?? null, null);
  assert.equal(liveCapabilities('opus', AVAILABLE).fastMode, true);
  assert.equal(fastModeStatus().reason, 'extra_usage_disabled');
  assert.ok(capabilitiesProbedAt() > 0);
});

test('a failing capability read leaves the usage reading intact', async () => {
  resetUsage();
  fakeQuery({
    supportedModels: async () => { throw new Error('catalog gone'); },
    initializationResult: async () => ({}),
  });
  const u = await refreshUsage({ force: true });
  assert.equal(u.lastError ?? null, null);
  assert.ok(usageState().rows.length > 0);
  assert.equal(capabilitiesProbedAt(), null);
});

test('a hanging capability read times out without failing usage', async () => {
  resetUsage();
  usageHooks.timeoutMs = 30;
  fakeQuery({ supportedModels: () => new Promise(() => {}), initializationResult: async () => ({}) });
  const u = await refreshUsage({ force: true });
  assert.equal(u.lastError ?? null, null);
  assert.equal(capabilitiesProbedAt(), null);
});

test('a query without the methods reads nothing and does not wait', async () => {
  resetUsage();
  usageHooks.timeoutMs = 60_000;
  fakeQuery();
  const t0 = Date.now();
  const u = await refreshUsage({ force: true });
  assert.ok(Date.now() - t0 < 5_000);
  assert.equal(u.lastError ?? null, null);
  assert.equal(capabilitiesProbedAt(), null);
});
