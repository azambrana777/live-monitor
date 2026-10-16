// What this browser tells the server about what it is looking at, so the board
// polls fully only the projects that are open somewhere. Pure helpers: the
// socket and the listeners live in `api.js` and `App.jsx`.

/** The WebSocket message: the project on screen (null: none) and whether the tab is visible. */
export function viewMessage(project, visible) {
  return { type: 'view', project: project || null, visible: !!visible };
}

/** Send only a state that differs from the last one sent on this socket. */
export function shouldSend(prev, next) {
  if (!prev) return true;
  return prev.project !== next.project || prev.visible !== next.visible;
}
