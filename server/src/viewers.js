import { EventEmitter } from 'node:events';
import { listProjects } from './projects.js';

/**
 * Which projects somebody is looking at right now.
 *
 * Each connected browser reports, over its WebSocket, the project it shows and
 * whether the tab is visible. A project is «viewed» when at least one
 * connection has it visible. The poller does the full, expensive cycle only for
 * viewed projects and a light one for the rest.
 *
 * Nothing here is persisted: a restart starts with nobody viewing.
 */

/** @type {Map<object, {project: string|null, visible: boolean}>} keyed by the connection */
const registry = new Map();
let lister = () => listProjects().map((p) => p.id);
/** The viewed set as of the last change; the events are the diff against it. */
let last = new Set();

/** Emits `'viewed'` with `{ project, added }` when a project enters or leaves the viewed set. */
export const viewerEvents = new EventEmitter();

/** Test seam: replace how the known project ids are listed; no argument resets. */
export function setViewerProjectLister(fn) {
  lister = fn ?? (() => listProjects().map((p) => p.id));
}

/** Projects that are visible in some connection and registered on the board (unknown ids are ignored). */
export function viewedProjects() {
  const known = new Set(lister());
  const out = new Set();
  for (const { project, visible } of registry.values()) {
    if (visible && typeof project === 'string' && known.has(project)) out.add(project);
  }
  return out;
}

function settle() {
  const now = viewedProjects();
  const before = last;
  last = now;
  for (const project of now) if (!before.has(project)) viewerEvents.emit('viewed', { project, added: true });
  for (const project of before) if (!now.has(project)) viewerEvents.emit('viewed', { project, added: false });
}

/** Records what one connection shows. A connection reports its latest state only. */
export function setView(socket, { project = null, visible = false } = {}) {
  registry.set(socket, {
    project: typeof project === 'string' && project ? project : null,
    visible: visible === true,
  });
  settle();
}

/** The connection closed: whatever it showed no longer counts. */
export function drop(socket) {
  if (registry.delete(socket)) settle();
}

/**
 * Handles one client message; true when it was a `view` message (valid or not).
 * Malformed fields are coerced to «not viewing», never thrown.
 */
export function handleViewMessage(socket, msg) {
  if (!msg || msg.type !== 'view') return false;
  setView(socket, { project: msg.project, visible: msg.visible === true });
  return true;
}

/** Test seam: forget every connection and the last viewed set. */
export function resetViewers() {
  registry.clear();
  last = new Set();
  viewerEvents.removeAllListeners();
}
