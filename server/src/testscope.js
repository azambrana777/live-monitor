/**
 * Which tests a task runs before its PR: only what the diff touched.
 *
 * The test phase used to run the project's whole suite (a release build plus
 * every browser test) whatever the change was, and then GitHub ran it all
 * again on the PR. The board's job is to get the task to the PR quickly; the
 * full suite is CI's, and a failure there comes back through the same repair
 * loop. So `config.e2e.scopes` lists what to run for which paths, and the plan
 * holds only the scopes the changed files match.
 *
 * A scope is `{ name, paths, command, cwd?, prepareCommand?, browser?,
 * crates?, crateOf? }`:
 * - `paths` are globs (`*` stays inside a folder, `**` crosses folders),
 * - `command` may carry `{crates}` (`-p a -p b`), `{files}` and `{base}`,
 * - `browser` marks a scope that needs a free port block and the e2e gate,
 * - `crates` is the regexp whose first group names the crate of a file;
 *   `cratePrefix` is put before that folder name and `crateOf` maps a folder to
 *   its package name outright when it is neither.
 * `config.e2e.ignore` lists globs that never need a test (docs, markdown).
 *
 * Strict on purpose: no match means nothing runs, and an unreadable diff means
 * nothing runs. Nothing falls back to the full suite except the person asking
 * for it (the `fullTests` switch), which is decided by the caller.
 *
 * Pure: config and file names in, a plan out. The caller reads the diff.
 */

/** A glob as an anchored RegExp: `**` crosses folders, `*` and `?` do not. */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

const matcher = (globs) => {
  const res = (globs ?? []).map(globToRegExp);
  return (file) => res.some((r) => r.test(file));
};

/** Whether `e2e` asks for scoped tests at all: a non-empty `scopes` list. */
export const hasScopes = (e2e) => Array.isArray(e2e?.scopes) && e2e.scopes.length > 0;

const fill = (template, values) => template.replace(/\{(crates|files|base)\}/g, (_, k) => values[k]);

/**
 * The runs for these changed files.
 * @returns {{ runs: object[], covered: string[], ignored: string[], unmatched: string[] }}
 */
export function planScopes(e2e, files, { base = 'main' } = {}) {
  const isIgnored = matcher(e2e?.ignore);
  const ignored = [];
  const live = [];
  for (const f of files) (isIgnored(f) ? ignored : live).push(f);

  const runs = [];
  const used = new Set();
  for (const scope of e2e?.scopes ?? []) {
    const hits = live.filter(matcher(scope.paths));
    if (!hits.length) continue;
    hits.forEach((f) => used.add(f));
    const crates = new Set();
    if (scope.crates) {
      const re = new RegExp(scope.crates);
      for (const f of hits) {
        const dir = re.exec(f)?.[1];
        if (dir) crates.add(scope.crateOf?.[dir] ?? `${scope.cratePrefix ?? ''}${dir}`);
      }
    }
    // A scope that needs crates and found none has nothing to run.
    if (scope.crates && !crates.size) continue;
    runs.push({
      name: scope.name,
      browser: scope.browser === true,
      cwd: scope.cwd ?? null,
      prepareCommand: scope.prepareCommand ?? null,
      command: fill(scope.command, {
        crates: [...crates].map((c) => `-p ${c}`).join(' '),
        files: hits.join(' '),
        base,
      }),
      files: hits,
    });
  }
  return {
    runs,
    covered: runs.map((r) => r.name),
    ignored,
    unmatched: live.filter((f) => !used.has(f)),
  };
}

/** One line for the log and the PR: what ran, or why nothing did. */
export function describePlan(plan) {
  if (plan.runs.length) return `scoped tests: ${plan.covered.join(', ')} (${plan.runs.reduce((n, r) => n + r.files.length, 0)} changed files)`;
  return 'scoped tests: nothing to run for this diff';
}
