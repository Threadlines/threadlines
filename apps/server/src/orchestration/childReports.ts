/**
 * Child threads: the reports a child owes its parent for turns it takes on
 * its own after its answer went back (docs/design/agent-autonomy-no-limits.md,
 * Part 2, "Delivery rules"). The decision that starts such a turn records an
 * entry on the child's owed list; the decision that settles the turn writes
 * the report into the parent, or drops it, and removes the entry. Each
 * function returns the events to plan, or a refusal.
 */
import {
  ChildRequestId,
  type OrchestrationMessage,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OwedChildReport,
  type OwedReportKey,
  type OwedReportStamps,
  type ThreadMessageOrigin,
  type ThreadParticipantId,
  type TurnId,
} from "@threadlines/contracts";
import { isOwedReport, owedReportKeyOf } from "@threadlines/shared/childThreads";
import { activeParticipants } from "@threadlines/shared/threadParticipants";
import { isTurnAside } from "@threadlines/shared/transcriptRevert";

import {
  type ChildEventBase,
  type ChildThreadDecision,
  childReportMessageId,
  decideChildRequestSettle,
  personWrote,
} from "./childThreadDecisions.ts";
import { childDeliveryForQuietCandidate } from "./childThreadDelivery.ts";
import { currentAgentModel, messageAgentModels } from "./messageAgentModels.ts";

type PlannedEvent = Extract<ChildThreadDecision, ReadonlyArray<unknown>>[number];

const findThread = (readModel: OrchestrationReadModel, threadId: string) =>
  readModel.threads.find((thread) => thread.id === threadId && thread.deletedAt === null) ?? null;

/** The parent a child on this computer reports to, while it is attached to it here. */
function reportingParent(
  readModel: OrchestrationReadModel,
  child: OrchestrationThread,
): OrchestrationThread | null {
  if (
    child.deletedAt !== null ||
    child.parentThreadId === null ||
    !child.attachedToParent ||
    (child.remoteOrigin ?? null) !== null
  ) {
    return null;
  }
  return findThread(readModel, child.parentThreadId);
}

/**
 * The epochs a report from `child` would be delivered under now, or null when
 * the child reports to nobody here (no parent, separated, started over a link).
 */
export function owedReportStamps(
  readModel: OrchestrationReadModel,
  child: OrchestrationThread,
): OwedReportStamps | null {
  const parent = reportingParent(readModel, child);
  return parent === null
    ? null
    : {
        deliveryEpoch: parent.childRequests.deliveryEpoch,
        attachmentEpoch: child.parentAttachmentEpoch,
      };
}

/** What a turn's starting message says about who started it. */
export interface TurnStartOrigin {
  readonly fromThread?: ThreadMessageOrigin | undefined;
  readonly fromOutside?: unknown;
  readonly composer?: unknown;
  readonly sentFrom?: unknown;
  readonly trigger?: string | undefined;
  readonly requestKind?: OrchestrationMessage["requestKind"];
}

/** Whether a message's own turn answers someone other than the thread's parent (rule 2). */
function answersSomeoneElse(origin: TurnStartOrigin): boolean {
  return (
    origin.fromThread?.kind === "request" ||
    personWrote(origin) ||
    origin.fromOutside !== undefined ||
    // A hand-off's reply goes back to the agent that handed off.
    origin.requestKind === "hand_off"
  );
}

/**
 * Whether a turn started by a message owes `child`'s parent a report (rule 2),
 * and under which epochs. Read from the message that starts it, never from
 * what is open when it ends. A continue (`trigger`) is judged by the turn it
 * continues (`continued`, the newest message that is not a continue itself),
 * and answers the request the same decision moves onto it
 * (`continueAnswersRequest`).
 */
export function turnStartOwesReport(
  readModel: OrchestrationReadModel,
  child: OrchestrationThread,
  start: TurnStartOrigin,
  continued: {
    readonly origin: TurnStartOrigin | undefined;
    readonly answersRequest: boolean;
  },
): OwedReportStamps | undefined {
  const stamps = owedReportStamps(readModel, child);
  if (stamps === null) return undefined;
  if (start.trigger !== undefined) {
    if (continued.answersRequest) return undefined;
    const origin = continued.origin;
    // A continue of a turn a request started reports: that request was
    // settled when the turn stopped, unless it was moved onto this one.
    if (origin !== undefined && origin.fromThread?.kind !== "request" && answersSomeoneElse(origin))
      return undefined;
    return stamps;
  }
  return answersSomeoneElse(start) ? undefined : stamps;
}

/**
 * The message a continue continues: the newest message that started a turn
 * for `participantId` before it, skipping continues, messages still queued,
 * messages beside a turn (isTurnAside) and the continue's own message.
 */
export function continuedTurnMessage(
  thread: OrchestrationThread,
  participantId: ThreadParticipantId | null,
  continueMessageId: string,
): OrchestrationMessage | undefined {
  const queued = new Set((thread.queuedFollowUps ?? []).map((entry) => entry.messageId));
  return thread.messages.findLast(
    (message) =>
      message.role === "user" &&
      message.id !== continueMessageId &&
      // A message steered into a turn (the user's, a room agent's reply) is
      // never the one that started it.
      !isTurnAside(message) &&
      message.trigger === undefined &&
      !queued.has(message.id) &&
      (message.participantId ?? null) === participantId,
  );
}

/**
 * Whether the user wrapped a thread up by hand and it still stands: its done
 * override says done and is newer than its newest turn, the test the sidebar
 * files by. Reopening it, or a newer turn, lets reports through again.
 */
export function isWrappedByHand(thread: OrchestrationThread): boolean {
  const override = thread.doneOverride;
  if (override === null || override.state !== "done") return false;
  const turn = thread.latestTurn;
  const lastTurnAt =
    turn === null ? null : (turn.completedAt ?? turn.startedAt ?? turn.requestedAt);
  return lastTurnAt === null || Date.parse(override.at) >= Date.parse(lastTurnAt);
}

/**
 * Why a report owed under `entry` can't be delivered now (rule 7), or null.
 * A dropped report stays dropped.
 */
export function reportDropReason(
  readModel: OrchestrationReadModel,
  child: OrchestrationThread,
  entry: OwedChildReport,
): string | null {
  const parent = reportingParent(readModel, child);
  if (parent === null) return "The child is no longer in its parent's family.";
  if (
    entry.deliveryEpoch !== parent.childRequests.deliveryEpoch ||
    entry.attachmentEpoch !== child.parentAttachmentEpoch
  ) {
    return "Its delivery was cancelled since the turn started.";
  }
  if (parent.archivedAt !== null) return "The parent is archived.";
  if (isWrappedByHand(parent)) return "The parent is wrapped up.";
  if (parent.agentRequests.hold || child.agentRequests.hold) return "The user stopped one of them.";
  return null;
}

/**
 * The agent of `parent` a child's later reports go to: the one whose request
 * started it (`reportsTo`, kept on the child), while that agent is still in
 * the room; otherwise the thread's own. A child started before that was kept
 * reports to the thread's own agent: the parent's history can't say for sure
 * who started it, and the wrong room agent is worse than the thread's own.
 */
export function reportRecipient(
  parent: OrchestrationThread,
  child: Pick<OrchestrationThread, "childRequests">,
): ThreadParticipantId | null {
  const keptId = child.childRequests.reportsTo?.participantId ?? null;
  return keptId !== null &&
    activeParticipants(parent).some((participant) => participant.id === keptId)
    ? keptId
    : null;
}

/**
 * The request id a follow-up report carries, derived from the child and its
 * turn; for a turn that never started, from the owed entry itself, so a
 * message run again is a report of its own.
 */
export const followUpReportRequestId = (
  child: Pick<OrchestrationThread, "id">,
  turnId: TurnId | null,
  entry: OwedChildReport,
) =>
  ChildRequestId.make(
    `report:${child.id}:${turnId ?? `${"messageId" in entry ? entry.messageId : entry.turnId}:${entry.createdAt}`}`,
  );

/**
 * A turn `child` owed its parent a report for is over
 * (`thread.child-report.settle`): with `text`, the report is written into the
 * parent and queued for the agent that started the child, and the child is
 * stamped handed back as of that turn; otherwise, or when rule 7 says no, it
 * is dropped. Either way its entry goes, so a turn is reported once.
 */
export function decideChildReportSettle(
  readModel: OrchestrationReadModel,
  child: OrchestrationThread,
  input: {
    readonly owed: OwedReportKey;
    readonly turnId: TurnId | null;
    readonly text?: string | undefined;
  },
  baseFor: ChildEventBase,
  createdAt: string,
): ChildThreadDecision {
  const entry = (child.childRequests.owedReports ?? []).find((listed) =>
    isOwedReport(listed, input.owed),
  );
  if (entry === undefined) {
    return { refusal: "That report was already settled." };
  }
  const key = owedReportKeyOf(entry);
  const dropped: PlannedEvent = {
    ...baseFor(child.id),
    type: "thread.child-report-dropped",
    payload: { threadId: child.id, owed: key, turnId: input.turnId, createdAt },
  };
  const parent = reportingParent(readModel, child);
  const text = input.text?.trim();
  if (
    parent === null ||
    text === undefined ||
    text.length === 0 ||
    reportDropReason(readModel, child, entry) !== null
  ) {
    return [dropped];
  }
  const requestId = followUpReportRequestId(child, input.turnId, entry);
  const messageId = childReportMessageId(requestId);
  if (parent.messages.some((message) => message.id === messageId)) {
    return [dropped];
  }
  const fromThread = {
    threadId: child.id,
    requestId,
    kind: "report" as const,
    followUp: true as const,
    deliveryEpoch: parent.childRequests.deliveryEpoch,
    attachmentEpoch: child.parentAttachmentEpoch,
  };
  const participantId = reportRecipient(parent, child);
  return [
    {
      ...baseFor(parent.id),
      type: "thread.message-sent",
      payload: {
        threadId: parent.id,
        messageId,
        role: "user",
        text,
        attachments: [],
        participantId,
        fromThread,
        agentModels: messageAgentModels(parent, [
          { participantId, modelSelection: currentAgentModel(parent, participantId) },
        ]),
        turnId: null,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      },
    },
    {
      ...baseFor(parent.id),
      type: "thread.follow-up-queued",
      payload: {
        threadId: parent.id,
        followUp: {
          messageId,
          text,
          attachments: [],
          ...(participantId !== null ? { participantId } : {}),
          fromThread,
          runtimeMode: parent.runtimeMode,
          interactionMode: parent.interactionMode,
          createdAt,
        },
      },
    },
    {
      ...baseFor(child.id),
      type: "thread.handed-back",
      payload: {
        threadId: child.id,
        turnId: input.turnId,
        handedBackAt: createdAt,
        owedReport: key,
      },
    },
  ];
}

/**
 * A turn is starting in `child`, whatever starts it: a parent's request still
 * waiting on the child's background work settles now with its answer so far
 * (rule 4). No later turn is taken for that work coming back.
 */
export function settleWaitingAnswer(
  readModel: OrchestrationReadModel,
  child: OrchestrationThread,
  baseFor: ChildEventBase,
  createdAt: string,
): ReadonlyArray<PlannedEvent> {
  const parent = reportingParent(readModel, child);
  if (parent === null) return [];
  return parent.childRequests.open
    .filter(
      (request) =>
        request.childThreadId === child.id &&
        request.remote === undefined &&
        request.status === "awaiting_background",
    )
    .flatMap((request) => {
      const delivery = childDeliveryForQuietCandidate(child, request);
      if (delivery === null || delivery.type !== "thread.child-request.settle") return [];
      const decision = decideChildRequestSettle(
        readModel,
        parent,
        { ...delivery, threadId: parent.id, createdAt },
        baseFor,
      );
      return "refusal" in decision ? [] : decision;
    });
}
