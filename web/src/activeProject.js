// Which project this screen is looking at. On this device only, like
// `lastChat.js` keeps the last conversation: the board is open on a laptop and
// on a phone at once, and changing project on one must not change it on the
// other. The snapshot's `activeProject` is only the project the board OPENS
// on — the first of `projects[]` — never a stored selection.

const KEY = 'hfsmon-active-project';

/** What this device chose last, or null (never chosen, or storage blocked). */
export function readActiveProject() {
  try {
    const value = localStorage.getItem(KEY);
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;   // private mode, blocked storage
  }
}

// «No project selected» is a choice too: removing the project on screen must
// not make the board jump to another one, not on the next snapshot and not
// after a reload. A separate flag, so `KEY` keeps meaning «a project id».
const NONE_KEY = 'hfsmon-active-project-none';

export function readNoProject() {
  try {
    return localStorage.getItem(NONE_KEY) === '1';
  } catch {
    return false;
  }
}

/** The user left the board with no project on screen; survives snapshots and reloads. */
export function rememberNoProject() {
  try {
    localStorage.removeItem(KEY);
    localStorage.setItem(NONE_KEY, '1');
  } catch { /* private mode */ }
}

export function rememberActiveProject(id) {
  if (!id) return;
  try {
    localStorage.setItem(KEY, id);
    localStorage.removeItem(NONE_KEY);
  } catch { /* private mode */ }
}

/**
 * The project to show: this device's choice when the registry still has it
 * (a restricted one too: the user chose it), otherwise what the board opens
 * on, otherwise the first project it knows. Neither fallback picks a
 * restricted project. With «no project» chosen and nothing picked since, null.
 */
export function pickActiveProject(projects, opensOn, stored = readActiveProject(), none = readNoProject()) {
  const list = projects ?? [];
  const ids = list.map((p) => p.id);
  if (stored && ids.includes(stored)) return stored;
  // The project on screen was removed (here or from another device): blank
  // state, never another project. Only when the server sent a registry.
  if (stored && Array.isArray(projects)) {
    rememberNoProject();
    return null;
  }
  if (none) return null;
  const open = (id) => ids.includes(id) && !list.find((p) => p.id === id)?.restricted;
  if (opensOn && open(opensOn)) return opensOn;
  const first = list.find((p) => !p.restricted)?.id;
  if (first) return first;
  return list.length ? null : (opensOn ?? null);
}
