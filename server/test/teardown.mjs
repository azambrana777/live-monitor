// Shared teardown for tests that spawn the real board and then delete the
// temporary directory it ran in.
//
// On Windows a directory cannot be removed while a process has it as its working
// directory, and `fs.rmSync` does not wait for that: on Node 24 it fails with
// `EPERM` at once, whatever `maxRetries` and `retryDelay` say. In the full suite
// the board's directory was still held for a moment after the board had exited
// (something it started, most likely `git` or `gh`, though that was never
// observed), and the `after` hook failed with an intermittent `EPERM`. Waiting a
// little is what makes the removal succeed.
//
// `tempDir` is the other half: a directory a test creates and nobody removes. It is
// removed when the process ends, in one synchronous `exit` handler, which is the
// only point late enough for a data directory (the store flushes in `beforeExit`,
// after every `after` hook) and early enough to always run. This file must only
// import `node:*`: `data-dir.test.mjs` reads any relative import that reaches the
// board's writers as a reason to demand an isolated data dir above it.
import { rmSync, mkdtempSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const LOCKED = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);

const removeNow = (target) => rmSync(target, { recursive: true, force: true });

/**
 * Removes a directory tree, retrying while something still holds it. Resolves with
 * how many milliseconds it had to wait, and rejects with the original error once
 * `timeoutMs` has passed or the error is not a lock. `remove` is injectable for tests.
 *
 * A removal that works at the first attempt waited for nothing, so it resolves `0`
 * however long the call took: under load even a successful first attempt can take a
 * millisecond or more, and reporting that as a wait made callers print a lock that
 * never happened.
 */
export async function removeTree(target, { timeoutMs = 10_000, stepMs = 50, remove = removeNow } = {}) {
  const startedAt = performance.now();
  let retried = false;
  for (;;) {
    try {
      remove(target);
      return retried ? Math.round(performance.now() - startedAt) : 0;
    } catch (e) {
      if (!LOCKED.has(e.code) || performance.now() - startedAt >= timeoutMs) throw e;
    }
    retried = true;
    await new Promise((resolve) => { setTimeout(resolve, stepMs); });
  }
}

/**
 * `removeTree` that says so on stderr whenever it had to wait, so a green run still
 * shows whether the lock happened. With `tolerate` it never throws: a directory that
 * stays held is reported and left behind (resolves `null`), for cleanups that must
 * not fail a test. `write` is injectable for tests.
 */
export async function removeTreeReported(label, target, { tolerate = false, write = (s) => process.stderr.write(s), ...options } = {}) {
  try {
    const waited = await removeTree(target, options);
    if (waited > 0) write(`[${label}] ${target} was held for ${waited} ms\n`);
    return waited;
  } catch (e) {
    if (!tolerate) throw e;
    write(`[${label}] ${target} could not be removed (${e.code ?? e.message}); left behind\n`);
    return null;
  }
}

const registered = [];
let exitHandlerInstalled = false;

const writeStderrSync = (s) => {
  try { writeSync(2, s); } catch { /* an exit handler cannot wait for a stream, nor fail */ }
};

/**
 * Removes every registered directory, last registered first, and empties the list.
 * Synchronous and never throws: a directory that cannot be removed (a Windows lock;
 * `maxRetries` does not help on Node 24) is reported and left behind. `remove` and
 * `write` are injectable for tests.
 */
export function removeRegistered({ remove = removeNow, write = writeStderrSync } = {}) {
  while (registered.length) {
    const dir = registered.pop();
    try {
      remove(dir);
    } catch (e) {
      try { write(`[exit-cleanup] ${dir} could not be removed (${e.code ?? e.message}); left behind\n`); } catch { /* never throw at exit */ }
    }
  }
}

/** Removes `dir` when the process ends. The first call installs the one `exit` handler. */
export function removeAtExit(dir) {
  registered.push(dir);
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.on('exit', () => removeRegistered());
  }
  return dir;
}

/** `mkdtempSync` under the OS temp folder, removed when the process ends. Returns the path. */
export function tempDir(prefix) {
  return removeAtExit(mkdtempSync(path.join(tmpdir(), prefix)));
}
