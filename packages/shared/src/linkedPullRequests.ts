/**
 * The pull requests a thread holds by number
 * (`OrchestrationThreadShell.linkedPullRequests`) and the switches on them,
 * applied the same way by the server's read model, its projection and the web
 * store, and read the same way by everything that asks whether a thread has
 * the server watching its pull requests.
 *
 * @module linkedPullRequests
 */
import type {
  OrchestrationThreadLinkedPullRequest,
  PullRequestMergeMethod,
} from "@threadlines/contracts";

type LinkedPullRequests = ReadonlyArray<OrchestrationThreadLinkedPullRequest>;

/**
 * The list after one `thread.pull-request-linked` event, or null when the
 * thread already holds that number. A pull request comes in with its
 * switches off.
 */
export function applyPullRequestLinked(
  linked: LinkedPullRequests | null | undefined,
  link: { readonly number: number; readonly url: string },
): OrchestrationThreadLinkedPullRequest[] | null {
  const current = linked ?? [];
  if (current.some((entry) => entry.number === link.number)) {
    return null;
  }
  return [...current, { number: link.number, url: link.url, autoFix: false, autoMerge: null }];
}

/**
 * The list after a numbered `thread.pull-request-automation-changed` event. A
 * switch the event leaves out keeps its value, and a number the thread does
 * not hold changes nothing.
 */
export function applyLinkedPullRequestSwitches(
  linked: LinkedPullRequests | null | undefined,
  change: {
    readonly pullRequestNumber: number;
    readonly autoFix?: boolean | undefined;
    readonly autoMerge?: PullRequestMergeMethod | null | undefined;
  },
): OrchestrationThreadLinkedPullRequest[] {
  return (linked ?? []).map((entry) =>
    entry.number === change.pullRequestNumber
      ? {
          ...entry,
          ...(change.autoFix === undefined ? {} : { autoFix: change.autoFix }),
          ...(change.autoMerge === undefined ? {} : { autoMerge: change.autoMerge }),
        }
      : entry,
  );
}

/** Whether one held pull request has a switch on. */
export function linkedPullRequestArmed(
  entry: Pick<OrchestrationThreadLinkedPullRequest, "autoFix" | "autoMerge">,
): boolean {
  return entry.autoFix || entry.autoMerge !== null;
}

/**
 * Whether any of a thread's pull request switches is on: its own, for the
 * pull request on its checkout's branch, or one held by number.
 */
export function threadPullRequestAutomationArmed(thread: {
  readonly pullRequestAutoFix: boolean;
  readonly pullRequestAutoMerge: PullRequestMergeMethod | null;
  readonly linkedPullRequests: LinkedPullRequests;
}): boolean {
  return (
    thread.pullRequestAutoFix ||
    thread.pullRequestAutoMerge !== null ||
    thread.linkedPullRequests.some(linkedPullRequestArmed)
  );
}
