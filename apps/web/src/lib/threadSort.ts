import type { ProjectId } from "@threadlines/contracts";
import type {
  SidebarProjectSortOrder,
  SidebarThreadSortOrder,
} from "@threadlines/contracts/settings";
import type { Thread } from "../types";

export type ThreadSortInput = Pick<Thread, "createdAt" | "updatedAt"> & {
  latestUserMessageAt?: string | null;
  messages?: Pick<Thread["messages"][number], "createdAt" | "role">[];
  pinnedAt?: string | null;
};

export type ThreadInFlightStatus = "working" | "starting";

export function toSortableTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function getLatestUserMessageTimestamp(thread: ThreadSortInput): number {
  if (thread.latestUserMessageAt) {
    return toSortableTimestamp(thread.latestUserMessageAt) ?? Number.NEGATIVE_INFINITY;
  }

  let latestUserMessageTimestamp: number | null = null;

  for (const message of thread.messages ?? []) {
    if (message.role !== "user") continue;
    const messageTimestamp = toSortableTimestamp(message.createdAt);
    if (messageTimestamp === null) continue;
    latestUserMessageTimestamp =
      latestUserMessageTimestamp === null
        ? messageTimestamp
        : Math.max(latestUserMessageTimestamp, messageTimestamp);
  }

  if (latestUserMessageTimestamp !== null) {
    return latestUserMessageTimestamp;
  }

  return toSortableTimestamp(thread.updatedAt ?? thread.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function getThreadSortTimestamp(
  thread: ThreadSortInput,
  sortOrder: SidebarThreadSortOrder | Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (sortOrder === "created_at") {
    return toSortableTimestamp(thread.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return getLatestUserMessageTimestamp(thread);
}

function compareThreadsByTimestamp<T extends Pick<Thread, "id"> & ThreadSortInput>(
  left: T,
  right: T,
  sortOrder: SidebarThreadSortOrder,
): number {
  const rightTimestamp = getThreadSortTimestamp(right, sortOrder);
  const leftTimestamp = getThreadSortTimestamp(left, sortOrder);
  const byTimestamp =
    rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
  if (byTimestamp !== 0) return byTimestamp;
  return right.id.localeCompare(left.id);
}

export function sortThreads<T extends Pick<Thread, "id"> & ThreadSortInput>(
  threads: readonly T[],
  sortOrder: SidebarThreadSortOrder,
): T[] {
  return threads.toSorted((left, right) => {
    const rightPinned = right.pinnedAt !== null && right.pinnedAt !== undefined;
    const leftPinned = left.pinnedAt !== null && left.pinnedAt !== undefined;
    if (rightPinned !== leftPinned) {
      return rightPinned ? 1 : -1;
    }

    return compareThreadsByTimestamp(left, right, sortOrder);
  });
}

export function getThreadInFlightStatus(
  thread: Pick<Thread, "session">,
): ThreadInFlightStatus | null {
  if (thread.session?.status === "running" || thread.session?.orchestrationStatus === "running") {
    return "working";
  }

  if (
    thread.session?.status === "connecting" ||
    thread.session?.orchestrationStatus === "starting"
  ) {
    return "starting";
  }

  return null;
}

export function selectActiveAndRecentThreads<
  T extends Pick<Thread, "id" | "archivedAt" | "session"> & ThreadSortInput,
>(threads: readonly T[], limit: number): T[] {
  if (limit <= 0) return [];

  const byRecency = threads
    .filter((thread) => thread.archivedAt === null)
    .toSorted((left, right) => compareThreadsByTimestamp(left, right, "updated_at"));
  const activeThreads = byRecency.filter((thread) => getThreadInFlightStatus(thread) !== null);
  const recentThreads = byRecency.filter((thread) => getThreadInFlightStatus(thread) === null);
  const remainingRecentThreadCount = Math.max(0, limit - activeThreads.length);

  return [...activeThreads, ...recentThreads.slice(0, remainingRecentThreadCount)];
}

export function getLatestThreadForProject<
  T extends Pick<Thread, "id" | "projectId" | "archivedAt"> & ThreadSortInput,
>(threads: readonly T[], projectId: ProjectId, sortOrder: SidebarThreadSortOrder): T | null {
  return (
    sortThreads(
      threads.filter((thread) => thread.projectId === projectId && thread.archivedAt === null),
      sortOrder,
    )[0] ?? null
  );
}
