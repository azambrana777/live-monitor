import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTreeReported } from './teardown.mjs';

/**
 * upgrade.ps1, start.ps1 and stop.ps1 run for real, but inside a throwaway
 * copy of the repo, with fakes for everything that would touch the machine:
 *
 * - `tools\npm.cmd` runs `fake-npm.mjs`, which rewrites the sandbox's
 *   package.json / package-lock.json like npm would and drops or deletes the
 *   SDK's native `claude.exe` as `tools\scenario.json` says for each install.
 * - `claude.exe` (both the SDK's and the PATH one) is a tiny C# program built
 *   once with the .NET Framework csc: `--version` prints the `claude.version`
 *   file next to it, `install <v>` writes that file. With a
 *   `claude.install-hang` file next to it, `install` turns into the one that
 *   was killed on 2026-09-24: it leaves that file's bytes as
 *   `~\.local\share\claude\versions\<v>`, writes its own pid to
 *   `claude.hang-pid` and then never returns. `claude.install-half` is the
 *   same leftover, but the install exits 1 instead of hanging.
 * - The board is the sandbox's `server\src\index.js`, a stub HTTP server that
 *   the real start.ps1 launches and that answers `/api/upgrade`; the board
 *   being upgraded is a plain node process listening on the same port.
 * - `origin` is a bare repo next to the sandbox; a `pre-push` hook that sleeps
 *   makes the push hang.
 *
 * `tools` goes first on PATH, `~\.local\bin` is removed from it and HOME /
 * USERPROFILE point into the sandbox, so neither the real npm nor the real
 * claude can be reached. stop.ps1's port sweep gets an empty range (1..0):
 * its real range holds the live board's stacks.
 */

const WIN = process.platform === 'win32';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SANDBOX_ROOT = process.env.HFSMON_UPGRADE_SANDBOX || path.join(os.tmpdir(), 'hfsmon-upgrade-sandbox');
const JOB_ID = 'u-test1';
const SDK = '@anthropic-ai/claude-agent-sdk';
const BIN_PKG = '@anthropic-ai/claude-agent-sdk-win32-x64';
const FILES = ['remote/bootstrap.sh', 'server/package-lock.json', 'server/package.json'];
const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const SKIP = !WIN ? 'solo Windows'
  : !fs.existsSync(CSC) ? `falta ${CSC}, que compila el claude.exe falso` : false;

const BOOTSTRAP = [
  '#!/usr/bin/env bash',
  '# Sandbox copy of remote/bootstrap.sh — only the default below matters.',
  'set -euo pipefail',
  'CLAUDE_VERSION_WANTED="${CLAUDE_VERSION_WANTED:-2.1.272}"',
  "say()  { printf '✔ %s\\n' \"$*\"; }",
  "warn() { printf '⚠ %s\\n' \"$*\"; }",
  '[ "$have" = "$CLAUDE_VERSION_WANTED" ] || warn "claude is $have — the board refuses remote tasks"',
  '',
].join('\n');

const FAKE_CLAUDE_CS = `
using System;
using System.IO;
class FakeClaude {
  static int Main(string[] a) {
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    string vf = Path.Combine(dir, "claude.version");
    if (a.Length > 0 && a[0] == "--version") {
      if (!File.Exists(vf)) { Console.Error.WriteLine("no version"); return 1; }
      Console.WriteLine(File.ReadAllText(vf).Trim() + " (Claude Code)");
      return 0;
    }
    if (a.Length > 1 && a[0] == "install") {
      File.AppendAllText(Path.Combine(dir, "claude.calls"), string.Join(" ", a) + "\\n");
      string hang = Path.Combine(dir, "claude.install-hang");
      string half = Path.Combine(dir, "claude.install-half");
      string leave = File.Exists(hang) ? hang : (File.Exists(half) ? half : null);
      if (leave != null) {
        string vdir = Path.Combine(Environment.GetEnvironmentVariable("USERPROFILE"), ".local/share/claude/versions");
        Directory.CreateDirectory(vdir);
        File.WriteAllText(Path.Combine(vdir, a[1]), File.ReadAllText(leave));
        if (leave == half) { Console.Error.WriteLine("install died halfway"); return 1; }
        File.WriteAllText(Path.Combine(dir, "claude.hang-pid"), System.Diagnostics.Process.GetCurrentProcess().Id.ToString());
        System.Threading.Thread.Sleep(600000);
        return 0;
      }
      if (File.Exists(Path.Combine(dir, "claude.install-fail"))) { Console.Error.WriteLine("install failed"); return 1; }
      File.WriteAllText(vf, a[1]);
      Console.WriteLine("Claude Code " + a[1] + " installed");
      return 0;
    }
    return 2;
  }
}
`;

const FAKE_NPM = `
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(path.join(here, 'scenario.json'), 'utf8'));
fs.appendFileSync(path.join(here, 'npm-calls.log'), JSON.stringify(argv) + '\\n');
// scenario.buildExit makes \`npm run build\` fail.
if (argv[0] === 'run') process.exit(scenario.buildExit ?? 0);
// scenario.ciExit makes npm ci (the install start.ps1 does) fail.
if (argv[0] === 'ci') process.exit(scenario.ciExit ?? 0);
if (argv[0] !== 'install') process.exit(0);

const n = fs.readFileSync(path.join(here, 'npm-calls.log'), 'utf8').split('\\n')
  .filter(Boolean).filter((l) => JSON.parse(l)[0] === 'install').length;
const pick = (list, fallback) => (list?.length ? list[Math.min(n, list.length) - 1] : fallback);
const at = argv.indexOf('--prefix');
const prefix = path.resolve(at >= 0 ? argv[at + 1] : '.');
const specs = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--prefix');

const pkgFile = path.join(prefix, 'package.json');
const lockFile = path.join(prefix, 'package-lock.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
let sdk = null;
for (const s of specs) {
  const m = /^(@anthropic-ai\\/claude-agent-sdk(?:-win32-x64)?)@(\\d+\\.\\d+\\.\\d+)$/.exec(s);
  if (!m) continue;
  sdk = m[2];
  if (m[1] === '${SDK}' && !argv.includes('--no-save')) {
    pkg.dependencies['${SDK}'] = '^' + sdk;
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\\n');
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    lock.packages[''].dependencies['${SDK}'] = '^' + sdk;
    lock.packages['node_modules/${SDK}'].version = sdk;
    fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\\n');
  }
}
const want = sdk ?? pkg.dependencies['${SDK}'].replace(/^\\^/, '');
const binDir = path.join(prefix, 'node_modules', ...'${BIN_PKG}'.split('/'));
if (pick(scenario.binary, true)) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(scenario.fakeClaude, path.join(binDir, 'claude.exe'));
  fs.writeFileSync(path.join(binDir, 'claude.version'), scenario.versions?.[n - 1] ?? '2.1.' + want.split('.')[2]);
  console.log('added 1 package (fake npm, install #' + n + ')');
} else {
  fs.rmSync(path.join(binDir, 'claude.exe'), { force: true });
  console.log('added 1 package, native binary skipped (fake npm, install #' + n + ')');
}
process.exit(pick(scenario.exit, 0));
`;

const FAKE_BOARD = `
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const hosts = path.join(root, 'server', 'data', 'fake-board-hosts.log');
// Proves the environment reached the board.
try { fs.mkdirSync(path.dirname(hosts), { recursive: true }); fs.writeFileSync(path.join(path.dirname(hosts), 'fake-board-env.txt'), String(process.env.FAKEBOARD_PROBE)); } catch {}
// The names scriptEnv strips must be absent; the dump is one name per line.
try { fs.writeFileSync(path.join(path.dirname(hosts), 'fake-board-envnames.txt'), Object.keys(process.env).join('\\n')); } catch {}
http.createServer((req, res) => {
  try { fs.mkdirSync(path.dirname(hosts), { recursive: true }); fs.appendFileSync(hosts, req.headers.host + ' ' + req.url + '\\n'); } catch {}
  if (req.url.startsWith('/api/upgrade')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"job":null}');
    return;
  }
  res.writeHead(404);
  res.end();
// fakeBoardSilent: the board starts but never answers on its port.
}).listen(cfg.fakeBoardSilent ? 0 : cfg.port, '127.0.0.1');
`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(fn, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await delay(250);
  }
}

async function answers(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/upgrade`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

let fakeClaudeExe;
function buildFakeClaude() {
  const hash = createHash('sha1').update(FAKE_CLAUDE_CS).digest('hex').slice(0, 10);
  const dir = path.join(SANDBOX_ROOT, '_bin');
  const exe = path.join(dir, `fake-claude-${hash}.exe`);
  if (fs.existsSync(exe)) return exe;
  fs.mkdirSync(dir, { recursive: true });
  const cs = path.join(dir, `fake-claude-${hash}.cs`);
  fs.writeFileSync(cs, FAKE_CLAUDE_CS);
  execFileSync(CSC, ['/nologo', '/target:exe', `/out:${exe}`, cs], { stdio: 'pipe' });
  return exe;
}

function git(cwd, env, ...args) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function makeSandbox(name, { binary = [true], versions = null, pushHang = false, boardSilent = false } = {}) {
  const dir = path.join(SANDBOX_ROOT, `${Date.now().toString(36)}-${name}`);
  const repo = path.join(dir, 'repo');
  const tools = path.join(dir, 'tools');
  const home = path.join(dir, 'home');
  const remote = path.join(dir, 'remote.git');
  for (const d of [repo, tools, home, path.join(repo, 'server', 'src'), path.join(repo, 'server', 'data'),
    path.join(repo, 'remote'), path.join(repo, 'web', 'node_modules')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const port = await freePort();
  const ctx = { dir, repo, tools, home, remote, port, children: [] };

  for (const f of ['upgrade.ps1', 'start.ps1', 'stop.ps1']) fs.copyFileSync(path.join(REPO, f), path.join(repo, f));
  writeJson(path.join(repo, 'config.json'), boardSilent ? { port, fakeBoardSilent: true } : { port });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\nserver/data/\n.hfs-monitor.pid\n.hfs-monitor.upgrading\n*.log\n');
  writeJson(path.join(repo, 'server', 'package.json'), { name: 'fake-server', version: '1.0.0', dependencies: { [SDK]: '^0.3.272' } });
  writeJson(path.join(repo, 'server', 'package-lock.json'), {
    name: 'fake-server', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'fake-server', version: '1.0.0', dependencies: { [SDK]: '^0.3.272' } }, [`node_modules/${SDK}`]: { version: '0.3.272' } },
  });
  fs.writeFileSync(path.join(repo, 'server', 'src', 'index.js'), FAKE_BOARD);
  fs.writeFileSync(path.join(repo, 'remote', 'bootstrap.sh'), BOOTSTRAP);
  const binDir = path.join(repo, 'server', 'node_modules', ...BIN_PKG.split('/'));
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(fakeClaudeExe, path.join(binDir, 'claude.exe'));
  fs.writeFileSync(path.join(binDir, 'claude.version'), '2.1.272');

  fs.writeFileSync(path.join(tools, 'npm.cmd'), '@echo off\r\nnode "%~dp0fake-npm.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n');
  fs.writeFileSync(path.join(tools, 'fake-npm.mjs'), FAKE_NPM);
  writeJson(path.join(tools, 'scenario.json'), { binary, versions, fakeClaude: fakeClaudeExe });
  fs.copyFileSync(fakeClaudeExe, path.join(tools, 'claude.exe'));
  fs.writeFileSync(path.join(tools, 'claude.version'), '2.1.272');

  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(npm_|GIT_|CLAUDE|ANTHROPIC_|HFSMON_)/i.test(k) || /^INIT_CWD$/i.test(k)) continue;
    env[k] = v;
  }
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
  const parts = (env[pathKey] ?? '').split(';').filter((p) => p && !/\\\.local\\bin\\?$/i.test(p));
  env[pathKey] = [tools, ...parts].join(';');
  env.USERPROFILE = home;
  env.HOME = home;
  ctx.env = env;

  git(repo, env, 'init', '-q', '-b', 'main');
  git(repo, env, 'config', 'user.name', 'Sandbox');
  git(repo, env, 'config', 'user.email', 'sandbox@example.invalid');
  git(repo, env, 'config', 'commit.gpgsign', 'false');
  git(repo, env, 'add', '-A');
  git(repo, env, 'commit', '-q', '-m', 'init');
  git(dir, env, 'init', '-q', '--bare', remote);
  git(repo, env, 'remote', 'add', 'origin', remote);
  git(repo, env, 'push', '-q', '-u', 'origin', 'main');
  if (pushHang) fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nsleep 60\n');
  return ctx;
}

function spawnNode(ctx, args) {
  const child = spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true });
  ctx.children.push(child);
  return child;
}

async function cleanup(ctx) {
  for (const c of ctx.children) {
    try { c.kill(); } catch { /* already gone */ }
  }
  try {
    const pid = Number.parseInt(fs.readFileSync(path.join(ctx.repo, '.hfs-monitor.pid'), 'utf8'), 10);
    if (pid) process.kill(pid);
  } catch { /* no board left */ }
  await delay(300);
  // A killed hook may still hold a handle; the next run uses a new folder.
  await removeTreeReported('upgrade-ps1', ctx.dir, { tolerate: true, timeoutMs: 3000 });
}

function runPs(ctx, script, args = [], timeoutMs = 240_000) {
  return new Promise((resolve, reject) => {
    // A file, not a pipe. start.ps1 no longer lets the board inherit the caller's
    // handles (runPsPiped and its test prove that), but upgrade.ps1 still runs
    // start.ps1 with files and the old boards some tests spawn hold their own
    // handles; a file also keeps the whole output when the script is killed.
    const outFile = path.join(ctx.dir, `${script}-${Date.now().toString(36)}.out`);
    const fd = fs.openSync(outFile, 'w');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ctx.repo, script), ...args],
      { cwd: ctx.repo, env: ctx.env, stdio: ['ignore', fd, fd], windowsHide: true });
    fs.closeSync(fd);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${script} did not finish in ${timeoutMs} ms`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output: fs.readFileSync(outFile, 'utf8') });
    });
  });
}

/**
 * Runs a script with PIPED stdout/stderr, as `npm run start | cat` or a node
 * `spawn` would. `exit` and `close` are timed separately: `close` (EOF on both
 * pipes) only arrives when nothing the script launched still holds them.
 * On timeout the board is killed by the pid file BEFORE returning, or the pipes
 * would stay open.
 */
function runPsPiped(ctx, script, args = [], { env = ctx.env, closeTimeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ctx.repo, script), ...args],
      { cwd: ctx.repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    let exitCode = null;
    let exitMs = null;
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => {
      try {
        const pid = Number.parseInt(fs.readFileSync(path.join(ctx.repo, '.hfs-monitor.pid'), 'utf8'), 10);
        if (pid) process.kill(pid);
      } catch { /* no board */ }
      try { child.kill(); } catch { /* gone */ }
      resolve({ closed: false, code: exitCode, exitMs, closeMs: null, output });
    }, closeTimeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { exitCode = code; exitMs = Date.now() - t0; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ closed: true, code: exitCode ?? code, exitMs, closeMs: Date.now() - t0, output });
    });
  });
}

const boardPid = (ctx) => Number.parseInt(fs.readFileSync(path.join(ctx.repo, '.hfs-monitor.pid'), 'utf8'), 10);

function writeJob(ctx, boardPid, over = {}) {
  const at = new Date().toISOString();
  writeJson(path.join(ctx.repo, 'server', 'data', 'upgrade.json'), {
    id: JOB_ID, state: 'laptop',
    target: { sdk: '0.3.273', cli: '2.1.273' },
    previous: { sdk: '0.3.272', cli: '2.1.272', laptopCli: '2.1.272' },
    onlyLaptop: false, force: false, requestedAt: at, startedAt: at, endedAt: null,
    step: 'laptop_launch',
    steps: [
      { name: 'runner_check', state: 'ok', detail: 'runner-1', at },
      { name: 'laptop_launch', state: 'running', detail: '', at },
    ],
    failedStep: null, error: null, runners: {},
    laptop: { commit: null, pushed: null, pushError: null, rolledBack: false },
    scriptPid: null, boardPid, logTail: [], acknowledged: false,
    ...over,
  });
}

const jobPath = (ctx) => path.join(ctx.repo, 'server', 'data', 'upgrade.json');
const readJob = (ctx) => JSON.parse(fs.readFileSync(jobPath(ctx), 'utf8').replace(/^\uFEFF/, ''));
const stepStates = (job) => Object.fromEntries(job.steps.map((s) => [s.name, s.state]));
const npmInstalls = (ctx) => fs.readFileSync(path.join(ctx.tools, 'npm-calls.log'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] === 'install');
const sdkBinVersion = (ctx) => fs.readFileSync(path.join(ctx.repo, 'server', 'node_modules', ...BIN_PKG.split('/'), 'claude.version'), 'utf8').trim();
const readRepo = (ctx, rel) => fs.readFileSync(path.join(ctx.repo, rel));
const stepDetail = (job, name) => job.steps.find((s) => s.name === name).detail;
/** Every `install` the PATH claude ran; the file only exists once it ran one. */
const claudeInstalls = (ctx) => {
  const file = path.join(ctx.tools, 'claude.calls');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
};
const pathCliVersion = (ctx) => fs.readFileSync(path.join(ctx.tools, 'claude.version'), 'utf8').trim();
/** Where the native installer keeps its binaries, inside the sandbox's home. */
const cliVersionFile = (ctx, v) => path.join(ctx.home, '.local', 'share', 'claude', 'versions', v);
/** Makes the next `install` hang, leaving `partial` (may be empty) as the version file. */
const hangNextInstall = (ctx, partial) => fs.writeFileSync(path.join(ctx.tools, 'claude.install-hang'), partial);
/** The same leftover, but the install exits 1 instead of hanging. */
const failNextInstall = (ctx, partial) => fs.writeFileSync(path.join(ctx.tools, 'claude.install-half'), partial);
/** The pid the hanging `install` ran under, so a test can see it was killed. */
const hangPid = (ctx) => {
  const pid = Number.parseInt(fs.readFileSync(path.join(ctx.tools, 'claude.hang-pid'), 'utf8').trim(), 10);
  assert.ok(pid > 0, 'el install colgado dejo su pid');
  return pid;
};
/** Milliseconds between two steps: laptop_verify ends where laptop_cli begins. */
const stepGapMs = (job, from, to) =>
  Date.parse(job.steps.find((s) => s.name === to).at) - Date.parse(job.steps.find((s) => s.name === from).at);

/** The board being upgraded: listens on the port and exits on its own, or never (`exitAfterMs` 0). */
async function startOldBoard(ctx, exitAfterMs) {
  const code = `require('http').createServer((q, s) => s.end('old')).listen(${ctx.port}, '127.0.0.1');`
    + (exitAfterMs ? `setTimeout(() => process.exit(0), ${exitAfterMs});` : '');
  const board = spawnNode(ctx, ['-e', code]);
  assert.ok(await waitFor(() => answers(ctx.port), 5000), 'the old board listens');
  return board;
}

async function runUpgrade(ctx, { exitAfterMs = 800, extra = [], job = {}, startWaitSec = 30 } = {}) {
  const board = await startOldBoard(ctx, exitAfterMs);
  fs.writeFileSync(path.join(ctx.repo, '.hfs-monitor.pid'), `${board.pid}\r\n`);
  writeJob(ctx, board.pid, job);
  const res = await runPs(ctx, 'upgrade.ps1', [
    '-BoardPid', String(board.pid), '-JobId', JOB_ID, '-Root', ctx.repo, '-Port', String(ctx.port),
    '-SweepPortFrom', '1', '-SweepPortTo', '0', '-PortFreeSec', '10', '-GuardWaitSec', '2', '-StartWaitSec', String(startWaitSec),
    ...extra,
  ]);
  return { res, board };
}

describe('upgrade.ps1 en un repo de prueba', { skip: SKIP, timeout: 1_200_000 }, () => {
  before(async () => {
    fs.mkdirSync(SANDBOX_ROOT, { recursive: true });
    // Folders an earlier run could not delete (a killed hook still held a handle).
    // One that is still locked must not fail the hook, and with it the whole describe.
    for (const name of fs.readdirSync(SANDBOX_ROOT)) {
      const full = path.join(SANDBOX_ROOT, name);
      if (name === '_bin' || !fs.statSync(full).isDirectory()) continue;
      if (Date.now() - fs.statSync(full).mtimeMs > 60 * 60_000) {
        await removeTreeReported('upgrade-ps1 sweep', full, { tolerate: true, timeoutMs: 1000 });
      }
    }
    fakeClaudeExe = buildFakeClaude();
  });

  test('camino feliz: instala, verifica, salta el CLI del PATH, edita bootstrap.sh, hace commit y push, y arranca el tablero', async () => {
    const ctx = await makeSandbox('happy');
    try {
      const headBefore = git(ctx.repo, ctx.env, 'rev-parse', 'HEAD');
      const { res } = await runUpgrade(ctx);
      const job = readJob(ctx);
      assert.equal(res.code, 0, res.output);
      assert.equal(job.state, 'done', res.output);
      assert.equal(job.failedStep, null);
      assert.equal(job.error, null);
      assert.equal(job.step, null);
      assert.match(job.endedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.equal(typeof job.scriptPid, 'number');
      assert.deepEqual(job.steps.map((s) => [s.name, s.state]), [
        ['runner_check', 'ok'], ['laptop_launch', 'ok'],
        ['laptop_stop', 'ok'], ['laptop_guard', 'ok'], ['laptop_install', 'ok'], ['laptop_verify', 'ok'],
        ['laptop_cli', 'skipped'], ['laptop_bootstrap', 'ok'], ['laptop_commit', 'ok'], ['laptop_push', 'ok'], ['laptop_start', 'ok'],
      ]);

      const head = git(ctx.repo, ctx.env, 'rev-parse', 'HEAD');
      assert.notEqual(head, headBefore);
      assert.deepEqual(job.laptop, { commit: head, pushed: true, pushError: null, rolledBack: false });
      assert.equal(git(ctx.repo, ctx.env, 'log', '-1', '--format=%B'), 'Move to Claude Agent SDK 0.3.273 and CLI 2.1.273');
      assert.deepEqual(git(ctx.repo, ctx.env, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), FILES);
      assert.equal(git(ctx.repo, ctx.env, 'status', '--porcelain', '--', ...FILES), '');
      assert.equal(git(ctx.dir, ctx.env, '--git-dir', ctx.remote, 'rev-parse', 'main'), head);

      // Only the default moved: the ✔, the em dashes and the LF endings are intact.
      assert.deepEqual(readRepo(ctx, 'remote/bootstrap.sh'), Buffer.from(BOOTSTRAP.replace(':-2.1.272', ':-2.1.273'), 'utf8'));
      assert.equal(JSON.parse(readRepo(ctx, 'server/package.json')).dependencies[SDK], '^0.3.273');
      assert.equal(sdkBinVersion(ctx), '2.1.273');
      // No updatePathCli in the job: the claude a person has open is not touched.
      assert.match(stepDetail(job, 'laptop_cli'), /the job did not ask for the PATH claude to move to 2\.1\.273/);
      assert.deepEqual(claudeInstalls(ctx), []);
      assert.equal(pathCliVersion(ctx), '2.1.272');

      assert.equal(fs.existsSync(path.join(ctx.repo, '.hfs-monitor.upgrading')), false);
      assert.ok(job.logTail.length > 0 && job.logTail.length <= 40);
      assert.ok(job.logTail.every((l) => /^\d{4}-\d\d-\d\dT\S+Z /.test(l)));
      assert.ok(fs.existsSync(path.join(ctx.repo, 'server', 'data', 'upgrade', `${JOB_ID}.log`)));
      const hosts = fs.readFileSync(path.join(ctx.repo, 'server', 'data', 'fake-board-hosts.log'), 'utf8');
      assert.match(hosts, /^127\.0\.0\.1 \/api\/upgrade$/m);
      assert.ok(await answers(ctx.port));
    } finally {
      await cleanup(ctx);
    }
  });

  test('con updatePathCli el paso corre como siempre: instala y sube el claude del PATH', async () => {
    const ctx = await makeSandbox('cli-on');
    try {
      const { res } = await runUpgrade(ctx, { job: { updatePathCli: true } });
      const job = readJob(ctx);
      assert.equal(res.code, 0, res.output);
      assert.equal(job.state, 'done', res.output);
      assert.equal(stepStates(job).laptop_cli, 'ok');
      assert.equal(stepDetail(job, 'laptop_cli'), 'PATH claude 2.1.272 -> 2.1.273');
      assert.deepEqual(claudeInstalls(ctx), ['install 2.1.273']);
      assert.equal(pathCliVersion(ctx), '2.1.273');
      assert.ok(await answers(ctx.port));
    } finally {
      await cleanup(ctx);
    }
  });

  test('un claude install matado a mitad avisa y barre el archivo de 0 bytes que dejo', async () => {
    const ctx = await makeSandbox('cli-hang');
    try {
      hangNextInstall(ctx, '');
      // A finished install from before: it has bytes, so nothing may touch it.
      fs.mkdirSync(path.dirname(cliVersionFile(ctx, '2.1.270')), { recursive: true });
      fs.writeFileSync(cliVersionFile(ctx, '2.1.270'), 'a whole binary');
      const { res } = await runUpgrade(ctx, { job: { updatePathCli: true }, extra: ['-ClaudeInstallTimeoutMs', '4000'] });
      const job = readJob(ctx);
      assert.equal(res.code, 0, res.output);
      assert.equal(job.state, 'done', res.output);
      assert.equal(stepStates(job).laptop_cli, 'warn');
      assert.deepEqual(claudeInstalls(ctx), ['install 2.1.273']);
      assert.match(stepDetail(job, 'laptop_cli'), /timed out after 4 s/);
      assert.match(stepDetail(job, 'laptop_cli'), /removed the 0-byte .*2\.1\.273/);
      assert.equal(fs.existsSync(cliVersionFile(ctx, '2.1.273')), false);
      assert.equal(fs.readFileSync(cliVersionFile(ctx, '2.1.270'), 'utf8'), 'a whole binary');
      assert.equal(pathCliVersion(ctx), '2.1.272');
      // The install was stopped, not merely waited out: its pid is gone and the
      // step lasted seconds, not the ten minutes the fake would have slept.
      assert.equal(alive(hangPid(ctx)), false, 'Stop-OwnTree mato el install colgado');
      assert.ok(stepGapMs(job, 'laptop_verify', 'laptop_cli') < 30_000, 'laptop_cli duro menos de 30 s');
      assert.ok(await answers(ctx.port));
    } finally {
      await cleanup(ctx);
    }
  });

  test('un install que sale con error y deja el archivo vacio se barre igual', async () => {
    const ctx = await makeSandbox('cli-fail');
    try {
      failNextInstall(ctx, '');
      const { res } = await runUpgrade(ctx, { job: { updatePathCli: true } });
      const job = readJob(ctx);
      assert.equal(res.code, 0, res.output);
      assert.equal(job.state, 'done', res.output);
      assert.equal(stepStates(job).laptop_cli, 'warn');
      assert.deepEqual(claudeInstalls(ctx), ['install 2.1.273']);
      assert.match(stepDetail(job, 'laptop_cli'), /exited 1/);
      assert.match(stepDetail(job, 'laptop_cli'), /removed the 0-byte .*2\.1\.273/);
      assert.equal(fs.existsSync(cliVersionFile(ctx, '2.1.273')), false);
      assert.equal(pathCliVersion(ctx), '2.1.272');
      assert.ok(await answers(ctx.port));
    } finally {
      await cleanup(ctx);
    }
  });

  test('un install matado que si escribio bytes se deja como esta', async () => {
    const ctx = await makeSandbox('cli-hang-bytes');
    try {
      hangNextInstall(ctx, 'half a binary');
      const { res } = await runUpgrade(ctx, { job: { updatePathCli: true }, extra: ['-ClaudeInstallTimeoutMs', '4000'] });
      const job = readJob(ctx);
      assert.equal(res.code, 0, res.output);
      assert.equal(job.state, 'done', res.output);
      assert.equal(stepStates(job).laptop_cli, 'warn');
      assert.match(stepDetail(job, 'laptop_cli'), /timed out after 4 s/);
      assert.doesNotMatch(stepDetail(job, 'laptop_cli'), /removed/);
      assert.match(stepDetail(job, 'laptop_cli'), /left the 13-byte .*2\.1\.273 behind/);
      assert.equal(fs.readFileSync(cliVersionFile(ctx, '2.1.273'), 'utf8'), 'half a binary');
      assert.equal(pathCliVersion(ctx), '2.1.272');
      assert.equal(alive(hangPid(ctx)), false, 'Stop-OwnTree mato el install colgado');
      assert.ok(stepGapMs(job, 'laptop_verify', 'laptop_cli') < 30_000, 'laptop_cli duro menos de 30 s');
      assert.ok(await answers(ctx.port));
    } finally {
      await cleanup(ctx);
    }
  });

  test('el binario nativo que falta al primer npm install aparece al segundo', async () => {
    const ctx = await makeSandbox('second', { binary: [false, true] });
    try {
      const { res } = await runUpgrade(ctx, { job: { updatePathCli: false } });
      const job = readJob(ctx);
      assert.equal(res.code, 0, res.output);
      assert.equal(job.state, 'done', res.output);
      assert.equal(stepStates(job).laptop_verify, 'ok');
      assert.match(job.steps.find((s) => s.name === 'laptop_verify').detail, /attempt 2/);
      assert.deepEqual(npmInstalls(ctx), [
        ['install', `${SDK}@0.3.273`, '--prefix', 'server'],
        ['install', '--prefix', 'server'],
      ]);
      assert.equal(sdkBinVersion(ctx), '2.1.273');
      // updatePathCli false reads like no field at all.
      assert.equal(stepStates(job).laptop_cli, 'skipped');
      assert.match(stepDetail(job, 'laptop_cli'), /the job did not ask for the PATH claude/);
      assert.deepEqual(claudeInstalls(ctx), []);
      assert.equal(pathCliVersion(ctx), '2.1.272');
      assert.equal(job.laptop.rolledBack, false);
    } finally {
      await cleanup(ctx);
    }
  });

  test('si el binario nunca aparece, vuelve atrás, falla en laptop_verify y arranca igualmente', async () => {
    const ctx = await makeSandbox('rollback', { binary: [false, false, false, true] });
    try {
      const headBefore = git(ctx.repo, ctx.env, 'rev-parse', 'HEAD');
      const pkgBefore = readRepo(ctx, 'server/package.json');
      const { res } = await runUpgrade(ctx);
      const job = readJob(ctx);
      assert.equal(res.code, 1, res.output);
      assert.equal(job.state, 'failed', res.output);
      assert.equal(job.failedStep, 'laptop_verify');
      assert.match(job.error, /attempt 3: claude\.exe is missing/);
      assert.equal(job.laptop.rolledBack, true);
      const states = stepStates(job);
      assert.equal(states.laptop_verify, 'failed');
      assert.equal(states.laptop_rollback, 'ok');
      assert.equal(states.laptop_start, 'ok');
      assert.equal(states.laptop_commit, undefined);

      const installs = npmInstalls(ctx);
      assert.equal(installs.length, 4);
      assert.deepEqual(installs[2], ['install', '--no-save', `${BIN_PKG}@0.3.273`, '--prefix', 'server']);
      assert.deepEqual(installs[3], ['install', '--prefix', 'server']);

      assert.equal(git(ctx.repo, ctx.env, 'rev-parse', 'HEAD'), headBefore);
      assert.deepEqual(readRepo(ctx, 'server/package.json'), pkgBefore);
      assert.equal(git(ctx.repo, ctx.env, 'status', '--porcelain', '--', ...FILES), '');
      assert.equal(sdkBinVersion(ctx), '2.1.272');
      assert.equal(fs.readFileSync(path.join(ctx.tools, 'claude.version'), 'utf8').trim(), '2.1.272');
      assert.equal(fs.existsSync(path.join(ctx.repo, '.hfs-monitor.upgrading')), false);
      assert.ok(await answers(ctx.port));
    } finally {
      await cleanup(ctx);
    }
  });

  // Someone else lands a commit on origin/main while the upgrade runs.
  function pushToOrigin(ctx, name, edit) {
    const other = path.join(ctx.dir, name);
    git(ctx.dir, ctx.env, 'clone', '-q', '-b', 'main', ctx.remote, other);
    git(other, ctx.env, 'config', 'user.name', 'Other');
    git(other, ctx.env, 'config', 'user.email', 'other@example.invalid');
    git(other, ctx.env, 'config', 'commit.gpgsign', 'false');
    edit(other);
    git(other, ctx.env, 'add', '-A');
    git(other, ctx.env, 'commit', '-q', '-m', 'other work');
    git(other, ctx.env, 'push', '-q', 'origin', 'main');
  }

  test('un push rechazado porque origin/main avanzó: se integra con un merge y se reintenta', async () => {
    const ctx = await makeSandbox('pushdiverged');
    try {
      pushToOrigin(ctx, 'other-a', (dir) => fs.writeFileSync(path.join(dir, 'other.txt'), 'x'));
      const { res } = await runUpgrade(ctx);
      const job = readJob(ctx);
      assert.equal(res.code, 0, res.output);
      assert.equal(job.state, 'done', res.output);
      assert.equal(stepStates(job).laptop_push, 'ok');
      assert.equal(job.laptop.pushed, true);
      assert.equal(job.laptop.pushError, null);
      const head = git(ctx.repo, ctx.env, 'rev-parse', 'HEAD');
      assert.equal(git(ctx.dir, ctx.env, '--git-dir', ctx.remote, 'rev-parse', 'main'), head);
      assert.ok(fs.existsSync(path.join(ctx.repo, 'other.txt')), 'the other commit is now in the checkout');
      assert.equal(git(ctx.repo, ctx.env, 'log', '-1', '--format=%P').split(' ').length, 2, 'HEAD is a merge');
    } finally {
      await cleanup(ctx);
    }
  });

  test('un push rechazado cuyo merge choca: aviso claro, merge abortado y el job termina en done', async () => {
    const ctx = await makeSandbox('pushconflict');
    try {
      pushToOrigin(ctx, 'other-b', (dir) => {
        const f = path.join(dir, 'remote', 'bootstrap.sh');
        fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('2.1.272', '9.9.9'));
      });
      const remoteBefore = git(ctx.dir, ctx.env, '--git-dir', ctx.remote, 'rev-parse', 'main');
      const { res } = await runUpgrade(ctx);
      const job = readJob(ctx);
      assert.equal(res.code, 0, res.output);
      assert.equal(job.state, 'done', res.output);
      assert.equal(stepStates(job).laptop_push, 'warn');
      assert.equal(job.laptop.pushed, false);
      assert.match(job.laptop.pushError, /merging it did not apply cleanly \(merge aborted/);
      assert.equal(git(ctx.dir, ctx.env, '--git-dir', ctx.remote, 'rev-parse', 'main'), remoteBefore);
      assert.equal(job.laptop.commit, git(ctx.repo, ctx.env, 'rev-parse', 'HEAD'), 'the commit stays, no merge in progress');
      assert.equal(git(ctx.repo, ctx.env, 'status', '--porcelain', '--', ...FILES), '');
    } finally {
      await cleanup(ctx);
    }
  });

  test('un push que se cuelga se corta: aviso, y el job termina en done', async () => {
    const ctx = await makeSandbox('pushhang', { pushHang: true });
    try {
      const remoteBefore = git(ctx.dir, ctx.env, '--git-dir', ctx.remote, 'rev-parse', 'main');
      // A board that never exits by itself: laptop_stop has to Stop-Process it.
      const { res, board } = await runUpgrade(ctx, { exitAfterMs: 0, extra: ['-PushTimeoutMs', '3000', '-BoardWaitMs', '1500'] });
      const job = readJob(ctx);
      assert.equal(res.code, 0, res.output);
      assert.equal(job.state, 'done', res.output);
      assert.equal(stepStates(job).laptop_push, 'warn');
      assert.equal(job.laptop.pushed, false);
      assert.match(job.laptop.pushError, /timed out/);
      assert.equal(job.laptop.commit, git(ctx.repo, ctx.env, 'rev-parse', 'HEAD'));
      assert.equal(git(ctx.dir, ctx.env, '--git-dir', ctx.remote, 'rev-parse', 'main'), remoteBefore);
      assert.equal(alive(board.pid), false);
      assert.ok(await answers(ctx.port));
    } finally {
      await cleanup(ctx);
    }
  });

  test('laptop_guard aborta si un node corre desde server\\node_modules, sin tocar nada, y rearranca el tablero', async () => {
    const ctx = await makeSandbox('guard');
    try {
      const holdDir = path.join(ctx.repo, 'server', 'node_modules', 'fake-dev');
      fs.mkdirSync(holdDir, { recursive: true });
      fs.writeFileSync(path.join(holdDir, 'hold.js'), 'setInterval(() => {}, 1000);\n');
      const holder = spawnNode(ctx, [path.join(holdDir, 'hold.js')]);
      await delay(300);
      const headBefore = git(ctx.repo, ctx.env, 'rev-parse', 'HEAD');
      const pkgBefore = readRepo(ctx, 'server/package.json');

      const { res } = await runUpgrade(ctx);
      const job = readJob(ctx);
      assert.equal(res.code, 1, res.output);
      assert.equal(job.state, 'failed', res.output);
      assert.equal(job.failedStep, 'laptop_guard');
      assert.match(job.error, new RegExp(`node\\.exe pid ${holder.pid}`));
      assert.equal(job.laptop.rolledBack, false);
      assert.equal(stepStates(job).laptop_start, 'ok');
      assert.equal(stepStates(job).laptop_install, undefined);
      assert.deepEqual(npmInstalls(ctx), []);
      assert.equal(git(ctx.repo, ctx.env, 'rev-parse', 'HEAD'), headBefore);
      assert.deepEqual(readRepo(ctx, 'server/package.json'), pkgBefore);
      assert.ok(await answers(ctx.port));
    } finally {
      await cleanup(ctx);
    }
  });

  test('si upgrade.json no es este job en laptop, no cambia nada y solo arranca el tablero', async () => {
    const ctx = await makeSandbox('handover');
    try {
      const { res } = await runUpgrade(ctx, { job: { state: 'done' } });
      assert.equal(res.code, 1, res.output);
      assert.equal(readJob(ctx).state, 'done');
      assert.equal(readJob(ctx).steps.length, 2);
      assert.equal(fs.existsSync(path.join(ctx.tools, 'npm-calls.log'))
        ? npmInstalls(ctx).length : 0, 0);
      assert.equal(fs.existsSync(path.join(ctx.repo, '.hfs-monitor.upgrading')), false);
      assert.ok(await answers(ctx.port));
    } finally {
      await cleanup(ctx);
    }
  });

  test('un claude.exe con otra versión es un fallo: reintenta, vuelve atrás y falla en laptop_verify', async () => {
    const ctx = await makeSandbox('mismatch', { versions: ['2.1.270', '2.1.270', '2.1.270'] });
    try {
      const headBefore = git(ctx.repo, ctx.env, 'rev-parse', 'HEAD');
      const { res } = await runUpgrade(ctx);
      const job = readJob(ctx);
      assert.equal(res.code, 1, res.output);
      assert.equal(job.state, 'failed', res.output);
      assert.equal(job.failedStep, 'laptop_verify');
      assert.match(job.error, /attempt 3: claude\.exe is 2\.1\.270, expected 2\.1\.273/);
      assert.equal(npmInstalls(ctx).length, 4);
      assert.equal(job.laptop.rolledBack, true);
      assert.equal(stepStates(job).laptop_rollback, 'ok');
      assert.equal(stepStates(job).laptop_start, 'ok');
      assert.equal(sdkBinVersion(ctx), '2.1.272');
      assert.equal(git(ctx.repo, ctx.env, 'rev-parse', 'HEAD'), headBefore);
      assert.equal(git(ctx.repo, ctx.env, 'status', '--porcelain', '--', ...FILES), '');
      assert.ok(await answers(ctx.port));
    } finally {
      await cleanup(ctx);
    }
  });

  test('con la misma versión (force) no hay nada que commitear: laptop_commit skipped y el job termina en done', async () => {
    const ctx = await makeSandbox('same');
    try {
      const headBefore = git(ctx.repo, ctx.env, 'rev-parse', 'HEAD');
      const { res } = await runUpgrade(ctx, { job: { target: { sdk: '0.3.272', cli: '2.1.272' }, force: true, updatePathCli: true } });
      const job = readJob(ctx);
      assert.equal(res.code, 0, res.output);
      assert.equal(job.state, 'done', res.output);
      assert.equal(job.failedStep, null);
      const states = stepStates(job);
      assert.equal(states.laptop_install, 'ok');
      assert.equal(states.laptop_verify, 'ok');
      // The flag is on, so the step runs; it is the version that stops it.
      assert.equal(states.laptop_cli, 'skipped');
      assert.equal(stepDetail(job, 'laptop_cli'), 'PATH claude is already 2.1.272');
      assert.deepEqual(claudeInstalls(ctx), []);
      assert.equal(states.laptop_bootstrap, 'skipped');
      assert.equal(states.laptop_commit, 'skipped');
      assert.equal(states.laptop_push, 'ok');
      assert.equal(states.laptop_start, 'ok');
      assert.deepEqual(job.laptop, { commit: null, pushed: true, pushError: null, rolledBack: false });
      assert.equal(git(ctx.repo, ctx.env, 'rev-parse', 'HEAD'), headBefore);
      assert.deepEqual(readRepo(ctx, 'remote/bootstrap.sh'), Buffer.from(BOOTSTRAP, 'utf8'));
      assert.ok(await answers(ctx.port));
    } finally {
      await cleanup(ctx);
    }
  });

  test('si el tablero no responde tras actualizar, vuelve atrás, lo arranca otra vez y falla en laptop_start', async () => {
    const ctx = await makeSandbox('startfail', { boardSilent: true });
    try {
      const { res } = await runUpgrade(ctx, { startWaitSec: 4 });
      const job = readJob(ctx);
      assert.equal(res.code, 1, res.output);
      assert.equal(job.state, 'failed', res.output);
      assert.equal(job.failedStep, 'laptop_start');
      const start = job.steps.find((s) => s.name === 'laptop_start');
      assert.equal(start.state, 'failed');
      assert.match(start.detail, /second start/);
      const head = git(ctx.repo, ctx.env, 'rev-parse', 'HEAD');
      assert.equal(job.laptop.commit, head);
      assert.equal(job.laptop.rolledBack, true);
      const rollback = job.steps.find((s) => s.name === 'laptop_rollback');
      assert.equal(rollback.state, 'ok');
      assert.match(rollback.detail, new RegExp(`working tree left dirty against commit ${head}, pushed=true`));
      // Back at the files the upgrade started from, LF endings included.
      assert.equal(JSON.parse(readRepo(ctx, 'server/package.json')).dependencies[SDK], '^0.3.272');
      assert.deepEqual(readRepo(ctx, 'remote/bootstrap.sh'), Buffer.from(BOOTSTRAP, 'utf8'));
      assert.equal(sdkBinVersion(ctx), '2.1.272');
      assert.equal(fs.existsSync(path.join(ctx.repo, '.hfs-monitor.upgrading')), false);
    } finally {
      await cleanup(ctx);
    }
  });

  test('laptop_guard aborta si bootstrap.sh tiene cambios sin commitear, y el cambio sobrevive', async () => {
    const ctx = await makeSandbox('dirty');
    try {
      const edited = BOOTSTRAP + '# a local edit\n';
      fs.writeFileSync(path.join(ctx.repo, 'remote', 'bootstrap.sh'), edited);
      const { res } = await runUpgrade(ctx);
      const job = readJob(ctx);
      assert.equal(res.code, 1, res.output);
      assert.equal(job.state, 'failed', res.output);
      assert.equal(job.failedStep, 'laptop_guard');
      assert.match(job.error, /uncommitted changes/);
      assert.deepEqual(npmInstalls(ctx), []);
      assert.equal(job.laptop.rolledBack, false);
      assert.deepEqual(readRepo(ctx, 'remote/bootstrap.sh'), Buffer.from(edited, 'utf8'));
      assert.ok(await answers(ctx.port));
    } finally {
      await cleanup(ctx);
    }
  });

  test('.hfs-monitor.upgrading con su pid vivo bloquea start.ps1 y stop.ps1; -Force pasa; un lock huérfano se borra', async () => {
    const ctx = await makeSandbox('lock');
    try {
      const lockFile = path.join(ctx.repo, '.hfs-monitor.upgrading');
      const holder = spawnNode(ctx, ['-e', 'setInterval(() => {}, 1000)']);
      await delay(500);
      fs.writeFileSync(lockFile, JSON.stringify({ pid: holder.pid, startedAt: new Date().toISOString() }));
      const sweep = ['-PortFrom', '1', '-PortTo', '0'];

      let r = await runPs(ctx, 'start.ps1');
      assert.equal(r.code, 1, r.output);
      assert.match(r.output, new RegExp(`El tablero se esta actualizando \\(pid ${holder.pid}\\); espera o usa -Force`));
      assert.equal(await answers(ctx.port), false);

      r = await runPs(ctx, 'stop.ps1', sweep);
      assert.equal(r.code, 1, r.output);
      assert.ok(fs.existsSync(lockFile));

      r = await runPs(ctx, 'start.ps1', ['-Force']);
      assert.equal(r.code, 0, r.output);
      assert.ok(await waitFor(() => answers(ctx.port), 20_000), 'the board started with -Force');

      r = await runPs(ctx, 'stop.ps1', ['-Force', ...sweep]);
      assert.equal(r.code, 0, r.output);
      assert.ok(await waitFor(async () => !(await answers(ctx.port)), 10_000), 'stop.ps1 -Force stopped the board');
      assert.ok(fs.existsSync(lockFile), '-Force leaves the lock alone');

      holder.kill();
      assert.ok(await waitFor(() => !alive(holder.pid), 5000));
      r = await runPs(ctx, 'start.ps1');
      assert.equal(r.code, 0, r.output);
      assert.equal(fs.existsSync(lockFile), false);
      assert.ok(await waitFor(() => answers(ctx.port), 20_000));
    } finally {
      await cleanup(ctx);
    }
  });

  // Negative control, run once by hand: `git show <commit before this change>:start.ps1`
  // copied over the sandbox's start.ps1 makes this test fail after 60 s (the pipes
  // never close, the old script lets the board inherit the caller's stdout).
  test('start.ps1 con stdio por pipes termina (close) aunque el tablero siga vivo: no hereda los handles del llamador', async () => {
    const ctx = await makeSandbox('pipes');
    try {
      const r = await runPsPiped(ctx, 'start.ps1');
      assert.ok(r.closed, `los pipes siguen abiertos (el tablero heredo el stdout del llamador); salida: ${r.output}`);
      assert.ok(r.closeMs < 45_000, `close tardo ${r.closeMs} ms`);
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /hfs-monitor iniciado \(PID \d+\)/);
      const pid = boardPid(ctx);
      assert.ok(alive(pid), 'el tablero sigue vivo tras el close');
      assert.ok(await waitFor(() => answers(ctx.port), 20_000), 'el tablero responde');
    } finally {
      await cleanup(ctx);
    }
  });

  test('el tablero recibe el entorno del llamador', async () => {
    const ctx = await makeSandbox('env');
    try {
      const env = { ...ctx.env, FAKEBOARD_PROBE: 'ciruela-7' };
      const r = await runPsPiped(ctx, 'start.ps1', [], { env });
      assert.ok(r.closed, r.output);
      assert.equal(r.code, 0, r.output);
      const probe = path.join(ctx.repo, 'server', 'data', 'fake-board-env.txt');
      assert.ok(await waitFor(() => fs.existsSync(probe), 20_000), 'el tablero escribio su entorno');
      assert.equal(fs.readFileSync(probe, 'utf8'), 'ciruela-7');
    } finally {
      await cleanup(ctx);
    }
  });

  test('el tablero no hereda las variables de npm ni de una sesion Claude, y si las demas', async () => {
    const ctx = await makeSandbox('envstrip');
    try {
      const env = { ...ctx.env, CLAUDECODE: '1', CLAUDE_CODE_X: '1', ANTHROPIC_X: '1', npm_x: '1', INIT_CWD: ctx.repo, CLAUDECODE_X: '1', INIT_CWD_X: '1', HFSMON_KEEP: 'si', FAKEBOARD_PROBE: 'ordinaria' };
      const r = await runPsPiped(ctx, 'start.ps1', [], { env });
      assert.ok(r.closed, r.output);
      assert.equal(r.code, 0, r.output);
      const dump = path.join(ctx.repo, 'server', 'data', 'fake-board-envnames.txt');
      assert.ok(await waitFor(() => fs.existsSync(dump) && fs.statSync(dump).size > 0, 20_000), 'el tablero volco su entorno');
      const names = fs.readFileSync(dump, 'utf8').split('\n');
      for (const gone of ['CLAUDECODE', 'CLAUDE_CODE_X', 'ANTHROPIC_X', 'npm_x', 'INIT_CWD']) {
        assert.ok(!names.some((n) => n.toLowerCase() === gone.toLowerCase()), `${gone} no debia llegar al tablero`);
      }
      // The patterns are anchored: look-alikes survive.
      for (const kept of ['CLAUDECODE_X', 'INIT_CWD_X']) assert.ok(names.includes(kept), `${kept} debia sobrevivir`);
      assert.ok(names.includes('HFSMON_KEEP'), 'HFSMON_* sigue llegando');
      assert.ok(names.some((n) => /^path$/i.test(n)), 'PATH sigue llegando');
      assert.equal(fs.readFileSync(path.join(ctx.repo, 'server', 'data', 'fake-board-env.txt'), 'utf8'), 'ordinaria');
    } finally {
      await cleanup(ctx);
    }
  });

  test('pid reutilizado: un node vivo mas nuevo que el .pid (mtime 60 s atras) es obsoleto y no se toca', async () => {
    const ctx = await makeSandbox('pidreuse');
    try {
      const stranger = spawnNode(ctx, ['-e', 'setInterval(() => {}, 1000)']);
      await delay(1000);
      const pf = path.join(ctx.repo, '.hfs-monitor.pid');
      fs.writeFileSync(pf, `${stranger.pid}\r\n`);
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(pf, past, past);
      const r = await runPs(ctx, 'start.ps1');
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, new RegExp(`Archivo \\.pid obsoleto \\(PID ${stranger.pid} no es el tablero\\); se borra\\.`));
      assert.ok(await waitFor(() => answers(ctx.port), 20_000), 'el tablero arranco');
      assert.notEqual(boardPid(ctx), stranger.pid);
      assert.ok(alive(stranger.pid), 'el node ajeno no se toco');
    } finally {
      await cleanup(ctx);
    }
  });

  test('un .pid con un proceso vivo que no es node es obsoleto: se arranca y ese proceso sigue vivo', async () => {
    const ctx = await makeSandbox('stalepid');
    try {
      const stranger = spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 120'], { stdio: 'ignore', windowsHide: true });
      ctx.children.push(stranger);
      await delay(1000);
      assert.ok(alive(stranger.pid));
      fs.writeFileSync(path.join(ctx.repo, '.hfs-monitor.pid'), `${stranger.pid}\r\n`);
      const r = await runPs(ctx, 'start.ps1');
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, new RegExp(`Archivo \\.pid obsoleto \\(PID ${stranger.pid} no es el tablero\\); se borra\\.`));
      assert.ok(await waitFor(() => answers(ctx.port), 20_000), 'el tablero arranco');
      assert.notEqual(boardPid(ctx), stranger.pid);
      assert.ok(alive(stranger.pid), 'el proceso ajeno no se toco');
    } finally {
      await cleanup(ctx);
    }
  });

  test('un .pid con basura es obsoleto y no impide arrancar', async () => {
    const ctx = await makeSandbox('garbagepid');
    try {
      fs.writeFileSync(path.join(ctx.repo, '.hfs-monitor.pid'), 'no soy un pid\r\n');
      const r = await runPs(ctx, 'start.ps1');
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /Archivo \.pid obsoleto/);
      assert.ok(await waitFor(() => answers(ctx.port), 20_000));
    } finally {
      await cleanup(ctx);
    }
  });

  test('si npm ci falla, arranca igualmente, avisa y sale con 2', async () => {
    const ctx = await makeSandbox('installfail');
    try {
      fs.rmSync(path.join(ctx.repo, 'server', 'node_modules'), { recursive: true, force: true });
      writeJson(path.join(ctx.tools, 'scenario.json'), { binary: [true], versions: null, fakeClaude: fakeClaudeExe, ciExit: 1 });
      const r = await runPs(ctx, 'start.ps1');
      assert.equal(r.code, 2, r.output);
      const warn = /AVISO: npm ci del servidor fallo \(codigo 1\)/;
      assert.match(r.output, warn);
      const lines = r.output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      assert.match(lines.at(-1), warn, 'el aviso es la ultima linea');
      assert.ok(await waitFor(() => answers(ctx.port), 20_000), 'el tablero responde');
    } finally {
      await cleanup(ctx);
    }
  });

  test('si la compilacion del frontend falla, arranca igualmente, avisa y sale con 2', async () => {
    const ctx = await makeSandbox('buildfail');
    try {
      writeJson(path.join(ctx.tools, 'scenario.json'), { binary: [true], versions: null, fakeClaude: fakeClaudeExe, buildExit: 3 });
      const r = await runPs(ctx, 'start.ps1');
      assert.equal(r.code, 2, r.output);
      const warn = /AVISO: la compilacion del frontend fallo \(codigo 3\)/;
      assert.match(r.output, warn);
      const lines = r.output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      assert.match(lines.at(-1), warn, 'el aviso es la ultima linea');
      assert.ok(lines.some((l) => /hfs-monitor iniciado \(PID \d+\)/.test(l)));
      assert.ok(await waitFor(() => answers(ctx.port), 20_000), 'el tablero responde');
      assert.ok(alive(boardPid(ctx)));
    } finally {
      await cleanup(ctx);
    }
  });
});
