import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import es from '../../web/src/i18n/strings/es.js';

// There is no web test runner: the card's danger group (the red Worktree
// button, Cerrar issue) is pinned by reading the sources as text.
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const danger = read('components/card/DangerGroup.jsx');
const css = read('styles/card-danger.css');

// The text lives in the Spanish catalog: pin the value there and the key's use in the source.
const pin = (p, value) => assert.equal(p.split('.').reduce((o, k) => o?.[k], es), value, p);

test('la zona de peligro es una sección propia y no pinta nada si no hay nada', () => {
  pin('card.danger.title', 'Zona de peligro');
  assert.match(danger, /<CardSection title=\{t\.card\.danger\.title\}>/);
  assert.doesNotMatch(danger, /<CardSection[^>]*tone=/);
  assert.match(danger, /return null;/);
});

test('el Worktree es rojo y solo aparece si hay worktree y la tarea no trabaja', () => {
  assert.match(danger, /const canDelete = task\.hasWorktree && !busy;/);
  assert.match(danger, /\{canDelete && \(/);
  assert.match(danger, /className="btn btn-danger btn-sm"/);
  assert.match(danger, /onDeleteWorktree\(task\.issue\)/);
  pin('card.danger.worktreeHelp', 'Para el stack y borra la carpeta en {machine}. La rama y el PR se conservan.');
  assert.match(danger, /fill\(t\.card\.danger\.worktreeHelp, \{ machine \}\)/);
});

test('mientras la tarea trabaja no hay botón, solo la nota', () => {
  assert.match(danger, /const lockedWorktree = task\.hasWorktree && busy;/);
  pin('card.danger.worktreeLocked', 'Borrar el worktree: cuando la tarea pare');
  assert.ok(danger.includes('t.card.danger.worktreeLocked'));
});

test('Cerrar issue es ámbar solo si es cerrable, nunca rojo, y se bloquea con closeBlocked', () => {
  assert.match(danger, /\$\{task\.closable \? 'btn-warn' : 'btn-secondary'\}/);
  assert.match(danger, /disabled=\{closeBlocked\}/);
  pin('card.danger.closePublishing', 'Publicando el cierre en GitHub…');
  pin('card.danger.closeDraftExists', 'ya hay una propuesta redactada esperando');
  pin('card.danger.closeManual', 'Cerrar el issue sin PR: un agente redacta la propuesta leyendo el chat, el issue y la rama; nada llega a GitHub sin que lo confirmes');
  for (const k of ['closePublishing', 'closeDraftExists', 'closeManual']) assert.ok(danger.includes(`t.card.danger.${k}`), k);
});

test('sin alias viejos ni rejilla vieja', () => {
  assert.doesNotMatch(danger, /className="(?:[^"]* )?danger[ "]/);
  assert.doesNotMatch(danger, /\bspan-2\b|\bc2\b/);
  assert.doesNotMatch(danger, / warn'/);
});

test('la franja roja izquierda vive en card-danger.css', () => {
  assert.match(css, /\.tcx-danger::before/);
  assert.match(css, /color-mix\(in oklab, var\(--red\) 55%, transparent\)/);
});

test('la papelera de la tarjeta cerrada: solo completada, con worktree y sin trabajar', () => {
  const card = read('components/TaskCard.jsx');
  pin('card.danger.worktreeDelete', 'Eliminar worktree');
  assert.match(card, /const canTrash = \(compact \|\| task\.state === 'done'\) && task\.hasWorktree && !busy;/);
  assert.match(card, /\{canTrash && \(\s*<button type="button" className="btn btn-icon btn-danger tc-foot-trash"/);
  assert.match(card, /e\.stopPropagation\(\); h\.onDeleteWorktree\(task\.issue\);/);
  assert.match(card, /<Icon name="trash" \/>\s*<\/button>\s*\)\}\s*<\/footer>/);
});
