/**
 * Outside agents' turns (docs/design/outside-agents.md, "The live ceiling"):
 * when one may start. The decider applies this to every `thread.turn.start`
 * carrying `fromOutside`, serialized against the user's own sends and access
 * changes, so it is the authority; the `/mcp/connect` handler reads the same
 * rule first only to answer early.
 */
import type {
  OrchestrationCommandRefusal,
  OrchestrationThread,
  OutsideTurnOrigin,
} from "@threadlines/contracts";
import {
  APPROVAL_ACTIVITY_KINDS,
  collectOpenPendingRequests,
  USER_INPUT_ACTIVITY_KINDS,
} from "@threadlines/shared/pendingRequests";
import { exceedsRuntimeMode } from "@threadlines/shared/runtimeMode";

import { hasActionableProposedPlan } from "./proposedPlans.ts";

export interface OutsideTurnRefusal {
  /** Absent for a refusal no caller acts on by type (a thread it didn't start). */
  readonly refusal?: OrchestrationCommandRefusal;
  readonly detail: string;
}

/**
 * Why a thread can't take a turn from outside now, or null when it can: a
 * turn running or about to start, or one waiting on the user (an approval,
 * a question, a plan). Sends never queue, so these are refused, not held.
 */
export function outsideTurnBusy(
  thread: Pick<OrchestrationThread, "session" | "latestTurn" | "activities" | "proposedPlans">,
): string | null {
  const session = thread.session;
  if (
    thread.latestTurn?.state === "running" ||
    (session !== null &&
      (session.activeTurnId !== null ||
        session.status === "running" ||
        session.status === "starting"))
  ) {
    return "It's working on a turn. Wait for it with thread_wait, then send again.";
  }
  if (collectOpenPendingRequests(thread.activities, APPROVAL_ACTIVITY_KINDS).length > 0) {
    return "It's waiting for the user to approve something in Threadlines.";
  }
  if (collectOpenPendingRequests(thread.activities, USER_INPUT_ACTIVITY_KINDS).length > 0) {
    return "It's waiting for the user to answer a question in Threadlines.";
  }
  if (
    hasActionableProposedPlan({
      latestTurnId: thread.latestTurn?.turnId ?? null,
      proposedPlans: thread.proposedPlans,
      idOf: (plan) => plan.id,
    })
  ) {
    return "Its plan is waiting for the user in Threadlines.";
  }
  return null;
}

/**
 * Why the decider refuses an outside agent's Stop in `thread`, or null: a
 * thread it didn't start, or one the user raised above its ceiling, which is
 * out of the agent's reach.
 */
export function outsideStopRefusal(
  thread: Pick<OrchestrationThread, "runtimeMode" | "outsideOrigin">,
  origin: OutsideTurnOrigin,
): OutsideTurnRefusal | null {
  if (thread.outsideOrigin?.connectionId !== origin.connectionId) {
    return { detail: `${origin.name} didn't start this thread.` };
  }
  if (exceedsRuntimeMode(thread.runtimeMode, origin.maxRuntimeMode)) {
    return { refusal: "above_ceiling", detail: outsideCeilingDetail(origin.name) };
  }
  return null;
}

/**
 * Why the decider refuses an outside agent's turn in `thread`, or null when
 * it may start: the Stop rules, and a thread that is busy.
 */
export function outsideTurnRefusal(
  thread: Pick<
    OrchestrationThread,
    "runtimeMode" | "outsideOrigin" | "session" | "latestTurn" | "activities" | "proposedPlans"
  >,
  origin: OutsideTurnOrigin,
): OutsideTurnRefusal | null {
  const stop = outsideStopRefusal(thread, origin);
  if (stop !== null) return stop;
  const busy = outsideTurnBusy(thread);
  return busy === null ? null : { refusal: "thread_busy", detail: busy };
}

/** The words for a thread whose access is above what an outside agent may use. */
export const outsideCeilingDetail = (name: string) =>
  `This thread's access is above what ${name} may use. The user raised it, or can allow more in Threadlines → Settings → Connections.`;
