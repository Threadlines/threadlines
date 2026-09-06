/**
 * The message the server sends a thread when its pull request needs work: a
 * check has just failed, or a reviewer has just said something.
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

export interface PullRequestAutoFixPromptInput {
  readonly number: number;
  /** `owner/name`, as the host spells it. */
  readonly repository: string;
  readonly failingChecks: readonly PullRequestAutoFixCheck[];
  readonly comments: readonly PullRequestAutoFixComment[];
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
 * The whole message for one sweep: every check that has just started failing
 * and every remark that has just arrived, then what to do about them. Returns
 * null when there is nothing new to say, so a caller cannot start an empty turn.
 */
export function buildPullRequestAutoFixPrompt(input: PullRequestAutoFixPromptInput): string | null {
  if (input.failingChecks.length === 0 && input.comments.length === 0) {
    return null;
  }

  const sections: string[] = [
    `Pull request #${input.number} on ${input.repository} needs attention.`,
  ];

  if (input.failingChecks.length > 0) {
    const lines = input.failingChecks.map((check) => {
      const url = check.url?.trim() ?? "";
      return url.length === 0 ? `- ${check.name}` : `- ${check.name} (${url})`;
    });
    sections.push(["These checks failed:", ...lines].join("\n"));
  }

  if (input.comments.length > 0) {
    const blocks = input.comments.map((comment) => {
      const author = comment.author?.trim() || "Someone";
      return `${author} wrote:\n${quotePullRequestBody(comment.body)}`;
    });
    sections.push(`New review comments:\n${blocks.join("\n\n")}`);
  }

  sections.push(
    "Fix what needs fixing, run the project's checks, commit on this branch, and push so the pull request updates.",
  );

  return sections.join("\n\n");
}
