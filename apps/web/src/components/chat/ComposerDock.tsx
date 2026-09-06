/**
 * The rows docked to the top of the composer.
 *
 * One frame, not two: the pull request row and the notice rows share the
 * composer's left and right edges and square off its top corners, so they read
 * as one statement about sending rather than a stack of separate cards. The
 * pull request comes first because it is standing context, and a notice is
 * news that has to land closest to the thing it blocks.
 *
 * @module ComposerDock
 */
import { ComposerNoticeDock } from "./ComposerNoticeDock";
import { ComposerPullRequestRow, type ComposerPullRequest } from "./ComposerPullRequestRow";
import type { ComposerNotice } from "./composerNotices";

/** Whether the dock would draw anything, which is what squares the composer's top. */
export function hasComposerDockContent(input: {
  readonly pullRequest: ComposerPullRequest | null;
  readonly notices: ReadonlyArray<ComposerNotice>;
}): boolean {
  return input.pullRequest !== null || input.notices.length > 0;
}

export function ComposerDock({
  pullRequest,
  notices,
}: {
  readonly pullRequest: ComposerPullRequest | null;
  readonly notices: ReadonlyArray<ComposerNotice>;
}) {
  if (!hasComposerDockContent({ pullRequest, notices })) {
    return null;
  }
  return (
    // The dock is always exactly as wide as the composer it docks to, so its
    // inline size is contained: without that, a row's fixed chrome raises the
    // composer's minimum width and can hold its footer out of the compact
    // layout that narrow widths depend on.
    <div
      data-composer-notice-dock="true"
      className="rounded-t-xl border border-border border-b-0 bg-card [contain:inline-size]"
    >
      {pullRequest ? (
        <ComposerPullRequestRow pullRequest={pullRequest} divided={notices.length > 0} />
      ) : null}
      <ComposerNoticeDock notices={notices} />
    </div>
  );
}
