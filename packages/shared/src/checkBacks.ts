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

/** How long past a check-back's time it is still owed. Claude states a
 *  wake-up's exact time but may run a cron job up to 30 minutes late (its
 *  scheduler spreads jobs out). */
const CHECK_BACK_EXACT_GRACE_MS = 5 * 60 * 1000;
const CHECK_BACK_SCHEDULE_GRACE_MS = 35 * 60 * 1000;

/**
 * Whether a check-back that dies with its runtime is still owed at `nowMs`:
 * not saved to outlive it, and repeating or not yet past its time. Stopping
 * a runtime that holds one cancels a promise its agent made. The idle reaper
 * keeps such a runtime; archiving a parent separates such a child instead of
 * archiving it.
 */
export function runtimeCheckBackOwed(checkBack: OrchestrationCheckBack, nowMs: number): boolean {
  if (checkBack.durable) return false;
  if (checkBack.recurring) return true;
  const due =
    Date.parse(checkBack.scheduledFor) +
    (checkBack.exact ? CHECK_BACK_EXACT_GRACE_MS : CHECK_BACK_SCHEDULE_GRACE_MS);
  return Number.isFinite(due) && nowMs < due;
}

/** Whether any of a thread's agents still owes a check-back a session stop
 *  would cancel (runtimeCheckBackOwed). */
export function holdsRuntimeCheckBack(
  thread: { readonly checkBacks?: ReadonlyArray<OrchestrationCheckBack> | undefined },
  nowMs: number,
): boolean {
  return (thread.checkBacks ?? []).some((checkBack) => runtimeCheckBackOwed(checkBack, nowMs));
}
