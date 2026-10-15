// The i18n layer under web/src/i18n and the catalogs it serves: the core
// (language switch, plural, fill, splitAround, boot), and the four catalogs
// held to the Spanish source (same keys, same {holes}, none empty, none a
// copy of es). The web is plain JS, so this test is the only thing that keeps
// the catalogs honest; there is no compiler to do it.
//
// HFSMON_I18N_AREA=card limits the catalog and key-use checks to one area (see
// web-i18n-areas.mjs).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCALES, DEFAULT_LOCALE, LOCALE_KEY, isLocale, strings, locale, applyLocale, setLocale,
  onLocaleChange, resetLocaleState, fill, plural, splitAround,
} from '../../web/src/i18n/index.js';
import { bootLocale } from '../../web/src/i18n/boot.js';
import { formatNumber, formatPercent, formatDateTime } from '../../web/src/i18n/format.js';
import es from '../../web/src/i18n/strings/es.js';
import en from '../../web/src/i18n/strings/en.js';
import fr from '../../web/src/i18n/strings/fr.js';
import de from '../../web/src/i18n/strings/de.js';
import { AREAS, areaNames, filesInScope, read, ROOT } from './web-i18n-areas.mjs';
import path from 'node:path';

const TABLES = { es, en, fr, de };

// ---- helpers ----------------------------------------------------------

const paths = (node, prefix = '') => {
  if (typeof node === 'string') return [prefix];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) => paths(v, prefix ? `${prefix}.${k}` : k));
};
const at = (node, p) => p.split('.').reduce((acc, k) => acc?.[k], node);
const inScope = (p) => areaNames().includes(p.split('.')[0]);
const scoped = (table) => paths(table).filter(inScope);

// {n} may be left out of a `.one` form («una tarea»); every other hole may not.
const holes = (p, s) => (s.match(/\{(\w+)\}/g) ?? [])
  .filter((h) => !(p.endsWith('.one') && h === '{n}')).sort();

// Values a language may share with Spanish, with the reason. The list is exact:
// a stale entry fails too.
const SAME_AS_ES = {
  en: [
    'common.languageNames.es', 'common.languageNames.en', 'common.languageNames.fr',
    'common.languageNames.de', // a language names itself the same way everywhere
    'common.no', // "No" is the same word
    'topbar.settings.hoverSeconds', // «{n} s»: the symbol for seconds is the same everywhere
  ],
  fr: ['common.languageNames.es', 'common.languageNames.en', 'common.languageNames.fr', 'common.languageNames.de', 'topbar.settings.hoverSeconds'],
  de: ['common.languageNames.es', 'common.languageNames.en', 'common.languageNames.fr', 'common.languageNames.de', 'topbar.settings.hoverSeconds'],
};

let fakeLang;
const withDom = (fn) => {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = { documentElement: { setAttribute: (k, v) => { if (k === 'lang') fakeLang = v; } } };
  try { return fn(); } finally {
    if (prev) Object.defineProperty(globalThis, 'document', prev); else delete globalThis.document;
  }
};
const withStorage = (initial, fn) => {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const data = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) },
  });
  try { return fn(data); } finally {
    if (prev) Object.defineProperty(globalThis, 'localStorage', prev); else delete globalThis.localStorage;
  }
};

afterEach(() => { resetLocaleState(); fakeLang = undefined; });

// ---- the core ---------------------------------------------------------

test('Spanish is the default and the source, with no DOM and no stored choice', () => {
  assert.equal(DEFAULT_LOCALE, 'es');
  assert.equal(locale(), 'es');
  assert.deepEqual([...LOCALES], ['es', 'en', 'fr', 'de']);
  assert.equal(strings().common.cancel, 'Cancelar');
});

test('isLocale knows only the shipped languages', () => {
  for (const l of LOCALES) assert.equal(isLocale(l), true);
  for (const bad of ['', 'ES', 'en-US', 'it', null, undefined, 0, {}]) assert.equal(isLocale(bad), false);
});

test('applyLocale switches strings, <html lang> and subscribers together', () => {
  withDom(() => {
    let calls = 0;
    const off = onLocaleChange(() => { calls++; });
    assert.equal(applyLocale('fr'), 'fr');
    assert.equal(strings().common.cancel, 'Annuler');
    assert.equal(fakeLang, 'fr');
    assert.equal(calls, 1);
    off();
    applyLocale('de');
    assert.equal(calls, 1, 'an unsubscribed listener hears nothing');
  });
});

test('an unknown language falls back to Spanish', () => {
  assert.equal(applyLocale('klingon'), 'es');
  assert.equal(applyLocale(undefined), 'es');
});

test('setLocale remembers the choice, and boot reads it back before first paint', () => {
  withDom(() => withStorage({}, (data) => {
    setLocale('de');
    assert.equal(data.get(LOCALE_KEY), '"de"');
    resetLocaleState();
    assert.equal(locale(), 'es');
    assert.equal(bootLocale(), 'de');
    assert.equal(strings().common.cancel, 'Abbrechen');
    assert.equal(fakeLang, 'de');
  }));
});

test('boot falls back to Spanish for an absent, junk or unwritable store', () => {
  withDom(() => {
    withStorage({}, () => assert.equal(bootLocale(), 'es'));
    withStorage({ [LOCALE_KEY]: '"xx"' }, () => assert.equal(bootLocale(), 'es'));
    withStorage({ [LOCALE_KEY]: '{not json' }, () => assert.equal(bootLocale(), 'es'));
    assert.equal(bootLocale(), 'es', 'no localStorage at all');
  });
});

test('main.jsx imports the boot module before the app', () => {
  const src = read(path.join(ROOT, 'web', 'src', 'main.jsx'));
  const imports = [...src.matchAll(/^import\s.*?['"](.+?)['"];?$/gm)].map((m) => m[1]);
  assert.equal(imports[0], './i18n/boot.js');
  assert.ok(imports.indexOf('./i18n/boot.js') < imports.indexOf('./App.jsx'));
});

test('fill replaces named holes and leaves unfilled ones visible', () => {
  assert.equal(fill('hola {name}', { name: 'Ana' }), 'hola Ana');
  assert.equal(fill('{a} y {b}', { a: 1 }), '1 y {b}');
  assert.equal(fill('sin huecos'), 'sin huecos');
  assert.equal(fill('{toString}', {}), '{toString}', 'inherited keys are not holes');
});

test('plural picks the form by the language in use and fills {n}', () => {
  const forms = { one: '{n} tarea', other: '{n} tareas' };
  assert.equal(plural(1, forms), '1 tarea');
  assert.equal(plural(0, forms), '0 tareas');
  assert.equal(plural(2, forms), '2 tareas');
  applyLocale('en');
  assert.equal(plural(1, strings().common.task), '1 task');
  assert.equal(plural(3, strings().common.task), '3 tasks');
  applyLocale('fr');
  assert.equal(plural(0, strings().common.task), '0 tâche', 'French counts 0 as singular');
});

test('splitAround keeps a sentence whole and marks where the holes go', () => {
  assert.deepEqual(splitAround('{done} de 74', { done: 12 }), [
    { key: 'h0', text: '12', hole: 'done' }, { key: 't1', text: ' de 74', hole: null },
  ]);
  assert.deepEqual(splitAround('Quedan {n} tareas', { n: 3 }).map((p) => p.hole), [null, 'n', null]);
  const left = splitAround('{a} y {b}', { a: 1 });
  assert.equal(left.map((p) => p.text).join(''), '1 y {b}');
  assert.equal(left.filter((p) => p.hole).length, 1);
  assert.deepEqual(splitAround('Hecho', {}), [{ key: 't0', text: 'Hecho', hole: null }]);
});

test('format follows the language at call time', () => {
  assert.equal(formatNumber(1234.5), new Intl.NumberFormat('es').format(1234.5));
  applyLocale('de');
  assert.equal(formatNumber(1234.5), new Intl.NumberFormat('de').format(1234.5));
  assert.equal(formatPercent(0.26), new Intl.NumberFormat('de', { style: 'percent' }).format(0.26));
  assert.equal(formatDateTime('not a date'), '');
  assert.notEqual(formatDateTime('2026-01-02T03:04:05Z'), '');
});

// ---- the catalogs ------------------------------------------------------

test('every language has the same areas as the area map', () => {
  for (const l of LOCALES) assert.deepEqual(Object.keys(TABLES[l]).sort(), Object.keys(AREAS).sort(), l);
});

for (const l of LOCALES.filter((x) => x !== 'es')) {
  test(`${l} has exactly the keys of es`, () => {
    assert.deepEqual(scoped(TABLES[l]).sort(), scoped(es).sort());
  });

  test(`${l} keeps every {placeholder} of es`, () => {
    for (const p of scoped(es)) {
      const mine = at(TABLES[l], p);
      if (typeof mine !== 'string') continue; // the key test names the gap
      assert.deepEqual({ path: p, holes: holes(p, mine) }, { path: p, holes: holes(p, at(es, p)) });
    }
  });

  test(`${l} is translated: it shares with es only the listed values`, () => {
    const shared = scoped(es).filter((p) => at(TABLES[l], p) === at(es, p)).sort();
    assert.deepEqual(shared, SAME_AS_ES[l].filter(inScope).sort());
  });
}

test('no catalog string is empty or blank, in any language', () => {
  for (const l of LOCALES) {
    for (const p of scoped(TABLES[l])) assert.notEqual(String(at(TABLES[l], p)).trim(), '', `${l}.${p}`);
  }
});

test('plural entries are exactly { one, other }, in every language', () => {
  for (const l of LOCALES) {
    const walk = (node, p) => {
      if (!node || typeof node !== 'object') return;
      const keys = Object.keys(node);
      if (keys.includes('one') || keys.includes('other')) {
        assert.deepEqual(keys.sort(), ['one', 'other'], `${l}.${p}`);
        assert.match(node.other, /\{n\}/, `${l}.${p}.other must carry {n}`);
        return;
      }
      for (const k of keys) walk(node[k], p ? `${p}.${k}` : k);
    };
    walk(TABLES[l], '');
  }
});

test('"Iniciar HFS" never enters a catalog (the button is "Iniciar app")', () => {
  for (const l of LOCALES) assert.ok(!JSON.stringify(TABLES[l]).includes('Iniciar HFS'));
});

// ---- the keys components use -------------------------------------------

test('every t.area.key a file reads exists in the Spanish catalog', () => {
  const areas = Object.keys(es).join('|');
  const use = new RegExp(`\\b(?:t|txt|strings\\(\\))\\.(${areas})((?:\\.\\w+)+)`, 'g');
  const bad = [];
  for (const { file, name } of filesInScope()) {
    const src = read(file);
    if (!/from\s+['"][^'"]*i18n\/(?:index|useStrings)\.js['"]/.test(src)) continue;
    for (const m of src.matchAll(use)) {
      const p = `${m[1]}${m[2]}`;
      if (at(es, p) === undefined) bad.push(`${name}: ${p}`);
    }
  }
  assert.deepEqual([...new Set(bad)].sort(), []);
});
