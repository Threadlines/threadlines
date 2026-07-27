import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import type { AutoArchiveInactiveThreadsDays } from "@threadlines/contracts/settings";
import {
  AUTO_ARCHIVE_SUGGESTED_INACTIVE_DAYS,
  selectAutoArchiveCandidates as selectSharedAutoArchiveCandidates,
} from "@threadlines/shared/threadAutoArchive";

import type { Project, SidebarThreadSummary } from "./types";

export {
  AUTO_ARCHIVE_SUGGESTED_INACTIVE_DAYS,
  getAutoArchiveThreadInactiveSince,
  isAutoArchiveProtectedThread,
  type AutoArchiveThreadFields,
} from "@threadlines/shared/threadAutoArchive";

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
    ? AUTO_ARCHIVE_SUGGESTED_INACTIVE_DAYS
    : autoArchiveInactiveThreadsDays;
}

export function selectAutoArchiveCandidates({
  threads,
  inactiveDays,
  nowMs = Date.now(),
  excludeThreadKeys,
}: SelectAutoArchiveCandidatesInput): ReadonlyArray<AutoArchiveCandidate> {
  return selectSharedAutoArchiveCandidates({
    threads,
    inactiveDays,
    nowMs,
    isExcluded:
      excludeThreadKeys === undefined
        ? undefined
        : (thread) =>
            excludeThreadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
  });
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
