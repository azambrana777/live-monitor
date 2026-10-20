import { execFileSync } from 'node:child_process';

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
  if (!repoPath) return null;
  let url;
  try {
    url = execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch {
    return null;
  }
  return parseGitHubRemote(url);
}
