/**
 * A thread's move to another checkout, as the events both ways in decide it:
 * the user choosing one (`thread.checkout.select`) and an agent moving a
 * thread it steers into another thread's (`thread.child.send` with a
 * `checkout`, docs/design/child-threads.md, "Workspaces").
 */
import type {
  OrchestrationEvent,
  OrchestrationThread,
  ThreadWorktreeOrigin,
} from "@threadlines/contracts";
import { areFilesystemPathsEqual } from "@threadlines/shared/path";

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;
type EventBase = Omit<OrchestrationEvent, "sequence" | "type" | "payload">;

/** Whether `worktreePath` (already normalized: null is the project folder) is another checkout than the thread's. */
export function movesCheckout(
  thread: Pick<OrchestrationThread, "worktreePath">,
  worktreePath: string | null,
): boolean {
  return worktreePath === null || thread.worktreePath === null
    ? worktreePath !== thread.worktreePath
    : !areFilesystemPathsEqual(worktreePath, thread.worktreePath);
}

/**
 * A thread leaving another thread's worktree (ThreadWorktreeOrigin) stops
 * being its guest: the meta update that moves it says so.
 */
export function leavesLentWorktree(thread: Pick<OrchestrationThread, "worktreeOrigin">) {
  return (thread.worktreeOrigin ?? null) !== null ? { worktreeOrigin: null } : {};
}

/**
 * The events that point a thread at a checkout chosen for it, for its next
 * safe turn. The choice outranks where its session was last seen working:
 * while that still shadows it (or work is live, so it may yet), a
 * `selection` marker holds the choice; with nothing left to outrank, a stale
 * marker is cleared. `worktreeOrigin` names whose worktree it is, when it is
 * another thread's; left out, a move ends any earlier stay as a guest.
 */
export function checkoutSelectedEvents(input: {
  readonly thread: Pick<
    OrchestrationThread,
    "id" | "worktreePath" | "worktreeOrigin" | "effectiveCwd" | "effectiveCwdSource" | "session"
  >;
  readonly branch: string | null;
  /** Already normalized: null is the project folder. */
  readonly worktreePath: string | null;
  readonly worktreeOrigin?: ThreadWorktreeOrigin | undefined;
  readonly occurredAt: string;
  /** A fresh event base on the thread's aggregate, one per call. */
  readonly base: () => EventBase;
}): ReadonlyArray<PlannedEvent> {
  const { thread, occurredAt } = input;
  const metaUpdatedEvent = {
    ...input.base(),
    type: "thread.meta-updated",
    payload: {
      threadId: thread.id,
      branch: input.branch,
      worktreePath: input.worktreePath,
      ...(input.worktreeOrigin !== undefined
        ? { worktreeOrigin: input.worktreeOrigin }
        : movesCheckout(thread, input.worktreePath)
          ? leavesLentWorktree(thread)
          : {}),
      updatedAt: occurredAt,
    },
  } as const satisfies PlannedEvent;
  const hasLiveWork =
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.session?.activeTurnId != null ||
    (thread.session?.pendingBackgroundTaskCount ?? 0) > 0;
  const selectionAuthorityRequired = thread.effectiveCwd !== null || hasLiveWork;
  if (selectionAuthorityRequired === (thread.effectiveCwdSource === "selection")) {
    return [metaUpdatedEvent];
  }
  return [
    metaUpdatedEvent,
    {
      ...input.base(),
      causationEventId: metaUpdatedEvent.eventId,
      type: "thread.effective-cwd-set",
      payload: {
        threadId: thread.id,
        effectiveCwd: null,
        ...(selectionAuthorityRequired ? { effectiveCwdSource: "selection" as const } : {}),
        updatedAt: occurredAt,
      },
    },
  ];
}
