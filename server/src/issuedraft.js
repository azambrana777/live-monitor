import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from './exec.js';
import { store } from './store.js';
import { runClaude } from './claude.js';
import { parseTaggedJson } from './tagged.js';
import { chatById } from './chats.js';
import { renderPrompt } from './prompts.js';
import { assertNoQuotaHold } from './quota.js';
import { assertNoUpgradeRunning } from './upgrade.js';
import { machineOf } from './machine.js';
import { configFor } from './projects.js';
import { repo, assigneeOf } from './github.js';
import { ghEnvFor } from './gh-account.js';
import { ghPublishProblems } from './ghgate.js';
import { holderKey } from './projectchats.js';
import { chatTranscriptOf, ghGateHooks, noGitHubWriteHooks, mergeHooks } from './pipeline.js';

/**
 * «📌 Crear tarea» from the project chat: turn what a conversation found into a
 * GitHub issue assigned to the person the board watches, so the poller picks it
 * up like any other.
 *
 * Two steps, both clicks: a one-off session drafts `{ title, body }` in English
 * from the transcript (it cannot call `gh`: no tools at all, plus the two gate
 * hooks), a person edits it, and **the server** runs `gh issue create`. The
 * prompt never creates anything: «a prompt asks, it does not guarantee», and
 * the language gate runs on the exact command before it goes out.
 *
 * `issueDraftHooks` are test seams only: `query(options)` replaces `runClaude`
 * (resolves `{ resultText }`) and `gh(file, args, opts)` replaces `run`.
 */
export const issueDraftHooks = { query: null, gh: null };

export const ISSUE_TITLE_MAX = 200;
const BODY_MAX = 60_000;

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

const drafting = new Set();
const creating = new Set();

/** Pulls `{title, body}` out of whatever the session said; null when there is none. */
export function parseDraft(text) {
  const raw = String(text ?? '').trim();
  const candidates = [];
  const tagged = parseTaggedJson(raw, 'ISSUE_DRAFT');
  if (tagged) candidates.push(tagged);
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(raw);
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const c of candidates) {
    let obj = c;
    if (typeof c === 'string') {
      try { obj = JSON.parse(c); } catch { continue; }
    }
    if (!obj || typeof obj !== 'object') continue;
    const title = typeof obj.title === 'string' ? obj.title.replace(/\s+/g, ' ').trim() : '';
    const body = typeof obj.body === 'string' ? obj.body.trim() : '';
    if (title && body) return { title: title.slice(0, ISSUE_TITLE_MAX), body };
  }
  return null;
}

export async function draftIssueFromChat(holder, chatId) {
  const chat = chatById(holder, chatId);
  if (!chat) throw httpError(404, `Chat ${chatId} does not exist`);
  if (chat.busy) throw httpError(409, `«${chat.title}» has a turn in progress: wait for it to finish`);
  if (!(chat.messages ?? []).length) throw httpError(409, `«${chat.title}» has no messages: there is nothing to draw a task from`);
  // A first turn whose worktree could not be prepared leaves no `cwd` to run in.
  if (!holder.worktreePath) throw httpError(409, 'The project chat has no worktree yet: send a message first');
  // Same two refusals as `draftIssueClosing`: a click must not queue a model run
  // behind an upgrade or a quota wait without saying so.
  try {
    assertNoUpgradeRunning();
    assertNoQuotaHold();
  } catch (e) {
    throw httpError(e?.status ?? 409, e?.message ?? String(e));
  }
  const key = holderKey(holder.project, holder.machine);
  const lock = `${key}/${chatId}`;
  if (drafting.has(lock)) throw httpError(409, 'The task is already being drafted');
  drafting.add(lock);
  try {
    const transcript = chatTranscriptOf(key, chatId);
    if (!String(transcript ?? '').trim()) throw httpError(409, `«${chat.title}» has no messages: there is nothing to draw a task from`);
    const options = {
      machine: machineOf(holder),
      cwd: holder.worktreePath,
      model: configFor(holder.project).claude.chatModel,
      maxTurns: 3,
      // No tools at all: it reads a transcript and writes JSON. The hooks stay
      // as the second belt, as in every phase that drafts for a person to publish.
      tools: [],
      hooks: mergeHooks(ghGateHooks(holder, 'draft'), noGitHubWriteHooks(holder, 'draft')),
      prompt: renderPrompt('issue-draft', { transcript }),
      onEvent: () => {},
    };
    let result;
    try {
      result = await (issueDraftHooks.query ?? runClaude)(options);
    } catch (e) {
      throw httpError(502, `Could not draft the task:${e?.message ?? e}`);
    }
    const draft = parseDraft(result?.resultText);
    if (!draft) throw httpError(502, 'The agent did not return a usable draft (title and body as JSON). Try again.');
    return draft;
  } finally {
    drafting.delete(lock);
  }
}

/** POSIX single-quoting, so the command line the gate reads is one it can parse. */
const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

export async function createIssueFromDraft(holder, chatId, { title, body } = {}) {
  const chat = chatById(holder, chatId);
  if (!chat) throw httpError(404, `Chat ${chatId} does not exist`);
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  const b = String(body ?? '').trim();
  if (!t) throw httpError(400, 'The title cannot be empty');
  if (!b) throw httpError(400, 'The body cannot be empty');
  if (t.length > ISSUE_TITLE_MAX) throw httpError(400, `The title is longer than ${ISSUE_TITLE_MAX} characters`);
  if (b.length > BODY_MAX) throw httpError(400, 'The body is too long');

  let repoName;
  let assignee;
  let account;
  try {
    repoName = repo(holder.project);
    assignee = assigneeOf(holder.project);
    account = ghEnvFor(holder.project);
  } catch (e) {
    throw httpError(400, e.message);
  }

  const lock = `${holderKey(holder.project, holder.machine)}/${chatId}`;
  if (creating.has(lock)) throw httpError(409, 'The task is already being created: wait for it to finish');
  creating.add(lock);
  let dir = null;
  let file = null;
  try {
    dir = mkdtempSync(path.join(tmpdir(), 'hfsmon-issue-'));
    file = path.join(dir, 'body.md').replace(/\\/g, '/');
    writeFileSync(file, b, 'utf8');
    const args = ['issue', 'create', '-R', repoName, '--assignee', assignee, '--title', t, '--body-file', file];
    const command = `gh issue create -R ${sq(repoName)} --assignee ${sq(assignee)} --title ${sq(t)} --body-file ${sq(file)}`;
    const problems = await ghPublishProblems(command, {
      readFile: async (p) => {
        if (String(p).replace(/\\/g, '/') !== file) return null;
        try { return readFileSync(file, 'utf8'); } catch { return null; }
      },
    });
    if (problems.length) {
      throw httpError(400, `The board does not publish this:${problems.join('; ')}`, { problems });
    }
    const r = await (issueDraftHooks.gh ?? run)('gh', args, account ? { timeoutMs: 60_000, env: account } : { timeoutMs: 60_000 });
    if (!r?.ok) {
      throw httpError(502, `gh could not create the issue: ${String(r?.stderr || r?.stdout || 'no output').trim().slice(0, 400)}`);
    }
    const url = String(r.stdout ?? '').match(/https?:\/\/\S+\/issues\/(\d+)/);
    if (!url) throw httpError(502, `gh created the issue but its number could not be read:${String(r.stdout ?? '').trim().slice(0, 200)}`);
    const number = Number(url[1]);
    const issueUrl = url[0];
    store.addChat(holder, chatId, 'assistant', `📌 Tarea creada: #${number} ${issueUrl}`);
    return { number, url: issueUrl };
  } finally {
    creating.delete(lock);
    try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch { /* a temp dir is not worth the click */ }
  }
}

export function registerIssueDraftRoutes(app, { withHolder }) {
  const base = '/api/projects/:project/project-chats/:machine/chats/:chatId';
  const fail = (res, e) => res.status(e?.status ?? 500).json({ error: e?.message ?? String(e), ...(e?.problems ? { problems: e.problems } : {}) });

  app.post(`${base}/draft-issue`, withHolder(async (holder, req, res) => {
    try {
      res.json(await draftIssueFromChat(holder, req.params.chatId));
    } catch (e) { fail(res, e); }
  }));

  app.post(`${base}/create-issue`, withHolder(async (holder, req, res) => {
    try {
      res.json(await createIssueFromDraft(holder, req.params.chatId, req.body ?? {}));
    } catch (e) { fail(res, e); }
  }));
}
