/**
 * What the installed Claude Code CLI says each model can do, as read by the
 * usage probe (`usage.js`), and what the account allows (fast mode).
 *
 * This module imports nothing on purpose: `effort.js` and `models.js` read it,
 * and an import back would close the cycle models → effort → capabilities →
 * models. Until the first probe lands every reader gets `null` and falls back
 * to the static table in `effort.js#CAPABILITIES`.
 *
 * `recordCapabilities` stores the raw `supportedModels()` rows and the
 * `initializationResult()` of one probe; the readers derive from them.
 */

let state = null;

const lower = (v) => String(v ?? '').toLowerCase();
// Usable rows: everything but the `default` pseudo-row.
const usable = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && r.value !== 'default');

/** The configured alias a model id belongs to (same rule as `models.js#familyOf`, which cannot be imported here). */
function familyIn(id, available) {
  const s = lower(id);
  if (!s) return null;
  const ids = (Array.isArray(available) ? available : []).map((m) => lower(m?.id)).filter(Boolean);
  if (ids.includes(s)) return s;
  const parts = s.split(/[-_\s.]+/);
  return ids.find((x) => parts.includes(x)) ?? null;
}

/**
 * Live capabilities of one model, or null when the probe has not answered.
 * Crosses by `value` first, then by the family of `resolvedModel`; the
 * `default` row is ignored.
 * @param {string} modelId the id the board sends (an alias like `opus`, or a full id).
 * @param {{id:string}[]} [available] `config.claude.available`, to cross by alias.
 * @returns {{efforts:string[], fastMode:boolean, adaptiveThinking:boolean}|null}
 */
export function liveCapabilities(modelId, available = []) {
  const rows = usable(state?.models);
  if (!rows.length) return null;
  const id = lower(modelId);
  if (!id) return null;
  let row = rows.find((r) => lower(r.value) === id);
  if (!row) row = rows.find((r) => lower(r.resolvedModel) === id);
  if (!row) {
    const fam = familyIn(id, available);
    if (fam) row = rows.find((r) => familyIn(r.resolvedModel, available) === fam);
  }
  if (!row) return null;
  return {
    efforts: row.supportsEffort === false ? [] : [...(row.supportedEffortLevels ?? [])],
    fastMode: row.supportsFastMode === true,
    adaptiveThinking: row.supportsAdaptiveThinking === true,
  };
}

/**
 * Whether the account can use fast mode right now. A missing probe, a missing
 * field or `pending` is unknown (`available: null`); any other reason is a
 * refusal whose code is kept; no reason at all means nothing blocks it.
 * @returns {{available:boolean|null, reason:string|null, at:number|null}|null}
 */
export function fastModeStatus() {
  if (!state) return null;
  const init = state.init;
  const at = state?.at ?? null;
  const reason = init?.fast_mode_disabled_reason ?? null;
  if (reason === 'pending') return { available: null, reason: null, at };
  if (reason) return { available: false, reason: String(reason), at };
  if (init?.fast_mode_state == null) return { available: null, reason: null, at };
  // Cooling down: usable, but the CLI says it is temporarily slowed.
  if (init.fast_mode_state === 'cooldown') return { available: true, reason: 'cooldown', at };
  return { available: true, reason: null, at };
}

/**
 * The models the CLI offers, without the `default` row.
 * @returns {{value:string, displayName:string, resolvedModel:string}[]|null}
 */
export function cliModels() {
  if (!Array.isArray(state?.models)) return null;
  return usable(state.models).map((r) => ({
    value: r.value, displayName: r.displayName ?? r.value, resolvedModel: r.resolvedModel ?? r.value,
  }));
}

/** When the last probe recorded capabilities (ms epoch), or null. */
export function capabilitiesProbedAt() {
  return state?.at ?? null;
}

/**
 * Stores what one probe read. Called by the usage probe only.
 * @param {{models:object[], init:object, at:number}|null} snapshot
 */
export function recordCapabilities(snapshot) {
  state = snapshot ?? null;
}

/** Test hook: replace (or clear with null) the recorded capabilities. */
export function setCapabilitiesForTest(snapshot) {
  state = snapshot ?? null;
}
