// Global process budget (exec.js) and the lock-free read-only git calls.
import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { _throttled, setProcessCaps, getProcessCaps, _processSlots, Mutex, run } from '../src/exec.js';
import {
  RO, pendingWork, mergeInProgress, analyzeMerge, mergeBlockers, isProjectWorktree, resolveRef,
} from '../src/worktree.js';
import { LocalMachine } from '../src/machine.js';
import { tempDir } from './teardown.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A spawn stand-in that counts how many run at once. */
function counter(ms = 15) {
  const c = { now: 0, max: 0, done: 0 };
  c.fn = async () => {
    c.now += 1; c.max = Math.max(c.max, c.now);
    await sleep(ms);
    c.now -= 1; c.done += 1;
  };
  return c;
}

test('git and gh never exceed their global caps', async (t) => {
  const prev = setProcessCaps({ git: 3, gh: 2, ghPerRepo: 2 });
  t.after(() => setProcessCaps(prev));
  const git = counter();
  const gh = counter();
  await Promise.all([
    ...Array.from({ length: 20 }, () => _throttled('git', ['status'], '/x', git.fn)),
    // different repos, so only the global cap can hold them
    ...Array.from({ length: 12 }, (_, i) => _throttled('gh', ['pr', 'list', '-R', `o/r${i}`], undefined, gh.fn)),
  ]);
  assert.equal(git.done, 20);
  assert.equal(gh.done, 12);
  assert.equal(git.max, 3);
  assert.equal(gh.max, 2);
  assert.deepEqual(_processSlots(), { gh: 0, git: 0 });
});

test('gh is also capped per repository, and the .exe / path form counts as gh', async (t) => {
  const prev = setProcessCaps({ gh: 8, ghPerRepo: 2 });
  t.after(() => setProcessCaps(prev));
  const same = counter();
  const other = counter();
  await Promise.all([
    ...Array.from({ length: 9 }, () => _throttled('C:\\Program Files\\GitHub CLI\\gh.exe', ['pr', 'list', '-R', 'o/same'], undefined, same.fn)),
    ...Array.from({ length: 3 }, () => _throttled('gh', ['api', 'repos/o/other/pulls'], undefined, other.fn)),
  ]);
  assert.equal(same.max, 2);
  assert.ok(other.max <= 2);
});

test('other commands are not throttled', async (t) => {
  const prev = setProcessCaps({ git: 1, gh: 1 });
  t.after(() => setProcessCaps(prev));
  const c = counter();
  await Promise.all(Array.from({ length: 6 }, () => _throttled('node', [], undefined, c.fn)));
  assert.equal(c.max, 6);
});

test('raising a cap releases the waiters already queued', async (t) => {
  const prev = setProcessCaps({ git: 1 });
  t.after(() => setProcessCaps(prev));
  const c = counter(40);
  const all = Promise.all(Array.from({ length: 4 }, () => _throttled('git', [], '/x', c.fn)));
  await sleep(5);
  setProcessCaps({ git: 4 });
  await all;
  assert.ok(c.max > 1);
});

test('a failing spawn gives its slot back', async (t) => {
  const prev = setProcessCaps({ git: 1 });
  t.after(() => setProcessCaps(prev));
  await assert.rejects(_throttled('git', [], '/x', async () => { throw new Error('boom'); }), /boom/);
  const c = counter(1);
  await _throttled('git', [], '/x', c.fn);
  assert.equal(c.done, 1);
});

test('writers behind a mutex never deadlock with readers at cap 1', async (t) => {
  const prev = setProcessCaps({ git: 1 });
  t.after(() => setProcessCaps(prev));
  const mutex = new Mutex();
  const order = [];
  const writer = (name) => mutex.runExclusive('wt', async () => {
    // several git calls inside one exclusive section, like add + commit + push
    for (const step of ['add', 'commit', 'push']) {
      await _throttled('git', [step], '/wt', async () => { order.push(`${name}:${step}`); await sleep(3); });
    }
  });
  const reader = (name) => _throttled('git', ['status'], '/wt', async () => { order.push(name); await sleep(3); });
  const work = Promise.all([writer('A'), writer('B'), reader('r1'), reader('r2'), writer('C'), reader('r3')]);
  const timeout = sleep(5000).then(() => 'timeout');
  assert.notEqual(await Promise.race([work.then(() => 'ok'), timeout]), 'timeout', 'deadlock');
  assert.equal(order.length, 3 * 3 + 3);
  assert.deepEqual(_processSlots(), { gh: 0, git: 0 });
});

test('real run(): git calls go through the cap and still return their output', async (t) => {
  const prev = setProcessCaps({ git: 2 });
  t.after(() => setProcessCaps(prev));
  const results = await Promise.all(Array.from({ length: 6 }, () => run('git', ['--version'])));
  for (const r of results) assert.ok(r.ok && /^git version/.test(r.stdout));
  assert.equal(getProcessCaps().git, 2);
  assert.deepEqual(_processSlots(), { gh: 0, git: 0 });
});

// ---- --no-optional-locks -------------------------------------------------

const READ_ONLY = new Set(['status', 'diff', 'rev-list', 'rev-parse', 'merge-base', 'merge-tree']);
function subcommand(args) {
  const rest = [...args];
  while (rest[0] === RO || rest[0] === '-c') rest.splice(0, rest[0] === '-c' ? 2 : 1);
  return rest[0];
}

function fakeMachine(answer = () => ({ ok: true, code: 0, stdout: '', stderr: '' })) {
  const calls = [];
  return {
    calls,
    repoPath: '/repo',
    path: path.posix,
    samePath: (a, b) => a === b,
    fs: { exists: async () => true },
    exec: async (file, args) => { calls.push({ file, args }); return answer(args); },
  };
}

function assertReadsAreLockFree(calls) {
  const reads = calls.filter((c) => c.file === 'git' && READ_ONLY.has(subcommand(c.args)));
  assert.ok(reads.length > 0);
  for (const c of reads) {
    assert.ok(c.args.includes(RO), `git ${c.args.join(' ')} lacks ${RO}`);
    // a global option: before the subcommand
    assert.ok(c.args.indexOf(RO) < c.args.indexOf(subcommand(c.args)), `${c.args.join(' ')}: ${RO} must precede the subcommand`);
  }
}

test('pendingWork, mergeInProgress, resolveRef, isProjectWorktree, mergeBlockers read without optional locks', async () => {
  const m = fakeMachine();
  await pendingWork(m, '/wt', 'feat/x');
  await mergeInProgress(m, '/wt');
  await resolveRef(m, '/wt', 'HEAD');
  await isProjectWorktree(m, '/wt');
  await mergeBlockers(m, '/wt', 'abc123');
  assertReadsAreLockFree(m.calls);
  const status = m.calls.find((c) => subcommand(c.args) === 'status');
  assert.deepEqual(status.args, [RO, '-c', 'core.quotePath=false', 'status', '--porcelain']);
});

test('analyzeMerge reads without optional locks, on both paths', async () => {
  const m = fakeMachine((args) => ({ ok: true, code: 0, stdout: subcommand(args) === 'rev-list' ? '3\n' : 'abc\n', stderr: '' }));
  await analyzeMerge(m, '/wt', 'abc123');
  assertReadsAreLockFree(m.calls);
  assert.ok(m.calls.some((c) => subcommand(c.args) === 'merge-tree'));
});

test('real git: pendingWork keeps its answer and leaves a held index.lock alone', async () => {
  const root = tempDir('hfsmon-git-');
  const g = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  mkdirSync(origin);
  g(['init', '--bare', '-b', 'main', '.'], origin);
  g(['clone', origin, work], root);
  g(['config', 'user.email', 't@example.com'], work);
  g(['config', 'user.name', 'T'], work);
  writeFileSync(path.join(work, 'a.txt'), 'a\n');
  g(['add', '.'], work);
  g(['commit', '-m', 'seed'], work);
  g(['push', '-u', 'origin', 'main'], work);
  g(['checkout', '-b', 'feat'], work);
  writeFileSync(path.join(work, 'b.txt'), 'b\n');
  g(['add', '.'], work);
  g(['commit', '-m', 'b'], work);
  g(['push', '-u', 'origin', 'feat'], work);
  writeFileSync(path.join(work, 'c.txt'), 'c\n');
  g(['add', '.'], work);
  g(['commit', '-m', 'c'], work);
  writeFileSync(path.join(work, 'b.txt'), 'b2\n');

  // A writer is mid-`git add`: it holds the index lock.
  const lock = path.join(work, '.git', 'index.lock');
  writeFileSync(lock, '');
  const r = await pendingWork(new LocalMachine('test'), work, 'feat');
  assert.deepEqual(r.dirty, ['M b.txt']);
  assert.equal(r.unpushed, 1);
  // the poll neither failed nor removed the writer's lock
  assert.ok(existsSync(lock));
});
