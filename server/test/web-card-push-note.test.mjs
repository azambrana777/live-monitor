import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirtyNoteCount, gitUnknown } from '../../web/src/components/card/gitNote.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8').replace(/\r\n/g, '\n');
const code = read('components/card/CodeGroup.jsx');

test('nota de commit: solo con unpushed 0 y dirty > 0', () => {
  assert.equal(dirtyNoteCount({ unpushed: 0, dirty: 3 }), 3);
  assert.equal(dirtyNoteCount({ unpushed: 0, dirty: 0 }), 0);
  assert.equal(dirtyNoteCount({ unpushed: 2, dirty: 3 }), 0);
  assert.equal(dirtyNoteCount({ unpushed: null, dirty: 3 }), 0);
  assert.equal(dirtyNoteCount(null), 0);
});

test('estado desconocido: rama y worktree, sin branchStatus, no compacta', () => {
  const task = { branch: 'b', hasWorktree: true };
  assert.equal(gitUnknown(task, null, false), true);
  assert.equal(gitUnknown(task, null, true), false);
  assert.equal(gitUnknown(task, {}, false), false);
  assert.equal(gitUnknown({ branch: 'b' }, null, false), false);
});

test('CodeGroup usa las notas, la frescura y no escribe prosa', () => {
  assert.match(code, /dirtyNoteCount\(git\)/);
  assert.match(code, /plural\(dirtyN, t\.card\.code\.commitFirst\)/);
  assert.match(code, /fill\(t\.card\.code\.gitChecked, \{ ago: checkedAt \}\)/);
  assert.match(code, /t\.card\.code\.gitUnknown/);
  assert.match(code, /disabled=\{!canPush \|\| gitBusy/); // el botón sigue deshabilitado
});

test('catálogos: las tres claves en los 4 idiomas', async () => {
  for (const l of ['es', 'en', 'fr', 'de']) {
    const c = (await import(`../../web/src/i18n/strings/${l}/card.js`)).default;
    const o = c.code ?? c.card?.code ?? Object.values(c).find((v) => v?.commitFirst)?.code ?? c;
    const k = o.commitFirst ? o : o.code;
    assert.ok(k.commitFirst.one.includes('{n}') && k.commitFirst.other.includes('{n}'), l);
    assert.ok(k.gitChecked.includes('{ago}'), l);
    assert.ok(k.gitUnknown, l);
  }
});
