import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import es from '../../web/src/i18n/strings/es.js';

// There is no web test runner: the card's shell (TaskCard.jsx, the groups
// it lengthens into, the in-flight guard and the props contract) is
// pinned by reading the sources as text, like web-mobile.test.mjs does.
// The groups themselves are pinned by web-card-work / -settings / -code / -danger.
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8').replace(/\r\n/g, '\n');
const card = read('components/TaskCard.jsx');
const css = read('styles.css');
const cardCss = read('styles/card.css');
const groups = fs.readdirSync(path.join(WEB, 'components/card'))
  .filter((f) => f.endsWith('.jsx')).map((f) => `components/card/${f}`);

test('la tarjeta ya no usa las etiquetas viejas', () => {
  assert.equal(card.includes('Browser QA Plan'), false);
  assert.equal(card.includes('Listo para revisión'), false);
  for (const rel of ['App.jsx', 'components/TaskCard.jsx', 'components/DemoPanel.jsx', ...groups]) {
    assert.equal(read(rel).includes('Browser QA Plan'), false, rel);
  }
});

test('la raíz es `tc` y los controles de más van en `tc-groups`, tras el botón de ampliar', () => {
  assert.match(card, /className=\{cls\}/);
  assert.match(card, /const cls = \['tc', `tc-\$\{info\.tone\}`/);
  assert.match(card, /<article id=\{cid\} className=\{cls\} onPointerEnter=\{armHover\}/);
  // Closed and lengthened are the same body: the lengthened one only adds the groups.
  assert.match(card, /const \[expanded, setExpanded\] = useState\(false\);/);
  assert.match(card, /<ExpandButton expanded=\{expanded\} onToggle=\{toggleExpanded\} controls=\{`\$\{cid\}-controls`\} \/>/);
  assert.match(card, /<div className="tc-groups" id=\{`\$\{cid\}-controls`\}>/);
  // Six groups, in the order of the BRIEF §6.
  const order = ['DecisionGroup', 'WorkGroup', 'CodeGroup', 'EnvGroup', 'SettingsGroup', 'DangerGroup']
    .map((g) => card.indexOf(`<${g} task={task} m={m} h={h} compact={compact} />`));
  assert.ok(order.every((i) => i > 0), 'the six groups are rendered with the contract props');
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'in order');
  assert.ok(order[0] > card.indexOf('className="tc-groups"'), 'inside tc-groups');
  // No switches, no grid of the old card.
  assert.doesNotMatch(card, /\bToggle\b/);
  assert.doesNotMatch(card, /card-controls|ctl-group|\bc1\b|\bc2\b|span-2/);
  assert.doesNotMatch(card, /className="actions/);
  // The old `.actions` flow and the card's grid are gone from styles.css: nothing renders them any more.
  assert.doesNotMatch(css, /\.actions|\.card-controls|\.ctl-group/);
});

test('la cerrada pinta el pie con la acción principal y Chat; en curso solo Chat y Plan', () => {
  assert.match(card, /<footer className="tc-foot">/);
  assert.match(card, /<DecisionGroup task=\{task\} m=\{m\} h=\{h\} compact=\{compact\} variant="footer" \/>/);
  assert.match(card, /<ReadyButton task=\{task\} m=\{m\} h=\{h\} \/>/);
  assert.match(card, /<ChatButton task=\{task\} m=\{m\} h=\{h\} \/>/);
  assert.match(card, /<PlanButton task=\{task\} m=\{m\} h=\{h\} \/>/);
  // The foot holds at most the four of them and the groups never share the card with it.
  assert.match(card, /\{expanded \? \(\n\s+<div className="tc-groups"/);
  // Compact (the Completadas strip) and parked by quota: only Chat.
  assert.match(card, /\{compact \|\| park \? <ChatButton task=\{task\} m=\{m\} h=\{h\} \/>/);
});

test('the «lienzos» chip shows only for a task with Lienzos de diseño on', () => {
  assert.equal(es.board.card.design, 'lienzos');
  assert.match(card, /\{task\.design === true && \(\n\s+<Chip tone="violet" icon="palette"[^>]*>\{t\.design\}<\/Chip>/);
  assert.equal((card.match(/>\{t\.design\}</g) ?? []).length, 1);
});

test('Código y PR and Entorno share a tc-pair wrapper, in group order', () => {
  assert.match(card, /<div className="tc-pair">\s*<CodeGroup task=\{task\} m=\{m\} h=\{h\} compact=\{compact\} \/>\s*<EnvGroup task=\{task\} m=\{m\} h=\{h\} compact=\{compact\} \/>\s*<\/div>/);
  assert.match(cardCss, /\.tc-groups > \.tc-pair \{ display: flex; gap: 12px;/);
});

test('the lengthened card does not repeat what DecisionGroup shows', () => {
  assert.match(card, /\{questionText && rich && !expanded && \(/);
  assert.match(card, /\{rich && !expanded && readyPlan && \(/);
  assert.match(card, /\{rich && !expanded && mode === 'unconfirmed' && task\.suspect && \(/);
  assert.match(card, /\{task\.error && !expanded && \(/);
});

test('the closing lines keep their amber and the closed card warns about main', () => {
  assert.match(cardCss, /\.tc-line\.pr-issue-open, \.tc-line\.closed-open-pr, \.tc-line\.closed-no-merge \{ color: var\(--amber\); \}/);
  assert.match(card, /\{rich && !expanded && git && \(behind > 0 \|\| git\.conflicts > 0\) && \(/);
  assert.equal(es.board.card.conflictMain, 'conflicto con main');
  assert.match(card, /\$\{t\.conflictMain\} · /);
});

test('the card header uses the shared primitives', () => {
  assert.match(card, /import ExpandButton from '\.\/ui\/ExpandButton\.jsx'/);
  assert.match(card, /import Pill from '\.\/ui\/Pill\.jsx'/);
  assert.match(card, /import Chip from '\.\/ui\/Chip\.jsx'/);
  assert.match(card, /<Pill tone=\{pillTone\} live=\{busy\} icon=\{info\.icon\}>/);
});

test('the waiting pill says nothing false about an unanswered Artifact question', () => {
  assert.match(card, /isPublishQuestion\(pending\?\.questions\)/);
  assert.match(es.board.card.waitTitlePublish, /si nadie responde a tiempo, no se publica/);
  assert.match(card, /isPublishQuestion\(pending\?\.questions\) \? t\.waitTitlePublish/);
});

test('CardSection is labelled by its own title and keeps the tones of the contract', () => {
  const section = read('components/card/CardSection.jsx');
  assert.match(section, /aria-labelledby=\{titleId\}/);
  assert.match(section, /<h3 className="tc-section-title" id=\{titleId\}>/);
  assert.match(section, /tone = 'default'/);
  for (const rule of ['\.tc-section \{', '\.tc-section-warn \{', '\.tc-section-danger \{', '\.tc \.is-located|\.tc\.is-located']) {
    assert.match(cardCss, new RegExp(rule), rule);
  }
  assert.match(cardCss, /border-top: 1px solid var\(--line\)/);
});

test('the card stylesheet is the card\'s own: tokens only, no !important, phone block', () => {
  assert.doesNotMatch(cardCss, /!important/);
  assert.doesNotMatch(cardCss, /#[0-9a-fA-F]{3,6}\b/);
  assert.match(cardCss, /@media \(max-width: 780px\)/);
  assert.match(cardCss, /\.tc-head \.ui-expand \{ width: 32px; height: 32px; \}/);
  assert.match(cardCss, /\.tc\.is-located \{ animation: locate-flash/);
  assert.match(cardCss, /@keyframes locate-flash/);
});

test('the in-flight guard of the card reads the set of requests in flight', () => {
  // `inFlight` reads the set of requests in flight. When it read `pending` (the card's own question
  // object, a plain object with no `.has`) it threw, and the buttons never went disabled.
  assert.match(card, /const inFlight = [^\n]*inflightKeys\?\.has\(actionKey\(/);
});

// The in-flight set used to travel as a prop named `pending`, which the card also declares
// as a local (the question waiting for an answer). The build stops on that
// ("Identifier `pending` has already been declared"), and the tests never build the web.
test('a TaskCard prop is never declared again as a local', () => {
  const header = /export default function TaskCard\(\{([\s\S]*?)\}\) \{/.exec(card);
  assert.ok(header, 'the props of TaskCard were found');
  const props = header[1].split(',').map((p) => p.trim().split('=')[0].trim()).filter(Boolean);
  assert.ok(props.length > 20, `read the whole prop list (${props.length})`);
  for (const name of props) {
    assert.doesNotMatch(card, new RegExp(`\\n\\s*(?:const|let|var) ${name}\\b`), `${name} is a prop and is declared again`);
  }
  assert.ok(props.includes('inflightKeys'), 'the in-flight set has its own name');
});

test('hover: el reposo configurado abre, salir cierra con 150 ms de gracia, el clic ancla', () => {
  assert.doesNotMatch(card, /HOVER_OPEN_MS/);
  assert.match(card, /const HOVER_LEAVE_MS = 150;/);
  assert.match(card, /onPointerEnter=\{armHover\} onPointerMove=\{\(e\) => \{ armHover\(e\); onTapMove\(e\); \}\} onPointerLeave=\{onCardLeave\}/);
  assert.match(card, /e\.buttons !== 0/);
  assert.match(card, /e\.pointerType !== 'mouse' \|\| suppressHover\.current\) return;/);
  assert.match(card, /const suppressHover = useRef\(false\);/);
  assert.match(card, /pinned\.current = false; suppressHover\.current = true; setExpanded\(false\)/);
  assert.match(card, /const onCardLeave = \(\) => \{\s*suppressHover\.current = false;/);
  assert.match(card, /const pinned = useRef\(false\);/);
  assert.match(card, /pinned\.current = true; setExpanded\(true\)/);
  assert.match(card, /useEffect\(\(\) => clearTimers, \[\]\);/);
});
