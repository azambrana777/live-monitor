import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { removeTree, removeTreeReported, tempDir, removeAtExit, removeRegistered } from './teardown.mjs';

// A hung retry loop would otherwise hang the test: node:test has no default timeout.
const FAST = { timeout: 5000 };

const lock = (code) => Object.assign(new Error(`${code}: held`), { code });

test('removeTree retries a locked directory and reports how long it waited', FAST, async () => {
  let calls = 0;
  const remove = () => {
    calls += 1;
    if (calls <= 3) throw lock('EPERM');
  };
  const waited = await removeTree('x', { stepMs: 20, remove });
  assert.equal(calls, 4);
  assert.ok(waited >= 50, `it really waited between the attempts (${waited} ms)`);
});

test('removeTree gives up with the original error once the timeout has passed', FAST, async () => {
  let calls = 0;
  const original = lock('EBUSY');
  const remove = () => {
    calls += 1;
    throw original;
  };
  await assert.rejects(removeTree('x', { timeoutMs: 120, stepMs: 20, remove }), (e) => e === original);
  assert.ok(calls > 2, 'it kept trying until the timeout');
});

test('removeTree does not retry an error that is not a lock', FAST, async () => {
  let calls = 0;
  const remove = () => {
    calls += 1;
    throw lock('EACCES');
  };
  await assert.rejects(removeTree('x', { remove }), (e) => e.code === 'EACCES');
  assert.equal(calls, 1);
});

test('removeTreeReported writes the wait to stderr only when there was one', FAST, async () => {
  const lines = [];
  let calls = 0;
  const remove = () => {
    calls += 1;
    if (calls <= 2) throw lock('EPERM');
  };
  const waited = await removeTreeReported('t', 'x', { stepMs: 20, remove, write: (s) => lines.push(s) });
  assert.ok(waited > 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[t\] x was held for \d+ ms\n$/);

  lines.length = 0;
  assert.equal(await removeTreeReported('t', 'x', { remove: () => {}, write: (s) => lines.push(s) }), 0);
  assert.deepEqual(lines, []);
});

// The flake this pins: with the whole suite running, a removal that works at the
// FIRST attempt can still take a millisecond or more (the machine stalls between the
// two clock reads). `removeTree` used to report that elapsed time as a wait, so the
// «only when there was one» test saw 1 instead of 0 and a line on stderr.
test('a removal that works at the first attempt never counts as a wait, however slow the machine is', FAST, async () => {
  const slowButFirstTry = () => {
    const until = performance.now() + 8;
    while (performance.now() < until) { /* a stalled machine */ }
  };
  assert.equal(await removeTree('x', { remove: slowButFirstTry }), 0);

  const lines = [];
  assert.equal(await removeTreeReported('t', 'x', { remove: slowButFirstTry, write: (s) => lines.push(s) }), 0);
  assert.deepEqual(lines, [], 'nothing is written when nothing had to be retried');
});

test('removeTreeReported throws on a stuck directory unless tolerate is set', FAST, async () => {
  const lines = [];
  const original = lock('EBUSY');
  const remove = () => { throw original; };
  const opts = { timeoutMs: 80, stepMs: 20, remove, write: (s) => lines.push(s) };
  await assert.rejects(removeTreeReported('t', 'x', opts), (e) => e === original);
  assert.deepEqual(lines, []);

  assert.equal(await removeTreeReported('t', 'x', { ...opts, tolerate: true }), null);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[t\] x could not be removed \(EBUSY\); left behind\n$/);
});

test('removeTree on a directory that is already gone is not an error', FAST, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hfsmon-teardown-'));
  try {
    assert.ok(await removeTree(path.join(root, 'never-created')) < 50, 'nothing to wait for');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The real thing, only where it exists: a process with its cwd inside the directory
// locks it on Windows, and it can be removed once that process ends.
const WINDOWS_ONLY = { skip: process.platform !== 'win32' && 'only Windows locks a directory held as a cwd', timeout: 10_000 };

const HOLD_MS = 600;

/** A process that sleeps with `cwd` as its working directory; resolves once it is really running there. */
function startHolder(cwd) {
  const child = spawn(process.execPath, ['-e', `console.log('ready'); setTimeout(() => {}, ${HOLD_MS})`], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', () => resolve(child));
    child.once('exit', () => reject(new Error('the holder ended before it was ready')));
  });
}

const exited = (child) => new Promise((r) => { if (child.exitCode !== null) r(); else child.once('exit', r); });

test('removeTree waits for a process that holds the directory as its working directory', WINDOWS_ONLY, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hfsmon-teardown-'));
  const sub = path.join(dir, 'repo');
  mkdirSync(sub);
  let holding = null;
  try {
    holding = await startHolder(sub);
    // The premise, and the reason the helper exists: a plain removal fails now.
    assert.throws(() => rmSync(dir, { recursive: true, force: true }), (e) => ['EPERM', 'EBUSY'].includes(e.code));

    const waited = await removeTree(dir);

    assert.ok(!existsSync(dir), 'the directory is gone');
    assert.ok(waited >= 150, `it waited for the holder to end (waited ${waited} ms of its ${HOLD_MS})`);
  } finally {
    // Only the process this test started. The removal races the holder's exit, so it waits too.
    if (holding) {
      holding.kill();
      await exited(holding);
    }
    await removeTree(dir);
  }
});

// tempDir / removeAtExit: the removal runs in an `exit` handler, so it is proved
// from the outside, in a child process that ends.
const TEARDOWN_URL = pathToFileURL(path.resolve(import.meta.dirname, 'teardown.mjs')).href;
const ISOLATE_URL = pathToFileURL(path.resolve(import.meta.dirname, 'isolate.mjs')).href;
// Spelled out at run time: data-dir.test.mjs reads a literal call plus a non-literal argument as a computed import of this file.
const IMPORT = 'im' + 'port';

/** Runs `body` as an ES module in a fresh node; stdout is the path(s) it printed. */
function runChild(body, env = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', body], { env: childEnv, encoding: 'utf8', timeout: 8000 });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}

test('tempDir creates the directory and removes it, with its content, when the process ends', FAST, () => {
  const r = runChild(`
    import { writeFileSync, mkdirSync } from 'node:fs';
    import { tempDir } from ${JSON.stringify(TEARDOWN_URL)};
    const d = tempDir('hfsmon-tempdir-');
    mkdirSync(d + '/sub');
    writeFileSync(d + '/sub/f.txt', 'x');
    console.log(d);
  `);
  assert.equal(r.code, 0, r.err);
  assert.match(path.basename(r.out), /^hfsmon-tempdir-/);
  assert.ok(!existsSync(r.out), 'gone after exit');
});

test('tempDir is removed even when the process ends with an uncaught exception', FAST, () => {
  const r = runChild(`
    import { tempDir } from ${JSON.stringify(TEARDOWN_URL)};
    console.log(tempDir('hfsmon-tempdir-'));
    throw new Error('boom');
  `);
  assert.notEqual(r.code, 0);
  assert.ok(r.out && !existsSync(r.out), 'gone after exit');
});

test('isolate.mjs removes the data dir it created', FAST, () => {
  const r = runChild(`
    await ${IMPORT}(${JSON.stringify(ISOLATE_URL)});
    console.log(process.env.HFSMON_DATA_DIR);
  `, { HFSMON_DATA_DIR: undefined });
  assert.equal(r.code, 0, r.err);
  assert.match(path.basename(r.out), /^hfsmon-test-/);
  assert.ok(!existsSync(r.out), 'gone after exit');
});

test('isolate.mjs leaves an inherited data dir alone', FAST, () => {
  const inherited = mkdtempSync(path.join(tmpdir(), 'hfsmon-teardown-'));
  try {
    const r = runChild(`await ${IMPORT}(${JSON.stringify(ISOLATE_URL)});`, { HFSMON_DATA_DIR: inherited });
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(inherited), 'not ours, not removed');
  } finally {
    rmSync(inherited, { recursive: true, force: true });
  }
});

test('a removal that fails is reported on stderr and never throws', FAST, () => {
  const lines = [];
  const dir = tempDir('hfsmon-teardown-');
  const kept = tempDir('hfsmon-teardown-');
  const remove = (d) => { if (d === dir) throw lock('EPERM'); rmSync(d, { recursive: true, force: true }); };
  removeRegistered({ remove, write: (s) => lines.push(s) });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[exit-cleanup\] .*hfsmon-teardown-.* could not be removed \(EPERM\); left behind\n$/);
  assert.ok(lines[0].includes(dir));
  assert.ok(!existsSync(kept), 'the other directory was still removed');
  rmSync(dir, { recursive: true, force: true });
  removeAtExit(dir); // registered again on purpose: a second drain finds it gone and stays silent
  removeRegistered({ write: (s) => lines.push(s) });
  assert.equal(lines.length, 1);
});
