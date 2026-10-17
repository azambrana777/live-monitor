/**
 * Effort and session tuning: what a phase may ask of the model, and what each
 * model family accepts.
 *
 * Every knob defaults to `auto`, which passes nothing: the CLI keeps choosing,
 * exactly as before this module existed. A setting only reaches the SDK when
 * someone asked for it AND the family can honour it. An unsupported pair is
 * dropped (or lowered) with a warning instead of thrown, because it is read
 * from config at session start and a typo there must not stop a phase.
 *
 * Sources (sdk.d.ts of @anthropic-ai/claude-agent-sdk 0.3.286):
 *   - `effort` option, line 1911: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
 *     (EffortLevel, line 689). Per model the CLI reports `supportedEffortLevels`
 *     (line 1413) at runtime; `capabilities.js` holds what the usage probe read
 *     and the table below is the static fallback until it answers.
 *   - `thinking`, line 1904: adaptive is «Opus 4.6+»; enabled/disabled exist for
 *     older models. The CLI reports `supportsAdaptiveThinking` (line 1417).
 *   - `fallbackModel`, line 1682: a comma-separated list, passed as a string.
 *   - 1M window: the 5.x families always run with it, there is no option. The
 *     only beta (`betas`, line 1714) is «Sonnet 4/4.5 only», which the board no
 *     longer configures, so nothing here sends `betas`.
 *   - fast mode: `settings.fastMode`, line 8942; `supportsFastMode` per model,
 *     line 1421. `settings` may also be a string path (line 2210), which cannot
 *     be merged into.
 */
// models.js imports this module back: neither may call the other at module top
// level (only inside functions), or the cycle reads an uninitialised binding.
import { familyOf } from './models.js';
import { liveCapabilities, fastModeStatus } from './capabilities.js';

export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * By family alias, as `config.claude.available` names them. Anything absent
 * from a family is something the board does not offer it. `thinking` lists the
 * modes the family accepts: Opus, Sonnet and Fable 5.x only `adaptive` (anything else
 * answers 400), Haiku only a fixed budget (`enabled`) or none (`disabled`).
 */
export const CAPABILITIES = Object.freeze({
  opus: Object.freeze({ efforts: ['low', 'medium', 'high', 'xhigh', 'max'], fastMode: true, adaptiveThinking: true, thinking: ['adaptive'] }),
  sonnet: Object.freeze({ efforts: ['low', 'medium', 'high', 'xhigh', 'max'], fastMode: false, adaptiveThinking: true, thinking: ['adaptive'] }),
  fable: Object.freeze({ efforts: ['low', 'medium', 'high', 'xhigh', 'max'], fastMode: false, adaptiveThinking: true, thinking: ['adaptive'] }),
  haiku: Object.freeze({ efforts: [], fastMode: false, adaptiveThinking: false, thinking: ['enabled', 'disabled'] }),
});

const NONE = Object.freeze({ efforts: [], fastMode: false, adaptiveThinking: false, thinking: [] });

/** Bounds of `{ type: 'enabled', budgetTokens }`: the documented minimum, and the board's own ceiling. */
export const THINKING_BUDGET = Object.freeze({ min: 1024, max: 32000 });

/** The alias of a model's family, or null. Falls back to the family word inside a concrete id. */
export function capabilityFamily(model, available = []) {
  const fam = familyOf(model, available);
  if (fam && CAPABILITIES[String(fam).toLowerCase()]) return String(fam).toLowerCase();
  const hit = String(model ?? '').toLowerCase().split(/[-_\s.]+/).find((w) => CAPABILITIES[w]);
  return hit ?? null;
}

/** What a model accepts: the CLI's own answer when the probe has one, else the static family row. */
export function capabilitiesOf(model, available = []) {
  const live = liveCapabilities(model, available);
  if (live) return { efforts: [...live.efforts], fastMode: Boolean(live.fastMode), adaptiveThinking: Boolean(live.adaptiveThinking) };
  return CAPABILITIES[capabilityFamily(model, available)] ?? NONE;
}

/**
 * The thinking modes a model accepts, for the UI and for validation. A known
 * family answers from the static table (the CLI does not report modes, only
 * `supportsAdaptiveThinking`); an unknown one answers from the probe, else `[]`.
 */
export function thinkingModesFor(model, available = []) {
  const fam = capabilityFamily(model, available);
  if (fam) return [...CAPABILITIES[fam].thinking];
  return liveCapabilities(model, available)?.adaptiveThinking ? ['adaptive'] : [];
}

/** `'auto'`, null, undefined and '' mean «pass nothing». Anything else must be a level. */
export function normalizeEffort(value) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim().toLowerCase();
  if (s === '' || s === 'auto') return undefined;
  if (!EFFORT_LEVELS.includes(s)) {
    throw new Error(`effort «${value}» is not valid: use auto or one of ${EFFORT_LEVELS.join(', ')}`);
  }
  return s;
}

/**
 * The highest effort the model accepts that is not above `effort`, or
 * `undefined` when the model has no effort at all (Haiku), when `effort` is
 * `auto`/empty/unknown, or when every accepted level is above it. Nothing is
 * thrown: the stored choice is kept elsewhere and only this answer is lowered.
 */
export function clampEffort(model, effort, available = []) {
  let level;
  try { level = normalizeEffort(effort); } catch { return undefined; }
  if (!level) return undefined;
  const accepted = capabilitiesOf(model, available).efforts;
  if (!accepted.length) return undefined;
  if (accepted.includes(level)) return level;
  const rank = (l) => EFFORT_LEVELS.indexOf(l);
  return accepted.filter((l) => rank(l) <= rank(level)).sort((a, b) => rank(b) - rank(a))[0];
}

/**
 * Why a thinking mode and an effort cannot go together, or null. No pair
 * clashes today (`between_tools`, the only one that did, is not offered: the
 * CLI accepted it silently where the docs say 400); the seam stays so the
 * panel and `effortOptionsFor` ask one place when one appears.
 */
export function thinkingEffortConflict(thinking, effort) {
  void thinking; void effort;
  return null;
}

const THINKING_TYPES = ['adaptive', 'enabled', 'disabled'];

/**
 * The partial `query()` options for one session.
 *
 * `settings` is the caller's existing session settings (object or path); fast
 * mode is merged into a copy, never replacing it. Returns `{ options, warnings }`.
 * An unsupported effort is lowered to the highest the model accepts (Haiku
 * gets none); an unsupported or malformed thinking is dropped. Both warn.
 */
export function effortOptionsFor({ model, effort, thinking, fastMode, fallbackModel, settings, available = [] } = {}) {
  const options = {};
  const warnings = [];
  const caps = capabilitiesOf(model, available);
  const fam = capabilityFamily(model, available) ?? 'unknown';

  let level;
  try { level = normalizeEffort(effort); } catch (e) { warnings.push(`${e.message}; ignored`); }
  if (level) {
    const sent = clampEffort(model, level, available);
    if (sent) options.effort = sent;
    if (sent !== level) {
      warnings.push(sent
        ? `model «${model}» (family ${fam}) does not support effort «${level}»; using «${sent}»`
        : `model «${model}» (family ${fam}) does not support effort «${level}»; ignored`);
    }
  }

  if (thinking !== undefined && thinking !== null && thinking !== 'auto') {
    const modes = thinkingModesFor(model, available);
    if (!thinking || !THINKING_TYPES.includes(thinking.type)) {
      warnings.push(`invalid thinking (${JSON.stringify(thinking)}); ignored`);
    } else if (!modes.includes(thinking.type)) {
      warnings.push(`model «${model}» (family ${fam}) does not support thinking «${thinking.type}»; ignored`);
    } else if (thinking.type === 'enabled' && !(Number.isInteger(thinking.budgetTokens)
      && thinking.budgetTokens >= THINKING_BUDGET.min && thinking.budgetTokens <= THINKING_BUDGET.max)) {
      warnings.push(`thinking «enabled» needs an integer budget between ${THINKING_BUDGET.min} and ${THINKING_BUDGET.max}; ignored`);
    } else {
      const clash = thinkingEffortConflict(thinking, options.effort);
      if (clash) warnings.push(`${clash}; thinking ignored`);
      else options.thinking = thinking;
    }
  }

  if (fastMode) {
    const account = fastModeStatus();
    if (!caps.fastMode) {
      warnings.push(`fast mode is not available for «${model}» (family ${fam}); ignored`);
    } else if (account?.available === false) {
      warnings.push(`fast mode is not available on the account (${account.reason ?? 'no reason given'}); ignored`);
    } else if (typeof settings === 'string') {
      warnings.push('fast mode cannot be merged into `settings` given as a path; ignored');
    } else {
      options.settings = { ...(settings ?? {}), fastMode: true };
    }
  }

  if (fallbackModel) options.fallbackModel = String(fallbackModel);

  return { options, warnings };
}

/** Efforts a family accepts, for the UI. */
export const effortsFor = (model, available = []) => [...capabilitiesOf(model, available).efforts];
