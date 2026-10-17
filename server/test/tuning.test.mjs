import './isolate.mjs';

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { settings } from '../src/settings.js';
import { TUNING_ROLES, tuningFor, tuningSnapshot, setTuning } from '../src/tuning.js';
import { CAPABILITIES } from '../src/effort.js';
import { setCapabilitiesForTest } from '../src/capabilities.js';

const AVAILABLE = [
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'fable', label: 'Fable' },
  { id: 'haiku', label: 'Haiku' },
];
const cfg = (over = {}) => ({
  claude: {
    triageModel: 'opus', advisorModel: 'opus', planModel: 'opus', fixModel: 'opus',
    chatModel: 'sonnet', demoModel: 'sonnet', replyModel: 'sonnet',
    tuning: { fixEffort: 'high', planEffort: 'auto', fastMode: false },
    available: AVAILABLE,
    ...over.claude,
  },
  qa: { ...over.qa },
});

beforeEach(() => {
  settings.updateTuning({ roles: Object.fromEntries(TUNING_ROLES.map((r) => [r, null])), fastMode: null });
  setCapabilitiesForTest(null);
});

test('roles are the ten the pipeline uses', () => {
  assert.deepEqual([...TUNING_ROLES], ['triage', 'advisor', 'plan', 'fix', 'pr', 'demo', 'reply', 'chat', 'qa', 'qaPlan']);
  assert.throws(() => tuningFor('nope', cfg()), /role «nope»/);
});

test('config defaults, with the fallbacks the pipeline always had', () => {
  const c = cfg();
  assert.equal(tuningFor('fix', c).model, 'opus');
  assert.equal(tuningFor('pr', c).model, 'sonnet');          // prModel ?? chatModel
  assert.equal(tuningFor('qa', c).model, 'opus');            // qa.model ?? fixModel
  assert.equal(tuningFor('qaPlan', c).model, 'opus');        // qa.planModel ?? advisorModel
  assert.equal(tuningFor('chat', c).model, 'sonnet');
  const c2 = cfg({ claude: { prModel: 'haiku' }, qa: { model: 'sonnet', planModel: 'sonnet', effort: 'low', planEffort: 'max' } });
  assert.equal(tuningFor('pr', c2).model, 'haiku');
  assert.equal(tuningFor('qa', c2).model, 'sonnet');
  assert.equal(tuningFor('qaPlan', c2).model, 'sonnet');
  assert.equal(tuningFor('qa', c2).effort, 'low');
  assert.equal(tuningFor('qaPlan', c2).effort, 'max');
});

test('effort: config value, auto means undefined', () => {
  const c = cfg();
  assert.equal(tuningFor('fix', c).effort, 'high');
  assert.equal(tuningFor('plan', c).effort, undefined);
  assert.equal(tuningFor('triage', c).effort, undefined);
});

test('override precedence: board override beats config, explicit auto beats a config effort', () => {
  const c = cfg();
  setTuning({ roles: { fix: { model: 'sonnet', effort: 'max' }, plan: { effort: 'medium' } } }, c);
  assert.deepEqual([tuningFor('fix', c).model, tuningFor('fix', c).effort], ['sonnet', 'max']);
  assert.equal(tuningFor('plan', c).effort, 'medium');
  setTuning({ roles: { fix: { effort: 'auto' } } }, c);
  assert.equal(tuningFor('fix', c).effort, undefined);
  assert.equal(tuningFor('fix', c).model, 'sonnet');
  setTuning({ roles: { fix: null } }, c);
  assert.deepEqual([tuningFor('fix', c).model, tuningFor('fix', c).effort], ['opus', 'high']);
});

test('per-project config: the same override applies over a different merged cfg', () => {
  setTuning({ roles: { triage: { effort: 'low' } } }, cfg());
  const other = cfg({ claude: { triageModel: 'sonnet' } });
  assert.equal(tuningFor('triage', other).model, 'sonnet');
  assert.equal(tuningFor('triage', other).effort, 'low');
  assert.equal(tuningFor('triage', cfg()).model, 'opus');
});

test('fastMode: config default, board override, null clears', () => {
  const c = cfg({ claude: { tuning: { fastMode: true } } });
  assert.equal(tuningFor('fix', c).fastMode, true);
  setTuning({ fastMode: false }, c);
  assert.equal(tuningFor('fix', c).fastMode, false);
  setTuning({ fastMode: null }, c);
  assert.equal(tuningFor('fix', c).fastMode, true);
});

test('contextWindow is gone: accepted and ignored, never stored or returned', () => {
  const c = cfg();
  assert.equal('contextWindow' in tuningFor('fix', c), false);
  setTuning({ contextWindow: '1m' }, c);
  setTuning({ contextWindow: 'whatever' }, c);
  assert.equal('contextWindow' in settings.tuning, false);
  assert.equal('contextWindow' in tuningSnapshot(c), false);
});

test('tuningFor exposes the available list for the effort helpers', () => {
  assert.deepEqual(tuningFor('fix', cfg()).available, AVAILABLE);
});

test('a role may resolve to Fable, from the config default or an override', () => {
  const c = cfg({ claude: { fixModel: 'fable', available: [{ id: 'fable', label: 'Fable' }, ...AVAILABLE] } });
  assert.equal(tuningFor('fix', c).model, 'fable');
  setTuning({ roles: { chat: { model: 'fable' } } }, c);
  assert.equal(tuningFor('chat', c).model, 'fable');
});

test('setTuning rejects unknown roles and models, but never an effort a model lacks', () => {
  const c = cfg();
  assert.throws(() => setTuning({ roles: { nope: { effort: 'low' } } }, c), /role «nope»/);
  assert.throws(() => setTuning({ roles: { fix: { model: 'gpt-9' } } }, c), /is not available/);
  assert.throws(() => setTuning({ roles: { fix: { effort: 'turbo' } } }, c), /effort/);
  assert.deepEqual(settings.tuning, { roles: {} });
  // Not a 400 any more: stored as chosen, clamped when a session opens.
  setTuning({ roles: { fix: { model: 'haiku', effort: 'low' }, chat: { effort: 'max' } } }, c);
  assert.equal(settings.tuning.roles.fix.effort, 'low');
  assert.equal(settings.tuning.roles.chat.effort, 'max');
});

test('effectiveEffort is the chosen level clamped to the role model, null when it has none', () => {
  const c = cfg();
  setTuning({ roles: { fix: { model: 'haiku', effort: 'low' }, chat: { effort: 'max' }, plan: { model: 'opus', effort: 'xhigh' } } }, c);
  const snap = tuningSnapshot(c);
  assert.equal(snap.roles.fix.effort, 'low');
  assert.equal(snap.roles.fix.effectiveEffort, null);        // haiku has no effort
  assert.equal(snap.roles.chat.effectiveEffort, 'max');      // sonnet takes max
  assert.equal(snap.roles.plan.effectiveEffort, 'xhigh');
  assert.equal(snap.roles.triage.effort, 'auto');
  assert.equal(snap.roles.triage.effectiveEffort, null);
});

test('thinking per role: validated against the role model, also by a model-only patch', () => {
  const c = cfg();
  // opus (fix) takes adaptive only
  assert.throws(() => setTuning({ roles: { fix: { thinking: { type: 'enabled', budgetTokens: 2000 } } } }, c), /does not support thinking/);
  assert.throws(() => setTuning({ roles: { fix: { thinking: { type: 'disabled' } } } }, c), /does not support thinking/);
  assert.throws(() => setTuning({ roles: { fix: { thinking: { type: 'bogus' } } } }, c), /does not support thinking|thinking/);
  assert.deepEqual(settings.tuning, { roles: {} });
  setTuning({ roles: { fix: { thinking: { type: 'adaptive' } } } }, c);
  assert.deepEqual(settings.tuning.roles.fix.thinking, { type: 'adaptive' });
  assert.deepEqual(tuningFor('fix', c).thinking, { type: 'adaptive' });
  // the patch brings only the model, and the stored thinking stops fitting: 400, nothing stored
  assert.throws(() => setTuning({ roles: { fix: { model: 'haiku' } } }, c), /does not support thinking/);
  assert.equal(settings.tuning.roles.fix.model, undefined);
  // together with a thinking that fits the new model it is fine
  setTuning({ roles: { fix: { model: 'haiku', thinking: { type: 'enabled', budgetTokens: 1024 } } } }, c);
  assert.deepEqual(tuningFor('fix', c).thinking, { type: 'enabled', budgetTokens: 1024 });
  // enabled needs a budget in range
  assert.throws(() => setTuning({ roles: { fix: { thinking: { type: 'enabled' } } } }, c), /budgetTokens/);
  assert.throws(() => setTuning({ roles: { fix: { thinking: { type: 'enabled', budgetTokens: 999 } } } }, c), /budgetTokens/);
  assert.throws(() => setTuning({ roles: { fix: { thinking: { type: 'enabled', budgetTokens: 32001 } } } }, c), /budgetTokens/);
  // and going back to opus with that haiku-only thinking is refused too
  assert.throws(() => setTuning({ roles: { fix: { model: 'opus' } } }, c), /does not support/);
  assert.throws(() => setTuning({ roles: { fix: { model: null } } }, c), /does not support/);   // config default is opus
  // 'auto' and null always fit
  setTuning({ roles: { fix: { thinking: 'auto' } } }, c);
  assert.equal(tuningFor('fix', c).thinking, undefined);
  assert.equal(tuningSnapshot(c).roles.fix.thinking, 'auto');
  setTuning({ roles: { fix: { model: 'opus', thinking: null } } }, c);
  assert.equal(settings.tuning.roles.fix.thinking, undefined);
});

test('thinking: config default (claude.tuning.<role>Thinking) and the snapshot shape', () => {
  const c = cfg({ claude: { tuning: { fixThinking: { type: 'adaptive' }, planThinking: 'auto', triageThinking: 'sideways' } } });
  assert.deepEqual(tuningFor('fix', c).thinking, { type: 'adaptive' });
  assert.equal(tuningFor('plan', c).thinking, undefined);
  const real = console.warn;
  console.warn = () => {};
  try { assert.equal(tuningFor('triage', c).thinking, undefined); } finally { console.warn = real; }
  const snap = tuningSnapshot(c);
  assert.deepEqual(snap.roles.fix.thinking, { type: 'adaptive' });
  assert.equal(snap.roles.plan.thinking, 'auto');
});

test('the shipped config has a <role>Thinking: auto beside every <role>Effort, and no contextWindow', async () => {
  const { config } = await import('../src/config.js');
  const t = config.claude.tuning;
  for (const key of Object.keys(t).filter((k) => k.endsWith('Effort'))) {
    assert.equal(t[key.replace(/Effort$/, 'Thinking')], 'auto', key);
  }
  assert.equal('contextWindow' in t, false);
});

test('snapshot shape', () => {
  const c = cfg();
  setTuning({ roles: { plan: { model: 'sonnet', effort: 'low' } } }, c);
  const snap = tuningSnapshot(c);
  assert.deepEqual(Object.keys(snap.roles), [...TUNING_ROLES]);
  assert.deepEqual(snap.roles.plan, { model: 'sonnet', effort: 'low', effectiveEffort: 'low', thinking: 'auto' });
  assert.deepEqual(snap.roles.fix, { model: 'opus', effort: 'high', effectiveEffort: 'high', thinking: 'auto' });
  assert.deepEqual(snap.roles.triage, { model: 'opus', effort: 'auto', effectiveEffort: null, thinking: 'auto' });
  assert.equal(snap.fastMode, false);
  assert.equal(snap.fastModeStatus, null);   // no probe has answered
  assert.deepEqual(snap.newModels, []);
  assert.equal('contextWindow' in snap, false);
  assert.deepEqual(snap.models.map((m) => m.id), ['opus', 'sonnet', 'fable', 'haiku']);
  assert.deepEqual(snap.models[1].efforts, [...CAPABILITIES.sonnet.efforts]);
  assert.deepEqual(snap.models[0].thinking, ['adaptive']);
  assert.deepEqual(snap.models[3].thinking, ['enabled', 'disabled']);
  assert.equal(snap.models[0].fastMode, true);
  assert.deepEqual(snap.overrides.roles.plan, { model: 'sonnet', effort: 'low' });
});

test('snapshot exposes the probe fast-mode status', () => {
  setCapabilitiesForTest({ models: [], init: { fast_mode_state: 'off', fast_mode_disabled_reason: 'extra_usage_disabled' }, at: 1 });
  const s = tuningSnapshot(cfg()).fastModeStatus;
  assert.equal(s.available, false);
  assert.equal(s.reason, 'extra_usage_disabled');
});

// What supportedModels() answered on CLI 2.1.286 (Step 0), reduced to the fields read here.
const row = (value, resolvedModel, displayName = value) => ({ value, displayName, resolvedModel });
const STEP0 = [
  row('default', 'claude-sonnet-5-5'),
  row('opus', 'claude-opus-5-5'), row('sonnet', 'claude-sonnet-5-5'), row('haiku', 'claude-haiku-4-5-20251001'),
  row('claude-fable-5-1', 'claude-fable-5-1'), row('claude-sonnet-5', 'claude-sonnet-5'), row('claude-opus-5', 'claude-opus-5'),
  row('claude-fable-5', 'claude-fable-5'), row('claude-opus-4-8', 'claude-opus-4-8'), row('claude-opus-4-7', 'claude-opus-4-7'),
  row('claude-opus-4-6', 'claude-opus-4-6'), row('claude-sonnet-4-6', 'claude-sonnet-4-6'),
];

test('newModels: none with the Step-0 list, one for a higher version, a new family counts', () => {
  const c = cfg();
  assert.deepEqual(tuningSnapshot(c).newModels, []);                     // no probe
  setCapabilitiesForTest({ models: STEP0, init: {}, at: 1 });
  assert.deepEqual(tuningSnapshot(c).newModels, []);                     // today's list
  setCapabilitiesForTest({ models: [...STEP0, row('claude-opus-5-6', 'claude-opus-5-6', 'Opus 5.6')], init: {}, at: 2 });
  assert.deepEqual(tuningSnapshot(c).newModels, [{ value: 'claude-opus-5-6', displayName: 'Opus 5.6', resolvedModel: 'claude-opus-5-6' }]);
  setCapabilitiesForTest({ models: [...STEP0, row('claude-mythos-1', 'claude-mythos-1'), row('claude-fable-6', 'claude-fable-6')], init: {}, at: 3 });
  assert.deepEqual(tuningSnapshot(c).newModels.map((m) => m.resolvedModel), ['claude-mythos-1']);
});

test('dismissModel stores the model once, survives other patches, and hides its notice', () => {
  const c = cfg();
  setCapabilitiesForTest({ models: [...STEP0, row('claude-opus-5-6', 'claude-opus-5-6')], init: {}, at: 1 });
  assert.equal(tuningSnapshot(c).newModels.length, 1);
  setTuning({ dismissModel: 'claude-opus-5-6' }, c);
  setTuning({ dismissModel: 'claude-opus-5-6' }, c);
  assert.deepEqual(settings.tuning.dismissedModels, ['claude-opus-5-6']);
  assert.deepEqual(tuningSnapshot(c).newModels, []);
  setTuning({ fastMode: true }, c);
  assert.deepEqual(tuningSnapshot(c).overrides.dismissedModels, ['claude-opus-5-6']);
  assert.throws(() => setTuning({ dismissModel: '' }, c), /dismissModel/);
  assert.throws(() => setTuning({ dismissModel: 7 }, c), /dismissModel/);
});
