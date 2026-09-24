import type {
  OrchestrationEvent,
  OrchestrationThreadLinkedPullRequest,
  PullRequestMergeMethod,
  ThreadId,
} from "@threadlines/contracts";

/** A thread's server-held merge switches: its own, and each linked pull request's. */
interface ThreadMergeSwitches {
  readonly pullRequestAutoMerge?: PullRequestMergeMethod | null;
  readonly linkedPullRequests?: readonly OrchestrationThreadLinkedPullRequest[];
}

/**
 * Whether a server-held "Merge when checks pass" that was on is now off, for
 * the thread's own pull request or a linked one. The shell stream reports a
 * thread's new state rather than the event behind it, so the two states are
 * compared; see `needsPullRequestInvalidation` for why it matters.
 */
export function serverMergeSwitchTurnedOff(
  previous: ThreadMergeSwitches | undefined,
  next: ThreadMergeSwitches,
): boolean {
  if (previous === undefined) {
    return false;
  }
  if (previous.pullRequestAutoMerge != null && next.pullRequestAutoMerge == null) {
    return true;
  }
  return (previous.linkedPullRequests ?? []).some(
    (linked) =>
      linked.autoMerge !== null &&
      (next.linkedPullRequests ?? []).find((other) => other.number === linked.number)?.autoMerge ==
        null,
  );
}

export interface OrchestrationBatchEffects {
  promoteDraftThreadIds: ThreadId[];
  clearDeletedThreadIds: ThreadId[];
  removeTerminalStateThreadIds: ThreadId[];
  needsProviderInvalidation: boolean;
  /**
   * A thread's server-held "Merge when checks pass" turned off. The server
   * merged its pull request, handed it to a merge queue, or gave up, and that
   * switch is the only word of it the client gets, so every pull request read
   * is taken again.
   */
  needsPullRequestInvalidation: boolean;
}

export function deriveOrchestrationBatchEffects(
  events: readonly OrchestrationEvent[],
): OrchestrationBatchEffects {
  const threadLifecycleEffects = new Map<
    ThreadId,
    {
      clearPromotedDraft: boolean;
      clearDeletedThread: boolean;
      removeTerminalState: boolean;
    }
  >();
  let needsProviderInvalidation = false;
  let needsPullRequestInvalidation = false;

  for (const event of events) {
    switch (event.type) {
      case "thread.turn-diff-completed":
      case "thread.reverted": {
        needsProviderInvalidation = true;
        break;
      }

      case "thread.pull-request-automation-changed": {
        if (event.payload.autoMerge === null) {
          needsPullRequestInvalidation = true;
        }
        break;
      }

      case "thread.created": {
        threadLifecycleEffects.set(event.payload.threadId, {
          clearPromotedDraft: true,
          clearDeletedThread: false,
          removeTerminalState: false,
        });
        break;
      }

      case "thread.deleted": {
        threadLifecycleEffects.set(event.payload.threadId, {
          clearPromotedDraft: false,
          clearDeletedThread: true,
          removeTerminalState: true,
        });
        break;
      }

      case "thread.archived": {
        threadLifecycleEffects.set(event.payload.threadId, {
          clearPromotedDraft: false,
          clearDeletedThread: false,
          removeTerminalState: true,
        });
        break;
      }

      case "thread.unarchived": {
        threadLifecycleEffects.set(event.payload.threadId, {
          clearPromotedDraft: false,
          clearDeletedThread: false,
          removeTerminalState: false,
        });
        break;
      }

      default: {
        break;
      }
    }
  }

  const promoteDraftThreadIds: ThreadId[] = [];
  const clearDeletedThreadIds: ThreadId[] = [];
  const removeTerminalStateThreadIds: ThreadId[] = [];
  for (const [threadId, effect] of threadLifecycleEffects) {
    if (effect.clearPromotedDraft) {
      promoteDraftThreadIds.push(threadId);
    }
    if (effect.clearDeletedThread) {
      clearDeletedThreadIds.push(threadId);
    }
    if (effect.removeTerminalState) {
      removeTerminalStateThreadIds.push(threadId);
    }
  }

  return {
    promoteDraftThreadIds,
    clearDeletedThreadIds,
    removeTerminalStateThreadIds,
    needsProviderInvalidation,
    needsPullRequestInvalidation,
  };
}
