/**
 * What each kind of session runs on: model, effort and thinking per role, plus
 * the board-wide fast-mode knob.
 *
 * Precedence, per role: a board override (settings.js `tuning`) wins, then the
 * project's merged config (`claude.<role>Model`, `claude.tuning.<role>Effort`,
 * `claude.tuning.<role>Thinking`), then nothing. Effort and thinking
 * `undefined` mean «auto»: the caller passes nothing and the CLI keeps choosing.
 *
 * A chat's own model/effort/thinking (chosen in the chat panel) is NOT handled here:
 * `tuningFor('chat')` is only the default for a chat that chose nothing.
 */
import { config } from './config.js';
import { settings, TUNING_ROLES } from './settings.js';
import { normalizeEffort, clampEffort, thinkingModesFor, thinkingEffortConflict, THINKING_BUDGET } from './effort.js';
import { selectableModels } from './models.js';
import { cliModels, fastModeStatus } from './capabilities.js';

export { TUNING_ROLES };

/** Where each role's config default lives, with the fallbacks the pipeline always had. */
const MODEL_OF = {
  triage: (c) => c.claude?.triageModel,
  advisor: (c) => c.claude?.advisorModel,
  plan: (c) => c.claude?.planModel,
  fix: (c) => c.claude?.fixModel,
  pr: (c) => c.claude?.prModel ?? c.claude?.chatModel,
  demo: (c) => c.claude?.demoModel,
  reply: (c) => c.claude?.replyModel,
  chat: (c) => c.claude?.chatModel,
  qa: (c) => c.qa?.model ?? c.claude?.fixModel,
  qaPlan: (c) => c.qa?.planModel ?? c.claude?.advisorModel,
};

const EFFORT_OF = {
  qa: (c) => c.qa?.effort,
  qaPlan: (c) => c.qa?.planEffort,
};
const effortConfigOf = (role, c) => (EFFORT_OF[role] ? EFFORT_OF[role](c) : c.claude?.tuning?.[`${role}Effort`]);

const thinkingConfigOf = (role, c) => c.claude?.tuning?.[`${role}Thinking`];

const warned = new Set();
function warnOnce(key, text) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[tuning] ${text}`);
}

function assertRole(role) {
  if (!TUNING_ROLES.includes(role)) throw new Error(`role «${role}» does not exist: use ${TUNING_ROLES.join(', ')}`);
}

/**
 * The model, effort and board-wide knobs for one role.
 *
 * @param {string} role one of {@link TUNING_ROLES}.
 * @param {Object} [cfg] the (project-merged) config; defaults to the board's.
 * @returns {{model: string|undefined, effort: string|undefined, thinking: Object|undefined, fastMode: boolean, available: Object[]}}
 */
export function tuningFor(role, cfg = config) {
  assertRole(role);
  const over = settings.tuning;
  const mine = over.roles[role] ?? {};
  const available = cfg.claude?.available ?? [];
  const def = MODEL_OF[role](cfg);

  const model = mine.model ?? def;

  let effort;
  try {
    effort = mine.effort !== undefined ? normalizeEffort(mine.effort) : normalizeEffort(effortConfigOf(role, cfg));
  } catch (e) {
    warnOnce(`effort:${role}`, `${e.message} (rol ${role}); se usa auto`);
  }

  // 'auto' and nothing at all both mean «pass nothing».
  let thinking = mine.thinking !== undefined ? mine.thinking : thinkingConfigOf(role, cfg);
  if (typeof thinking === 'string') {
    if (thinking.trim().toLowerCase() !== 'auto') warnOnce(`thinking:${role}`, `razonamiento «${thinking}» no válido (rol ${role}); se usa auto`);
    thinking = undefined;
  } else if (thinking === null || typeof thinking !== 'object') thinking = undefined;
  else thinking = { ...thinking };

  return {
    model,
    effort,
    thinking,
    fastMode: over.fastMode ?? cfg.claude?.tuning?.fastMode === true,
    available,
  };
}

/**
 * What the settings panel renders from.
 *
 * `roles[r].effort` is what was chosen ('auto' or a level, stored as is);
 * `roles[r].effectiveEffort` is what the role's model will actually get once
 * clamped to what it accepts (null for auto or a model with no effort).
 * `roles[r].thinking` is 'auto' or `{ type, budgetTokens? }`.
 *
 * @returns {{roles: Object, fastMode: boolean, fastModeStatus: Object|null, models: Object[], newModels: Object[], overrides: Object}}
 */
export function tuningSnapshot(cfg = config) {
  const roles = {};
  for (const role of TUNING_ROLES) {
    const t = tuningFor(role, cfg);
    const available = cfg.claude?.available ?? [];
    roles[role] = {
      model: t.model,
      effort: t.effort ?? 'auto',
      effectiveEffort: t.effort ? (clampEffort(t.model, t.effort, available) ?? null) : null,
      thinking: t.thinking ?? 'auto',
    };
  }
  const { fastMode } = tuningFor(TUNING_ROLES[0], cfg);
  return {
    roles,
    fastMode,
    fastModeStatus: fastModeStatus(),
    models: selectableModels(cfg.claude?.available ?? []),
    newModels: newModelsOf(cfg),
    overrides: settings.tuning,
  };
}

/** `claude-opus-5-5` gives `{ family: 'opus', version: [5, 5] }`; a trailing date stamp is not a version. */
function parseResolved(id) {
  const m = /^claude-([a-z]+)-(\d+(?:-\d{1,2})*)(?:-\d{8})?$/i.exec(String(id ?? ''));
  return m ? { family: m[1].toLowerCase(), version: m[2].split('-').map(Number) } : null;
}

/** Lexicographic compare of version arrays; a missing part counts as 0. */
function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Models the CLI offers that the board's list does not know about yet: one
 * whose `resolvedModel` is no configured alias's, and whose family is either
 * not configured or has a higher version than anything a configured alias
 * resolves to. `default` (`cliModels` drops it) and dismissed ones
 * (`settings.tuning.dismissedModels`) never count.
 *
 * @returns {{value: string, displayName: string, resolvedModel: string}[]} `resolvedModel` is what `dismissModel` takes.
 */
function newModelsOf(cfg) {
  const rows = cliModels();
  if (!rows?.length) return [];
  const aliases = new Set((cfg.claude?.available ?? []).map((m) => String(m.id).toLowerCase()));
  const dismissed = new Set(settings.tuning.dismissedModels ?? []);
  const owned = new Set();          // resolvedModel of every configured alias
  const highest = new Map();        // family -> highest version those aliases resolve to
  for (const r of rows) {
    if (!aliases.has(String(r.value).toLowerCase())) continue;
    owned.add(r.resolvedModel);
    const p = parseResolved(r.resolvedModel);
    if (p && (!highest.has(p.family) || compareVersions(p.version, highest.get(p.family)) > 0)) highest.set(p.family, p.version);
  }
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const id = r.resolvedModel;
    if (owned.has(id) || dismissed.has(id) || seen.has(id)) continue;
    if (aliases.has(String(r.value).toLowerCase())) continue;
    const p = parseResolved(id);
    if (!p) continue;
    const known = highest.get(p.family);
    // A family no alias resolves to is new only when the board does not
    // configure it at all; a configured alias the probe has no row for stays quiet.
    if (known ? compareVersions(p.version, known) <= 0 : aliases.has(p.family)) continue;
    seen.add(id);
    out.push({ value: r.value, displayName: r.displayName, resolvedModel: id });
  }
  return out;
}

/**
 * Validates and stores a tuning patch (see `Settings#updateTuning`), then
 * returns the new snapshot. Models must be ones the UI could offer. A thinking
 * mode must be one the role's resulting model accepts — also when the patch
 * carries only the model and the stored thinking stops fitting — and must not
 * clash with the effort; those are refused (the caller answers 400). An effort is
 * NOT refused: it is stored as chosen and clamped when a session opens.
 * `null` clears an override.
 */
export function setTuning(patch, cfg = config) {
  const available = cfg.claude?.available ?? [];
  const offered = new Set(selectableModels(available).map((m) => m.id));
  if (patch && typeof patch === 'object' && patch.roles && typeof patch.roles === 'object') {
    for (const [role, o] of Object.entries(patch.roles)) {
      if (!TUNING_ROLES.includes(role) || !o || typeof o !== 'object') continue; // updateTuning reports these
      const stored = settings.tuning.roles[role] ?? {};
      let model;
      if (o.model === null) model = MODEL_OF[role](cfg);
      else model = o.model ?? stored.model ?? MODEL_OF[role](cfg);
      // The thinking that would result: the one sent, or the stored one when
      // the patch does not touch it. null clears it; the config default is
      // auto or the operator's own business.
      const thinking = o.thinking === undefined ? stored.thinking : o.thinking;
      if (thinking && typeof thinking === 'object') {
        const modes = thinkingModesFor(model, available);
        if (!modes.includes(thinking.type)) {
          throw new Error(`model «${model}» does not support thinking «${thinking.type}» (role ${role}); it supports: ${modes.join(', ') || 'none'}`);
        }
        if (thinking.type === 'enabled' && !(Number.isInteger(thinking.budgetTokens) && thinking.budgetTokens >= THINKING_BUDGET.min && thinking.budgetTokens <= THINKING_BUDGET.max)) {
          throw new Error(`thinking enabled needs budgetTokens between ${THINKING_BUDGET.min} and ${THINKING_BUDGET.max} (role ${role})`);
        }
        const effort = o.effort === undefined ? stored.effort : o.effort;
        const level = effort === null ? undefined : normalizeEffort(effort);
        const clash = thinkingEffortConflict(thinking, level);
        if (clash) throw new Error(`${clash} (rol ${role})`);
      }
    }
  }
  settings.updateTuning(patch, { isModel: (id) => offered.has(id) });
  return tuningSnapshot(cfg);
}
