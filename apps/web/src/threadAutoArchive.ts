import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import type { AutoArchiveInactiveThreadsDays } from "@t3tools/contracts/settings";

import type { Project, SidebarThreadSummary } from "./types";

export const SUGGESTED_AUTO_ARCHIVE_INACTIVE_THREADS_DAYS = 30 as const;

export interface AutoArchiveCandidate extends SidebarThreadSummary {
  readonly inactiveSince: string;
}

export interface AutoArchiveProjectGroup {
  readonly project: Project | null;
  readonly count: number;
  readonly threads: ReadonlyArray<AutoArchiveCandidate>;
}

interface SelectAutoArchiveCandidatesInput {
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly inactiveDays: AutoArchiveInactiveThreadsDays;
  readonly nowMs?: number | undefined;
  readonly excludeThreadKeys?: ReadonlySet<string> | undefined;
}

interface GroupAutoArchiveCandidatesInput {
  readonly candidates: ReadonlyArray<AutoArchiveCandidate>;
  readonly projects: ReadonlyArray<Project>;
}

export function resolveAutoArchivePreviewDays(
  autoArchiveInactiveThreadsDays: AutoArchiveInactiveThreadsDays,
): Exclude<AutoArchiveInactiveThreadsDays, 0> {
  return autoArchiveInactiveThreadsDays === 0
    ? SUGGESTED_AUTO_ARCHIVE_INACTIVE_THREADS_DAYS
    : autoArchiveInactiveThreadsDays;
}

export function getAutoArchiveThreadInactiveSince(
  thread: Pick<SidebarThreadSummary, "createdAt" | "latestUserMessageAt" | "updatedAt">,
): string {
  return thread.updatedAt ?? thread.latestUserMessageAt ?? thread.createdAt;
}

export function isAutoArchiveProtectedThread(
  thread: Pick<
    SidebarThreadSummary,
    | "archivedAt"
    | "hasActionableProposedPlan"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "latestTurn"
    | "pinnedAt"
    | "session"
  >,
): boolean {
  if (thread.archivedAt !== null || thread.pinnedAt !== null) {
    return true;
  }

  if (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.hasActionableProposedPlan
  ) {
    return true;
  }

  if (thread.latestTurn?.state === "running") {
    return true;
  }

  const session = thread.session;
  if (!session) {
    return false;
  }

  return (
    session.status === "running" ||
    session.orchestrationStatus === "running" ||
    session.activeTurnId !== undefined ||
    (session.pendingBackgroundTaskCount ?? 0) > 0
  );
}

export function selectAutoArchiveCandidates({
  threads,
  inactiveDays,
  nowMs = Date.now(),
  excludeThreadKeys,
}: SelectAutoArchiveCandidatesInput): ReadonlyArray<AutoArchiveCandidate> {
  if (inactiveDays === 0) {
    return [];
  }

  const cutoffMs = nowMs - inactiveDays * 24 * 60 * 60 * 1_000;
  return threads
    .flatMap((thread): AutoArchiveCandidate[] => {
      if (
        excludeThreadKeys?.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))) ===
        true
      ) {
        return [];
      }

      if (isAutoArchiveProtectedThread(thread)) {
        return [];
      }

      const inactiveSince = getAutoArchiveThreadInactiveSince(thread);
      const inactiveSinceMs = Date.parse(inactiveSince);
      if (!Number.isFinite(inactiveSinceMs) || inactiveSinceMs > cutoffMs) {
        return [];
      }

      return [{ ...thread, inactiveSince }];
    })
    .toSorted(
      (left, right) =>
        left.inactiveSince.localeCompare(right.inactiveSince) || left.id.localeCompare(right.id),
    );
}

export function groupAutoArchiveCandidatesByProject({
  candidates,
  projects,
}: GroupAutoArchiveCandidatesInput): ReadonlyArray<AutoArchiveProjectGroup> {
  const projectByKey = new Map<string, Project>(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
  );
  const groupByKey = new Map<string, AutoArchiveCandidate[]>();

  for (const candidate of candidates) {
    const key = `${candidate.environmentId}:${candidate.projectId}`;
    const group = groupByKey.get(key);
    if (group) {
      group.push(candidate);
    } else {
      groupByKey.set(key, [candidate]);
    }
  }

  return [...groupByKey.entries()]
    .map(([key, groupThreads]) => ({
      project: projectByKey.get(key) ?? null,
      count: groupThreads.length,
      threads: groupThreads,
    }))
    .toSorted((left, right) => {
      const leftName = left.project?.name ?? "Unknown project";
      const rightName = right.project?.name ?? "Unknown project";
      return leftName.localeCompare(rightName) || right.count - left.count;
    });
}
