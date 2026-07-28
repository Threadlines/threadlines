import * as React from "react";
import type {
  SidebarProjectSortOrder,
  SidebarThreadSortOrder,
} from "@threadlines/contracts/settings";
import {
  getThreadInFlightStatus,
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "../lib/threadSort";
import type { EnvironmentId } from "@threadlines/contracts";
import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import type { SidebarThreadSummary, Thread } from "../types";
import type { OnDeckSyncInput } from "../uiStateStore";
import { cn } from "../lib/utils";
import { isLatestTurnSettled } from "../session-logic";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 100;
// Visible sidebar rows are prewarmed into the thread-detail cache so opening a
// nearby thread usually reuses an already-hot subscription.
export const SIDEBAR_THREAD_PREWARM_LIMIT = 10;
export type SidebarNewThreadEnvMode = "local" | "worktree";
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
    | "Background"
    | "Failed";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  Working: 3,
  Starting: 3,
  "Plan Ready": 2,
  Background: 2,
  Completed: 1,
  Failed: 4,
};

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
  | "interactionMode"
  | "latestTurn"
  | "session"
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

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
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

export function resolveSidebarNewThreadEnvMode(input: {
  requestedEnvMode?: SidebarNewThreadEnvMode;
  defaultEnvMode: SidebarNewThreadEnvMode;
}): SidebarNewThreadEnvMode {
  return input.requestedEnvMode ?? input.defaultEnvMode;
}

export function resolveSidebarNewThreadSeedContext(input: {
  projectId: string;
  defaultEnvMode: SidebarNewThreadEnvMode;
  activeThread?: {
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
  } | null;
  activeDraftThread?: {
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
    envMode: SidebarNewThreadEnvMode;
  } | null;
}): {
  branch?: string | null;
  worktreePath?: string | null;
  envMode: SidebarNewThreadEnvMode;
} {
  if (input.defaultEnvMode === "worktree") {
    return {
      envMode: "worktree",
    };
  }

  if (input.activeDraftThread?.projectId === input.projectId) {
    return {
      branch: input.activeDraftThread.branch,
      worktreePath: input.activeDraftThread.worktreePath,
      envMode: input.activeDraftThread.envMode,
    };
  }

  if (input.activeThread?.projectId === input.projectId) {
    return {
      branch: input.activeThread.branch,
      worktreePath: input.activeThread.worktreePath,
      envMode: input.activeThread.worktreePath ? "worktree" : "local",
    };
  }

  return {
    envMode: input.defaultEnvMode,
  };
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

export function getVisibleSidebarThreadIds<TThreadId>(
  renderedProjects: readonly {
    shouldShowThreadPanel?: boolean;
    renderedThreadIds: readonly TThreadId[];
  }[],
): TThreadId[] {
  return renderedProjects.flatMap((renderedProject) =>
    renderedProject.shouldShowThreadPanel === false ? [] : renderedProject.renderedThreadIds,
  );
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

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  const baseClassName =
    "h-7 w-full translate-x-0 cursor-pointer justify-start px-2 text-left select-none focus-ring focus-visible:ring-inset";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-primary/22 text-foreground font-medium hover:bg-primary/26 hover:text-foreground dark:bg-primary/30 dark:hover:bg-primary/36",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-primary/15 text-foreground hover:bg-primary/19 hover:text-foreground dark:bg-primary/22 dark:hover:bg-primary/28",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-accent/85 text-foreground font-medium hover:bg-accent hover:text-foreground dark:bg-accent/55 dark:hover:bg-accent/70",
    );
  }

  return cn(baseClassName, "text-muted-foreground hover:bg-accent hover:text-foreground");
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
}): ThreadStatusPill | null {
  const { thread } = input;

  if (thread.hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: THREAD_STATUS_DOT_CLASSES.amber,
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput) {
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
  const pendingBackgroundTaskCount = thread.session?.pendingBackgroundTaskCount ?? 0;
  if (pendingBackgroundTaskCount > 0 && isLatestTurnSettled(thread.latestTurn, thread.session)) {
    return {
      label: "Background",
      colorClass: "text-cyan-600 dark:text-cyan-300/90",
      dotClass: THREAD_STATUS_DOT_CLASSES.cyan,
      pulse: true,
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

/** Statuses that mean the provider is working or waiting on the user right now. */
const ON_DECK_LIVE_STATUSES: ReadonlySet<ThreadStatusPill["label"]> = new Set([
  "Pending Approval",
  "Awaiting Input",
  "Working",
  "Starting",
  "Plan Ready",
  "Background",
]);

/** Maps a thread's status pill and pin state onto the deck's entry signals. */
export function buildOnDeckSyncInput(input: {
  threadKey: string;
  pinnedAt: string | null;
  status: ThreadStatusPill | null;
}): OnDeckSyncInput {
  return {
    key: input.threadKey,
    pinned: input.pinnedAt !== null,
    live: input.status !== null && ON_DECK_LIVE_STATUSES.has(input.status.label),
    unseen: input.status?.label === "Completed",
  };
}

/** Only settled rows offer the dismiss affordance; live work can't be waved away. */
export function isOnDeckDismissible(status: ThreadStatusPill | null): boolean {
  return status === null || !ON_DECK_LIVE_STATUSES.has(status.label);
}

/**
 * Drops threads that already have a deck row, so a thread on deck appears once
 * in the sidebar rather than twice. Must be applied *before* the preview window
 * is computed: a deck thread should not consume a preview slot and then vanish,
 * which would leave "Show more" counts disagreeing with the rendered rows.
 */
export function excludeOnDeckThreads<TThread>(input: {
  threads: readonly TThread[];
  onDeckThreadKeys: ReadonlySet<string>;
  getThreadKey: (thread: TThread) => string;
}): TThread[] {
  if (input.onDeckThreadKeys.size === 0) {
    return [...input.threads];
  }
  return input.threads.filter((thread) => !input.onDeckThreadKeys.has(input.getThreadKey(thread)));
}

/**
 * Statuses where the agent has stopped and cannot continue without the user.
 * Narrower than {@link ON_DECK_LIVE_STATUSES}: a working thread is live but
 * needs nothing, and a ready plan is an invitation rather than a block.
 */
const NEEDS_USER_STATUSES: ReadonlySet<ThreadStatusPill["label"]> = new Set([
  "Pending Approval",
  "Awaiting Input",
  "Failed",
]);

/** True while the provider is working on the thread or waiting on the user. */
export function isLiveThreadStatus(status: ThreadStatusPill | null): boolean {
  return status !== null && ON_DECK_LIVE_STATUSES.has(status.label);
}

/** True when the thread is blocked waiting on the user. */
export function isNeedsUserStatus(status: ThreadStatusPill | null): boolean {
  return status !== null && NEEDS_USER_STATUSES.has(status.label);
}

/**
 * How many threads are blocked on the user. The collapsed sidebar rail drops
 * per-thread titles, so this aggregate is the only attention signal left.
 */
export function countThreadsNeedingUser(statuses: ReadonlyArray<ThreadStatusPill | null>): number {
  let count = 0;
  for (const status of statuses) {
    if (isNeedsUserStatus(status)) count += 1;
  }
  return count;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

export interface SidebarThreadWindow<T> {
  visibleThreads: T[];
  hiddenThreads: T[];
  /** How many threads the next "Show more" click reveals (0 = no row). */
  nextRevealCount: number;
  /** Total thread count for the "Search all N threads" row (null = no row). */
  searchHandoffThreadCount: number | null;
  /** True once the user revealed beyond the preview (shows "Show less"). */
  isRevealed: boolean;
}

export function getSidebarThreadWindow<T>(input: {
  threads: readonly T[];
  getThreadKey: (thread: T) => string;
  activeThreadKey: string | null;
  previewLimit: number;
  revealedCount: number;
}): SidebarThreadWindow<T> {
  const { activeThreadKey, getThreadKey, previewLimit, revealedCount, threads } = input;
  const isRevealed = revealedCount > 0;
  const windowSize = previewLimit + Math.max(0, revealedCount);

  if (threads.length <= windowSize) {
    return {
      visibleThreads: [...threads],
      hiddenThreads: [],
      nextRevealCount: 0,
      searchHandoffThreadCount: null,
      isRevealed,
    };
  }

  const windowThreads = threads.slice(0, windowSize);
  // The active thread always stays visible, even when it falls in the hidden
  // tail, so the current-thread marker never disappears from the sidebar.
  const visibleThreadKeys = new Set(windowThreads.map(getThreadKey));
  const includeActiveThread =
    activeThreadKey !== null &&
    !visibleThreadKeys.has(activeThreadKey) &&
    threads.some((thread) => getThreadKey(thread) === activeThreadKey);
  if (includeActiveThread) {
    visibleThreadKeys.add(activeThreadKey);
  }

  const visibleThreads = includeActiveThread
    ? threads.filter((thread) => visibleThreadKeys.has(getThreadKey(thread)))
    : windowThreads;
  const hiddenThreads = threads.filter((thread) => !visibleThreadKeys.has(getThreadKey(thread)));

  // Reveal in preview-sized chunks until the tail is exhausted. Search remains
  // available after the first expansion as a fast path for huge projects.
  const revealStepSize = Math.max(0, previewLimit);
  const nextRevealCount = Math.min(hiddenThreads.length, revealStepSize);

  return {
    visibleThreads,
    hiddenThreads,
    nextRevealCount,
    searchHandoffThreadCount: isRevealed && hiddenThreads.length > 0 ? threads.length : null,
    isRevealed,
  };
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, threads } = input;
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
      sortOrder,
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

export interface ProjectHoverSummary {
  name: string;
  cwd: string;
  environmentId: EnvironmentId;
  status: ThreadStatusPill | null;
  threadCount: number;
  activeCount: number;
  lastActivityAt: string | null;
}

/**
 * Builds a project's hover summary from its threads. Shared so the expanded row
 * and the collapsed rail glyph describe a project identically.
 */
export function buildProjectHoverSummary(input: {
  name: string;
  cwd: string;
  environmentId: EnvironmentId;
  threads: readonly SidebarThreadSummary[];
  getLastVisitedAt: (threadKey: string) => string | null | undefined;
}): ProjectHoverSummary {
  const getThreadKey = (thread: SidebarThreadSummary) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const statuses = input.threads.map((thread) => {
    const lastVisitedAt = input.getLastVisitedAt(getThreadKey(thread));
    return resolveThreadStatusPill({
      thread: {
        ...thread,
        ...(lastVisitedAt !== undefined && lastVisitedAt !== null ? { lastVisitedAt } : {}),
      },
    });
  });
  const lastActivityAt = input.threads.reduce<string | null>((latest, thread) => {
    const at = thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt;
    return latest === null || at > latest ? at : latest;
  }, null);

  return {
    name: input.name,
    cwd: input.cwd,
    environmentId: input.environmentId,
    status: resolveProjectStatusIndicator(statuses),
    threadCount: input.threads.length,
    activeCount: statuses.filter(isLiveThreadStatus).length,
    lastActivityAt,
  };
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
  "hasPendingApprovals" | "hasPendingUserInput" | "session" | "latestUserMessageAt" | "latestTurn"
>;

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
 * user, or queued cannot be waved away: hiding a pending approval defeats
 * the approval, and hiding a running turn hides where its result will land.
 * A failed thread CAN be marked done -- that is "I saw it, I'm done with it".
 */
export function canMarkThreadDone(
  thread: InboxLifecycleInput,
  options: { readonly now: string },
): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  // The same in-flight resolution the status pill uses, so "can't be marked
  // done" and "shows as working" can never disagree about what running means.
  if (getThreadInFlightStatus(thread) !== null) return false;
  if (hasQueuedTurnStart(thread, options)) return false;
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
 * Where a thread lives. The blockers outrank the override in both
 * directions: new activity in a done thread pulls it back to the live list
 * without anyone having to un-mark it, which is what makes Done safe to use
 * freely.
 */
export function isThreadDone(
  thread: InboxLifecycleInput,
  override: ThreadDoneOverride | null | undefined,
  options: { readonly now: string },
): boolean {
  if (!canMarkThreadDone(thread, options)) return false;
  return override?.state === "done";
}

/**
 * The live list holds still. Creation order, newest first; activity never
 * reorders it, so a row keeps its place from open until it is marked done
 * and the thing you were reaching for never jumps. Pins are the one
 * exception, and they move only when you pin -- your action, your motion.
 */
export function sortInboxThreads<
  T extends { readonly id: string; readonly createdAt: string; readonly pinnedAt: string | null },
>(threads: readonly T[]): T[] {
  return [...threads].toSorted((left, right) => {
    if ((left.pinnedAt !== null) !== (right.pinnedAt !== null)) {
      return left.pinnedAt !== null ? -1 : 1;
    }
    if (left.pinnedAt !== null && right.pinnedAt !== null) {
      const byPin =
        (toSortableTimestamp(right.pinnedAt) ?? 0) - (toSortableTimestamp(left.pinnedAt) ?? 0);
      if (byPin !== 0) return byPin;
    }
    const byCreated =
      (toSortableTimestamp(right.createdAt) ?? 0) - (toSortableTimestamp(left.createdAt) ?? 0);
    return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
  });
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

// ── Project chips ────────────────────────────────────────────────────

export interface ProjectChipModel {
  readonly key: string;
  readonly label: string;
  /** Threads in this project blocked on the user, shown on the chip. */
  readonly needsYouCount: number;
}

/**
 * Which projects earn a chip, in most-recently-active order.
 *
 * The scoped project always gets a chip even when its activity would not
 * earn one: filtering by a project and then watching its chip vanish into
 * the overflow reads as the sidebar losing your place.
 */
export function buildProjectChips(input: {
  readonly projects: ReadonlyArray<{ readonly key: string; readonly label: string }>;
  readonly lastActivityMsByKey: ReadonlyMap<string, number>;
  readonly needsYouCountByKey: ReadonlyMap<string, number>;
  readonly scopedKey: string | null;
  readonly maxChips: number;
}): { readonly chips: ProjectChipModel[]; readonly overflow: ProjectChipModel[] } {
  const toModel = (project: { key: string; label: string }): ProjectChipModel => ({
    key: project.key,
    label: project.label,
    needsYouCount: input.needsYouCountByKey.get(project.key) ?? 0,
  });
  const ordered = [...input.projects]
    .toSorted(
      (left, right) =>
        (input.lastActivityMsByKey.get(right.key) ?? 0) -
          (input.lastActivityMsByKey.get(left.key) ?? 0) || left.label.localeCompare(right.label),
    )
    .map(toModel);
  if (ordered.length <= input.maxChips) {
    return { chips: ordered, overflow: [] };
  }
  const chips = ordered.slice(0, input.maxChips);
  const overflow = ordered.slice(input.maxChips);
  if (input.scopedKey !== null && !chips.some((chip) => chip.key === input.scopedKey)) {
    const scoped = overflow.find((chip) => chip.key === input.scopedKey);
    if (scoped !== undefined) {
      // The scoped project takes the last visible slot; the displaced chip
      // joins the overflow where the scoped one came from.
      const displaced = chips[chips.length - 1]!;
      chips[chips.length - 1] = scoped;
      const index = overflow.indexOf(scoped);
      overflow[index] = displaced;
    }
  }
  return { chips, overflow };
}
