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
 * runtime (not saved to outlive it). Stopping that runtime cancels a promise
 * its agent made, so archiving leaves such a thread running: a parent's
 * archive separates the child instead, and auto-archive and "Archive
 * inactive threads now" skip it. No clock is read: a runtime that stops
 * reports its list emptied, and archiving clears what it ends.
 */
export function holdsRuntimeCheckBack(thread: {
  readonly checkBacks?: ReadonlyArray<Pick<OrchestrationCheckBack, "durable">> | undefined;
}): boolean {
  return (thread.checkBacks ?? []).some((checkBack) => !checkBack.durable);
}
