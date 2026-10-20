import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseGitHubRemote, detectRepo } from '../src/repo-identity.js';
import { config } from '../src/config.js';

/** A throwaway local git repo, with an `origin` remote if `originUrl` is given. */
function initRepo(originUrl) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hfsmon-repoid-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  if (originUrl) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', originUrl]);
  return dir;
}

// --- parseGitHubRemote: pure string parsing, no git involved ---------------

test('parseGitHubRemote reads HTTPS and SSH origins, with and without a trailing .git', () => {
  assert.equal(parseGitHubRemote('https://github.com/HeliosSoftware/hfs.git'), 'HeliosSoftware/hfs');
  assert.equal(parseGitHubRemote('https://github.com/HeliosSoftware/hfs'), 'HeliosSoftware/hfs');
  assert.equal(parseGitHubRemote('git@github.com:HeliosSoftware/hfs.git'), 'HeliosSoftware/hfs');
  assert.equal(parseGitHubRemote('git@github.com:HeliosSoftware/hfs'), 'HeliosSoftware/hfs');
  assert.equal(parseGitHubRemote('git@github-work:HeliosSoftware/hfs.git'), 'HeliosSoftware/hfs');
});

test('parseGitHubRemote returns null for anything it cannot read, never throws', () => {
  for (const bad of [
    null, undefined, '', 'not a url',
    'https://gitlab.com/Foo/Bar.git',        // right shape, wrong host
    'ssh://git@github.com/Foo/Bar.git',      // the ssh:// form — only the scp-style git@ form is in scope
    'git@gitlab-work:Foo/Bar.git',           // an alias, but not a github-<account> one
  ]) {
    assert.equal(parseGitHubRemote(bad), null, String(bad));
  }
});

// --- detectRepo: against a real git checkout --------------------------------

test('detectRepo reads owner/repo from a real HTTPS origin remote', (t) => {
  const dir = initRepo('https://github.com/HeliosSoftware/hfs.git');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(detectRepo(dir), 'HeliosSoftware/hfs');
});

test('detectRepo reads owner/repo from a real SSH origin remote', (t) => {
  const dir = initRepo('git@github.com:HeliosSoftware/hfs.git');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(detectRepo(dir), 'HeliosSoftware/hfs');
});

test('detectRepo never throws: no origin, an unparseable origin, a bad path or an empty path all come back null', (t) => {
  const noOrigin = initRepo(null);
  const badOrigin = initRepo('https://example.com/not-github');
  t.after(() => {
    rmSync(noOrigin, { recursive: true, force: true });
    rmSync(badOrigin, { recursive: true, force: true });
  });
  assert.equal(detectRepo(noOrigin), null, 'git remote get-url origin fails: no remote at all');
  assert.equal(detectRepo(badOrigin), null, 'origin exists but is not a GitHub URL');
  assert.equal(detectRepo(path.join(tmpdir(), 'hfsmon-repoid-does-not-exist')), null, 'not even a git repo');
  assert.equal(detectRepo(null), null);
  assert.equal(detectRepo(undefined), null);
  assert.equal(detectRepo(''), null);
});

// --- github.js's repo(): precedence and the throw-not-null contract --------
//
// Each scenario imports github.js under a distinct query string so it gets
// its own module instance — repo() caches for the life of a module instance,
// same as it would for the life of the real process, so scenarios can't share
// one. config.js itself is not re-imported (no query string on it): it stays
// the one live `config` object, which is what these tests mutate and restore.

test('github.js repo(): config.github.repo always wins over detection', async (t) => {
  const savedRepo = config.github.repo;
  const savedPath = config.project.repoPath;
  const detected = initRepo('https://github.com/Other/Detected.git');
  t.after(() => {
    config.github.repo = savedRepo;
    config.project.repoPath = savedPath;
    rmSync(detected, { recursive: true, force: true });
  });
  config.github.repo = 'Explicit/Wins';
  config.project.repoPath = detected;

  const mod = await import('../src/github.js?repo-identity-config-wins');
  assert.equal(mod.repo('hfs'), 'Explicit/Wins');
});

test('github.js repo(): config wins even when detection would fail — it never runs', async (t) => {
  const savedRepo = config.github.repo;
  const savedPath = config.project.repoPath;
  t.after(() => {
    config.github.repo = savedRepo;
    config.project.repoPath = savedPath;
  });
  config.github.repo = 'Explicit/StillWins';
  config.project.repoPath = path.join(tmpdir(), 'hfsmon-repoid-does-not-exist-2');

  const mod = await import('../src/github.js?repo-identity-config-wins-no-detect-needed');
  assert.equal(mod.repo('hfs'), 'Explicit/StillWins');
});

test('github.js repo(): falls back to detection only when config.github.repo is unset', async (t) => {
  const savedRepo = config.github.repo;
  const savedPath = config.project.repoPath;
  const detected = initRepo('https://github.com/Detected/Only.git');
  t.after(() => {
    config.github.repo = savedRepo;
    config.project.repoPath = savedPath;
    rmSync(detected, { recursive: true, force: true });
  });
  config.github.repo = undefined;
  config.project.repoPath = detected;

  const mod = await import('../src/github.js?repo-identity-fallback');
  assert.equal(mod.repo('hfs'), 'Detected/Only');
});

test('github.js repo(): throws — never returns null/undefined — when neither source has an answer, and caches the failure', async (t) => {
  const savedRepo = config.github.repo;
  const savedPath = config.project.repoPath;
  const noOrigin = initRepo(null);
  t.after(() => {
    config.github.repo = savedRepo;
    config.project.repoPath = savedPath;
    rmSync(noOrigin, { recursive: true, force: true });
  });
  config.github.repo = undefined;
  config.project.repoPath = noOrigin;

  const mod = await import('../src/github.js?repo-identity-throws');
  assert.throws(() => mod.repo('hfs'), /could not determine the GitHub repository/);

  // The failure is cached (the same Error comes back), not retried per call —
  // see the comment above repoCache in github.js for why that matters: a
  // broken origin should not shell out to git on every `gh` call.
  let first;
  let second;
  try { mod.repo('hfs'); } catch (e) { first = e; }
  try { mod.repo('hfs'); } catch (e) { second = e; }
  assert.equal(first, second, 'el fallo se cachea: la misma excepción vuelve, no un reintento');
});
