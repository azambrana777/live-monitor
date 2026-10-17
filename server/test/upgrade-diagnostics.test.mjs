// What the board saw when a runner restart did not take, and the unit/pid
// pre-check. Fakes only: no shell, no runner, no machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './teardown.mjs';

const dataDir = tempDir('hfsmon-updiag-');
process.env.HFSMON_DATA_DIR = dataDir;
process.env.HFSMON_NO_AUTOSTART = '1';
delete process.env.HFSMON_UPGRADE_FORCE;

let upgrade;
let saved;
const NEW = '97c2938aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD = '131107abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

before(async () => {
  upgrade = await import('../src/upgrade.js');
  saved = { ...upgrade.upgradeHooks.timing };
  Object.assign(upgrade.upgradeHooks.timing, { restartPollMs: 5, restartTimeoutMs: 60, infoTimeoutMs: 1000 });
});
after(() => {
  Object.assign(upgrade.upgradeHooks.timing, saved);
});

const machine = (answers) => {
  let i = 0;
  return {
    name: 'box',
    info: async () => {
      const a = typeof answers === 'function' ? answers(i++) : answers;
      if (a instanceof Error) throw a;
      return a;
    },
  };
};
const never = () => false;
const wait = async (m, pidBefore, sha = NEW) => {
  const seen = {};
  const back = await upgrade.waitForRunner(m, (x) => x.pid !== pidBefore && x.commit === sha, 60, seen);
  assert.equal(back, null);
  return seen;
};

test('timeout with the same pid: last seen says unchanged and blames the unit', async () => {
  const info = { pid: 1234, commit: OLD, diskCommit: OLD, monitorDir: '/home/edson/src/live-monitor' };
  const seen = await wait(machine(info), 1234);
  const text = upgrade.describeLastSeen(seen, { sha: NEW, pidBefore: 1234 });
  assert.match(text, /^last seen: pid 1234 \(unchanged\), commit 131107a, diskCommit 131107a, dir \/home\/edson\/src\/live-monitor/);
  assert.match(text, /did not replace the process that listens on this port; check that the hfsmon-runner\.service unit/);
});

test('timeout with another pid and another commit: restarted from another checkout', async () => {
  const info = { pid: 5678, commit: OLD, diskCommit: NEW };
  const seen = await wait(machine(info), 1234);
  const text = upgrade.describeLastSeen(seen, { sha: NEW, pidBefore: 1234 });
  assert.match(text, /pid 5678 \(was 1234\), commit 131107a, diskCommit 97c2938/);
  assert.match(text, /restarted from another checkout\/commit/);
});

test('timeout with no answer: error message, failed polls and "not answering"', async () => {
  const seen = await wait(machine(new Error('connect ETIMEDOUT')), 1234);
  assert.ok(seen.failed >= 2);
  const text = upgrade.describeLastSeen(seen, { sha: NEW, pidBefore: 1234 });
  assert.match(text, /last seen: no answer \(connect ETIMEDOUT\), \d+ failed poll\(s\)/);
  assert.match(text, /the runner is not answering/);
});

test('answered once, then went silent: both are reported, diagnosis is no answer', async () => {
  const seen = await wait(machine((n) => (n === 0 ? { pid: 1234, commit: OLD, diskCommit: OLD } : new Error('refused'))), 1234);
  const text = upgrade.describeLastSeen(seen, { sha: NEW, pidBefore: 1234 });
  assert.match(text, /no answer \(refused\)/);
  assert.match(text, /before that: pid 1234 \(unchanged\)/);
  assert.match(text, /not answering/);
});

test('rollback wording is Spanish, with the same facts', async () => {
  const seen = await wait(machine({ pid: 1234, commit: NEW, diskCommit: NEW }), 1234, OLD);
  const text = upgrade.describeLastSeen(seen, { sha: OLD, pidBefore: 1234 }, 'es');
  assert.match(text, /^visto por última vez: pid 1234 \(sin cambio\)/);
  assert.match(text, /Diagnóstico: el reinicio no sustituyó/);
});

test('a runner that comes back as expected still resolves (healthy case)', async () => {
  const seen = {};
  const got = await upgrade.waitForRunner(machine((n) => (n < 2 ? new Error('down') : { pid: 9, commit: NEW, diskCommit: NEW })),
    (x) => x.pid !== 1 && x.commit === NEW, 500, seen);
  assert.equal(got.pid, 9);
  assert.equal(seen.failed, 2);
});

// --- the pre-check -------------------------------------------------------

const shWith = (stdout, extra = {}) => async () => ({ ok: true, code: 0, stdout, stderr: '', ...extra });
const show = (load, state, pid) => `LoadState=${load}\nActiveState=${state}\nMainPID=${pid}\n`;

test('pre-check: unit MainPID differs from the pid serving /info fails with both pids and the commands', async () => {
  const r = await upgrade.checkUnitPid(shWith(show('loaded', 'active', 111)), { pid: 222 });
  assert.equal(r.level, 'fail');
  assert.match(r.message, /pid 111/);
  assert.match(r.message, /pid 222/);
  assert.match(r.message, /kill 222/);
  assert.match(r.message, /systemctl --user restart hfsmon-runner\.service/);
});

test('pre-check: an inactive unit fails when a restart is needed, warns when not', async () => {
  const sh = shWith(show('loaded', 'inactive', 0));
  assert.equal((await upgrade.checkUnitPid(sh, { pid: 222 })).level, 'fail');
  assert.equal((await upgrade.checkUnitPid(sh, { pid: 222 }, { restartNeeded: false })).level, 'warn');
});

test('pre-check: matching pids are fine; a missing unit is fine only when no restart is coming', async () => {
  assert.equal((await upgrade.checkUnitPid(shWith(show('loaded', 'active', 222)), { pid: 222 })).level, 'ok');
  const gone = shWith(show('not-found', 'inactive', 0));
  assert.equal((await upgrade.checkUnitPid(gone, { pid: 222 }, { restartNeeded: false })).level, 'ok');
});

test('runnerUnitName: the unit from /info, validated; hfsmon-runner when absent or odd', () => {
  assert.equal(upgrade.runnerUnitName({ unit: 'livemon-runner.service' }), 'livemon-runner.service');
  assert.equal(upgrade.runnerUnitName({ unit: 'livemon-runner' }), 'livemon-runner.service');
  assert.equal(upgrade.runnerUnitName({ unit: 'app@1.service' }), 'app@1.service');
  for (const bad of [undefined, null, '', '.service', 42, 'x; rm -rf ~', 'a b', '$(id)', 'x\ny', '`id`.service']) {
    assert.equal(upgrade.runnerUnitName({ unit: bad }), 'hfsmon-runner.service', String(bad));
  }
  assert.equal(upgrade.runnerUnitName(null), 'hfsmon-runner.service');
});

test('pre-check: queries and names the unit from /info', async () => {
  const seenCmds = [];
  const sh = async (cmd) => { seenCmds.push(cmd); return { ok: true, code: 0, stdout: show('loaded', 'active', 111), stderr: '' }; };
  const r = await upgrade.checkUnitPid(sh, { pid: 222, unit: 'livemon-runner.service' });
  assert.match(seenCmds[0], /systemctl --user show livemon-runner\.service -p LoadState/);
  assert.equal(r.level, 'fail');
  assert.match(r.message, /livemon-runner\.service unit runs pid 111/);
  assert.match(r.message, /systemctl --user restart livemon-runner\.service/);
  assert.doesNotMatch(r.message, /hfsmon-runner/);
});

test('pre-check: an injected unit name is ignored and never reaches the shell', async () => {
  const seenCmds = [];
  const sh = async (cmd) => { seenCmds.push(cmd); return { ok: true, code: 0, stdout: show('loaded', 'active', 222), stderr: '' }; };
  await upgrade.checkUnitPid(sh, { pid: 222, unit: 'x; rm -rf ~' });
  assert.match(seenCmds[0], /show hfsmon-runner\.service -p/);
  assert.doesNotMatch(seenCmds[0], /rm -rf/);
});

test('pre-check: a unit that does not exist fails early when a restart is coming, naming it', async () => {
  const gone = shWith(show('not-found', 'inactive', 0));
  const r = await upgrade.checkUnitPid(gone, { pid: 222, unit: 'livemon-runner.service' });
  assert.equal(r.level, 'fail');
  assert.match(r.message, /the runner process \(pid 222\) is not managed by a systemd user unit named livemon-runner\.service: the board cannot restart it; start it under a user unit or restart it by hand/);
  assert.doesNotMatch(r.message, /older version/, 'the runner did report its unit: no old-runner hint');
});

test('pre-check: an old runner (no unit in /info) with no hfsmon-runner unit is told to restart once by hand', async () => {
  const gone = shWith(show('not-found', 'inactive', 0));
  const r = await upgrade.checkUnitPid(gone, { pid: 222 });
  assert.equal(r.level, 'fail');
  assert.match(r.message, /named hfsmon-runner\.service/);
  assert.match(r.message, /older version/);
  assert.match(r.message, /restart it once by hand/);
});

test('describeLastSeen names the real unit', () => {
  const text = upgrade.describeLastSeen({ info: { pid: 1234, commit: OLD, diskCommit: OLD } }, { sha: NEW, pidBefore: 1234, unit: 'livemon-runner.service' });
  assert.match(text, /check that the livemon-runner\.service unit/);
  assert.doesNotMatch(text, /hfsmon-runner/);
});

test('pre-check: a failing or throwing probe degrades to a warning', async () => {
  const bad = await upgrade.checkUnitPid(shWith('', { ok: false, code: 1, stderr: 'boom' }), { pid: 222 });
  assert.equal(bad.level, 'warn');
  const thrown = await upgrade.checkUnitPid(async () => { throw new Error('runner gone'); }, { pid: 222 });
  assert.equal(thrown.level, 'warn');
  assert.match(thrown.message, /runner gone/);
  const junk = await upgrade.checkUnitPid(shWith('hello'), { pid: 222 });
  assert.equal(junk.level, 'warn');
});
