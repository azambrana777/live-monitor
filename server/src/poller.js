import { EventEmitter } from 'node:events';
import { config, configEvents } from './config.js';
import { settings } from './settings.js';
import { store } from './store.js';
import { listAssignedIssues, listClosedAssignedIssues, getIssue, issueStates, assigneeOf } from './github.js';
import { listProjects } from './projects.js';
import { makeKey, keyOf } from './keys.js';
import { listAllBranches } from './worktree.js';
import {
  tick, refreshClassification, reopenIfNeeded, checkChangeRequests, isRunning, refreshBranchStatus, refreshChecks,
  clearClosedWithoutPr, completeOnIssueClosed, settleUnassigned,
} from './pipeline.js';
import { findManualKeyword, shouldAskAboutMode } from './mode.js';
import { evaluateQuota } from './quota.js';
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
let lastPollAt = null;

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

export const pollStatus = () => ({ lastPollAt, running: Boolean(inFlight) });

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

/**
 * Runs one full cycle. The Fetch button calls this very function, so what a
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
export function pollNow({ scheduled = false } = {}) {
  if (inFlight) return inFlight;
  const all = listProjects();
  const now = Date.now();
  const due = scheduled ? all.filter((p) => isDue(p, now)) : all;
  for (const project of due) lastPolledAt.set(project.id, now);
  inFlight = runCycle(due).finally(() => { inFlight = null; });
  // Announced at both ends, so every open board shows the cycle running and
  // not just the tab whose button started it.
  pollEvents.emit('poll', pollStatus());
  return inFlight;
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

async function runCycle(due) {
  const found = { tasks: 0, changeRequests: 0, swept: 0 };
  const errors = [];
  // What each project's listings answered for, per project and owned here so
  // that a project whose `pollProject` threw still has an (empty) set: its
  // sweep then asks about every task it has, which is exactly right — a listing
  // that failed answered for nothing.
  const seen = new Map(due.map((p) => [p.id, new Set()]));
  // The projects this round is about. Every per-task sweep below is filtered
  // by it, so a project that polls every 30 minutes is not re-classified,
  // re-measured and re-read every 5 because another project is quicker.
  const polling = new Set(due.map((p) => p.id));
  // Tasks reassigned away are left out of every per-task refresh below (they
  // would only spend `gh`); pollProject and the sweep still see them so a
  // reassign-back restores them.
  const mine = () => store.all().filter((t) => polling.has(t.project) && !t.unassigned);

  for (const project of due) {
    try {
      await pollProject(project, found, seen.get(project.id));
    } catch (e) {
      console.error(`[poll] ${project.id}: ${e.message}`);
      errors.push(`${project.id}: ${e.message}`);
    }
  }

  // What the listings could not say, asked by number. Its own loop with its own
  // try/catch, and not inside `pollProject`: this is the one call that does not
  // depend on the listing, so a failed listing must not skip the sweep and a
  // failed sweep must not discard a fold that succeeded. Before the
  // classification, never after: the flag flipped here has to be acted on in
  // the SAME cycle, so a task whose issue somebody closed reaches «Completadas»
  // on the poll that discovers it and not on the next one.
  for (const project of due) {
    try {
      const counts = await sweepClosedIssues(project, seen.get(project.id));
      found.swept += counts.flipped + counts.settled;
      sweepFailures.delete(project.id);
    } catch (e) {
      // Nothing is written on any task: the question was about the repository,
      // and a `gh` that keeps failing the same way says it once.
      if (sweepFailures.get(project.id) !== e.message) {
        sweepFailures.set(project.id, e.message);
        console.error(`[poll] ${project.id}: no se pudo comprobar el estado de los issues: ${e.message}`);
      }
      errors.push(`${project.id}: ${e.message}`);
    }
  }

  // Classification hits the network per task; run it one at a time so a
  // long backlog doesn't fire dozens of gh processes at once.
  for (const task of mine()) {
    try {
      await refreshClassification(task);
    } catch (e) {
      store.addLog(task, 'guard', `⚠️ could not reclassify: ${e.message}`);
    }
  }

  // How each branch stands against main, and how each PR's CI is doing. The
  // fetch is asked for explicitly rather than relied upon as a side effect of
  // classification: a cycle where every task is busy would skip it, and then
  // "3 commits behind" would be measured against a stale origin/main. One
  // fetch per project: each has its own checkout, and hfs's branches say
  // nothing about the other's.
  for (const project of due) {
    try {
      await listAllBranches({ project: project.id });
    } catch (e) {
      console.error(`[poll] ${project.id}: no se pudieron listar las ramas: ${e.message}`);
      errors.push(`${project.id}: ${e.message}`);
    }
  }
  for (const task of mine()) {
    try {
      await refreshBranchStatus(task);
    } catch (e) {
      store.addLog(task, 'merge', `⚠️ could not check the branch state: ${e.message}`);
    }
  }
  // Stacks the board believes are up, asked whether they are: a server can
  // stop answering without its exit ever reaching the board.
  for (const task of mine()) {
    if (task.stack?.status !== 'running') continue;
    try {
      await refreshStackHealth(task);
    } catch (e) {
      store.addLog(task, 'stack', `⚠️ could not check the stack: ${e.message}`);
    }
  }
  // After the branches, never before: a PR's checks describe the last pushed
  // commit, so knowing whether anything is still local is what says if that
  // green light is talking about your code at all.
  try {
    await refreshChecks();
  } catch (e) {
    console.error(`[poll] no se pudieron mirar los checks: ${e.message}`);
    errors.push(e.message);
  }

  // Change requests, in the same cycle: a task waiting for approval may have
  // had changes requested on its PR since the last look.
  for (const task of mine()) {
    try {
      found.changeRequests += await checkChangeRequests(task);
    } catch (e) {
      store.addLog(task, 'cr', `⚠️ could not read the PR reviews: ${e.message}`);
    }
  }

  // Both of these are local and account-wide: the task cap and the quota hold
  // belong to the board, not to a project. They run even after a project's
  // listing failed — one repository GitHub cannot answer for must not stop the
  // other's queued task from starting.
  tick();
  // A free look at the quota hold: the cycle already runs on its own timer,
  // so a board that slept through the 30 s clock still hears about the
  // window reopening here.
  evaluateQuota();

  if (errors.length) found.error = errors.join('; ');
  lastPollAt = new Date().toISOString();
  pollEvents.emit('poll', pollStatus());
  return found;
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

  pollNow();
  arm();
  settings.on('change', arm);
  configEvents.on('change', arm);
}
