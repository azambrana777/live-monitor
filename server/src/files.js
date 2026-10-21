import express from 'express';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { machines, machineFor } from './machine.js';
import { worktreePathFor } from './worktree.js';
import { store } from './store.js';
import { coerceKey, DEFAULT_PROJECT_ID, PROJECT_WORKTREE_DIR } from './keys.js';
import { listProjects } from './projects.js';
import { ROOT, DATA_DIR, CONFIG_FILE, LOCAL_FILE } from './config.js';

/**
 * The file viewer's server side: turn a mention in a chat message
 * (`tmp/user/docs/937-plan.md`, `README.md:352`, `/home/user/…/RERUN.md`)
 * into files that exist, and serve their bytes.
 *
 * A file opens wherever it is. The chat's task may run on the laptop while
 * the file it names only exists on the dev box, or the other way round, so
 * every configured machine is asked in parallel: one that does not answer a
 * cheap probe is reported and never holds up the others.
 *
 * What may be served is decided on the machine that holds the file, after
 * resolving symlinks there: the task worktrees, the main checkout, the
 * machine's `~/.claude/plans`, its `~/tmp` (where sessions leave reports and
 * PR texts) and Claude's scratchpad. A link inside a root
 * that points outside it is outside.
 */

// Mirror of `web/src/viewer/filerefs.js`: the web only makes clickable what
// this module will serve, so both lists must stay identical.
export const FILE_KINDS = {
  md: ['md', 'markdown'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
  text: ['txt', 'log', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'rs', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'ps1', 'css', 'html', 'xml', 'sql', 'csv', 'ini', 'cfg', 'conf', 'lock', 'diff', 'patch'],
};

/** highlight.js language names; an extension without one is shown plain. */
const LANGS = {
  rs: 'rust',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python',
  sh: 'bash', bash: 'bash',
  ps1: 'powershell',
  yml: 'yaml', yaml: 'yaml',
  json: 'json', jsonl: 'json',
  // highlight.js has no TOML grammar of its own; its INI one covers TOML.
  toml: 'ini',
  html: 'xml', xml: 'xml',
  sql: 'sql',
  css: 'css',
  md: 'markdown', markdown: 'markdown',
  diff: 'diff', patch: 'diff',
};

const KIND_BY_EXT = new Map(Object.entries(FILE_KINDS).flatMap(([kind, exts]) => exts.map((ext) => [ext, kind])));

const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
};

const MB = 1024 * 1024;
const MAX_BYTES = { md: 2 * MB, text: 2 * MB, image: 15 * MB };
const MAX_HITS_PER_BASE = 50;
const HIT_CONCURRENCY = 8;
const ETAG_CACHE_MAX = 200;

/** What the viewer would do with a path, from its extension alone. */
export function kindOf(p) {
  const base = String(p ?? '').split(/[\\/]/).pop();
  const m = /\.([A-Za-z0-9]+)$/.exec(base);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  const kind = KIND_BY_EXT.get(ext);
  return kind ? { kind, lang: LANGS[ext] ?? null, ext } : null;
}

/**
 * A mention as written in a message, reduced to a path and a position:
 * `` `crates/hfs/README.md:352` `` → `{ path: 'crates/hfs/README.md', line: 352 }`.
 * Understands `:N`, `:N:M`, `:N-M` and GitHub's `#L12` / `#L12-L20`; a range
 * keeps its first line. Null for anything the viewer would not open, so a
 * caller can test with it.
 */
export function parseRef(ref) {
  if (typeof ref !== 'string') return null;
  let s = ref.trim();
  for (let m; (m = /^([`'"])([\s\S]*)\1$/.exec(s));) s = m[2].trim();
  if (!s || /[\r\n]/.test(s)) return null;
  // `C://x` is still a drive, however oddly written; `https://…` is not a file.
  if (/^[a-z]+:\/\//i.test(s) && !/^[A-Za-z]:[\\/]/.test(s)) return null;
  let line = null;
  let col = null;
  const anchor = /^(.+?)#L(\d+)(?:-L?\d+)?$/.exec(s);
  const suffix = anchor ? null : /^(.+?):(\d+)(?:([:-])(\d+))?$/.exec(s);
  if (anchor) {
    s = anchor[1];
    line = Number(anchor[2]);
  } else if (suffix) {
    s = suffix[1];
    line = Number(suffix[2]);
    if (suffix[3] === ':') col = Number(suffix[4]);
  }
  if (!kindOf(s)) return null;
  return { path: s, line, col };
}

// ---------------------------------------------------------------------------

const INFO_TTL_MS = 10 * 60 * 1000;
const infoCache = new Map();

/**
 * A machine's home and user, asked at most every ten minutes. On a runner the
 * answer comes from `/info`, which also runs `claude --version` there and can
 * take longer than a probe is allowed: without the cache every click would pay
 * it. A failure is not remembered, so a runner that comes back is asked again.
 */
function cachedInfo(machine) {
  const hit = infoCache.get(machine.name);
  if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit.promise;
  const promise = machine.kind === 'local'
    ? Promise.resolve({ home: os.homedir(), uid: process.getuid?.() ?? null })
    : Promise.resolve().then(() => machine.info()).then((info) => ({ home: info.home, uid: info.uid ?? null }));
  infoCache.set(machine.name, { at: Date.now(), promise });
  promise.catch(() => { if (infoCache.get(machine.name)?.promise === promise) infoCache.delete(machine.name); });
  return promise;
}

/**
 * Seams for tests: where a machine's home and Claude scratchpad are and who
 * it runs as, so a test never serves the user's real `~/.claude/plans`; what
 * counts as an absolute path there (an in-process runner on a Windows host
 * has Windows paths behind a POSIX `path`); where the board's own checkout is
 * (only on the machine the board runs on; a checkout elsewhere is recognised
 * by what it holds, not through this); how long one probe, and one whole
 * request, may take.
 */
export const filesHooks = {
  boardRoot: (machine) => (machine.kind === 'local' ? ROOT : null),
  homeOf: (machine) => cachedInfo(machine).then((info) => info.home),
  uidOf: (machine) => cachedInfo(machine).then((info) => info.uid),
  tmpRoots: (machine) => (machine.kind === 'local' ? [path.join(os.tmpdir(), 'claude')] : ['/tmp/claude']),
  isAbsolute: (machine, p) => machine.path.isAbsolute(p),
  probeMs: 5000,
  // A whole resolve or one content request: long enough for a 15 MB image over
  // the tailnet, short enough that a box that died mid-transfer is not a hang.
  requestMs: 15_000,
};

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const notFound = (m, p, message = `No existe en ${m.name}: ${p}`) =>
  httpError(404, message, { tried: [{ machine: m.name, where: p, status: 404 }] });

function withTimeout(promise, ms, what) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${what}: no response in ${Math.round(ms / 1000)} s`), { code: 'TIMEOUT' })), ms);
    timer.unref?.();
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/** Rejects when `signal` aborts, whatever `promise` is still doing. */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('no response in time'), { code: 'TIMEOUT' }));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function machineByName(name) {
  const m = machines()[name];
  if (!m) throw httpError(400, `Unknown machine: «${name}»`);
  return m;
}

const isWin = (m) => m.platform === 'win32';

/**
 * A path in the form the machine's path arithmetic expects. Git and a runner
 * exercised on a Windows host both hand backslashes to a POSIX `path`, which
 * would read the whole thing as one segment (the same normalisation as
 * `RunnerMachine.samePath`). Windows compares without case.
 */
function comparable(m, p) {
  const s = String(p ?? '');
  return isWin(m) ? s.toLowerCase() : s.replace(/\\/g, '/');
}

/**
 * The flip side of `comparable` on a real POSIX box, where `\` is an ordinary
 * filename character: `/tmp/x\..\..\home/…/evil.md` is one odd name in `/tmp`,
 * yet normalised it reads as a file in the checkout. A path that needs the
 * normalisation to climb is refused outright.
 */
function backslashClimbs(m, p) {
  const s = String(p ?? '');
  return !isWin(m) && s.includes('\\') && s.split(/[\\/]/).some((seg) => seg === '.' || seg === '..');
}

function isInside(m, root, file) {
  const rel = m.path.relative(comparable(m, root), comparable(m, file));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${m.path.sep}`) && !m.path.isAbsolute(rel);
}

// Claude's scratchpad on a POSIX box is `/tmp/claude` or, for another user or
// session layout, `/tmp/claude-<something>`: a prefix, not a fixed list of roots.
const POSIX_SCRATCH = /^\/tmp\/claude(?:-[^/]*)?\/./;

/**
 * Which kind of root holds `file`: `'main'` (worktrees, checkout, plans),
 * `'scratch'` (Claude's temp dirs, where on a shared box ownership also
 * matters) or null. Pure path arithmetic on the machine's own rules.
 */
export function rootPlace(machine, { main = [], scratch = [] }, file) {
  if (backslashClimbs(machine, file)) return null;
  if (main.some((root) => isInside(machine, root, file))) return 'main';
  // On the normalised path: `/tmp/claude-x/../../etc/passwd.md` is not in `/tmp/claude-x`.
  if (!isWin(machine) && POSIX_SCRATCH.test(machine.path.normalize(comparable(machine, file)))) return 'scratch';
  if (scratch.some((root) => isInside(machine, root, file))) return 'scratch';
  return null;
}

const DENIED = [
  /^\.env(\.|$)/i, /\.(pem|key|p12|pfx)$/i, /^id_[a-z0-9]+(\.pub)?$/i,
  // `~/.claude/.credentials.json` is where the CLI keeps its login.
  /^\.?credentials/i, /^\.mcp\.json$/i, /^secrets\./i,
];

/** A name that is never served, or a path through a `.git` folder (its config holds remotes and tokens). */
function isDeniedPath(p) {
  const segments = String(p ?? '').split(/[\\/]/);
  if (segments.some((seg) => seg.toLowerCase() === '.git')) return true;
  const name = segments.at(-1);
  return DENIED.some((re) => re.test(name));
}

/**
 * Windows paths that must never reach the disk API, not even to be refused
 * afterwards: a UNC name (`\\host\share`, `\\?\`, `\\.\`) makes Windows open
 * an SMB connection — and hand over the user's NTLM hash — just to resolve
 * it, and a `:` past the drive letter names an alternate data stream.
 */
export function dangerousOnWindows(m, p) {
  return isWin(m) && (/^[\\/]{2}/.test(p) || p.indexOf(':', 2) !== -1);
}

/**
 * The folders a machine will serve from, as configured (not yet resolved).
 *
 * The union over every registered project, because a mention in a chat of one
 * project can name a file in another checkout on the same disk, and a root the
 * viewer does not know is a 403 the person cannot do anything about. A project
 * that is not declared on this machine — any second project on a runner —
 * simply contributes nothing. A root that is not there is dropped later, when
 * it fails to resolve (`rootsOn`), so a `app-b-wt` nobody has cut yet
 * costs nothing.
 *
 * The default project deliberately reads the machine itself rather than the
 * registry: `machineFor` does the same, and for the same reason — the registry
 * freezes its seed on first load while the machine follows the live
 * `config.project`, which the worktree fixtures move.
 */
export async function allowedRoots(machine) {
  const m = typeof machine === 'string' ? machineByName(machine) : machine;
  let home = null;
  try {
    home = await withTimeout(Promise.resolve().then(() => filesHooks.homeOf(m)), filesHooks.probeMs, m.name);
  } catch {
    // Without a home the plans folder is not a root; the worktrees still are.
    home = null;
  }
  const tmp = (await filesHooks.tmpRoots(m)) ?? [];
  const perProject = projectViews(m).flatMap((view) => [view.worktreeRoot, view.repoPath]);
  // The board's own checkout, on the machine the board runs on, unless a
  // project already contributes it (`board` is the board, so it is one of them).
  const board = await filesHooks.boardRoot(m);
  const own = board && !perProject.some((p) => p && m.samePath(p, board)) ? board : null;
  return [...new Set([...perProject, own, home ? m.path.join(home, '.claude', 'plans') : null, home ? m.path.join(home, 'tmp') : null, ...tmp])].filter(Boolean);
}

/**
 * The machine as every registered project sees it. A project that is not
 * declared on this machine contributes nothing.
 */
function projectViews(m) {
  const views = [];
  for (const p of listProjects()) {
    if (p.id === DEFAULT_PROJECT_ID) {
      views.push(m);
      continue;
    }
    try {
      views.push(machineFor(m.name, p.id));
    } catch {
      // Not declared on this machine: not a root here.
    }
  }
  return views;
}

/**
 * What the viewer never serves from a checkout of the board itself, as path
 * segments below the checkout. A checkout is any directory `isBoardCheckout`
 * recognises, plus the one the board runs from, and so is every folder directly
 * under the worktree root of a project whose checkout is one: each of them has
 * its own tracked `config.json`.
 */
function boardSecret(segs) {
  const name = segs.at(-1) ?? '';
  if (segs.length === 1 && (name === 'config.json' || name === 'config.local.json')) return true;
  if (segs[0] === 'server' && segs[1] === 'data') return true;
  if (segs[0] === '.claude') return true;
  return /\.log$/i.test(name) || /\.local\.[^/\\]*$/i.test(name);
}

const BOARD_MARKERS = [['server', 'src', 'config.js'], ['server', 'src', 'files.js']];
const BOARD_CHECKOUT_TTL_MS = 60_000;
const BOARD_ANCESTOR_LEVELS = 8;
const boardCheckouts = new Map();
/** Disk calls `isBoardCheckout` has made (a test seam: the ancestor walk must stay bounded). */
export const probeStats = { exists: 0 };

/** Forgets what was learned about which directories are board checkouts (tests). */
export function resetBoardCache() {
  boardCheckouts.clear();
}

/**
 * Whether `dir` is a checkout of the board itself, by what it holds rather than
 * by where the running process lives: it has the board's `config.js` and
 * `files.js`. Asked of the machine's own file API, so it works on a runner too.
 * The answer is kept for a minute, per machine and directory. A probe that
 * fails is not kept and is not an answer: the error goes up and nothing is
 * served on a guess.
 */
function isBoardCheckout(m, dir, signal) {
  const key = `${m.name}\0${comparable(m, dir)}`;
  const hit = boardCheckouts.get(key);
  if (hit && Date.now() - hit.at < BOARD_CHECKOUT_TTL_MS) return hit.promise;
  const exists = (marker) => withTimeout(
    Promise.resolve().then(() => { probeStats.exists += 1; return m.fs.exists(m.path.join(dir, ...marker), { signal }); }), filesHooks.probeMs, m.name,
  );
  const promise = Promise.all(BOARD_MARKERS.map(exists)).then((found) => found.every(Boolean));
  boardCheckouts.set(key, { at: Date.now(), promise });
  promise.catch(() => { if (boardCheckouts.get(key)?.promise === promise) boardCheckouts.delete(key); });
  return promise;
}

/**
 * The places of the board's tree on this machine, or null when it has none: the
 * checkouts (the one the board runs from, here, plus every project checkout
 * that is one by `isBoardCheckout`), the worktree root of each project whose
 * checkout is one, and, only on the machine the board runs on, the live config
 * files and data folder, which `HFSMON_CONFIG` / `HFSMON_DATA_DIR` may put
 * anywhere.
 */
async function boardPlaces(m, signal) {
  const own = await filesHooks.boardRoot(m);
  const views = projectViews(m).filter((view) => view.repoPath);
  const found = await Promise.all(views.map(async (view) => (
    (own && m.samePath(view.repoPath, own)) || await isBoardCheckout(m, view.repoPath, signal) ? view.repoPath : null)));
  const checkouts = [own, ...found].filter(Boolean);
  const wtRoots = views
    .filter((view) => view.worktreeRoot && checkouts.some((c) => m.samePath(view.repoPath, c)))
    .map((view) => view.worktreeRoot);
  const local = m.kind === 'local';
  if (!checkouts.length && !local) return null;
  return { checkouts, wtRoots, files: local ? [CONFIG_FILE, LOCAL_FILE] : [], dirs: local ? [DATA_DIR] : [] };
}

/**
 * The board checkouts found among the ancestors of `file`: a copy of the board
 * can sit anywhere inside a served root, not only where a project is registered.
 * The walk goes from the file's folder upward, never above the served root that
 * holds it, and for at most `BOARD_ANCESTOR_LEVELS` levels; each folder is asked
 * to the cached `isBoardCheckout`. Path arithmetic and the machine's own file API
 * only: nothing is asked about `file` itself.
 */
async function ancestorCheckouts(m, roots, file, signal) {
  const holders = [...roots.main, ...roots.scratch].filter((root) => isInside(m, root, file));
  // The walk ends at the outermost served root that holds the file, itself included.
  const top = holders.sort((x, y) => comparable(m, x).length - comparable(m, y).length)[0];
  const dirs = [];
  let dir = m.path.dirname(comparable(m, file));
  for (let level = 0; level < BOARD_ANCESTOR_LEVELS; level += 1) {
    dirs.push(dir);
    const up = m.path.dirname(dir);
    if (up === dir || (top && m.path.relative(comparable(m, top), dir) === '')) break;
    dir = up;
  }
  const found = await Promise.all(dirs.map((d) => isBoardCheckout(m, d, signal).then((is) => (is ? d : null))));
  return found.filter(Boolean);
}

/** `board` plus the copies found above `file` (and `real`, where it lands), or null when there is nothing to protect. */
async function placesFor(m, board, roots, file, signal) {
  const found = await ancestorCheckouts(m, roots, file, signal);
  if (!found.length) return board;
  return { checkouts: [...(board?.checkouts ?? []), ...found], wtRoots: board?.wtRoots ?? [], files: board?.files ?? [], dirs: board?.dirs ?? [] };
}

/** The same places once symlinks are resolved: a link in the tree can lead to one, and the board's folders can be links. */
async function withRealPlaces(m, places, signal) {
  const resolveOne = (p) => realpathOn(m, p, signal).then((r) => r.path);
  const real = async (list) => (await Promise.all(list.map((p) => resolveOne(p).catch(() => null)))).filter(Boolean);
  return {
    checkouts: [...places.checkouts, ...await real(places.checkouts)],
    wtRoots: [...places.wtRoots, ...await real(places.wtRoots)],
    files: [...places.files, ...await real(places.files)],
    dirs: [...places.dirs, ...await real(places.dirs)],
  };
}

/** Whether `file` is something the board keeps secret, by path arithmetic alone (no disk). */
function isBoardSecret(m, places, file) {
  // `relative` resolves both sides, so `x/../config.json` needs no normalising first.
  const f = comparable(m, file);
  const below = (root) => {
    const rel = m.path.relative(comparable(m, root), f);
    if (rel === '' || rel === '..' || rel.startsWith(`..${m.path.sep}`) || m.path.isAbsolute(rel)) return null;
    return rel.split(/[\\/]/);
  };
  const same = (p) => m.path.relative(comparable(m, p), f) === '';
  return places.checkouts.some((root) => { const s = below(root); return s && boardSecret(s); })
    || places.wtRoots.some((root) => { const s = below(root); return s && boardSecret(s.slice(1)); })
    || places.files.some(same)
    || places.dirs.some((d) => same(d) || below(d));
}

const isUnanswered = (e) => e?.name === 'TypeError' || e?.name === 'AbortError' || e?.name === 'TimeoutError' || e?.code === 'TIMEOUT';

/** A machine that does not answer is a 502; the local disk failing oddly is ours, a 500. */
function fsError(e, m, p) {
  if (e?.status) return e;
  if (isUnanswered(e)) return httpError(502, `${m.name} did not respond (${e.message})`);
  const text = `${e?.code ?? ''} ${e?.message ?? ''}`;
  if (/ENOENT|ENOTDIR|no such file/i.test(text)) return notFound(m, p);
  if (/EISDIR/.test(text)) return notFound(m, p, `Es una carpeta, no un archivo: ${p}`);
  if (/EACCES|EPERM/.test(text)) return httpError(403, `No permission to read ${p} on ${m.name}`);
  if (m.kind === 'local') return httpError(500, `Could not read ${p}: ${e?.message}`);
  return httpError(502, `${m.name} did not respond properly (${e?.message})`);
}

/**
 * `{ path, size, isFile, uid, mtimeMs, nlink }` for where a path really lands on that
 * machine. A runner from before `/fs/realpath` answers `NO_ROUTE`, and
 * `realpath -e` plus `stat` do the same job there without updating it first
 * (with no mtime, so that runner never answers a reload from the cache).
 */
async function realpathOn(m, p, signal) {
  try {
    return await withTimeout(Promise.resolve().then(() => m.fs.realpath(p, { signal })), filesHooks.probeMs, m.name);
  } catch (e) {
    if (e?.code !== 'NO_ROUTE') throw fsError(e, m, p);
  }
  const exec = (file, args) => withTimeout(m.exec(file, args, { timeoutMs: filesHooks.probeMs }), filesHooks.probeMs + 1000, m.name)
    .catch((e) => { throw fsError(e, m, p); });
  // `--`: a name like `-x.md` is a file, not an option.
  const resolved = await exec('realpath', ['-e', '--', p]);
  if (!resolved.ok) throw notFound(m, p);
  const real = resolved.stdout.replace(/\r?\n$/, '');
  const stat = await exec('stat', ['-Lc', '%s %F %u %h', '--', real]);
  if (!stat.ok) throw notFound(m, p);
  const parts = /^(\d+) (.+) (\d+) (\d+)$/.exec(stat.stdout.trim());
  if (!parts) throw httpError(502, `${m.name}: stat did not return what was expected for ${real}`);
  return { path: real, size: Number(parts[1]), isFile: /^regular (empty )?file$/.test(parts[2]), uid: Number(parts[3]), mtimeMs: null, nlink: Number(parts[4]) };
}

/**
 * The roots, main and scratch apart, as configured and as resolved on the
 * machine. The configured form serves the check made before touching the
 * disk; the resolved one, the check on the real path. A root that does not
 * exist there is not a root.
 */
async function rootsOn(m, signal) {
  const all = await allowedRoots(m);
  const scratchSet = new Set((await filesHooks.tmpRoots(m)) ?? []);
  const configured = { main: all.filter((r) => !scratchSet.has(r)), scratch: all.filter((r) => scratchSet.has(r)) };
  const resolve = async (list) => (await Promise.all(list.map((root) => realpathOn(m, root, signal).then((r) => r.path, (e) => {
    if (e.status === 502 || e.status === 500) throw e;
    return null;
  })))).filter(Boolean);
  const [main, scratch] = await Promise.all([resolve(configured.main), resolve(configured.scratch)]);
  return { configured, real: { main, scratch } };
}

// Per machine, `path → { size, mtimeMs, etag }` of what was last read: the
// live reload asks every few seconds, and an unchanged file on a runner must
// not travel the tailnet each time just to be hashed into the same ETag.
const etagCaches = new Map();

function etagCacheOf(m) {
  if (!etagCaches.has(m.name)) etagCaches.set(m.name, new Map());
  return etagCaches.get(m.name);
}

function rememberEtag(m, key, entry) {
  const cache = etagCacheOf(m);
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > ETAG_CACHE_MAX) cache.delete(cache.keys().next().value);
}

function etagMatches(header, etag) {
  if (!header || !etag) return false;
  return String(header).split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
}

/**
 * `readAllowed` on a machine object. `roots` is a function so a caller probing
 * many hits resolves them once, and only when needed: a promise made up front
 * would reject unobserved when an earlier step fails first.
 */
async function readOn(m, requested, { roots = () => rootsOn(m, signal), boardOf = () => boardPlaces(m, signal), signal, ifNoneMatch } = {}) {
  const work = async () => {
    // Denied names first: a bare `.env` or `id_rsa` has no extension the viewer
    // opens, and must still be refused as a secret (403), not as a wrong type.
    if (isDeniedPath(requested)) throw httpError(403, `The viewer does not show this file: ${requested}`);
    if (dangerousOnWindows(m, requested) || backslashClimbs(m, requested)) throw httpError(403, `Path not allowed: ${requested}`);
    // The board's own secrets answer as a file that is not there, before any
    // disk call on the requested path and before the type check: a 403 would
    // say they exist, and a 400 would say the name is not even looked at. Which
    // directories are board checkouts is asked of the roots, not of this path.
    const { configured, real: realRoots } = await roots();
    const byName = { main: [...configured.main, ...realRoots.main], scratch: [...configured.scratch, ...realRoots.scratch] };
    // A copy of the board anywhere inside a served root is found among the
    // ancestors of the path, not only where a project is registered.
    const board = await placesFor(m, await boardOf(), byName, requested, signal);
    if (board && isBoardSecret(m, board, requested)) throw notFound(m, requested);
    if (!kindOf(requested)) throw httpError(400, `The viewer does not open this file type: ${requested}`);
    // Before any disk call on the path itself: a name outside every root is
    // refused without asking the filesystem what it is.
    if (!rootPlace(m, byName, requested)) throw httpError(403, `Outside the allowed folders on ${m.name}: ${requested}`);
    const info = await realpathOn(m, requested, signal);
    // And again where it lands: `ok.md` may be a link to `.env`, to a binary,
    // or to a folder outside every root.
    if (isDeniedPath(info.path)) throw httpError(403, `The viewer does not show this file: ${info.path}`);
    if (backslashClimbs(m, info.path)) throw httpError(403, `Path not allowed: ${info.path}`);
    // The link's target is never named: the answer is the one for the requested path.
    const realBoard = await placesFor(m, board, byName, info.path, signal);
    if (realBoard && isBoardSecret(m, await withRealPlaces(m, realBoard, signal), info.path)) throw notFound(m, requested);
    // A hard link is a second name for a file, and its real path is its own:
    // `inocente.md` may be `config.json`. No way to tell from here, so where the
    // board's secrets are, a file with more than one name is not served.
    if (realBoard && info.isFile && info.nlink > 1) throw notFound(m, requested);
    const kind = kindOf(info.path);
    if (!kind) throw httpError(403, `${requested} points to a file the viewer does not open: ${info.path}`);
    const place = rootPlace(m, realRoots, info.path);
    if (!place) throw httpError(403, `Outside the allowed folders on ${m.name}: ${info.path}`);
    if (place === 'scratch' && !isWin(m)) {
      // `/tmp/claude-*` can be anyone's on a shared box: only this user's is served.
      const owner = await withTimeout(Promise.resolve().then(() => filesHooks.uidOf(m)), filesHooks.probeMs, m.name).catch(() => null);
      if (owner == null || info.uid == null || info.uid !== owner) {
        throw httpError(403, `Belongs to another user on ${m.name}: ${info.path}`);
      }
    }
    if (!info.isFile) throw notFound(m, requested, `No es un archivo: ${info.path}`);
    const cap = MAX_BYTES[kind.kind];
    const tooBig = (size) => httpError(413, `Too large for the viewer: ${(size / MB).toFixed(1)} MB (max ${cap / MB} MB)`);
    // From the stat, so a gigabyte of log is never pulled over the tailnet.
    if (info.size > cap) throw tooBig(info.size);

    const key = comparable(m, info.path);
    const cached = etagCacheOf(m).get(key);
    if (ifNoneMatch && cached && info.mtimeMs != null && cached.mtimeMs === info.mtimeMs
        && cached.size === info.size && etagMatches(ifNoneMatch, cached.etag)) {
      return { machine: m.name, path: info.path, kind: kind.kind, lang: kind.lang, bytes: null, etag: cached.etag, size: info.size, notModified: true };
    }
    let bytes;
    try {
      bytes = await m.fs.readBinary(info.path, { signal });
    } catch (e) {
      throw fsError(e, m, info.path);
    }
    // It may have grown between the stat and the read.
    if (bytes.length > cap) throw tooBig(bytes.length);
    const etag = `"sha1:${createHash('sha1').update(bytes).digest('hex')}"`;
    if (info.mtimeMs != null && bytes.length === info.size) rememberEtag(m, key, { size: info.size, mtimeMs: info.mtimeMs, etag });
    return { machine: m.name, path: info.path, kind: kind.kind, lang: kind.lang, bytes, etag, size: bytes.length };
  };
  try {
    return await untilAborted(work(), signal);
  } catch (e) {
    throw fsError(e, m, requested);
  }
}

/**
 * One file's bytes, if that machine allows serving it. Errors carry an HTTP
 * `status`. With `ifNoneMatch`, an unchanged file may come back as
 * `{ notModified: true, bytes: null }` without being read.
 */
export async function readAllowed({ machine, path: p, signal, ifNoneMatch }) {
  const m = machineByName(String(machine ?? ''));
  if (typeof p !== 'string' || !p) throw httpError(400, 'Missing file path');
  // A relative path would be resolved against wherever each process happens
  // to run, which for a runner means nothing the board can check.
  if (!filesHooks.isAbsolute(m, p)) throw httpError(400, `The path must be absolute on ${m.name}: ${p}`);
  return readOn(m, p, { signal, ifNoneMatch });
}

// ---------------------------------------------------------------------------

function shapeOf(p) {
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\')) return 'windows';
  if (p.startsWith('/')) return 'posix';
  if (/^~[\\/]/.test(p)) return 'home';
  if (/[\\/]/.test(p)) return 'relative';
  return 'bare';
}

/** A path shape names the machines it can be on: a drive letter is never on the box. */
function shapeFits(shape, m) {
  if (shape === 'windows') return isWin(m);
  if (shape === 'posix') return !isWin(m);
  return true;
}

/**
 * Where a relative mention is looked for on one machine, in order: the
 * task's worktree there (the active one, a parked place, or the one its
 * branch would have), then the machine's main checkout.
 *
 * A project chat has no task: its owner is `{ kind: 'project', project,
 * machine }` and its working directory is the holder worktree
 * `<worktreeRoot>/_proyecto`, derived here rather than looked up (looking a
 * holder up creates it). That base is only on the holder's machine, or on every
 * machine when the caller did not say which one. A relative path is joined to it
 * without probing it; a bare name checks that it exists first. One that was
 * never created shows up in `tried` as a 404.
 *
 * A project this machine does not hold has no bases at all: searching the
 * machine's own roots instead would look for its mention inside hfs.
 */
async function basesFor(m, task) {
  // The machine as this task's project sees it: the same disk holds both
  // checkouts, so without this a relative mention in a app-b chat would
  // be looked for inside hfs — and, worse, found there. A task from before
  // projects existed belongs to the default one, which reads the machine
  // itself, unchanged.
  const projectId = task?.project ?? DEFAULT_PROJECT_ID; // allowlisted: a chat task from before projects existed belongs to the default one
  let view = m;
  if (projectId !== DEFAULT_PROJECT_ID) {
    try {
      view = machineFor(m.name, projectId);
    } catch {
      // Unknown project, or one this machine does not hold: nothing to search.
      return [];
    }
  }
  const bases = [];
  if (task?.kind === 'project') {
    if ((task.machine == null || task.machine === m.name) && view.worktreeRoot) {
      bases.push({ dir: m.path.join(view.worktreeRoot, PROJECT_WORKTREE_DIR), kind: 'worktree', optional: true });
    }
  } else if (task) {
    let wt = (task.machine ?? 'local') === m.name ? task.worktreePath : task.places?.[m.name]?.worktreePath;
    if (!wt && task.branch && view.worktreeRoot) {
      const guess = worktreePathFor(view, task.branch);
      if (await withTimeout(Promise.resolve().then(() => m.fs.exists(guess)), filesHooks.probeMs, m.name)) wt = guess;
    }
    if (wt) bases.push({ dir: wt, kind: 'worktree' });
  }
  if (view.repoPath && !bases.some((b) => m.samePath(b.dir, view.repoPath))) bases.push({ dir: view.repoPath, kind: 'repo' });
  return bases;
}

/**
 * A bare file name, in one checkout: tracked and untracked-but-not-ignored
 * files anywhere, plus the gitignored `tmp/` where the working docs live,
 * without listing the ignored `target/` trees. The first walk still visits
 * untracked folders that are not ignored (a `target-r4-main/`) and can run
 * out of time: that is a cut-off search, reported as such, not a dead machine.
 */
async function gitSearch(m, dir, name) {
  const opts = { cwd: dir, timeoutMs: filesHooks.probeMs };
  const git = (args) => withTimeout(m.exec('git', args, opts), filesHooks.probeMs + 1000, m.name)
    .catch((e) => {
      if (e.code === 'TIMEOUT') return { ok: false, code: -2, stdout: '' };
      throw e;
    });
  const [visible, ignored] = await Promise.all([
    git(['ls-files', '-z', '-co', '--exclude-standard', '--', `:(glob)**/${name}`, name]),
    git(['ls-files', '-z', '-oi', '--exclude-standard', '--', `:(glob)tmp/**/${name}`]),
  ]);
  const hits = [];
  for (const r of [visible, ignored]) {
    // A killed git may stop mid-name: only NUL-terminated entries count.
    for (const f of String(r.stdout ?? '').split('\0').slice(0, -1)) if (f && !hits.includes(f)) hits.push(f);
  }
  return {
    searched: visible.ok || ignored.ok,
    cut: visible.code === -2 || ignored.code === -2,
    hits: hits.slice(0, MAX_HITS_PER_BASE),
  };
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const toSlash = (p) => p.replace(/\\/g, '/');

/** Everything one machine has for a mention. Throws only when the machine itself fails. */
async function probeMachine(m, parsed, task, sink, signal) {
  let rootsPromise = null;
  const roots = () => (rootsPromise ??= rootsOn(m, signal));
  let boardPromise = null;
  const boardOf = () => (boardPromise ??= boardPlaces(m, signal));
  const check = async (full, meta, searchedIn) => {
    try {
      const file = await readOn(m, full, { roots, boardOf, signal });
      sink.add({ machine: m.name, path: file.path, kind: file.kind, lang: file.lang, etag: file.etag, size: file.size, ...meta });
    } catch (e) {
      // Out of time for the whole resolve: this place was not finished, which
      // says nothing about whether the machine answers.
      if (signal?.aborted) {
        sink.tried({ machine: m.name, where: full, status: null, cut: true });
        return;
      }
      // A 403/404/413 is an answer about that place, not about the machine.
      if (![400, 403, 404, 413].includes(e.status)) throw e;
      // A search hit exists in git, so a 404 on it means the viewer hides it
      // (a secret, or a link to one): name the folder searched, not the hit.
      sink.tried({ machine: m.name, where: searchedIn && e.status === 404 ? searchedIn : full, status: e.status });
    }
  };

  const shape = shapeOf(parsed.path);
  if (shape === 'windows' || shape === 'posix') {
    await check(parsed.path, { rel: toSlash(parsed.path), base: 'absolute', baseIndex: 0, seq: 0 });
    return;
  }
  const segments = parsed.path.split(/[\\/]+/).filter(Boolean);
  if (shape === 'home') {
    let home;
    try {
      home = await withTimeout(Promise.resolve().then(() => filesHooks.homeOf(m)), filesHooks.probeMs, m.name);
    } catch {
      // The machine answered the probe; only its home is slow to tell.
      sink.tried({ machine: m.name, where: parsed.path, status: null });
      return;
    }
    const rest = segments.slice(1);
    await check(m.path.join(home, ...rest), { rel: rest.join('/'), base: 'home', baseIndex: 0, seq: 0 });
    return;
  }

  const bases = await basesFor(m, task);
  await Promise.all(bases.map(async (base, baseIndex) => {
    if (shape === 'relative') {
      const full = m.path.join(base.dir, ...segments);
      await check(full, { rel: path.posix.normalize(segments.join('/')), base: base.kind, baseIndex, seq: 0 });
      return;
    }
    // A base that may not exist yet (a holder worktree nobody has cut) is a
    // miss, not a failure of the machine.
    if (base.optional) {
      // A slow answer is a cut search, like gitSearch's own timeouts: it must not
      // turn a machine that passed the cheap probe into an unreachable one.
      const there = await withTimeout(Promise.resolve().then(() => m.fs.exists(base.dir)), filesHooks.probeMs, m.name).catch(() => null);
      if (there === null) {
        sink.tried({ machine: m.name, where: `${base.dir} (búsqueda cortada)`, status: null, cut: true });
        return;
      }
      if (!there) {
        sink.tried({ machine: m.name, where: base.dir, status: 404 });
        return;
      }
    }
    const found = await gitSearch(m, base.dir, parsed.path);
    const { searched, cut } = found;
    // A secret is neither found nor named: the search reads as if it was not there.
    const board = await boardOf();
    const hits = board ? found.hits.filter((hit) => !isBoardSecret(m, board, m.path.join(base.dir, ...hit.split('/')))) : found.hits;
    if (cut) sink.tried({ machine: m.name, where: `${base.dir} (búsqueda cortada)`, status: null, cut: true });
    else if (!hits.length) sink.tried({ machine: m.name, where: base.dir, status: searched ? 404 : null });
    await mapLimit(hits, HIT_CONCURRENCY, (hit, seq) =>
      check(m.path.join(base.dir, ...hit.split('/')), { rel: hit, base: 'search', baseIndex, seq }, base.dir));
  }));
}

/**
 * Every file a mention can mean, on every machine. `candidates` never carry
 * bytes, only the ETag, so the web can tell «the same file on two machines»
 * (same `rel`) from «different content on the other machine» (another ETag).
 */
export async function resolveRef({ task = null, ref }) {
  const parsed = parseRef(ref);
  if (!parsed) throw httpError(400, `Not a reference to a file the viewer opens: ${ref}`);
  const shape = shapeOf(parsed.path);
  // Pathspec syntax: a bare `*.md` would list every file there is, and a
  // leading `:` is magic (`:(exclude)x.md` lists the whole repository).
  if (shape === 'bare' && (/[*?[\]]/.test(parsed.path) || parsed.path.startsWith(':'))) {
    throw httpError(400, `Name with git syntax, not a file name: ${parsed.path}`);
  }
  const activeName = task?.machine ?? 'local';
  const all = Object.values(machines());
  const signal = AbortSignal.timeout(filesHooks.requestMs);

  const found = [];
  const tried = [];
  const unreachable = [];
  await Promise.all(all.map(async (m, machineIndex) => {
    if (!shapeFits(shape, m)) return;
    // Whether the machine answers at all is one cheap question; a slow search
    // on a machine that does answer is not the same thing as a dead one.
    try {
      const probe = AbortSignal.timeout(filesHooks.probeMs);
      await withTimeout(Promise.resolve().then(() => m.fs.exists(m.worktreeRoot ?? m.repoPath ?? '.', { signal: probe })), filesHooks.probeMs, m.name);
    } catch {
      unreachable.push({ name: m.name, machineIndex });
      return;
    }
    let hits = 0;
    const sink = {
      add: (c) => { hits += 1; found.push({ ...c, machineIndex, active: m.name === activeName }); },
      tried: (t) => tried.push(t),
    };
    try {
      await probeMachine(m, parsed, task, sink, signal);
    } catch (e) {
      // A machine that already produced a file did answer, whatever failed after.
      if (hits > 0 || (e.status && e.status !== 502)) tried.push({ machine: m.name, where: parsed.path, status: e.status ?? null });
      else unreachable.push({ name: m.name, machineIndex });
    }
  }));

  found.sort((a, b) => (Number(b.active) - Number(a.active))
    || (a.machineIndex - b.machineIndex) || (a.baseIndex - b.baseIndex) || (a.seq - b.seq));
  // One entry per file per machine, and per relative path per machine: the
  // same `docs/x.md` in the worktree and in the checkout is the worktree's.
  const seen = new Set();
  const candidates = [];
  for (const c of found) {
    const m = machines()[c.machine];
    const byPath = `${c.machine}\0p\0${m ? comparable(m, c.path) : c.path}`;
    const byRel = `${c.machine}\0r\0${c.rel}`;
    if (seen.has(byPath) || seen.has(byRel)) continue;
    seen.add(byPath);
    seen.add(byRel);
    candidates.push({ machine: c.machine, path: c.path, kind: c.kind, lang: c.lang, rel: c.rel, base: c.base, etag: c.etag, size: c.size, active: c.active });
  }
  return {
    line: parsed.line,
    col: parsed.col,
    candidates,
    unreachable: unreachable.sort((a, b) => a.machineIndex - b.machineIndex).map((u) => u.name),
    tried,
  };
}

// ---------------------------------------------------------------------------

// An `.svg` is shown, never run: no scripts, no fetches, only its own styles;
// opened on its own it is a sandboxed document that no other site can frame.
const CONTENT_SECURITY_POLICY = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'";

const sendError = (res, e) => res.status(e.status ?? 500).json({ error: e.message, tried: e.tried ?? null });

export const filesRouter = express.Router();

filesRouter.get('/api/files/resolve', async (req, res) => {
  res.set({ 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' });
  try {
    // `project` is optional: a link from a board that does not send one means
    // the project the board has always watched. An issue the board does not
    // know is a mention without a task, not an error.
    const key = req.query.issue
      ? coerceKey(req.query.issue, req.query.project ? String(req.query.project) : DEFAULT_PROJECT_ID) // allowlisted: legacy clients send a bare issue number
      : null;
    let task = key ? (store.get(key) ?? null) : null;
    // A project chat has no issue: `project` + `machine` name its holder. The
    // owner is built, not looked up (a lookup would create the holder), and an
    // unknown project or machine is no owner / every machine, as before.
    if (!req.query.issue && req.query.project) {
      const project = String(req.query.project);
      if (listProjects().some((p) => p.id === project)) {
        const machine = String(req.query.machine ?? '');
        task = { kind: 'project', project, issue: null, machine: machines()[machine] ? machine : null };
      }
    }
    res.json(await resolveRef({ task, ref: String(req.query.ref ?? '') }));
  } catch (e) {
    sendError(res, e);
  }
});

filesRouter.get('/api/files/content', async (req, res) => {
  res.set({
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  });
  try {
    const ifNoneMatch = req.headers['if-none-match'];
    const file = await readAllowed({
      machine: String(req.query.machine ?? ''), path: String(req.query.path ?? ''),
      signal: AbortSignal.timeout(filesHooks.requestMs), ifNoneMatch,
    });
    res.set('ETag', file.etag);
    // The live reload asks every few seconds; an unchanged file costs a stat, not a transfer.
    if (file.notModified || etagMatches(ifNoneMatch, file.etag)) return res.status(304).end();
    if (file.kind === 'image') {
      res.type(IMAGE_TYPES[kindOf(file.path).ext]);
      return res.send(file.bytes);
    }
    return res.json({
      kind: file.kind, lang: file.lang, text: file.bytes.toString('utf8'),
      etag: file.etag, size: file.size, machine: file.machine, path: file.path,
    });
  } catch (e) {
    return sendError(res, e);
  }
});

// An `.html` shown as a page, inside a sandboxed iframe of the viewer: no
// scripts, no network (so no relative image, no external CSS, no fonts but
// `data:`), no forms, no navigation of the top window.
const PAGE_SECURITY_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox; frame-ancestors 'self'";

// Only `.html`, not `.htm`: `FILE_KINDS` does not open the latter, and the web mirrors that list.
const isHtmlPath = (p) => /\.html$/i.test(String(p ?? ''));

// Same reads as `/api/files/content` (roots, denylist, size cap, ETag), only
// the answer differs: the file's own bytes, typed as a page.
filesRouter.get('/api/files/page', async (req, res) => {
  res.set({
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': PAGE_SECURITY_POLICY,
  });
  try {
    const requested = String(req.query.path ?? '');
    // Before any read: the viewer only turns a request for an `.html` into a page.
    if (!isHtmlPath(requested)) throw httpError(400, `Only .html files are shown as a page: ${requested}`);
    const ifNoneMatch = req.headers['if-none-match'];
    const file = await readAllowed({
      machine: String(req.query.machine ?? ''), path: requested,
      signal: AbortSignal.timeout(filesHooks.requestMs), ifNoneMatch,
    });
    // And again where it lands: `a.html` may be a link to a script.
    if (!isHtmlPath(file.path)) throw httpError(400, `${requested} points to a file that is not .html`);
    res.set('ETag', file.etag);
    if (file.notModified || etagMatches(ifNoneMatch, file.etag)) return res.status(304).end();
    res.type('text/html; charset=utf-8');
    return res.send(file.bytes);
  } catch (e) {
    return sendError(res, e);
  }
});
