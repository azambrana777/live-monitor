import './isolate.mjs';   // primero: aísla el directorio de datos

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  parseSshGreeting, sshTargetOf, httpsLoginOf, detectGhUser, identityHooks, forgetSshLogins,
} from '../src/repo-identity.js';
import { saveProjects, setGhAccount, projectAt, projectOf } from '../src/projects.js';
import { ghEnvFor, ghEnvAt, ghAccountHooks, forgetGhTokens, identityProblems, identityIssues, assertPushIdentity, ghAccounts, defaultGhLogin, forgetGhEmails } from '../src/gh-account.js';
import { readyPr, currentLogin, _setGhRunner, forgetRepoCache } from '../src/github.js';
import { sessionOptions } from '../src/claude.js';
import { DATA_DIR } from '../src/config.js';

// Una cuenta por proyecto: «alpha» trabaja como `alice`, «beta» no declara
// ninguna y sigue con la cuenta activa de `gh`, como siempre.
const ROOT = path.resolve('/work');
const ALPHA = path.join(ROOT, 'alpha');
const BETA = path.join(ROOT, 'beta');
const entry = (id, repoPath, over = {}) => ({
  id, name: id, repoPath, worktreeRoot: `${repoPath}-wt`, repo: `acme/${id}`, assignee: 'someone', overrides: {}, ...over,
});

const realHooks = { ...identityHooks };
const realToken = ghAccountHooks.token;
const realEmails = ghAccountHooks.emails;
let git;      // args -> stdout, o un Error que lanzar
let sshSeen;  // las líneas de comando que se le pidieron a ssh
let sshSays;  // lo que ssh imprime

beforeEach(() => {
  saveProjects([entry('alpha', ALPHA, { ghUser: 'alice' }), entry('beta', BETA)]);
  forgetGhTokens();
  forgetGhEmails();
  ghAccountHooks.emails = async () => ({ ok: false, stdout: '' });
  forgetSshLogins();
  forgetRepoCache();
  git = () => { throw new Error('not set'); };
  sshSeen = [];
  sshSays = "Hi alice! You've successfully authenticated, but GitHub does not provide shell access.";
  identityHooks.git = (args) => {
    const out = git(args);
    if (out instanceof Error) throw out;
    return out;
  };
  identityHooks.ssh = async (command) => { sshSeen.push(command); return `\n${sshSays}\n`; };
  ghAccountHooks.token = (login) => (login === 'alice' ? 'gho_alice' : '');
});

after(() => {
  Object.assign(identityHooks, realHooks);
  ghAccountHooks.token = realToken;
  ghAccountHooks.emails = realEmails;
  _setGhRunner();
});

// --- detección: funciones puras ------------------------------------------

test('el saludo de `ssh -T` de GitHub dice la cuenta; cualquier otra respuesta no', () => {
  assert.equal(parseSshGreeting("Hi azambrana777! You've successfully authenticated, but GitHub does not provide shell access."), 'azambrana777');
  assert.equal(parseSshGreeting('git@github.com: Permission denied (publickey).'), null);
  assert.equal(parseSshGreeting('Welcome to GitLab, @alice!'), null);
  assert.equal(parseSshGreeting(undefined), null);
});

test('el destino ssh sale de la forma scp y de ssh://, con alias y puerto', () => {
  assert.deepEqual(sshTargetOf('git@github-alice:acme/alpha.git'), { user: 'git', host: 'github-alice', port: null });
  assert.deepEqual(sshTargetOf('ssh://git@github.com:2222/acme/alpha.git'), { user: 'git', host: 'github.com', port: '2222' });
  assert.equal(sshTargetOf('https://github.com/acme/alpha.git'), null);
  assert.equal(sshTargetOf('git@evil;rm -rf ~:x/y'), null, 'un host con caracteres de shell no es un destino');
});

test('un remoto HTTPS con usuario dice la cuenta; sin usuario, no', () => {
  assert.equal(httpsLoginOf('https://alice@github.com/acme/alpha.git'), 'alice');
  assert.equal(httpsLoginOf('https://alice:secret@github.com/acme/alpha.git'), 'alice');
  assert.equal(httpsLoginOf('https://github.com/acme/alpha.git'), null);
});

// --- detección: contra el checkout ----------------------------------------

test('detectGhUser pregunta con el ssh que usa git (core.sshCommand) y al alias del remoto', async () => {
  git = (args) => {
    if (args.includes('get-url')) return 'git@github-alice:acme/alpha.git\n';
    if (args.includes('core.sshCommand')) return 'C:/Windows/System32/OpenSSH/ssh.exe\n';
    return new Error('unexpected');
  };
  assert.equal(await detectGhUser(ALPHA), 'alice');
  assert.equal(sshSeen.length, 1);
  assert.match(sshSeen[0], /^C:\/Windows\/System32\/OpenSSH\/ssh\.exe -T -o BatchMode=yes .* git@github-alice$/);
});

test('detectGhUser: el usuario de un remoto HTTPS gana sin preguntar a ssh; sin respuesta, null', async () => {
  git = (args) => (args.includes('get-url') ? 'https://bob@github.com/acme/alpha.git' : new Error('unset'));
  assert.equal(await detectGhUser(ALPHA), 'bob');
  assert.equal(sshSeen.length, 0);

  forgetSshLogins();
  git = (args) => (args.includes('get-url') ? 'git@github.com:acme/alpha.git' : new Error('unset'));
  sshSays = 'git@github.com: Permission denied (publickey).';
  assert.equal(await detectGhUser(ALPHA), null);

  git = () => new Error('no origin');
  assert.equal(await detectGhUser(ALPHA), null);
});

// --- registro ---------------------------------------------------------------

test('ghUser se guarda como login, se valida, y projects.json nunca lleva un token', () => {
  const saved = setGhAccount('beta', { ghUser: 'carol', assignee: 'carol' });
  assert.equal(saved.ghUser, 'carol');
  assert.equal(saved.assignee, 'carol');
  assert.throws(() => setGhAccount('beta', { ghUser: 'not a login' }), /ghUser: invalid GitHub login/);
  ghEnvFor('alpha');
  const file = readFileSync(path.join(DATA_DIR, 'projects.json'), 'utf8');
  assert.doesNotMatch(file, /gho_|GH_TOKEN|token/i);
  assert.equal(setGhAccount('beta', { ghUser: null }).ghUser, undefined, 'null vuelve a la cuenta activa');
  assert.equal(projectOf('beta').assignee, 'carol', 'quitar la cuenta no toca el asignado');
});

test('projectAt encuentra el proyecto por su checkout o por su raíz de worktrees, el más profundo gana', () => {
  assert.equal(projectAt(path.join(ALPHA, 'src'))?.id, 'alpha');
  assert.equal(projectAt(path.join(`${ALPHA}-wt`, 'feat-1'))?.id, 'alpha');
  assert.equal(projectAt(path.join(ROOT, 'alphabet')), undefined, 'un prefijo de nombre no es un directorio contenedor');
  saveProjects([entry('alpha', ALPHA), entry('inner', path.join(ALPHA, 'vendor', 'inner'))]);
  assert.equal(projectAt(path.join(ALPHA, 'vendor', 'inner', 'x'))?.id, 'inner');
  if (process.platform === 'win32') assert.equal(projectAt(ALPHA.toUpperCase())?.id, 'alpha');
});

// --- el token, por proyecto -------------------------------------------------

test('cada proyecto lleva el token de su cuenta; uno sin cuenta no lleva nada', () => {
  assert.deepEqual(ghEnvFor('alpha'), { GH_TOKEN: 'gho_alice' });
  assert.equal(ghEnvFor('beta'), null);
  assert.deepEqual(ghEnvAt(path.join(`${ALPHA}-wt`, 'feat-1')), { GH_TOKEN: 'gho_alice' });
  assert.equal(ghEnvAt(path.join(ROOT, 'elsewhere')), null);
});

test('una cuenta sin sesión en gh es un error que dice cómo arreglarlo, nunca la cuenta activa', () => {
  setGhAccount('beta', { ghUser: 'mallory' });
  assert.throws(() => ghEnvFor('beta'), /gh has no session for the GitHub account "mallory": run `gh auth login`/);
});

test('github.js pasa GH_TOKEN al gh del proyecto con cuenta y deja intactas las opciones del que no la tiene', async () => {
  const calls = [];
  _setGhRunner(async (file, args, opts) => { calls.push({ args, opts }); return { ok: true, stdout: '', stderr: '' }; });
  await readyPr(7, 'alpha');
  await readyPr(8, 'beta');
  assert.equal(calls[0].opts?.env?.GH_TOKEN, 'gho_alice');
  assert.deepEqual(calls[0].args.slice(0, 3), ['pr', 'ready', '7']);
  assert.equal(calls[1].opts, undefined, 'sin cuenta, la llamada sale exactamente como estaba escrita');
});

test('currentLogin responde por la cuenta de cada proyecto, no por la del primero que preguntó', async () => {
  setGhAccount('beta', { ghUser: 'bob' });
  ghAccountHooks.token = (login) => `gho_${login}`;
  let calls = 0;
  _setGhRunner(async (_file, _args, opts) => {
    calls += 1;
    return { ok: true, stdout: `${opts?.env?.GH_TOKEN?.slice(4) ?? 'active'}\n`, stderr: '' };
  });
  assert.equal(await currentLogin('alpha'), 'alice');
  assert.equal(await currentLogin('beta'), 'bob');
  assert.equal(await currentLogin('alpha'), 'alice', 'de la caché, y la suya');
  assert.equal(calls, 2, 'una llamada por cuenta');
});

test('una sesión de agente en un worktree del proyecto recibe su GH_TOKEN; en un runner, no', () => {
  const wt = path.join(`${ALPHA}-wt`, 'feat-1');
  assert.equal(sessionOptions({ cwd: wt, model: 'm', machine: { kind: 'local', name: 'local' } }).env.GH_TOKEN, 'gho_alice');
  const remote = sessionOptions({ cwd: wt, model: 'm', machine: { kind: 'runner', name: 'box' } }).env.GH_TOKEN;
  assert.equal(remote, process.env.GH_TOKEN, 'un runner no recibe los tokens de esta máquina');
});

test('ghAccounts lista las cuentas con sesión en gh, la activa marcada, y nada si gh no sabe decirlo', async () => {
  const realStatus = ghAccountHooks.status;
  try {
    ghAccountHooks.status = async () => ({ ok: true, stdout: JSON.stringify({ hosts: { 'github.com': [
      { state: 'success', active: true, login: 'alice' },
      { state: 'success', active: false, login: 'bob' },
      { state: 'error', active: false, login: 'expired' },
    ], 'ghe.example.com': [{ state: 'success', active: true, login: 'elsewhere' }] } }) });
    // alice: su token puede leer sus correos y gana el principal. bob: sin el
    // scope (404), sale el user.email local de un proyecto que trabaja como bob.
    ghAccountHooks.emails = async (login) => ({
      ok: login === 'alice',
      stdout: login === 'alice'
        ? JSON.stringify([{ email: 'old@a.example', primary: false, verified: true }, { email: 'alice@a.example', primary: true, verified: true }])
        : JSON.stringify({ message: 'Not Found', status: '404' }),
    });
    setGhAccount('beta', { ghUser: 'bob' });
    git = (args) => (args.includes('--local') && args.includes(BETA) ? 'bob@b.example\n' : new Error('unset'));
    assert.deepEqual(await ghAccounts(), [
      { login: 'alice', active: true, email: 'alice@a.example' },
      { login: 'bob', active: false, email: 'bob@b.example' },
    ]);
    setGhAccount('beta', { ghUser: null });
    assert.equal((await ghAccounts())[1].email, null, 'sin scope y sin proyecto que la use, no hay correo');

    // Un proyecto mal configurado no responde por la cuenta: alpha dice ser
    // bob, pero su remoto empuja como alice, y su correo es el de alice.
    setGhAccount('alpha', { ghUser: 'bob' });
    forgetGhEmails();
    git = (args) => {
      if (args.includes('get-url')) return 'git@github-alice:acme/alpha.git';
      if (args.includes('--local')) return 'alice@a.example';
      return new Error('unset');
    };
    assert.equal((await ghAccounts())[1].email, null, 'el correo de un repo que empuja como otra cuenta no cuenta');
    ghAccountHooks.status = async () => ({ ok: false, stdout: '', stderr: 'unknown flag: --json' });
    assert.deepEqual(await ghAccounts(), []);
  } finally {
    ghAccountHooks.status = realStatus;
  }
});

test('la cuenta por defecto es la activa del keyring, o la del GH_TOKEN con que arrancó el tablero', async () => {
  const accounts = [{ login: 'alice', active: false }, { login: 'bob', active: true }];
  const realWhoami = ghAccountHooks.whoami;
  const had = process.env.GH_TOKEN;
  try {
    delete process.env.GH_TOKEN;
    assert.equal(await defaultGhLogin(accounts), 'bob');
    process.env.GH_TOKEN = 'gho_x';
    ghAccountHooks.whoami = async () => ({ ok: true, stdout: 'alice\n' });
    assert.equal(await defaultGhLogin(accounts), 'alice', 'el token gana al keyring, como en gh');
    ghAccountHooks.whoami = async () => ({ ok: false, stdout: '' });
    assert.equal(await defaultGhLogin(accounts), null);
  } finally {
    ghAccountHooks.whoami = realWhoami;
    if (had === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = had;
  }
});

// --- la verificación antes del push ----------------------------------------

test('sin user.email local o con un remoto que empuja como otra cuenta, el push se niega', async () => {
  git = (args) => {
    if (args.includes('get-url')) return 'git@github-other:acme/alpha.git';
    if (args.includes('--local')) return '';
    return new Error('unset');
  };
  sshSays = "Hi mallory! You've successfully authenticated, but GitHub does not provide shell access.";
  const problems = await identityProblems(ALPHA);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /no local user\.email/);
  assert.match(problems[1], /pushes as mallory, not as alice/);
  await assert.rejects(assertPushIdentity(path.join(`${ALPHA}-wt`, 'feat-1')), (e) => e.code === 'identity_mismatch');

  // Lo mismo como datos, para que la UI lo diga en el idioma de quien lee.
  const issues = await identityIssues(ALPHA);
  assert.deepEqual(issues.map(({ message: _m, ...rest }) => rest), [
    { code: 'no_local_email', login: 'alice', repoPath: ALPHA },
    { code: 'push_mismatch', login: 'alice', pusher: 'mallory' },
  ]);
  assert.deepEqual(issues.map((i) => i.message), problems, 'el mensaje en inglés sigue siendo el de identityProblems');
});

test('con el correo local y el remoto de la cuenta, el push pasa; un proyecto sin cuenta no se comprueba', async () => {
  git = (args) => {
    if (args.includes('get-url')) return 'git@github-alice:acme/alpha.git';
    if (args.includes('--local')) return 'alice@example.com';
    return new Error('unset');
  };
  assert.deepEqual(await identityProblems(ALPHA), []);
  await assertPushIdentity(ALPHA);
  git = () => new Error('nada que leer');
  assert.deepEqual(await identityProblems(BETA), [], 'beta no declara cuenta: nada cambia para él');
  assert.equal(sshSeen.length, 1, 'el ssh de alpha, una sola vez: beta no pregunta');
});

test('un remoto SSH que no responde con ninguna cuenta también niega el push', async () => {
  git = (args) => {
    if (args.includes('get-url')) return 'git@github-alice:acme/alpha.git';
    if (args.includes('--local')) return 'alice@example.com';
    return new Error('unset');
  };
  sshSays = 'ssh: connect to host github.com port 22: Connection timed out';
  const problems = await identityProblems(ALPHA);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /did not answer with a GitHub account/);
});
