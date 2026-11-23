import type { OrchestrationCheckBack, ThreadParticipantId } from "@threadlines/contracts";

/**
 * A thread's check-backs after one agent's runtime reported its whole list:
 * that agent's are replaced, every other agent's kept, soonest first. Every
 * reader of `thread.check-backs-set` (server read models, clients) applies it.
 */
export function replaceAgentCheckBacks(
  current: ReadonlyArray<OrchestrationCheckBack>,
  update: {
    readonly participantId: ThreadParticipantId | null;
    readonly checkBacks: ReadonlyArray<OrchestrationCheckBack>;
  },
): ReadonlyArray<OrchestrationCheckBack> {
  return [
    ...current.filter((checkBack) => checkBack.participantId !== update.participantId),
    ...update.checkBacks,
  ].toSorted((left, right) => left.scheduledFor.localeCompare(right.scheduledFor));
}

/** Whether two check-back lists say the same thing (a runtime repeats its
 *  list at the end of every turn; only a change is worth recording). */
export function sameCheckBacks(
  left: ReadonlyArray<Omit<OrchestrationCheckBack, "participantId">>,
  right: ReadonlyArray<Omit<OrchestrationCheckBack, "participantId">>,
): boolean {
  return (
    left.length === right.length &&
    left.every((checkBack, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        checkBack.id === other.id &&
        checkBack.scheduledFor === other.scheduledFor &&
        checkBack.exact === other.exact &&
        checkBack.recurring === other.recurring &&
        checkBack.schedule === other.schedule &&
        checkBack.description === other.description &&
        checkBack.prompt === other.prompt &&
        checkBack.cron === other.cron &&
        checkBack.durable === other.durable
      );
    })
  );
}

/**
 * Whether any of a thread's agents holds a check-back that dies with its
 * runtime (not saved to outlive it), however old. A parent's archive
 * separates such a child instead of archiving it. The decider reads no
 * clock, and a stale entry only leaves a child as its own thread.
 */
export function holdsRuntimeCheckBack(thread: {
  readonly checkBacks?: ReadonlyArray<Pick<OrchestrationCheckBack, "durable">> | undefined;
}): boolean {
  return (thread.checkBacks ?? []).some((checkBack) => !checkBack.durable);
}

/** How long past a check-back's time it is still owed. Claude states a
 *  wake-up's exact time but may run a cron job up to 30 minutes late (its
 *  scheduler spreads jobs out). */
const CHECK_BACK_EXACT_GRACE_MS = 5 * 60 * 1000;
const CHECK_BACK_SCHEDULE_GRACE_MS = 35 * 60 * 1000;
/** Claude's repeating jobs expire after 7 days; one idle longer is gone. */
const RECURRING_CHECK_BACK_IDLE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

/** The check-back fields runtimeCheckBackOwed reads. */
export type OwedCheckBackFields = Pick<
  OrchestrationCheckBack,
  "durable" | "recurring" | "exact" | "scheduledFor"
>;

/**
 * Whether a check-back that dies with its runtime is still owed at `nowMs`,
 * its agent idle for `idleDurationMs`: a repeating one until Claude would
 * have expired it, a one-off until a little past its time. Stopping the
 * runtime then cancels a promise its agent made. The idle reaper keeps such a
 * runtime, and auto-archive skips such a thread; a stale entry, one whose
 * runtime ended without its report landing, stops counting on its own.
 */
export function runtimeCheckBackOwed(
  checkBack: OwedCheckBackFields,
  nowMs: number,
  idleDurationMs: number,
): boolean {
  if (checkBack.durable) return false;
  if (checkBack.recurring) return idleDurationMs < RECURRING_CHECK_BACK_IDLE_LIMIT_MS;
  const due =
    Date.parse(checkBack.scheduledFor) +
    (checkBack.exact ? CHECK_BACK_EXACT_GRACE_MS : CHECK_BACK_SCHEDULE_GRACE_MS);
  return Number.isFinite(due) && nowMs < due;
}

/**
 * Whether one of the thread's agents can still wake itself up. A job saved
 * to the project counts too: in a room, the thread's session says nothing of
 * the other agents' runtimes, where it may still fire. A stop counts it as
 * work to stop.
 */
export function hasLiveCheckBack(thread: {
  readonly checkBacks?: ReadonlyArray<OrchestrationCheckBack> | undefined;
}): boolean {
  return (thread.checkBacks ?? []).length > 0;
}
