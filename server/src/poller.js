import { EventEmitter } from 'node:events';
import { config, configEvents } from './config.js';
import { settings } from './settings.js';
import { store } from './store.js';
import { listAssignedIssues, listClosedAssignedIssues, getIssue, issueStates, assigneeOf } from './github.js';
import { listProjects } from './projects.js';
import { viewedProjects, viewerEvents } from './viewers.js';
import { makeKey, keyOf } from './keys.js';
import { listAllBranches } from './worktree.js';
import {
  tick, refreshClassification, reopenIfNeeded, checkChangeRequests, isRunning, refreshBranchStatus, refreshChecks,
  clearClosedWithoutPr, completeOnIssueClosed, settleUnassigned, refreshGitNow,
} from './pipeline.js';
import { findManualKeyword, shouldAskAboutMode } from './mode.js';
import { evaluateQuota } from './quota.js';
import * as pipelineNs from './pipeline.js';
import { Semaphore } from './exec.js';
import { refreshStackHealth } from './stack.js';

/**
 * Asks, when the word "manual" turns up in an issue the board has not started.
 *
 * It only ever asks. Deciding for you is what went wrong before: the word
 * shows up in ordinary English — #955 was marked manual over "without a manual
 * page reload" — and a wrong guess used to change what the board did with the
 * task. Now the card just stops and waits, so a false positive costs one click.
 *
 * Title and labels ride along with the listing and are free, so they are read
 * every cycle: adding the `manual` label on GitHub works at any moment. The
 * body costs a `gh issue view`, so it is read once per task and no more — a
 * long backlog must not turn each cycle into one fetch per task.
 */
async function askAboutModeIfSuspicious(task, issue, busy) {
  if (!shouldAskAboutMode(task, issue, { running: busy })) return;

  let found = findManualKeyword(issue);
  if (!found && !task.bodyCheckedForMode) {
    try {
      found = findManualKeyword(await getIssue(issue.number, task.project));
      task.bodyCheckedForMode = true;
    } catch (e) {
      // Only a real answer closes the question: a `gh` that failed says
      // nothing about the body, so the next cycle may try again.
      store.addLog(task, 'modo', `⚠️ could not read the issue body: ${e.message}`);
    }
    store.touch(task);
  }
  if (!found) return;

  task.mode = 'unconfirmed';
  task.suspect = found;
  const where = found.where === 'etiqueta' ? 'a label' : found.where === 'título' ? 'the title' : 'the body';
  store.addLog(task, 'modo', `the word "manual" appears in ${where} of the issue: «${found.quote}». The task waits for you to confirm whether it is automatic or manual; nothing has been done.`);
  store.touch(task);
}

/**
 * Compares who GitHub says an issue is assigned to against the project's
 * owner, and keeps `task.unassigned` in step: the mark that hides a task the
 * board no longer owns, and the clearing of it when it is assigned back.
 *
 * Reversible by design: only the mark and the cleanup live here, never the
 * task's state. A row without `assignees` is «unknown», never «nobody», so a
 * listing that cannot say leaves everything as it was. Never throws.
 *
 * @param {Object} task
 * @param {{assignees?: string[]}} row
 * @param {{settle?: Function}} [deps]
 * @returns {Promise<'marked'|'restored'|'none'>}
 */
export async function noteAssignees(task, row, { settle = settleUnassigned } = {}) {
  try {
    if (!task || !Array.isArray(row?.assignees)) return 'none';

    const owner = String(assigneeOf(task.project)).toLowerCase();
    const isOwner = row.assignees.some((a) => String(a).toLowerCase() === owner);

    if (isOwner) {
      if (!task.unassigned) return 'none';
      task.unassigned = null;
      store.addLog(task, 'poll', 'the task is assigned to you again');
      store.touch(task);
      return 'restored';
    }

    // A finished or closed task is never newly hidden (it is in the Completed
    // column, nothing runs on it); an existing mark was cleared above even so.
    if (!task.unassigned && (task.state === 'done' || task.issueClosed || row.closed === true)) return 'none';

    const fresh = !task.unassigned;
    if (fresh) {
      task.unassigned = { at: new Date().toISOString(), to: [...row.assignees], settled: false };
      store.addLog(task, 'poll', row.assignees.length
        ? `the task was reassigned on GitHub to ${row.assignees.join(', ')}`
        : 'the task was left unassigned on GitHub');
      store.touch(task);
    } else if (task.unassigned.settled) {
      return 'none';
    }

    const result = await settle(task);
    if (result === 'running' && fresh) {
      store.addLog(task, 'poll', '⚠️ the task was reassigned with a run in progress: nothing has been interrupted');
      store.touch(task);
    }
    return fresh ? 'marked' : 'none';
  } catch (e) {
    try { store.addLog(task, 'poll', `⚠️ could not check the assignment: ${e.message}`); } catch { /* never throws */ }
    return 'none';
  }
}

// The last reopen-check failure said per task: a GitHub that keeps failing the
// same way writes one line, not one per cycle. Keyed by the composite key and
// not by the bare issue number — two projects both stuck on their own #12
// would otherwise silence each other's warning.
const reopenFailures = new Map();

/**
 * Records what the listing says about a task the board already has, and
 * checks whether the issue came back. Exported with its dependencies as
 * parameters so a test can drive it without `gh`.
 *
 * This is the single place in the board that learns an issue is closed — the
 * listing fold and {@link sweepClosedIssues} both come through here — so the
 * completion hangs off the FLIP itself: `!was` is true exactly once per close,
 * which makes the warning below once-only with no new field on the task. A
 * later cycle finds `was` already true and says nothing; an issue reopened and
 * closed again flips again and warns again, which is the truth about it.
 */
export async function noteIssue(task, issue, { reopen = reopenIfNeeded, complete = completeOnIssueClosed } = {}) {
  // Read before it is overwritten: what the last cycle saw is the one clue
  // that the issue was closed and is open again.
  const was = task.issueClosed;
  task.title = issue.title;
  task.labels = issue.labels;
  if (issue.closed) {
    task.issueClosed = true;
    if (!was && complete(task) === 'running') {
      // Nothing was written and nothing was interrupted: a run in flight is
      // never yanked out from under itself. The line is for a person to read.
      // «en marcha», not «trabajando»: a plan waiting for your approval holds
      // its pipeline too, and nothing there is working.
      store.addLog(task, 'poll', '⚠️ the issue was closed on GitHub with a run in progress: nothing has been interrupted, you decide whether to stop it.');
    }
  } else {
    // A reopened issue whose work was merged starts a new cycle. When GitHub
    // cannot be asked, nothing is recorded — not even that the issue is
    // open — so the next cycle asks again from the same place.
    const key = keyOf(task);
    try {
      await reopen(task, was);
      task.issueClosed = false;
      // This branch is the ONLY place in the board that ever finds out an
      // issue is open again. A task closed without a PR would otherwise keep
      // that mark for ever: no button clears it, and the window would go on
      // saying «cerrada sin PR» about an issue somebody reopened.
      clearClosedWithoutPr(task);
      reopenFailures.delete(key);
    } catch (e) {
      if (reopenFailures.get(key) !== e.message) {
        reopenFailures.set(key, e.message);
        store.addLog(task, 'guard', `⚠️ could not check whether the issue was reopened: ${e.message}`);
      }
    }
  }
  store.touch(task);
}

// The last sweep failure said per PROJECT, not per task: the question is about
// a repository, one `gh api graphql` answers for all of its issues at once, and
// nothing is written on any task. Same idiom as `reopenFailures` above.
const sweepFailures = new Map();

/** The sweep's one dependency, replaceable in tests. */
export const SWEEP_STEPS = { issueStates };

/**
 * Asks GitHub, by number, about the board's own tasks — the ones this cycle's
 * listings did not answer for.
 *
 * Why it exists: `gh issue list --state closed --limit N` sorts by issue NUMBER
 * descending, not by closing date. #1126 sits at index 17 and #937 at index 30
 * of the closed list although they were the two most recently closed, so the
 * fold never saw them and their `issueClosed` stayed false for ever. This asks
 * by number instead: one batched call per project per cycle, never a repo-wide
 * scan and never a bigger listing.
 *
 * Every write goes through {@link noteIssue}, untouched, which is what keeps
 * the `was` protocol, the reopen contract and «a failed `gh` writes nothing»
 * in one place.
 *
 * @param {import('./keys.js').Project} project
 * @param {Set<number>} seen the issue numbers this cycle's listings answered
 *   for, for this project. Asking about them again would cost a call to learn
 *   what the fold just recorded.
 * @param {{steps?: {issueStates: Function}, note?: Function, complete?: Function}} [deps]
 * @returns {Promise<{asked: number, flipped: number, settled: number}>}
 */
export async function sweepClosedIssues(project, seen, {
  steps = SWEEP_STEPS, note = noteIssue, complete = completeOnIssueClosed,
  assignees = noteAssignees, settle = settleUnassigned,
} = {}) {
  const counts = { asked: 0, flipped: 0, settled: 0 };
  const mine = store.all().filter((t) => t.project === project.id);
  // The tasks the board may be wrong about: anything not already resting in
  // «Completada» with the flag set. A `done` task whose flag is true is the
  // one shape no answer could change.
  const candidates = mine.filter((t) => (t.state !== 'done' || t.issueClosed !== true) && !seen.has(t.issue));

  if (candidates.length) {
    counts.asked = candidates.length;
    const rows = await steps.issueStates(candidates.map((t) => t.issue), project.id);
    for (const task of candidates) {
      const row = rows.get(task.issue);
      // Absent from the answer is not an answer about closedness: a number that
      // is a pull request, or an issue deleted or transferred away. Recording
      // it as open would quietly reopen a task GitHub knows nothing about.
      if (!row) continue;
      await assignees(task, row);
      if (row.closed === (task.issueClosed === true)) continue;   // already believed
      await note(task, row);
      counts.flipped += 1;
    }
  }

  // The catch-up: a task in `error` or `plan_ready` whose issue IS inside the
  // 12-row listing gets its flag flipped by the fold, but `refreshClassification`
  // returns at its `CLASSIFIABLE` gate for those two states, so nothing would
  // ever settle it. Idempotent (`'skip'` once the task is `done`) and free — no
  // network, and it writes only through `completeOnIssueClosed`'s own line.
  for (const task of mine) {
    if (task.issueClosed !== true || task.state === 'done') continue;
    if (complete(task) === 'done') counts.settled += 1;
  }

  // A reassignment whose cleanup was deferred (a run was in flight, a chat busy):
  // retried here, once per cycle, until it settles.
  for (const task of mine) {
    if (!task.unassigned || task.unassigned.settled) continue;
    try { await settle(task); } catch { /* retried next cycle */ }
  }
  return counts;
}

let inFlight = null;
let startedAt = null;
let current = null;
let lastPollAt = null;
/** What the last finished cycle found; null before any. */
let lastResult = null;

/** The phases of a cycle, in order; `stepIndex` is the 1-based position here. Phases overlap in time. */
export const POLL_STEPS = ['listing', 'sweep', 'fetch', 'classify', 'branches', 'checks', 'crs'];
const emptyPhases = () => Object.fromEntries(POLL_STEPS.map((n) => [n, { done: 0, total: 0 }]));
const idleProgress = () => ({
  step: null, stepIndex: 0, stepCount: POLL_STEPS.length, done: 0, total: 0, project: null, progressAt: null, phases: emptyPhases(),
});
let progress = idleProgress();
/** Phases of the running cycle that have begun (a phase with total 0 may still be «started»). */
let startedPhases = new Set();

/** A cycle running longer than this is abandoned from the flag's point of view. */
const WATCHDOG_MS = 10 * 60_000;
/** Inside a loop the 'poll' event goes out at most this often (a trailing emit keeps the final count). */
const EMIT_THROTTLE_MS = 1_000;
const hooks = { watchdogMs: WATCHDOG_MS, runCycle: null, steps: {}, throttleMs: EMIT_THROTTLE_MS, projects: null };

/**
 * Test seam: inject the watchdog timeout, the cycle body, replacements for the
 * pieces of a cycle (`steps`: pollProject, sweepClosedIssues, listAllBranches,
 * refreshClassification, refreshBranchStatus, refreshStackHealth, refreshChecks,
 * checkChangeRequests, tick, evaluateQuota, listTasks), the emit throttle and
 * `projects` (a function replacing listProjects).
 * Call with no argument to reset.
 */
export function setPollTestHooks({ watchdogMs, runCycle, steps, throttleMs, projects } = {}) {
  hooks.projects = projects ?? null;
  pending.clear();
  hooks.watchdogMs = watchdogMs ?? WATCHDOG_MS;
  hooks.runCycle = runCycle ?? null;
  hooks.steps = steps ?? {};
  hooks.throttleMs = throttleMs ?? EMIT_THROTTLE_MS;
}

/**
 * When each project's issue list was last asked for, in milliseconds — stamped
 * at the START of its round, not at the end, so the spacing measured is
 * between one round and the next and never grows by however long GitHub took.
 *
 * @type {Map<string, number>}
 */
const lastPolledAt = new Map();

/**
 * How early a project may still count as due. The timer runs at the shortest
 * interval any project asks for, so a project at an exact multiple of it lands
 * on the tick where `now - last` is a hair under its own period; without this
 * slack that project would skip a turn and effectively poll at twice its
 * interval.
 */
const DUE_SLACK_MS = 1_000;

/** Emits 'poll' when a cycle ends, so the board's "last search" label ages
    from the real thing instead of from the page's last reload. */
export const pollEvents = new EventEmitter();

/** The levels of the running cycle: which projects get the full chain and which the light one. */
let scope = { full: [], light: [] };
/** Requests that arrived while a cycle ran: project id -> 'full' | 'light' (full wins). Run as one follow-up cycle. */
const pending = new Map();
const knownProjects = () => (hooks.projects ?? listProjects)();

export const pollStatus = () => ({
  scope: inFlight ? { full: [...scope.full], light: [...scope.light] } : { full: [], light: [] },
  lastPollAt,
  running: Boolean(inFlight),
  startedAt: inFlight ? startedAt : null,
  ...progress,
  cancelling: Boolean(inFlight && current?.cancelled),
  last: lastResult,
});

let lastEmitAt = 0;
let trailing = null;

function emitNow() {
  if (trailing) { clearTimeout(trailing); trailing = null; }
  lastEmitAt = Date.now();
  pollEvents.emit('poll', pollStatus());
}

/**
 * The phase shown as «current»: the lowest-index one that has started and is
 * unfinished; when everything started so far is finished (the cycle is between
 * discoveries), the highest-index started one, so a running cycle never reads idle.
 */
function currentStep(phases) {
  let last = null;
  for (const name of POLL_STEPS) {
    if (!startedPhases.has(name)) continue;
    last = name;
    if (phases[name].done < phases[name].total) return name;
  }
  return last;
}

function withDerived(phases, project) {
  const step = currentStep(phases);
  let done = 0;
  let total = 0;
  for (const name of POLL_STEPS) { done += phases[name].done; total += phases[name].total; }
  return {
    step, stepIndex: step ? POLL_STEPS.indexOf(step) + 1 : 0, stepCount: POLL_STEPS.length,
    done, total, project, progressAt: Date.now(), phases,
  };
}

/** Work of `phase` discovered: its total grows by `n` (never shrinks) and the phase counts as started. */
function progressAdd(token, phase, n = 1) {
  if (current !== token) return;
  const before = progress.step;
  startedPhases.add(phase);
  const phases = { ...progress.phases, [phase]: { ...progress.phases[phase], total: progress.phases[phase].total + n } };
  progress = withDerived(phases, progress.project);
  if (progress.step !== before) emitNow(); else throttledEmit();
}

/** One unit of `phase` finished: counted at once, announced at most once per throttle window, plus phase-change emits. */
function progressBump(token, phase, project = null) {
  if (current !== token) return;
  const before = progress.step;
  const cur = progress.phases[phase];
  const phases = { ...progress.phases, [phase]: { ...cur, done: Math.min(cur.total, cur.done + 1) } };
  progress = withDerived(phases, project);
  if (progress.step !== before) emitNow(); else throttledEmit();
}

function throttledEmit() {
  const wait = hooks.throttleMs - (Date.now() - lastEmitAt);
  if (wait <= 0) { emitNow(); return; }
  if (!trailing) {
    trailing = setTimeout(emitNow, wait);
    trailing.unref?.();
  }
}

/**
 * Is it this project's turn? A project never polled is always due.
 *
 * @param {import('./keys.js').Project} project
 * @param {number} now
 */
function isDue(project, now) {
  const last = lastPolledAt.get(project.id);
  if (last === undefined) return true;
  const minutes = settings.pollIntervalMinutesFor(project.id);
  return now - last >= minutes * 60_000 - DUE_SLACK_MS;
}

/** Clears the running flag if `token` is still the current cycle, then announces the final state. */
function release(token, result) {
  if (current !== token) return;
  current = null;
  inFlight = null;
  startedAt = null;
  if (trailing) emitNow();
  progress = idleProgress();
  startedPhases = new Set();
  lastResult = {
    tasks: result?.tasks ?? 0,
    changeRequests: result?.changeRequests ?? 0,
    swept: result?.swept ?? 0,
    error: result?.error ?? null,
    finishedAt: new Date().toISOString(),
  };
  scope = { full: [], light: [] };
  emitNow();
  if (pending.size) queueMicrotask(drainPending);
}

/**
 * Runs one cycle. The Fetch button calls this very function, so what a
 * click does is exactly what the timer does — one code path, nothing to drift.
 * A second call while one is running joins it instead of starting another:
 * two concurrent `gh issue list` add nothing but load.
 *
 * @param {Object} [options]
 * @param {boolean} [options.scheduled] set only by the timer. The timer ticks
 *   at the shortest interval any project asks for, so it polls only the
 *   projects whose own interval has elapsed; a click polls every project,
 *   because "Buscar ahora" means now and means all of them.
 */
export function pollNow(options) {
  return startPoll(options).promise;
}

/**
 * Starts a cycle unless one is running. `started` says which of the two
 * happened; `promise` settles when the cycle ends either way.
 *
 * @param {Object} [options] same as {@link pollNow}
 */
export function startPoll({ scheduled = false, project = null } = {}) {
  const plan = planFor({ scheduled, project });
  if (inFlight) {
    queueRequest(plan);
    return { started: false, promise: inFlight };
  }
  return { started: true, promise: launch(plan) };
}

/**
 * Which projects a request covers and at which level. An explicit `project`
 * means that one, full, alone. Otherwise: the viewed projects get the full
 * chain and every other the light one; `scheduled` keeps only the due ones.
 * With nobody viewing, everything is light.
 */
function planFor({ scheduled, project }) {
  const all = knownProjects();
  if (project) return new Map(all.filter((p) => p.id === project).map((p) => [p.id, 'full']));
  const now = Date.now();
  const viewed = viewedProjects();
  const due = scheduled ? all.filter((p) => isDue(p, now)) : all;
  return new Map(due.map((p) => [p.id, viewed.has(p.id) ? 'full' : 'light']));
}

/** Adds a plan to the follow-up set, skipping what the running cycle already does at that level or better. */
function queueRequest(plan) {
  for (const [id, level] of plan) {
    if (scope.full.includes(id) || (level === 'light' && scope.light.includes(id))) continue;
    if (pending.get(id) !== 'full') pending.set(id, level);
  }
}

function drainPending() {
  if (inFlight || !pending.size) return;
  const plan = new Map(pending);
  pending.clear();
  launch(plan).catch(() => {});
}

function launch(plan) {
  const due = knownProjects().filter((p) => plan.has(p.id));
  const now = Date.now();
  for (const project of due) lastPolledAt.set(project.id, now);
  scope = {
    full: due.filter((p) => plan.get(p.id) === 'full').map((p) => p.id),
    light: due.filter((p) => plan.get(p.id) === 'light').map((p) => p.id),
  };
  // One token per cycle: cancelling or abandoning this one can never reach the next.
  const token = { cancelled: false };
  const timeout = new Promise((resolve) => {
    token.timer = setTimeout(() => {
      if (current !== token) return;
      console.warn(`poll: the cycle ran over ${Math.round(hooks.watchdogMs / 1000)} s; abandoning it so a new one can start`);
      // The abandoned cycle must stop starting work, or it would overlap the next one.
      token.cancelled = true;
      const result = { error: 'poll watchdog: the cycle was abandoned' };
      release(token, result);
      resolve(result);
    }, hooks.watchdogMs);
    token.timer.unref?.();
  });
  current = token;
  startedAt = Date.now();
  progress = idleProgress();
  startedPhases = new Set();
  const levels = new Map(due.map((p) => [p.id, plan.get(p.id)]));
  const body = Promise.resolve().then(() => (hooks.runCycle ?? runCycle)(due, token, levels));
  const promise = Promise.race([body, timeout])
    .then((result) => { clearTimeout(token.timer); release(token, result); return result; },
      (e) => { clearTimeout(token.timer); release(token, { error: e?.message ?? String(e) }); throw e; });
  inFlight = promise;
  // Announced at the start, so every open board shows the cycle running and
  // not just the tab whose button started it. The end is announced by
  // `release`, after the flag is cleared.
  emitNow();
  return promise;
}

/**
 * A project just became viewed: its full cycle starts now (or right after the
 * running one). Returns the stop function.
 */
export function watchViewers() {
  const onViewed = ({ project, added }) => {
    if (!added) return;
    const { promise } = startPoll({ project });
    promise.catch(() => {});
  };
  viewerEvents.on('viewed', onViewed);
  return () => viewerEvents.off('viewed', onViewed);
}

/**
 * Asks the running cycle to stop: no new project or task is started, the ones
 * in flight finish, and the cycle then ends. A no-op when nothing runs.
 */
export function cancelPoll() {
  pending.clear();
  if (inFlight && current && !current.cancelled) {
    current.cancelled = true;
    emitNow();
  }
  return pollStatus();
}

/**
 * One project's issue listing, folded into the store. Its own function so that
 * a project whose `gh` fails costs only its own issues: the other projects and
 * every per-task sweep below still run.
 *
 * @param {import('./keys.js').Project} project
 * @param {{tasks: number}} found
 * @param {Set<number>} seen filled with every number this listing answered for,
 *   so {@link sweepClosedIssues} does not pay a call to ask about it again.
 */
async function pollProject(project, found, seen) {
  const [open, closed] = await Promise.all([
    listAssignedIssues(project.id),
    listClosedAssignedIssues(config.limits.completedShown, project.id),
  ]);

  for (const issue of [...open, ...closed]) {
    // First thing in the body: whatever happens below, this listing has an
    // answer about this number and the sweep must not pay to ask again.
    seen.add(issue.number);
    // The composite key, never the bare number: #12 of one project and #12 of
    // another are two tasks, and `store.get(12)` would hand back whichever of
    // them the default project happens to own.
    const key = makeKey(project.id, issue.number);
    let task = store.get(key);
    if (task) {
      await noteAssignees(task, issue);
      await noteIssue(task, issue);
    } else {
      task = store.addTask(issue, project.id);
      task.issueClosed = issue.closed;
      store.addLog(task, 'poll', `task assigned on GitHub: #${issue.number} ${issue.title}`);
      found.tasks++;
    }
    if (!task.unassigned) await askAboutModeIfSuspicious(task, issue, isRunning(key));
  }
}

/** The pieces of a cycle a test may replace; anything left out is the real one. */
const realSteps = () => ({
  pollProject, sweepClosedIssues, listAllBranches, refreshClassification, refreshBranchStatus,
  refreshStackHealth, refreshChecks, checkChangeRequests, tick, evaluateQuota,
  // The two halves of the checks (pipeline contract); absent -> the old whole-project refreshChecks is used.
  settledDone: pipelineNs.settledDone,
  prefetchChecks: pipelineNs.prefetchChecks, applyChecksForTask: pipelineNs.applyChecksForTask,
  listTasks: (polling) => store.all().filter((t) => polling.has(t.project) && !t.unassigned),
});

/** Per-task work in flight inside ONE project. */
const TASK_CONCURRENCY = 4;
/** Per-task STEPS (classify, branches, stack, crs, checks) in flight across all projects. */
const STEP_CONCURRENCY = 6;
const FETCH_CONCURRENCY = 3;

/**
 * One cycle. `token` is this cycle's own object: setting `token.cancelled`
 * makes it stop starting work, and only the token that is still the current
 * one may write progress.
 *
 * No phase barriers: every due project runs its own chain from t=0, and order
 * is kept only where one step needs the result of another.
 *
 *   per project   listing -> sweep -> (tasks known)
 *                 fetch (forced) and the GitHub half of the checks start at t=0
 *   per task      classify || branches   (after sweep AND fetch of the project)
 *                 classify -> crs, stack health
 *                 classify + branches -> applyChecks (needs prNumber and unpushed)
 *   board         tick() once every project is classified, and again at the very end
 */
export async function runCycle(due, token = {}, levels = null) {
  const S = { ...realSteps(), ...hooks.steps };
  const found = { tasks: 0, changeRequests: 0, swept: 0 };
  const errors = [];
  const splitChecks = typeof S.prefetchChecks === 'function' && typeof S.applyChecksForTask === 'function';
  const stepSem = new Semaphore(() => STEP_CONCURRENCY);
  const fetchSem = new Semaphore(() => FETCH_CONCURRENCY);
  const cancelled = () => Boolean(token.cancelled);
  const finish = () => {
    if (cancelled()) {
      found.error = 'cancelled';
    } else {
      if (errors.length) found.error = errors.join('; ');
      lastPollAt = new Date().toISOString();
    }
    return found;
  };

  /** One task step behind the shared bound; resolves true when it ran (even if it failed), false when skipped by a cancel. */
  const runStep = (fn, onError) => stepSem.run(async () => {
    if (cancelled()) return false;
    try { await fn(); } catch (e) { onError(e); }
    return true;
  });

  /** The light chain: the listing, then classification of the tasks never classified. Nothing else. */
  const lightChainOf = (project, onClassified) => async () => {
    const id = project.id;
    progressAdd(token, 'listing');
    if (cancelled()) return;
    try {
      await S.pollProject(project, found, new Set());
    } catch (e) {
      console.error(`[poll] ${id}: ${e.message}`);
      errors.push(`${id}: ${e.message}`);
    }
    progressBump(token, 'listing', id);
    if (cancelled()) return;
    const tasks = S.listTasks(new Set([id]))
      .filter((t) => t.project === id && !t.classified && t.state !== 'done' && !t.unassigned);
    progressAdd(token, 'classify', tasks.length);
    const lightSem = new Semaphore(() => TASK_CONCURRENCY);
    await Promise.all(tasks.map((task) => lightSem.run(async () => {
      const ran = await runStep(() => S.refreshClassification(task),
        (e) => store.addLog(task, 'guard', `⚠️ could not reclassify: ${e.message}`));
      if (ran) progressBump(token, 'classify', id);
    })));
    onClassified();
  };

  const chainOf = (project, onClassified) => (levels?.get(project.id) === 'light'
    ? lightChainOf(project, onClassified)
    : fullChainOf(project, onClassified));

  const fullChainOf = (project, onClassified) => async () => {
    const id = project.id;
    const seen = new Set();

    // t=0, independent of everything else: the forced fetch (so the classification
    // reads a warm branch cache) and the GitHub half of the checks.
    progressAdd(token, 'fetch');
    const fetched = fetchSem.run(async () => {
      if (cancelled()) return;
      try {
        await S.listAllBranches({ project: id, force: true });
      } catch (e) {
        console.error(`[poll] ${id}: no se pudieron listar las ramas: ${e.message}`);
        errors.push(`${id}: ${e.message}`);
      }
    }).finally(() => progressBump(token, 'fetch', id));
    progressAdd(token, 'checks');
    let prefetched = Promise.resolve(null);
    if (splitChecks) {
      prefetched = Promise.resolve().then(() => (cancelled() ? null : S.prefetchChecks(id))).catch((e) => {
        console.error(`[poll] ${id}: no se pudieron mirar los checks: ${e.message}`);
        errors.push(`${id}: ${e.message}`);
        return null;
      });
    }

    // listing -> sweep: the hard order of a project.
    progressAdd(token, 'listing');
    if (cancelled()) { await fetched; return; }
    try {
      await S.pollProject(project, found, seen);
    } catch (e) {
      console.error(`[poll] ${id}: ${e.message}`);
      errors.push(`${id}: ${e.message}`);
    }
    progressBump(token, 'listing', id);

    if (cancelled()) { await fetched; return; }
    progressAdd(token, 'sweep');
    try {
      const counts = await S.sweepClosedIssues(project, seen);
      found.swept += counts.flipped + counts.settled;
      sweepFailures.delete(id);
    } catch (e) {
      // Nothing is written on any task: the question was about the repository,
      // and a `gh` that keeps failing the same way says it once.
      if (sweepFailures.get(id) !== e.message) {
        sweepFailures.set(id, e.message);
        console.error(`[poll] ${id}: no se pudo comprobar el estado de los issues: ${e.message}`);
      }
      errors.push(`${id}: ${e.message}`);
    }
    progressBump(token, 'sweep', id);

    // Classification and branches both need the warm cache of the forced fetch.
    await fetched;
    if (cancelled()) return;
    const tasks = S.listTasks(new Set([id])).filter((t) => t.project === id && !S.settledDone(t));
    progressAdd(token, 'classify', tasks.length);
    progressAdd(token, 'branches', tasks.length);
    progressAdd(token, 'crs', tasks.length);

    const projectSem = new Semaphore(() => TASK_CONCURRENCY);
    const chains = tasks.map((task) => {
      let classified;
      const clsDone = new Promise((r) => { classified = r; });
      const all = projectSem.run(async () => {
        try {
          if (cancelled()) return;
          const cls = runStep(() => S.refreshClassification(task),
            (e) => store.addLog(task, 'guard', `⚠️ could not reclassify: ${e.message}`))
            .then((ran) => { if (ran) progressBump(token, 'classify', id); classified(); return ran; });
          const br = runStep(() => S.refreshBranchStatus(task),
            (e) => store.addLog(task, 'merge', `⚠️ could not check the branch state: ${e.message}`))
            .then((ran) => { if (ran) progressBump(token, 'branches', id); return ran; });

          // After classify only (they read nothing of the branch measurement).
          const afterClassify = cls.then(async (ran) => {
            if (!ran || cancelled()) return;
            await Promise.all([
              task.stack?.status === 'running'
                ? runStep(() => S.refreshStackHealth(task), (e) => store.addLog(task, 'stack', `⚠️ could not check the stack: ${e.message}`))
                : null,
              runStep(async () => { found.changeRequests += await S.checkChangeRequests(task); },
                (e) => store.addLog(task, 'cr', `⚠️ could not read the PR reviews: ${e.message}`))
                .then((ran2) => { if (ran2) progressBump(token, 'crs', id); }),
            ]);
          });

          // A PR's checks describe the last pushed commit: they need the PR
          // from classify and the unpushed count from branches.
          const afterBoth = splitChecks
            ? Promise.all([cls, br]).then(async ([a, b]) => {
              if (!a || !b || cancelled()) return;
              const map = await prefetched;
              await runStep(() => S.applyChecksForTask(task, map ? new Map([[id, map]]) : new Map()),
                (e) => store.addLog(task, 'checks', `⚠️ could not apply the checks: ${e.message}`));
            })
            : Promise.resolve();
          await Promise.all([afterClassify, afterBoth]);
        } finally {
          classified();
        }
      });
      return { clsDone, all };
    });

    await Promise.all(chains.map((c) => c.clsDone));
    onClassified();

    if (splitChecks) {
      await Promise.all(chains.map((c) => c.all));
      if (!cancelled()) progressBump(token, 'checks', id);
    } else {
      // Old whole-project checks, after every branch of this project is measured.
      await Promise.all(chains.map((c) => c.all));
      if (!cancelled()) {
        try {
          await S.refreshChecks({ projects: [id] });
        } catch (e) {
          console.error(`[poll] no se pudieron mirar los checks: ${e.message}`);
          errors.push(e.message);
        }
        progressBump(token, 'checks', id);
      }
    }
  };

  // Every project's chain starts now. `classified` resolves when its tasks are
  // classified or its chain ended for any reason (a failure must not hold the tick).
  const classified = [];
  const chainPromises = due.map((project) => {
    let mark;
    classified.push(new Promise((r) => { mark = r; }));
    return chainOf(project, mark)().catch((e) => {
      console.error(`[poll] ${project.id}: ${e.message}`);
      errors.push(`${project.id}: ${e.message}`);
    }).finally(() => mark());
  });

  // The early tick: the board-wide gate (task cap, queue) as soon as all
  // classification is in; idempotent, so the final one below is harmless.
  const early = Promise.all(classified).then(() => {
    if (cancelled()) return;
    try { S.tick(); } catch (e) { console.error(`[poll] tick: ${e.message}`); }
  });

  await Promise.all(chainPromises);
  await early;

  // Both are local and account-wide: the task cap and the quota hold belong to
  // the board, not to a project. They run even after a failed listing or a
  // cancellation, so one repository GitHub cannot answer for does not stop the
  // other's queued task from starting. The second tick picks up change requests
  // registered late.
  S.tick();
  S.evaluateQuota();
  return finish();
}

/**
 * Polls GitHub on the cadence set from the dashboard. `arm` only reprograms
 * when the period actually changed, so a settings save that touches something
 * else does not restart the clock.
 *
 * One timer for the whole board, ticking at the shortest interval any project
 * asks for, and each tick polls the projects whose own interval has elapsed
 * ({@link isDue}). A timer per project would be the obvious shape and the
 * wrong one: `pollNow` already serialises — a second cycle joins the one in
 * flight instead of starting another — so N timers would collapse into one
 * queue anyway, having cost N clocks to re-arm on every settings change.
 */
export function shortestPollMinutes(minutes) {
  const m = Math.min(...minutes);
  return Number.isFinite(m) && m > 0 ? m : null;
}

/** The shortest positive git refresh period, in seconds; `null` when all are 0 (off) or there are none. */
export function shortestGitRefreshSeconds(seconds) {
  const positive = seconds.filter((n) => Number.isFinite(n) && n > 0);
  return positive.length ? Math.min(...positive) : null;
}

let gitRefreshing = false;

/** One timer tick: never overlaps a previous run, never throws. */
export async function gitRefreshTick(refresh = refreshGitNow, viewed = viewedProjects) {
  if (gitRefreshing) return false;
  // Only what somebody is looking at: nobody viewing, nothing to refresh.
  const projects = [...viewed()];
  if (!projects.length) return false;
  gitRefreshing = true;
  try {
    await refresh({ projects, force: true });
  } catch (e) {
    console.warn(`git refresh failed: ${e?.message ?? e}`);
  } finally {
    gitRefreshing = false;
  }
  return true;
}

export function startPolling() {
  let timer = null;
  let period = null;
  const arm = () => {
    const minutes = shortestPollMinutes(listProjects().map((p) => settings.pollIntervalMinutesFor(p.id)));
    if (minutes === null) { // no projects: nothing to poll, and Infinity would fire every 1 ms
      if (timer) clearInterval(timer);
      timer = null;
      period = null;
      return;
    }
    if (period === minutes) return;
    period = minutes;
    if (timer) clearInterval(timer);
    timer = setInterval(() => pollNow({ scheduled: true }), minutes * 60 * 1000);
    const projects = listProjects();
    const detail = projects.length > 1
      ? ` (${projects.map((p) => `${p.id}: ${settings.pollIntervalMinutesFor(p.id)} min`).join(', ')})`
      : '';
    console.log(`buscando issues y change requests cada ${minutes} min${detail}`);
  };

  let gitTimer = null;
  let gitPeriod = null;
  const armGit = () => {
    const seconds = shortestGitRefreshSeconds(listProjects().map((p) => settings.gitRefreshSecondsFor(p.id)));
    if (seconds === gitPeriod) return;
    gitPeriod = seconds;
    if (gitTimer) clearInterval(gitTimer);
    gitTimer = null;
    if (seconds === null) return;
    gitTimer = setInterval(() => { gitRefreshTick(); }, seconds * 1000);
    gitTimer.unref?.();
    console.log(`refrescando el estado de git cada ${seconds} s`);
  };

  watchViewers();
  pollNow();
  arm();
  armGit();
  settings.on('change', () => { arm(); armGit(); });
  configEvents.on('change', () => { arm(); armGit(); });
}
