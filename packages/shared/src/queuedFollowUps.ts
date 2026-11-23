import type { OrchestrationQueuedFollowUp } from "@threadlines/contracts";

/**
 * A thread's queue after `followUp` was queued: one already there with the
 * same message id is replaced where it stands (a report handed to another
 * agent keeps its turn in line); a new one goes last, except a message
 * Threadlines wrote because the thread moved or its move didn't happen
 * (`afterMove`, docs/design/fleet.md, Part 3e), which goes ahead of every
 * message the user queued, behind any other one like it. Every reader of
 * `thread.follow-up-queued` (server read models, clients) applies it, so they
 * agree on what goes next.
 */
export function withQueuedFollowUp(
  current: ReadonlyArray<OrchestrationQueuedFollowUp>,
  followUp: OrchestrationQueuedFollowUp,
): ReadonlyArray<OrchestrationQueuedFollowUp> {
  const at = current.findIndex((queued) => queued.messageId === followUp.messageId);
  if (at >= 0 && (current[at]!.afterMove === true) === (followUp.afterMove === true)) {
    return current.map((queued, index) => (index === at ? followUp : queued));
  }
  const rest = current.filter((queued) => queued.messageId !== followUp.messageId);
  if (followUp.afterMove !== true) return [...rest, followUp];
  const ahead = rest.filter((queued) => queued.afterMove === true);
  const behind = rest.filter((queued) => queued.afterMove !== true);
  return [...ahead, followUp, ...behind];
}
