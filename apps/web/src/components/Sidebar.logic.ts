import * as React from "react";
import type { SidebarProjectSortOrder } from "@threadlines/contracts/settings";
import {
  getThreadInFlightStatus,
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "../lib/threadSort";
import type { SidebarThreadSummary, Thread } from "../types";
import { isLatestTurnSettled, isWaitingOnBackgroundTasks } from "../session-logic";
import { isHandedBackCompletion } from "@threadlines/shared/childThreads";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 100;
// Visible sidebar rows are prewarmed into the thread-detail cache so opening a
// nearby thread usually reuses an already-hot subscription.
export const SIDEBAR_THREAD_PREWARM_LIMIT = 10;
type SidebarProject = {
  id: string;
  name: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export type ThreadTraversalDirection = "previous" | "next";

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Starting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready"
    | "Waiting"
    | "Answering"
    | "Failed";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
  /**
   * "Waiting" on the threads its agent started rather than on its own
   * background work: how many still owe it an answer.
   */
  childThreadCount?: number;
}

export const THREAD_STATUS_DOT_CLASSES = {
  amber: "bg-amber-500 dark:bg-amber-300/90",
  blue: "bg-primary-graph",
  cyan: "bg-cyan-500 dark:bg-cyan-300/90",
  emerald: "bg-emerald-500 dark:bg-emerald-300/90",
  violet: "bg-violet-500 dark:bg-violet-300/90",
  red: "bg-red-500 dark:bg-red-400/90",
} as const;

type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasBlockingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
  | "sideTurn"
  | "pendingChildApproval"
  | "awaitedChildThreadCount"
> & {
  lastVisitedAt?: string | undefined;
};

export interface ThreadJumpHintVisibilityController {
  sync: (shouldShow: boolean) => void;
  dispose: () => void;
}

export function createThreadJumpHintVisibilityController(input: {
  delayMs: number;
  onVisibilityChange: (visible: boolean) => void;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
}): ThreadJumpHintVisibilityController {
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout;
  let isVisible = false;
  let timeoutId: NodeJS.Timeout | null = null;

  const clearPendingShow = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeoutFn(timeoutId);
    timeoutId = null;
  };

  return {
    sync: (shouldShow) => {
      if (!shouldShow) {
        clearPendingShow();
        if (isVisible) {
          isVisible = false;
          input.onVisibilityChange(false);
        }
        return;
      }

      if (isVisible || timeoutId !== null) {
        return;
      }

      timeoutId = setTimeoutFn(() => {
        timeoutId = null;
        isVisible = true;
        input.onVisibilityChange(true);
      }, input.delayMs);
    },
    dispose: () => {
      clearPendingShow();
    },
  };
}

export function useThreadJumpHintVisibility(): {
  showThreadJumpHints: boolean;
  updateThreadJumpHintsVisibility: (shouldShow: boolean) => void;
} {
  const [showThreadJumpHints, setShowThreadJumpHints] = React.useState(false);
  const controllerRef = React.useRef<ThreadJumpHintVisibilityController | null>(null);

  React.useEffect(() => {
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        setShowThreadJumpHints(visible);
      },
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
    });
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const updateThreadJumpHintsVisibility = React.useCallback((shouldShow: boolean) => {
    controllerRef.current?.sync(shouldShow);
  }, []);

  return {
    showThreadJumpHints,
    updateThreadJumpHintsVisibility,
  };
}

export function hasUnseenCompletion(
  thread: Pick<SidebarThreadSummary, "latestTurn"> & { lastVisitedAt?: string | undefined },
): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
}): TItem[] {
  const { getId, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const itemsById = new Map(items.map((item) => [getId(item), item] as const));
  const preferredIdSet = new Set(preferredIds);
  const emittedPreferredIds = new Set<TId>();
  const ordered = preferredIds.flatMap((id) => {
    if (emittedPreferredIds.has(id)) {
      return [];
    }
    const item = itemsById.get(id);
    if (!item) {
      return [];
    }
    emittedPreferredIds.add(id);
    return [item];
  });
  const remaining = items.filter((item) => !preferredIdSet.has(getId(item)));
  return [...ordered, ...remaining];
}

export function getSidebarThreadIdsToPrewarm<TThreadId>(
  visibleThreadIds: readonly TThreadId[],
  limit = SIDEBAR_THREAD_PREWARM_LIMIT,
): TThreadId[] {
  return visibleThreadIds.slice(0, Math.max(0, limit));
}

export function resolveAdjacentThreadId<T>(input: {
  threadIds: readonly T[];
  currentThreadId: T | null;
  direction: ThreadTraversalDirection;
}): T | null {
  const { currentThreadId, direction, threadIds } = input;

  if (threadIds.length === 0) {
    return null;
  }

  if (currentThreadId === null) {
    return direction === "previous" ? (threadIds.at(-1) ?? null) : (threadIds[0] ?? null);
  }

  const currentIndex = threadIds.indexOf(currentThreadId);
  if (currentIndex === -1) {
    return null;
  }

  if (direction === "previous") {
    return currentIndex > 0 ? (threadIds[currentIndex - 1] ?? null) : null;
  }

  return currentIndex < threadIds.length - 1 ? (threadIds[currentIndex + 1] ?? null) : null;
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
  /**
   * Look past waiting on the threads its agent started, to what the thread
   * itself shows beneath it. Wrapping up reads it this way: those threads keep
   * running wrapped or not.
   */
  ignoreChildThreadWait?: boolean;
}): ThreadStatusPill | null {
  const { thread } = input;

  // Threads its agent asked to start wait for the user's yes like any other
  // approval: blocking, and never wrapped away.
  if (thread.hasPendingApprovals || thread.pendingChildApproval === true) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: THREAD_STATUS_DOT_CLASSES.amber,
      pulse: false,
    };
  }

  if (thread.hasBlockingUserInput ?? thread.hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: THREAD_STATUS_DOT_CLASSES.amber,
      pulse: false,
    };
  }

  const inFlightStatus = getThreadInFlightStatus(thread);

  if (inFlightStatus === "working") {
    return {
      label: "Working",
      colorClass: "text-primary-readable",
      dotClass: THREAD_STATUS_DOT_CLASSES.blue,
      pulse: true,
    };
  }

  if (inFlightStatus === "starting") {
    return {
      label: "Starting",
      colorClass: "text-primary-readable",
      dotClass: THREAD_STATUS_DOT_CLASSES.blue,
      pulse: true,
    };
  }

  // In a room, an agent answering on the side while the others are idle.
  if ((thread.sideTurn ?? null) !== null) {
    return {
      label: "Answering",
      colorClass: "text-primary-readable",
      dotClass: THREAD_STATUS_DOT_CLASSES.blue,
      pulse: true,
    };
  }

  if (thread.session?.status === "error") {
    // Failed threads previously showed nothing -- indistinguishable from
    // healthy idle ones, which is the worst place for a failure to hide.
    return {
      label: "Failed",
      colorClass: "text-red-600 dark:text-red-400/90",
      dotClass: THREAD_STATUS_DOT_CLASSES.red,
      pulse: false,
    };
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: THREAD_STATUS_DOT_CLASSES.violet,
      pulse: false,
    };
  }

  // Settled turn with provider tasks still running: the provider will start
  // the thread back up on its own when they finish.
  if (isWaitingOnBackgroundTasks(thread.latestTurn, thread.session)) {
    return {
      label: "Waiting",
      colorClass: "text-cyan-600 dark:text-cyan-300/90",
      dotClass: THREAD_STATUS_DOT_CLASSES.cyan,
      pulse: true,
    };
  }

  // Its own turn is over and the threads its agent started still owe it
  // answers: each one that comes back starts it up again on its own.
  const awaitedChildThreads = thread.awaitedChildThreadCount ?? 0;
  if (
    input.ignoreChildThreadWait !== true &&
    awaitedChildThreads > 0 &&
    isLatestTurnSettled(thread.latestTurn, thread.session)
  ) {
    return {
      label: "Waiting",
      colorClass: "text-cyan-600 dark:text-cyan-300/90",
      dotClass: THREAD_STATUS_DOT_CLASSES.cyan,
      pulse: true,
      childThreadCount: awaitedChildThreads,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: THREAD_STATUS_DOT_CLASSES.emerald,
      pulse: false,
    };
  }

  return null;
}

/**
 * Statuses where the agent has stopped and cannot continue without the user.
 * Narrower than "busy": a working thread needs nothing, and a ready plan is an
 * invitation rather than a block.
 */
const NEEDS_USER_STATUSES: ReadonlySet<ThreadStatusPill["label"]> = new Set([
  "Pending Approval",
  "Awaiting Input",
  "Failed",
]);

/** True when the thread is blocked waiting on the user. */
export function isNeedsUserStatus(status: ThreadStatusPill | null): boolean {
  return status !== null && NEEDS_USER_STATUSES.has(status.label);
}

/**
 * The single word a row spends on status. Only states that stop the agent and
 * hand the thread back earn one; in-flight work reads as "working" with its
 * elapsed time, and everything else rests with a timestamp instead.
 */
const INBOX_STATUS_WORDS: Partial<Record<ThreadStatusPill["label"], string>> = {
  "Pending Approval": "approval",
  "Awaiting Input": "input",
  Failed: "failed",
};

export function inboxStatusWord(status: ThreadStatusPill | null): string | null {
  return status === null ? null : (INBOX_STATUS_WORDS[status.label] ?? null);
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreads(
      threads.filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id),
      ),
    )[0]?.id ?? null
  );
}
export function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly ThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends Pick<Thread, "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  return [...projects].toSorted((left, right) => {
    const rightTimestamp = getProjectSortTimestamp(
      right,
      threadsByProjectId.get(right.id) ?? [],
      sortOrder,
    );
    const leftTimestamp = getProjectSortTimestamp(
      left,
      threadsByProjectId.get(left.id) ?? [],
      sortOrder,
    );
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) return byTimestamp;
    return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
}

/** `sortProjectsForSidebar` for environment-scoped inputs: threads attribute
    to projects by `environment:project` key so same-id projects from
    different environments stay distinct. Archived threads are ignored. */
export function sortScopedProjectsByActivity<
  TProject extends SidebarProject & { environmentId: string },
  TThread extends ThreadSortInput & {
    environmentId: string;
    projectId: string;
    archivedAt: string | null;
  },
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): TProject[] {
  const scopedKey = (environmentId: string, id: string) => `${environmentId}:${id}`;
  const projectByScopedKey = new Map(
    projects.map((project) => [scopedKey(project.environmentId, project.id), project]),
  );
  const sortableProjects = projects.map((project) => ({
    ...project,
    id: scopedKey(project.environmentId, project.id),
  }));
  const sortableThreads = threads
    .filter((thread) => thread.archivedAt === null)
    .map((thread) => ({
      ...thread,
      projectId: scopedKey(thread.environmentId, thread.projectId) as Thread["projectId"],
    }));
  return sortProjectsForSidebar(sortableProjects, sortableThreads, sortOrder).flatMap((sorted) => {
    const project = projectByScopedKey.get(sorted.id);
    return project ? [project] : [];
  });
}

// ── Inbox lifecycle ──────────────────────────────────────────────────
//
// The sidebar is an inbox: one live list, a Done tail. "Done" is a client-side
// overlay in v1 -- an override the user sets, resolved against the thread's
// actual state. The rules below owe their shape to studying how the settle
// lifecycle goes wrong: the invariant that matters is that no override may
// hide work that is moving or blocked on the user.

/**
 * A queued turn start counts as pending work for at most this long.
 *
 * Between sending a message and a session adopting it, the work is invisible
 * to every status check: no turn, no running session. Without a bound, a
 * thread whose start failed would be permanently un-doneable; without the
 * guard, marking Done in that gap would hide a message that is about to run.
 */
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

type InboxLifecycleInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "session"
  | "latestUserMessageAt"
  | "latestTurn"
  | "pendingChildApproval"
  | "awaitedChildThreadCount"
  | "handedBackTurnId"
  | "queuedFollowUpCount"
> & {
  lastVisitedAt?: string | undefined;
};

function hasUnseenSessionFailure(thread: InboxLifecycleInput): boolean {
  if (thread.session?.status !== "error") return false;
  const failedAt = Date.parse(thread.session.updatedAt);
  if (Number.isNaN(failedAt)) return false;
  if (thread.lastVisitedAt == null) return true;
  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  return Number.isNaN(lastVisitedAt) || failedAt > lastVisitedAt;
}

/**
 * A user message no turn has picked up yet: strictly newer than every
 * timestamp on the latest turn, and within the adoption grace window. Bounded
 * on both sides because message timestamps originate on whichever device sent
 * them -- a clock ahead of this one would otherwise hold the queued state for
 * the whole skew.
 */
export function hasQueuedTurnStart(
  thread: InboxLifecycleInput,
  options: { readonly now: string },
): boolean {
  if (thread.latestUserMessageAt == null) return false;
  // A failed start is already visible as the Failed pill; holding the queued
  // state too would make the thread un-doneable while it screams red.
  if (thread.session?.status === "error") return false;
  const messageAt = Date.parse(thread.latestUserMessageAt);
  if (Number.isNaN(messageAt)) return false;
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(nowMs)) return false;
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  const turn = thread.latestTurn;
  if (turn === null) return true;
  return [turn.requestedAt, turn.startedAt, turn.completedAt].every(
    (candidate) => candidate == null || Date.parse(candidate) < messageAt,
  );
}

/**
 * Whether Done is allowed right now. Work that is moving, blocked on the
 * user, waiting in the background, unread, or queued cannot be waved away:
 * hiding a pending approval defeats the approval, and hiding an unread
 * completion or background wakeup hides where its result will land.
 * A failed thread CAN be marked done after it has been inspected -- that is
 * "I saw it, I'm done with it" rather than an accidental dismissal.
 *
 * Waiting on the threads its agent started does not hold a thread open:
 * wrapping it up never stops them, so the check reads what the thread shows
 * beneath that wait.
 */
export function canMarkThreadDone(
  thread: InboxLifecycleInput,
  options: {
    readonly now: string;
    /**
     * A child thread whose latest finished work went back to its parent: the
     * parent's agent read that completion, so it needs no visit.
     */
    readonly handedBackCompletionSeen?: boolean;
  },
): boolean {
  // The same status resolution the row uses, so "can't be marked done" and
  // "shows a status that deserves attention" can never drift apart.
  const status = resolveThreadStatusPill({ thread, ignoreChildThreadWait: true });
  if (status !== null) {
    const handedBack = status.label === "Completed" && options.handedBackCompletionSeen === true;
    if (!handedBack) {
      if (status.label !== "Failed") return false;
      // Failed persists as a diagnostic status after a visit, unlike Completed,
      // so compare its session timestamp explicitly before allowing dismissal.
      if (hasUnseenSessionFailure(thread)) return false;
    }
  }
  if (hasQueuedTurnStart(thread, options)) return false;
  // A message waiting behind the last turn (the user's, or one another
  // thread's agent sent) is work about to run, whoever wrote it.
  if ((thread.queuedFollowUpCount ?? 0) > 0) return false;
  return true;
}

/**
 * The user's explicit word on a thread's lifecycle, stamped when given.
 * "active" exists so a reopened thread stays reopened once auto-done rules
 * arrive; today it simply reads as not-done.
 */
export interface ThreadDoneOverride {
  readonly state: "done" | "active";
  readonly at: string;
}

/**
 * One answer from two sources: the thread's server-held word (shared by every
 * device) and this device's unconfirmed local write. Freshest stamp wins, and
 * the server wins ties -- a landed write carries the same stamp it was sent
 * with, so a tie is the same word twice, not a conflict.
 */
export function mergeThreadDoneOverride(
  overlay: ThreadDoneOverride | null | undefined,
  server: ThreadDoneOverride | null | undefined,
): ThreadDoneOverride | null {
  const overlayAt = overlay ? toSortableTimestamp(overlay.at) : null;
  const serverAt = server ? toSortableTimestamp(server.at) : null;
  if (overlay == null || overlayAt === null)
    return server != null && serverAt !== null ? server : null;
  if (server == null || serverAt === null) return overlay;
  return overlayAt > serverAt ? overlay : server;
}

/**
 * When the user last saw a thread. A pending local write speaks first, then
 * the server's value, then this device's seed for threads the server has
 * never recorded a visit for.
 */
export function mergeThreadLastSeenAt(input: {
  readonly overlayAt?: string | undefined;
  readonly serverLastSeenAt?: string | null | undefined;
  readonly seedAt?: string | undefined;
}): string | undefined {
  return input.overlayAt ?? input.serverLastSeenAt ?? input.seedAt ?? undefined;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * How long a thread sits idle before it files itself under Done.
 *
 * Without this the live list is every thread ever opened: one-off questions
 * from three weeks ago standing shoulder to shoulder with this morning's
 * work, which is the sidebar this design exists to replace. Two days keeps
 * yesterday's threads at hand and lets the weekend clear the desk.
 */
export const INBOX_AUTO_DONE_AFTER_DAYS = 2;

/**
 * Where a thread lives. Resolution order, each layer outranking the next:
 *
 * 1. Blockers. Moving, queued or blocked-on-you work is live, whatever anyone
 *    said.
 * 2. The user's override -- but only while it is FRESHER than the thread's
 *    last activity. New work outranks an old word in both directions: a done
 *    thread that starts again pulls itself back without being un-marked, and
 *    a reopened thread that goes quiet again is allowed to re-file itself.
 * 3. A pin. It is "keep this at hand", the one placement the user made by
 *    hand, so none of the automatic rules below may file it; only the user's
 *    own word above can. Unpinning hands it back to them.
 * 4. A finished child thread (the "wrap up finished child threads" setting):
 *    one still part of its parent's family files itself
 *    once its latest work went back to the parent -- the parent's agent read
 *    that answer, so it needs no visit -- or once the parent itself is
 *    wrapped, since the user is finished with that work. Only the exact
 *    completion handed back skips the unread rule; later work does not.
 * 5. A merged or closed pull request. The branch landing is a stronger signal
 *    than idleness, so it files the thread at once rather than waiting out the
 *    timer. Unread work still stays out, and a moving thread was already
 *    excluded above.
 * 6. Auto-done on idle, unless the thread holds a completion the user has not
 *    seen. Unread work is the inbox's reason to exist; filing it unread would
 *    be the sidebar reading your mail for you.
 */
export function isThreadDone(
  thread: InboxLifecycleInput &
    DoneSortInput &
    Pick<SidebarThreadSummary, "pinnedAt"> & { readonly lastVisitedAt?: string | undefined },
  override: ThreadDoneOverride | null | undefined,
  options: {
    readonly now: string;
    readonly autoDoneAfterDays?: number | null;
    /**
     * When the thread's pull request merged or closed. The landing files the
     * thread once: a message sent after it, or a "keep active" given after it,
     * is the user's word that the thread is still in use.
     */
    readonly pullRequestSettledAt?: string | null;
    /**
     * Set for a thread in its parent's family while "wrap up finished child
     * threads" is on: whether that parent is wrapped. Absent: rule 4 is off.
     */
    readonly childWrapUp?: { readonly parentDone: boolean } | null;
  },
): boolean {
  const childWrapUp = options.childWrapUp ?? null;
  const handedBackCompletionSeen =
    childWrapUp !== null &&
    isHandedBackCompletion({
      handedBackTurnId: thread.handedBackTurnId ?? null,
      latestTurn: thread.latestTurn,
    });
  if (!canMarkThreadDone(thread, { now: options.now, handedBackCompletionSeen })) return false;
  const lastActivityAt = resolveDoneTimestamp(thread, null);
  const overrideIsStale =
    override != null &&
    lastActivityAt !== null &&
    Date.parse(lastActivityAt) > Date.parse(override.at);
  if (override != null && !overrideIsStale) {
    return override.state === "done";
  }
  if (thread.pinnedAt !== null) return false;
  if (childWrapUp !== null && (handedBackCompletionSeen || childWrapUp.parentDone)) {
    return true;
  }
  if (
    isFiledByPullRequest(thread, override, options.pullRequestSettledAt) &&
    !hasUnseenCompletion(thread)
  ) {
    return true;
  }
  if (options.autoDoneAfterDays == null) return false;
  if (hasUnseenCompletion(thread)) return false;
  if (lastActivityAt === null) return false;
  return Date.parse(lastActivityAt) < Date.parse(options.now) - options.autoDoneAfterDays * DAY_MS;
}

/**
 * Whether a landed pull request is the last word on the thread. The user's own
 * later moves outrank it: a message sent after the landing, or an explicit
 * "keep active" given after it, even one that later activity has made stale
 * for the override rule above.
 */
function isFiledByPullRequest(
  thread: DoneSortInput,
  override: ThreadDoneOverride | null | undefined,
  settledAt: string | null | undefined,
): boolean {
  if (settledAt == null) return false;
  const settledMs = Date.parse(settledAt);
  if (Number.isNaN(settledMs)) return false;
  if (override?.state === "active" && Date.parse(override.at) >= settledMs) return false;
  const userSpokeAt = thread.latestUserMessageAt ?? thread.latestTurn?.requestedAt ?? null;
  if (userSpokeAt === null) return true;
  const userSpokeMs = Date.parse(userSpokeAt);
  return Number.isNaN(userSpokeMs) || userSpokeMs <= settledMs;
}

/**
 * Pins are a deliberate, stable group at the top. Everything else tracks the
 * user's latest message rather than background agent activity.
 */
export function sortInboxThreads<
  T extends Pick<Thread, "id"> & ThreadSortInput & { readonly pinnedAt: string | null },
>(threads: readonly T[]): T[] {
  const pinned = threads
    .filter((thread) => thread.pinnedAt !== null)
    .toSorted((left, right) => {
      const byPin =
        (toSortableTimestamp(right.pinnedAt ?? undefined) ?? 0) -
        (toSortableTimestamp(left.pinnedAt ?? undefined) ?? 0);
      if (byPin !== 0) return byPin;

      const byCreated =
        (toSortableTimestamp(right.createdAt) ?? 0) - (toSortableTimestamp(left.createdAt) ?? 0);
      return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
    });
  const unpinned = sortThreads(threads.filter((thread) => thread.pinnedAt === null));

  return [...pinned, ...unpinned];
}

type DoneSortInput = Pick<
  SidebarThreadSummary,
  "latestUserMessageAt" | "latestTurn" | "updatedAt" | "createdAt"
>;

/**
 * Done rows are history, so they order by when the work ended: the explicit
 * mark when there is one, else the thread's last activity. Label and order
 * both come from here so they can never disagree.
 */
export function resolveDoneTimestamp(
  thread: DoneSortInput,
  override: ThreadDoneOverride | null | undefined,
): string | null {
  if (override?.state === "done" && !Number.isNaN(Date.parse(override.at))) {
    return override.at;
  }
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ]) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed) && parsed > latestMs) {
      latest = candidate;
      latestMs = parsed;
    }
  }
  return latest ?? thread.updatedAt ?? thread.createdAt;
}

export function sortDoneThreads<T extends DoneSortInput & { readonly id: string }>(
  threads: readonly T[],
  overrideFor: (thread: T) => ThreadDoneOverride | null | undefined,
): T[] {
  const timestampMs = (thread: T) => {
    const timestamp = resolveDoneTimestamp(thread, overrideFor(thread));
    return timestamp === null ? 0 : (toSortableTimestamp(timestamp) ?? 0);
  };
  return [...threads].toSorted(
    (left, right) => timestampMs(right) - timestampMs(left) || left.id.localeCompare(right.id),
  );
}

// ── Project scope ────────────────────────────────────────────────────

export interface ProjectScopeOption {
  readonly key: string;
  readonly label: string;
  /** Threads in this project blocked on the user, shown beside its name. */
  readonly needsYouCount: number;
}

/**
 * The scope menu's projects, most-recently-active first.
 *
 * A menu has room for all of them, so ordering is the whole job: whatever you
 * touched last sits under the cursor when the menu opens.
 */
export function buildProjectScopeOptions(input: {
  readonly projects: ReadonlyArray<{ readonly key: string; readonly label: string }>;
  readonly lastActivityMsByKey: ReadonlyMap<string, number>;
  readonly needsYouCountByKey: ReadonlyMap<string, number>;
}): ProjectScopeOption[] {
  return [...input.projects]
    .toSorted(
      (left, right) =>
        (input.lastActivityMsByKey.get(right.key) ?? 0) -
          (input.lastActivityMsByKey.get(left.key) ?? 0) || left.label.localeCompare(right.label),
    )
    .map((project) => ({
      key: project.key,
      label: project.label,
      needsYouCount: input.needsYouCountByKey.get(project.key) ?? 0,
    }));
}

/**
 * Which live rows show while the list is folded.
 *
 * The live list keeps every thread, but only the first few quiet ones are
 * worth screen space at rest -- a dev session mints a dozen threads a day and
 * a wall of two-line rows buries the ones that matter. Rows with a status are
 * exempt from the fold entirely: hiding a pending approval behind "show more"
 * defeats the approval, and hiding running work hides where its result will
 * land. Pinned rows always show and take no seat from the limit: a pin says
 * "keep this in view", not "hide something else". Order is never changed,
 * only membership.
 */
export function windowInboxThreads<T>(input: {
  readonly rows: readonly T[];
  readonly hasAttention: (row: T) => boolean;
  readonly isPinned: (row: T) => boolean;
  readonly limit: number;
  readonly expanded: boolean;
}): { readonly visible: T[]; readonly hiddenCount: number } {
  if (input.expanded) {
    return { visible: [...input.rows], hiddenCount: 0 };
  }
  let seatsTaken = 0;
  const visible = input.rows.filter((row) => {
    if (input.isPinned(row)) return true;
    seatsTaken += 1;
    return seatsTaken <= input.limit || input.hasAttention(row);
  });
  return { visible, hiddenCount: input.rows.length - visible.length };
}

// ── Child thread families ────────────────────────────────────────────
//
// A thread whose agent started threads of its own heads a family: the parent
// plus the children still attached to it (docs/design/child-threads.md). The
// inbox shows a family as one row with a summary line that opens in place,
// so an agent that starts five threads costs the list one seat, not six.

/** What the family rules read about each inbox thread. */
export interface InboxFamilyEntry {
  readonly threadKey: string;
  readonly thread: Pick<SidebarThreadSummary, "id" | "createdAt">;
  readonly status: ThreadStatusPill | null;
  readonly isDone: boolean;
}

/** One live row: a thread, the family it heads, and what shows under it. */
export interface InboxLiveRow<E extends InboxFamilyEntry> {
  readonly entry: E;
  /** The threads in its family, oldest first; empty unless it is a parent. */
  readonly children: readonly E[];
  /** The children drawn under it: all of them while open, else only those
   *  that need the user and the one open in the chat. */
  readonly shownChildren: readonly E[];
  /** A live child whose parent is wrapped stands on its own, naming the parent. */
  readonly wrappedParent: E | null;
}

/** One wrapped row: a thread, and the threads its family had. */
export interface InboxDoneRow<E extends InboxFamilyEntry> {
  readonly entry: E;
  /** Its attached children, oldest first: the wrapped ones live inside it. */
  readonly children: readonly E[];
  /** A wrapped child of this wrapped parent that is open in the chat. */
  readonly openChild: E | null;
}

const NEEDS_YOU_NOW: ReadonlySet<ThreadStatusPill["label"]> = new Set([
  "Pending Approval",
  "Awaiting Input",
]);

/** A child that is waiting on the user's answer: never folded out of sight. */
export function isChildThreadNeedingYou(entry: InboxFamilyEntry): boolean {
  return !entry.isDone && entry.status !== null && NEEDS_YOU_NOW.has(entry.status.label);
}

const IN_FLIGHT: ReadonlySet<ThreadStatusPill["label"]> = new Set([
  "Working",
  "Starting",
  "Answering",
  "Waiting",
]);

/** A child with work in flight: what "Stop N working threads" stops. */
export function isChildThreadWorking(entry: InboxFamilyEntry): boolean {
  return !entry.isDone && entry.status !== null && IN_FLIGHT.has(entry.status.label);
}

/**
 * Lays the inbox out in families. `parentKeyOf` names the parent a thread is
 * attached to, whether or not it is in the list; a thread whose parent is not
 * (archived, deleted) stands on its own. Scope is decided by the family's
 * parent, so children always travel with it. The live and wrapped orders come
 * from the caller's sorts, applied to the rows that stand on their own;
 * children keep creation order and are never re-sorted.
 */
export function buildInboxSections<E extends InboxFamilyEntry>(input: {
  readonly entries: readonly E[];
  readonly parentKeyOf: (entry: E) => string | null;
  readonly inScope: (entry: E) => boolean;
  readonly isFamilyOpen: (parentKey: string) => boolean;
  readonly activeThreadKey: string | null;
  readonly sortLive: (entries: readonly E[]) => E[];
  readonly sortDone: (entries: readonly E[]) => E[];
}): { readonly live: InboxLiveRow<E>[]; readonly done: InboxDoneRow<E>[] } {
  const entryByKey = new Map(input.entries.map((entry) => [entry.threadKey, entry] as const));
  const parentOf = (entry: E): E | null => {
    const parentKey = input.parentKeyOf(entry);
    if (parentKey === null || parentKey === entry.threadKey) return null;
    return entryByKey.get(parentKey) ?? null;
  };
  const childrenByParentKey = new Map<string, E[]>();
  for (const entry of input.entries) {
    const parent = parentOf(entry);
    if (parent === null) continue;
    const siblings = childrenByParentKey.get(parent.threadKey) ?? [];
    siblings.push(entry);
    childrenByParentKey.set(parent.threadKey, siblings);
  }
  for (const siblings of childrenByParentKey.values()) {
    siblings.sort(
      (left, right) =>
        (toSortableTimestamp(left.thread.createdAt) ?? 0) -
          (toSortableTimestamp(right.thread.createdAt) ?? 0) ||
        left.thread.id.localeCompare(right.thread.id),
    );
  }

  const liveHeads: E[] = [];
  const doneHeads: E[] = [];
  const wrappedParentByKey = new Map<string, E>();
  for (const entry of input.entries) {
    const parent = parentOf(entry);
    if (parent === null) {
      if (!input.inScope(entry)) continue;
      (entry.isDone ? doneHeads : liveHeads).push(entry);
      continue;
    }
    // In a live family, or inside its wrapped parent: not a row of its own.
    if (!parent.isDone || entry.isDone) continue;
    if (!input.inScope(parent)) continue;
    liveHeads.push(entry);
    wrappedParentByKey.set(entry.threadKey, parent);
  }

  const live = input.sortLive(liveHeads).map((entry): InboxLiveRow<E> => {
    const wrappedParent = wrappedParentByKey.get(entry.threadKey) ?? null;
    const children = wrappedParent === null ? (childrenByParentKey.get(entry.threadKey) ?? []) : [];
    const shownChildren = input.isFamilyOpen(entry.threadKey)
      ? children
      : children.filter(
          (child) => isChildThreadNeedingYou(child) || child.threadKey === input.activeThreadKey,
        );
    return { entry, children, shownChildren, wrappedParent };
  });
  const done = input.sortDone(doneHeads).map((entry): InboxDoneRow<E> => {
    const children = childrenByParentKey.get(entry.threadKey) ?? [];
    return {
      entry,
      children,
      openChild:
        children.find((child) => child.isDone && child.threadKey === input.activeThreadKey) ?? null,
    };
  });
  return { live, done };
}

/** Whether a live row earns a seat past the fold: it or a live child shows a status. */
export function inboxLiveRowHasAttention(row: InboxLiveRow<InboxFamilyEntry>): boolean {
  return (
    row.entry.status !== null ||
    row.children.some((child) => !child.isDone && child.status !== null)
  );
}

/**
 * Whether a live row's family holds the thread open in the chat. Such a row
 * never folds away: opening a quiet or wrapped child must not hide the whole
 * family it sits in.
 */
export function inboxLiveRowHoldsOpenChild(
  row: InboxLiveRow<InboxFamilyEntry>,
  activeThreadKey: string | null,
): boolean {
  return (
    activeThreadKey !== null && row.children.some((child) => child.threadKey === activeThreadKey)
  );
}

/**
 * The Wrapped rows shown at rest: the first `limit`, plus any wrapped family
 * past them that holds the thread open in the chat. Order never changes.
 */
export function windowInboxDoneRows<E extends InboxFamilyEntry>(
  rows: readonly InboxDoneRow<E>[],
  limit: number,
): InboxDoneRow<E>[] {
  return rows.filter((row, index) => index < limit || row.openChild !== null);
}

/** The thread keys of the rows a live row draws, in order: it, then its shown children. */
export function inboxLiveRowThreadKeys(row: InboxLiveRow<InboxFamilyEntry>): string[] {
  return [row.entry.threadKey, ...row.shownChildren.map((child) => child.threadKey)];
}

/** Dots past this fold into "+N". */
export const CHILD_THREAD_SUMMARY_DOT_LIMIT = 8;

/** A family's summary line: a dot per child, then what matters most. */
export interface ChildThreadsSummary {
  readonly count: number;
  /** Each shown child's status dot class; null draws it grey (finished or wrapped). */
  readonly dots: ReadonlyArray<string | null>;
  readonly hiddenDotCount: number;
  /** The one count the line names after "N threads"; null when all are finished. */
  readonly highlight: {
    readonly kind: "needs-you" | "failed" | "working";
    readonly count: number;
  } | null;
}

export function summarizeChildThreads(
  children: ReadonlyArray<InboxFamilyEntry>,
): ChildThreadsSummary {
  const dotOf = (child: InboxFamilyEntry) =>
    child.isDone || child.status === null ? null : child.status.dotClass;
  const needsYou = children.filter(isChildThreadNeedingYou).length;
  const failed = children.filter(
    (child) => !child.isDone && child.status?.label === "Failed",
  ).length;
  const working = children.filter(isChildThreadWorking).length;
  return {
    count: children.length,
    dots: children.slice(0, CHILD_THREAD_SUMMARY_DOT_LIMIT).map(dotOf),
    hiddenDotCount: Math.max(0, children.length - CHILD_THREAD_SUMMARY_DOT_LIMIT),
    highlight:
      needsYou > 0
        ? { kind: "needs-you", count: needsYou }
        : failed > 0
          ? { kind: "failed", count: failed }
          : working > 0
            ? { kind: "working", count: working }
            : null,
  };
}

/** "3 threads", "1 thread". */
export function formatChildThreadCount(count: number): string {
  return `${count} ${count === 1 ? "thread" : "threads"}`;
}

/** The highlight's words: "1 needs you", "2 failed", "3 working". */
export function formatChildThreadsHighlight(
  highlight: NonNullable<ChildThreadsSummary["highlight"]>,
): string {
  switch (highlight.kind) {
    case "needs-you":
      return `${highlight.count} needs you`;
    case "failed":
      return `${highlight.count} failed`;
    case "working":
      return `${highlight.count} working`;
  }
}

/** The summary line as text: "3 threads · 1 needs you", or "3 threads finished". */
export function childThreadsSummaryText(summary: ChildThreadsSummary): string {
  const count = formatChildThreadCount(summary.count);
  return summary.highlight === null
    ? `${count} finished`
    : `${count} · ${formatChildThreadsHighlight(summary.highlight)}`;
}

/** A parent's hover card line: "Threads: 3 · 1 needs you", or "Threads: 3". */
export function childThreadsHoverLine(summary: ChildThreadsSummary): string {
  return summary.highlight === null
    ? `Threads: ${summary.count}`
    : `Threads: ${summary.count} · ${formatChildThreadsHighlight(summary.highlight)}`;
}
