import * as React from "react";
import type {
  AgentThreadStatusWord,
  EnvironmentId,
  RemoteChildRequestStatus,
  FamilyRemoteChild,
  RemoteThreadFiling,
  ScopedThreadRef,
  ThreadId,
} from "@threadlines/contracts";
import type { SidebarProjectSortOrder } from "@threadlines/contracts/settings";
import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import {
  getThreadInFlightStatus,
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "../lib/threadSort";
import type { SidebarThreadSummary, Thread } from "../types";
import { isLatestTurnSettled, isWaitingOnBackgroundTasks } from "../session-logic";
import { startOfLocalDayMs } from "../timestampFormat";
import { nextCheckBack } from "./chat/checkBacks";
import { isHandedBackCompletion } from "@threadlines/shared/childThreads";
import {
  hasUnseenCompletion as hasUnseenCompletionSince,
  hasUnseenSessionFailure as hasUnseenSessionFailureSince,
  threadLastActivityAt,
} from "@threadlines/shared/threadFiling";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 100;
// The top sidebar rows are prewarmed into the thread-detail cache, one at a
// time while the page is idle, so opening one usually reuses a hot
// subscription. Other rows warm when the pointer rests on them.
export const SIDEBAR_THREAD_PREWARM_LIMIT = 3;
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
    | "Checking back"
    | "Continues at reset"
    | "Failed";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
  /**
   * "Waiting" on the threads its agent started rather than on its own
   * background work: how many still owe it an answer.
   */
  childThreadCount?: number;
  /** "Checking back": when the soonest check-back fires. "Continues at reset": when it continues. */
  checkBackAt?: string;
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
  | "pendingScheduleApproval"
  | "awaitedChildThreadCount"
  | "checkBacks"
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
  return hasUnseenCompletionSince(thread, thread.lastVisitedAt);
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

/**
 * What the sidebar prewarms while the page is idle, in order: the open
 * thread's neighbours first (previous/next traversal lands there), then the
 * top rows. The open thread itself already loads as the foreground.
 */
export function getSidebarIdlePrewarmThreadIds<TThreadId>(input: {
  traversalThreadIds: readonly TThreadId[];
  activeThreadId: TThreadId | null;
  limit?: number;
}): TThreadId[] {
  const { activeThreadId, traversalThreadIds } = input;
  const neighbours =
    activeThreadId === null
      ? []
      : (["previous", "next"] as const).map((direction) =>
          resolveAdjacentThreadId({
            threadIds: traversalThreadIds,
            currentThreadId: activeThreadId,
            direction,
          }),
        );
  const ordered = [...neighbours, ...getSidebarThreadIdsToPrewarm(traversalThreadIds, input.limit)];
  return [
    ...new Set(ordered.filter((id): id is TThreadId => id !== null && id !== activeThreadId)),
  ];
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

  // Threads its agent asked to start, and scheduled tasks it asked to create
  // or change, wait for the user's yes like any other approval: blocking,
  // and never wrapped away.
  if (
    thread.hasPendingApprovals ||
    thread.pendingChildApproval === true ||
    thread.pendingScheduleApproval === true
  ) {
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

  // A usage limit stopped it and it continues once the limit resets: the row
  // says when, like an agent checking back, not that it failed.
  const continueAt = thread.session?.continueAtReset?.at ?? null;
  if (continueAt !== null) {
    return {
      label: "Continues at reset",
      colorClass: "text-cyan-600 dark:text-cyan-300/90",
      dotClass: THREAD_STATUS_DOT_CLASSES.cyan,
      pulse: false,
      checkBackAt: continueAt,
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

  // Settled, and an agent set itself to come back: the row says when, not
  // when it was last at work.
  const checkBack = nextCheckBack(thread.checkBacks);
  if (checkBack !== null && isLatestTurnSettled(thread.latestTurn, thread.session)) {
    return {
      label: "Checking back",
      colorClass: "text-cyan-600 dark:text-cyan-300/90",
      dotClass: THREAD_STATUS_DOT_CLASSES.cyan,
      pulse: false,
      checkBackAt: checkBack.scheduledFor,
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

/** Where a list learns when each thread was last seen: the ui state store's two maps. */
export interface ThreadSeenSources {
  readonly seenThreadOverlays: Readonly<Record<string, { readonly at: string }>>;
  readonly threadSeedVisitedAtById: Readonly<Record<string, string>>;
}

/**
 * A thread's status the way every list shows it, and when the user last saw
 * it. A finished turn reads as new until it has been seen, on this device or
 * another, so a list that skipped the visit would call every chat unread.
 */
export function resolveSeenThreadStatus(
  thread: ThreadStatusInput & { readonly lastSeenAt?: string | null | undefined },
  threadKey: string,
  sources: ThreadSeenSources,
): { readonly lastVisitedAt: string | undefined; readonly status: ThreadStatusPill | null } {
  const lastVisitedAt = mergeThreadLastSeenAt({
    overlayAt: sources.seenThreadOverlays[threadKey]?.at,
    serverLastSeenAt: thread.lastSeenAt,
    seedAt: sources.threadSeedVisitedAtById[threadKey],
  });
  const status = resolveThreadStatusPill({
    thread: { ...thread, ...(lastVisitedAt !== undefined ? { lastVisitedAt } : {}) },
  });
  return { lastVisitedAt, status };
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
  | "pendingScheduleApproval"
  | "awaitedChildThreadCount"
  | "handedBackTurnId"
  | "queuedFollowUpCount"
  | "checkBacks"
> & {
  lastVisitedAt?: string | undefined;
};

function hasUnseenSessionFailure(thread: InboxLifecycleInput): boolean {
  return hasUnseenSessionFailureSince(thread, thread.lastVisitedAt);
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
  return resolveThreadSeenAt(input.overlayAt, input.serverLastSeenAt) ?? input.seedAt ?? undefined;
}

/**
 * When the user surely saw a thread: a visit this device has sent, else the
 * server's stamp. Without the seed, which is this device's guess for threads
 * the server never recorded a visit for, made again on every load: it keeps
 * a fresh load from calling everything unread, but is no proof of a visit.
 */
export function resolveThreadSeenAt(
  overlayAt: string | undefined,
  serverLastSeenAt: string | null | undefined,
): string | undefined {
  return overlayAt ?? serverLastSeenAt ?? undefined;
}

/**
 * The user's word on a thread while it still stands: one older than the
 * thread's last activity is stale, since new work outranks an old word.
 */
export function freshThreadDoneOverride(
  thread: DoneSortInput,
  override: ThreadDoneOverride | null | undefined,
): ThreadDoneOverride | null {
  if (override == null) return null;
  const lastActivityAt = resolveDoneTimestamp(thread, null);
  return lastActivityAt !== null && Date.parse(lastActivityAt) > Date.parse(override.at)
    ? null
    : override;
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
  return fileByFacts(
    {
      held: () => !canMarkThreadDone(thread, { now: options.now, handedBackCompletionSeen }),
      freshOverride: () => freshThreadDoneOverride(thread, override),
      pinned: thread.pinnedAt !== null,
      childFinished: childWrapUp !== null && (handedBackCompletionSeen || childWrapUp.parentDone),
      filedByPullRequest: () =>
        isFiledByPullRequest(thread, override, options.pullRequestSettledAt),
      unseenCompletion: () => hasUnseenCompletion(thread),
      lastActivityAt: () => resolveDoneTimestamp(thread, null),
    },
    options,
  );
}

/**
 * What the wrap-up rules weigh ({@link isThreadDone}), however a thread's
 * facts were found: from its summary for a thread this app has, or from what
 * its computer says for a child this app can't see ({@link isRemoteChildDone}).
 * Costlier facts are read only when their rule is reached.
 */
interface FilingFacts {
  /** Rule 1: moving, blocked on the user, queued, or unread work it can't be filed with. */
  readonly held: () => boolean;
  /** Rule 2: the user's word, while it is fresher than the thread's last activity. */
  readonly freshOverride: () => ThreadDoneOverride | null;
  /** Rule 3. */
  readonly pinned: boolean;
  /** Rule 4: a child whose work for its parent is over (its answer went back, or the parent wrapped). */
  readonly childFinished: boolean;
  /** Rule 5: its pull request landed, and the user hasn't spoken since. */
  readonly filedByPullRequest: () => boolean;
  readonly unseenCompletion: () => boolean;
  /** Rule 6's clock. */
  readonly lastActivityAt: () => string | null;
}

function fileByFacts(
  facts: FilingFacts,
  options: { readonly now: string; readonly autoDoneAfterDays?: number | null },
): boolean {
  if (facts.held()) return false;
  const freshOverride = facts.freshOverride();
  if (freshOverride !== null) {
    return freshOverride.state === "done";
  }
  if (facts.pinned) return false;
  if (facts.childFinished) return true;
  if (facts.filedByPullRequest() && !facts.unseenCompletion()) return true;
  if (options.autoDoneAfterDays == null) return false;
  if (facts.unseenCompletion()) return false;
  const lastActivityAt = facts.lastActivityAt();
  if (lastActivityAt === null) return false;
  return Date.parse(lastActivityAt) < Date.parse(options.now) - options.autoDoneAfterDays * DAY_MS;
}

/**
 * The same rules for a child on a computer this app can't see, read from
 * what that computer says (`RemoteThreadFiling`), so it files here as it
 * does there: moving, blocked on the user or waiting holds it, and so does a
 * failure the user hasn't opened, or a finished turn that didn't go back to
 * the parent; then the user's word (given there, or here and sent on), a pin
 * there, its answer having reached the parent, and sitting idle. Waiting to
 * start again (a check-back, a usage reset, a queued message) holds it too.
 * A Wrap up given here also marks it seen there (`peer.thread.wrap`), the
 * visit a child here gets before it can be wrapped, so until that computer
 * has it (`unsentWordHere`) it outranks what is unread there. Archived or
 * deleted there, it is done. A link this computer no
 * longer has to that one (`linked` false) means nothing more will come of
 * it, so only the user's word decides.
 */
export function isRemoteChildDone(input: {
  readonly phase: AgentThreadStatusWord;
  readonly filing: RemoteThreadFiling;
  /** The freshest of the word given here and the one given there. */
  readonly override: ThreadDoneOverride | null;
  /** That word was given here and that computer doesn't have it yet. */
  readonly unsentWordHere: boolean;
  readonly linked: boolean;
  readonly now: string;
  readonly wrapUpOnFinish: boolean;
  readonly autoDoneAfterDays: number | null;
}): boolean {
  const { filing } = input;
  if (filing.archived) return true;
  if (!input.linked) return input.override?.state === "done";
  const handedBackSeen = input.wrapUpOnFinish && filing.handedBackAt !== null;
  const freshOverride = () => {
    const override = input.override;
    if (override === null) return null;
    return Date.parse(filing.lastActivityAt) > Date.parse(override.at) ? null : override;
  };
  // A failure holds it until seen, handed back or not; a finished turn only
  // when its answer didn't go back.
  const unseenHolds = filing.unseen && (input.phase === "failed" || !handedBackSeen);
  return fileByFacts(
    {
      held: () =>
        isRemoteChildHeld(input.phase, filing) ||
        (unseenHolds && !(input.unsentWordHere && freshOverride()?.state === "done")),
      freshOverride,
      pinned: filing.pinned,
      childFinished: handedBackSeen,
      filedByPullRequest: () => false,
      unseenCompletion: () => filing.unseen,
      lastActivityAt: () => filing.lastActivityAt,
    },
    { now: input.now, autoDoneAfterDays: input.autoDoneAfterDays },
  );
}

/** A child's status words that keep it in front of the user, whatever was said. */
const REMOTE_HELD_PHASES: ReadonlySet<string> = new Set(["working", "needs the user", "waiting"]);

/** Moving, blocked on the user, or bound to start again: no word files it away. */
function isRemoteChildHeld(phase: string, filing: RemoteThreadFiling | undefined): boolean {
  return REMOTE_HELD_PHASES.has(phase) || filing?.waiting === true;
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

/** One inbox thread as every list reads it: seen-aware status, and Active or Wrapped. */
export interface FiledInboxThread {
  readonly thread: SidebarThreadSummary;
  readonly threadKey: string;
  readonly lastVisitedAt: string | undefined;
  /**
   * When the user surely saw it: a visit this device sent, or the server's
   * stamp. Never this device's first-load guess, which `lastVisitedAt` falls
   * back on and every load makes again.
   */
  readonly seenAt: string | undefined;
  readonly status: ThreadStatusPill | null;
  readonly override: ThreadDoneOverride | null;
  readonly isDone: boolean;
}

/**
 * Files each inbox thread under Active or Wrapped by {@link isThreadDone}. A
 * child's wrap-up reads its parent's, so each answer is worked out once and
 * parents are asked first. Families are one level deep; `visiting` only
 * guards against a loop the server should never let happen.
 */
export function fileInboxThreads(input: {
  readonly threads: readonly SidebarThreadSummary[];
  readonly seenSources: ThreadSeenSources;
  /** This device's filings not yet confirmed, by scoped thread key. */
  readonly doneOverlays: Readonly<Record<string, ThreadDoneOverride>>;
  readonly now: string;
  /** The "wrap up finished child threads" setting. */
  readonly wrapUpChildThreadsOnFinish: boolean;
  /** The "wrap up idle threads" setting: off, nothing files itself for sitting still. */
  readonly wrapUpIdleThreads: boolean;
  /** When the thread's pull requests landed, if a landing should file it; null otherwise. */
  readonly pullRequestSettledAt: (thread: SidebarThreadSummary, threadKey: string) => string | null;
}): FiledInboxThread[] {
  const prepared = input.threads.map((thread) => {
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const { lastVisitedAt, status } = resolveSeenThreadStatus(thread, threadKey, input.seenSources);
    const seenAt = resolveThreadSeenAt(
      input.seenSources.seenThreadOverlays[threadKey]?.at,
      thread.lastSeenAt,
    );
    const override = mergeThreadDoneOverride(input.doneOverlays[threadKey], thread.doneOverride);
    return { thread, threadKey, lastVisitedAt, seenAt, status, override };
  });
  const preparedByKey = new Map(prepared.map((item) => [item.threadKey, item] as const));
  const doneByKey = new Map<string, boolean>();
  const resolveDone = (item: (typeof prepared)[number], visiting: ReadonlySet<string>): boolean => {
    const known = doneByKey.get(item.threadKey);
    if (known !== undefined) return known;
    // A child on another computer wraps with its parent like any other.
    const parentKey = input.wrapUpChildThreadsOnFinish ? familyParentKeyOf(item.thread) : null;
    const parent = parentKey === null ? undefined : preparedByKey.get(parentKey);
    const childWrapUp =
      parentKey === null
        ? null
        : {
            parentDone:
              parent !== undefined && !visiting.has(parent.threadKey)
                ? resolveDone(parent, new Set([...visiting, item.threadKey]))
                : false,
          };
    const isDone = isThreadDone(
      { ...item.thread, lastVisitedAt: item.lastVisitedAt },
      item.override,
      {
        now: input.now,
        autoDoneAfterDays: input.wrapUpIdleThreads ? INBOX_AUTO_DONE_AFTER_DAYS : null,
        pullRequestSettledAt: input.pullRequestSettledAt(item.thread, item.threadKey),
        childWrapUp,
      },
    );
    doneByKey.set(item.threadKey, isDone);
    return isDone;
  };
  return prepared.map((item) => ({ ...item, isDone: resolveDone(item, new Set()) }));
}

/** Statuses a finished turn can leave behind: a result, a plan to review, or a failure. */
const FINISHED_WORK_LABELS: ReadonlySet<ThreadStatusPill["label"]> = new Set([
  "Completed",
  "Plan Ready",
  "Failed",
]);

/**
 * Finished work the user has not opened yet, still in front of them: the
 * count the Dock and taskbar show. Work still moving or waiting on its own
 * threads is not finished, and a child thread wrapped up with its family (its
 * answer went back to the parent, or the parent was wrapped) needs no visit.
 */
export function isUnreadFinishedWork(entry: {
  readonly thread: Pick<SidebarThreadSummary, "latestTurn">;
  readonly status: ThreadStatusPill | null;
  readonly lastVisitedAt: string | undefined;
  readonly isDone: boolean;
}): boolean {
  if (entry.isDone || entry.status === null) return false;
  if (!FINISHED_WORK_LABELS.has(entry.status.label)) return false;
  return hasUnseenCompletion({
    latestTurn: entry.thread.latestTurn,
    lastVisitedAt: entry.lastVisitedAt,
  });
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
  return threadLastActivityAt(thread);
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
 * The projects the list is actually narrowed to, in the order they were
 * picked; empty is All projects.
 *
 * A picked project lapses rather than pinning the list to nothing: one removed
 * since, or one with no checkout on the scoped machine (the two scopes compose
 * as an intersection), drops out, and with none left the list is unscoped.
 */
export function resolveScopedProjectKeys(input: {
  readonly pickedKeys: readonly string[];
  readonly projectByKey: ReadonlyMap<
    string,
    { readonly memberProjects: ReadonlyArray<{ readonly environmentId: string }> }
  >;
  readonly scopedEnvironmentId: string | null;
}): string[] {
  return input.pickedKeys.filter((key) => {
    const project = input.projectByKey.get(key);
    return (
      project !== undefined &&
      (input.scopedEnvironmentId === null ||
        project.memberProjects.some((member) => member.environmentId === input.scopedEnvironmentId))
    );
  });
}

/**
 * Where the new-thread button starts while the list is scoped to projects.
 *
 * It stays inside the scope: a thread or draft open in a picked project keeps
 * its project ("follow"), and otherwise the first project picked wins --
 * filtering and then getting a thread somewhere else reads as the button
 * ignoring you. The default project is not somewhere you are, so it never
 * outranks the pick order. A project grouped across checkouts starts on the
 * scoped machine, else this device, else its first checkout. Unscoped, the
 * button follows as it always has.
 */
export function resolveScopedComposeTarget<
  Member extends { readonly environmentId: string },
>(input: {
  readonly scopedProjectKeys: readonly string[];
  /** The logical key of the project whose thread or draft is open, if any. */
  readonly openProjectKey: string | null;
  readonly projectByKey: ReadonlyMap<string, { readonly memberProjects: readonly Member[] }>;
  readonly scopedEnvironmentId: string | null;
  readonly primaryEnvironmentId: string | null;
}): { readonly kind: "follow" } | { readonly kind: "member"; readonly member: Member } {
  const firstScopedKey = input.scopedProjectKeys[0];
  if (
    firstScopedKey === undefined ||
    (input.openProjectKey !== null && input.scopedProjectKeys.includes(input.openProjectKey))
  ) {
    return { kind: "follow" };
  }
  const members = input.projectByKey.get(firstScopedKey)?.memberProjects ?? [];
  const member =
    members.find((candidate) => candidate.environmentId === input.scopedEnvironmentId) ??
    members.find((candidate) => candidate.environmentId === input.primaryEnvironmentId) ??
    members[0];
  return member === undefined ? { kind: "follow" } : { kind: "member", member };
}

/** Adds a project to the scope, or takes it out when it is already in. */
export function toggleProjectScopeKey(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((picked) => picked !== key) : [...keys, key];
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

/**
 * The key of the thread this one is still attached to (child threads), in
 * the same environment; null for a thread no other thread started, or one
 * made its own. What the server's own family commands (separate, stop its
 * threads, delete with its threads) act on.
 */
export function attachedParentKeyOf(
  thread: Pick<SidebarThreadSummary, "environmentId" | "parentThreadId" | "attachedToParent">,
): string | null {
  return thread.attachedToParent === true && thread.parentThreadId != null
    ? scopedThreadKey(scopeThreadRef(thread.environmentId, thread.parentThreadId))
    : null;
}

/**
 * The key of the family a thread sits in: its attached parent on its own
 * computer, or the thread on another computer whose agent started it there
 * (`remoteOrigin`). Keys are environment-scoped, so a family can span two
 * computers (docs/design/fleet.md, Part 5).
 */
export function familyParentKeyOf(
  thread: Pick<
    SidebarThreadSummary,
    "environmentId" | "parentThreadId" | "attachedToParent" | "remoteOrigin"
  >,
): string | null {
  const remoteOrigin = thread.remoteOrigin ?? null;
  return remoteOrigin === null
    ? attachedParentKeyOf(thread)
    : scopedThreadKey(scopeThreadRef(remoteOrigin.environmentId, remoteOrigin.threadId));
}

/** What a family's summary and counts read about each of its threads. */
export interface InboxFamilyStatus {
  readonly status: ThreadStatusPill | null;
  readonly isDone: boolean;
}

/** What decides when a wrapped child leaves its live parent's family ({@link hasLeftLiveFamily}). */
export interface InboxFamilyExit extends InboxFamilyStatus {
  /** When its work last moved: what the user must have seen for it to go. */
  readonly settledAt: string | null;
  /** When the user surely saw it (`FiledInboxThread.seenAt`); absent for a child this app can't open. */
  readonly seenAt?: string | undefined;
  /**
   * When its answer last reached the parent (handed back). Background work
   * can deliver a turn well after it ended, and a parent seen before the
   * delivery has not shown that answer.
   */
  readonly deliveredAt?: string | null | undefined;
  /** The user wrapped it themselves, not a wrap-up rule. */
  readonly wrappedByUser?: boolean | undefined;
}

/** What the family rules read about each inbox thread. */
export interface InboxFamilyEntry extends InboxFamilyExit {
  readonly threadKey: string;
  readonly thread: Pick<SidebarThreadSummary, "id" | "createdAt">;
  readonly seenAt: string | undefined;
  readonly wrappedByUser: boolean;
}

/**
 * Whether a wrapped child has left its live parent's family for Wrapped,
 * where it stands on its own and names the parent. Finished children
 * otherwise pile up under a parent still in use, for as long as it lives.
 * The user wrapping it is their word, so it goes at once. One that wrapped
 * itself (its answer went back, its pull request landed, it sat idle) stays
 * until the user has seen what it finished, so coming back still shows
 * "1 thread finished" under the parent: in the child, or in a parent turn
 * that ended after its answer reached the parent (seen stamps are turn
 * completions, and a handed-back answer starts one). It waits no longer than
 * a quiet thread waits in the live list, so a parent that never ran again
 * cannot hold it there.
 */
export function hasLeftLiveFamily(
  child: InboxFamilyExit,
  parent: { readonly seenAt: string | undefined },
  now: string,
): boolean {
  if (!child.isDone) return false;
  if (child.wrappedByUser === true) return true;
  const settledMs = child.settledAt === null ? Number.NaN : Date.parse(child.settledAt);
  if (Number.isNaN(settledMs)) return true;
  if (settledMs < Date.parse(now) - INBOX_AUTO_DONE_AFTER_DAYS * DAY_MS) return true;
  const seenSince = (seenAt: string | undefined, sinceMs: number) =>
    seenAt !== undefined && Date.parse(seenAt) >= sinceMs;
  const deliveredMs = child.deliveredAt == null ? Number.NaN : Date.parse(child.deliveredAt);
  return (
    seenSince(child.seenAt, settledMs) ||
    seenSince(
      parent.seenAt,
      Number.isNaN(deliveredMs) ? settledMs : Math.max(settledMs, deliveredMs),
    )
  );
}

/**
 * Where a child on another computer stands, as its parent last heard: one of
 * that computer's status words for a thread it runs, or how far a start has
 * got before there is a thread (`RemoteChildRequestStatus`). `setting_up`:
 * a child started here whose thread isn't made yet (its worktree is cut
 * first, docs/design/thread-setup-state.md).
 */
export type InboxRemoteChildPhase = AgentThreadStatusWord | RemoteChildRequestStatus | "setting_up";

/**
 * A child in a parent's family the app has no thread for, shown from the
 * parent's own record of it: one on a computer this app can't see (its last
 * known status, or a start that has no thread there yet), or one started here
 * that is still being set up. It can't be opened: there is no thread to open,
 * so once wrapped and seen through the parent it has no row until the parent
 * wraps and holds it.
 */
export interface InboxRemoteChild extends InboxFamilyExit {
  /**
   * The key its thread would have in this app (environment-scoped), or
   * `start:<environmentId>:<requestId>` for a start with no thread yet.
   */
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  /** Null for a start with no thread there yet. */
  readonly threadId: ThreadId | null;
  /**
   * The computer it runs on, by the name this app knows it by (this
   * computer's, for one being set up here).
   */
  readonly computerLabel: string;
  readonly title: string;
  readonly phase: InboxRemoteChildPhase;
  /**
   * The user can wrap it up (or reopen it, once done) from here: a thread
   * there that nothing holds in front of them. Absent: a start, or one being
   * set up, which can't.
   */
  readonly canWrap?: boolean | undefined;
  /** The parent whose record of it a Wrap up or Reopen lands on. */
  readonly parentRef?: ScopedThreadRef | undefined;
}

/** One live row: a thread, the family it heads, and what shows under it. */
export interface InboxLiveRow<E extends InboxFamilyEntry> {
  readonly entry: E;
  /** The threads in its family, oldest first; empty unless it is a parent. */
  readonly children: readonly E[];
  /** The children drawn under it: all of them while open, else only those
   *  that need the user and the one open in the chat. */
  readonly shownChildren: readonly E[];
  /** Its family's children on computers this app can't see, after `children`. */
  readonly remoteChildren: readonly InboxRemoteChild[];
  /** The ones drawn: all while open, else only those that need the user. */
  readonly shownRemoteChildren: readonly InboxRemoteChild[];
  /** A live child whose parent is wrapped stands on its own, naming the parent. */
  readonly wrappedParent: E | null;
  /**
   * A child on another computer whose parent the machine filter hides: it
   * stands on its own, naming the parent and its computer.
   */
  readonly scopedOutParent: E | null;
}

/**
 * A child on a computer this app can't see that left its live parent's
 * family ({@link hasLeftLiveFamily}): a row of its own in Wrapped, naming
 * the parent, as a child here does.
 */
export interface InboxDoneRemoteRow<E extends InboxFamilyEntry> {
  readonly child: InboxRemoteChild;
  readonly startedBy: E;
}

/** One wrapped row: a thread, and the threads its family had. */
export interface InboxDoneRow<E extends InboxFamilyEntry> {
  readonly entry: E;
  /** Its attached children, oldest first: the wrapped ones live inside it. */
  readonly children: readonly E[];
  /** Its children on computers this app can't see; they wrap inside it too. */
  readonly remoteChildren: readonly InboxRemoteChild[];
  /** A wrapped child of this wrapped parent that is open in the chat. */
  readonly openChild: E | null;
  /**
   * The thread that started it, when it stands here apart from that thread's
   * family: it left a live parent's family, or the machine filter hides the
   * parent.
   */
  readonly startedBy: E | null;
}

const NEEDS_YOU_NOW: ReadonlySet<ThreadStatusPill["label"]> = new Set([
  "Pending Approval",
  "Awaiting Input",
]);

/** A child that is waiting on the user's answer: never folded out of sight. */
export function isChildThreadNeedingYou(entry: InboxFamilyStatus): boolean {
  return !entry.isDone && entry.status !== null && NEEDS_YOU_NOW.has(entry.status.label);
}

const IN_FLIGHT: ReadonlySet<ThreadStatusPill["label"]> = new Set([
  "Working",
  "Starting",
  "Answering",
  "Waiting",
]);

/** A child with work in flight: what "Stop N working threads" stops. */
export function isChildThreadWorking<T extends InboxFamilyStatus>(entry: T): boolean {
  return !entry.isDone && entry.status !== null && IN_FLIGHT.has(entry.status.label);
}

/** What a thread asks of the user right now, as the rail and Fleet count it. */
export type ThreadAttention = "needs-you" | "working";

/**
 * Whether a thread needs the user (an approval, a question, a failure they
 * have not seen) or has work in flight. Both hold the thread in the live list
 * whatever the wrap-up rules say, so counting them needs no Wrapped check: a
 * failure the user has seen is the one exception, and it stops counting here.
 */
export function resolveThreadAttention(
  thread: InboxLifecycleInput,
  status: ThreadStatusPill | null,
): ThreadAttention | null {
  if (status === null) return null;
  if (NEEDS_YOU_NOW.has(status.label)) return "needs-you";
  if (status.label === "Failed") return hasUnseenSessionFailure(thread) ? "needs-you" : null;
  return IN_FLIGHT.has(status.label) ? "working" : null;
}

const UNREAD_RESULTS: ReadonlySet<ThreadStatusPill["label"]> = new Set(["Completed", "Plan Ready"]);

/**
 * A result the user has not looked at yet: a finished turn they have not
 * seen, or a plan waiting to be read. Neither needs the user the way an
 * approval does, so it is said apart from the needs-you count.
 */
export function isUnreadResultStatus(status: ThreadStatusPill | null): boolean {
  return status !== null && UNREAD_RESULTS.has(status.label);
}

/** How many threads need the user and how many are working. */
export interface ThreadAttentionCounts {
  readonly needsYou: number;
  readonly working: number;
}

export const NO_THREAD_ATTENTION: ThreadAttentionCounts = { needsYou: 0, working: 0 };

export function countThreadAttention(
  attentions: Iterable<ThreadAttention | null>,
): ThreadAttentionCounts {
  let needsYou = 0;
  let working = 0;
  for (const attention of attentions) {
    if (attention === "needs-you") needsYou += 1;
    else if (attention === "working") working += 1;
  }
  return needsYou === 0 && working === 0 ? NO_THREAD_ATTENTION : { needsYou, working };
}

/**
 * Lays the inbox out in families. `parentKeyOf` names the parent a thread is
 * attached to, whether or not it is in the list, and on whichever computer
 * (keys are environment-scoped); a thread whose parent is not in the list
 * (archived, deleted, on a computer this app can't see) stands on its own.
 * Scope is decided by the family's parent, so children always travel with
 * it, except where `standsAlone` lets a child the scope keeps stand apart
 * from a parent it hides (the machine filter showing a child's computer but
 * not its parent's). `remoteChildrenOf` adds a parent's children on
 * computers this app can't see; one whose thread is in the list is the
 * thread, never both. A wrapped child leaves a live parent's family once
 * {@link hasLeftLiveFamily} says so, unless it is open in the chat. The live
 * and wrapped orders come from the caller's sorts, applied to the rows that
 * stand on their own; children keep creation order and are never re-sorted.
 */
export function buildInboxSections<E extends InboxFamilyEntry>(input: {
  readonly entries: readonly E[];
  readonly parentKeyOf: (entry: E) => string | null;
  readonly inScope: (entry: E) => boolean;
  readonly standsAlone?: ((child: E, parent: E) => boolean) | undefined;
  readonly remoteChildrenOf?: ((parent: E) => readonly InboxRemoteChild[]) | undefined;
  readonly isFamilyOpen: (parentKey: string) => boolean;
  readonly activeThreadKey: string | null;
  /** The inbox clock, for {@link hasLeftLiveFamily}. */
  readonly now: string;
  readonly sortLive: (entries: readonly E[]) => E[];
  readonly sortDone: (entries: readonly E[]) => E[];
}): {
  readonly live: InboxLiveRow<E>[];
  readonly done: InboxDoneRow<E>[];
  /** Children on computers this app can't see that left a live family, newest wrap first. */
  readonly doneRemote: InboxDoneRemoteRow<E>[];
} {
  const entryByKey = new Map(input.entries.map((entry) => [entry.threadKey, entry] as const));
  const parentOf = (entry: E): E | null => {
    const parentKey = input.parentKeyOf(entry);
    if (parentKey === null || parentKey === entry.threadKey) return null;
    return entryByKey.get(parentKey) ?? null;
  };
  const remoteChildrenOf = (parent: E): readonly InboxRemoteChild[] => {
    const remote = input.remoteChildrenOf?.(parent) ?? [];
    return remote.length === 0
      ? remote
      : remote.filter((child) => !entryByKey.has(child.threadKey));
  };
  // A wrapped parent whose children on a computer this app can't see still
  // work or need the user stays live: those children have no row of their
  // own to stand on, unlike its children here.
  const wrapped = (entry: E): boolean =>
    entry.isDone &&
    !remoteChildrenOf(entry).some(
      (child) => isChildThreadNeedingYou(child) || isChildThreadWorking(child),
    );
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
  const scopedOutParentByKey = new Map<string, E>();
  const liveParentByKey = new Map<string, E>();
  for (const entry of input.entries) {
    const parent = parentOf(entry);
    if (parent === null) {
      if (!input.inScope(entry)) continue;
      (wrapped(entry) ? doneHeads : liveHeads).push(entry);
      continue;
    }
    if (!input.inScope(parent)) {
      // The scope hides its parent but keeps it: a row of its own.
      if (input.standsAlone?.(entry, parent) === true) {
        (entry.isDone ? doneHeads : liveHeads).push(entry);
        scopedOutParentByKey.set(entry.threadKey, parent);
      }
      continue;
    }
    if (!wrapped(parent)) {
      // Finished with, it moves to Wrapped; otherwise it is in the family.
      if (
        entry.threadKey !== input.activeThreadKey &&
        hasLeftLiveFamily(entry, parent, input.now)
      ) {
        doneHeads.push(entry);
        liveParentByKey.set(entry.threadKey, parent);
      }
      continue;
    }
    // Inside its wrapped parent: not a row of its own.
    if (entry.isDone) continue;
    liveHeads.push(entry);
    wrappedParentByKey.set(entry.threadKey, parent);
  }

  const doneRemote: InboxDoneRemoteRow<E>[] = [];
  const live = input.sortLive(liveHeads).map((entry): InboxLiveRow<E> => {
    const wrappedParent = wrappedParentByKey.get(entry.threadKey) ?? null;
    const scopedOutParent = scopedOutParentByKey.get(entry.threadKey) ?? null;
    const heads = wrappedParent === null && scopedOutParent === null;
    const children = heads
      ? (childrenByParentKey.get(entry.threadKey) ?? []).filter(
          (child) => !liveParentByKey.has(child.threadKey),
        )
      : [];
    const remoteChildren: InboxRemoteChild[] = [];
    for (const child of heads ? remoteChildrenOf(entry) : []) {
      if (hasLeftLiveFamily(child, entry, input.now)) doneRemote.push({ child, startedBy: entry });
      else remoteChildren.push(child);
    }
    const open = input.isFamilyOpen(entry.threadKey);
    const shownChildren = open
      ? children
      : children.filter(
          (child) => isChildThreadNeedingYou(child) || child.threadKey === input.activeThreadKey,
        );
    const shownRemoteChildren = open
      ? remoteChildren
      : remoteChildren.filter(isChildThreadNeedingYou);
    return {
      entry,
      children,
      shownChildren,
      remoteChildren,
      shownRemoteChildren,
      wrappedParent,
      scopedOutParent,
    };
  });
  const done = input.sortDone(doneHeads).map((entry): InboxDoneRow<E> => {
    const startedBy =
      liveParentByKey.get(entry.threadKey) ?? scopedOutParentByKey.get(entry.threadKey) ?? null;
    const standsApart = startedBy !== null;
    const children = standsApart ? [] : (childrenByParentKey.get(entry.threadKey) ?? []);
    return {
      entry,
      children,
      remoteChildren: standsApart ? [] : remoteChildrenOf(entry),
      openChild:
        children.find((child) => child.isDone && child.threadKey === input.activeThreadKey) ?? null,
      startedBy,
    };
  });
  doneRemote.sort(
    (left, right) =>
      (toSortableTimestamp(right.child.settledAt ?? undefined) ?? 0) -
      (toSortableTimestamp(left.child.settledAt ?? undefined) ?? 0),
  );
  return { live, done, doneRemote };
}

/** One row of the Wrapped shelf: a thread this app has, or a child on a computer it can't see. */
export type WrappedShelfRow<E extends InboxFamilyEntry> =
  | { readonly kind: "thread"; readonly key: string; readonly row: InboxDoneRow<E> }
  | { readonly kind: "remote"; readonly key: string; readonly row: InboxDoneRemoteRow<E> };

/**
 * The Wrapped shelf's rows, newest wrap first: the wrapped threads in their
 * order, with the remote children that left a live family placed among them
 * by when each wrapped. Both lists come sorted that way.
 */
export function mergeWrappedShelfRows<E extends InboxFamilyEntry>(
  done: readonly InboxDoneRow<E>[],
  doneRemote: readonly InboxDoneRemoteRow<E>[],
  doneAtOf: (row: InboxDoneRow<E>) => string | null,
): WrappedShelfRow<E>[] {
  const rows: WrappedShelfRow<E>[] = [];
  let remoteIndex = 0;
  const wrappedMs = (at: string | null) => toSortableTimestamp(at ?? undefined) ?? 0;
  for (const row of done) {
    const at = wrappedMs(doneAtOf(row));
    while (true) {
      const remote = doneRemote[remoteIndex];
      if (remote === undefined || wrappedMs(remote.child.settledAt) <= at) break;
      rows.push({ kind: "remote", key: remote.child.threadKey, row: remote });
      remoteIndex += 1;
    }
    rows.push({ kind: "thread", key: row.entry.threadKey, row });
  }
  for (const remote of doneRemote.slice(remoteIndex)) {
    rows.push({ kind: "remote", key: remote.child.threadKey, row: remote });
  }
  return rows;
}

/** When a Wrapped shelf row wrapped: its day label and its "today" count read this. */
export function wrappedShelfRowDoneAt<E extends InboxFamilyEntry>(
  row: WrappedShelfRow<E>,
  doneAtOf: (row: InboxDoneRow<E>) => string | null,
): string | null {
  return row.kind === "thread" ? doneAtOf(row.row) : row.row.child.settledAt;
}

/** Whether a live row earns a seat past the fold: it or a live child shows a status. */
export function inboxLiveRowHasAttention(row: InboxLiveRow<InboxFamilyEntry>): boolean {
  const hasStatus = (child: InboxFamilyStatus) => !child.isDone && child.status !== null;
  return (
    row.entry.status !== null || row.children.some(hasStatus) || row.remoteChildren.some(hasStatus)
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
 * Whether a live row is a thread, or holds it in its family: the thread open
 * in the chat, or the one being renamed. False for a null key.
 */
export function inboxLiveRowHolds(
  row: InboxLiveRow<InboxFamilyEntry>,
  threadKey: string | null,
): boolean {
  return (
    threadKey !== null &&
    (row.entry.threadKey === threadKey || inboxLiveRowHoldsOpenChild(row, threadKey))
  );
}

/**
 * The Wrapped rows shown at rest: the first `limit`, plus any past them that
 * is the thread open in the chat or holds it. Order never changes.
 */
export function windowInboxDoneRows<E extends InboxFamilyEntry>(
  rows: readonly WrappedShelfRow<E>[],
  limit: number,
  activeThreadKey: string | null,
): WrappedShelfRow<E>[] {
  return rows.filter(
    (row, index) =>
      index < limit ||
      (row.kind === "thread" &&
        (row.row.openChild !== null || row.row.entry.threadKey === activeThreadKey)),
  );
}

/** One live row as the fold's room budget sees it. */
export interface InboxFoldRowCost {
  /** Pinned: always drawn, and takes no seat. */
  readonly pinned: boolean;
  /** Drawn past the fold anyway (a status, the thread open in the chat), though it takes a seat. */
  readonly alwaysShown: boolean;
  /** Its own row's height as drawn; 0 when a folded group hides it. */
  readonly costPx: number;
  /** Its shown children's height; 0 when it has none or a folded group hides it. */
  readonly childrenPx: number;
  /** Its group while the list is grouped, else null. A group's header is drawn with its first shown row. */
  readonly groupKey: string | null;
}

/**
 * How many quiet live rows rest unfolded: as many as fit the column, and
 * never fewer than `minimum`. Walks the rows in list order the way the fold
 * does (`windowInboxThreads`): rows always drawn are charged first, then
 * each quiet row in turn, with its group's header when it is the group's
 * first shown row, until the next one would overflow `roomPx`. A row that
 * fits brings its shown children even past the room: opening a family must
 * never fold the family away. `roomPx` is
 * the column's height for live rows with the Wrapped shelf closed;
 * `reservedPx` is what else will stand in it (the wrapped rows a closed shelf
 * keeps). Costs must not depend on how many rows the fold shows, or the fold
 * would chase its own result.
 */
export function resolveInboxLiveFoldLimit(input: {
  readonly rows: readonly InboxFoldRowCost[];
  readonly roomPx: number | null;
  readonly groupHeaderPx: number;
  readonly reservedPx: number;
  readonly minimum: number;
}): number {
  if (input.roomPx === null) return input.minimum;
  let usedPx = input.reservedPx;
  const shownGroups = new Set<string>();
  const show = (row: InboxFoldRowCost) => {
    usedPx += row.costPx;
    if (row.groupKey !== null && !shownGroups.has(row.groupKey)) {
      shownGroups.add(row.groupKey);
      usedPx += input.groupHeaderPx;
    }
  };
  for (const row of input.rows) {
    if (row.pinned || row.alwaysShown) {
      show(row);
      usedPx += row.childrenPx;
    }
  }
  let limit = 0;
  for (const row of input.rows) {
    if (row.pinned) continue;
    if (!row.alwaysShown) {
      show(row);
      if (usedPx > input.roomPx) break;
      usedPx += row.childrenPx;
    }
    limit += 1;
  }
  return Math.max(input.minimum, limit);
}

/** The day groups the open Wrapped shelf sorts its rows under, newest first. */
export type WrappedDayGroup = "today" | "yesterday" | "week" | "month" | "older";

export const WRAPPED_DAY_GROUP_LABELS: Readonly<Record<WrappedDayGroup, string>> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Last 7 days",
  month: "Last 30 days",
  older: "Older",
};

/**
 * Which day group a wrap-up time falls in, by the viewer's calendar. "Last 7
 * days" and "Last 30 days" count today, so they hold the five and the 23 days
 * before yesterday. A missing or unreadable time is Older.
 */
export function wrappedDayGroupOf(doneAt: string | null, todayStartMs: number): WrappedDayGroup {
  const doneMs = doneAt === null ? Number.NaN : Date.parse(doneAt);
  if (Number.isNaN(doneMs)) return "older";
  if (doneMs >= todayStartMs) return "today";
  if (doneMs >= startOfLocalDayMs(todayStartMs, 1)) return "yesterday";
  if (doneMs >= startOfLocalDayMs(todayStartMs, 6)) return "week";
  if (doneMs >= startOfLocalDayMs(todayStartMs, 29)) return "month";
  return "older";
}

/**
 * The open shelf's day labels, one slot per row: the group on the first row
 * of each run, null on the rest. Rows come newest first; a row in a different
 * group from the row above starts a run, so a row out of order repeats a
 * label rather than hiding one.
 */
export function labelWrappedRowsByDay<R>(
  rows: readonly R[],
  doneAtOf: (row: R) => string | null,
  todayStartMs: number,
): (WrappedDayGroup | null)[] {
  let previous: WrappedDayGroup | null = null;
  return rows.map((row) => {
    const group = wrappedDayGroupOf(doneAtOf(row), todayStartMs);
    if (group === previous) return null;
    previous = group;
    return group;
  });
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

export function summarizeChildThreads<T extends InboxFamilyStatus>(
  children: ReadonlyArray<T>,
): ChildThreadsSummary {
  const dotOf = (child: InboxFamilyStatus) =>
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

// ── Families across computers ────────────────────────────────────────
//
// A thread an agent on one computer started on another belongs to its
// parent's family (docs/design/fleet.md, Part 5). Where the app has the
// child's computer, the child row is the real thread. Where it doesn't, the
// parent's own record of the child stands in for it, with its last known
// status, and so does a start that has no thread there yet.

const REMOTE_THREAD_PHASES: readonly AgentThreadStatusWord[] = [
  "working",
  "needs the user",
  "waiting",
  "failed",
  "idle",
  "wrapped",
];

const REMOTE_PHASE_PILLS: Record<InboxRemoteChildPhase, ThreadStatusPill | null> = {
  working: {
    label: "Working",
    colorClass: "text-primary-readable",
    dotClass: THREAD_STATUS_DOT_CLASSES.blue,
    pulse: true,
  },
  "needs the user": {
    label: "Awaiting Input",
    colorClass: "text-amber-600 dark:text-amber-300/90",
    dotClass: THREAD_STATUS_DOT_CLASSES.amber,
    pulse: false,
  },
  waiting: {
    label: "Waiting",
    colorClass: "text-cyan-600 dark:text-cyan-300/90",
    dotClass: THREAD_STATUS_DOT_CLASSES.cyan,
    pulse: true,
  },
  failed: {
    label: "Failed",
    colorClass: "text-red-600 dark:text-red-400/90",
    dotClass: THREAD_STATUS_DOT_CLASSES.red,
    pulse: false,
  },
  idle: null,
  wrapped: null,
  sending: {
    label: "Starting",
    colorClass: "text-primary-readable",
    dotClass: THREAD_STATUS_DOT_CLASSES.blue,
    pulse: true,
  },
  accepted: {
    label: "Starting",
    colorClass: "text-primary-readable",
    dotClass: THREAD_STATUS_DOT_CLASSES.blue,
    pulse: true,
  },
  // Its computer waits for the user's Allow: the user is who it waits on.
  awaiting_approval: {
    label: "Pending Approval",
    colorClass: "text-amber-600 dark:text-amber-300/90",
    dotClass: THREAD_STATUS_DOT_CLASSES.amber,
    pulse: false,
  },
  setting_up: {
    label: "Starting",
    colorClass: "text-primary-readable",
    dotClass: THREAD_STATUS_DOT_CLASSES.blue,
    pulse: true,
  },
};

/**
 * A parent's children the app has no thread for, from the parent's record:
 * its children on computers this app can't see (`remoteChildren`, then
 * `remoteChildStarts`), then the ones it started here whose thread isn't in
 * the list (`localChildStarts`, shown as setting up). A child on a computer
 * whose threads the app has is left out: its thread speaks for it, or it is
 * gone there. So is a start that computer already took, since its thread
 * shows up there; a start it hasn't taken yet has no thread anywhere, so it
 * stays. A child started here stands in until its own thread is in the list
 * (`hasThread`), whichever of the two arrives first. `computerLabel` names a
 * computer the way this app knows it, falling back to the name the parent
 * last heard.
 */
export function resolveRemoteFamilyChildren(input: {
  readonly parent: Pick<
    SidebarThreadSummary,
    "id" | "environmentId" | "remoteChildren" | "remoteChildStarts" | "localChildStarts"
  >;
  readonly canSeeComputer: (environmentId: EnvironmentId) => boolean;
  readonly computerLabel: (environmentId: EnvironmentId, lastKnown: string) => string;
  readonly hasThread: (threadId: ThreadId) => boolean;
  /** How a child there files (see remoteChildEntry). */
  readonly filing: RemoteChildFilingOptions;
}): InboxRemoteChild[] {
  const children = (input.parent.remoteChildren ?? []).flatMap((child): InboxRemoteChild[] =>
    input.canSeeComputer(child.environmentId)
      ? []
      : [
          {
            ...remoteChildEntry(
              child,
              input.computerLabel(child.environmentId, child.label),
              input.filing,
            ),
            parentRef: scopeThreadRef(input.parent.environmentId, input.parent.id),
          },
        ],
  );
  const starts = (input.parent.remoteChildStarts ?? [])
    .filter((start) => !(start.status === "accepted" && input.canSeeComputer(start.environmentId)))
    .toSorted(
      (left, right) =>
        (toSortableTimestamp(left.createdAt) ?? 0) - (toSortableTimestamp(right.createdAt) ?? 0),
    )
    .map((start): InboxRemoteChild => ({
      threadKey: `start:${start.environmentId}:${start.requestId}`,
      environmentId: start.environmentId,
      threadId: null,
      computerLabel: input.computerLabel(start.environmentId, start.label),
      title: start.title,
      phase: start.status,
      status: REMOTE_PHASE_PILLS[start.status],
      isDone: false,
      settledAt: null,
    }));
  const settingUp = (input.parent.localChildStarts ?? [])
    .filter((child) => !input.hasThread(child.childThreadId))
    .map((child): InboxRemoteChild => ({
      threadKey: `setup:${child.requestId}`,
      environmentId: input.parent.environmentId,
      threadId: null,
      computerLabel: input.computerLabel(input.parent.environmentId, "This computer"),
      title: child.title,
      phase: "setting_up",
      status: REMOTE_PHASE_PILLS.setting_up,
      isDone: false,
      settledAt: null,
    }));
  return [...children, ...starts, ...settingUp];
}

/**
 * How a child on another computer is doing, as its parent last heard: its
 * status word (an unknown one reads as idle, the way the parent's own tools
 * read it) and the pill for it.
 */
export function remoteChildStanding(child: Pick<FamilyRemoteChild, "cachedStatus">): {
  readonly phase: AgentThreadStatusWord;
  readonly status: ThreadStatusPill | null;
} {
  const phase = REMOTE_THREAD_PHASES.find((word) => word === child.cachedStatus) ?? "idle";
  return { phase, status: REMOTE_PHASE_PILLS[phase] };
}

/** What decides how a child on a computer this app can't see files. */
export interface RemoteChildFilingOptions {
  /** The inbox clock. */
  readonly now: string;
  /** "Wrap up finished child threads": one whose answer went back counts as done. */
  readonly wrapUpOnFinish: boolean;
  /** "Wrap up idle threads": how long one sits quiet before it files itself; null: never. */
  readonly autoDoneAfterDays: number | null;
  /**
   * The parent's computer still links to that one (false only once this app
   * knows the link is gone): nothing more will be heard of a child there
   * otherwise.
   */
  readonly linked: (environmentId: EnvironmentId) => boolean;
}

/**
 * A child on a computer this app can't see, from its parent's record: its
 * last known status, under `computerLabel`, filed by what that computer says
 * ({@link isRemoteChildDone}). From an older computer, which says nothing of
 * filing and only how a child is doing while a request to it is open, a
 * quiet child no request is open to counts as finished.
 */
export function remoteChildEntry(
  child: FamilyRemoteChild,
  computerLabel: string,
  options: RemoteChildFilingOptions,
): InboxRemoteChild {
  const { phase, status } = remoteChildStanding(child);
  const linked = options.linked(child.environmentId);
  const base = {
    threadKey: scopedThreadKey(scopeThreadRef(child.environmentId, child.threadId)),
    environmentId: child.environmentId,
    threadId: child.threadId,
    computerLabel,
    title: child.title,
    phase,
    // With its link gone, its last word is history, not news.
    status: linked ? status : null,
  };
  const filing = child.filing;
  if (filing === undefined) {
    const own = child.override ?? null;
    const ownStands = own !== null && Date.parse(own.at) >= Date.parse(child.updatedAt);
    const isDone = ownStands
      ? own.state === "done"
      : phase === "wrapped" ||
        !linked ||
        (options.wrapUpOnFinish &&
          child.followed === false &&
          (phase === "idle" || phase === "failed"));
    return {
      ...base,
      isDone,
      settledAt: ownStands && own.state === "done" ? own.at : child.updatedAt,
      wrappedByUser: ownStands && own.state === "done",
      canWrap: isDone || !linked || !isRemoteChildHeld(phase, undefined),
    };
  }
  const override = mergeThreadDoneOverride(child.override, filing.override);
  const own = child.override;
  const isDone = isRemoteChildDone({
    phase,
    filing,
    override,
    unsentWordHere: own !== undefined && override === own && filing.override?.at !== own.at,
    linked,
    now: options.now,
    wrapUpOnFinish: options.wrapUpOnFinish,
    autoDoneAfterDays: options.autoDoneAfterDays,
  });
  const wrappedByUser =
    filing.archived ||
    (override?.state === "done" &&
      (!linked || Date.parse(override.at) >= Date.parse(filing.lastActivityAt)));
  return {
    ...base,
    isDone,
    // When its work there ended, or the user's word on it: what the parent
    // must have been seen after for it to leave the family.
    settledAt: wrappedByUser && override !== null ? override.at : filing.lastActivityAt,
    seenAt: filing.seenAt ?? undefined,
    deliveredAt: filing.handedBackAt,
    wrappedByUser,
    // Archived there, nothing here can bring it back.
    canWrap: !filing.archived && (isDone || !linked || !isRemoteChildHeld(phase, filing)),
  };
}

/**
 * What a remote child's row says about where it stands: a thread's status
 * word ("working", "needs you"), or, before there is a thread, how far its
 * start got ("Waiting for Mac mini to allow it").
 */
export function remoteChildStatusText(
  child: Pick<InboxRemoteChild, "phase" | "computerLabel">,
): string {
  switch (child.phase) {
    case "sending":
      return `Sending to ${child.computerLabel}`;
    case "accepted":
      return `Starting on ${child.computerLabel}`;
    case "awaiting_approval":
      return `Waiting for ${child.computerLabel} to allow it`;
    case "setting_up":
      return "Setting up";
    case "needs the user":
      return "needs you";
    default:
      return child.phase;
  }
}

// ── Grouping ─────────────────────────────────────────────────────────
//
// The live list can be shown under a header per project or per computer
// (the "Group" choice in the scope menu). Grouping runs over the rows the
// family rules built, so a family goes where its parent goes, and it never
// reorders rows inside a group: pins keep leading. Wrapped stays one flat
// section below.

/** One group of live rows, keyed by what the rows share. */
export interface InboxRowGroup<R> {
  readonly key: string;
  readonly rows: readonly R[];
}

/**
 * The rows split into groups by `groupKeyOf`, each group placed where its
 * first row stood in the list and keeping the rows' order.
 */
export function groupInboxLiveRows<R>(
  rows: readonly R[],
  groupKeyOf: (row: R) => string,
): InboxRowGroup<R>[] {
  const rowsByKey = new Map<string, R[]>();
  for (const row of rows) {
    const key = groupKeyOf(row);
    const groupRows = rowsByKey.get(key);
    if (groupRows) {
      groupRows.push(row);
    } else {
      rowsByKey.set(key, [row]);
    }
  }
  return [...rowsByKey].map(([key, groupRows]) => ({ key, rows: groupRows }));
}

/**
 * What a group's header counts: live threads blocked on the user, and live
 * threads with work in flight, children of its families included (on other
 * computers too).
 */
export function countInboxRowAttention(
  rows: readonly InboxLiveRow<InboxFamilyEntry>[],
): ThreadAttentionCounts {
  let needsYou = 0;
  let working = 0;
  for (const row of rows) {
    for (const entry of [row.entry, ...row.children, ...row.remoteChildren]) {
      if (entry.isDone) continue;
      if (isNeedsUserStatus(entry.status)) needsYou += 1;
      else if (entry.status !== null && IN_FLIGHT.has(entry.status.label)) working += 1;
    }
  }
  return needsYou === 0 && working === 0 ? NO_THREAD_ATTENTION : { needsYou, working };
}
