/**
 * The message the server sends a thread when its pull request needs work: a
 * check has just failed, a reviewer has just said something, or the merge
 * queue has just given it back.
 *
 * Pure so the watcher's behaviour is testable without a host, and shared so
 * the client's own review-comment hand-off quotes a remark the same way.
 *
 * @module pullRequestAutoFix
 */

/** One failing check, as the message lists it. */
export interface PullRequestAutoFixCheck {
  readonly name: string;
  readonly url?: string | null | undefined;
}

/** One remark that arrived from somebody other than the viewer. */
export interface PullRequestAutoFixComment {
  readonly author: string | null;
  readonly body: string;
}

/**
 * The merge queue taking the pull request out: its own run of the checks, on
 * the pull request merged with the latest base, failed.
 */
export interface PullRequestAutoFixMergeQueueFailure {
  /** The branch the queue merged it with, as the host names it. */
  readonly baseBranch: string;
  /** What failed in that run; empty where a re-run has passed since. */
  readonly failedChecks: readonly PullRequestAutoFixCheck[];
}

/**
 * Where the pull request's branch is checked out, when that is not known to be
 * the folder the thread's agent works in: `folder` is another checkout the
 * server found on it, and `unknown` is a branch it found no checkout of that
 * it could vouch for.
 */
export type PullRequestAutoFixCheckout =
  | { readonly kind: "folder"; readonly branch: string; readonly path: string }
  | { readonly kind: "unknown"; readonly branch: string };

export interface PullRequestAutoFixPromptInput {
  readonly number: number;
  /** `owner/name`, as the host spells it. */
  readonly repository: string;
  readonly failingChecks: readonly PullRequestAutoFixCheck[];
  readonly comments: readonly PullRequestAutoFixComment[];
  readonly mergeQueueFailure?: PullRequestAutoFixMergeQueueFailure | null;
  /** Absent or null: the branch is the one the thread's own folder is on. */
  readonly checkout?: PullRequestAutoFixCheckout | null;
}

const FIX_AND_PUSH =
  "fix what needs fixing, run the project's checks, commit on that branch, and push so the pull request updates.";

/** The closing instruction: what to do, and where. */
function workLine(checkout: PullRequestAutoFixCheckout | null): string {
  if (checkout === null) {
    return "Fix what needs fixing, run the project's checks, commit on this branch, and push so the pull request updates.";
  }
  if (checkout.kind === "folder") {
    return `Its branch, \`${checkout.branch}\`, is checked out at \`${checkout.path}\`, not in this thread's folder. Work in that folder: ${FIX_AND_PUSH}`;
  }
  return `Its branch is \`${checkout.branch}\`. Work in the folder it is checked out in (\`git worktree list\` shows where), or check it out in a new worktree, rather than switching this thread's folder to it. Then ${FIX_AND_PUSH}`;
}

function checkLines(checks: readonly PullRequestAutoFixCheck[]): string[] {
  return checks.map((check) => {
    const url = check.url?.trim() ?? "";
    return url.length === 0 ? `- ${check.name}` : `- ${check.name} (${url})`;
  });
}

/**
 * A remark quoted rather than restated, so the agent reads the reviewer's own
 * words. Blank lines stay blank quotes, which keeps paragraphs apart.
 */
export function quotePullRequestBody(body: string): string {
  return body
    .replace(/\r\n/gu, "\n")
    .trimEnd()
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

/**
 * The whole message for one sweep: the merge queue giving the pull request
 * back, every check that has just started failing, and every remark that has
 * just arrived, then what to do about them. Returns null when there is nothing
 * new to say, so a caller cannot start an empty turn.
 */
export function buildPullRequestAutoFixPrompt(input: PullRequestAutoFixPromptInput): string | null {
  const queueFailure = input.mergeQueueFailure ?? null;
  if (queueFailure === null && input.failingChecks.length === 0 && input.comments.length === 0) {
    return null;
  }

  const sections: string[] = [
    `Pull request #${input.number} on ${input.repository} needs attention.`,
  ];

  if (queueFailure !== null) {
    const merged = `merged with the latest ${queueFailure.baseBranch}`;
    sections.push(
      [
        queueFailure.failedChecks.length === 0
          ? `The merge queue took it out because a check failed when it was ${merged}.`
          : `The merge queue took it out because these checks failed when it was ${merged}:`,
        ...checkLines(queueFailure.failedChecks),
        `A failure there can come from newer changes on ${queueFailure.baseBranch} or from a flaky test. If nothing needs changing, say so and leave the branch alone. It goes back in the queue on its own once its checks pass.`,
      ].join("\n"),
    );
  }

  if (input.failingChecks.length > 0) {
    sections.push(["These checks failed:", ...checkLines(input.failingChecks)].join("\n"));
  }

  if (input.comments.length > 0) {
    const blocks = input.comments.map((comment) => {
      const author = comment.author?.trim() || "Someone";
      return `${author} wrote:\n${quotePullRequestBody(comment.body)}`;
    });
    sections.push(`New review comments:\n${blocks.join("\n\n")}`);
  }

  sections.push(workLine(input.checkout ?? null));

  return sections.join("\n\n");
}
