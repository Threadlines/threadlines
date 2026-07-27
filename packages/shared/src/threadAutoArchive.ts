export const AUTO_ARCHIVE_SUGGESTED_INACTIVE_DAYS = 30 as const;

export interface AutoArchiveThreadFields {
  readonly createdAt: string;
  readonly updatedAt?: string | undefined;
  readonly latestUserMessageAt: string | null;
  readonly archivedAt: string | null;
  readonly pinnedAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasActionableProposedPlan: boolean;
  readonly latestTurn: { readonly state: string } | null;
  readonly session: {
    readonly status: string;
    readonly orchestrationStatus?: string | undefined;
    readonly activeTurnId?: unknown;
    readonly pendingBackgroundTaskCount?: number | undefined;
  } | null;
}

export function getAutoArchiveThreadInactiveSince(thread: AutoArchiveThreadFields): string {
  return thread.updatedAt ?? thread.latestUserMessageAt ?? thread.createdAt;
}

export function isAutoArchiveProtectedThread(thread: AutoArchiveThreadFields): boolean {
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
    session.activeTurnId != null ||
    (session.pendingBackgroundTaskCount ?? 0) > 0
  );
}

export function selectAutoArchiveCandidates<T extends AutoArchiveThreadFields>(input: {
  readonly threads: readonly T[];
  readonly inactiveDays: number;
  readonly nowMs?: number | undefined;
  readonly isExcluded?: ((thread: T) => boolean) | undefined;
}): ReadonlyArray<T & { readonly inactiveSince: string }> {
  if (input.inactiveDays === 0) {
    return [];
  }

  const cutoffMs = (input.nowMs ?? Date.now()) - input.inactiveDays * 24 * 60 * 60 * 1_000;
  return input.threads
    .flatMap((thread): Array<T & { readonly inactiveSince: string }> => {
      if (input.isExcluded?.(thread) === true || isAutoArchiveProtectedThread(thread)) {
        return [];
      }

      const inactiveSince = getAutoArchiveThreadInactiveSince(thread);
      const inactiveSinceMs = Date.parse(inactiveSince);
      if (!Number.isFinite(inactiveSinceMs) || inactiveSinceMs > cutoffMs) {
        return [];
      }

      return [{ ...thread, inactiveSince }];
    })
    .toSorted((left, right) => left.inactiveSince.localeCompare(right.inactiveSince));
}
