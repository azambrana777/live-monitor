/**
 * Pure helpers for the poll progress shown in the top bar. The server reports
 * `{ running, startedAt, step, stepIndex, stepCount, done, total, project,
 * progressAt, cancelling, last }`; nothing here touches the DOM or the catalog.
 */

/** The cycle's steps, in the order the server runs them (keys of `topbar.poll.steps`). */
export const POLL_STEPS = ['listing', 'sweep', 'fetch', 'classify', 'branches', 'checks', 'crs'];

/** A cycle with no progress for longer than this is a dead one, not a slow one. */
export const POLL_STALE_MS = 10 * 60 * 1000;

/** The catalog key of a step's name, or null when the step is unknown or the poll idle. */
export function stepLabelKey(step) {
  return POLL_STEPS.includes(step) ? step : null;
}

/** «3/12» for the current step; empty while there is no total to count against. */
export function progressText(poll) {
  const total = Number(poll?.total);
  if (!poll?.running || !Number.isFinite(total) || total <= 0) return '';
  const done = Math.min(Math.max(Number(poll.done) || 0, 0), total);
  return `${done}/${total}`;
}

/** Whether a step is `done`, the `current` one or still `pending`, given the poll's step. */
export function stepState(step, poll) {
  const at = POLL_STEPS.indexOf(poll?.step);
  const me = POLL_STEPS.indexOf(step);
  if (at < 0) return 'pending';
  return me < at ? 'done' : me === at ? 'current' : 'pending';
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
