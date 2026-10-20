import { exec, execFileSync } from 'node:child_process';

// https://github.com/OWNER/REPO(.git)? and git@github.com:OWNER/REPO(.git)? —
// the two forms `git remote get-url origin` can hand back for a GitHub
// remote. The SSH form also takes a `github-<account>` host alias, the usual
// ~/.ssh/config trick for several GitHub accounts on one machine. Anything
// else (a different host, another alias, a malformed URL) falls through to null.
const HTTPS_ORIGIN = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const SSH_ORIGIN = /^git@github(?:\.com|-[\w.-]+):([^/]+)\/([^/]+?)(?:\.git)?$/;

/**
 * Parses `owner/repo` out of a GitHub remote URL. Returns null for anything
 * that does not match — a fork hosted elsewhere, a non-GitHub remote, an
 * empty string. Split out from detectRepo() so the parsing itself can be
 * tested without shelling out to git.
 */
export function parseGitHubRemote(url) {
  if (!url) return null;
  const trimmed = url.trim();
  const m = HTTPS_ORIGIN.exec(trimmed) ?? SSH_ORIGIN.exec(trimmed);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Detects the GitHub `owner/repo` of the hfs checkout at `repoPath`, from its
 * `origin` remote — the only remote verified to exist on Edson's machine
 * today; this does not try any other name. Never throws: a missing
 * `repoPath`, no `origin` remote, or a URL `parseGitHubRemote` cannot read
 * all resolve to null, and it is up to the caller (github.js's `repo()`) to
 * decide what a null means.
 */
export function detectRepo(repoPath) {
  return parseGitHubRemote(originUrl(repoPath));
}

/** The `origin` URL of a checkout, or null when there is none. Never throws. */
function originUrl(repoPath) {
  if (!repoPath) return null;
  try {
    return identityHooks.git(['-C', repoPath, 'remote', 'get-url', 'origin']).trim() || null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------
 * The GitHub account of a checkout
 * ---------------------------------------------------------------------- */

// GitHub's answer to `ssh -T`, the same for every key it knows:
// "Hi <login>! You've successfully authenticated, but GitHub does not provide shell access."
const SSH_GREETING = /^Hi ([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))! You've successfully authenticated/m;
// `user@host:path` (scp-like) and `ssh://user@host[:port]/path`. Host and user
// are restricted to characters that cannot break out of a command line, since
// the ssh command is run through a shell (see `sshLogin`).
const SCP_REMOTE = /^([\w.-]+)@([\w.-]+):(?!\/\/)/;
const SSH_URL = /^ssh:\/\/([\w.-]+)@([\w.-]+)(?::(\d+))?\//;
const HTTPS_USER = /^https:\/\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?::[^@/]*)?@github\.com\//;

/** The login in GitHub's `ssh -T` greeting, or null. Pure. */
export function parseSshGreeting(text) {
  const m = SSH_GREETING.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/**
 * Where an SSH remote connects: `{ user, host, port }`, `port` null when the
 * URL names none. Null for anything that is not an SSH remote. Pure.
 */
export function sshTargetOf(url) {
  const trimmed = String(url ?? '').trim();
  const scp = SCP_REMOTE.exec(trimmed);
  if (scp) return { user: scp[1], host: scp[2], port: null };
  const ssh = SSH_URL.exec(trimmed);
  return ssh ? { user: ssh[1], host: ssh[2], port: ssh[3] ?? null } : null;
}

/** The login written into an HTTPS GitHub remote (`https://<login>@github.com/...`), or null. Pure. */
export function httpsLoginOf(url) {
  const m = HTTPS_USER.exec(String(url ?? '').trim());
  return m ? m[1] : null;
}

/**
 * The ssh git itself would use for this checkout: `GIT_SSH_COMMAND`, then
 * `core.sshCommand`, then `GIT_SSH`, then plain `ssh`. Asking any other ssh
 * answers for other keys: on Windows, Git Bash's ssh does not see the agent
 * the Windows OpenSSH one does, and says "Permission denied" for a remote git
 * pushes to every day.
 */
function sshCommandFor(repoPath) {
  if (process.env.GIT_SSH_COMMAND) return process.env.GIT_SSH_COMMAND;
  try {
    const configured = identityHooks.git(['-C', repoPath, 'config', 'core.sshCommand']).trim();
    if (configured) return configured;
  } catch { /* not set */ }
  return process.env.GIT_SSH ? `"${process.env.GIT_SSH}"` : 'ssh';
}

/**
 * The GitHub login the key of an SSH remote authenticates as, asked with
 * `ssh -T` exactly as git would connect. Null when the host is not GitHub, the
 * key is refused or ssh does not answer in time.
 *
 * Cached per command and target for {@link SSH_LOGIN_TTL_MS}: the check runs
 * before every push, and a key does not change account between two pushes.
 * ponytail: a TTL, not invalidation; a key swapped mid-window is seen late.
 */
const sshLoginCache = new Map();
const SSH_LOGIN_TTL_MS = 10 * 60 * 1000;

async function sshLogin(repoPath, { user, host, port }) {
  const command = sshCommandFor(repoPath);
  const key = `${command}|${user}@${host}:${port ?? ''}`;
  const hit = sshLoginCache.get(key);
  if (hit && Date.now() - hit.at < SSH_LOGIN_TTL_MS) return hit.login;
  const portArg = port ? ` -p ${port}` : '';
  const out = await identityHooks.ssh(`${command} -T -o BatchMode=yes -o ConnectTimeout=10${portArg} ${user}@${host}`);
  const login = parseSshGreeting(out);
  sshLoginCache.set(key, { login, at: Date.now() });
  return login;
}

/** Exported for tests only: forgets every cached `ssh -T` answer. */
export function forgetSshLogins() { sshLoginCache.clear(); }

/**
 * The GitHub account a checkout works as, read from its `origin`: the login
 * an HTTPS URL carries, else the account `ssh -T` reports for an SSH remote.
 * Null when neither answers. Never rejects.
 */
export async function detectGhUser(repoPath) {
  const url = originUrl(repoPath);
  if (!url) return null;
  const fromHttps = httpsLoginOf(url);
  if (fromHttps) return fromHttps;
  const target = sshTargetOf(url);
  if (!target) return null;
  try {
    return await sshLogin(repoPath, target);
  } catch {
    return null;
  }
}

/**
 * The account a push of this checkout goes out as, when that can be known:
 * the `ssh -T` login for an SSH remote, `undefined` for any other remote (an
 * HTTPS push authenticates through git's credential helper, which this does
 * not ask). Null means "SSH, but no GitHub account answered".
 */
export async function pushLoginOf(repoPath) {
  const url = originUrl(repoPath);
  const target = url ? sshTargetOf(url) : null;
  if (!target) return undefined;
  try {
    return await sshLogin(repoPath, target);
  } catch {
    return null;
  }
}

/** The repository's own `user.email` (`--local`), or null when it only has the global one. */
export function localEmailOf(repoPath) {
  try {
    return identityHooks.git(['-C', repoPath, 'config', '--local', 'user.email']).trim() || null;
  } catch {
    return null;
  }
}

/**
 * The processes this module runs, swappable for tests only. `ssh` gets one
 * command line (run by a shell, as git runs `core.sshCommand`) and resolves to
 * everything ssh printed: GitHub greets on stderr and exits 1 even when the key
 * is accepted, so the exit code says nothing. Asynchronous because a remote
 * that does not answer takes the whole `ConnectTimeout`, and the board must
 * keep serving meanwhile.
 */
export const identityHooks = {
  git: (args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }),
  ssh: (command) => new Promise((resolve) => {
    exec(command, { encoding: 'utf8', windowsHide: true, timeout: 15_000 }, (_err, stdout, stderr) => {
      resolve(`${stdout ?? ''}\n${stderr ?? ''}`);
    });
  }),
};
