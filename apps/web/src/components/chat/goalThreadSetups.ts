/**
 * Threads a goal is setting up from this window (making the thread, or
 * cutting its worktree), by scoped thread key. A send, a Retry or another goal
 * on the same thread waits until it's done: a second setup of the thread would
 * race the first, and the server would refuse one of the two. Kept outside the
 * chat view so it holds while the view remounts (the user leaves the draft and
 * comes back while git works).
 *
 * @module goalThreadSetups
 */

const settingUp = new Set<string>();

/** Marks the thread as being set up by a goal; call the result once it's done. */
export function beginGoalThreadSetup(threadKey: string): () => void {
  settingUp.add(threadKey);
  return () => {
    settingUp.delete(threadKey);
  };
}

/** Whether a goal from this window is setting the thread up right now. */
export function isGoalSettingUpThread(threadKey: string): boolean {
  return settingUp.has(threadKey);
}
