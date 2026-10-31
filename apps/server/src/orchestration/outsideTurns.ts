/**
 * Outside agents' turns and answers (docs/design/outside-agents.md, "The live
 * ceiling"; docs/design/assistants.md, "Build plan: step 3"): when one may
 * start or reach an agent. The decider applies these to every
 * `thread.turn.start` and `thread.user-input.respond` carrying `fromOutside`,
 * serialized against the user's own sends and access changes, so it is the
 * authority; the `/mcp/connect` handler reads the same rules first only to
 * answer early.
 */
import type {
  ApprovalRequestId,
  OrchestrationCommandRefusal,
  OrchestrationOutsideWork,
  OrchestrationThread,
  OutsideAgentRef,
  OutsideTurnOrigin,
  ThreadParticipantId,
} from "@threadlines/contracts";
import {
  APPROVAL_ACTIVITY_KINDS,
  collectOpenPendingRequests,
  USER_INPUT_ACTIVITY_KINDS,
} from "@threadlines/shared/pendingRequests";
import { exceedsRuntimeMode } from "@threadlines/shared/runtimeMode";
import { sessionSlotParticipantId } from "@threadlines/shared/threadParticipants";

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
  /** The open question this turn answers (`answering`): not a reason to wait. */
  answering?: ApprovalRequestId,
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
  if (
    collectOpenPendingRequests(thread.activities, USER_INPUT_ACTIVITY_KINDS).some(
      (open) => open.requestId !== answering,
    )
  ) {
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
 * thread it didn't start (below Work), or one the user raised above its
 * ceiling, which is out of the agent's reach.
 */
export function outsideStopRefusal(
  thread: Pick<OrchestrationThread, "runtimeMode" | "outsideOrigin">,
  origin: OutsideTurnOrigin,
): OutsideTurnRefusal | null {
  if (origin.access !== "work" && thread.outsideOrigin?.connectionId !== origin.connectionId) {
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
  answering?: ApprovalRequestId,
): OutsideTurnRefusal | null {
  const stop = outsideStopRefusal(thread, origin);
  if (stop !== null) return stop;
  const busy = outsideTurnBusy(thread, answering);
  return busy === null ? null : { refusal: "thread_busy", detail: busy };
}

/**
 * Whether an outside agent may answer the open question `requestId` in
 * `thread`: Work only, at or under its ceiling, a question (never an
 * approval) that is open, and asked by the agent that holds the thread now
 * (a room handed over since would deliver it to someone else). Allowed, it
 * names the agent that asked, which the answer may only reach.
 */
export function outsideAnswerDecision(
  thread: Pick<OrchestrationThread, "runtimeMode" | "outsideOrigin" | "session" | "activities">,
  origin: OutsideTurnOrigin,
  requestId: ApprovalRequestId,
):
  | { readonly type: "allowed"; readonly participantId: ThreadParticipantId | null }
  | { readonly type: "refused"; readonly refusal: OutsideTurnRefusal } {
  const refused = (refusal: OutsideTurnRefusal) => ({ type: "refused" as const, refusal });
  if (origin.access !== "work") {
    return refused({ detail: `${origin.name} can't answer questions at its access level.` });
  }
  const stop = outsideStopRefusal(thread, origin);
  if (stop !== null) return refused(stop);
  const open = collectOpenPendingRequests(thread.activities, USER_INPUT_ACTIVITY_KINDS).find(
    (entry) => entry.requestId === requestId,
  );
  if (open === undefined) {
    const approval = collectOpenPendingRequests(thread.activities, APPROVAL_ACTIVITY_KINDS).some(
      (entry) => entry.requestId === requestId,
    );
    return refused({
      detail: approval
        ? "That's an approval. Only the user answers those, in Threadlines."
        : "That question isn't open anymore.",
    });
  }
  if (open.activity.sideTurnId !== undefined) {
    return refused({ detail: "That question came from a side answer. Answer it in Threadlines." });
  }
  const asker = open.activity.participantId ?? null;
  if (asker !== sessionSlotParticipantId(thread.session)) {
    return refused({
      detail: "The agent that asked doesn't hold the thread anymore. Answer it in Threadlines.",
    });
  }
  return { type: "allowed", participantId: asker };
}

/**
 * The thread's outside work after outside text reached `participantId`
 * through `ref` at `at`: that agent's entry gains the connection (once),
 * or one is added.
 */
export function markOutsideWork(
  current: ReadonlyArray<OrchestrationOutsideWork> | undefined,
  participantId: ThreadParticipantId | null,
  ref: OutsideAgentRef,
  at: string,
): ReadonlyArray<OrchestrationOutsideWork> {
  const entries = current ?? [];
  const existing = entries.find((entry) => entry.participantId === participantId);
  const connection = { connectionId: ref.connectionId, name: ref.name };
  if (existing === undefined) {
    return [...entries, { participantId, connections: [connection], since: at }];
  }
  const connections = existing.connections.some((entry) => entry.connectionId === ref.connectionId)
    ? existing.connections.map((entry) =>
        entry.connectionId === ref.connectionId ? connection : entry,
      )
    : [...existing.connections, connection];
  return entries.map((entry) =>
    entry.participantId === participantId ? { ...entry, connections } : entry,
  );
}

/** The thread's outside work once `participantId` started fresh. */
export function clearOutsideWork(
  current: ReadonlyArray<OrchestrationOutsideWork> | undefined,
  participantId: ThreadParticipantId | null,
): ReadonlyArray<OrchestrationOutsideWork> {
  return (current ?? []).filter((entry) => entry.participantId !== participantId);
}

/** Whether outside text reached `participantId` and it hasn't started fresh since. */
export function isOutsideMarked(
  thread: Pick<OrchestrationThread, "outsideWork">,
  participantId: ThreadParticipantId | null,
): boolean {
  return (thread.outsideWork ?? []).some((entry) => entry.participantId === participantId);
}

/** The words for a thread whose access is above what an outside agent may use. */
export const outsideCeilingDetail = (name: string) =>
  `This thread's access is above what ${name} may use. The user raised it, or can allow more in Threadlines → Settings → Connections.`;
