/** Why Push is disabled while the tree has work: uncommitted files never enable
 * it (push only runs `git push`). Returns the file count, or 0 for no note. */
export function dirtyNoteCount(git) {
  if (!git || git.unpushed !== 0) return 0;
  const n = Number(git.dirty);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The git state is unknown (no branchStatus yet) for a card whose branch has a worktree. */
export function gitUnknown(task, git, compact) {
  return !git && !compact && Boolean(task?.branch && task?.hasWorktree);
}

/** A task with no worktree yet (typical for manual-mode tasks) and no git state: Pull and
 * Push show disabled with a hint and a button to create the worktree. Not for a finished or
 * reassigned task, not for the compact card, and never when a worktree exists. */
export function needsWorktree(task, git, compact) {
  return !git && !compact && Boolean(task) && !task.hasWorktree
    && task.state !== 'done' && !task.unassigned;
}
