/**
 * The pull request rows a thread's user closed above the composer
 * (`OrchestrationThreadShell.dismissedPullRequests`), applied the same way by
 * the server's read model, its projection and the web store.
 *
 * @module pullRequestDismissals
 */

/**
 * The list after one `thread.pull-request-dismissed` event, or null when the
 * event changes nothing.
 */
export function applyPullRequestDismissed(
  dismissed: ReadonlyArray<number> | null | undefined,
  change: { readonly number: number; readonly dismissed: boolean },
): ReadonlyArray<number> | null {
  const current = dismissed ?? [];
  if (current.includes(change.number) === change.dismissed) {
    return null;
  }
  return change.dismissed
    ? [...current, change.number]
    : current.filter((number) => number !== change.number);
}
