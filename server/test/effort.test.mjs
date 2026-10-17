import './isolate.mjs';   // primero: aisla el directorio de datos
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  EFFORT_LEVELS, CAPABILITIES, THINKING_BUDGET, normalizeEffort, effortOptionsFor, capabilitiesOf,
  thinkingModesFor, clampEffort, thinkingEffortConflict,
} from '../src/effort.js';
import { setCapabilitiesForTest } from '../src/capabilities.js';
import { sessionOptions } from '../src/claude.js';
import { selectableModels } from '../src/models.js';

const config = JSON.parse(readFileSync(path.join(process.cwd(), 'config.json'), 'utf8'));
const available = config.claude.available;
const quiet = { onWarning: () => {} };

test('normalizeEffort: auto, null y vacío no piden nada; un nivel no válido lanza', () => {
  for (const v of ['auto', 'AUTO', null, undefined, '', '  ']) assert.equal(normalizeEffort(v), undefined);
  for (const l of EFFORT_LEVELS) assert.equal(normalizeEffort(l), l);
  assert.equal(normalizeEffort(' High '), 'high');
  assert.throws(() => normalizeEffort('ultra'), /is not valid/);
});

test('auto no añade nada: ni opciones ni avisos', () => {
  const r = effortOptionsFor({ model: 'opus', effort: 'auto', fastMode: false, available });
  assert.deepEqual(r, { options: {}, warnings: [] });
});

test('el esfuerzo se pasa tal cual cuando la familia lo admite', () => {
  assert.deepEqual(effortOptionsFor({ model: 'opus', effort: 'xhigh', available }).options, { effort: 'xhigh' });
  assert.deepEqual(effortOptionsFor({ model: 'claude-sonnet-5-5', effort: 'low', available }).options, { effort: 'low' });
});

test('Sonnet admite xhigh y max; un esfuerzo que la familia no admite se descarta con aviso, sin lanzar', () => {
  assert.deepEqual(effortOptionsFor({ model: 'sonnet', effort: 'xhigh', available }), { options: { effort: 'xhigh' }, warnings: [] });
  assert.deepEqual(capabilitiesOf('sonnet', available).efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  const h = effortOptionsFor({ model: 'haiku', effort: 'high', available });
  assert.deepEqual(h.options, {});
  assert.match(h.warnings[0], /haiku/);
  const bad = effortOptionsFor({ model: 'opus', effort: 'ultra', available });
  assert.deepEqual(bad.options, {});
  assert.match(bad.warnings[0], /is not valid/);
});

test('el modo rápido se fusiona en settings sin reemplazarlo', () => {
  const settings = { plansDirectory: 'x', other: { a: 1 } };
  const r = effortOptionsFor({ model: 'opus', fastMode: true, settings, available });
  assert.deepEqual(r.options.settings, { plansDirectory: 'x', other: { a: 1 }, fastMode: true });
  assert.deepEqual(settings, { plansDirectory: 'x', other: { a: 1 } }, 'el original no se toca');
  assert.deepEqual(effortOptionsFor({ model: 'opus', fastMode: true, available }).options.settings, { fastMode: true });
});

test('modo rápido: familia sin soporte o settings como ruta se descartan con aviso', () => {
  const a = effortOptionsFor({ model: 'haiku', fastMode: true, available });
  assert.deepEqual(a.options, {}); assert.equal(a.warnings.length, 1);
  const b = effortOptionsFor({ model: 'opus', fastMode: true, settings: '/x/settings.json', available });
  assert.deepEqual(b.options, {}); assert.match(b.warnings[0], /path/);
});

test('la ventana de contexto ya no existe: ni campo en las familias, ni beta, ni opción', () => {
  for (const m of available) assert.equal('context1m' in capabilitiesOf(m.id, available), false);
  const r = effortOptionsFor({ model: 'sonnet', contextWindow: '1m', available });
  assert.deepEqual(r, { options: {}, warnings: [] });
  assert.equal('betas' in sessionOptions({ cwd: '/x', model: 'sonnet', contextWindow: '1m', available, ...quiet }), false);
});

test('thinking y fallbackModel se pasan; thinking adaptativo no en Haiku', () => {
  const r = effortOptionsFor({ model: 'opus', thinking: { type: 'adaptive' }, fallbackModel: 'sonnet', available });
  assert.deepEqual(r.options, { thinking: { type: 'adaptive' }, fallbackModel: 'sonnet' });
  const h = effortOptionsFor({ model: 'haiku', thinking: { type: 'adaptive' }, available });
  assert.deepEqual(h.options, {}); assert.equal(h.warnings.length, 1);
  const sn = effortOptionsFor({ model: 'sonnet', thinking: { type: 'enabled', budgetTokens: 2000 }, available });
  assert.deepEqual(sn.options, {}); assert.equal(sn.warnings.length, 1);
  assert.equal(effortOptionsFor({ model: 'opus', thinking: { type: 'nope' }, available }).warnings.length, 1);
});

test('sessionOptions: incluye effort cuando se pide y lo omite si no', () => {
  const base = { cwd: '/x', model: 'opus', available, ...quiet };
  const without = sessionOptions(base);
  assert.equal('effort' in without, false);
  assert.equal('thinking' in without, false);
  assert.equal('fallbackModel' in without, false);
  assert.equal('settings' in without, false);
  assert.deepEqual(without.settingSources, ['user', 'project']);

  const tuned = sessionOptions({ ...base, effort: 'high', fastMode: true, settings: { k: 1 }, fallbackModel: 'sonnet', settingSources: ['user'] });
  assert.equal(tuned.effort, 'high');
  assert.deepEqual(tuned.settings, { k: 1, fastMode: true });
  assert.equal(tuned.fallbackModel, 'sonnet');
  assert.deepEqual(tuned.settingSources, ['user']);

  const auto = sessionOptions({ ...base, effort: 'auto' });
  assert.equal('effort' in auto, false);
});

test('sessionOptions: boardPlugins becomes options.plugins with the path of the machine the CLI runs on', async () => {
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tempDir } = await import('./teardown.mjs');
  const os = await import('node:os');
  const { boardPluginHooks, noteBoardPlugin, forgetBoardPlugins } = await import('../src/boardplugin.js');
  const root = tempDir('hfs-boardplugin-');
  const dir = path.join(root, 'plugins', 'hfs-ux');
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{"name":"hfs-ux"}');
  const realRoot = boardPluginHooks.root;
  boardPluginHooks.root = root;
  try {
    const base = { cwd: '/x', model: 'opus', available, ...quiet };
    const plain = sessionOptions(base);
    assert.equal('plugins' in plain, false, 'no boardPlugins, no plugins key');
    assert.deepEqual(sessionOptions({ ...base, boardPlugins: [] }), plain, 'an empty list changes nothing');

    // Local: the board's own checkout.
    assert.deepEqual(sessionOptions({ ...base, boardPlugins: ['hfs-ux'] }).plugins, [{ type: 'local', path: dir }]);
    const local = { kind: 'local', name: 'local', path, spawnClaude: null };
    assert.deepEqual(sessionOptions({ ...base, machine: local, boardPlugins: ['hfs-ux'] }).plugins, [{ type: 'local', path: dir }]);

    // A runner: its own directory, never the board's. Nothing cached: dropped with a warning.
    const runner = { kind: 'runner', name: 'box', path: path.posix, spawnClaude: () => null };
    const warnings = [];
    forgetBoardPlugins();
    const cold = sessionOptions({ ...base, machine: runner, boardPlugins: ['hfs-ux'], onWarning: (w) => warnings.push(w) });
    assert.equal('plugins' in cold, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /hfs-ux/);
    noteBoardPlugin('box', 'hfs-ux', '/srv/monitor/plugins/hfs-ux');
    const warm = sessionOptions({ ...base, machine: runner, boardPlugins: ['hfs-ux'] });
    assert.deepEqual(warm.plugins, [{ type: 'local', path: '/srv/monitor/plugins/hfs-ux' }]);
    assert.equal(typeof warm.spawnClaudeCodeProcess, 'function');
    forgetBoardPlugins();

    // Local without the plugin on disk: dropped with a warning too.
    boardPluginHooks.root = path.join(root, 'nada');
    const missing = [];
    assert.equal('plugins' in sessionOptions({ ...base, boardPlugins: ['hfs-ux'], onWarning: (w) => missing.push(w) }), false);
    assert.equal(missing.length, 1);
  } finally {
    boardPluginHooks.root = realRoot;
    forgetBoardPlugins();
    rmSync(root, { recursive: true, force: true });
  }
});

test('runClaude: boardPlugins reaches the SDK options, and onInit gets the init frame once', async () => {
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tempDir } = await import('./teardown.mjs');
  const os = await import('node:os');
  const { runClaude, claudeHooks } = await import('../src/claude.js');
  const { boardPluginHooks } = await import('../src/boardplugin.js');
  const root = tempDir('hfs-boardplugin-');
  const dir = path.join(root, 'plugins', 'hfs-ux');
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{"name":"hfs-ux"}');
  const original = { query: claudeHooks.query, onInit: claudeHooks.onInit, root: boardPluginHooks.root };
  const seen = [];
  const inits = [];
  claudeHooks.onInit = (info) => inits.push(info);
  boardPluginHooks.root = root;
  claudeHooks.query = ({ prompt, options }) => {
    seen.push(options);
    (async () => { for await (const _ of prompt) { /* stdin */ } })();
    const init = { type: 'system', subtype: 'init', session_id: 's', model: 'opus', skills: ['hfs-ux:design-canvas'], plugins: [{ name: 'hfs-ux', path: dir }], plugin_errors: [{ plugin: 'x', type: 'path-not-found', message: 'gone' }] };
    return (async function* stream() {
      yield init;
      yield init;
      yield { type: 'result', subtype: 'success', result: 'ok', session_id: 's', num_turns: 1 };
    })();
  };
  try {
    await runClaude({ cwd: '.', prompt: 'hola', model: 'opus', boardPlugins: ['hfs-ux'], onEvent: () => {} });
    await runClaude({ cwd: '.', prompt: 'hola', model: 'opus', onEvent: () => {} });
  } finally {
    claudeHooks.query = original.query;
    claudeHooks.onInit = original.onInit;
    boardPluginHooks.root = original.root;
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(seen[0].plugins, [{ type: 'local', path: dir }]);
  assert.equal('plugins' in seen[1], false);
  assert.equal(inits.length, 2, 'one per session: the repeated frame of the same session is not re-announced');
  assert.deepEqual(inits[0], {
    machine: 'local', skills: ['hfs-ux:design-canvas'], plugins: [{ name: 'hfs-ux', path: dir }],
    pluginErrors: [{ plugin: 'x', type: 'path-not-found', message: 'gone' }],
  });
});

test('sessionOptions: una combinación no soportada avisa y no lanza', () => {
  const seen = [];
  const o = sessionOptions({ cwd: '/x', model: 'haiku', effort: 'max', available, onWarning: (w) => seen.push(w) });
  assert.equal('effort' in o, false);
  assert.equal(seen.length, 1);
});

test('selectableModels: las familias configuradas, con sus esfuerzos y modos de razonamiento', () => {
  const list = selectableModels(available);
  assert.deepEqual(list.find((m) => m.id === 'opus').thinking, ['adaptive']);
  assert.deepEqual(list.find((m) => m.id === 'sonnet').thinking, ['adaptive']);
  assert.deepEqual(list.find((m) => m.id === 'haiku').thinking, ['enabled', 'disabled']);
  assert.ok(list.every((m) => !('context1m' in m)));
  assert.deepEqual(list.map((m) => m.id), available.map((m) => m.id));
  assert.deepEqual(list.find((m) => m.id === 'opus').efforts, CAPABILITIES.opus.efforts);
  assert.deepEqual(list.find((m) => m.id === 'haiku').efforts, []);
  assert.deepEqual(selectableModels([...available, { id: 'fable', label: 'Fable' }]).map((m) => m.id), [...available.map((m) => m.id), 'fable']);
});

test('config: claude.tuning trae todo en auto y qa.effort/planEffort también', () => {
  const t = config.claude.tuning;
  for (const k of ['triageEffort', 'advisorEffort', 'planEffort', 'fixEffort', 'prEffort', 'demoEffort', 'replyEffort', 'chatEffort']) {
    assert.equal(t[k], 'auto', k);
    assert.equal(normalizeEffort(t[k]), undefined);
  }
  assert.equal(t.fastMode, false);
  assert.equal(config.qa.effort, 'auto');
  assert.equal(config.qa.planEffort, 'auto');
});

test('runClaude: el esfuerzo llega a las opciones del SDK cuando se pide y se omite si no', async () => {
  const { runClaude, claudeHooks } = await import('../src/claude.js');
  const original = claudeHooks.query;
  const seen = [];
  claudeHooks.query = ({ prompt, options }) => {
    seen.push(options);
    (async () => { for await (const _ of prompt) { /* stdin */ } })();
    return (async function* stream() {
      yield { type: 'result', subtype: 'success', result: 'ok', session_id: 's', num_turns: 1 };
    })();
  };
  try {
    await runClaude({ cwd: '.', prompt: 'hola', model: 'opus', effort: 'max', onEvent: () => {} });
    await runClaude({ cwd: '.', prompt: 'hola', model: 'opus', onEvent: () => {} });
  } finally { claudeHooks.query = original; }
  assert.equal(seen[0].effort, 'max');
  assert.equal('effort' in seen[1], false);
});

test('thinkingModesFor: opus y sonnet solo adaptativo, haiku presupuesto o apagado, lo desconocido nada', () => {
  assert.deepEqual(thinkingModesFor('opus', available), ['adaptive']);
  assert.deepEqual(thinkingModesFor('claude-sonnet-5-5', available), ['adaptive']);
  assert.deepEqual(thinkingModesFor('haiku', available), ['enabled', 'disabled']);
  assert.deepEqual(thinkingModesFor('gpt-x', available), []);
  assert.equal(thinkingModesFor('sonnet', available).includes('between_tools'), false, 'between_tools queda fuera de esta ronda');
});

test('clampEffort: el nivel más alto admitido que no supere lo pedido; Haiku y auto, undefined', () => {
  assert.equal(clampEffort('opus', 'max', available), 'max');
  assert.equal(clampEffort('sonnet', 'xhigh', available), 'xhigh');
  assert.equal(clampEffort('haiku', 'high', available), undefined);
  for (const v of ['auto', null, undefined, '', 'ultra']) assert.equal(clampEffort('opus', v, available), undefined);
});

test('clampEffort y effortOptionsFor con capacidades vivas: baja al nivel admitido y avisa', () => {
  setCapabilitiesForTest({
    at: 1,
    init: { fast_mode_state: 'off' },
    models: [
      { value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFastMode: true, supportsAdaptiveThinking: true },
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6', resolvedModel: 'claude-opus-4-6', supportedEffortLevels: ['low', 'medium', 'high', 'max'], supportsFastMode: false, supportsAdaptiveThinking: true },
    ],
  });
  try {
    assert.equal(clampEffort('claude-opus-4-6', 'xhigh', available), 'high');
    assert.equal(clampEffort('claude-opus-4-6', 'max', available), 'max');
    const r = effortOptionsFor({ model: 'claude-opus-4-6', effort: 'xhigh', available });
    assert.deepEqual(r.options, { effort: 'high' });
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /xhigh.*high/);
  } finally { setCapabilitiesForTest(null); }
  assert.equal(clampEffort('claude-opus-4-6', 'xhigh', available), 'xhigh', 'sin sonda, vuelve la tabla estática (familia opus)');
});

test('un esfuerzo no admitido en Haiku no se envía, y el aviso lo dice', () => {
  const r = effortOptionsFor({ model: 'haiku', effort: 'high', available });
  assert.deepEqual(r.options, {});
  assert.match(r.warnings[0], /ignored/);
});

test('thinking enabled exige un presupuesto entero dentro de THINKING_BUDGET (solo Haiku)', () => {
  assert.deepEqual(THINKING_BUDGET, { min: 1024, max: 32000 });
  for (const budgetTokens of [THINKING_BUDGET.min, 5000, THINKING_BUDGET.max]) {
    const r = effortOptionsFor({ model: 'haiku', thinking: { type: 'enabled', budgetTokens }, available });
    assert.deepEqual(r, { options: { thinking: { type: 'enabled', budgetTokens } }, warnings: [] });
  }
  for (const budgetTokens of [undefined, 1023, 32001, 2000.5, '2000']) {
    const r = effortOptionsFor({ model: 'haiku', thinking: { type: 'enabled', budgetTokens }, available });
    assert.deepEqual(r.options, {}, String(budgetTokens));
    assert.equal(r.warnings.length, 1, String(budgetTokens));
  }
  assert.deepEqual(effortOptionsFor({ model: 'haiku', thinking: { type: 'disabled' }, available }).options, { thinking: { type: 'disabled' } });
});

test('thinkingEffortConflict: sin choques mientras between_tools no se ofrece', () => {
  assert.equal(thinkingEffortConflict({ type: 'adaptive' }, 'xhigh'), null);
  assert.equal(thinkingEffortConflict({ type: 'enabled', budgetTokens: 1024 }, undefined), null);
});

test('modo rápido: se descarta con aviso si la cuenta lo tiene apagado; con estado desconocido se pasa', () => {
  const live = (init) => setCapabilitiesForTest({ at: 1, init, models: [] });
  try {
    live({ fast_mode_state: 'off', fast_mode_disabled_reason: 'extra_usage_disabled' });
    const off = effortOptionsFor({ model: 'opus', fastMode: true, available });
    assert.deepEqual(off.options, {});
    assert.match(off.warnings[0], /extra_usage_disabled/);
    live({ fast_mode_state: 'off', fast_mode_disabled_reason: 'pending' });
    assert.deepEqual(effortOptionsFor({ model: 'opus', fastMode: true, available }).options, { settings: { fastMode: true } });
    live({ fast_mode_state: 'on' });
    assert.deepEqual(effortOptionsFor({ model: 'opus', fastMode: true, available }).options, { settings: { fastMode: true } });
  } finally { setCapabilitiesForTest(null); }
});
