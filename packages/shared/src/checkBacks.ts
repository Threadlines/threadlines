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
        checkBack.durable === other.durable
      );
    })
  );
}
