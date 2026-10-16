/**
 * Pure helpers for the poll progress shown in the top bar. The server reports
 * `{ running, startedAt, step, stepIndex, stepCount, done, total, phases, project,
 * progressAt, cancelling, last }` (`done/total` are sums over `phases`); nothing here touches the DOM or the catalog.
 */

/** The cycle's steps, in the order the server runs them (keys of `topbar.poll.steps`). */
export const POLL_STEPS = ['listing', 'sweep', 'fetch', 'classify', 'branches', 'checks', 'crs'];

/** A cycle with no progress for longer than this is a dead one, not a slow one. */
export const POLL_STALE_MS = 10 * 60 * 1000;

/** The catalog key of a step's name, or null when the step is unknown or the poll idle. */
export function stepLabelKey(step) {
  return POLL_STEPS.includes(step) ? step : null;
}

/** The `{ done, total }` of a phase, clamped and never NaN; null when the phase is absent. */
export function phaseCounts(phases, key) {
  const p = phases && typeof phases === 'object' ? phases[key] : null;
  if (!p || typeof p !== 'object') return null;
  const total = Math.max(Number(p.total) || 0, 0);
  const done = Math.min(Math.max(Number(p.done) || 0, 0), total);
  return { done, total };
}

/** Overall `{ done, total }`: the server's sums, else the sum of the phases (a stale server has only the sums). */
export function overallCounts(poll) {
  let total = Number(poll?.total);
  let done = Number(poll?.done);
  if ((!Number.isFinite(total) || total <= 0) && poll?.phases && typeof poll.phases === 'object') {
    total = 0; done = 0;
    for (const k of POLL_STEPS) { const c = phaseCounts(poll.phases, k); if (c) { total += c.total; done += c.done; } }
  }
  if (!Number.isFinite(total) || total <= 0) return { done: 0, total: 0 };
  return { done: Math.min(Math.max(Number(done) || 0, 0), total), total };
}

/** «37/210» over all phases; empty while there is no total to count against. */
export function progressText(poll) {
  if (!poll?.running) return '';
  const { done, total } = overallCounts(poll);
  return total > 0 ? `${done}/${total}` : '';
}

/** 0-100 for the overall bar; 0 while the total is unknown. */
export function overallPercent(poll) {
  const { done, total } = overallCounts(poll);
  return total > 0 ? Math.min(100, Math.max(0, Math.round((done / total) * 100))) : 0;
}

/** Old-server fallback: a step is `done` before the poll's step, `active` at it, `pending` after. */
export function stepState(step, poll) {
  const at = POLL_STEPS.indexOf(poll?.step);
  const me = POLL_STEPS.indexOf(step);
  if (at < 0) return 'pending';
  return me < at ? 'done' : me === at ? 'active' : 'pending';
}

/**
 * `done` (total > 0 and all done), `active` (work in progress: 0 < done < total,
 * or it is the current step with work to do) or `pending`. Several phases can be
 * active at once. Without `phases` (a stale server) it falls back to `stepState`.
 */
export function phaseState(phases, key, poll = null) {
  if (!phases || typeof phases !== 'object') return stepState(key, poll);
  const c = phaseCounts(phases, key);
  if (!c || c.total === 0) return poll?.step === key && poll?.running ? 'active' : 'pending';
  if (c.done >= c.total) return 'done';
  return c.done > 0 || poll?.step === key ? 'active' : 'pending';
}

/** `running` is a leftover when nothing has progressed (or started) for ten minutes. */
export function isStale(poll, now, seenSince = null) {
  if (!poll?.running) return false;
  const since = poll.progressAt ?? poll.startedAt ?? seenSince;
  return since != null && now - since > POLL_STALE_MS;
}

/** «m:ss» (or «h:mm:ss») for a duration in ms; empty when it is unknown. */
export function elapsedClock(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/**
 * What to say when `running` goes true -> false: `{ error }`, `{ cancelled: true }`
 * or `{ tasks, changeRequests }`; null when there is nothing to say.
 */
export function finishedOutcome(prevRunning, poll) {
  if (!prevRunning || poll?.running) return null;
  const last = poll?.last;
  if (!last) return null;
  if (last.cancelled || last.error === 'cancelled') return { cancelled: true };
  if (last.error) return last.error === 'cancelled' ? { cancelled: true } : { error: String(last.error) };
  return { tasks: last.tasks || 0, changeRequests: last.changeRequests || 0 };
}
