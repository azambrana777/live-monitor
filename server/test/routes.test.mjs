// Un directorio de datos propio antes que nada: este archivo no importa
// `../src/…`, pero la regla vale igual — y `isolate.mjs` es lo que la prueba
// de `data-dir` reconoce.
import './isolate.mjs';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { removeTree } from './teardown.mjs';

/**
 * Las rutas con proyecto, contra el tablero de verdad.
 *
 * `server/src/index.js` levanta el servidor al importarse, así que la única
 * manera de probar sus rutas —y no una copia de ellas escrita aquí— es
 * arrancarlo: proceso propio, `HFSMON_CONFIG` y `HFSMON_DATA_DIR` propios, y
 * un `github.repo` que no existe para que el primer sondeo falle rápido y sin
 * tocar nada real.
 *
 * Lo que se comprueba es la colisión que toda esta oleada existe para evitar:
 * dos tareas con el **mismo número** en dos proyectos distintos. Con el número
 * suelto en la URL eran la misma; con `/api/projects/:project/tasks/:issue` no.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');

let dir;
let dataDir;
let port;
let child;

/** La rama de la #77, la tarea con worktree y trabajo sin publicar. */
const PENDING_BRANCH = 'fix/77-sin-cambios';

const url = (p) => `http://127.0.0.1:${port}${p}`;

async function call(method, p, body) {
  const res = await fetch(url(p), {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

/** Un puerto libre, pedido al sistema y devuelto en el acto. */
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port: p } = srv.address();
    srv.close(() => resolve(p));
  });
});

const task = (issue, title, over = {}) => ({
  issue, title, labels: [], url: `https://example.invalid/${issue}`,
  state: 'assigned', log: [{ ts: '2026-09-24T00:00:00.000Z', phase: 'estado', line: `log de ${title}` }],
  chats: [], ...over,
});

const project = (id, name, base) => ({
  id, name, repoPath: base, worktreeRoot: `${base}-wt`,
  repo: null, assignee: 'nobody', reviewer: 'nobody', overrides: {},
});

/**
 * Un git de verdad, con identidad propia y sin firmar: la máquina de quien
 * corre esto no decide si el commit sale.
 */
const git = (cwd, ...args) => execFileSync('git', [
  '-c', 'user.name=hfs-monitor test', '-c', 'user.email=test@example.invalid',
  '-c', 'commit.gpgsign=false', ...args,
], { cwd, stdio: 'pipe' });

/**
 * Un worktree enlazado de verdad, con un commit sin subir y un archivo sin
 * commitear, porque `pendingWork` no se puede simular con un directorio: mide
 * `git status` y `git rev-list` contra `origin/<rama>` y `origin/main`, así
 * que hace falta un remoto y una rama publicada. Devuelve la ruta.
 */
function worktreeWithPendingWork(dir, repoPath, branch) {
  const origin = path.join(dir, 'origin.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' });

  git(dir, 'init', '-b', 'main', repoPath);
  writeFileSync(path.join(repoPath, 'README.md'), 'raíz\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'root');
  git(repoPath, 'remote', 'add', 'origin', origin);
  git(repoPath, 'push', '-u', 'origin', 'main');

  const wtPath = path.join(`${repoPath}-wt`, branch.replaceAll('/', '-'));
  git(repoPath, 'worktree', 'add', wtPath, '-b', branch);
  const file = path.join(wtPath, 'nota.txt');

  writeFileSync(file, 'uno\n');
  git(wtPath, 'add', 'nota.txt');
  git(wtPath, 'commit', '-m', 'first');
  git(wtPath, 'push', '-u', 'origin', branch);

  // Un commit por encima de lo publicado: `unpushed` vale 1.
  writeFileSync(file, 'dos\n');
  git(wtPath, 'add', 'nota.txt');
  git(wtPath, 'commit', '-m', 'second');

  // Y el mismo archivo tocado y sin commitear: `dirty` vale 1. Tiene que ser
  // uno que la rama ya haya tocado — `pendingWork` ignora a propósito lo que
  // la rama no tiene nada que ver (specs regeneradas, salida de tests).
  writeFileSync(file, 'tres\n');
  return wtPath;
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'hfsmon-routes-'));
  dataDir = path.join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const hfsRepo = path.join(dir, 'hfs');
  const betaRepo = path.join(dir, 'app-b');
  mkdirSync(hfsRepo, { recursive: true });
  mkdirSync(betaRepo, { recursive: true });

  // La #77 tiene worktree de verdad, con trabajo sin publicar: es la única
  // manera de que `pendingWork` conteste algo.
  const wtPath = worktreeWithPendingWork(dir, hfsRepo, PENDING_BRANCH);

  // Dos proyectos, y en cada uno una issue #12: el choque, puesto a propósito.
  writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify({
    12: task(12, 'hfs doce'),
    4: task(4, 'hfs cuatro'),
    77: task(77, 'hfs setenta y siete', { branch: PENDING_BRANCH, worktreePath: wtPath, machine: 'local' }),
  }));
  writeFileSync(path.join(dataDir, 'tasks.app-b.json'), JSON.stringify({
    12: task(12, 'abeja doce'),
  }));
  writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([
    project('hfs', 'hfs', hfsRepo),
    project('app-b', 'app-b', betaRepo),
  ]));

  port = await freePort();
  const configFile = path.join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    port,
    // Un repositorio que no existe: `gh` contesta que no, el sondeo lo anota y
    // el tablero sigue. Nada de esta prueba depende de GitHub.
    github: { repo: 'nobody/nothing-at-all', assignee: 'nobody', reviewer: 'nobody' },
    poll: { intervalSeconds: 36000 },
    project: { repoPath: hfsRepo, worktreeRoot: `${hfsRepo}-wt` },
    limits: { defaultMaxActiveTasks: 1, maxActiveTasksCeiling: 2, maxFixIterations: 1, completedShown: 5 },
    claude: { chatModel: 'sonnet', available: ['sonnet'] },
  }));

  child = spawn(process.execPath, [path.join('server', 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      HFSMON_CONFIG: configFile,
      HFSMON_DATA_DIR: dataDir,
      // Que no arranque ninguna tarea por su cuenta mientras se le pregunta.
      HFSMON_NO_AUTOSTART: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (b) => log.push(String(b)));
  child.stderr.on('data', (b) => log.push(String(b)));
  child.once('exit', (code) => log.push(`[exit ${code}]`));

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await call('GET', '/api/tasks')).status === 200) break;
    } catch { /* todavía no escucha */ }
    if (Date.now() > deadline) throw new Error(`el tablero no levantó:\n${log.join('')}`);
    await new Promise((r) => { setTimeout(r, 150); });
  }
});

after(async () => {
  // Por su propio pid y sólo por él: este proceso lo arrancó esta prueba.
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
  // On Windows the directory can stay held for a moment after the board has exited
  // (something it started, probably git or gh) and `rmSync` does not wait: see teardown.mjs.
  // Any wait at all is reported, so a green run still shows whether the lock happened.
  const waited = await removeTree(dir);
  if (waited > 0) process.stderr.write(`[routes] ${dir} was held for ${waited} ms after the board exited\n`);
});

test('la misma issue #12 en dos proyectos son dos tareas, y cada ruta llega a la suya', async () => {
  const hfs = await call('GET', '/api/projects/hfs/tasks/12/log');
  const beta = await call('GET', '/api/projects/app-b/tasks/12/log');
  assert.equal(hfs.status, 200);
  assert.equal(beta.status, 200);
  // The startup poll may append its own warning lines: look for the seeded entry, not the last one.
  assert.ok(hfs.body.log.some((e) => /hfs doce/.test(e.line)));
  assert.ok(beta.body.log.some((e) => /abeja doce/.test(e.line)), 'antes el número suelto daba la tarea de hfs');
  assert.ok(!beta.body.log.some((e) => /hfs doce/.test(e.line)));
});

test('un número que sólo existe en un proyecto no aparece en el otro', async () => {
  assert.equal((await call('GET', '/api/projects/hfs/tasks/4/log')).status, 200);
  assert.equal((await call('GET', '/api/projects/app-b/tasks/4/log')).status, 404);
  assert.equal((await call('GET', '/api/projects/hfs/tasks/999/log')).status, 404);
});

test('una mitad mal escrita es un 404, no una clave inventada', async () => {
  // `HFS` en mayúsculas y `007` con cero delante no son formas canónicas: la
  // clave no se construye y nadie se lleva la tarea de al lado.
  assert.equal((await call('GET', '/api/projects/HFS/tasks/12/log')).status, 404);
  assert.equal((await call('GET', '/api/projects/hfs/tasks/012/log')).status, 404);
  assert.equal((await call('GET', '/api/projects/no-existe/tasks/12/log')).status, 404);
});

test('una acción cambia la tarea de su proyecto y deja intacta la del otro', async () => {
  const before = await call('GET', '/api/projects/app-b/tasks/12/demo');
  assert.equal(before.body.demo, 'auto');

  const changed = await call('POST', '/api/projects/hfs/tasks/12/demo-mode', { mode: 'off' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.demo, 'off');

  assert.equal((await call('GET', '/api/projects/hfs/tasks/12/demo')).body.demo, 'off');
  assert.equal((await call('GET', '/api/projects/app-b/tasks/12/demo')).body.demo, 'auto',
    'la #12 de la abeja no se entera');

  // Y otra acción más, por una ruta con cuerpo y con su propio validador.
  const approve = await call('POST', '/api/projects/app-b/tasks/12/approve-plan', { mode: 'on' });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.approvePlan, 'on');
  assert.equal((await call('GET', '/api/projects/hfs/tasks/12/qa')).status, 200);
});

test('el snapshot lleva el registro, el proyecto con el que abre, y un `project` por tarea', async () => {
  const { status, body } = await call('GET', '/api/tasks');
  assert.equal(status, 200);
  assert.deepEqual(body.projects.map((p) => p.id), ['hfs', 'app-b']);
  assert.equal(body.activeProject, 'hfs', 'el primero del registro, no una selección guardada');
  // El `project` singular es otra cosa: las rutas de la máquina.
  assert.ok(body.project.repoPath, '`project` sigue siendo config.project');
  const doce = body.tasks.filter((t) => t.issue === 12);
  assert.deepEqual(doce.map((t) => t.project).sort(), ['app-b', 'hfs']);
  assert.deepEqual(
    doce.map((t) => `${t.project}#${t.issue}:${t.demo}`).sort(),
    ['app-b#12:auto', 'hfs#12:off'],
  );
});

test('GET /api/projects lista el registro y /api/projects/:project/tasks filtra', async () => {
  const list = await call('GET', '/api/projects');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.projects.map((p) => p.id), ['hfs', 'app-b']);

  const mine = await call('GET', '/api/projects/app-b/tasks');
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.tasks.map((t) => t.issue), [12]);
  assert.equal((await call('GET', '/api/projects/no-existe/tasks')).status, 404);
});

test('POST /api/projects deduce todo lo que puede de la ruta del checkout', async () => {
  const repoPath = path.join(dir, 'Sudoku');
  mkdirSync(repoPath, { recursive: true });

  const created = await call('POST', '/api/projects', { repoPath });
  assert.equal(created.status, 201);
  assert.equal(created.body.id, 'sudoku', 'el último segmento, en minúsculas');
  assert.equal(created.body.name, 'Sudoku');
  assert.equal(created.body.repoPath, repoPath);
  assert.equal(created.body.worktreeRoot, `${repoPath}-wt`, 'la convención <checkout>-wt');
  assert.equal(created.body.repo, null, 'sin remoto de GitHub que leer');
  assert.equal(created.body.assignee, 'nobody', 'el asignado sale del config');
  // An empty checkout is the `blank` profile: nothing inherited from hfs.
  assert.deepEqual(created.body.overrides, { e2e: null, stack: null, qa: null });
  assert.equal(created.body.kind, 'blank');
  assert.equal(created.body.reviewer ?? null, null, 'nunca hereda el revisor de hfs');
  // The server runs out of process, so `configFor` is not importable here:
  // what it reads is the registry file, where both sections must be present
  // and null (`REPLACED_WHOLE` turns that into `configFor(id).e2e === null`).
  const stored = JSON.parse(readFileSync(path.join(dataDir, 'projects.json'), 'utf8'))
    .find((p) => p.id === 'sudoku');
  assert.ok(Object.hasOwn(stored.overrides, 'e2e') && stored.overrides.e2e === null);
  assert.ok(Object.hasOwn(stored.overrides, 'stack') && stored.overrides.stack === null);

  assert.deepEqual(
    (await call('GET', '/api/projects')).body.projects.map((p) => p.id),
    ['hfs', 'app-b', 'sudoku'],
  );
});

test('POST /api/projects rechaza con 400, y el motivo es el del registro', async () => {
  const repoPath = path.join(dir, 'Sudoku');
  const dup = await call('POST', '/api/projects', { repoPath });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /duplicate project id/, 'el mensaje del registro, tal cual');

  const missing = await call('POST', '/api/projects', {});
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /repoPath/);

  const nowhere = await call('POST', '/api/projects', { repoPath: path.join(dir, 'no-esta-aqui') });
  assert.equal(nowhere.status, 400);
  assert.match(nowhere.body.error, /does not exist/);

  // Sólo dígitos: el registro lo prohíbe por el `attachments/<issue>/` viejo.
  const digits = path.join(dir, '1447');
  mkdirSync(digits, { recursive: true });
  const numeric = await call('POST', '/api/projects', { repoPath: digits });
  assert.equal(numeric.status, 400);
  assert.match(numeric.body.error, /attachments\/1447\//);
});

test('las seis rutas de cerrar sin PR contestan 404 a una tarea que no existe', async () => {
  const gone = '/api/projects/hfs/tasks/999';
  const codes = await Promise.all([
    call('GET', `${gone}/close/draft`),
    call('GET', `${gone}/close/options`),
    call('GET', `${gone}/close/verify?ref=1`),
    call('POST', `${gone}/close/draft`, {}),
    call('POST', `${gone}/close/discard`, {}),
    call('POST', `${gone}/close`, { comment: 'No change needed.' }),
  ]);
  assert.deepEqual(codes.map((r) => r.status), [404, 404, 404, 404, 404, 404]);
});

test('POST …/close valida el comentario antes de la red: 400 con `problems` y sin llamar a `gh`', async () => {
  // El `github.repo` de esta prueba no existe, así que cualquier cosa que
  // llegara a `gh` volvería como un error de red o de repositorio —nunca como
  // una lista de `problems`—. Que la respuesta traiga esa lista es, por tanto,
  // la prueba de que la validación local corre PRIMERO. Si alguien invierte
  // ese orden, este test se cae, y ése es todo su trabajo.
  const res = await call('POST', '/api/projects/hfs/tasks/4/close', {
    comment: 'Este issue ya está resuelto y no hace falta ningún cambio en el código.',
    reason: 'completed',
  });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.problems), 'la ventana pinta `problems` dentro, sin cerrarse');
  assert.ok(res.body.problems.length, `sin motivos que pintar: ${JSON.stringify(res.body)}`);
});

test('POST …/close con trabajo sin publicar se planta con 409 y dice cuánto queda', async () => {
  const res = await call('POST', '/api/projects/hfs/tasks/77/close', {
    comment: 'No change needed: the existing guard already covers this case.',
    reason: 'completed',
  });
  assert.equal(res.status, 409, `se esperaba la negativa por trabajo pendiente: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.pending, 'la negativa lleva el recuento, no sólo el mensaje');
  assert.equal(res.body.pending.unpushed, 1, `un commit por encima de origin/${PENDING_BRANCH}`);
  assert.equal(res.body.pending.commits, true);
  // `dirty` es un RECUENTO, y la aserción es estricta a propósito: llegó a
  // viajar como la lista de archivos por un lado y como el número por el otro,
  // y el mismo aviso se pinta en dos sitios de la ventana. Una comprobación
  // tolerante a las dos formas deja volver al array sin ponerse en rojo, que
  // es justo lo que pasó.
  assert.equal(res.body.pending.dirty, 1, 'nota.txt tocado y sin commitear');
});

/**
 * La otra mitad del mismo contrato. El aviso de trabajo pendiente se pinta dos
 * veces —antes de confirmar, desde aquí, y en la negativa 409 de arriba— y los
 * dos tienen que hablar igual. Este test y el anterior son el único sitio donde
 * las dos formas se comparan.
 */
test('GET close/options da el mismo `pending` que la negativa', async () => {
  const res = await call('GET', `/api/projects/hfs/tasks/77/close/options`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.pending, 'con worktree, el aviso viaja');
  assert.equal(res.body.pending.dirty, 1, 'el recuento, no la lista');
  assert.equal(res.body.pending.unpushed, 1);
  assert.equal(res.body.pending.commits, true);
});
