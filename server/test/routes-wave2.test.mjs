import './isolate.mjs';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { removeTreeReported } from './teardown.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';

/**
 * Wave 2 routes, against the real board in its own process (the same way
 * `routes.test.mjs` does it): the tuning snapshot, «Cerrar huecos», the
 * reviewer search, what a new project is made of, and the public task's new
 * fields. The reviewer flow of `markReady` itself is tested with the pipeline.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
let dir;
let dataDir;
let port;
let child;

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

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port: p } = srv.address();
    srv.close(() => resolve(p));
  });
});

const task = (issue, title) => ({
  issue, title, labels: [], url: `https://example.invalid/${issue}`,
  state: 'assigned', log: [{ ts: '2026-09-30T00:00:00.000Z', phase: 'estado', line: title }], chats: [],
});

const project = (id, base, over = {}) => ({
  id, name: id, repoPath: base, worktreeRoot: `${base}-wt`,
  repo: null, assignee: 'nobody', overrides: {}, ...over,
});

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'hfsmon-routes2-'));
  dataDir = path.join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const withStack = path.join(dir, 'with-stack');
  const noStack = path.join(dir, 'no-stack');
  mkdirSync(withStack, { recursive: true });
  mkdirSync(noStack, { recursive: true });

  writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify({ 5: task(5, 'con stack') }));
  writeFileSync(path.join(dataDir, 'tasks.docs.json'), JSON.stringify({ 5: task(5, 'sin stack') }));
  writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([
    project('hfs', withStack),
    project('docs', noStack, { overrides: { e2e: null, stack: null } }),
  ]));

  port = await freePort();
  const configFile = path.join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    port,
    github: { repo: 'nobody/nothing-at-all', assignee: 'nobody', reviewer: 'config-reviewer' },
    poll: { intervalSeconds: 36000 },
    project: { repoPath: withStack, worktreeRoot: `${withStack}-wt` },
    stack: { command: 'npm start' },
    limits: { defaultMaxActiveTasks: 1, maxActiveTasksCeiling: 2, maxFixIterations: 1, completedShown: 5 },
    claude: {
      chatModel: 'sonnet', advisorModel: 'opus', fixModel: 'sonnet',
      available: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'fable', label: 'Fable' }],
    },
  }));

  child = spawn(process.execPath, [path.join('server', 'src', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, HFSMON_CONFIG: configFile, HFSMON_DATA_DIR: dataDir, HFSMON_NO_AUTOSTART: '1',
      // The server runs in its own process: the ceiling keeps git from finding a repository above the temp dir.
      GIT_CEILING_DIRECTORIES: [dir, tmpdir()].join(path.delimiter) },
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
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`el tablero no levantó:\n${log.join('')}`);
    await new Promise((r) => { setTimeout(r, 150); });
  }
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
  // `rmSync` does not wait for a Windows lock: see teardown.mjs.
  await removeTreeReported('routes-wave2', dir);
});

test('the public task carries fixGaps, fixGapsWanted and hasStack per project', async () => {
  const { body } = await call('GET', '/api/tasks');
  const mine = (p) => body.tasks.find((t) => t.project === p && t.issue === 5);
  assert.equal(mine('hfs').fixGaps, 'auto');
  assert.equal(typeof mine('hfs').fixGapsWanted, 'boolean');
  assert.equal(mine('hfs').hasStack, true, 'inherits the global stack');
  assert.equal(mine('docs').hasStack, false, 'a null stack override means none');
});

test('POST …/fix-gaps sets the tri-state, refuses anything else, and stays in its project', async () => {
  const on = await call('POST', '/api/projects/hfs/tasks/5/fix-gaps', { mode: 'on' });
  assert.equal(on.status, 200);
  assert.equal(on.body.fixGaps, 'on');
  const { body } = await call('GET', '/api/tasks');
  assert.equal(body.tasks.find((t) => t.project === 'hfs').fixGaps, 'on');
  assert.equal(body.tasks.find((t) => t.project === 'docs').fixGaps, 'auto', 'the other #5 is untouched');
  assert.equal((await call('POST', '/api/projects/hfs/tasks/5/fix-gaps', { mode: 'maybe' })).status, 400);
  assert.equal((await call('POST', '/api/projects/hfs/tasks/999/fix-gaps', { mode: 'on' })).status, 404);
});

test('GET /api/tuning answers the snapshot and POST /api/tuning validates', async () => {
  const snap = await call('GET', '/api/tuning');
  assert.equal(snap.status, 200);
  assert.ok(snap.body.roles?.fix, 'one entry per role');
  assert.ok(Array.isArray(snap.body.models));
  assert.ok(snap.body.models.some((m) => m.id === 'fable'), 'Fable is offered');

  const bad = await call('POST', '/api/tuning', { roles: { nonsense: { effort: 'high' } } });
  assert.equal(bad.status, 400);

  const ok = await call('POST', '/api/tuning', { roles: { fix: { effort: 'high' } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.roles.fix.effort, 'high');
  const cleared = await call('POST', '/api/tuning', { roles: { fix: { effort: null } } });
  assert.equal(cleared.status, 200);
  assert.notEqual(cleared.body.roles.fix.effort, 'high', 'null removes the override');
});

test('GET …/reviewers: 404 for an unknown project', async () => {
  assert.equal((await call('GET', '/api/projects/nope/reviewers?q=a')).status, 404);
});

test('a new project gets no reviewer, the requested assignee, its profile and a detected base branch', async () => {
  const repoPath = path.join(dir, 'Notes');
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(path.join(repoPath, 'README.md'), '# notes\n');
  execFileSync('git', ['init', '-b', 'trunk', repoPath], { stdio: 'pipe' });

  const created = await call('POST', '/api/projects', { repoPath, assignee: 'someone', language: 'es' });
  assert.equal(created.status, 201);
  assert.equal(created.body.reviewer ?? null, null, 'config.github.reviewer is not inherited');
  assert.equal(created.body.assignee, 'someone');
  assert.equal(created.body.kind, 'docs-research', 'detected from the markdown-only checkout');
  assert.deepEqual(created.body.overrides, { e2e: null, stack: null, qa: null });
  assert.equal(created.body.baseBranch, 'trunk');
  assert.equal(created.body.language, 'es');

  const fallback = path.join(dir, 'Other');
  mkdirSync(fallback, { recursive: true });
  const explicit = await call('POST', '/api/projects', {
    repoPath: fallback, kind: 'python', baseBranch: 'develop', reviewer: 'alice',
  });
  assert.equal(explicit.status, 201);
  assert.equal(explicit.body.kind, 'python');
  assert.equal(explicit.body.baseBranch, 'develop');
  assert.equal(explicit.body.reviewer, 'alice');
  assert.equal(explicit.body.assignee, 'nobody', 'the board assignee when the request names none');

  const bad = path.join(dir, 'Third');
  mkdirSync(bad, { recursive: true });
  const wrong = await call('POST', '/api/projects', { repoPath: bad, kind: 'cobol' });
  assert.equal(wrong.status, 400);
  const stored = JSON.parse(readFileSync(path.join(dataDir, 'projects.json'), 'utf8'));
  assert.ok(!stored.some((p) => p.id === 'third'), 'a refused import writes nothing');
});

test('the model route accepts an effort in the body, per chat', async () => {
  // The chat does not exist, so 400; what matters is that the route does not
  // choke on `effort` and answers with the pipeline's own refusal.
  const r = await call('POST', '/api/projects/hfs/tasks/5/model', { chatId: 'nope', model: 'sonnet', effort: 'high' });
  assert.equal(r.status, 400);
  assert.ok(r.body.error);
});

const chatOf = async (project, issue) => {
  const { body } = await call('GET', '/api/tasks');
  return body.tasks.find((t) => t.project === project && t.issue === issue).chats[0];
};

test('the model route: an absent key keeps its value, null clears it, thinking is validated (400) and exposed', async () => {
  const route = '/api/projects/hfs/tasks/5/model';
  assert.equal((await call('POST', route, { model: 'opus', effort: 'xhigh' })).status, 200);
  let chat = await chatOf('hfs', 5);
  assert.equal(chat.model, 'opus');
  assert.equal(chat.effort, 'xhigh');
  assert.equal(chat.thinking, null, 'inherits the role «chat»');
  assert.equal(chat.effectiveEffort, 'xhigh');
  assert.equal(chat.lastTurnAt, null);

  // Only a thinking: the model and the effort stay.
  const t = await call('POST', route, { thinking: { type: 'adaptive' } });
  assert.equal(t.status, 200);
  assert.equal(t.body.model, 'opus');
  chat = await chatOf('hfs', 5);
  assert.deepEqual([chat.model, chat.effort, chat.thinking], ['opus', 'xhigh', { type: 'adaptive' }]);

  // A mode the model does not take and a bad shape: 400, nothing changes.
  for (const thinking of [{ type: 'enabled', budgetTokens: 2000 }, { type: 'disabled' }, { type: 'enabled', budgetTokens: 5 }, 'sideways']) {
    const bad = await call('POST', route, { thinking });
    assert.equal(bad.status, 400, JSON.stringify(thinking));
    assert.ok(bad.body.error);
  }
  chat = await chatOf('hfs', 5);
  assert.deepEqual(chat.thinking, { type: 'adaptive' });

  // An effort the model lacks is not a 400 any more.
  assert.equal((await call('POST', route, { effort: 'max' })).status, 200);

  // auto and null.
  assert.equal((await call('POST', route, { thinking: 'auto' })).status, 200);
  assert.equal((await chatOf('hfs', 5)).thinking, 'auto');
  assert.equal((await call('POST', route, { thinking: null, model: null, effort: null })).status, 200);
  chat = await chatOf('hfs', 5);
  assert.deepEqual([chat.model, chat.effort, chat.thinking, chat.effectiveEffort], [null, null, null, null]);
});

test('POST /api/tuning: thinking per role (400 when the model lacks it), dismissModel, contextWindow ignored', async () => {
  const bad = await call('POST', '/api/tuning', { roles: { fix: { thinking: { type: 'enabled', budgetTokens: 2000 } } } });
  assert.equal(bad.status, 400);   // fix runs on sonnet here: adaptive only
  const ok = await call('POST', '/api/tuning', { roles: { fix: { thinking: { type: 'adaptive' }, effort: 'xhigh' } } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.roles.fix.thinking, { type: 'adaptive' });
  assert.equal(ok.body.roles.fix.effort, 'xhigh', 'the effort is stored as chosen');
  assert.ok(ok.body.roles.fix.effectiveEffort, 'and the snapshot says what the model will get');
  // A model-only patch whose stored thinking no longer fits is refused: no such model here, so check the snapshot shape instead.
  assert.ok(Array.isArray(ok.body.models[0].thinking));
  assert.equal('contextWindow' in ok.body, false);
  assert.ok(Array.isArray(ok.body.newModels));

  const ignored = await call('POST', '/api/tuning', { contextWindow: '1m' });
  assert.equal(ignored.status, 200);
  assert.equal('contextWindow' in ignored.body, false);

  const dismissed = await call('POST', '/api/tuning', { dismissModel: 'claude-opus-9-9' });
  assert.equal(dismissed.status, 200);
  assert.deepEqual(dismissed.body.overrides.dismissedModels, ['claude-opus-9-9']);
  assert.equal((await call('POST', '/api/tuning', { dismissModel: '' })).status, 400);
  assert.equal((await call('POST', '/api/tuning', { dismissModel: 'not an id;' })).status, 400);

  const cleared = await call('POST', '/api/tuning', { roles: { fix: null } });
  assert.equal(cleared.body.roles.fix.thinking, 'auto');
});

test('the ready route passes the reviewer options through (source check)', () => {
  const src = readFileSync(path.join(ROOT, 'server', 'src', 'index.js'), 'utf8');
  const block = src.slice(src.indexOf("/tasks/:issue/ready'"), src.indexOf("/tasks/:issue/merge-main'"));
  for (const key of ['force', 'reviewer', 'noReviewer', 'always']) assert.match(block, new RegExp(`\\b${key}\\b`));
  assert.ok(!/\bremember\b/.test(block), 'no `remember` option: the pick is remembered whenever a reviewer is set');
});

test('POST …/reviewer: sets, clears and validates the project reviewer choice; the public project carries it', async () => {
  const pub = async () => (await call('GET', '/api/projects')).body.projects.find((p) => p.id === 'docs');
  const set = await call('POST', '/api/projects/docs/reviewer', { reviewer: 'zoe' });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.project, { id: 'docs', reviewer: 'zoe', noReviewer: false, lastReviewer: null });
  assert.equal((await pub()).reviewer, 'zoe');

  const none = await call('POST', '/api/projects/docs/reviewer', { noReviewer: true });
  assert.deepEqual(none.body.project, { id: 'docs', reviewer: null, noReviewer: true, lastReviewer: null });
  const shown = await pub();
  assert.equal(shown.noReviewer, true);
  assert.equal(shown.reviewer, null);
  assert.ok(!JSON.stringify(shown).includes('token'), 'the public project carries no token');

  const cleared = await call('POST', '/api/projects/docs/reviewer', { reviewer: null, noReviewer: false });
  assert.deepEqual(cleared.body.project, { id: 'docs', reviewer: null, noReviewer: false, lastReviewer: null });

  assert.equal((await call('POST', '/api/projects/docs/reviewer', { reviewer: 'a b' })).status, 400);
  assert.equal((await call('POST', '/api/projects/docs/reviewer', { reviewer: '-x' })).status, 400);
  const blank = await call('POST', '/api/projects/docs/reviewer', { reviewer: '   ' });
  assert.equal(blank.status, 400);
  assert.match(blank.body.error, /empty login/);
  assert.equal((await call('POST', '/api/projects/docs/reviewer', { reviewer: '' })).status, 400);
  assert.equal((await call('POST', '/api/projects/nope/reviewer', { reviewer: 'zoe' })).status, 400);
  assert.equal((await call('POST', '/api/projects/docs/reviewer', {})).status, 400);
  assert.equal((await pub()).reviewer, null, 'a refused choice changed nothing');
});

test('POST …/bootstrap-repo: 400 without confirm, 404 for an unknown task, 409 when not an empty repository; the public task carries errorCode', async () => {
  const mine = (await call('GET', '/api/tasks')).body.tasks.find((t) => t.project === 'hfs' && t.issue === 5);
  assert.equal(mine.errorCode ?? null, null);
  assert.equal(mine.errorInfo ?? null, null);

  const bare = await call('POST', '/api/projects/hfs/tasks/5/bootstrap-repo');
  assert.equal(bare.status, 400);
  assert.equal(bare.body.code, 'confirm_required');
  assert.equal((await call('POST', '/api/projects/hfs/tasks/5/bootstrap-repo', { confirm: false })).status, 400);
  assert.equal((await call('POST', '/api/projects/hfs/tasks/999/bootstrap-repo', { confirm: true })).status, 404);

  // The checkout of this fixture is a plain directory with no repository: nothing
  // to bootstrap, and nothing written.
  const notEmpty = await call('POST', '/api/projects/hfs/tasks/5/bootstrap-repo', { confirm: true });
  assert.equal(notEmpty.status, 409);
  assert.equal(notEmpty.body.code, 'no_longer_empty');
});

test('POST /api/projects/:project/base-branch: 404 unknown project, 400 for a missing body or an invalid name, 502 when origin cannot be asked; nothing changes', async () => {
  const pub = async () => (await call('GET', '/api/projects')).body.projects.find((p) => p.id === 'docs');
  const before = (await pub()).baseBranch ?? null;

  assert.equal((await call('POST', '/api/projects/nope/base-branch', { baseBranch: 'main' })).status, 404);
  const noBody = await call('POST', '/api/projects/docs/base-branch');
  assert.equal(noBody.status, 400);
  assert.equal((await call('POST', '/api/projects/docs/base-branch', {})).status, 400);
  assert.equal((await call('POST', '/api/projects/docs/base-branch', { baseBranch: 7 })).status, 400);
  for (const baseBranch of ['+main', '@', 'a..b', '-x', '  ']) {
    const r = await call('POST', '/api/projects/docs/base-branch', { baseBranch });
    assert.equal(r.status, 400, JSON.stringify(baseBranch));
    assert.equal(r.body.code, 'bad_base');
  }
  assert.equal((await call('POST', '/api/projects/docs/base-branch', { baseBranch: 'main', issue: 'abc' })).status, 400);
  assert.equal((await call('POST', '/api/projects/docs/base-branch', { baseBranch: 'main', issue: 999 })).status, 404);

  // The fixture checkout is a plain directory with no repository: origin cannot be asked.
  const unreachable = await call('POST', '/api/projects/docs/base-branch', { baseBranch: 'main' });
  assert.equal(unreachable.status, 502);
  assert.equal(unreachable.body.code, 'remote_unreachable');
  assert.equal((await pub()).baseBranch ?? null, before, 'a refused change wrote nothing');
});

test('POST …/design sets the mark from a strict boolean and stays in its project', async () => {
  const before = (await call('GET', '/api/tasks')).body.tasks;
  assert.equal(before.find((t) => t.project === 'hfs').design, false, 'a legacy task is born off');
  const on = await call('POST', '/api/projects/hfs/tasks/5/design', { on: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.design, true);
  const { body } = await call('GET', '/api/tasks');
  assert.equal(body.tasks.find((t) => t.project === 'hfs').design, true);
  assert.equal(body.tasks.find((t) => t.project === 'docs').design, false, 'the other #5 is untouched');
  for (const bad of ['true', 1, null, undefined]) {
    assert.equal((await call('POST', '/api/projects/hfs/tasks/5/design', { on: bad })).status, 400, `refuses ${JSON.stringify(bad)}`);
  }
  assert.equal((await call('POST', '/api/projects/hfs/tasks/999/design', { on: true })).status, 404);
  assert.equal((await call('POST', '/api/projects/hfs/tasks/5/design', { on: false })).body.design, false);
});
