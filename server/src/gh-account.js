import { execFileSync } from 'node:child_process';
import { run } from './exec.js';
import { projectOf, projectAt } from './projects.js';
import { pushLoginOf, localEmailOf } from './repo-identity.js';

/**
 * The GitHub account a project works as, turned into what a process needs.
 *
 * A project that declares `ghUser` gets that account's token in `GH_TOKEN`
 * for every `gh` the board runs for it (`github.js`, `issuedraft.js`) and in
 * the environment of its agent sessions (`claude.js#sessionOptions`), so `gh`
 * answers as that account whatever `gh auth switch` last chose. A project
 * without `ghUser` gets nothing added and works exactly as before: the active
 * `gh` account, or whatever `GH_TOKEN` the board itself was started with.
 *
 * The token comes from `gh auth token -u <login>`, i.e. from gh's own keyring,
 * at use. It is never written anywhere: the registry stores the login only.
 *
 * @module gh-account
 */

/**
 * Tokens per login, for {@link TOKEN_TTL_MS}: `gh auth token` is a process,
 * and a poll runs several `gh` per project.
 * ponytail: a TTL, not invalidation on 401; a token revoked mid-window fails
 * for at most that long before it is asked for again.
 */
const tokens = new Map();
const TOKEN_TTL_MS = 15 * 60 * 1000;

/** The processes this module runs, swappable for tests only. */
export const ghAccountHooks = {
  token: (login) => execFileSync('gh', ['auth', 'token', '-u', login], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim(),
  // Without GH_TOKEN/GITHUB_TOKEN: with either set, `gh auth status` reports
  // that one token instead of the accounts in the keyring.
  status: () => run('gh', ['auth', 'status', '--json', 'hosts'], {
    timeoutMs: 15_000, env: { GH_TOKEN: undefined, GITHUB_TOKEN: undefined },
  }),
  // As the board's own process sees it, token included.
  whoami: () => run('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 15_000 }),
};

/**
 * The account a project without `ghUser` works as: the login of the token the
 * board was started with (`GH_TOKEN`/`GITHUB_TOKEN`, which wins over the
 * keyring), else the active keyring account. Null when it cannot be told.
 *
 * @param {{login: string, active: boolean}[]} accounts what {@link ghAccounts} answered.
 * @returns {Promise<string|null>}
 */
export async function defaultGhLogin(accounts) {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    return accounts.find((a) => a.active)?.login ?? null;
  }
  try {
    const r = await ghAccountHooks.whoami();
    return (r.ok && r.stdout.trim()) || null;
  } catch {
    return null;
  }
}

/**
 * The GitHub accounts `gh` has a working session for, the active one marked:
 * what a person can pick as a project's account. Empty when `gh` cannot say
 * (not installed, too old for `--json`, no session at all).
 *
 * @returns {Promise<{login: string, active: boolean}[]>}
 */
export async function ghAccounts() {
  try {
    const r = await ghAccountHooks.status();
    const hosts = JSON.parse(r.stdout)?.hosts?.['github.com'];
    return (Array.isArray(hosts) ? hosts : [])
      .filter((h) => h?.state === 'success' && typeof h.login === 'string')
      .map((h) => ({ login: h.login, active: h.active === true }));
  } catch {
    return [];
  }
}

/** Exported for tests only: forgets every cached token. */
export function forgetGhTokens() { tokens.clear(); }

/**
 * The token of one logged-in `gh` account.
 *
 * @param {string} login
 * @returns {string}
 * @throws {Error} when `gh` has no session for that login: publishing as the
 *   active account instead is exactly what a project with `ghUser` must not do.
 */
export function ghTokenFor(login) {
  const hit = tokens.get(login);
  if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.token;
  let token = '';
  try { token = ghAccountHooks.token(login); } catch { /* reported below */ }
  if (!token) {
    throw new Error(`gh has no session for the GitHub account "${login}": run \`gh auth login\` and sign in as ${login}`);
  }
  tokens.set(login, { token, at: Date.now() });
  return token;
}

const envOf = (project) => (project?.ghUser ? { GH_TOKEN: ghTokenFor(project.ghUser) } : null);

/**
 * What to add to the environment of a `gh` run for this project, or null when
 * it declares no account.
 *
 * @param {string} projectId
 * @returns {{GH_TOKEN: string}|null}
 */
export function ghEnvFor(projectId) {
  return envOf(projectOf(projectId));
}

/**
 * The same, for a process that only knows its working directory (an agent
 * session): the project whose checkout or worktree root contains `dir`.
 *
 * @param {string} dir
 * @returns {{GH_TOKEN: string}|null}
 */
export function ghEnvAt(dir) {
  return envOf(projectAt(dir));
}

/**
 * Why a push from `dir` must not go out for a project with `ghUser`, as a list
 * of sentences; empty when it may (or when the project declares no account, so
 * nothing changes for it).
 *
 * - The repository has no local `user.email`: the commits would carry the
 *   global identity, whichever account that belongs to.
 * - The `origin` remote is SSH and its key authenticates as another account,
 *   or as none at all: the push would go out as somebody else.
 *
 * An HTTPS remote is not checked for its account: that push authenticates
 * through git's credential helper, which this cannot ask.
 *
 * @param {string} dir a checkout or worktree of the project.
 * @param {import('./keys.js').Project} [project] defaults to the project at `dir`.
 * @returns {Promise<string[]>}
 */
export async function identityProblems(dir, project = projectAt(dir)) {
  return (await identityIssues(dir, project)).map((i) => i.message);
}

/**
 * {@link identityProblems} as data, for a client that words them itself (the
 * board's UI, in the reader's language): `{ code, login, ...details, message }`,
 * `message` being the English sentence. Codes: `no_local_email` (with
 * `repoPath`), `push_unverified`, `push_mismatch` (with `pusher`).
 *
 * @param {string} dir
 * @param {import('./keys.js').Project} [project]
 * @returns {Promise<{code: string, login: string, message: string}[]>}
 */
export async function identityIssues(dir, project = projectAt(dir)) {
  const login = project?.ghUser;
  if (!login) return [];
  const issues = [];
  if (!localEmailOf(dir)) {
    issues.push({
      code: 'no_local_email', login, repoPath: project.repoPath,
      message: `the repository has no local user.email, so commits would carry the global one: run \`git config user.email <email of ${login}>\` in ${project.repoPath}`,
    });
  }
  const pusher = await pushLoginOf(dir);
  if (pusher === null) {
    issues.push({
      code: 'push_unverified', login,
      message: `\`ssh -T\` to the origin remote did not answer with a GitHub account, so the push could not be checked to go out as ${login}`,
    });
  } else if (pusher !== undefined && pusher.toLowerCase() !== login.toLowerCase()) {
    issues.push({
      code: 'push_mismatch', login, pusher,
      message: `the origin remote pushes as ${pusher}, not as ${login}: point it at an SSH host alias whose key belongs to ${login}`,
    });
  }
  return issues;
}

/**
 * {@link identityProblems}, as a refusal.
 *
 * @param {string} dir
 * @throws {Error} with `code: 'identity_mismatch'` when there is any problem.
 */
export async function assertPushIdentity(dir) {
  const project = projectAt(dir);
  const problems = await identityProblems(dir, project);
  if (!problems.length) return;
  const e = new Error(`GitHub identity check failed for project "${project.id}": ${problems.join('; ')}`);
  e.code = 'identity_mismatch';
  throw e;
}
