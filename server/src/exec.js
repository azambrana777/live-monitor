import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Run an executable (git.exe / gh.exe resolve without a shell, so argv is safe
 * against quoting issues). Use runShell() only for fixed command strings the
 * board itself writes (npm scripts, .cmd files). A command line written by a
 * model — a plan task's `check` — is bash syntax and goes to runPosixShell().
 *
 * Never rejects. Besides the command's own exit code, `code` can be: -1 could
 * not run, -2 timed out, -3 the caller went away (`signal` aborted, e.g. the
 * board disconnected from the runner).
 */
export function run(file, args, { cwd, onLine, timeoutMs = 10 * 60 * 1000, env, signal } = {}) {
  return throttled(file, args, cwd, () => execute(file, args, false, { cwd, onLine, timeoutMs, env, signal }));
}

/**
 * Global process budget. Task-level limits count tasks, not processes (one
 * task runs four git calls at once, a classification two to four gh calls), so
 * the cap lives here, at the spawn, keyed on the command name. Only the real
 * spawn holds a slot: a caller waiting for gitMutex or anything else holds
 * nothing, so a writer queue cannot starve the readers it waits behind.
 * Remote runner machines have their own path and are not counted here.
 */
const caps = { gh: 8, ghPerRepo: 4, git: 8 };
let globalSemsCache = null;
const globalSems = () => (globalSemsCache ??= {
  gh: new Semaphore(() => caps.gh),
  git: new Semaphore(() => caps.git),
});
const ghRepoSems = new Map();

/** Overrides the caps (tests, tuning). Returns the previous values. */
export function setProcessCaps(next = {}) {
  const prev = { ...caps };
  for (const k of ['gh', 'ghPerRepo', 'git']) {
    if (next[k] != null) caps[k] = Math.max(1, Math.floor(Number(next[k])) || 1);
  }
  globalSems().gh.refresh(); globalSems().git.refresh();
  for (const sem of ghRepoSems.values()) sem.refresh();
  return prev;
}

export function getProcessCaps() { return { ...caps }; }

/** Tests only: live counters of the global semaphores. */
export function _processSlots() {
  return { gh: globalSems().gh.active, git: globalSems().git.active };
}

function commandName(file) {
  return String(file).replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
}

/** `-R owner/name` / `--repo` in a gh argv, else the cwd, else null. */
function ghRepoKey(args, cwd) {
  const i = args.findIndex((a) => a === '-R' || a === '--repo');
  if (i >= 0 && args[i + 1]) return String(args[i + 1]).toLowerCase();
  const eq = args.find((a) => typeof a === 'string' && a.startsWith('--repo='));
  if (eq) return eq.slice(7).toLowerCase();
  const api = args.find((a) => typeof a === 'string' && /^repos\/[^/]+\/[^/?]+/.test(a));
  if (api) return api.split('/').slice(1, 3).join('/').toLowerCase();
  return cwd ? `cwd:${String(cwd).toLowerCase()}` : null;
}

/** Tests only: the budget layer around any async `spawnIt`. */
export const _throttled = (file, args, cwd, spawnIt) => throttled(file, args, cwd, spawnIt);

function throttled(file, args, cwd, spawnIt) {
  const name = commandName(file);
  const global = globalSems()[name];
  if (!global) return spawnIt();
  if (name !== 'gh') return global.run(spawnIt);
  const key = ghRepoKey(args, cwd);
  if (!key) return global.run(spawnIt);
  let per = ghRepoSems.get(key);
  if (!per) { per = new Semaphore(() => caps.ghPerRepo); ghRepoSems.set(key, per); }
  // Per-repo first, then global: a repo's queue never sits on global slots.
  return per.run(() => global.run(spawnIt));
}

/** Run a fixed command string through the shell (needed for npm.cmd on Windows). */
export function runShell(command, { cwd, onLine, timeoutMs = 10 * 60 * 1000, env, signal } = {}) {
  return execute(command, [], true, { cwd, onLine, timeoutMs, env, signal });
}

/**
 * Run a command line with bash — the shell the Agent SDK sessions use for
 * their Bash tool (Git Bash on Windows). A planning session tests its `check`
 * with that tool, so the board must run it with the same shell: on Windows
 * `runShell()` is cmd.exe, where `CI=1 npx …` is "'CI' is not recognized"
 * (2026-09-28, five failed checks in a row). And on POSIX it is bash, not
 * `/bin/sh`: on Debian that is dash, a second dialect again.
 *
 * - POSIX: `bash -c`. Only if bash cannot be spawned at all (ENOENT) does it
 *   fall back to runShell() (`/bin/sh -c`) — better a POSIX sh than nothing.
 * - Windows: Git Bash's `bash.exe -c`, argv passed straight (no cmd quoting
 *   pass). If Git Bash cannot be found it fails with a clear message; it
 *   never falls back to cmd, which is exactly the bug this exists to avoid.
 *
 * Known gap, shared with runShell(): on Windows a timeout or abort kills only
 * the direct child (bash), so grandchildren (npx, playwright) can outlive it.
 *
 * Same contract as run(): never rejects, same `code` meanings. `platform` and
 * `findBash` exist for tests only.
 */
export async function runPosixShell(command, {
  cwd, onLine, timeoutMs = 10 * 60 * 1000, env, signal,
  platform = process.platform, findBash = resolveGitBash,
} = {}) {
  const opts = { cwd, onLine, timeoutMs, env, signal };
  if (platform !== 'win32') {
    const r = await run('bash', ['-c', command], opts);
    if (r.code === -1 && /ENOENT/.test(r.stderr)) return runShell(command, opts);
    return r;
  }
  const bash = findBash();
  if (!bash) return { ok: false, code: -1, stdout: '', stderr: gitBashMissing() };
  return run(bash, ['-c', command], opts);
}

let gitBashCache = null;

/** Tests only: forget the Git Bash found by an earlier call. */
export function _resetGitBashCache() { gitBashCache = null; }

/**
 * Where Git Bash's `bash.exe` is, or null. Windows only in practice; the
 * arguments are injectable so tests can run anywhere. The real lookup (no
 * injected arguments) is cached after its first success; a failure is retried,
 * so installing Git fixes it without a restart.
 *
 * Order: `CLAUDE_CODE_GIT_BASH_PATH` (the variable Claude Code itself honours,
 * so the board and the sessions agree), then the Git install that owns the
 * `git.exe` on PATH, then the two default install locations.
 *
 * Never a bare `bash` from PATH: on Windows that is usually
 * `C:\Windows\System32\bash.exe`, WSL — another OS and filesystem. Anything
 * under the Windows directory is rejected, whichever step proposed it.
 * `<root>\bin\bash.exe` is the launcher that sets up PATH for the MSYS tools;
 * `usr\bin\bash.exe` is only used if the variable names it.
 */
export function resolveGitBash({ env = process.env, exists = existsSync, whereGit } = {}) {
  const real = env === process.env && exists === existsSync && !whereGit;
  if (real && gitBashCache) return gitBashCache;
  const win = path.win32;
  // With neither variable set, still assume the usual location: a missing
  // SystemRoot must not let WSL's System32\bash.exe through.
  const declared = [env.SystemRoot, env.windir, env.SYSTEMROOT, env.WINDIR].filter(Boolean);
  const windowsDirs = (declared.length ? declared : ['C:\\Windows'])
    .map((d) => win.resolve(d).toLowerCase());
  const underWindows = (p) => {
    const full = win.resolve(p).toLowerCase();
    return windowsDirs.some((d) => full === d || full.startsWith(d + '\\'));
  };
  const ok = (p) => Boolean(p) && !underWindows(p) && exists(p);

  const candidates = [];
  if (env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(env.CLAUDE_CODE_GIT_BASH_PATH);
  const git = whereGit ? whereGit() : findGitOnPath(env, exists);
  const root = git ? gitRoot(git) : null;
  if (root) candidates.push(win.join(root, 'bin', 'bash.exe'));
  candidates.push('C:\\Program Files\\Git\\bin\\bash.exe');
  if (env.LOCALAPPDATA) candidates.push(win.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));

  const found = candidates.find(ok) ?? null;
  if (found && real) gitBashCache = found;
  return found;
}

/** The first `git.exe` in PATH, scanned synchronously (no `where` child). */
function findGitOnPath(env, exists) {
  const raw = env.PATH ?? env.Path ?? '';
  for (let dir of raw.split(';')) {
    dir = dir.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
    if (!dir) continue;
    const p = path.win32.join(dir, 'git.exe');
    if (exists(p)) return p;
  }
  return null;
}

/** Git for Windows' root from its git.exe: `cmd\`, `bin\` or `mingw64\bin\`. */
function gitRoot(gitExe) {
  const win = path.win32;
  const dir = win.dirname(gitExe);
  const parent = win.dirname(dir);
  const leaf = win.basename(dir).toLowerCase();
  if (leaf === 'bin' && win.basename(parent).toLowerCase() === 'mingw64') return win.dirname(parent);
  if (leaf === 'cmd' || leaf === 'bin') return parent;
  return null;
}

function gitBashMissing() {
  return 'no se encontró Git Bash (bash.exe), y el check no se ejecuta con cmd: se escribió para bash. '
    + 'Se buscó en CLAUDE_CODE_GIT_BASH_PATH, junto al git.exe del PATH (<raíz>\\bin\\bash.exe), '
    + 'en C:\\Program Files\\Git\\bin\\bash.exe y en %LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe. '
    + 'Instala Git for Windows o define CLAUDE_CODE_GIT_BASH_PATH con la ruta completa de bash.exe.';
}

function execute(fileOrCmd, args, shell, { cwd, onLine, timeoutMs, env, signal }) {
  return new Promise((resolve) => {
    const posix = process.platform !== 'win32';
    // `env` is what the caller adds, over the environment of the machine the
    // command runs on — never a replacement. A board on one machine cannot
    // hand its own PATH and HOME to a command on another.
    const child = spawn(fileOrCmd, args, {
      cwd,
      shell,
      env: env ? { ...process.env, ...env } : process.env,
      windowsHide: true,
      // Nothing that runs through here ever writes to a child's stdin — an
      // inherited pipe left open is nobody's input. Most commands never
      // notice; `opencode run` on Windows does, and hangs forever waiting on
      // it instead of reading from a non-interactive `--auto` run (found
      // 2026-09-22, reproduced with a minimal spawn() outside this file).
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so a kill reaches whatever the command itself
      // spawned (`sh -c '…; sleep'`, the `cargo test` under `opencode run`).
      // Windows keeps killing the direct child only. Side effect: a runner
      // started by hand from a terminal no longer forwards Ctrl-C to running
      // children (the systemd unit is unaffected).
      detached: posix,
    });

    let out = '';
    let err = '';
    let ended = null; // 'timeout' | 'abort'
    const kill = () => {
      try { if (posix && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    };
    // Whichever ends it first names the outcome: an abort whose child is slow
    // to close must not be reported as a timeout.
    const timer = setTimeout(() => { if (!ended) { ended = 'timeout'; kill(); } }, timeoutMs);
    // Not spawn()'s own `signal` option: it kills only the direct child and
    // emits an 'error' right away, resolving before the child is dead.
    const onAbort = () => { if (!ended) { ended = 'abort'; kill(); } };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const feed = (buf, sink) => {
      const text = buf.toString('utf8');
      if (sink === 'out') out += text; else err += text;
      if (onLine) {
        for (const line of text.split(/\r?\n/)) {
          const clean = stripAnsi(line).trimEnd();
          if (clean) onLine(clean);
        }
      }
    };

    child.stdout.on('data', (b) => feed(b, 'out'));
    child.stderr.on('data', (b) => feed(b, 'err'));
    child.on('error', (e) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ ok: false, code: -1, stdout: out, stderr: `${err}\n${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        ok: !ended && code === 0,
        code: ended === 'timeout' ? -2 : ended === 'abort' ? -3 : code,
        stdout: out,
        stderr: ended === 'timeout' ? `${err}\n[timeout after ${timeoutMs}ms]`
          : ended === 'abort' ? `${err}\n[aborted by the caller]`
          : err,
      });
    });
  });
}

export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Counting semaphore whose limit is read on every check, so raising the
 * dashboard's parallelism releases whoever is already waiting.
 */
export class Semaphore {
  #active = 0;
  #waiters = [];
  #limitFn;

  constructor(limitFn) {
    this.#limitFn = limitFn;
  }

  get active() { return this.#active; }
  get waiting() { return this.#waiters.length; }
  get limit() { return this.#limitFn(); }

  /** Runs `fn` once a slot is free, always giving the slot back. */
  async run(fn) {
    await this.#acquire();
    try {
      return await fn();
    } finally {
      this.#active--;
      this.#drain();
    }
  }

  /** Call after the limit changes, to let newly-allowed waiters through. */
  refresh() {
    this.#drain();
  }

  #acquire() {
    if (this.#active < this.#limitFn()) {
      this.#active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  // The slot is taken here, before waking the waiter, so two wake-ups can never
  // hand out the same slot.
  #drain() {
    while (this.#waiters.length && this.#active < this.#limitFn()) {
      this.#active++;
      this.#waiters.shift()();
    }
  }
}

/** Serialize async work per key (used for the per-task chat). */
export class Mutex {
  #chains = new Map();
  runExclusive(key, fn) {
    const prev = this.#chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.#chains.set(key, next.catch(() => {}));
    return next;
  }
  isBusy(key) {
    return this.#chains.has(key);
  }
}
