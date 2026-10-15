import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from './exec.js';
import { shared } from './inflight.js';
import { config } from './config.js';
import { assertPublishable } from './language.js';
import { PR_TITLE_MAX } from './prtitle.js';
import { detectRepo } from './repo-identity.js';
import { DEFAULT_PROJECT_ID } from './keys.js';
import { requireProject } from './machine.js';
import { projectOf, baseBranchOf, LOGIN_RE } from './projects.js';

/**
 * Every exported function here talks to exactly one GitHub repository, and
 * which one is decided by the project id it is given. The id is the LAST
 * argument everywhere and REQUIRED (omitting it throws `falta el proyecto en
 * <fn>`, never falls back to {@link DEFAULT_PROJECT_ID}), except in the
 * functions that already took an options object, where it rides inside it as
 * `project` — the contract written down in `keys.js`, section "How the project
 * reaches the modules that do not take a task", point 1.
 *
 * Nothing here may be called without knowing whose repository it is: eight of
 * these functions WRITE to GitHub, each labelled `WRITE (n/8)` where it is
 * defined — `createDraftPr` (1), `readyPr` (2), `addReviewer` (3),
 * `markPrReady` (4), `commentOnPr` (5), `publishIssueComment` (6),
 * `addIssueLabels` (7) and `closeIssue` (8) — and a wrong `-R` is a public
 * mistake in somebody else's repository. Hence: no exported function builds a
 * `gh` argument list without passing its own `projectId` to `repo()`.
 *
 * Two more writes stay outside that numbering, because neither publishes text
 * of ours into a repository named by `-R`: `replyToReviewThread`, whose review
 * thread is a node id unique across all of GitHub and which therefore carries
 * no repository at all, and `requestReviewForChangeRequest`, which resolves
 * threads and re-requests the review of whoever asked for the changes rather
 * than the project's own reviewer. Both say so where they are defined.
 */

// Resolved once per project and cached for the life of the process — unlike
// the assignee and the reviewer, which are read from the registry at every use
// so that a project edited in `projects.json` takes effect on the next call.
// Running `git` on every `gh` invocation isn't free, and a remote doesn't move
// mid-process, so this trades hot-reload parity for one `git` call per project
// instead of one per action.
//
// A failed resolution is cached too (as the Error itself), so a broken
// `origin` is not retried on every call. An UNKNOWN project id is not cached:
// that is not a broken remote, it is a project the registry does not have yet,
// and `saveProjects` can add it while the process runs.
//
// @type {Map<string, string|Error>}
const repoCache = new Map();

/**
 * Where a project's repository name comes from, and why the default project
 * does not read the registry for it.
 *
 * For {@link DEFAULT_PROJECT_ID} this stays EXACTLY what it has always been —
 * live `config.github.repo`, falling back to detection from
 * `config.project.repoPath` — and deliberately not `projectOf('hfs').repo`.
 * The registry freezes its seed from `config` on first load, while `config` is
 * reloaded in place when `config.json` changes; reading the frozen copy would
 * make a hot-edited repo invisible and would break the four `repo()` tests in
 * `repo-identity.test.mjs`, which mutate `config` and expect `repo()` to
 * follow. Same reasoning, and the same exception, as `machineFor` in
 * `keys.js` point 3.
 *
 * Any other project has no `config` of its own, so it reads its registry
 * entry: `repo`, or detection from that project's own checkout.
 *
 * @param {string} projectId
 * @returns {string|null}
 */
function resolveRepo(projectId) {
  if (projectId === DEFAULT_PROJECT_ID) {
    return config.github.repo ?? detectRepo(config.project.repoPath);
  }
  const entry = registryEntry(projectId);
  return entry.repo ?? detectRepo(entry.repoPath);
}

/**
 * The registry entry of a project. **Throws** rather than falling back to the
 * default project: silently answering with hfs's repository, assignee or
 * reviewer is how a `gh pr create` lands in the wrong repository.
 *
 * @param {string} projectId
 * @returns {import('./keys.js').Project}
 */
function registryEntry(projectId) {
  const entry = projectOf(projectId);
  if (!entry) {
    throw new Error(
      `no project registered as ${JSON.stringify(projectId ?? null)}: `
      + 'cannot talk to GitHub without knowing which repository it is',
    );
  }
  return entry;
}

/**
 * The repository (`owner/name`) of one project.
 *
 * @param {string} projectId
 * @returns {string} `owner/name`.
 * @throws {Error} when neither the registry nor detection has an answer.
 */
export function repo(projectId) {
  requireProject(projectId, 'repo');
  const hit = repoCache.get(projectId);
  if (hit instanceof Error) throw hit;
  if (hit) return hit;
  const value = resolveRepo(projectId);
  if (!value) {
    const failure = new Error(
      projectId === DEFAULT_PROJECT_ID
        ? 'could not determine the GitHub repository: config.github.repo is '
          + 'empty and no owner/repo was found in the origin remote of config.project.repoPath'
        : `could not determine the GitHub repository of project "${projectId}": `
          + 'its registry entry declares no `repo` and no owner/repo was found in the '
          + 'origin remote of its `repoPath`',
    );
    repoCache.set(projectId, failure);
    throw failure;
  }
  repoCache.set(projectId, value);
  return value;
}

/**
 * The login whose assigned issues a project watches. From the registry, not
 * from `config.github` — for the default project the registry seeds itself
 * from exactly that value, so nothing changes for hfs.
 *
 * @param {string} projectId
 * @returns {string}
 */
export function assigneeOf(projectId) {
  const login = registryEntry(projectId).assignee;
  if (!login) throw new Error(`project "${projectId}" declares no assignee to watch issues for`);
  return login;
}

/**
 * The login a project asks for review. Checked before use and never passed on
 * empty: `gh pr edit --add-reviewer ""` is a write, and a write with a missing
 * argument fails in public rather than here.
 *
 * @param {string} projectId
 * @returns {string}
 */
function reviewerOf(projectId) {
  return registryEntry(projectId).reviewer || null;
}

/**
 * A review was asked for and there is nobody to ask: the project declares no
 * reviewer and none was picked. Typed so the pipeline can turn it into «elige
 * un revisor» instead of a failure. Thrown BEFORE any `gh` call.
 */
export class NeedsReviewerError extends Error {
  constructor(projectId) {
    super(`el proyecto "${projectId}" no declara un revisor al que pedirle la review`);
    this.name = 'NeedsReviewerError';
    this.code = 'needs_reviewer';
    this.project = projectId;
  }
}

/** The reviewer to ask, or a {@link NeedsReviewerError}. An explicit `login` wins over the registry. */
function reviewerOrThrow(projectId, login) {
  const picked = typeof login === 'string' ? login.trim() : '';
  if (picked && !LOGIN_RE.test(picked)) {
    throw new Error(`reviewer login "${picked}" is not a valid GitHub login: only letters, numbers and hyphens, up to 39 characters`);
  }
  const who = picked || reviewerOf(projectId);
  if (!who) throw new NeedsReviewerError(projectId);
  return who;
}

/** The writing doors that lost their `project =` default must be told which project, loudly. */
function needProject(project, door) {
  if (!project) throw new Error(`${door}: project is missing — nothing is written to GitHub without knowing which repository it is`);
  return project;
}

// The `gh` runner of the doors below; swappable for tests only.
let ghRun = run;
/** Exported for tests only: replaces (or, with no argument, restores) the `gh` runner. */
export function _setGhRunner(fn) { ghRun = fn ?? run; }

/**
 * Exported for tests only: forgets what `repo()` resolved, for one project or
 * for all of them. Production code never needs this — a remote does not move
 * mid-process — but a test that changes what a project points at does.
 *
 * @param {string} [projectId] all projects when omitted.
 */
export function forgetRepoCache(projectId) {
  if (projectId === undefined) repoCache.clear();
  else repoCache.delete(projectId);
}

// `run`'s own default is ten minutes: one hung `gh` would hold a whole poll.
const GH_TIMEOUT_MS = 60_000;

async function issueList(state, limit, projectId) {
  const r = await run('gh', [
    'issue', 'list', '-R', repo(projectId),
    '--assignee', assigneeOf(projectId),
    '--state', state,
    '--json', 'number,title,labels,url,closed,assignees',
    '--limit', String(limit),
  ], { timeoutMs: GH_TIMEOUT_MS });
  if (!r.ok) throw new Error(`gh issue list (${state}) failed: ${r.stderr}`);
  return JSON.parse(r.stdout).map((i) => ({
    number: i.number,
    title: i.title,
    url: i.url,
    closed: Boolean(i.closed),
    labels: (i.labels ?? []).map((l) => l.name),
    assignees: (i.assignees ?? []).map((a) => a.login),
  }));
}

export function listAssignedIssues(projectId) {
  requireProject(projectId, 'listAssignedIssues');
  return issueList('open', 50, projectId);
}

/** Recently closed assignments — the board shows these as completed work. */
export function listClosedAssignedIssues(limit = 12, projectId) {
  requireProject(projectId, 'listClosedAssignedIssues');
  return issueList('closed', limit, projectId);
}

export async function getIssue(number, projectId) {
  requireProject(projectId, 'getIssue');
  const r = await run('gh', [
    'issue', 'view', String(number), '-R', repo(projectId),
    '--json', 'number,title,body,labels,url,state',
  ]);
  if (!r.ok) throw new Error(`gh issue view ${number} failed: ${r.stderr}`);
  const i = JSON.parse(r.stdout);
  return { ...i, labels: (i.labels ?? []).map((l) => l.name) };
}

/**
 * How many issues one query asks about. A GraphQL document is a fixed cost per
 * `gh` process, so the point of batching is to spend one process on a whole
 * candidate set; 50 keeps a single query short enough to read in an error
 * message and a retry cheap.
 */
export const ISSUE_STATE_BATCH = 50;

/**
 * The GraphQL queries that ask ONE repository about a given set of issue
 * numbers — one query per chunk of {@link ISSUE_STATE_BATCH}. Pure and
 * exported so the aliasing, validation and chunking rules are testable
 * without spawning `gh`, like `normalizePrList` and `summarizeChecks`.
 *
 * Why by number at all: `gh issue list --state closed` sorts by issue NUMBER
 * descending, not by closing date, so the two most recently closed assigned
 * issues can sit at index 17 and 30 of that listing and never enter the
 * window. This door lets the board ask about its OWN tasks instead of scanning
 * the repository and hoping they show up.
 *
 * The alias is `i<number>` because a GraphQL alias may not begin with a digit.
 * Numbers are coerced, kept only when `Number.isInteger(n) && n > 0`, deduped
 * and sorted — `Number('')` is 0 and `Number('12a')` is NaN, so an empty field
 * or a half-parsed one would otherwise become issue #0 or a syntax error; a
 * boolean is refused before coercion, since `Number(true)` is a perfectly
 * valid-looking 1. Nothing but those validated integers and the owner/name
 * that `repo()` resolved is ever interpolated into the query text.
 *
 * An empty (or entirely invalid) set returns no queries at all, and does so
 * WITHOUT asking `repo()`: an empty selection set is a GraphQL syntax error,
 * and a project with zero candidates must cost nothing.
 *
 * @param {Array<number|string>} numbers
 * @param {string} projectId
 * @returns {string[]} one query string per chunk.
 */
export function issueStatesQueries(numbers, projectId) {
  requireProject(projectId, 'issueStatesQueries');
  const wanted = [...new Set(
    (numbers ?? [])
      .filter((n) => typeof n === 'number' || typeof n === 'string')
      .map((n) => Number(n)),
  )]
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
  if (!wanted.length) return [];
  const [owner, name] = repo(projectId).split('/');
  const queries = [];
  for (let i = 0; i < wanted.length; i += ISSUE_STATE_BATCH) {
    const fields = wanted
      .slice(i, i + ISSUE_STATE_BATCH)
      .map((n) => `i${n}: issue(number: ${n}) { number state title url labels(first: 20) { nodes { name } } assignees(first: 20) { nodes { login } } }`)
      .join(' ');
    queries.push(`{ repository(owner: "${owner}", name: "${name}") { ${fields} } }`);
  }
  return queries;
}

/**
 * One `gh api graphql` body, turned into the rows the board uses. Pure.
 *
 * Two distinctions the callers depend on:
 *
 * - An alias whose value is `null` — a deleted issue, or a number that belongs
 *   to no issue here — is ABSENT from the map. Recording it as open would
 *   quietly reopen a task GitHub knows nothing about.
 * - No parseable `data.repository` at all returns `null`, not an empty map, so
 *   the caller can tell «GitHub did not answer» from «none of these is
 *   closed». An invented empty map reads as "no issue is closed", which is the
 *   very bug this door exists to fix.
 *
 * Rows are shape-compatible with a row of `issueList` above
 * (`{number, title, url, closed, labels: string[], assignees: string[]}`): `noteIssue` copies
 * `issue.labels` straight onto the task, so the labels must already be flat
 * strings and not GraphQL's `{ nodes: [{ name }] }`.
 *
 * @param {string} stdout the body of one `gh api graphql` call.
 * @returns {Map<number, {number: number, title: string, url: string, closed: boolean, labels: string[], assignees: string[]}>|null}
 */
export function parseIssueStates(stdout) {
  let body;
  try {
    body = JSON.parse(stdout);
  } catch {
    return null;
  }
  const rows = body?.data?.repository;
  if (!rows || typeof rows !== 'object') return null;
  const out = new Map();
  for (const row of Object.values(rows)) {
    if (!row || typeof row !== 'object') continue;   // `null`: no such issue here
    const number = Number(row.number);
    if (!Number.isInteger(number) || number <= 0) continue;
    out.set(number, {
      number,
      title: row.title ?? '',
      url: row.url ?? '',
      closed: row.state === 'CLOSED',
      labels: (row.labels?.nodes ?? []).map((l) => l?.name).filter((n) => typeof n === 'string'),
      assignees: (row.assignees?.nodes ?? []).map((a) => a?.login).filter((n) => typeof n === 'string'),
    });
  }
  return out;
}

/**
 * The live state of the issues the board actually has tasks for, asked by
 * number in batched GraphQL calls — never a repository-wide scan.
 *
 * **`r.stdout` is parsed BEFORE `r.ok` is judged, on purpose.** `gh api
 * graphql` exits 1 when ANY alias fails to resolve, even though stdout carries
 * valid `data` for every other alias. Measured against the real repository:
 *
 *     { repository(...) { i937: issue(number: 937) { state }
 *                         i99999: issue(number: 99999) { state } } }
 *     {"data":{"repository":{"i937":{"state":"CLOSED"},"i99999":null}},
 *      "errors":[{"type":"NOT_FOUND",…}]}   exit = 1
 *
 * So a usable `data.repository` wins over a non-zero exit, and one deleted
 * issue does not blank a whole sweep. It throws only when there is no
 * parseable `data.repository` — the same reason `issueReopenInfo` throws
 * instead of answering `null`: a `gh` hiccup must not look like a real answer.
 *
 * Chunks run one at a time, never `Promise.all`, for the reason `poller.js`
 * gives about classification: a long backlog must not fire dozens of `gh`
 * processes at once. `timeoutMs` is explicit because `run`'s default is ten
 * minutes, which would hold a whole poll cycle hostage.
 *
 * Nothing is cached: this answer is the entire point of the cycle it runs in.
 *
 * @param {Array<number|string>} numbers the issues to ask about.
 * @param {string} projectId
 * @returns {Promise<Map<number, {number: number, title: string, url: string, closed: boolean, labels: string[]}>>}
 * @throws {Error} when a chunk comes back with no parseable `data.repository`.
 */
export async function issueStates(numbers, projectId) {
  requireProject(projectId, 'issueStates');
  const merged = new Map();
  for (const query of issueStatesQueries(numbers, projectId)) {
    const r = await run('gh', ['api', 'graphql', '-f', `query=${query}`], { timeoutMs: 60_000 });
    const rows = parseIssueStates(r.stdout);
    if (!rows) {
      const why = String(r.stderr ?? '').trim().split('\n').pop()?.trim() || `exit ${r.code}`;
      throw new Error(`gh api graphql (issue state) failed: ${why}`);
    }
    for (const [number, row] of rows) merged.set(number, row);
  }
  return merged;
}

/** PRs GitHub has linked to the issue (the "Development" / closing-reference field). */
export async function linkedPullRequests(number, projectId) {
  requireProject(projectId, 'linkedPullRequests');
  const r = await run('gh', [
    'issue', 'view', String(number), '-R', repo(projectId),
    '--json', 'closedByPullRequestsReferences',
  ], { timeoutMs: GH_TIMEOUT_MS });
  if (!r.ok) return [];
  let refs;
  try {
    refs = JSON.parse(r.stdout).closedByPullRequestsReferences ?? [];
  } catch {
    return [];
  }
  // The reference carries only number/url/repository, so ask for title+state
  // separately — knowing whether it is merged or still open changes what the
  // user does about it. Cross-repo references are dropped.
  const own = refs.filter((p) => !p.repository || `${p.repository.owner.login}/${p.repository.name}` === repo(projectId));
  const known = await allPullRequests(projectId);
  return Promise.all(own.map(async (p) => {
    let extra = known.find((pr) => pr.number === p.number);
    if (!extra) {
      const detail = await run('gh', [
        'pr', 'view', String(p.number), '-R', repo(projectId),
        '--json', 'title,state,isDraft,url,createdAt,mergedAt,closedAt',
      ]);
      try { extra = detail.ok ? JSON.parse(detail.stdout) : {}; } catch { extra = {}; }
    }
    return {
      number: p.number,
      url: p.url ?? extra.url ?? `https://github.com/${repo(projectId)}/pull/${p.number}`,
      title: extra.title ?? '',
      state: extra.isDraft ? 'DRAFT' : (extra.state ?? ''),
      createdAt: extra.createdAt ?? null,
      mergedAt: extra.mergedAt ?? null,
      closedAt: extra.closedAt ?? null,
    };
  }));
}

// Same reason as the branch cache: classifying a backlog would otherwise run
// one `gh pr list` per issue.
const PR_TTL_MS = 60_000;
// Keyed by repo() so a board that works across more than one repo never mixes
// their PR lists — that day has arrived, and the key is the repository rather
// than the project id on purpose: two projects pointing at the same repository
// are asking the same question.
const prCache = new Map();

const prInflight = new Map();   // repo -> in-flight `gh pr list`

async function allPullRequests(projectId) {
  requireProject(projectId, 'allPullRequests');
  const r = repo(projectId);
  const cached = prCache.get(r);
  if (cached && Date.now() - cached.at < PR_TTL_MS) return cached.list;
  // Concurrent misses (classification runs several tasks at once) share one call.
  return shared(prInflight, r, () => fetchAllPullRequests(r));
}

async function fetchAllPullRequests(r) {
  const cached = prCache.get(r);
  const result = await run('gh', [
    'pr', 'list', '-R', r, '--state', 'all', '--limit', '200',
    '--json', 'number,title,headRefName,url,state,isDraft,createdAt,mergedAt,closedAt',
  ], { timeoutMs: 2 * 60 * 1000 });
  if (!result.ok) return cached?.list ?? [];
  try {
    const list = JSON.parse(result.stdout);
    prCache.set(r, { at: Date.now(), list });
    return list;
  } catch {
    return cached?.list ?? []; // keep the previous list
  }
}

/**
 * Turns a raw `gh pr list --json ...` array into the board's PR shape and
 * order: `isDraft` folded into `state` (GitHub reports a draft PR as
 * `state: "OPEN"` plus a separate flag — the board only wants one field to
 * switch on), newest `createdAt` first. Pure and exported so the sorting and
 * shape rules are testable without spawning `gh`.
 */
export function normalizePrList(json) {
  return (json ?? [])
    .map((pr) => ({
      number: pr.number,
      url: pr.url,
      title: pr.title ?? '',
      state: pr.isDraft ? 'DRAFT' : pr.state,
      createdAt: pr.createdAt ?? null,
      mergedAt: pr.mergedAt ?? null,
      closedAt: pr.closedAt ?? null,
    }))
    .sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0));
}

// Classification (refreshClassification) wants a 60 s cache like allPullRequests
// above; draftPrPhase/markReady want the live answer instead, so the TTL is
// opt-in per call via `{ cache }` rather than baked into the function. Keyed by
// repo()+branch, unlike `prCache`, because this function is called once per
// branch instead of once for the whole backlog.
const PR_BRANCH_TTL_MS = 60_000;
const prBranchCache = new Map();

/**
 * The key one branch of one project takes in {@link prBranchCache}: the
 * repository first, the bare branch name second.
 *
 * Exported because it is the only part of the cache a test can reach without
 * spawning `gh`, and it is the part that matters: a key that were the branch
 * alone would serve one repository's PR list to another repository's task,
 * which is the collision this whole package exists to prevent, in miniature.
 *
 * @param {string} branch with or without an `origin/` prefix.
 * @param {string} projectId
 * @returns {string}
 */
export function prBranchCacheKey(branch, projectId) {
  requireProject(projectId, 'prBranchCacheKey');
  return `${repo(projectId)}::${branch.replace(/^origin\//, '')}`;
}

/**
 * Every PR of a head branch, newest first, full shape incl. createdAt/mergedAt/
 * closedAt. Throws when `gh` fails — a caller that wants "no PRs" from a failed
 * call would silently forget a merged PR exists, which is exactly the #787 bug.
 * The one exception: with `cache: true`, a failed refresh falls back to the
 * previous cached list (still never an invented `[]`) so a transient GitHub
 * hiccup doesn't wipe classification for every task on the same poll.
 */
export async function prsForBranch(branch, { cache = false, project } = {}) {
  requireProject(project, 'prsForBranch');
  const bare = branch.replace(/^origin\//, '');
  const key = prBranchCacheKey(bare, project);
  if (cache) {
    const hit = prBranchCache.get(key);
    // A copy, not the cached array itself: a caller that mutates its result
    // (or one entry in it) must never corrupt what the next cache hit hands
    // out to someone else.
    if (hit && Date.now() - hit.at < PR_BRANCH_TTL_MS) return hit.list.map((p) => ({ ...p }));
  }
  const r = await run('gh', [
    'pr', 'list', '-R', repo(project), '--head', bare, '--state', 'all', '--limit', '30',
    '--json', 'number,url,title,state,isDraft,createdAt,mergedAt,closedAt',
  ], { timeoutMs: GH_TIMEOUT_MS });
  if (!r.ok) {
    const stale = cache && prBranchCache.get(key);
    if (stale) return stale.list.map((p) => ({ ...p }));
    throw new Error(`gh pr list --head ${bare} failed: ${r.stderr}`);
  }
  let list;
  try {
    list = normalizePrList(JSON.parse(r.stdout));
  } catch (e) {
    const stale = cache && prBranchCache.get(key);
    if (stale) return stale.list.map((p) => ({ ...p }));
    throw new Error(`could not read the PRs of ${bare}: ${e.message}`);
  }
  // Written on a live fetch too: a caller that insisted on fresh data (the
  // reopen check, a PR the board holds open) has just paid for the list, and
  // the next cached caller in the same poll should reuse it, not ask again.
  prBranchCache.set(key, { at: Date.now(), list: list.map((p) => ({ ...p })) });
  return list;
}

/** The PR already open for a head branch, if any. Uncached: callers act on it. */
export async function findPrForBranch(branch, projectId) {
  requireProject(projectId, 'findPrForBranch');
  const list = await prsForBranch(branch, { project: projectId });
  return list.find((pr) => pr.state === 'OPEN' || pr.state === 'DRAFT') ?? null;
}

// No cwd: `gh` runs on the board's machine whatever machine holds the
// worktree, and `-R` plus `--head` tell it everything a checkout would.
//
// WRITE (1/8). `-R` decides which repository gets a new pull request, so
// `project` is resolved through `repo()` like everywhere else and never
// inferred from the branch name.
export async function createDraftPr({ branch, title, body, project }) {
  needProject(project, 'createDraftPr');
  // Same gate as the review replies: an agent wrote this body, and the PR is
  // the most read thing the board publishes.
  // At the project's language: the English-only rule is the default, not the
  // rule of a project whose own text is Spanish (`language: 'es'`).
  const language = projectOf(project)?.language ?? 'en';
  assertPublishable(title, `el título del PR de ${branch}`, { maxChars: PR_TITLE_MAX, language });
  assertPublishable(body, `el cuerpo del PR de ${branch}`, { maxChars: 60_000, language });
  const dir = mkdtempSync(path.join(tmpdir(), 'hfsmon-'));
  const bodyFile = path.join(dir, 'pr-body.md');
  writeFileSync(bodyFile, body, 'utf8');
  try {
    const r = await ghRun('gh', [
      'pr', 'create', '--draft', '-R', repo(project),
      '--base', baseBranchOf(project), '--head', branch,
      '--title', title, '--body-file', bodyFile,
    ]);
    if (!r.ok) throw new Error(`gh pr create failed: ${r.stderr}`);
    const url = r.stdout.trim().split(/\r?\n/).pop();
    const number = Number(url.match(/\/pull\/(\d+)/)?.[1]);
    return { url, number };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One PR's live `{ number, state, isDraft, author }` — never cached: callers
 * act on it. `author` is the PR author's login, or null; the reviewer dialog
 * uses it to leave them out (nobody reviews their own PR).
 */
export async function prView(number, projectId) {
  requireProject(projectId, 'prView');
  const r = await run('gh', [
    'pr', 'view', String(number), '-R', repo(projectId), '--json', 'number,state,isDraft,author',
  ]);
  if (!r.ok) throw new Error(`gh pr view ${number} failed: ${r.stderr}`);
  let raw;
  try {
    raw = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`could not read PR #${number}: ${e.message}`);
  }
  return { number: raw.number, state: raw.isDraft ? 'DRAFT' : raw.state, isDraft: Boolean(raw.isDraft), author: raw.author?.login ?? null };
}

/**
 * When the issue was last reopened on GitHub (the reopening event's ISO
 * timestamp), or `null` when there is genuinely no `ReopenedEvent` in its
 * timeline. Throws instead of swallowing a failed call into `null` — callers
 * treat `null` as "never reopened", and a `gh` hiccup must not look the same
 * as that.
 */
export async function issueReopenInfo(issue, projectId) {
  requireProject(projectId, 'issueReopenInfo');
  const [owner, name] = repo(projectId).split('/');
  const query = `{ repository(owner: "${owner}", name: "${name}") {
    issue(number: ${Number(issue)}) {
      timelineItems(itemTypes: [REOPENED_EVENT], last: 1) {
        nodes { ... on ReopenedEvent { createdAt } }
      }
    } } }`;
  const r = await run('gh', ['api', 'graphql', '-f', `query=${query}`], { timeoutMs: GH_TIMEOUT_MS });
  if (!r.ok) throw new Error(`gh api graphql (reopened event of #${issue}) failed: ${r.stderr}`);
  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`could not read the timeline of #${issue}: ${e.message}`);
  }
  const nodes = data?.data?.repository?.issue?.timelineItems?.nodes ?? [];
  return nodes[0]?.createdAt ?? null;
}

/**
 * WRITE (2/8). `gh pr ready` alone — split out of `markPrReady` so B can add
 * the reviewer separately. Takes a PR number that only means anything inside
 * one repository, hence the project.
 */
export async function readyPr(number, projectId) {
  requireProject(projectId, 'readyPr');
  const r = await ghRun('gh', ['pr', 'ready', String(number), '-R', repo(projectId)]);
  if (!r.ok) throw new Error(`gh pr ready failed: ${r.stderr}`);
}

/**
 * WRITE (3/8). `gh pr edit --add-reviewer` with the project's reviewer, alone.
 * The login comes from the registry entry, so a second project asks its own
 * reviewer and not hfs's; an explicit `login` (picked in the reviewer dialog)
 * overrides it. No reviewer at all throws {@link NeedsReviewerError}.
 */
export async function addReviewer(number, projectId, login) {
  needProject(projectId, 'addReviewer');
  // Resolved first: with nobody to ask, `gh` is never called.
  const reviewer = reviewerOrThrow(projectId, login);
  const r = await ghRun('gh', [
    'pr', 'edit', String(number), '-R', repo(projectId),
    '--add-reviewer', reviewer,
  ]);
  if (!r.ok) throw new Error(`gh pr edit --add-reviewer failed: ${r.stderr}`);
}

/**
 * WRITE (4/8). Both of the two above, in one go. An explicit `login` (picked
 * in the reviewer dialog) overrides the registry's reviewer.
 */
export async function markPrReady(prNumber, projectId, login) {
  requireProject(projectId, 'markPrReady');
  // Before the first write: a PR must not be left ready with nobody to review it.
  const reviewer = reviewerOrThrow(projectId, login);
  const ready = await ghRun('gh', ['pr', 'ready', String(prNumber), '-R', repo(projectId)]);
  if (!ready.ok) throw new Error(`gh pr ready failed: ${ready.stderr}`);
  const review = await ghRun('gh', [
    'pr', 'edit', String(prNumber), '-R', repo(projectId),
    '--add-reviewer', reviewer,
  ]);
  if (!review.ok) throw new Error(`gh pr edit --add-reviewer failed: ${review.stderr}`);
}

const USERS_TTL_MS = 5 * 60 * 1000;
const USERS_MAX = 30;
const USERS_PAGES = 3;
/** @type {Map<string, {at: number, users: {login: string, name?: string}[]}>} */
const usersCache = new Map();
/** A hung `gh` must not stall the reviewer dialog: each read gives up after this. */
const USERS_TIMEOUT_MS = 20_000;
/** One in-flight lookup per repository: typing before the cache is warm shares it. */
const usersInflight = new Map();

/**
 * Case-insensitive filter of candidate reviewers, at most 30. The PR author is
 * ANNOTATED (`isAuthor: true`), never removed: GitHub itself decides whether
 * they can be asked, and on a one-person repository they are the only
 * candidate. Pure.
 *
 * @param {{login: string, name?: string}[]} users
 * @param {string} [query]
 * @param {string|null} [authorLogin]
 * @returns {{login: string, name?: string, isAuthor?: true}[]}
 */
export function filterUsers(users, query = '', authorLogin = null) {
  const q = String(query ?? '').trim().toLowerCase();
  const author = authorLogin ? String(authorLogin).toLowerCase() : null;
  const out = [];
  for (const u of users ?? []) {
    if (!u?.login) continue;
    if (q && !u.login.toLowerCase().includes(q) && !(u.name ?? '').toLowerCase().includes(q)) continue;
    const one = u.name ? { login: u.login, name: u.name } : { login: u.login };
    if (author && u.login.toLowerCase() === author) one.isAuthor = true;
    out.push(one);
    if (out.length >= USERS_MAX) break;
  }
  return out;
}

/**
 * READ. Up to {@link USERS_PAGES} pages of 100 from a `gh api` list endpoint.
 * Null when the first page fails or answers garbage (a soft failure: the caller
 * skips this source); a later page that fails just ends the list. Logins that
 * the registry would not accept (`dependabot[bot]`) are dropped.
 */
async function fetchUsers(runner, endpoint) {
  const all = [];
  for (let page = 1; page <= USERS_PAGES; page += 1) {
    let list;
    try {
      const r = await runner('gh', ['api', `${endpoint}?per_page=100&page=${page}`], { timeoutMs: USERS_TIMEOUT_MS });
      if (!r?.ok) { if (page === 1) return null; break; }
      list = JSON.parse(r.stdout);
      if (!Array.isArray(list)) { if (page === 1) return null; break; }
    } catch {
      if (page === 1) return null;
      break;
    }
    for (const u of list) {
      if (!u || typeof u.login !== 'string' || !LOGIN_RE.test(u.login)) continue;
      all.push(typeof u.name === 'string' && u.name ? { login: u.login, name: u.name } : { login: u.login });
    }
    if (list.length < 100) break;
  }
  return all;
}

/** READ. The repository owner's type (`User` or `Organization`), or null when it cannot be read. */
async function ownerType(runner, repoName) {
  try {
    const r = await runner('gh', ['api', `repos/${repoName}`], { timeoutMs: USERS_TIMEOUT_MS });
    if (!r?.ok) return null;
    const type = JSON.parse(r.stdout)?.owner?.type;
    return typeof type === 'string' ? type : null;
  } catch {
    return null;
  }
}

/**
 * READ-only. Everyone who can be asked for review in the project's repository:
 * the union of its assignable users, collaborators and contributors, plus the
 * owner's members when the owner is an Organization. Deduplicated by login
 * (case-insensitive) and sorted alphabetically. A source that fails (403, 404,
 * garbage) is skipped; the search fails only as an empty list. Cached 5
 * minutes per repository, and only when it found somebody: an empty or failed
 * answer must not hide the list after a transient `gh` error. The project
 * rides in the options object (there is no default).
 *
 * `authorLogin` (alias `excludeLogin`, the old name) only annotates.
 *
 * @param {string} query
 * @param {{authorLogin?: string|null, excludeLogin?: string|null, project: string, runner?: Function, now?: () => number}} opts
 * @returns {Promise<{login: string, name?: string, isAuthor?: true}[]>}
 */
export async function searchRepoUsers(query, { authorLogin = null, excludeLogin = null, project, runner = ghRun, now = Date.now } = {}) {
  needProject(project, 'searchRepoUsers');
  const repoName = repo(project);
  const hit = usersCache.get(repoName);
  let users = hit && now() - hit.at < USERS_TTL_MS ? hit.users : null;
  if (!users) {
    let pending = usersInflight.get(repoName);
    if (!pending) {
      pending = loadRepoUsers(runner, repoName, now).finally(() => usersInflight.delete(repoName));
      usersInflight.set(repoName, pending);
    }
    users = await pending;
  }
  return filterUsers(users, query, authorLogin ?? excludeLogin);
}

/** READ. The uncached union behind {@link searchRepoUsers}; caches it when non-empty. */
async function loadRepoUsers(runner, repoName, now) {
  const owner = repoName.split('/')[0];
  const [assignees, collaborators, contributors, type] = await Promise.all([
    fetchUsers(runner, `repos/${repoName}/assignees`),
    fetchUsers(runner, `repos/${repoName}/collaborators`),
    fetchUsers(runner, `repos/${repoName}/contributors`),
    ownerType(runner, repoName),
  ]);
  const members = type === 'Organization' ? await fetchUsers(runner, `orgs/${owner}/members`) : null;
  const seen = new Map();
  for (const list of [assignees, collaborators, contributors, members]) {
    for (const u of list ?? []) {
      const key = u.login.toLowerCase();
      if (!seen.has(key)) seen.set(key, u);
    }
  }
  const users = [...seen.values()].sort((x, y) => {
    const a = x.login.toLowerCase();
    const b = y.login.toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  });
  if (users.length) usersCache.set(repoName, { at: now(), users });
  return users;
}

/** Exported for tests only: forgets the cached user lists. */
export function _forgetUsersCache() { usersCache.clear(); usersInflight.clear(); }

/**
 * A PR's checks, boiled down to the three things a traffic light needs.
 *
 * GitHub reports two shapes and they disagree about everything: a `CheckRun`
 * carries `status` plus `conclusion`, a `StatusContext` only `state`. Skipped
 * and neutral runs count as passed — this repo skips three by routine on every
 * PR, and calling that "not green" would light the board up for nothing.
 *
 * Pure and exported so it can be tested against real payloads without network.
 */
export function summarizeChecks(rollup) {
  const counts = { failed: 0, pending: 0, passed: 0, total: 0 };
  for (const c of rollup ?? []) {
    counts.total += 1;
    if (c.__typename === 'StatusContext') {
      if (['PENDING', 'EXPECTED'].includes(c.state)) counts.pending += 1;
      else if (c.state === 'SUCCESS') counts.passed += 1;
      else counts.failed += 1;
      continue;
    }
    if (c.status !== 'COMPLETED') counts.pending += 1;
    else if (['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(c.conclusion)) counts.passed += 1;
    else counts.failed += 1;
  }
  return counts;
}

// One call covers every open PR in the repo — measured at 3.5 s for 16 — where
// asking per task would be one round trip each, every cycle.
const CHECKS_TTL_MS = 60_000;
// Keyed by repo() — see prCache above for why.
const checksCache = new Map();

/**
 * Check state for every open PR, keyed by number. Closed and merged PRs are not
 * asked about on purpose: their CI describes work that is already over.
 */
export async function checksForOpenPrs({ force = false, project } = {}) {
  requireProject(project, 'checksForOpenPrs');
  const r = repo(project);
  const cached = checksCache.get(r);
  if (!force && cached && Date.now() - cached.at < CHECKS_TTL_MS) return cached.byNumber;
  const result = await run('gh', [
    'pr', 'list', '-R', r, '--state', 'open', '--limit', '100',
    '--json', 'number,headRefOid,isDraft,statusCheckRollup',
  ], { timeoutMs: 2 * 60 * 1000 });
  if (!result.ok) return cached?.byNumber ?? new Map();

  try {
    const byNumber = new Map();
    for (const pr of JSON.parse(result.stdout)) {
      byNumber.set(pr.number, {
        ...summarizeChecks(pr.statusCheckRollup),
        headRefOid: pr.headRefOid ?? null,
        isDraft: Boolean(pr.isDraft),
        at: new Date().toISOString(),
      });
    }
    checksCache.set(r, { at: Date.now(), byNumber });
    return byNumber;
  } catch {
    return cached?.byNumber ?? new Map(); // keep the previous answer rather than inventing one
  }
}

/**
 * Change requests on a PR: the reviews that asked for changes, each with its
 * body and the inline comments belonging to it.
 *
 * Three calls because GitHub splits the information three ways: the reviews
 * themselves, their inline comments, and — only over GraphQL — the thread ids
 * needed to mark those comments resolved later.
 *
 * Uncached, like `findPrForBranch`: the caller acts on the result.
 */
export async function getChangeRequests(prNumber, projectId) {
  requireProject(projectId, 'getChangeRequests');
  // Deliberately the REST reviews endpoint and not `gh pr view --json reviews`:
  // that one returns node ids (PRR_kwDO…) while the comments carry the numeric
  // `pull_request_review_id`, so the two never match and every change request
  // would silently come back with no comments at all.
  const [meta, reviews] = await Promise.all([
    run('gh', ['pr', 'view', String(prNumber), '-R', repo(projectId), '--json', 'reviewDecision,headRefOid'], { timeoutMs: GH_TIMEOUT_MS }),
    run('gh', ['api', `repos/${repo(projectId)}/pulls/${prNumber}/reviews`, '--paginate'], { timeoutMs: GH_TIMEOUT_MS }),
  ]);
  if (!meta.ok) throw new Error(`gh pr view failed: ${meta.stderr}`);
  if (!reviews.ok) throw new Error(`gh api pulls/${prNumber}/reviews failed: ${reviews.stderr}`);

  let head = {};
  let all = [];
  try {
    head = JSON.parse(meta.stdout);
    all = JSON.parse(reviews.stdout);
  } catch (e) {
    throw new Error(`could not read the reviews of PR #${prNumber}: ${e.message}`);
  }

  const base = { reviewDecision: head.reviewDecision ?? null, headRefOid: head.headRefOid ?? null };
  const requested = all.filter((r) => r.state === 'CHANGES_REQUESTED');
  if (!requested.length) return { ...base, changeRequests: [] };

  const [comments, threads] = await Promise.all([
    reviewComments(prNumber, projectId),
    reviewThreads(prNumber, projectId),
  ]);

  const changeRequests = requested.map((review) => {
    // Pair each comment with its thread: GitHub exposes no direct link, and the
    // thread id is what `resolveReviewThread` needs later.
    const own = comments
      .filter((c) => c.reviewId === review.id)
      .map((c) => ({ ...c, threadId: threads.find((t) => t.commentIds.includes(c.id))?.threadId ?? null }));
    return {
      reviewId: review.id,
      author: review.user?.login ?? 'desconocido',
      // The commit the reviewer was reading. It is the honest baseline for
      // "what changed since they looked", even if the fix came days later.
      commitId: review.commit_id ?? null,
      submittedAt: review.submitted_at,
      url: review.html_url,
      body: review.body ?? '',
      comments: own,
      threadIds: [...new Set(own.map((c) => c.threadId).filter(Boolean))],
    };
  });

  return { ...base, changeRequests };
}

async function reviewComments(prNumber, projectId) {
  const r = await run('gh', ['api', `repos/${repo(projectId)}/pulls/${prNumber}/comments`, '--paginate']);
  if (!r.ok) return [];
  try {
    return JSON.parse(r.stdout).map((c) => ({
      id: c.id,
      reviewId: c.pull_request_review_id,
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      body: c.body ?? '',
      url: c.html_url,
    }));
  } catch {
    return [];
  }
}

/** Thread ids and the comments they hold — only GraphQL exposes these. */
async function reviewThreads(prNumber, projectId) {
  const [owner, name] = repo(projectId).split('/');
  const query = `{ repository(owner: "${owner}", name: "${name}") {
    pullRequest(number: ${prNumber}) {
      reviewThreads(first: 100) {
        nodes { id isResolved comments(first: 100) { nodes { databaseId } } }
      } } } }`;
  const r = await run('gh', ['api', 'graphql', '-f', `query=${query}`]);
  if (!r.ok) return [];
  try {
    return JSON.parse(r.stdout).data.repository.pullRequest.reviewThreads.nodes.map((t) => ({
      threadId: t.id,
      isResolved: t.isResolved,
      commentIds: t.comments.nodes.map((c) => c.databaseId),
    }));
  } catch {
    return [];
  }
}

/**
 * Answers one review thread. The reply lands inside the thread, where the
 * reviewer left the remark — which is where they will look for the answer.
 *
 * The text is checked here, at the wire, and not where it was drafted: this is
 * the only door to GitHub, so passing through it is not optional.
 */
export async function replyToReviewThread(threadId, body, projectId) {
  requireProject(projectId, 'replyToReviewThread');
  assertPublishable(body, `la respuesta al hilo ${threadId}`);
  // `projectId` is accepted for the uniform signature (`keys.js`, point 1) and
  // is deliberately NOT on the wire: a review-thread node id is unique across
  // all of GitHub, so this mutation carries no repository and cannot land in
  // the wrong one. Validated anyway, so a caller that passes a project the
  // registry does not know hears about it here and not three calls later.
  registryEntry(projectId);
  // The body travels as a GraphQL variable — review replies carry backticks,
  // quotes and newlines that would break an interpolated query — and as a raw
  // field (`-f`), not a typed one: `-F` would read a reply starting with
  // "@someone" as a filename and a numeric one as a number.
  const r = await run('gh', [
    'api', 'graphql',
    '-f', 'query=mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) { comment { url } } }',
    '-f', `thread=${threadId}`,
    '-f', `body=${body}`,
  ]);
  if (!r.ok) throw new Error(`could not reply to thread ${threadId}: ${r.stderr.trim().split('\n').pop()}`);
  try {
    return JSON.parse(r.stdout).data.addPullRequestReviewThreadReply.comment.url;
  } catch {
    return null;
  }
}

/**
 * WRITE (5/8). A plain comment on the PR — used when a review left no inline
 * threads. `-R` names the repository the comment is published in.
 */
export async function commentOnPr(prNumber, body, projectId) {
  requireProject(projectId, 'commentOnPr');
  assertPublishable(body, `el comentario en el PR #${prNumber}`);
  const dir = mkdtempSync(path.join(tmpdir(), 'hfsmon-'));
  const file = path.join(dir, 'comment.md');
  writeFileSync(file, body, 'utf8');
  try {
    const r = await run('gh', ['pr', 'comment', String(prNumber), '-R', repo(projectId), '--body-file', file]);
    if (!r.ok) throw new Error(`gh pr comment failed: ${r.stderr}`);
    return r.stdout.trim().split(/\r?\n/).pop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Hands the change request back to its author: marks its threads resolved and
 * re-requests their review. Never dismisses the review — that would be the
 * author overruling their own reviewer, and it is theirs to lift.
 */
export async function requestReviewForChangeRequest(prNumber, changeRequest, projectId) {
  requireProject(projectId, 'requestReviewForChangeRequest');
  // A write too (it resolves threads and re-requests a review), and the only
  // one whose reviewer is NOT the project's: it is the author of the change
  // request, read off the review itself. The repository still has to be the
  // project's, which is what `-R` below is for.
  const failures = [];
  for (const threadId of changeRequest.threadIds ?? []) {
    const r = await run('gh', ['api', 'graphql', '-f',
      `query=mutation { resolveReviewThread(input: {threadId: "${threadId}"}) { thread { isResolved } } }`]);
    if (!r.ok) failures.push(`${threadId}: ${r.stderr.trim().split('\n').pop()}`);
  }

  const reviewer = changeRequest.author;
  const req = await run('gh', [
    'pr', 'edit', String(prNumber), '-R', repo(projectId), '--add-reviewer', reviewer,
  ]);
  if (!req.ok) throw new Error(`could not request review again from ${reviewer}: ${req.stderr}`);

  return { reviewer, resolved: (changeRequest.threadIds ?? []).length - failures.length, failures };
}

// ---------------------------------------------------------------------------
// Closing an issue without a pull request
//
// When the analysis concludes that nothing has to change, the board does not
// open a PR: an agent drafts a closing comment, a person confirms it, and only
// then does this section publish it, label the issue and close it. Everything
// below is either pure (and exported so it can be tested without `gh`) or one
// thin `gh` call, same as the rest of the module.

/**
 * How long a closing comment may be.
 *
 * `publishProblems` defaults to 4 000 characters because what goes through it
 * today is a reply to a review — a paragraph or two. A closing comment is a
 * different animal: it says why the issue is being closed, what already covers
 * it and where (with paths), which gaps are left and what stays out of scope.
 * A PR body, at the other end, is allowed 60 000 (`PR_BODY_MAX` in
 * `ghgate.js`). This sits in between on purpose: room for a documented
 * argument, not room for the whole analysis.
 */
export const CLOSE_COMMENT_MAX = 20_000;

/**
 * The invisible marker that makes a closing comment findable again, so a
 * re-publication edits the comment instead of stacking a second one.
 *
 * It says `claude-agent`, a neutral tag that stays valid whatever the board is
 * called: the marker travels inside the text that `publishProblems` reads, and
 * existing comments already carry it, so changing it would orphan them.
 *
 * @param {number|string} issue
 * @returns {string} an HTML comment, invisible in the rendered comment.
 */
export function closingCommentMarker(issue) {
  return `<!-- claude-agent:issue-close:${Number(issue)} -->`;
}

/** When a comment was written, as a sortable number; falls back to its id. */
function commentStamp(c) {
  const t = Date.parse(c?.createdAt ?? '');
  return Number.isNaN(t) ? Number(c?.id ?? 0) : t;
}

/**
 * The closing comment we published before, if it is still there and still ours.
 *
 * Looks obvious and is not, because of GitHub's "Quote reply": it copies the
 * raw markdown of a comment into a new one, HTML marker included. So a comment
 * carrying our marker can perfectly well have been written by somebody else,
 * and the marker alone does not prove authorship. Hence every match is filtered
 * by `login` before it is treated as ours, and a quoted marker from a human
 * yields `'none'` — not ours to edit, but no reason to refuse to publish a new
 * one either. Without that, one quote would block the closing of an issue
 * forever.
 *
 * The stored `commentId` is stronger evidence than the marker, but only if the
 * comment it points at is ours. If it is not, the board is holding a corrupt id
 * and the answer is `'foreign'`: stop, publish nothing. If the id is simply
 * gone (deleted), the marker takes over.
 *
 * @param {Array<{id:number|string, body?:string, author?:string, url?:string,
 *   createdAt?:string}>} comments as returned by {@link issueComments}.
 * @param {{commentId?: number|string|null, marker: string, login: string}} opts
 * @returns {{comment: object|null, how: 'id'|'marker'|'none'|'foreign'}}
 * @throws {Error} when `login` is missing — comparing authors against `null`
 *   would make every anonymous-looking comment "ours".
 */
export function findPriorClosingComment(comments, { commentId = null, marker, login } = {}) {
  if (!login) {
    throw new Error(
      'findPriorClosingComment needs our own login: without it we cannot '
      + 'tell our comment apart from someone else quoting it',
    );
  }
  if (!marker) {
    throw new Error('findPriorClosingComment needs the marker: any comment carries an empty marker');
  }
  const list = Array.isArray(comments) ? comments : [];

  if (commentId !== null && commentId !== undefined && commentId !== '') {
    const hit = list.find((c) => String(c.id) === String(commentId));
    if (hit) {
      if (hit.author === login) return { comment: hit, how: 'id' };
      return { comment: null, how: 'foreign' };
    }
    // Gone from the list: somebody deleted it. Fall through to the marker.
  }

  const mine = list.filter((c) => c.author === login && String(c.body ?? '').includes(marker));
  if (!mine.length) return { comment: null, how: 'none' };
  const newest = mine.reduce((a, b) => (commentStamp(b) >= commentStamp(a) ? b : a));
  return { comment: newest, how: 'marker' };
}

/**
 * The argv for closing one issue. Pure, so the flag rules below are testable
 * without spawning anything — and they are worth testing, because `gh` reads
 * each of them differently.
 *
 * `gh` 2.98.0 takes `--reason {completed|not planned|duplicate}` and
 * `--duplicate-of <number|url>`:
 *
 * - `not planned` is ONE argv element, space and all. `run()` uses `spawn`
 *   without a shell, so there are no quotes to add and nothing splits it.
 * - a duplicate of an ISSUE travels as `--duplicate-of` with no `--reason`:
 *   the link is what makes GitHub mark it a duplicate, and `gh` derives the
 *   state from it.
 * - a duplicate of a PULL REQUEST is the reverse — `--reason duplicate`, no
 *   `--duplicate-of` — because that flag resolves the number against the
 *   repository's Issues and a PR is not one (`gh` says so itself: "`--duplicate-of`
 *   must reference an issue"). The PR is named in the closing comment instead.
 *
 *   **This one is UNVERIFIED against GitHub.** Both shapes pass `gh`'s local
 *   flag validation, but nobody has watched the server accept a
 *   `stateReason: DUPLICATE` with no duplicate to point at — checking it means
 *   closing a real issue. If GitHub refuses it, every duplicate-of-a-PR close
 *   fails, and the way out is to fall back to `not planned` with the PR cited
 *   in the comment. Do not read the bullet above as a tested fact.
 *
 * `duplicateOf` is required for both, PR target included: "duplicate of
 * nothing" is not a closing reason, even when the number never reaches the
 * wire.
 *
 * @param {{issue: number|string, reason: 'completed'|'not_planned'|'duplicate',
 *   duplicateOf?: number|string|null, repo: string, targetIsPr?: boolean}} spec
 * @returns {string[]} argv for `gh`.
 * @throws {Error} on an unknown reason, or a duplicate with no target.
 */
export function closeIssueArgs({ issue, reason, duplicateOf = null, repo, targetIsPr = false }) {
  const base = ['issue', 'close', String(issue), '-R', repo];
  if (reason === 'completed') return [...base, '--reason', 'completed'];
  if (reason === 'not_planned') return [...base, '--reason', 'not planned'];
  if (reason === 'duplicate') {
    if (duplicateOf === null || duplicateOf === undefined || String(duplicateOf).trim() === '') {
      throw new Error(`cannot close issue #${issue} as a duplicate without saying what it duplicates`);
    }
    if (targetIsPr === true) return [...base, '--reason', 'duplicate'];
    return [...base, '--duplicate-of', String(duplicateOf)];
  }
  throw new Error(`unknown close reason: ${JSON.stringify(reason ?? null)}`);
}

/**
 * Every comment on an issue, oldest first.
 *
 * `--slurp` is not optional next to `--paginate`: without it `gh` concatenates
 * the pages as `[…][…]` and `JSON.parse` blows up past 100 comments (its own
 * help says so). With it, stdout is an array OF PAGES, which is why this
 * flattens.
 *
 * **Throws when the read fails.** A failed read must never look like "there is
 * no previous comment", because that is exactly how a second copy of the
 * closing comment gets published.
 *
 * @param {number|string} number
 * @param {string} projectId
 * @returns {Promise<Array<{id:number, body:string, url:string, author:string,
 *   createdAt:string, updatedAt:string}>>}
 */
export async function issueComments(number, projectId) {
  requireProject(projectId, 'issueComments');
  const r = await run('gh', [
    'api', `repos/${repo(projectId)}/issues/${Number(number)}/comments`,
    '--paginate', '--slurp',
  ]);
  if (!r.ok) throw new Error(`gh api issues/${number}/comments failed: ${r.stderr}`);
  let pages;
  try {
    pages = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`could not read the comments of issue #${number}: ${e.message}`);
  }
  if (!Array.isArray(pages)) {
    throw new Error(`could not read the comments of issue #${number}: the response is not a list`);
  }
  return pages.flat().map((c) => ({
    id: c.id,
    body: c.body ?? '',
    url: c.html_url,
    author: c.user?.login ?? null,
    createdAt: c.created_at ?? null,
    updatedAt: c.updated_at ?? null,
  }));
}

// The login `gh` is authenticated as. It is a property of the machine's `gh`,
// not of the project, so one answer serves every project.
//
// ONLY SUCCESS is cached, unlike `repoCache` above, which caches the Error too:
// a broken `origin` stays broken, but a transient failure of `gh api user` is
// over in a second, and caching it would block every issue closing until
// somebody restarts the board.
let currentLoginPromise = null;

/**
 * The login the board publishes as. Cached for the life of the process on
 * success, retried after a failure.
 *
 * @param {string} [projectId] validated for the uniform signature; the call
 *   itself carries no repository.
 * @returns {Promise<string>}
 */
export async function currentLogin(projectId) {
  requireProject(projectId, 'currentLogin');
  registryEntry(projectId);
  if (currentLoginPromise) return currentLoginPromise;
  const attempt = (async () => {
    const r = await run('gh', ['api', 'user', '--jq', '.login']);
    if (!r.ok) throw new Error(`gh api user failed: ${r.stderr}`);
    const login = r.stdout.trim();
    if (!login) throw new Error('gh api user returned no login: cannot tell which account publishes');
    return login;
  })();
  currentLoginPromise = attempt;
  // Forget the failure so the next caller tries again; this handler also keeps
  // the rejection from being an unhandled one when nobody is awaiting yet.
  attempt.catch(() => { if (currentLoginPromise === attempt) currentLoginPromise = null; });
  return attempt;
}

// Same 60 s shape as `prCache`, and keyed by repo() for the same reason: a
// label catalogue belongs to a repository, not to a project id.
const LABELS_TTL_MS = 60_000;
const labelsCache = new Map();

/**
 * The repository's label catalogue.
 *
 * `--limit 200` is not decoration: `gh label list` stops at 30 by default, and
 * a truncated catalogue would make {@link addIssueLabels} reject labels that
 * exist perfectly well.
 *
 * A failed refresh serves the previous list, like `prsForBranch({cache:true})`.
 * With no previous list it THROWS — an invented `[]` would turn every label
 * into an unknown one.
 *
 * @param {string} projectId
 * @returns {Promise<Array<{name:string, color:string, description:string}>>}
 */
export async function repoLabels(projectId) {
  requireProject(projectId, 'repoLabels');
  const r = repo(projectId);
  const hit = labelsCache.get(r);
  // A copy, never the cached array: a caller that mutates its result must not
  // corrupt the next cache hit.
  const copy = (list) => list.map((l) => ({ ...l }));
  if (hit && Date.now() - hit.at < LABELS_TTL_MS) return copy(hit.list);

  const result = await run('gh', [
    'label', 'list', '-R', r, '--limit', '200', '--json', 'name,color,description',
  ]);
  if (!result.ok) {
    if (hit) return copy(hit.list);
    throw new Error(`gh label list failed: ${result.stderr}`);
  }
  let list;
  try {
    list = JSON.parse(result.stdout).map((l) => ({
      name: l.name,
      color: l.color ?? '',
      description: l.description ?? '',
    }));
  } catch (e) {
    if (hit) return copy(hit.list);
    throw new Error(`could not read the labels of ${r}: ${e.message}`);
  }
  labelsCache.set(r, { at: Date.now(), list });
  return copy(list);
}

/**
 * What number `n` is in this repository: an issue, a pull request, or nothing.
 *
 * `repos/{owner}/{repo}/issues/{n}` answers for BOTH — a PR is an issue with a
 * `pull_request` field — which is the only way to tell them apart in one call.
 *
 * `null` means a real 404 and nothing else. `gh` exits 1 for every kind of
 * failure, so the exit code cannot tell "that issue does not exist" from "the
 * network hiccuped"; the 404 is read off stderr instead, and anything else
 * throws. A hiccup reported as "does not exist" would let a duplicate be
 * closed against a number nobody checked.
 *
 * @param {number|string} number
 * @param {string} projectId
 * @returns {Promise<{number:number, title:string, state:string, url:string,
 *   isPr:boolean}|null>}
 */
export async function issueOrPrRef(number, projectId) {
  requireProject(projectId, 'issueOrPrRef');
  const r = await run('gh', ['api', `repos/${repo(projectId)}/issues/${Number(number)}`]);
  if (!r.ok) {
    if (/HTTP 404/.test(r.stderr)) return null;
    throw new Error(`gh api issues/${number} failed: ${r.stderr}`);
  }
  let raw;
  try {
    raw = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`could not read reference #${number}: ${e.message}`);
  }
  return {
    number: raw.number,
    title: raw.title ?? '',
    // Uppercased so it reads like `getIssue`/`prView`, which come from the
    // `--json` surface; this REST endpoint answers in lowercase.
    state: String(raw.state ?? '').toUpperCase(),
    url: raw.html_url ?? `https://github.com/${repo(projectId)}/issues/${Number(number)}`,
    isPr: raw.pull_request != null,
  };
}

/**
 * WRITE (6/8). Publishes the closing comment on an issue, or edits the one
 * already published.
 *
 * The order matters and is part of the design:
 *
 * 1. the gate runs on the PERSON'S text, before the marker is appended, so the
 *    marker can trip neither the language filter nor the character limit;
 * 2. the marker goes last, after a blank line;
 * 3. the previous comment is looked up by id first and by marker second;
 * 4. a `'foreign'` answer publishes NOTHING — the board is holding an id that
 *    is not its own, and that has to be looked at, not written around;
 * 5. editing a comment that vanished in between throws instead of publishing a
 *    new one: better an error than two closing comments nobody meant to leave.
 *
 * `gh api` rather than `gh issue comment` (what `commentOnPr` uses) because it
 * answers with the created comment's JSON, so the `id` that step 3 needs next
 * time comes back structurally instead of being scraped off a
 * `#issuecomment-123` URL. Note `gh api` has no `--body-file`: the field is
 * read from a file with `-F body=@path`.
 *
 * @param {number|string} issue
 * @param {string} body the person's text, without the marker.
 * @param {{commentId?: number|string|null, project?: string}} [opts]
 * @returns {Promise<{id:number, url:string, how:'created'|'edited'}>}
 */
export async function publishIssueComment(issue, body, { commentId = null, project } = {}) {
  requireProject(project, 'publishIssueComment');
  assertPublishable(body, `el comentario de cierre del issue #${issue}`, { maxChars: CLOSE_COMMENT_MAX });
  const marker = closingCommentMarker(issue);
  const full = `${String(body).replace(/\s+$/, '')}\n\n${marker}\n`;

  const login = await currentLogin(project);
  const comments = await issueComments(issue, project);
  const prior = findPriorClosingComment(comments, { commentId, marker, login });
  if (prior.how === 'foreign') {
    const foreign = comments.find((c) => String(c.id) === String(commentId));
    throw Object.assign(
      new Error(
        `comment ${commentId} saved for issue #${issue} is not from ${login}: `
        + 'nothing is edited or published until someone looks at it',
      ),
      { code: 'FOREIGN_COMMENT', commentUrl: foreign?.url ?? null, commentId, issue },
    );
  }

  const target = prior.comment;
  const dir = mkdtempSync(path.join(tmpdir(), 'hfsmon-'));
  const file = path.join(dir, 'issue-comment.md');
  writeFileSync(file, full, 'utf8');
  try {
    const r = target
      ? await run('gh', [
        'api', '-X', 'PATCH',
        `repos/${repo(project)}/issues/comments/${target.id}`,
        '-F', `body=@${file}`,
      ])
      : await run('gh', [
        'api', '-X', 'POST',
        `repos/${repo(project)}/issues/${Number(issue)}/comments`,
        '-F', `body=@${file}`,
      ]);
    if (!r.ok) {
      if (target && /HTTP 404/.test(r.stderr)) {
        throw Object.assign(
          new Error(
            `comment ${target.id} of issue #${issue} no longer exists: not posting another `
            + 'in its place, to avoid two closing comments',
          ),
          { code: 'COMMENT_GONE', commentId: target.id, issue },
        );
      }
      throw new Error(`gh api ${target ? 'PATCH' : 'POST'} of the comment on #${issue} failed: ${r.stderr}`);
    }
    let published;
    try {
      published = JSON.parse(r.stdout);
    } catch (e) {
      throw new Error(`could not read the comment published on #${issue}: ${e.message}`);
    }
    return { id: published.id, url: published.html_url, how: target ? 'edited' : 'created' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * WRITE (7/8). Adds labels to an issue, and only labels the repository already
 * has.
 *
 * The whole list is validated against {@link repoLabels} BEFORE any `gh` runs,
 * so an unknown label costs nothing instead of half-labelling the issue. The
 * comparison is case-insensitive because GitHub's labels are, and what goes on
 * the wire is the repository's own spelling.
 *
 * `gh` would catch an unknown label too — it resolves every `--add-label`
 * through GraphQL and fails with `'x' not found` — so this is not a hole being
 * plugged. What the check buys is where and how it fails: before any label is
 * added rather than after some of them are, in the repository's own spelling
 * rather than the model's casing, and as an error carrying `LABELS_UNKNOWN`
 * and the list, which the confirmation window can show as "these labels do not
 * exist" instead of relaying a line of `gh` stderr.
 *
 * One `--add-label` per label, never a joined string: `gh` splits that flag on
 * commas, so a label containing one would silently become two.
 *
 * @param {number|string} issue
 * @param {string[]} labels
 * @param {string} projectId
 * @returns {Promise<string[]>} the labels added, in the repository's spelling.
 * @throws {Error & {code:'LABELS_UNKNOWN', unknown:string[]}}
 */
export async function addIssueLabels(issue, labels, projectId) {
  requireProject(projectId, 'addIssueLabels');
  const wanted = [...new Set((labels ?? []).map((l) => String(l).trim()).filter(Boolean))];
  if (!wanted.length) return [];

  const known = await repoLabels(projectId);
  const bySpelling = new Map(known.map((l) => [l.name.toLowerCase(), l.name]));
  const unknown = wanted.filter((l) => !bySpelling.has(l.toLowerCase()));
  if (unknown.length) {
    throw Object.assign(
      new Error(
        `repository ${repo(projectId)} lacks these labels: ${unknown.join(', ')} `
        + '(the board does not create labels)',
      ),
      { code: 'LABELS_UNKNOWN', unknown },
    );
  }

  const names = wanted.map((l) => bySpelling.get(l.toLowerCase()));
  const args = ['issue', 'edit', String(issue), '-R', repo(projectId)];
  for (const name of names) args.push('--add-label', name);
  const r = await run('gh', args);
  if (!r.ok) throw new Error(`gh issue edit --add-label failed: ${r.stderr}`);
  return names;
}

/**
 * WRITE (8/8). Closes an issue, with a reason.
 *
 * Whatever the exit code says, the issue is read back and the call only fails
 * if it is STILL open. That makes a retry harmless and makes "somebody already
 * closed it" a success: the state the board wanted is the state GitHub is in,
 * and who got there first does not change that.
 *
 * `alreadyClosed` is read BEFORE the close, never derived from the exit code.
 * `gh issue close` against an issue that is already closed warns and exits 0,
 * so `!r.ok` answered `false` in precisely the case the field exists to name —
 * and it would answer `true` for any other failure, network included. The
 * state before the call is the only thing that actually says it.
 *
 * @param {number|string} issue
 * @param {{reason: 'completed'|'not_planned'|'duplicate',
 *   duplicateOf?: number|string|null, targetIsPr?: boolean, project?: string}} opts
 * @returns {Promise<{state:string, alreadyClosed:boolean}>} `alreadyClosed` is
 *   true when the issue was already closed before the board asked — somebody
 *   else got there first, or this is a retry of a close that did land.
 */
export async function closeIssue(issue, { reason, duplicateOf = null, targetIsPr = false, project } = {}) {
  requireProject(project, 'closeIssue');
  const args = closeIssueArgs({ issue, reason, duplicateOf, repo: repo(project), targetIsPr });
  const before = await getIssue(issue, project);
  const alreadyClosed = String(before.state ?? '').toUpperCase() === 'CLOSED';
  const r = await run('gh', args);
  // Read back before judging: `gh issue close` against an issue somebody else
  // has just closed is a failure that changed nothing, and the board wants the
  // state, not the exit code.
  const after = await getIssue(issue, project);
  const state = String(after.state ?? '').toUpperCase();
  if (state === 'OPEN') {
    const detail = r.stderr.trim().split('\n').pop() || `gh salió con ${r.code}`;
    throw new Error(`could not close issue #${issue}: ${detail}`);
  }
  return { state, alreadyClosed };
}
