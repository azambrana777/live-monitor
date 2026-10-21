// The file viewer's server side against real disks: `local` is this process
// and `box` is an in-process runner over real HTTP, each with its own checkout,
// worktree root, home and scratchpad under one temp dir. Homes, users and
// scratchpads go through `filesHooks`, so nothing here reads the user's real
// `~/.claude`.
//
// The in-process runner reports `linux` while its disk is this host's. On a
// Windows host that means a real `/home/…` file cannot exist, so absolute-path
// routing is proved by which machines appear in `tried`; a Windows path
// reaching `box` is proved by giving `box` the Windows `platform` and `path`
// for that one test; and `filesHooks.isAbsolute` accepts `C:\…` for `box`,
// because those are the only absolute paths its disk has. POSIX-only rules
// (backslash segments, `/tmp/claude-*`) are proved on `rootPlace` alone with
// `path.posix`, which is the same arithmetic whatever the host.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync, realpathSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { removeTree, tempDir } from './teardown.mjs';

const dataDir = mkdtempSync(path.join(tmpdir(), 'hfsmon-files-data-'));
process.env.HFSMON_DATA_DIR = dataDir;
process.env.HFSMON_NO_AUTOSTART = '1';

const HOST_WIN = process.platform === 'win32';
const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'hfsmon-files-')));
const TOKEN = 'secreto-de-prueba';
const BRANCH = 'feat/5100-visor';

const git = (args, cwd) => execFileSync(
  'git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' },
);
const write = (dir, name, data) => {
  const file = path.join(dir, ...name.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  return file;
};

const L = {
  repo: path.join(ROOT, 'local-repo'), wtRoot: path.join(ROOT, 'local-wt'),
  home: path.join(ROOT, 'local-home'), tmp: path.join(ROOT, 'local-tmp', 'claude'),
};
const B = {
  repo: path.join(ROOT, 'box-repo'), wtRoot: path.join(ROOT, 'box-wt'),
  home: path.join(ROOT, 'box-home'), tmp: path.join(ROOT, 'box-tmp', 'claude'),
};
L.wt = path.join(L.wtRoot, BRANCH.replaceAll('/', '-'));
B.wt = path.join(B.wtRoot, BRANCH.replaceAll('/', '-'));
const BOARD_WT = path.join(L.wtRoot, 'feat-1-tablero');
const OUTSIDE = path.join(ROOT, 'outside');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);

let files;
let config;
let machines;
let store;
let runner;
let savedMachines;
// What `filesHooks.boardRoot` is in production, taken before the suite replaces it.
let realBoardRoot;

before(async () => {
  ({ config } = await import('../src/config.js'));
  ({ machines } = await import('../src/machine.js'));
  ({ store } = await import('../src/store.js'));
  files = await import('../src/files.js');
  const { createRunner } = await import('../src/runner/app.js');

  // local: a real git checkout, one tracked doc deep down and a gitignored tmp/.
  mkdirSync(L.repo, { recursive: true });
  git(['init', '-b', 'main', '.'], L.repo);
  git(['config', 'user.email', 't@e.com'], L.repo);
  git(['config', 'user.name', 'T'], L.repo);
  write(L.repo, '.gitignore', 'tmp/\n');
  write(L.repo, 'docs/deep/guia-unica.md', '# guía\n');
  write(L.repo, 'docs/guide.md', '# Guide\n\ntexto\n');
  write(L.repo, 'img/pixel.png', PNG);
  write(L.repo, 'notes/both.md', 'copia del checkout, no del worktree\n');
  git(['add', '.'], L.repo);
  git(['commit', '-m', 'seed'], L.repo);
  write(L.repo, 'tmp/user/docs/nota-ignorada.md', '# en tmp\n');
  for (const secret of ['.env.json', 'credentials.json', '.credentials.json', '.mcp.json', 'secrets.yaml', '.git/notas.md']) {
    write(L.repo, secret, '{"secret":1}');
  }
  write(L.repo, 'grande.md', 'x'.repeat(2 * 1024 * 1024 + 1));
  mkdirSync(path.join(L.repo, 'carpeta.md'));

  // The board's own tree, as the viewer sees it: `L.repo` plays the board
  // checkout (see `filesHooks.boardRoot` below) and `BOARD_WT` a worktree of it.
  for (const name of [
    'config.json', 'config.local.json', 'server/data/projects.json', '.claude/settings.json', '.claude/skills/x/SKILL.md',
    '.claude/sin-extension', 'hfs-monitor.log', 'CLAUDE.local.md', 'tools/decisions/sessions.local.json',
  ]) write(L.repo, name, '{"token":"secreto"}');
  write(L.repo, 'src/app.js', 'export const ok = 1;\n');
  write(L.repo, 'tools/decisions/config.json', '{"cutoff":1}');
  for (const name of ['config.json', 'server/data/a.json', '.claude/settings.json', 'run.log']) write(BOARD_WT, name, '{"token":"secreto"}');
  for (const name of ['config.local.json', 'tools/x.local.json', 'CLAUDE.local.md']) write(BOARD_WT, name, '{"token":"secreto"}');
  write(BOARD_WT, 'src/app.js','export const ok = 2;\n');
  write(B.wt, 'run.log', 'log del box\n');

  write(L.wt, 'notes/both.md', 'versión local\n');
  write(L.wt, 'notes/only-local.md', 'solo en local\n');
  write(B.wt, 'notes/both.md', 'versión del box, distinta\n');
  write(B.wt, 'notes/only-box.md', 'solo en el box\n');
  write(B.repo, 'box-doc.md', '# box\n');
  write(B.tmp, 'borrador.md', '# del scratchpad del box\n');
  write(L.home, '.claude/plans/plan-x.md', '# plan\n');
  write(L.home, 'tmp/bench-opt/prs/informe.md', '# informe\n');
  mkdirSync(L.tmp, { recursive: true });

  write(OUTSIDE, 'secret.md', 'fuera\n');
  symlinkSync(OUTSIDE, path.join(L.repo, 'escape'), 'junction');

  runner = createRunner({
    token: TOKEN, repoPath: B.repo, worktreeRoot: B.wtRoot,
    attachmentsDir: path.join(ROOT, 'attachments'), claudeCommand: process.execPath,
  });
  const addr = await runner.listen(0, '127.0.0.1');
  savedMachines = config.machines;
  config.machines = {
    local: { kind: 'local', repoPath: L.repo, worktreeRoot: L.wtRoot },
    box: { kind: 'runner', url: `http://127.0.0.1:${addr.port}`, token: TOKEN, repoPath: B.repo, worktreeRoot: B.wtRoot },
  };

  realBoardRoot = files.filesHooks.boardRoot;
  files.filesHooks.homeOf = async (m) => (m.name === 'local' ? L.home : B.home);
  files.filesHooks.uidOf = async () => null;
  files.filesHooks.boardRoot = (m) => (m.kind === 'local' ? L.repo : null);
  files.filesHooks.tmpRoots = (m) => [m.name === 'local' ? L.tmp : B.tmp];
  files.filesHooks.isAbsolute = (m, p) => (HOST_WIN && m.kind === 'runner' ? path.win32.isAbsolute(p) : m.path.isAbsolute(p));
  files.filesHooks.probeMs = 5000;
});

after(async () => {
  config.machines = savedMachines;
  if (savedMachines === undefined) delete config.machines;
  store.flush();
  await runner?.close();
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

const status = (code) => (e) => { assert.equal(e.status, code, e.message); return true; };
const task = (over = {}) => ({ issue: 5100, machine: 'local', branch: BRANCH, worktreePath: null, places: {}, ...over });

/** Replaces `obj[key]` for the length of `fn`, whatever happens inside. */
async function withStub(obj, key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(obj, key);
  const saved = obj[key];
  obj[key] = value;
  try {
    return await fn();
  } finally {
    if (had) obj[key] = saved;
    else delete obj[key];
  }
}

test('parseRef: backticks, comillas, :línea, :línea:col, rangos y #L; URLs y sin extensión fuera', () => {
  const { parseRef } = files;
  assert.deepEqual(parseRef('`tmp/user/docs/937-plan.md`'), { path: 'tmp/user/docs/937-plan.md', line: null, col: null });
  assert.deepEqual(parseRef(' "crates/hfs/README.md:352" '), { path: 'crates/hfs/README.md', line: 352, col: null });
  assert.deepEqual(parseRef("'src/lib.rs:12:3'"), { path: 'src/lib.rs', line: 12, col: 3 });
  assert.deepEqual(parseRef('src/lib.rs:10-20'), { path: 'src/lib.rs', line: 10, col: null });
  assert.deepEqual(parseRef('README.md#L12'), { path: 'README.md', line: 12, col: null });
  assert.deepEqual(parseRef('README.md#L12-L20'), { path: 'README.md', line: 12, col: null });
  assert.deepEqual(parseRef('C:\\x\\y.md'), { path: 'C:\\x\\y.md', line: null, col: null });
  assert.deepEqual(parseRef('C:/x/y.md:7'), { path: 'C:/x/y.md', line: 7, col: null });
  assert.deepEqual(parseRef('~/.claude/plans/p.md'), { path: '~/.claude/plans/p.md', line: null, col: null });
  assert.equal(parseRef('https://github.com/x/README.md'), null);
  assert.equal(parseRef('Makefile'), null);
  assert.equal(parseRef('archivo.exe'), null);
  assert.equal(parseRef('a.md\nb.md'), null);
  assert.equal(parseRef(''), null);
  assert.deepEqual(files.kindOf('a/b/Main.RS'), { kind: 'text', lang: 'rust', ext: 'rs' });
  assert.deepEqual(files.kindOf('x.svg'), { kind: 'image', lang: null, ext: 'svg' });
  assert.equal(files.kindOf('x.toml').lang, 'ini');
});

test('rootPlace con reglas POSIX: la barra invertida no trepa, el scratch se mira normalizado', () => {
  const box = { platform: 'linux', path: path.posix };
  const roots = { main: ['/home/user/src/hfs'], scratch: ['/tmp/claude'] };
  assert.equal(files.rootPlace(box, roots, '/home/user/src/hfs/docs/x.md'), 'main');
  assert.equal(files.rootPlace(box, roots, '/tmp/x\\..\\..\\home/user/src/hfs/evil.md'), null,
    'en Linux es un nombre raro dentro de /tmp, no un archivo del checkout');
  assert.equal(files.rootPlace(box, roots, '/home/user/src/hfs/a\\b.md'), 'main', 'una barra invertida sin . ni .. es un nombre más');
  assert.equal(files.rootPlace(box, roots, '/home/user/src/hfs/../../.ssh/x.md'), null);
  assert.equal(files.rootPlace(box, roots, '/tmp/claude/f.md'), 'scratch');
  assert.equal(files.rootPlace(box, roots, '/tmp/claude-1000/sesion/f.md'), 'scratch');
  assert.equal(files.rootPlace(box, roots, '/tmp/claude-x/../../etc/passwd.md'), null);
  assert.equal(files.rootPlace(box, roots, '/tmp/claudette/f.md'), null);

  const win = { platform: 'win32', path: path.win32 };
  assert.equal(files.rootPlace(win, { main: ['C:\\Users\\E\\repo'] }, 'c:\\users\\e\\REPO\\x.md'), 'main', 'Windows sin mayúsculas');
  assert.equal(files.rootPlace(win, { main: ['C:\\Users\\E\\repo'] }, 'C:\\Users\\E\\repo2\\x.md'), null);
  assert.equal(files.rootPlace(win, { main: [] }, '/tmp/claude/f.md'), null, 'la regla de /tmp no es de Windows');
});

test('allowedRoots: worktrees, checkout, plans y ~/tmp del home y scratchpad', async () => {
  const roots = await files.allowedRoots(machines().local);
  assert.deepEqual(roots, [L.wtRoot, L.repo, path.join(L.home, '.claude', 'plans'), path.join(L.home, 'tmp'), L.tmp],
    'the board checkout here is the project checkout: it is not listed twice');
});

test('allowedRoots: la raíz del tablero se suma solo en la máquina local', async () => {
  const board = path.join(ROOT, 'board-tree');
  await withStub(files.filesHooks, 'boardRoot', (m) => (m.kind === 'local' ? board : null), async () => {
    assert.deepEqual(await files.allowedRoots(machines().local), [L.wtRoot, L.repo, board, path.join(L.home, '.claude', 'plans'), path.join(L.home, 'tmp'), L.tmp]);
    const boxRoots = await files.allowedRoots(machines().box);
    assert.ok(!boxRoots.includes(board), 'a runner is not where the board runs');
    assert.equal(boxRoots.length, 5);
  });
});

test('una ruta relativa que solo está en el box se abre desde una tarea local, y viceversa', async () => {
  const fromLocal = await files.resolveRef({ task: task({ worktreePath: L.wt }), ref: '`notes/only-box.md`' });
  assert.deepEqual(fromLocal.unreachable, []);
  assert.equal(fromLocal.candidates.length, 1);
  const [c] = fromLocal.candidates;
  assert.equal(c.machine, 'box');
  assert.equal(c.base, 'worktree', 'el worktree de la rama en el box, aunque la tarea no haya estado allí');
  assert.equal(c.rel, 'notes/only-box.md');
  assert.equal(c.active, false);
  assert.equal(c.kind, 'md');
  assert.equal(c.bytes, undefined, 'los candidatos no llevan bytes');
  assert.ok(fromLocal.tried.some((t) => t.machine === 'local' && t.status === 404), 'y dice dónde miró en local');

  const fromBox = await files.resolveRef({
    task: task({ machine: 'box', worktreePath: B.wt, places: { local: { worktreePath: L.wt } } }),
    ref: 'notes/only-local.md:4',
  });
  assert.equal(fromBox.line, 4);
  assert.deepEqual(fromBox.candidates.map((x) => [x.machine, x.base, x.active]), [['local', 'worktree', false]]);

  const opened = await files.readAllowed({ machine: c.machine, path: c.path });
  assert.equal(opened.bytes.toString('utf8'), 'solo en el box\n', 'y se lee por el runner');
  assert.equal(opened.etag, c.etag);
});

test('una tarea sin rama ni worktree busca solo en el checkout', async () => {
  const r = await files.resolveRef({ task: task({ branch: null }), ref: 'docs/guide.md' });
  assert.deepEqual(r.candidates.map((x) => [x.machine, x.base]), [['local', 'repo']]);
});

test('el mismo relativo en las dos máquinas: dos candidatos, la activa primero, ETags distintos', async () => {
  const onBox = await files.resolveRef({ task: task({ machine: 'box', worktreePath: B.wt }), ref: 'notes/both.md' });
  assert.deepEqual(onBox.candidates.map((x) => [x.machine, x.active, x.rel, x.base]), [
    ['box', true, 'notes/both.md', 'worktree'],
    ['local', false, 'notes/both.md', 'worktree'],
  ], 'el checkout de local tiene el mismo relativo y queda fuera: gana el worktree');
  assert.notEqual(onBox.candidates[0].etag, onBox.candidates[1].etag);
  assert.match(onBox.candidates[0].etag, /^"sha1:[0-9a-f]{40}"$/);

  const onLocal = await files.resolveRef({ task: task({ worktreePath: L.wt }), ref: 'notes/both.md' });
  assert.deepEqual(onLocal.candidates.map((x) => x.machine), ['local', 'box']);
});

test('nombre suelto: en una subcarpeta versionada y en el tmp/ ignorado; comodines y magia de git fuera', async () => {
  const deep = await files.resolveRef({ ref: 'guia-unica.md' });
  assert.deepEqual(deep.candidates.map((x) => [x.machine, x.base, x.rel]), [['local', 'search', 'docs/deep/guia-unica.md']]);
  assert.equal(deep.candidates[0].active, true, 'sin tarea, la activa es local');
  assert.ok(deep.tried.some((t) => t.machine === 'box'), 'el box también se buscó (su checkout no es git)');

  const ignored = await files.resolveRef({ ref: '`nota-ignorada.md`' });
  assert.deepEqual(ignored.candidates.map((x) => [x.machine, x.rel]), [['local', 'tmp/user/docs/nota-ignorada.md']]);

  for (const ref of ['*.md', 'nota[1].md', ':(exclude)x.md', ':x.md']) {
    await assert.rejects(() => files.resolveRef({ ref }), status(400), ref);
  }
});

test('una búsqueda que se corta por tiempo va a tried, no a unreachable', async () => {
  const local = machines().local;
  const realExec = local.exec.bind(local);
  const exec = async (file, args, opts) => (file === 'git' && args.includes('-co')
    ? { ok: false, code: -2, stdout: 'docs/a-medias', stderr: '[timeout]' }
    : realExec(file, args, opts));
  await withStub(local, 'exec', exec, async () => {
    const r = await files.resolveRef({ ref: 'nota-ignorada.md' });
    assert.deepEqual(r.unreachable, []);
    assert.ok(r.tried.some((t) => t.machine === 'local' && t.cut === true && /búsqueda cortada/.test(t.where)));
    assert.deepEqual(r.candidates.map((x) => x.rel), ['tmp/user/docs/nota-ignorada.md'], 'lo que sí llegó se ofrece');
  });
});

test('un resolve que agota su tiempo deja al box que sí responde fuera de unreachable', async () => {
  const box = machines().box;
  // Never answers: the cut comes from the budget alone, and the budget can be wide
  // enough for the real requests of a loaded machine (a sleep shorter than the
  // budget would let the stub win the race).
  const slowRead = () => new Promise(() => {});
  await withStub(files.filesHooks, 'requestMs', 1500, () => withStub(box.fs, 'readBinary', slowRead, async () => {
    const r = await files.resolveRef({ task: task({ worktreePath: L.wt }), ref: 'notes/both.md' });
    assert.deepEqual(r.unreachable, [], 'contestó a la sonda: lento no es caído');
    assert.deepEqual(r.candidates.map((x) => x.machine), ['local']);
    assert.ok(r.tried.some((t) => t.machine === 'box' && t.cut === true && t.status === null));
  }));
});

test('~/tmp del home se abre: es donde las sesiones dejan informes y textos de PR', async () => {
  const r = await files.resolveRef({ ref: '~/tmp/bench-opt/prs/informe.md' });
  assert.deepEqual(r.candidates.map((x) => [x.machine, x.base, x.rel]), [['local', 'home', 'tmp/bench-opt/prs/informe.md']]);
  const opened = await files.readAllowed({ machine: 'local', path: path.join(L.home, 'tmp', 'bench-opt', 'prs', 'informe.md') });
  assert.ok(opened);
});

test('~/ se prueba en todas las máquinas con su home', async () => {
  const r = await files.resolveRef({ ref: '~/.claude/plans/plan-x.md' });
  assert.deepEqual(r.candidates.map((x) => [x.machine, x.base, x.rel]), [['local', 'home', '.claude/plans/plan-x.md']]);
  assert.ok(r.tried.some((t) => t.machine === 'box' && t.status === 404));
});

test('ruta absoluta: solo en las máquinas cuya plataforma encaja con su forma', async () => {
  const hostFile = path.join(L.repo, 'docs', 'guide.md');
  const winRef = HOST_WIN ? hostFile : 'C:\\nada\\guide.md';
  const posixRef = HOST_WIN ? '/home/nadie/guide.md' : hostFile;

  const w = await files.resolveRef({ ref: winRef });
  const p = await files.resolveRef({ ref: posixRef });
  if (HOST_WIN) {
    assert.deepEqual(w.candidates.map((x) => [x.machine, x.base, x.rel]), [['local', 'absolute', hostFile.replace(/\\/g, '/')]]);
    assert.equal(w.tried.some((t) => t.machine === 'box'), false, 'una ruta C:\\ no se pregunta al box');
    assert.deepEqual(p.candidates, []);
    assert.deepEqual([...new Set(p.tried.map((t) => t.machine))], ['box'], 'una /home/… solo al box');
  } else {
    assert.deepEqual(w.candidates, []);
    assert.deepEqual(w.tried, [], 'no hay máquinas Windows');
    assert.deepEqual(p.candidates.map((x) => [x.machine, x.base]), [['local', 'absolute']]);
    assert.ok(p.tried.some((t) => t.machine === 'box' && t.status === 403), 'el box también, y fuera de sus roots');
  }
});

test('ruta absoluta de la forma del host dentro de los roots del box: se abre desde el box', async () => {
  const box = machines().box;
  const saved = { platform: box.platform, path: box.path };
  // See the header: on a Windows host the in-process runner is a Windows disk.
  if (HOST_WIN) Object.assign(box, { platform: 'win32', path: path.win32 });
  try {
    const r = await files.resolveRef({ task: task({ worktreePath: L.wt }), ref: path.join(B.repo, 'box-doc.md') });
    assert.deepEqual(r.candidates.map((x) => [x.machine, x.base, x.active]), [['box', 'absolute', false]]);
    assert.ok(r.tried.some((t) => t.machine === 'local' && t.status === 403), 'en local está fuera de sus roots');
  } finally {
    Object.assign(box, saved);
  }
});

test('roots: fuera → 403, un enlace dentro que sale → 403, carpeta → 404, relativa → 400', async () => {
  await assert.rejects(() => files.readAllowed({ machine: 'local', path: path.join(OUTSIDE, 'secret.md') }), status(403));
  await assert.rejects(() => files.readAllowed({ machine: 'local', path: path.join(L.repo, 'escape', 'secret.md') }), status(403));
  await assert.rejects(() => files.readAllowed({ machine: 'box', path: path.join(L.repo, 'escape', 'secret.md') }), status(403));
  await assert.rejects(() => files.readAllowed({ machine: 'local', path: path.join(L.repo, 'no-existe.md') }), status(404));
  await assert.rejects(() => files.readAllowed({ machine: 'local', path: path.join(L.repo, 'carpeta.md') }), status(404));
  await assert.rejects(() => files.readAllowed({ machine: 'local', path: path.join(L.repo, '.gitignore') }), status(400));
  await assert.rejects(() => files.readAllowed({ machine: 'marte', path: path.join(L.repo, 'docs', 'guide.md') }), status(400));
  await assert.rejects(() => files.readAllowed({ machine: 'local', path: 'docs/guide.md' }), status(400));
  await assert.rejects(() => files.readAllowed({ machine: 'box', path: 'notes/only-box.md' }), status(400));

  const escaped = await files.resolveRef({ ref: 'escape/secret.md' });
  assert.deepEqual(escaped.candidates, [], 'la resolución tampoco lo ofrece');
  assert.ok(escaped.tried.some((t) => t.machine === 'local' && t.status === 403));
});

test('nombres denegados dentro de un root: .env*, credentials, .credentials, .mcp.json, secrets.*, .git/', async () => {
  for (const name of ['.env.json', 'credentials.json', '.credentials.json', '.mcp.json', 'secrets.yaml', '.git/notas.md']) {
    await assert.rejects(() => files.readAllowed({ machine: 'local', path: path.join(L.repo, ...name.split('/')) }), status(403), name);
  }
});

test('nombres denegados sin extensión que el visor abra siguen siendo 403, no 400; una extensión desconocida sí es 400', async () => {
  for (const name of ['.env', '.env.local', 'id_rsa', 'credentials']) {
    const inWorktree = write(L.wt, name, 'SECRETO=1\n');
    await assert.rejects(() => files.readAllowed({ machine: 'local', path: inWorktree }), status(403), name);
    await assert.rejects(() => files.readAllowed({ machine: 'box', path: path.join(B.wt, name) }), status(403), `${name} en el box`);
  }
  const exe = write(L.wt, 'x.exe', 'MZ');
  await assert.rejects(() => files.readAllowed({ machine: 'local', path: exe }), status(400));
});

test('un enlace con nombre permitido que apunta a .env → 403', async () => {
  const link = path.join(L.repo, 'inocente.md');
  const target = path.join(L.repo, '.env.json');
  let real = true;
  try {
    symlinkSync(target, link, 'file');
  } catch {
    // File symlinks on Windows need Developer Mode or an elevated shell; then
    // the link is simulated where it matters, in what realpath answers.
    real = false;
  }
  const local = machines().local;
  const origRealpath = local.fs.realpath.bind(local.fs);
  const realpath = real ? origRealpath : async (p) => (p === link ? origRealpath(target) : origRealpath(p));
  await withStub(local.fs, 'realpath', realpath, async () => {
    await assert.rejects(() => files.readAllowed({ machine: 'local', path: link }), status(403));
  });
});

test('rutas Windows peligrosas (UNC, \\\\?\\, flujos NTFS) → 403 sin tocar el disco', async () => {
  const local = machines().local;
  const saved = { platform: local.platform, path: local.path };
  // Off Windows, the check is exercised by making `local` look like Windows:
  // it must refuse before any fs call, so the disk underneath never matters.
  if (!HOST_WIN) Object.assign(local, { platform: 'win32', path: path.win32 });
  const calls = [];
  const spy = async (p) => { calls.push(p); throw Object.assign(new Error('no debería llamarse'), { code: 'EPERM' }); };
  try {
    await withStub(local.fs, 'realpath', spy, async () => {
      for (const p of ['\\\\atacante\\share\\x.md', '//atacante/share/x.md', '\\\\?\\C:\\x\\y.md', '\\\\.\\pipe\\x.md', `${L.repo}\\docs\\guide.md:oculto.md`]) {
        await assert.rejects(() => files.readAllowed({ machine: 'local', path: p }), status(403), p);
      }
      const r = await files.resolveRef({ ref: '\\\\atacante\\share\\x.md' });
      assert.deepEqual(r.candidates, []);
    });
    assert.deepEqual(calls, [], 'ni realpath llegó a llamarse');
  } finally {
    Object.assign(local, saved);
  }
});

test('scratchpad de un runner: solo si el archivo es del usuario del runner', async () => {
  const box = machines().box;
  const file = path.join(B.tmp, 'borrador.md');
  const origRealpath = box.fs.realpath.bind(box.fs);
  // The in-process runner cannot own files as another user; the uid it reports is the seam.
  const ownedBy = (uid) => async (p, opts) => ({ ...(await origRealpath(p, opts)), uid });
  await withStub(box.fs, 'realpath', ownedBy(4242), async () => {
    await withStub(files.filesHooks, 'uidOf', async () => 4242, async () => {
      assert.equal((await files.readAllowed({ machine: 'box', path: file })).bytes.toString('utf8'), '# del scratchpad del box\n');
    });
    await withStub(files.filesHooks, 'uidOf', async () => 1000, async () => {
      await assert.rejects(() => files.readAllowed({ machine: 'box', path: file }), status(403));
    });
    await withStub(files.filesHooks, 'uidOf', async () => null, async () => {
      await assert.rejects(() => files.readAllowed({ machine: 'box', path: file }), status(403), 'sin saber quién es el runner, no');
    });
  });
  await withStub(files.filesHooks, 'uidOf', async () => 4242, async () => {
    await assert.rejects(() => files.readAllowed({ machine: 'box', path: path.join(B.repo, 'box-doc.md').replace('box-doc', 'no-existe') }), status(404));
    assert.equal((await files.readAllowed({ machine: 'box', path: path.join(B.repo, 'box-doc.md') })).size, 6, 'fuera del scratch el dueño no importa');
  });
});

test('más de 2 MB de markdown → 413, sin leer el archivo', async () => {
  const local = machines().local;
  let reads = 0;
  const readBinary = async () => { reads += 1; return Buffer.alloc(0); };
  await withStub(local.fs, 'readBinary', readBinary, async () => {
    await assert.rejects(() => files.readAllowed({ machine: 'local', path: path.join(L.repo, 'grande.md') }), status(413));
  });
  assert.equal(reads, 0, 'el tamaño se decide con el stat');
});

test('recarga en vivo: con el ETag de la última lectura y el archivo igual, no se descarga del runner', async () => {
  const box = machines().box;
  const file = write(B.repo, 'cache.md', '# uno\n');
  const first = await files.readAllowed({ machine: 'box', path: file });
  let reads = 0;
  const realRead = box.fs.readBinary.bind(box.fs);
  await withStub(box.fs, 'readBinary', async (p, opts) => { reads += 1; return realRead(p, opts); }, async () => {
    const same = await files.readAllowed({ machine: 'box', path: file, ifNoneMatch: first.etag });
    assert.equal(same.notModified, true);
    assert.equal(same.bytes, null);
    assert.equal(same.etag, first.etag);
    assert.equal(reads, 0, 'ni un byte por el cable');

    const other = await files.readAllowed({ machine: 'box', path: file, ifNoneMatch: '"sha1:otro"' });
    assert.equal(other.notModified, undefined);
    assert.equal(reads, 1, 'con otro ETag sí se lee');

    writeFileSync(file, '# dos, y más largo\n');
    const changed = await files.readAllowed({ machine: 'box', path: file, ifNoneMatch: first.etag });
    assert.equal(changed.notModified, undefined);
    assert.notEqual(changed.etag, first.etag);
    assert.equal(changed.bytes.toString('utf8'), '# dos, y más largo\n');
    assert.equal(reads, 2);
  });
});

test('runner viejo sin /fs/realpath: realpath -e y stat por exec, con -- delante de la ruta', async () => {
  const box = machines().box;
  const realExec = box.exec.bind(box);
  const calls = [];
  const noRoute = async () => { throw Object.assign(new Error('sin ruta'), { code: 'NO_ROUTE' }); };
  const exec = async (file, args, opts) => {
    if (file !== 'realpath' && file !== 'stat') return realExec(file, args, opts);
    calls.push([file, ...args]);
    const target = args.at(-1);
    try {
      const real = realpathSync(target);
      const st = statSync(real);
      const stdout = file === 'realpath' ? `${real}\n` : `${st.size} ${st.isFile() ? 'regular file' : 'directory'} 1000 ${st.nlink}\n`;
      return { ok: true, code: 0, stdout, stderr: '' };
    } catch {
      return { ok: false, code: 1, stdout: '', stderr: 'No such file or directory' };
    }
  };
  await withStub(box.fs, 'realpath', noRoute, () => withStub(box, 'exec', exec, async () => {
    const target = path.join(B.repo, 'box-doc.md');
    const file = await files.readAllowed({ machine: 'box', path: target });
    assert.equal(file.bytes.toString('utf8'), '# box\n');
    assert.ok(calls.some((c) => c.join(' ') === `realpath -e -- ${target}`));
    assert.ok(calls.some((c) => c[0] === 'stat' && c[1] === '-Lc' && c[2] === '%s %F %u %h' && c[3] === '--'));
    const again = await files.readAllowed({ machine: 'box', path: target, ifNoneMatch: file.etag });
    assert.equal(again.notModified, undefined, 'sin mtime no hay atajo: se vuelve a leer');
    await assert.rejects(() => files.readAllowed({ machine: 'box', path: path.join(B.repo, 'no-existe.md') }), status(404));
  }));
});

test('una máquina que no responde se lista en unreachable sin frenar el resultado local', async () => {
  const closed = net.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const closedPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  // And one that accepts the connection and never answers, which is what a
  // box that dropped off the tailnet looks like.
  const sockets = new Set();
  const silent = net.createServer((s) => { sockets.add(s); s.on('error', () => {}); });
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));

  const savedProbe = files.filesHooks.probeMs;
  const saved = config.machines;
  config.machines = {
    ...saved,
    caida: { kind: 'runner', url: `http://127.0.0.1:${closedPort}`, token: TOKEN, repoPath: '/srv/r', worktreeRoot: '/srv/w' },
    muda: { kind: 'runner', url: `http://127.0.0.1:${silent.address().port}`, token: TOKEN, repoPath: '/srv/r', worktreeRoot: '/srv/w' },
  };
  // Outcomes, not stopwatch readings: a loaded machine stretches every timer.
  // `probeMs` caps local operations too, so it must be wide enough that `local`
  // never times out under load; the only time bound left has ×4 headroom and
  // exists just to prove the silent box does not hold the answer forever.
  const PROBE_MS = 2500;
  files.filesHooks.probeMs = PROBE_MS;
  try {
    const mudaFs = machines().muda.fs;
    const realExists = mudaFs.exists.bind(mudaFs);
    let probeSignal = null;
    mudaFs.exists = (p, opts) => { probeSignal = opts?.signal ?? null; return realExists(p, opts); };
    const started = Date.now();
    const r = await files.resolveRef({ ref: 'docs/guide.md' });
    const took = Date.now() - started;
    assert.deepEqual(r.unreachable, ['caida', 'muda']);
    assert.deepEqual(r.candidates.map((x) => x.machine), ['local'], 'el resultado local llega igual');
    assert.ok(took < PROBE_MS * 4, `tardó ${took} ms`);
    assert.ok(probeSignal, 'la sonda lleva su señal');
    // The signal's own timer and the probe's timeout fire at the same mark, in
    // either order: wait for the abort itself rather than guessing a delay.
    const aborted = await new Promise((resolve) => {
      if (probeSignal.aborted) return resolve(true);
      const giveUp = setTimeout(() => resolve(false), PROBE_MS * 4);
      probeSignal.addEventListener('abort', () => { clearTimeout(giveUp); resolve(true); }, { once: true });
    });
    assert.equal(aborted, true, 'y se abortó: no queda un fetch colgado por clic');
  } finally {
    files.filesHooks.probeMs = savedProbe;
    config.machines = saved;
    for (const s of sockets) s.destroy();
    await new Promise((r) => silent.close(r));
  }
});

// A project chat has no issue: its owner is `{ kind: 'project', project, machine }`
// and its files live in `<worktreeRoot>/_proyecto` on the machine that holds it.
const holder = (machine) => ({ kind: 'project', project: 'hfs', issue: null, machine });
const HOLDER = { local: path.join(L.wtRoot, '_proyecto'), box: path.join(B.wtRoot, '_proyecto') };

/** Runs `fn` over a clean `_proyecto` on both machines and leaves none behind. */
async function withHolderDirs(fn) {
  const clean = () => { for (const d of Object.values(HOLDER)) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); };
  clean();
  try {
    return await fn();
  } finally {
    clean();
  }
}

test('un chat de proyecto abre un .md, un .html y una imagen relativos de su _proyecto local', async () => {
  await withHolderDirs(async () => {
    write(HOLDER.local, 'out2/cmp.png', PNG);
    write(HOLDER.local, 'out2/informe.md', '# informe\n');
    write(HOLDER.local, 'out2/pagina.html', '<p>hola</p>\n');
    for (const [ref, kind] of [['out2\\cmp.png', 'image'], ['`out2/informe.md:3`', 'md'], ['out2/pagina.html', 'text']]) {
      const r = await files.resolveRef({ task: holder('local'), ref });
      assert.deepEqual(r.candidates.map((x) => [x.machine, x.base, x.active, x.kind]), [['local', 'worktree', true, kind]], ref);
      assert.ok(r.candidates[0].path.startsWith(HOLDER.local), 'se leyó del holder');
    }
    // The holder's machine is the only one whose _proyecto is searched.
    const r = await files.resolveRef({ task: holder('local'), ref: 'out2/informe.md' });
    assert.ok(!r.tried.some((t) => t.where.startsWith(HOLDER.box)), 'no mira el _proyecto del box');
  });
});

test('un chat de proyecto en el box abre desde el _proyecto del box, con la activa primero', async () => {
  await withHolderDirs(async () => {
    write(HOLDER.box, 'out2/solo-box.md', '# del holder del box\n');
    const r = await files.resolveRef({ task: holder('box'), ref: 'out2/solo-box.md' });
    assert.deepEqual(r.candidates.map((x) => [x.machine, x.base, x.active]), [['box', 'worktree', true]]);
    assert.ok(r.tried.some((t) => t.machine === 'local' && t.where === path.join(L.repo, 'out2', 'solo-box.md') && t.status === 404));
    const opened = await files.readAllowed({ machine: 'box', path: r.candidates[0].path });
    assert.equal(opened.bytes.toString('utf8'), '# del holder del box\n');
  });
});

test('un chat de proyecto sin máquina conocida mira el _proyecto de todas', async () => {
  await withHolderDirs(async () => {
    write(HOLDER.local, 'out2/en-local.md', 'l\n');
    write(HOLDER.box, 'out2/en-box.md', 'b\n');
    const a = await files.resolveRef({ task: holder(null), ref: 'out2/en-local.md' });
    assert.deepEqual(a.candidates.map((x) => [x.machine, x.base]), [['local', 'worktree']]);
    const b = await files.resolveRef({ task: holder(null), ref: 'out2/en-box.md' });
    assert.deepEqual(b.candidates.map((x) => [x.machine, x.base, x.active]), [['box', 'worktree', false]]);
  });
});

test('lo que no existe sigue sin existir, y tried nombra el _proyecto que se miró y el checkout', async () => {
  await withHolderDirs(async () => {
    const r = await files.resolveRef({ task: holder('local'), ref: 'out2/nada.md' });
    assert.deepEqual(r.candidates, []);
    assert.deepEqual(r.unreachable, []);
    const wheres = r.tried.filter((t) => t.machine === 'local' && t.status === 404).map((t) => t.where);
    assert.ok(wheres.includes(path.join(HOLDER.local, 'out2', 'nada.md')), `_proyecto en tried: ${wheres}`);
    assert.ok(wheres.includes(path.join(L.repo, 'out2', 'nada.md')), `checkout en tried: ${wheres}`);
  });
});

test('el mismo relativo en el _proyecto y en el checkout es el del _proyecto', async () => {
  await withHolderDirs(async () => {
    write(HOLDER.local, 'notes/both.md', 'versión del holder\n');
    const r = await files.resolveRef({ task: holder('local'), ref: 'notes/both.md' });
    assert.deepEqual(r.candidates.map((x) => [x.machine, x.base]), [['local', 'worktree']]);
    assert.ok(r.candidates[0].path.startsWith(HOLDER.local));
  });
});

test('un nombre suelto se busca en el _proyecto (git) y, si aún no existe, queda en tried sin tumbar la máquina', async () => {
  await withHolderDirs(async () => {
    const absent = await files.resolveRef({ task: holder('local'), ref: 'guia-unica.md' });
    assert.deepEqual(absent.unreachable, [], 'un _proyecto sin crear no deja la máquina inalcanzable');
    assert.deepEqual(absent.candidates.map((x) => x.base), ['search'], 'el acierto del checkout se conserva');
    assert.ok(absent.tried.some((t) => t.machine === 'local' && t.where === HOLDER.local && t.status === 404));

    mkdirSync(HOLDER.local, { recursive: true });
    git(['init', '-b', 'main', '.'], HOLDER.local);
    write(HOLDER.local, 'docs/solo-proyecto.md', '# solo aquí\n');
    const found = await files.resolveRef({ task: holder('local'), ref: 'solo-proyecto.md' });
    assert.deepEqual(found.candidates.map((x) => [x.machine, x.base, x.rel]), [['local', 'search', 'docs/solo-proyecto.md']]);
    assert.ok(found.candidates[0].path.startsWith(HOLDER.local));
  });
});

test('un nombre suelto con el _proyecto lento queda cortado en tried, no inalcanzable', async () => {
  const box = machines().box;
  const realExists = box.fs.exists.bind(box.fs);
  // Never answers for the `_proyecto` folder; `probeMs` also bounds the real probes
  // (reachability, git), so it stays wide enough for a loaded machine.
  const slowExists = (p, ...rest) => (String(p).endsWith('_proyecto') ? new Promise(() => {}) : realExists(p, ...rest));
  await withHolderDirs(async () => {
    await withStub(files.filesHooks, 'probeMs', 1500, () => withStub(box.fs, 'exists', slowExists, async () => {
      const r = await files.resolveRef({ task: holder('box'), ref: 'guia-unica.md' });
      assert.ok(!r.unreachable.includes('box'), 'contestó a la sonda: lento no es caído');
      assert.ok(r.tried.some((t) => t.machine === 'box' && t.cut && t.where.includes('_proyecto')));
    }));
  });
});

test('un archivo del _proyecto que sale de las raíces sigue siendo 403', async () => {
  await withHolderDirs(async () => {
    mkdirSync(HOLDER.local, { recursive: true });
    symlinkSync(OUTSIDE, path.join(HOLDER.local, 'escape'), 'junction');
    const r = await files.resolveRef({ task: holder('local'), ref: 'escape/secret.md' });
    assert.deepEqual(r.candidates, []);
    assert.ok(r.tried.some((t) => t.where.startsWith(HOLDER.local) && t.status === 403));
  });
});

test('router por HTTP: project + machine sin issue es un chat de proyecto', async () => {
  const express = (await import('express')).default;
  const app = express();
  app.use(files.filesRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const resolve = async (params) => (await fetch(`${base}/api/files/resolve?${new URLSearchParams(params)}`)).json();
  try {
    await withHolderDirs(async () => {
      write(HOLDER.box, 'out2/http.md', '# http\n');
      const r = await resolve({ project: 'hfs', machine: 'box', ref: 'out2/http.md' });
      assert.deepEqual(r.candidates.map((x) => [x.machine, x.base, x.active]), [['box', 'worktree', true]]);

      const unknownMachine = await resolve({ project: 'hfs', machine: 'nope', ref: 'out2/http.md' });
      assert.deepEqual(unknownMachine.candidates.map((x) => x.machine), ['box'], 'una máquina desconocida no rompe: se mira en todas');

      const unknownProject = await resolve({ project: 'no-existe', machine: 'box', ref: 'out2/http.md' });
      assert.deepEqual(unknownProject.candidates, [], 'un proyecto desconocido no es dueño de nada');

      const withIssue = await resolve({ project: 'hfs', machine: 'box', issue: '999999', ref: 'out2/http.md' });
      assert.deepEqual(withIssue.candidates, [], 'con issue, machine se ignora');
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('router por HTTP: content con ETag y 304, imagen con sus bytes, resolve con issue', async () => {
  const express = (await import('express')).default;
  const app = express();
  app.use(files.filesRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const doc = path.join(L.repo, 'docs', 'guide.md');
    const url = `${base}/api/files/content?${new URLSearchParams({ machine: 'local', path: doc })}`;
    const first = await fetch(url);
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag');
    assert.match(etag, /^"sha1:[0-9a-f]{40}"$/);
    assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
    const csp = first.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /(^|; )sandbox(;|$)/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.match(first.headers.get('cache-control'), /private/);
    const body = await first.json();
    assert.deepEqual(body, {
      kind: 'md', lang: 'markdown', text: '# Guide\n\ntexto\n', etag, size: 15, machine: 'local', path: realpathSync(doc),
    });
    const again = await fetch(url, { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get('etag'), etag);

    const img = await fetch(`${base}/api/files/content?${new URLSearchParams({ machine: 'local', path: path.join(L.repo, 'img', 'pixel.png') })}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.deepEqual([...Buffer.from(await img.arrayBuffer())], [...PNG]);

    const denied = await fetch(`${base}/api/files/content?${new URLSearchParams({ machine: 'local', path: path.join(OUTSIDE, 'secret.md') })}`);
    assert.equal(denied.status, 403);
    assert.ok((await denied.json()).error);
    const relative = await fetch(`${base}/api/files/content?${new URLSearchParams({ machine: 'local', path: 'docs/guide.md' })}`);
    assert.equal(relative.status, 400);
    const missing = await fetch(`${base}/api/files/content?${new URLSearchParams({ machine: 'box', path: path.join(B.repo, 'nada.md') })}`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).tried[0].machine, 'box');

    const t = store.addTask({ number: 5101, title: 'visor', labels: [], url: 'https://x/5101', closed: false }, 'hfs');
    t.machine = 'box';
    t.branch = BRANCH;
    t.worktreePath = B.wt;
    const resolved = await (await fetch(`${base}/api/files/resolve?${new URLSearchParams({ issue: '5101', ref: '`notes/both.md:9`' })}`)).json();
    assert.equal(resolved.line, 9);
    assert.deepEqual(resolved.candidates.map((x) => [x.machine, x.active]), [['box', true], ['local', false]]);

    const unknown = await fetch(`${base}/api/files/resolve?${new URLSearchParams({ issue: '999999', ref: 'docs/guide.md' })}`);
    assert.equal(unknown.status, 200, 'un issue desconocido es una mención sin tarea');
    assert.deepEqual((await unknown.json()).candidates.map((x) => [x.machine, x.active]), [['local', true]]);

    const bad = await fetch(`${base}/api/files/resolve?${new URLSearchParams({ ref: 'https://example.com/a.md' })}`);
    assert.equal(bad.status, 400);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('el árbol del tablero: config, datos, .claude, logs y *.local.* responden 404 aunque la raíz esté permitida', async () => {
  const express = (await import('express')).default;
  const app = express();
  app.use(files.filesRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (machine, p) => fetch(`${base}/api/files/content?${new URLSearchParams({ machine, path: p })}`);
  try {
    const excluded = [
      ...['config.json', 'config.local.json', 'server/data/projects.json', 'server/data/nunca-existio.json', '.claude/settings.json',
        '.claude/skills/x/SKILL.md', '.claude/sin-extension', 'hfs-monitor.log', 'CLAUDE.local.md', 'tools/decisions/sessions.local.json',
      ].map((name) => path.join(L.repo, ...name.split('/'))),
      ...['config.json', 'server/data/a.json', '.claude/settings.json', 'run.log'].map((name) => path.join(BOARD_WT, ...name.split('/'))),
      `${L.repo}${path.sep}docs${path.sep}..${path.sep}config.json`,
    ];
    if (HOST_WIN) excluded.push(path.join(L.repo, 'CONFIG.JSON'), path.join(L.repo, 'Server', 'DATA', 'projects.json'));
    for (const p of excluded) {
      const res = await get('local', p);
      assert.equal(res.status, 404, p);
      const body = await res.json();
      assert.match(body.error, /^No existe en local: /, `${p}: the answer must not tell a secret from a missing file`);
      assert.deepEqual(body.tried.map((t) => [t.machine, t.status]), [['local', 404]], p);
    }

    for (const p of [
      path.join(L.repo, 'src', 'app.js'), path.join(L.repo, 'tools', 'decisions', 'config.json'), path.join(BOARD_WT, 'src', 'app.js'),
    ]) assert.equal((await get('local', p)).status, 200, p);
    assert.equal((await get('box', path.join(B.wt, 'run.log'))).status, 200, 'a runner without a board checkout serves its logs');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('el árbol del tablero: un enlace con nombre inocente que apunta a config.json → 404 sin nombrar el destino', async () => {
  const link = path.join(L.repo, 'enlace-config.md');
  const target = path.join(L.repo, 'config.json');
  let real = true;
  try {
    symlinkSync(target, link, 'file');
  } catch {
    real = false; // see the `.env.json` link test: simulated in what realpath answers
  }
  const local = machines().local;
  const origRealpath = local.fs.realpath.bind(local.fs);
  const realpath = real ? origRealpath : async (p) => (p === link ? origRealpath(target) : origRealpath(p));
  await withStub(local.fs, 'realpath', realpath, async () => {
    await assert.rejects(() => files.readAllowed({ machine: 'local', path: link }), (e) => {
      assert.equal(e.status, 404);
      assert.ok(!/config\.json/.test(e.message) && !/config\.json/.test(JSON.stringify(e.tried)), e.message);
      return true;
    });
  });
});

test('el árbol del tablero: una mención a config.json no ofrece el de la raíz, sí otros config.json del árbol', async () => {
  const r = await files.resolveRef({ task: task({ worktreePath: BOARD_WT }), ref: 'config.json' });
  assert.deepEqual(r.candidates.map((c) => c.rel), ['tools/decisions/config.json']);
  assert.ok(!r.tried.some((t) => /config\.json/.test(t.where)), 'the list of tried places never names a secret');
});

test('el árbol del tablero: una mención a un secreto que es lo único que hay no lo encuentra ni lo nombra', async () => {
  const r = await files.resolveRef({ task: task(), ref: 'CLAUDE.local.md' });
  assert.deepEqual(r.candidates, []);
  assert.ok(r.tried.some((t) => t.machine === 'local' && t.where === L.repo && t.status === 404), 'it reads as a search that found nothing');
  assert.ok(!r.tried.some((t) => /CLAUDE\.local\.md/.test(t.where)));
});

test('el árbol del tablero: el config.json real se excluye por ruta absoluta', async () => {
  const cfg = await import('../src/config.js');
  const board = realpathSync(cfg.ROOT);
  await withStub(files.filesHooks, 'boardRoot', (m) => (m.kind === 'local' ? board : null), async () => {
    await assert.rejects(() => files.readAllowed({ machine: 'local', path: cfg.CONFIG_FILE }), status(404));
    const data = await files.readAllowed({ machine: 'local', path: path.join(board, 'package.json') });
    assert.equal(data.kind, 'text', 'the rest of the tree opens');
  });
});

// ---- the board is recognised by what a directory is, not by where the process runs ----

const BOARD_MARKERS = ['server/src/config.js', 'server/src/files.js'];
const markBoard = (dir) => { for (const f of BOARD_MARKERS) write(dir, f, '// stand-in for a board checkout\n'); };
const unmarkBoard = (dir) => { for (const f of BOARD_MARKERS) rmSync(path.join(dir, ...f.split('/')), { force: true }); };
const FAKE = '{"token":"falso-no-es-un-token"}';

async function serve() {
  const express = (await import('express')).default;
  const app = express();
  app.use(files.filesRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: (machine, p) => fetch(`${base}/api/files/content?${new URLSearchParams({ machine, path: p })}`),
    resolve: (ref) => fetch(`${base}/api/files/resolve?${new URLSearchParams({ ref })}`),
    close: () => new Promise((r) => server.close(r)),
  };
}

test('el árbol del tablero: con el tablero corriendo desde otro directorio, el checkout registrado y sus worktrees siguen protegidos', async () => {
  const running = path.join(ROOT, 'board-running-elsewhere');
  mkdirSync(running, { recursive: true });
  const via = path.join(L.tmp, 'enlace-al-checkout');
  try {
    markBoard(L.repo);
    files.resetBoardCache();
    symlinkSync(L.repo, via, 'junction');
    await withStub(files.filesHooks, 'boardRoot', (m) => (m.kind === 'local' ? running : null), async () => {
      for (const p of [
        path.join(L.repo, 'config.json'), path.join(L.repo, 'CLAUDE.local.md'), path.join(L.repo, 'hfs-monitor.log'),
        path.join(L.repo, 'server', 'data', 'projects.json'), path.join(L.repo, '.claude', 'settings.json'),
        path.join(BOARD_WT, 'config.json'), path.join(BOARD_WT, 'run.log'), path.join(via, 'config.json'),
      ]) await assert.rejects(() => files.readAllowed({ machine: 'local', path: p }), status(404));
      for (const p of [path.join(L.repo, 'src', 'app.js'), path.join(BOARD_WT, 'src', 'app.js')]) {
        assert.equal((await files.readAllowed({ machine: 'local', path: p })).kind, 'text', p);
      }
    });
  } finally {
    rmSync(via, { recursive: true, force: true });
    unmarkBoard(L.repo);
    files.resetBoardCache();
  }
});

test('el árbol del tablero: un runner cuyo checkout es del tablero lo protege, y su resolve no lo ofrece', async () => {
  const secrets = ['config.json', 'CLAUDE.local.md', 'servidor.log'].map((n) => path.join(B.repo, n));
  const sibling = path.join(B.wt, 'config.json');
  try {
    markBoard(B.repo);
    for (const p of [...secrets, sibling]) write(path.dirname(p), path.basename(p), FAKE);
    files.resetBoardCache();
    for (const p of [...secrets, sibling, path.join(B.wt, 'run.log')]) {
      await assert.rejects(() => files.readAllowed({ machine: 'box', path: p }), status(404));
    }
    assert.equal((await files.readAllowed({ machine: 'box', path: path.join(B.repo, 'box-doc.md') })).kind, 'md');

    const r = await files.resolveRef({ task: task({ machine: 'box' }), ref: './config.json' });
    assert.deepEqual(r.candidates.filter((c) => c.machine === 'box'), [], 'the runner does not offer the secret');
    assert.ok(r.tried.some((t) => t.machine === 'box' && t.status === 404));
    const ok = await files.resolveRef({ task: task({ machine: 'box' }), ref: './notes/only-box.md' });
    assert.deepEqual(ok.candidates.filter((c) => c.machine === 'box').map((c) => c.rel), ['notes/only-box.md']);
  } finally {
    unmarkBoard(B.repo);
    for (const p of [...secrets, sibling]) rmSync(p, { force: true });
    files.resetBoardCache();
  }
});

test('el árbol del tablero: un enlace duro dentro de una raíz servida responde 404, sea cual sea su nombre', async () => {
  const dir = path.join(L.wtRoot, 'enlaces-duros');
  try {
    const solo = write(dir, 'solo.md', '# un nombre\n');
    const original = write(dir, 'original.md', '# dos nombres\n');
    linkSync(original, path.join(dir, 'copia.md'));
    linkSync(path.join(L.repo, 'config.json'), path.join(dir, 'inocente.md'));
    for (const name of ['original.md', 'copia.md', 'inocente.md']) {
      await assert.rejects(() => files.readAllowed({ machine: 'local', path: path.join(dir, name) }), status(404), name);
    }
    assert.equal((await files.readAllowed({ machine: 'local', path: solo })).kind, 'md');
  } finally {
    await removeTree(dir);
  }
});

test('el árbol del tablero: una búsqueda por nombre que da con un alias de un secreto no lo nombra en tried', async () => {
  const dir = path.join(L.repo, 'alias-busqueda');
  try {
    markBoard(L.repo);
    files.resetBoardCache();
    write(L.repo, 'config.json', FAKE);
    mkdirSync(dir, { recursive: true });
    linkSync(path.join(L.repo, 'config.json'), path.join(dir, 'alias-unico.md'));
    await withStub(files.filesHooks, 'boardRoot', (m) => (m.kind === 'local' ? L.repo : null), async () => {
      const r = await files.resolveRef({ task: task({ machine: 'local' }), ref: 'alias-unico.md' });
      assert.deepEqual(r.candidates, [], 'el alias no se ofrece');
      assert.equal(r.tried.some((t) => String(t.where).includes('alias-unico')), false, 'ni se nombra');
      assert.ok(r.tried.some((t) => t.machine === 'local' && t.where === L.repo && t.status === 404), 'sí la carpeta buscada');
    });
  } finally {
    await removeTree(dir);
    unmarkBoard(L.repo);
    files.resetBoardCache();
  }
});

test('el árbol del tablero: el valor real de filesHooks.boardRoot sirve el tablero con sus exclusiones', async () => {
  const cfg = await import('../src/config.js');
  const board = realpathSync(cfg.ROOT);
  await withStub(files.filesHooks, 'boardRoot', realBoardRoot, async () => {
    for (const p of [path.join(board, 'config.json'), path.join(board, '.claude', 'settings.local.json')]) {
      await assert.rejects(() => files.readAllowed({ machine: 'local', path: p }), status(404), p);
    }
    assert.equal((await files.readAllowed({ machine: 'local', path: path.join(board, 'package.json') })).kind, 'text');
  });
});

test('el árbol del tablero: la carpeta de datos se excluye por ruta absoluta aunque cuelgue de una raíz servida', async () => {
  const cfg = await import('../src/config.js');
  assert.equal(cfg.DATA_DIR, dataDir);
  const secret = write(dataDir, 'frasco-falso.json', FAKE);
  try {
    // The board "runs" from the temp folder that holds the data folder, so the
    // data folder is inside a served root but not under a checkout rule.
    await withStub(files.filesHooks, 'boardRoot', (m) => (m.kind === 'local' ? path.dirname(dataDir) : null), async () => {
      await assert.rejects(() => files.readAllowed({ machine: 'local', path: secret }), status(404));
      assert.equal((await files.readAllowed({ machine: 'local', path: path.join(OUTSIDE, 'secret.md') })).kind, 'md', 'what is next to it opens');
    });
  } finally {
    rmSync(secret, { force: true });
  }
});

test('el árbol del tablero: el checkout puede ser un enlace y entrarse por otro enlace', async () => {
  const real = path.join(ROOT, 'tablero-real');
  const asBoard = path.join(ROOT, 'tablero-enlace');
  const other = path.join(L.tmp, 'otro-enlace');
  write(real, 'config.json', FAKE);
  write(real, 'src/app.js', 'export const ok = 3;\n');
  try {
    symlinkSync(real, asBoard, 'junction');
    symlinkSync(real, other, 'junction');
    await withStub(files.filesHooks, 'boardRoot', (m) => (m.kind === 'local' ? asBoard : null), async () => {
      await assert.rejects(() => files.readAllowed({ machine: 'local', path: path.join(other, 'config.json') }), status(404));
      assert.equal((await files.readAllowed({ machine: 'local', path: path.join(other, 'src', 'app.js') })).kind, 'text');
    });
  } finally {
    rmSync(other, { recursive: true, force: true });
    rmSync(asBoard, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test('allowedRoots: el checkout del tablero escrito de otra forma no se suma como otra raíz', async () => {
  await withStub(files.filesHooks, 'boardRoot', (m) => (m.kind === 'local' ? `${L.repo}${path.sep}` : null), async () => {
    assert.deepEqual(await files.allowedRoots(machines().local), [L.wtRoot, L.repo, path.join(L.home, '.claude', 'plans'), path.join(L.home, 'tmp'), L.tmp]);
  });
});

test('el árbol del tablero: lo que cuelga directo de la carpeta de worktrees no es un checkout', async () => {
  const loose = ['suelto.log', 'notas.json'].map((n) => write(L.wtRoot, n, 'x\n'));
  try {
    for (const p of loose) assert.equal((await files.readAllowed({ machine: 'local', path: p })).kind, 'text', p);
  } finally {
    for (const p of loose) rmSync(p, { force: true });
  }
});

test('el árbol del tablero: config.local.json y *.local.* de un worktree, y un enlace a server/data, responden 404', async () => {
  const link = path.join(L.wtRoot, 'datos-enlace');
  try {
    symlinkSync(path.join(L.repo, 'server', 'data'), link, 'junction');
    // The files must really exist: a 404 for a file that is not there proves nothing.
    for (const p of [path.join(BOARD_WT, 'config.local.json'), path.join(BOARD_WT, 'tools', 'x.local.json'), path.join(BOARD_WT, 'CLAUDE.local.md')]) {
      assert.ok(existsSync(p), `fixture file missing: ${p}`);
      await assert.rejects(() => files.readAllowed({ machine: 'local', path: p }), status(404), p);
    }
    await assert.rejects(() => files.readAllowed({ machine: 'local', path: path.join(link, 'projects.json') }), status(404), 'link to server/data');
    // Positive control: an ordinary file of the same worktree is still served.
    assert.equal((await files.readAllowed({ machine: 'local', path: path.join(BOARD_WT, 'src', 'app.js') })).kind, 'text');
  } finally {
    rmSync(link, { recursive: true, force: true });
  }
});

test('el árbol del tablero: un secreto y un archivo que falta responden con la misma forma, por content y por resolve', async () => {
  const s = await serve();
  try {
    const shape = async (p) => {
      const res = await s.get('local', p);
      const body = await res.json();
      return { status: res.status, error: body.error.replace(p, '<ruta>'), tried: body.tried.map((t) => [t.machine, t.status]) };
    };
    assert.deepEqual(await shape(path.join(L.repo, 'config.json')), await shape(path.join(L.repo, 'no-existe.json')));
    assert.deepEqual(await shape(path.join(BOARD_WT, 'server', 'data', 'a.json')), await shape(path.join(BOARD_WT, 'server', 'data', 'no-existe.json')));

    const resolved = async (ref) => {
      const res = await s.resolve(ref);
      const body = await res.json();
      return { status: res.status, candidates: body.candidates, unreachable: body.unreachable, tried: body.tried.map((t) => [t.machine, t.status]) };
    };
    const secret = await resolved('./config.json');
    assert.equal(secret.status, 200);
    assert.deepEqual(secret.candidates, []);
    assert.deepEqual(secret, await resolved('./no-existe.json'));

    // Known and accepted difference: a name with no extension is refused by type
    // before anything else, so only an excluded one is a 404.
    assert.equal((await s.get('local', path.join(L.repo, '.claude', 'sin-extension'))).status, 404);
    assert.equal((await s.get('local', path.join(L.repo, 'sin-extension'))).status, 400);
  } finally {
    await s.close();
  }
});

// ---- copies of the board that are not a registered project's checkout ----

const COPY_SECRETS = ['config.json', 'config.local.json', 'server/data/x.json', '.claude/settings.json', 'run.log', 'CLAUDE.local.md'];
const buildCopy = (dir) => {
  markBoard(dir);
  for (const name of COPY_SECRETS) write(dir, name, FAKE);
  write(dir, 'src/app.js', 'export const ok = 4;\n');
};
const secretsOf = (dir) => COPY_SECRETS.map((n) => path.join(dir, ...n.split('/')));
async function assertCopyProtected(machine, dir) {
  for (const p of secretsOf(dir)) {
    assert.ok(existsSync(p), `fixture file missing: ${p}`);
    await assert.rejects(() => files.readAllowed({ machine, path: p }), status(404), p);
  }
  assert.equal((await files.readAllowed({ machine, path: path.join(dir, 'src', 'app.js') })).kind, 'text', 'an ordinary file of the copy opens');
}

test('copia del tablero en la raíz scratch: sus secretos responden 404 y lo ordinario se sirve', async () => {
  const dir = path.join(L.tmp, 'copia-a');
  try {
    buildCopy(dir);
    files.resetBoardCache();
    await assertCopyProtected('local', dir);
  } finally {
    await removeTree(dir);
    files.resetBoardCache();
  }
});

test('copia del tablero anidada en un worktree de proyecto: sus secretos responden 404', async () => {
  const dir = path.join(L.wt, 'vendor', 'board');
  try {
    buildCopy(dir);
    files.resetBoardCache();
    await assertCopyProtected('local', dir);
  } finally {
    await removeTree(path.join(L.wt, 'vendor'));
    files.resetBoardCache();
  }
});

test('copia parcial (un solo marcador o ninguno): se sirve, y el config.json de otro proyecto también', async () => {
  const one = path.join(L.tmp, 'parcial-uno');
  const none = path.join(L.tmp, 'parcial-ninguno');
  const other = path.join(L.tmp, 'otro-proyecto');
  try {
    write(one, BOARD_MARKERS[1], '// only one marker\n');
    write(one, 'config.json', FAKE);
    write(none, 'config.json', FAKE);
    write(other, 'config.json', FAKE);
    write(other, 'server/src/config.js', '// unrelated\n');
    files.resetBoardCache();
    for (const d of [one, none, other]) {
      assert.equal((await files.readAllowed({ machine: 'local', path: path.join(d, 'config.json') })).kind, 'text', d);
    }
  } finally {
    for (const d of [one, none, other]) await removeTree(d);
    files.resetBoardCache();
  }
});

test('la subida por los ancestros se detiene en la raíz servida: un tablero por encima de ella no cuenta', async () => {
  const above = realpathSync(tempDir('hfsmon-above-'));
  const inner = path.join(above, 'claude');
  try {
    markBoard(above);
    write(above, 'config.json', FAKE);
    write(inner, 'config.json', FAKE);
    write(inner, 'run.log', 'log\n');
    files.resetBoardCache();
    await withStub(files.filesHooks, 'tmpRoots', (m) => (m.kind === 'local' ? [inner] : [B.tmp]), async () => {
      assert.equal((await files.readAllowed({ machine: 'local', path: path.join(inner, 'config.json') })).kind, 'text');
      assert.equal((await files.readAllowed({ machine: 'local', path: path.join(inner, 'run.log') })).kind, 'text');
    });
  } finally {
    await removeTree(above);
    files.resetBoardCache();
  }
});

test('un enlace desde una raíz servida a una copia anidada del tablero: sus secretos responden 404', async () => {
  const dir = path.join(L.tmp, 'copia-e');
  const link = path.join(L.wtRoot, 'enlace-a-copia');
  try {
    buildCopy(dir);
    symlinkSync(dir, link, 'junction');
    files.resetBoardCache();
    await assertCopyProtected('local', link);
    await assertCopyProtected('local', dir);
  } finally {
    rmSync(link, { recursive: true, force: true });
    await removeTree(dir);
    files.resetBoardCache();
  }
});

test('copia del tablero en un runner: en su scratchpad y anidada en su worktree, 404', async () => {
  const a = path.join(B.tmp, 'copia-a');
  const b = path.join(B.wt, 'vendor', 'board');
  try {
    buildCopy(a);
    buildCopy(b);
    files.resetBoardCache();
    // As in the scratchpad test above: the in-process runner owns its files, the uid is the seam.
    const box = machines().box;
    const origRealpath = box.fs.realpath.bind(box.fs);
    await withStub(box.fs, 'realpath', async (p, opts) => ({ ...(await origRealpath(p, opts)), uid: 4242 }), async () => {
      await withStub(files.filesHooks, 'uidOf', async () => 4242, async () => {
        await assertCopyProtected('box', a);
        await assertCopyProtected('box', b);
      });
    });
  } finally {
    await removeTree(a);
    await removeTree(path.join(B.wt, 'vendor'));
    files.resetBoardCache();
  }
});

test('la búsqueda de copias hace pocas llamadas a disco: acotadas en frío, ninguna en caliente', async () => {
  const dir = path.join(L.tmp, 'copia-g');
  try {
    buildCopy(dir);
    const deep = write(dir, 'a/b/c/d/e/f.md', '# hondo\n');
    files.resetBoardCache();
    const before = files.probeStats.exists;
    assert.equal((await files.readAllowed({ machine: 'local', path: deep })).kind, 'md');
    const cold = files.probeStats.exists - before;
    assert.ok(cold > 0 && cold <= 16, `cold request made ${cold} exists calls`);
    const warm0 = files.probeStats.exists;
    assert.equal((await files.readAllowed({ machine: 'local', path: deep })).kind, 'md');
    assert.equal(files.probeStats.exists - warm0, 0, 'a warm request asks the disk nothing new');
  } finally {
    await removeTree(dir);
    files.resetBoardCache();
  }
});

test('200 lecturas seguidas de archivos ordinarios: el recorrido de ancestros no añade lecturas de disco y el total queda acotado', async () => {
  const dir = path.join(L.tmp, 'copia-h');
  try {
    buildCopy(dir);
    const file = path.join(dir, 'src', 'app.js');
    files.resetBoardCache();
    await files.readAllowed({ machine: 'local', path: file }); // the cold request is measured apart
    const existsBefore = files.probeStats.exists;
    const t0 = performance.now();
    for (let i = 0; i < 200; i += 1) await files.readAllowed({ machine: 'local', path: file });
    const ms = performance.now() - t0;
    assert.equal(files.probeStats.exists - existsBefore, 0, 'the ancestor walk asks the disk nothing after the first request');
    // The roots are resolved on every request (about 4 ms each); this bound only catches a runaway (generous: the board check runs many test files at once).
    assert.ok(ms < 30000, `200 warm requests took ${Math.round(ms)} ms`);
    console.log(`# 200 warm requests: ${Math.round(ms)} ms`);
  } finally {
    await removeTree(dir);
    files.resetBoardCache();
  }
});
