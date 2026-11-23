/**
 * Child threads: when a child's work is an answer for its parent or a report
 * to it, and what it says (docs/design/child-threads.md, "Delivery", and
 * docs/design/agent-autonomy-no-limits.md, "Delivery rules"). Pure: runtime
 * ingestion calls it once a child's turn has ended and its words are final
 * (or its runtime exited with the turn), the reactor once a child that was
 * finishing background work goes quiet, and startup for whatever a restart
 * cut off. Each returns the command to dispatch, or null when the turn
 * answers nothing. The same rules decide a child's answers to a parent on a
 * linked computer (LinkRequests), whose requests live in a ledger rather than
 * on a parent here, and which owes no reports.
 */
import {
  type ChildRequestOutcome,
  CommandId,
  type MessageId,
  type OrchestrationChildRequest,
  type OrchestrationThread,
  type OwedChildReport,
  type OwedReportKey,
  type TurnId,
} from "@threadlines/contracts";
import { isOwedReport, owedReportKeyOf } from "@threadlines/shared/childThreads";

import { childReportMessageId, childReportText } from "./childThreadDecisions.ts";
import { turnStartingMessage } from "./continueTurns.ts";

/** What the delivery rules read of a request, wherever it is kept. */
export type ChildDeliveryRequest = Pick<
  OrchestrationChildRequest,
  "requestId" | "status" | "childMessageId" | "candidateTurnId"
>;

/** How a child's turn ended. */
export interface ChildTurnEnd {
  readonly turnId: TurnId;
  readonly outcome: "completed" | "failed" | "interrupted";
  readonly error?: string | undefined;
}

export type ChildDelivery =
  | {
      readonly type: "thread.child-request.update";
      readonly commandId: CommandId;
      readonly requestId: OrchestrationChildRequest["requestId"];
      readonly status: "awaiting_background";
      readonly candidateTurnId: TurnId;
    }
  | {
      readonly type: "thread.child-request.settle";
      readonly commandId: CommandId;
      readonly requestId: OrchestrationChildRequest["requestId"];
      readonly outcome: ChildRequestOutcome;
      readonly reply: {
        readonly messageId: MessageId;
        readonly text: string;
        readonly turnId: TurnId | null;
      };
      readonly error?: string;
    };

/** A turn's last saved answer: its final assistant message with words in it. */
export function lastAnswerOfTurn(
  thread: Pick<OrchestrationThread, "messages">,
  turnId: TurnId,
): string | undefined {
  return [...thread.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" && message.turnId === turnId && message.text.trim().length > 0,
    )?.text;
}

const settleCommandId = (requestId: OrchestrationChildRequest["requestId"]) =>
  CommandId.make(`server:child-request:${requestId}:settle`);

function settle(
  request: ChildDeliveryRequest,
  outcome: ChildRequestOutcome,
  text: string,
  turnId: TurnId | null,
  error?: string,
): ChildDelivery {
  return {
    type: "thread.child-request.settle",
    commandId: settleCommandId(request.requestId),
    requestId: request.requestId,
    outcome,
    reply: { messageId: childReportMessageId(request.requestId), text, turnId },
    ...(error !== undefined ? { error } : {}),
  };
}

/** What the child had said so far, for an answer cut short. */
const partialAnswer = (
  child: Pick<OrchestrationThread, "messages">,
  request: ChildDeliveryRequest,
) => {
  const candidate =
    request.candidateTurnId === undefined
      ? undefined
      : lastAnswerOfTurn(child, request.candidateTurnId);
  return candidate === undefined
    ? ""
    : `\n\nIts last reply before that:\n\n${childReportText(candidate)}`;
};

/** What the parent is told of a turn that ended without being stopped (rule 5). */
export const stoppedBeforeFinishedText = (title: string, reason: string) =>
  `'${title}' stopped before it finished: ${reason.replace(/\.$/, "")}. Send it a message with thread_send to continue.`;

/**
 * Whether a turn that ended interrupted was stopped on purpose: it is the
 * turn a Stop named (rule 6). A runtime that died, the idle reaper, or a
 * stream that ended mid-turn names none, and is never the user's doing.
 */
export const stoppedOnPurpose = (child: Pick<OrchestrationThread, "session">, turnId: TurnId) =>
  (child.session?.stopRequestedTurnId ?? null) === turnId;

/**
 * A child's turn ended. It answers the request whose message started it, and
 * nothing else: a turn no message started never continues a request waiting
 * on background work (rule 4; the turn's start settled that one). With
 * background work still owed, the answer waits for it (`awaiting_background`,
 * keeping this turn as the answer so far).
 */
export function childDeliveryForTurnEnd(input: {
  /** The child's open requests: on its parent here, or in the link ledger. */
  readonly owned: ReadonlyArray<ChildDeliveryRequest>;
  readonly child: OrchestrationThread;
  readonly end: ChildTurnEnd;
  /** The message that started the ended turn, if any. */
  readonly pendingMessageId: MessageId | null;
  /** The child's background work it still waits on, as of the turn's end. */
  readonly awaitedBackgroundTaskCount: number;
  /**
   * A linked computer's ledger: a turn no message started still continues a
   * request waiting on background work, since nothing else brings a linked
   * child's later work back (rule 15).
   */
  readonly continuesWaitingAnswer?: boolean;
}): ChildDelivery | null {
  const { owned, child, end } = input;
  const request =
    owned.find(
      (entry) =>
        input.pendingMessageId !== null &&
        entry.status === "running" &&
        entry.childMessageId === input.pendingMessageId,
    ) ??
    (input.continuesWaitingAnswer === true && input.pendingMessageId === null
      ? owned.find(
          (entry) =>
            entry.status === "awaiting_background" &&
            entry.candidateTurnId !== undefined &&
            entry.candidateTurnId !== end.turnId,
        )
      : undefined);
  if (request === undefined) {
    return null;
  }
  if (end.outcome === "completed") {
    if (input.awaitedBackgroundTaskCount > 0) {
      return {
        type: "thread.child-request.update",
        commandId: CommandId.make(
          `server:child-request:${request.requestId}:background:${end.turnId}`,
        ),
        requestId: request.requestId,
        status: "awaiting_background",
        candidateTurnId: end.turnId,
      };
    }
    return settle(
      request,
      "answered",
      childReportText(lastAnswerOfTurn(child, end.turnId)),
      end.turnId,
    );
  }
  if (end.outcome === "failed") {
    // A usage limit paused it: the request waits for the continue at the
    // reset, which answers it (docs/design/lead-chat.md, "Usage limits").
    if (isHeldByContinueAtReset(child, request)) {
      return null;
    }
    const error = end.error ?? "Its turn did not finish.";
    return settle(
      request,
      "failed",
      `'${child.title}' failed: ${error}${partialAnswer(child, request)}`,
      end.turnId,
      error,
    );
  }
  if (!stoppedOnPurpose(child, end.turnId)) {
    const reason = end.error ?? "its runtime stopped";
    return settle(
      request,
      "failed",
      `${stoppedBeforeFinishedText(child.title, reason)}${partialAnswer(child, request)}`,
      end.turnId,
      reason,
    );
  }
  return settle(
    request,
    "stopped",
    `The user stopped '${child.title}' before it finished.${partialAnswer(child, request)}`,
    end.turnId,
  );
}

/** A report a child's ended turn owed its parent: the command that settles it. */
export interface ChildReportDelivery {
  readonly type: "thread.child-report.settle";
  readonly commandId: CommandId;
  readonly owed: OwedReportKey;
  readonly turnId: TurnId | null;
  readonly text?: string;
}

/**
 * The settle's command id, from the owed entry itself: the same entry settles
 * once however often it is routed, and a new entry for the same message (a
 * resend runs it again) is a settle of its own.
 */
const reportSettleCommandId = (child: Pick<OrchestrationThread, "id">, entry: OwedChildReport) =>
  CommandId.make(
    `server:child-report:${child.id}:${"messageId" in entry ? `message:${entry.messageId}` : `turn:${entry.turnId}`}:${entry.createdAt}:settle`,
  );

/** The owed entry a turn settles: keyed by the turn, or by the message that started it. */
export function owedEntryForTurn(
  child: Pick<OrchestrationThread, "childRequests">,
  turnId: TurnId,
  pendingMessageId: MessageId | null,
): OwedChildReport | undefined {
  return (child.childRequests.owedReports ?? []).find(
    (entry) =>
      isOwedReport(entry, { turnId }) ||
      (pendingMessageId !== null && isOwedReport(entry, { messageId: pendingMessageId })),
  );
}

/**
 * What a turn that ended failed says (rule 5), with the reports from its own
 * threads waiting in it unread (rule 10), and whether it goes on by itself.
 */
export function reportFailureText(child: OrchestrationThread, error: string): string {
  const waiting = (child.queuedFollowUps ?? []).filter(
    (queued) => queued.fromThread?.kind === "report",
  ).length;
  const failed = `'${child.title}' failed: ${error.replace(/\.$/, "")}.`;
  if ((child.session?.continueAtReset ?? null) !== null) {
    return `${failed} It continues by itself when the limit resets.`;
  }
  if (waiting === 0) {
    return `${failed} Send it a message with thread_send to continue.`;
  }
  const reports =
    waiting === 1 ? "1 report from its threads is" : `${waiting} reports from its threads are`;
  return `${failed} ${reports} waiting in it unread. Send it a message with thread_send and it reads them first.`;
}

/**
 * The report an ended turn owed (rules 5 and 6): its reply when it completed,
 * its failure, or "stopped before it finished" when it was cut off without a
 * Stop naming it. Nothing to say (stopped on purpose, completed with no
 * reply) settles it as dropped. Null when the turn owed nothing.
 */
export function childReportForTurnEnd(input: {
  readonly child: OrchestrationThread;
  readonly end: ChildTurnEnd;
  readonly pendingMessageId: MessageId | null;
}): ChildReportDelivery | null {
  const { child, end } = input;
  const entry = owedEntryForTurn(child, end.turnId, input.pendingMessageId);
  if (entry === undefined) return null;
  const owed = owedReportKeyOf(entry);
  const text =
    end.outcome === "completed"
      ? reportReplyText(child, end.turnId)
      : end.outcome === "failed"
        ? reportFailureText(child, end.error ?? "Its turn did not finish.")
        : stoppedOnPurpose(child, end.turnId)
          ? undefined
          : stoppedBeforeFinishedText(child.title, end.error ?? "its runtime stopped");
  return {
    type: "thread.child-report.settle",
    commandId: reportSettleCommandId(child, entry),
    owed,
    turnId: end.turnId,
    ...(text !== undefined ? { text } : {}),
  };
}

/** A turn's reply as a report, clipped as answers are; undefined when it said nothing. */
function reportReplyText(child: OrchestrationThread, turnId: TurnId): string | undefined {
  const reply = lastAnswerOfTurn(child, turnId)?.trim();
  return reply === undefined || reply.length === 0 ? undefined : childReportText(reply);
}

/**
 * A child's turn ended: the request it answers settles, or the report it
 * owed does. Never both: a turn a request started owes no report (rule 2).
 * The turn end, the exit that took a turn with it, and startup all call this.
 */
export function childDeliveryForEndedTurn(input: {
  readonly owned: ReadonlyArray<ChildDeliveryRequest>;
  readonly child: OrchestrationThread;
  readonly end: ChildTurnEnd;
  readonly pendingMessageId: MessageId | null;
  readonly awaitedBackgroundTaskCount: number;
}): ChildDelivery | ChildReportDelivery | null {
  return childDeliveryForTurnEnd(input) ?? childReportForTurnEnd(input);
}

/**
 * A turn is starting: what the thread still owes for earlier turns, each
 * settled as a turn that ended without being stopped (rule 3). The starting
 * turn's entry, and the entries of `messageIds` (a message still waiting to
 * start, or the one bound to this turn), are kept.
 */
export function staleOwedReports(
  child: OrchestrationThread,
  keep: { readonly turnId: TurnId; readonly messageIds: ReadonlyArray<MessageId> },
): ReadonlyArray<ChildReportDelivery> {
  return (child.childRequests.owedReports ?? [])
    .filter(
      (entry) =>
        !isOwedReport(entry, { turnId: keep.turnId }) &&
        !keep.messageIds.some((messageId) => isOwedReport(entry, { messageId })),
    )
    .map((entry) => {
      const owed = owedReportKeyOf(entry);
      return {
        type: "thread.child-report.settle" as const,
        commandId: reportSettleCommandId(child, entry),
        owed,
        turnId: "turnId" in entry ? entry.turnId : null,
        text: stoppedBeforeFinishedText(
          child.title,
          "its turn ended without its reply reaching Threadlines",
        ),
      };
    });
}

/**
 * An owed turn a restart cut off or left unreported (rule 14): a completed
 * turn is delivered, a failed one delivers its failure, and one the restart
 * cut off (or that never started) says so.
 */
export function childReportAfterRestart(
  child: OrchestrationThread,
  entry: OwedChildReport,
  turn: { readonly turnId: TurnId | null; readonly state: string } | undefined,
): ChildReportDelivery {
  const owed = owedReportKeyOf(entry);
  const turnId = turn?.turnId ?? ("turnId" in entry ? entry.turnId : null);
  const text =
    turn?.state === "completed" && turnId !== null
      ? reportReplyText(child, turnId)
      : turn?.state === "error"
        ? reportFailureText(child, child.session?.lastError ?? "Its turn did not finish.")
        : `'${child.title}' was interrupted by a Threadlines restart. Send it a message with thread_send to continue.`;
  return {
    type: "thread.child-report.settle",
    commandId: reportSettleCommandId(child, entry),
    owed,
    turnId,
    ...(text !== undefined ? { text } : {}),
  };
}

/**
 * Whether a parent's request is held open by the child's wait to continue
 * after a usage limit (docs/design/lead-chat.md, "Usage limits"): the child
 * waits to continue at the reset, and the request is `running` and answered
 * by the turn that stopped on the limit. Only such a request is held: one
 * waiting on background work (`awaiting_background`) follows its own path.
 */
export function isHeldByContinueAtReset(
  child: OrchestrationThread,
  request: ChildDeliveryRequest,
): boolean {
  const session = child.session;
  return (
    session !== null &&
    (session.continueAtReset ?? null) !== null &&
    request.status === "running" &&
    request.childMessageId === failedTurnMessage(child)?.id
  );
}

/**
 * The message that started the child's last turn, not counting messages still
 * waiting in its queue: an agent's message is written into the chat when it
 * is queued, so the newest user message may not have run yet.
 */
export function failedTurnMessage(child: OrchestrationThread) {
  const session = child.session;
  if (session === null) return undefined;
  const queued = new Set((child.queuedFollowUps ?? []).map((entry) => entry.messageId));
  if (queued.size === 0) return turnStartingMessage(child, session);
  return turnStartingMessage(
    { ...child, messages: child.messages.filter((message) => !queued.has(message.id)) },
    session,
  );
}

/**
 * A held request whose wait ended without its continue: it settles as it
 * would have when its turn stopped, with why it did not go on.
 */
export function heldRequestEnded(
  child: OrchestrationThread,
  request: ChildDeliveryRequest,
  outcome: "failed" | "stopped",
  why: string,
): Extract<ChildDelivery, { readonly type: "thread.child-request.settle" }> {
  const text =
    outcome === "stopped"
      ? `The user stopped '${child.title}' while it waited for a usage limit to reset.`
      : `'${child.title}' stopped on a usage limit and won't continue: ${why}`;
  const delivery = settle(request, outcome, `${text}${partialAnswer(child, request)}`, null);
  return {
    ...(delivery as Extract<ChildDelivery, { readonly type: "thread.child-request.settle" }>),
    ...(outcome === "failed" ? { error: why } : {}),
  };
}

/**
 * A child whose turn ended while it waited on background work has gone quiet
 * with nothing left running and no follow-up turn: its answer so far stands.
 */
export function childDeliveryForQuietCandidate(
  child: OrchestrationThread,
  request: ChildDeliveryRequest,
): ChildDelivery | null {
  if (request.status !== "awaiting_background" || request.candidateTurnId === undefined) {
    return null;
  }
  return settle(
    request,
    "answered",
    childReportText(lastAnswerOfTurn(child, request.candidateTurnId)),
    request.candidateTurnId,
  );
}

/**
 * Whether a child that was finishing background work has truly gone quiet: no
 * turn since the answer so far, nothing running, nothing owed, nothing queued.
 */
export function isQuietCandidate(
  child: OrchestrationThread,
  request: ChildDeliveryRequest,
): boolean {
  const session = child.session;
  return (
    request.status === "awaiting_background" &&
    request.candidateTurnId !== undefined &&
    child.latestTurn?.turnId === request.candidateTurnId &&
    child.latestTurn.state !== "running" &&
    (session === null ||
      (session.status !== "running" &&
        session.status !== "starting" &&
        session.activeTurnId === null &&
        (session.awaitedBackgroundTaskCount ?? 0) === 0)) &&
    (child.queuedFollowUps ?? []).length === 0
  );
}

/**
 * The turn that durably finished a request's answer before a restart, if one
 * did: the turn its message started. No later turn is looked for (rule 4),
 * except in a linked computer's ledger (`continuesWaitingAnswer`, rule 15):
 * there an answer waiting on background work takes the latest follow-up that
 * work started on its own.
 */
export function finishedTurnAfterRestart(
  childTurns: ReadonlyArray<{
    readonly turnId: TurnId | null;
    readonly pendingMessageId: MessageId | null;
    readonly state: string;
    readonly requestedAt: string;
    readonly completedAt: string | null;
  }>,
  request: ChildDeliveryRequest,
  options: { readonly continuesWaitingAnswer?: boolean } = {},
): TurnId | null {
  const candidateEnded =
    childTurns.find((entry) => entry.turnId === request.candidateTurnId)?.completedAt ?? "";
  const finishedTurn =
    request.status === "running"
      ? childTurns.find(
          (turn) => turn.pendingMessageId === request.childMessageId && turn.state === "completed",
        )
      : request.status === "awaiting_background" && options.continuesWaitingAnswer === true
        ? childTurns
            .filter(
              (turn) =>
                turn.state === "completed" &&
                turn.pendingMessageId === null &&
                turn.turnId !== null &&
                turn.turnId !== request.candidateTurnId &&
                turn.requestedAt >= candidateEnded,
            )
            .toSorted((left, right) => left.requestedAt.localeCompare(right.requestedAt))
            .at(-1)
        : undefined;
  return finishedTurn?.turnId ?? null;
}

/**
 * A request a server restart cut off: an answer that durably finished is
 * delivered, and one waiting on background work settles with its answer so
 * far; anything else is reported as interrupted, with what the child had
 * said so far, so the agent that asked can send it a message to continue.
 */
export function childDeliveryAfterRestart(
  child: OrchestrationThread,
  request: ChildDeliveryRequest,
  finishedTurnId: TurnId | null,
  options: { readonly continuesWaitingAnswer?: boolean } = {},
): ChildDelivery {
  const waiting =
    finishedTurnId === null && options.continuesWaitingAnswer !== true
      ? childDeliveryForQuietCandidate(child, request)
      : null;
  if (waiting !== null) return waiting;
  if (finishedTurnId !== null) {
    return settle(
      request,
      "answered",
      childReportText(lastAnswerOfTurn(child, finishedTurnId)),
      finishedTurnId,
    );
  }
  const error = "Threadlines restarted while it was working.";
  return settle(
    request,
    "failed",
    `'${child.title}' was interrupted by a Threadlines restart. Send it a message with thread_send to continue.${partialAnswer(child, request)}`,
    null,
    error,
  );
}
