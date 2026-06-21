import type { OrchestrationThreadActivity } from "@threadlines/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNormalizedString(value: unknown): string | null {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

function activityOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  const leftSequence = typeof left.sequence === "number" ? left.sequence : null;
  const rightSequence = typeof right.sequence === "number" ? right.sequence : null;
  if (leftSequence !== null || rightSequence !== null) {
    if (leftSequence === null) return -1;
    if (rightSequence === null) return 1;
    if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  }
  const created = left.createdAt.localeCompare(right.createdAt);
  return created === 0 ? left.id.localeCompare(right.id) : created;
}

function contextCompactionPayload(
  activity: OrchestrationThreadActivity,
): Record<string, unknown> | null {
  return activity.kind === "context-compaction" ? asRecord(activity.payload) : null;
}

function isManualSyntheticContextCompactionActivity(
  activity: OrchestrationThreadActivity,
): boolean {
  const payload = contextCompactionPayload(activity);
  if (!payload) {
    return false;
  }
  const detail = asRecord(payload.detail);
  return (
    asNormalizedString(payload.status) === "inprogress" &&
    asNormalizedString(detail?.trigger) === "manual"
  );
}

function isConcreteContextCompactionActivity(activity: OrchestrationThreadActivity): boolean {
  const payload = contextCompactionPayload(activity);
  if (!payload || isManualSyntheticContextCompactionActivity(activity)) {
    return false;
  }
  const status = asNormalizedString(payload.status);
  return (
    asNormalizedString(payload.sourceItemType) === "context_compaction" ||
    status === "completed" ||
    status === "failed"
  );
}

export function filterSupersededManualContextCompactionActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThreadActivity[] {
  const ordered = [...activities].toSorted(activityOrder);
  const supersededIds = new Set<string>();
  for (let index = 0; index < ordered.length; index += 1) {
    const activity = ordered[index];
    if (!activity || !isManualSyntheticContextCompactionActivity(activity)) {
      continue;
    }
    const hasLaterConcreteCompaction = ordered
      .slice(index + 1)
      .some(isConcreteContextCompactionActivity);
    if (hasLaterConcreteCompaction) {
      supersededIds.add(activity.id);
    }
  }
  return activities.filter((activity) => !supersededIds.has(activity.id));
}

export function hasActiveContextCompactionActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
): boolean {
  if (!activities) {
    return false;
  }
  return filterSupersededManualContextCompactionActivities(activities).some((activity) => {
    const payload = contextCompactionPayload(activity);
    const status = asNormalizedString(payload?.status);
    return status === "inprogress" || status === "running" || status === "pending";
  });
}
