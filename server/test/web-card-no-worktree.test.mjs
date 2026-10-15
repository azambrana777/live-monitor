import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { needsWorktree, gitUnknown } from '../../web/src/components/card/gitNote.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8').replace(/\r\n/g, '\n');
const code = read('components/card/CodeGroup.jsx');

test('needsWorktree: sin worktree ni estado git, tarjeta completa, tarea viva', () => {
  const task = { branch: null, hasWorktree: false, state: 'queued' };
  assert.equal(needsWorktree(task, null, false), true);
  assert.equal(needsWorktree(task, null, true), false); // compacta
  assert.equal(needsWorktree(task, { behind: 0 }, false), false); // ya hay estado
  assert.equal(needsWorktree({ ...task, hasWorktree: true }, null, false), false);
  assert.equal(needsWorktree({ ...task, state: 'done' }, null, false), false);
  assert.equal(needsWorktree({ ...task, unassigned: { to: [] } }, null, false), false);
  assert.equal(needsWorktree(null, null, false), false);
});

test('no pisa el caso git desconocido (rama + worktree)', () => {
  const t = { branch: 'b', hasWorktree: true, state: 'queued' };
  assert.equal(gitUnknown(t, null, false), true);
  assert.equal(needsWorktree(t, null, false), false);
});

test('CodeGroup (solo fuente): botones deshabilitados, nota y crear worktree con el mismo handler', () => {
  assert.match(code, /needsWorktree\(task, git, compact\)/);
  assert.match(code, /onCreateWorktree\(task\.issue\)/);
  assert.match(code, /onCreateWorktree \} = h/);
  assert.match(code, /disabled=\{creating \|\| gitBusy\}/);
  assert.match(code, /t\.card\.code\.noWorktreeNote/);
  assert.match(code, /t\.card\.code\.createWorktree\b/);
  assert.match(code, /\{noTree && \(/);
});

test('catálogos: claves nuevas en los 4 idiomas', async () => {
  for (const l of ['es', 'en', 'fr', 'de']) {
    const c = (await import(`../../web/src/i18n/strings/${l}/card.js`)).default;
    const k = c.code ?? c.card?.code;
    for (const key of ['noWorktreeNote', 'createWorktree', 'createWorktreeTitle']) assert.ok(k[key], `${l}.${key}`);
  }
});
