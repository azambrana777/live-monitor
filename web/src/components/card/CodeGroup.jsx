import React, { useState } from 'react';
import Icon from '../Icon.jsx';
import ChangeRequestCard from '../ChangeRequestCard.jsx';
import ChecksBar from '../charts/ChecksBar.jsx';
import CardSection from './CardSection.jsx';
import { useStrings } from '../../i18n/useStrings.js';
import { fill, plural, strings } from '../../i18n/index.js';
import { ago } from '../../time.js';
import { dirtyNoteCount, gitUnknown, needsWorktree } from './gitNote.js';

// The PR picker's labels live here, with the only component that reads them
// (kept in TaskCard they would make an import cycle).
/** The PR's state as a word (draft, open, merged, closed), or null for a PR whose state an
 * old record never carried (only `prUrl` survives from before `task.prs`). */
function prStateLabel(state) {
  return strings().card.code.prState[state] ?? null;
}

/** «21/09»: the combobox lists several PRs and only needs to tell them apart,
 * not carry the full stamp `time.js` gives a chat message. `createdAt` can be
 * null for a PR adopted from an old record, so this reads it like every other
 * stamp on the card: absent means nothing is printed, not «Invalid Date». */
function prShortDate(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function prOptionLabel(pr) {
  return [`#${pr.number}`, prStateLabel(pr.state), prShortDate(pr.createdAt)].filter(Boolean).join(' · ');
}

/** The checks light as words: «3 running», «2 failing», «12 passed». */
function checksText(light, checks) {
  const t = strings();
  if (light === 'fail') return fill(t.card.code.checksFailing, { n: checks.failed });
  if (light === 'pending') return fill(t.card.code.checksRunning, { n: checks.pending });
  return fill(t.card.code.checksPassed, { n: checks.passed });
}

/** The link to the selected PR, with its checks light. */
export function PrLink({ task, m, h, size = 'md' }) {
  const t = useStrings();
  const { selectedPr, showPrChecks, checks, light } = m;
  if (!selectedPr) return null;
  const state = prStateLabel(selectedPr.state);
  const tone = (selectedPr.state ?? 'unknown').toLowerCase();
  const title = !showPrChecks ? t.card.code.prOpenTitle
    : checks?.stale ? t.card.code.checksStale
      : light === 'fail' ? plural(checks.failed, t.card.code.checksFailTitle)
        : light === 'pending' ? plural(checks.pending, t.card.code.checksPendingTitle)
          : light === 'ok' ? plural(checks.passed, t.card.code.checksOkTitle) : t.card.code.prOpenShort;
  const withChecks = showPrChecks && light && checks;
  return (
    <span className={`tcc-pr tcc-pr-${size}`}>
      <a className={`tcc-pr-link tcc-pr-${tone}`} href={selectedPr.url} target="_blank" rel="noreferrer" title={title}>
        <Icon name="pull-request" />
        <span>PR #{selectedPr.number}</span>{/* i18n-ok: PR reads the same in every language */}
        {state && <span className="tcc-pr-state">{state}</span>}
      </a>
      {withChecks && (
        <span className={`tcc-checks tcc-checks-${light}`} title={title}>
          <ChecksBar passed={checks.passed ?? 0} pending={checks.pending ?? 0} failed={checks.failed ?? 0}
            label={[fill(t.card.code.checksAria, { passed: checks.passed ?? 0, total: checks.total ?? 0 }),
              checks.pending > 0 && fill(t.card.code.checksRunning, { n: checks.pending }),
              checks.failed > 0 && fill(t.card.code.checksFailing, { n: checks.failed })].filter(Boolean).join(', ')} />
          <span className="tcc-checks-text">{checksText(light, checks)}</span>
        </span>
      )}
    </span>
  );
}

/** «Ready»: from draft to ready for review. */
export function ReadyButton({ task, m, h }) {
  const t = useStrings();
  const { inFlight } = m;
  const { onReady } = h;
  return (
    <>
      {task.state === 'pr_draft' && task.prNumber && (
        <button type="button" className="btn btn-warn btn-sm tcc-ready" disabled={inFlight('ready')} onClick={() => onReady(task.issue)}
          title={t.card.code.readyTitle}>
          <Icon name="check-circle" /> {t.card.code.ready}
        </button>
      )}
    </>
  );
}

export default function CodeGroup({ task, m, h, compact = false, variant = 'expanded' }) {
  const t = useStrings();
  const { gitBusy, inFlight, prList, selectedPr, selectedPrNumber, setSelectedPrNumber, changeRequests, git, behind, unpushed, canPush, busy } = m;
  const { onReviewer, onOpenCr, onToggleActiveCr, onDraftCr, onStartCr, onMergeMain, onPush, onMergeHelp, onCreateWorktree } = h;
  const [creating, setCreating] = useState(false);
  const showGit = Boolean(git) && !compact;
  const showReady = task.state === 'pr_draft' && Boolean(task.prNumber);
  const showReviewer = Boolean(task.prNumber && onReviewer);
  const showStack = !compact && changeRequests.length > 0;
  // Nothing here would exist for this task: no section, not an empty title.
  const unknown = gitUnknown(task, git, compact);
  const noTree = needsWorktree(task, git, compact) && Boolean(onCreateWorktree);
  const dirtyN = showGit ? dirtyNoteCount(git) : 0;
  const checkedAt = showGit && git.at ? ago(git.at) : '';
  if (!selectedPr && !showGit && !unknown && !noTree && !showReady && !showReviewer && !showStack) return null;

  // Pull/Push are disabled while the task or a chat turn is working (gitBusy);
  // the note says why once, instead of a dead pair of buttons saying nothing.
  const waitNote = task.chatBusy ? t.card.code.waitChat
    : busy ? t.card.code.waitTask : null;
  const files = (n) => plural(n, t.card.code.files);
  const behindNote = git && (behind > 0 || git.conflicts > 0)
    ? [plural(behind, t.card.code.behindMain),
      git.conflicts > 0 && fill(t.card.code.conflictIn, { files: files(git.conflicts) })].filter(Boolean).join(' · ')
    : null;
  const note = showGit ? (waitNote ?? behindNote) : null;
  const workTitle = task.chatBusy ? t.card.code.workChat : t.card.code.workTask;

  return (
    <CardSection title={t.card.code.title} note={note}>
      {(selectedPr || showGit) && (
        <div className="tcc-pr-row">
          {selectedPr ? (
            <>
              <PrLink task={task} m={m} h={h} />
              {prList.length > 1 && (
                <select className="tcc-pr-pick" value={selectedPrNumber ?? ''}
                  onChange={(e) => setSelectedPrNumber(Number(e.target.value))}
                  title={t.card.code.pickTitle}
                  aria-label={t.card.code.pickAria}>
                  {prList.map((p) => (
                    <option key={p.number} value={p.number}
                      className={`tcc-opt-${(p.state ?? 'unknown').toLowerCase()}`}>
                      {prOptionLabel(p)}
                    </option>
                  ))}
                </select>
              )}
            </>
          ) : (
            <span className="tcc-no-pr"><Icon name="pull-request" /> {t.card.code.noPr}</span>
          )}
        </div>
      )}
      {(showGit || unknown || noTree || showReady || showReviewer) && (
        <div className="tcc-actions">
          {unknown && <span className="tcc-git-unknown">{t.card.code.gitUnknown}</span>}
          {noTree && (
            <>
              <button type="button" className="btn btn-sm btn-secondary" disabled title={t.card.code.noWorktreeNote}>
                <Icon name="arrow-down" /> Pull{/* i18n-ok: git verb */}
              </button>
              <button type="button" className="btn btn-sm btn-secondary" disabled title={t.card.code.noWorktreeNote}>
                <Icon name="arrow-up" /> Push{/* i18n-ok: git verb */}
              </button>
              <button type="button" className="btn btn-sm tcc-create-tree" disabled={creating || gitBusy}
                title={t.card.code.createWorktreeTitle}
                onClick={async () => {
                  setCreating(true);
                  try { await onCreateWorktree(task.issue); } finally { setCreating(false); }
                }}>
                <Icon name="tree" /> {t.card.code.createWorktree}
              </button>
              <span className="tcc-git-note tcc-no-tree">{t.card.code.noWorktreeNote}</span>
            </>
          )}
          {showGit && (
            <button type="button" className={`btn btn-sm ${behind > 0 ? 'btn-warn' : 'btn-secondary'}`} disabled={behind === 0 || gitBusy || inFlight('merge')}
              onClick={() => onMergeMain(task.issue)}
              title={[gitBusy ? fill(task.chatBusy ? t.card.code.pullWaitsChat : t.card.code.pullWaitsTask, { work: workTitle })
                : git.mergeStuck ? t.card.code.mergeStuck
                  : behind === 0 ? t.card.code.upToDate
                    : git.conflicts > 0
                      ? fill(plural(behind, t.card.code.pullConflict), { files: files(git.conflicts) })
                      : plural(behind, t.card.code.pullBehind), checkedAt && fill(t.card.code.gitChecked, { ago: checkedAt })].filter(Boolean).join(' · ')}>
              <Icon name="arrow-down" /> Pull{behind > 0 ? ` · ${behind}` : ''}{/* i18n-ok: git verb */}
            </button>
          )}
          {showGit && (
            <button type="button" className={`btn btn-sm ${canPush ? 'btn-warn' : 'btn-secondary'}`} disabled={!canPush || gitBusy || inFlight('push')}
              onClick={() => onPush(task.issue)}
              title={[gitBusy ? fill(task.chatBusy ? t.card.code.pushWaitsChat : t.card.code.pushWaitsTask, { work: workTitle })
                : canPush ? t.card.code.pushTitle : dirtyN > 0 ? plural(dirtyN, t.card.code.commitFirst) : t.card.code.nothingToPush,
                checkedAt && fill(t.card.code.gitChecked, { ago: checkedAt })].filter(Boolean).join(' · ')}>
              <Icon name="arrow-up" /> Push{unpushed > 0 ? ` · ${unpushed}` : ''}{/* i18n-ok: git verb */}
            </button>
          )}
          {git?.conflicts > 0 && !compact && (
            <button type="button" className="btn btn-warn btn-sm" disabled={gitBusy} onClick={() => onMergeHelp(task.issue)}
              title={t.card.code.fixConflictTitle}>
              <Icon name="message" /> {t.card.code.fixConflict}
            </button>
          )}
          <ReadyButton task={task} m={m} h={h} />
          {dirtyN > 0 && <span className="tcc-git-note tcc-git-dirty">{plural(dirtyN, t.card.code.commitFirst)}</span>}
          {checkedAt && <span className="tcc-git-note tcc-git-checked">{fill(t.card.code.gitChecked, { ago: checkedAt })}</span>}
          {showReviewer && (
            <button type="button" className="btn btn-secondary btn-sm tcc-reviewer" onClick={() => onReviewer(task.issue)}
              title={t.card.code.reviewerTitle}>
              <Icon name="user" /> {t.card.code.reviewer}
            </button>
          )}
        </div>
      )}
      {showStack && (
        <div className="tcc-cr-stack">
          {changeRequests.map((cr) => (
            <ChangeRequestCard
              key={cr.reviewId} task={task} cr={cr}
              onOpen={(reviewId) => onOpenCr(task.issue, reviewId)}
              onToggleActive={(reviewId, active) => onToggleActiveCr(task.issue, reviewId, active)}
              onDraft={(reviewId) => onDraftCr(task.issue, reviewId)}
              onStart={() => onStartCr(task.issue)}
            />
          ))}
        </div>
      )}
    </CardSection>
  );
}
