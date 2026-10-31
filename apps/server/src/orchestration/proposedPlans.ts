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
 * The plan a thread holds for the user to act on (the sidebar's "plan
 * ready"): the newest plan of its newest turn, or with none there its newest
 * plan, when it is neither implemented nor dismissed; undefined otherwise.
 * The shell's `hasActionableProposedPlan` comes from here, and so do the
 * decider's check that an outside agent's turn waits for the user and the
 * plan an outside agent's `inbox` lists.
 */
export function actionableProposedPlan<Plan extends PlanLike>(input: {
  readonly latestTurnId: string | null;
  readonly proposedPlans: ReadonlyArray<Plan>;
  /** The plan's id, the last tiebreak. */
  readonly idOf: (plan: Plan) => string;
}): Plan | undefined {
  const sorted = [...input.proposedPlans].toSorted(
    (left, right) =>
      (left.eventSequence === undefined && right.eventSequence === undefined
        ? left.updatedAt.localeCompare(right.updatedAt)
        : compareTranscriptPosition(left, right)) ||
      input.idOf(left).localeCompare(input.idOf(right)),
  );
  const latestForTurn =
    input.latestTurnId === null
      ? undefined
      : sorted.findLast((plan) => plan.turnId === input.latestTurnId);
  const candidate = latestForTurn ?? sorted.at(-1);
  return candidate !== undefined && awaitsUser(candidate) ? candidate : undefined;
}

/** Whether a thread holds a plan the user has yet to act on (actionableProposedPlan). */
export function hasActionableProposedPlan<Plan extends PlanLike>(input: {
  readonly latestTurnId: string | null;
  readonly proposedPlans: ReadonlyArray<Plan>;
  readonly idOf: (plan: Plan) => string;
}): boolean {
  return actionableProposedPlan(input) !== undefined;
}

const awaitsUser = (plan: PlanLike): boolean =>
  plan.implementedAt === null && (plan.dismissedAt ?? null) === null;

/** A plan's title: its first Markdown heading, as the app's plan card shows it; null without one. */
export function proposedPlanTitle(planMarkdown: string): string | null {
  const heading = planMarkdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}
