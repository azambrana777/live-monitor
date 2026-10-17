/**
 * Models, by family rather than by version.
 *
 * The config names families — `opus`, `sonnet`, `haiku` — and the CLI
 * resolves each to the newest version it knows, so a point release reaches
 * the board without anyone editing a file. That happened the other way round
 * once: `claude-fable-5` sat in config.json while 5.1 was out. What this
 * module adds is sight: every session announces the concrete model it got,
 * and that is remembered per alias, so the board can show what «opus» means
 * today and say so the first time it changes.
 */

// effort.js imports this module back: neither may call the other at module top
// level (only inside functions), or the cycle reads an uninitialised binding.
import { capabilitiesOf, thinkingModesFor } from './effort.js';

/**
 * Resolves what someone typed after `/model` to one configured model.
 *
 * Short names are the point: nobody wants to type `claude-opus-4-1`, and
 * "opus" is unambiguous within a list this size. The net widens one round at
 * a time and only while the answer stays unique, so an ambiguous term is
 * reported rather than guessed at. A concrete id from before the config moved
 * to aliases still resolves: `claude-opus-4` contains `opus`.
 */
export function resolveModel(available, argument) {
  const wanted = String(argument ?? '').trim().toLowerCase();
  if (!wanted) return {};
  const lower = (s) => String(s ?? '').toLowerCase();
  const words = (id) => lower(id).split(/[-_\s.]+/);

  const rounds = [
    (m) => lower(m.id) === wanted || lower(m.label) === wanted,            // opus · "Opus"
    (m) => words(m.label)[0] === wanted || words(m.id).includes(wanted),   // opus · haiku
    (m) => lower(m.id).includes(wanted) || lower(m.label).includes(wanted), // partial
    (m) => words(wanted).includes(lower(m.id)),                             // claude-opus-4-1 → opus
  ];
  for (const round of rounds) {
    const hits = available.filter(round);
    if (hits.length === 1) return { match: hits[0] };
    if (hits.length > 1) return { ambiguous: hits };
  }
  return {};
}

/** The one-word alias each configured model answers to in the chat. */
export const shortName = (m) => String(m.label).split(/\s+/)[0].toLowerCase();

/**
 * The configured family a model id belongs to, or null. `claude-opus-4`
 * belongs to `opus`; an alias belongs to itself; `gpt-x` belongs nowhere.
 */
export function familyOf(id, available = []) {
  const s = String(id ?? '').toLowerCase();
  if (!s) return null;
  if (available.some((m) => String(m.id).toLowerCase() === s)) return s;
  const parts = s.split(/[-_\s.]+/);
  const hit = available.find((m) => parts.includes(String(m.id).toLowerCase()));
  return hit ? hit.id : null;
}

/**
 * What the UI may offer as a model: each configured family with the efforts it
 * accepts. Built from `claude.available`, so no version is named here and a
 * family removed from the config disappears.
 */
export function selectableModels(available = []) {
  return available
    .map((m) => {
      const caps = capabilitiesOf(m.id, available);
      return { id: m.id, label: m.label, hint: m.hint ?? null, efforts: [...caps.efforts], thinking: thinkingModesFor(m.id, available), fastMode: caps.fastMode };
    });
}

// alias -> { resolved, seenAt, previous }
const resolved = new Map();

/**
 * Remembers what a requested model turned into. Returns whether that differs
 * from the last time this alias was seen — the one moment worth a log line.
 */
export function noteResolved(requested, concrete) {
  if (!requested || !concrete) return { changed: false, first: false, previous: null };
  const prev = resolved.get(requested) ?? null;
  const changed = Boolean(prev && prev.resolved !== concrete);
  resolved.set(requested, { resolved: concrete, seenAt: new Date().toISOString(), previous: changed ? prev.resolved : prev?.previous ?? null });
  if (changed) console.log(`[models] «${requested}» ahora resuelve a ${concrete} (antes ${prev.resolved})`);
  return { changed, first: !prev, previous: prev?.resolved ?? null };
}

/** Each configured alias with the concrete model it last resolved to, if any session has told us yet. */
export function resolvedModels(available = []) {
  return available.map((m) => ({
    alias: m.id, label: m.label, hint: m.hint ?? null,
    ...(resolved.get(m.id) ?? { resolved: null, seenAt: null, previous: null }),
  }));
}

/** Tests only: forget what was seen. */
export function forgetResolved() { resolved.clear(); }
