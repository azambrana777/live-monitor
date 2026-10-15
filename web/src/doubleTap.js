// Double tap on a touch screen: two taps close in time and in place.
export const DOUBLE_TAP_MS = 350;
export const DOUBLE_TAP_PX = 24;
/** A finger that travelled farther than this between down and up was a scroll, not a tap. */
export const TAP_SLOP_PX = 10;

/**
 * Decides whether `tap` ({ t, x, y }) completes a double tap after `prev` (the
 * previous lone tap, or null). Returns { double, last }: `last` is what to
 * remember for the next tap (null right after a double, so a third tap starts over).
 */
export function nextTap(prev, tap) {
  if (prev && tap.t - prev.t >= 0 && tap.t - prev.t <= DOUBLE_TAP_MS
    && Math.hypot(tap.x - prev.x, tap.y - prev.y) < DOUBLE_TAP_PX) {
    return { double: true, last: null };
  }
  return { double: false, last: tap };
}

// Taps on these never count towards a double tap, so their own action keeps working.
export const TAP_IGNORE = 'button, a, input, select, textarea, label, summary, [role="button"], .tc-foot, .tc-groups'; // i18n-ok: CSS selector
