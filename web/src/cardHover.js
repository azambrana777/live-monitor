// How long the pointer must rest on a task card before it expands by itself.
// On this device only (the board is open on a laptop and a phone at once, and a
// phone has no pointer to rest). 0 means off: the card then only opens with its
// button or, on a touch screen, a double tap.
import { read, write } from './storage.js';

const KEY = 'hfsmon-card-hover-ms';

export const DEFAULT_HOVER_DELAY_MS = 3000;

/** The values the settings menu offers, in ms; 0 is «off». */
export const HOVER_DELAY_OPTIONS = [0, 1000, 2000, 3000, 5000];

const CHANGED = 'hfsmon-card-hover-changed';

/** What this browser chose, or the default (never chosen, or a value we do not offer). */
export function readHoverDelay() {
  const value = read(KEY, DEFAULT_HOVER_DELAY_MS);
  return HOVER_DELAY_OPTIONS.includes(value) ? value : DEFAULT_HOVER_DELAY_MS;
}

/** Stores the choice and tells every card on this page, so no reload is needed. */
export function writeHoverDelay(ms) {
  if (!HOVER_DELAY_OPTIONS.includes(ms)) return;
  write(KEY, ms);
  try { window.dispatchEvent(new Event(CHANGED)); } catch { /* no window: nothing to tell */ }
}

/** Calls `fn` whenever the choice changes; returns the unsubscribe. */
export function onHoverDelayChange(fn) {
  window.addEventListener(CHANGED, fn);
  return () => window.removeEventListener(CHANGED, fn);
}
