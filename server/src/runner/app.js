import express from 'express';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { LocalMachine } from '../machine.js';
import { PROJECT_WORKTREE_DIR } from '../keys.js';

const UNIT_RE = /^[A-Za-z0-9@_.:-]+\.service$/;
const USER_MANAGER_RE = /^user@\d+\.service$/;

/**
 * The systemd user service a process lives in, from the text of
 * `/proc/self/cgroup` (cgroup v2 `0::/path` or v1 `N:name=systemd:/path`).
 * Only a service under a `user@<uid>.service` manager counts; a session scope,
 * a system service or anything unparseable is `null`. Returns the full name,
 * `.service` included.
 */
export function unitFromCgroup(text) {
  if (typeof text !== 'string') return null;
  const paths = [];
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    const j = i < 0 ? -1 : line.indexOf(':', i + 1);
    if (j < 0) continue;
    const hierarchy = line.slice(i + 1, j);
    if (hierarchy === '' || hierarchy === 'name=systemd') paths.push([hierarchy, line.slice(j + 1).trim()]);
  }
  paths.sort((a, b) => (a[0] === '' ? -1 : 0) - (b[0] === '' ? -1 : 0));
  for (const [, p] of paths) {
    const segs = p.split('/').filter(Boolean);
    const mgr = segs.findIndex((x) => USER_MANAGER_RE.test(x));
    if (mgr < 0) continue;
    for (let k = segs.length - 1; k > mgr; k--) {
      if (segs[k].endsWith('.service')) return UNIT_RE.test(segs[k]) ? segs[k] : null;
    }
  }
  return null;
}

function readOwnUnit() {
  if (process.platform !== 'linux') return null;
  try { return unitFromCgroup(readFileSync('/proc/self/cgroup', 'utf8')); } catch { return null; }
}

/**
 * The runner: a `LocalMachine` served over the network.
 *
 * It runs on a dev box and does, on request, exactly what the board does on
 * its own machine — run a command, read a file, start a server, spawn
 * `claude` — with that machine's tools, its login and its paths. It decides
 * nothing: which task, which prompt, when to push, are the board's.
 *
 * Streams where the board needs them live: a command's lines while it runs,
 * a daemon's output, and Claude's stdin/stdout as they happen. Plain HTTP
 * everywhere else, which is what keep-alive over the tailnet makes cheap.
 *
 * The token is the whole door. On a box where the user has passwordless sudo
 * that means the token is root, so `bind` should be the Tailscale address and
 * nothing wider — the entry point refuses to listen on 0.0.0.0.
 */
export function createRunner({
  token, repoPath, worktreeRoot, claudeCommand = 'claude',
  attachmentsDir = path.join(homedir(), '.hfs-monitor', 'attachments'),
  monitorDir = defaultMonitorDir(),
  heartbeatMs = 30_000,
  infoBoundMs = 2_000,
}) {
  if (!token) throw new Error('runner: falta el token');
  const machine = new LocalMachine('runner', { repoPath, worktreeRoot });

  // The hfs-monitor checkout this runner runs from, and its HEAD twice over:
  // `commit` is read once, now, so it names the code actually loaded;
  // `diskCommit` is read on every `/info`, so a pull that has not been
  // followed by a restart shows up as the two disagreeing.
  const checkoutDir = monitorDir ? path.resolve(monitorDir) : null;
  // `/info` must answer even when git is slow (the board decides the runner
  // came back from this answer), so each read has its own bound and falls back
  // to the last value seen; `degraded` says something was cut short.
  const startCommit = headOf(machine, checkoutDir);
  const unit = readOwnUnit();
  const last = { commit: null, diskCommit: null, base: null };
  const bounded = (p, ms) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(BOUND), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(BOUND); });
  });

  const app = express();

  // The token first, the bodies after: without it nothing gets parsed, not
  // the JSON and not a 25 MB upload.
  const allowed = (req) => req.headers['x-hfsmon-token'] === token;
  app.use((req, res, next) => (allowed(req) ? next() : res.status(401).json({ error: 'token' })));

  app.use(express.json({ limit: '2mb' }));
  app.use(express.raw({ type: 'application/octet-stream', limit: '25mb' }));

  app.get('/info', async (_req, res) => {
    const [base, commit, diskCommit] = await Promise.all([
      bounded(machine.info(), infoBoundMs),
      bounded(startCommit, infoBoundMs),
      bounded(headOf(machine, checkoutDir), infoBoundMs),
    ]);
    const degraded = base === BOUND || commit === BOUND || diskCommit === BOUND;
    if (base !== BOUND) last.base = base;
    if (commit !== BOUND) last.commit = commit;
    if (diskCommit !== BOUND) last.diskCommit = diskCommit;
    res.json({
      ...(last.base ?? { platform: process.platform, node: process.version, claude: null, home: homedir() }),
      repoPath, worktreeRoot, home: homedir(), pid: process.pid,
      // Who this runner runs as: the file viewer serves a `/tmp/claude-*` file
      // only when it belongs to this user, not to anyone else on the box.
      uid: process.getuid?.() ?? null,
      commit: last.commit,
      diskCommit: last.diskCommit,
      monitorDir: checkoutDir,
      // systemd user service this runner runs under (cached at startup), or null.
      unit,
      degraded,
    });
  });

  /**
   * A command, with its lines as they come. NDJSON: `{line}` while it runs,
   * then one `{result}` — so the board's `onLine` sees the same thing it
   * would from a local spawn, and a build that takes half an hour is not
   * a request that hangs silent for half an hour. A `{hb}` frame every
   * `heartbeatMs` keeps a silent command's body alive (the client ignores
   * it), and a client that disconnects aborts the command.
   */
  const streamed = (runIt) => async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();
    const send = (obj) => { if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); };
    // A board's fetch drops a body that stays silent for 300 s; a compile does.
    const beat = setInterval(() => send({ hb: true }), heartbeatMs);
    // A board that went away must not leave its command running (and editing a worktree).
    // `res`, not `req`: since Node 16 the request's 'close' fires once its body is read.
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    if (res.destroyed) abort.abort();
    try {
      const result = await runIt(req.body ?? {}, (line) => send({ line }), abort.signal);
      send({ result });
    } catch (e) {
      send({ result: { ok: false, code: -1, stdout: '', stderr: e.message } });
    } finally {
      clearInterval(beat);
    }
    res.end();
  };
  app.post('/exec', streamed(({ file, args = [], cwd, env, timeoutMs }, onLine, signal) =>
    machine.exec(file, args, { cwd, env, timeoutMs, onLine, signal })));
  app.post('/shell', streamed(({ command, cwd, env, timeoutMs }, onLine, signal) =>
    machine.shell(command, { cwd, env, timeoutMs, onLine, signal })));

  // --- fs -------------------------------------------------------------------
  const fsOp = (fn) => async (req, res) => {
    try {
      res.json({ value: await fn(req.body ?? {}) });
    } catch (e) {
      res.status(400).json({ error: e.message, code: e.code });
    }
  };
  app.post('/fs/exists', fsOp(({ path: p }) => machine.fs.exists(p)));
  app.post('/fs/read', fsOp(({ path: p, tail }) => (tail ? machine.fs.tail(p, tail) : machine.fs.readFile(p))));
  app.post('/fs/write', fsOp(({ path: p, data }) => machine.fs.writeFile(p, data).then(() => true)));
  app.post('/fs/mkdir', fsOp(({ path: p }) => machine.fs.mkdir(p).then(() => true)));
  app.post('/fs/rm', fsOp(({ path: p, retries }) => machine.fs.rm(p, { retries }).then(() => true)));
  app.post('/fs/readdir', fsOp(({ path: p }) => machine.fs.readdir(p)));
  app.post('/fs/readdir-deep', fsOp(({ path: p }) => machine.fs.readdirDeep(p)));

  /** A file's bytes — a QA screenshot or video the board wants to show. */
  app.post('/fs/download', async (req, res) => {
    try {
      const bytes = await machine.fs.readBinary(String(req.body?.path ?? ''));
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(bytes.length));
      res.end(bytes);
    } catch (e) {
      res.status(400).json({ error: e.message, code: e.code });
    }
  });
  app.post('/fs/copy', fsOp(({ from, to }) => machine.fs.copy(from, to).then(() => true)));
  /**
   * `{ path, size, isFile }`, symlinks resolved: what the file viewer checks
   * before it downloads anything. A missing file is the usual 400 with
   * `code: 'ENOENT'`; a 404 only ever means a runner without this route.
   */
  app.post('/fs/realpath', fsOp(({ path: p }) => machine.fs.realpath(String(p ?? ''))));

  /**
   * An attachment for a task or a project chat, stored where a Claude session
   * here can Read it. `issue` is validated, not cleaned: a positive decimal, or
   * exactly the project chat's directory name. Nothing else steers the path.
   */
  app.put('/fs/upload', (req, res) => {
    const issue = typeof req.query.issue === 'string' ? req.query.issue : '';
    const name = path.basename(String(req.query.name ?? 'archivo')).replace(/[^A-Za-z0-9._-]/g, '_').slice(-80) || 'archivo';
    if (!(/^[1-9]\d*$/.test(issue) || issue === PROJECT_WORKTREE_DIR) || !Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: 'issue y cuerpo binario' });
    }
    const dir = path.join(attachmentsDir, issue);
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${Date.now()}-${name}`);
    writeFileSync(target, req.body);
    return res.json({ path: target, bytes: req.body.length });
  });

  /**
   * The Zen proxy on this machine, started on first ask and reused after.
   * It has to live here and not on the board: it is the `claude` process that
   * talks to it, over loopback, and that process runs on this box.
   */
  app.post('/zen-proxy/ensure', async (_req, res) => res.json({ port: await machine.zenProxyPort() }));

  // --- ports & daemons ------------------------------------------------------
  app.post('/port/free', async (req, res) => res.json({ value: await machine.portFree(Number(req.body?.port)) }));
  app.post('/daemon/find', async (req, res) => res.json({ value: await machine.daemon.find(req.body?.prefix, req.body?.binNames ?? []) }));
  app.post('/daemon/kill', async (req, res) => { await machine.daemon.kill(Number(req.body?.pid)); res.json({ value: true }); });

  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://runner');
    if (req.headers['x-hfsmon-token'] !== token && url.searchParams.get('token') !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (url.pathname !== '/daemon' && url.pathname !== '/claude') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname === '/daemon') serveDaemon(ws, machine);
      else serveClaude(ws, claudeCommand);
    });
  });

  return {
    app,
    machine,
    listen: (port, bind) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, bind, () => resolve(server.address()));
    }),
    // Ends open sockets too: server.close() alone waits for every connection,
    // and a stuck stop would sit there until systemd gives up.
    close: () => new Promise((resolve) => {
      for (const ws of wss.clients) { try { ws.terminate(); } catch { /* gone */ } }
      wss.close();
      server.close(() => resolve());
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    }),
  };
}

const BOUND = Symbol('bound');

/**
 * The checkout root: this file is `<root>/server/src/runner/app.js`.
 * `null` when the module location is not a file path.
 */
function defaultMonitorDir() {
  try {
    return path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  } catch {
    return null;
  }
}

/**
 * `git rev-parse HEAD` of `dir`, or `null` when there is no dir, it is not a
 * repo, it has no commits, or git fails or takes more than 5 s. Never throws.
 * The ceiling stops git from walking up into an enclosing repo: a checkout
 * root that is not itself a repo has no commit, whatever sits above it.
 */
async function headOf(machine, dir) {
  if (!dir) return null;
  try {
    const r = await machine.exec('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      timeoutMs: 5_000,
      env: { GIT_CEILING_DIRECTORIES: path.dirname(dir) },
    });
    const sha = r.ok ? r.stdout.trim() : '';
    return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * A long-lived process the board wants to watch: first frame says what to
 * start, then its lines flow back until it exits, and `{kill:true}` ends it.
 * Closing the socket ends it too — a board that went away must not leave
 * servers running that nothing can reach.
 */
function serveDaemon(ws, machine) {
  let handle = null;
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.spawn && !handle) {
      try {
        handle = machine.daemon.spawn(msg.spawn.bin, { cwd: msg.spawn.cwd, env: msg.spawn.env, args: msg.spawn.args ?? [] });
      } catch (e) {
        send({ error: e.message });
        ws.close();
        return;
      }
      send({ pid: handle.pid });
      handle.on('line', (line) => send({ line }));
      handle.on('exit', (code) => { send({ exit: { code } }); ws.close(); });
    } else if (msg.kill && handle) {
      handle.kill();
    }
  });
  ws.on('close', () => { if (handle) handle.kill(); });
}

/**
 * The SDK's process, on this machine. The first frame carries the args the
 * SDK built and the cwd; from then on stdin goes one way as `{stdin}` frames
 * and stdout/stderr come back as `{stdout}`/`{stderr}`, until `{exit}`.
 * The SDK's protocol is line-delimited JSON, so text frames carry it whole.
 */
function serveClaude(ws, claudeCommand) {
  let child = null;
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.start && !child) {
      const { args = [], cwd, env = {} } = msg.start;
      try {
        child = spawn(claudeCommand, args, {
          cwd,
          env: { ...process.env, ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (e) {
        send({ error: e.message });
        ws.close();
        return;
      }
      send({ pid: child.pid });
      child.stdout.on('data', (b) => send({ stdout: b.toString('utf8') }));
      child.stderr.on('data', (b) => send({ stderr: b.toString('utf8') }));
      child.on('error', (e) => send({ error: e.message }));
      child.on('exit', (code, signal) => { send({ exit: { code, signal } }); ws.close(); });
    } else if (child && typeof msg.stdin === 'string') {
      child.stdin.write(msg.stdin);
    } else if (child && msg.end) {
      child.stdin.end();
    } else if (child && msg.kill) {
      try { child.kill(msg.kill === true ? 'SIGTERM' : msg.kill); } catch { /* gone */ }
    }
  });
  ws.on('close', () => {
    if (child && child.exitCode === null) {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
    }
  });
}
