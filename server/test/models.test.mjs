import './isolate.mjs';   // primero: aisla el directorio de datos
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveModel, shortName, familyOf, noteResolved, resolvedModels, forgetResolved } from '../src/models.js';
import { isNewerVersion } from '../src/claude.js';

/**
 * Against the real config, on purpose: the aliases people type are a promise
 * about *this* list, and it was a version pinned in config.json that once
 * left the board on Fable 5 with 5.1 out. Families, not versions, from here.
 */
const config = JSON.parse(readFileSync(path.join(process.cwd(), 'config.json'), 'utf8'));
const available = config.claude.available;
const id = (arg) => resolveModel(available, arg).match?.id;

test('la configuración nombra familias, no versiones: así el CLI elige siempre la última', () => {
  assert.deepEqual(available.map((m) => m.id), ['opus', 'sonnet', 'fable', 'haiku']);
  const roles = ['triageModel', 'fixModel', 'chatModel', 'demoModel', 'replyModel', 'advisorModel', 'planModel'];
  for (const role of roles) {
    assert.ok(['opus', 'sonnet', 'fable', 'haiku'].includes(config.claude[role]), `${role} = ${config.claude[role]} es una versión concreta, no una familia`);
  }
  assert.equal(config.qa.model, 'sonnet');
  assert.equal(config.qa.planModel, 'opus');
});

test('las palabras cortas resuelven a su familia, y «fable» es una familia más', () => {
  assert.equal(id('opus'), 'opus');
  assert.equal(id('Opus'), 'opus');
  assert.equal(id('fable'), 'fable');
  assert.equal(id('Fable'), 'fable');
  assert.equal(id('sonnet'), 'sonnet');
  assert.equal(id('haiku'), 'haiku');
  assert.deepEqual(available.map(shortName), ['opus', 'sonnet', 'fable', 'haiku'], 'lo que /model lista como alias');
});

test('lo que se escribía antes sigue funcionando: versión, id concreto, etiqueta', () => {
  assert.equal(id('opus 5'), 'opus');
  assert.equal(id('Opus 5.1'), 'opus');
  assert.equal(id('claude-opus-5'), 'opus', 'el id viejo, por si alguien lo tiene en los dedos');
  assert.equal(id('claude-opus-5-1'), 'opus');
  assert.equal(id('claude-fable-5-1'), 'fable', 'un id de Fable es de la familia fable, no de otra');
  assert.equal(id('claude-haiku-4-5-20251001'), 'haiku');
});

test('lo que no existe no se adivina, y lo ambiguo se devuelve como tal', () => {
  assert.deepEqual(resolveModel(available, 'gpt'), {});
  assert.deepEqual(resolveModel(available, ''), {});
  assert.deepEqual(resolveModel(available, '5'), {}, 'un número solo no es ningún modelo');
});

test('familyOf lleva un id concreto a su familia, y deja en paz lo que no es de ninguna', () => {
  assert.equal(familyOf('claude-opus-5', available), 'opus');
  assert.equal(familyOf('claude-opus-5-1', available), 'opus');
  assert.equal(familyOf('claude-fable-5-1', available), 'fable');
  assert.equal(familyOf('claude-haiku-4-5-20251001', available), 'haiku');
  assert.equal(familyOf('opus', available), 'opus', 'un alias es de su propia familia');
  assert.equal(familyOf('gpt-5', available), null);
  assert.equal(familyOf(null, available), null);
});

test('lo que resuelve cada alias se recuerda, y el cambio se señala una vez', () => {
  forgetResolved();
  assert.deepEqual(noteResolved('opus', 'claude-opus-5-5'), { changed: false, first: true, previous: null });
  assert.deepEqual(noteResolved('opus', 'claude-opus-5-5'), { changed: false, first: false, previous: 'claude-opus-5-5' });
  const bump = noteResolved('opus', 'claude-opus-5-6');
  assert.equal(bump.changed, true);
  assert.equal(bump.previous, 'claude-opus-5-5');
  assert.equal(noteResolved('opus', 'claude-opus-5-6').changed, false, 'la segunda vez ya no es noticia');
  const listed = resolvedModels(available);
  assert.equal(listed.find((m) => m.alias === 'opus').resolved, 'claude-opus-5-6');
  assert.equal(listed.find((m) => m.alias === 'opus').previous, 'claude-opus-5-5');
  assert.equal(listed.find((m) => m.alias === 'sonnet').resolved, null, 'sin sesión aún, no se inventa');
  assert.deepEqual(noteResolved(null, 'x'), { changed: false, first: false, previous: null });
  forgetResolved();
});

test('el SDK sabe cuándo está por detrás', () => {
  assert.equal(isNewerVersion('0.3.301', '0.3.266'), true);
  assert.equal(isNewerVersion('0.4.0', '0.3.999'), true);
  assert.equal(isNewerVersion('0.3.266', '0.3.266'), false);
  assert.equal(isNewerVersion('0.3.200', '0.3.266'), false);
  assert.equal(isNewerVersion(null, '0.3.266'), false, 'sin red no hay aviso');
  assert.equal(isNewerVersion('latest', '0.3.266'), false);
});

// The check done by hand on 2026-09-12, repeatable: one turn per family with
// the local login, and the concrete model each one gets belongs to it. Costs
// three short sessions, so only when asked for.
test('en vivo: cada alias resuelve a un modelo de su familia', { skip: process.env.HFSMON_LIVE !== '1' && 'HFSMON_LIVE=1 para lanzarlo' }, async () => {
  const { runClaude } = await import('../src/claude.js');
  const { tmpdir } = await import('node:os');
  await Promise.all(available.map(async (m) => {
    let got = null;
    const r = await runClaude({ cwd: tmpdir(), model: m.id, maxTurns: 1, prompt: 'Reply with the single word ok.', onEvent: (ev) => { if (ev.kind === 'init') got = ev.model; } });
    assert.equal(r.ok, true, `${m.id}: ${r.error}`);
    assert.equal(familyOf(got, available), m.id, `${m.id} resolvió a ${got}`);
  }));
});
