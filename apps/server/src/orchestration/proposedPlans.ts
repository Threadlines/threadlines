import { compareTranscriptPosition } from "@threadlines/shared/transcriptOrder";

/** A proposed plan as the projections and the read model both keep it. */
interface PlanLike {
  readonly turnId: string | null;
  readonly implementedAt: string | null;
  /** Dismissed by the user: no longer waiting on them. Absent on older rows. */
  readonly dismissedAt?: string | null | undefined;
  readonly eventSequence?: number | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Whether a thread holds a plan the user has yet to act on (the sidebar's
 * "plan ready"): the newest plan of its newest turn, or with none there its
 * newest plan, neither implemented nor dismissed. The shell's `hasActionableProposedPlan`
 * comes from here, and so does the decider's check that an outside agent's
 * turn waits for the user.
 */
export function hasActionableProposedPlan<Plan extends PlanLike>(input: {
  readonly latestTurnId: string | null;
  readonly proposedPlans: ReadonlyArray<Plan>;
  /** The plan's id, the last tiebreak. */
  readonly idOf: (plan: Plan) => string;
}): boolean {
  const sorted = [...input.proposedPlans].toSorted(
    (left, right) =>
      (left.eventSequence === undefined && right.eventSequence === undefined
        ? left.updatedAt.localeCompare(right.updatedAt)
        : compareTranscriptPosition(left, right)) ||
      input.idOf(left).localeCompare(input.idOf(right)),
  );
  if (input.latestTurnId !== null) {
    const latestForTurn = sorted.findLast((plan) => plan.turnId === input.latestTurnId);
    if (latestForTurn !== undefined) {
      return awaitsUser(latestForTurn);
    }
  }
  const latestPlan = sorted.at(-1);
  return latestPlan !== undefined && awaitsUser(latestPlan);
}

const awaitsUser = (plan: PlanLike): boolean =>
  plan.implementedAt === null && (plan.dismissedAt ?? null) === null;
