/**
 * Child threads: when a child's work is an answer for its parent, and what
 * that answer says (docs/design/child-threads.md, "Delivery"). Pure: runtime
 * ingestion calls it once a child's turn has ended and its words are final,
 * the reactor once a child that was finishing background work goes quiet,
 * and startup for whatever a restart cut off. Each returns the command to
 * dispatch, or null when the turn answers nothing. The same rules decide a
 * child's answers to a parent on a linked computer (LinkRequests), whose
 * requests live in a ledger rather than on a parent here.
 */
import {
  type ChildRequestOutcome,
  CommandId,
  type MessageId,
  type OrchestrationChildRequest,
  type OrchestrationThread,
  type TurnId,
} from "@threadlines/contracts";

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

/**
 * A child's turn ended. It answers the request whose message started it, or,
 * for a request whose turn already ended while the child kept waiting on its
 * own background work, the follow-up turn that work started. With background
 * work still owed, the answer waits for it (`awaiting_background`, keeping
 * this turn as the answer so far).
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
}): ChildDelivery | null {
  const { owned, child, end } = input;
  // The request whose own message started this turn comes first. Only a turn
  // no message started (the follow-up a child's background work starts on
  // its own) continues a request waiting on that work; a turn the parent or
  // the user started answers its own message, never an older request.
  const request =
    owned.find(
      (entry) => entry.status === "running" && entry.childMessageId === input.pendingMessageId,
    ) ??
    (input.pendingMessageId === null
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
  return settle(
    request,
    "stopped",
    `The user stopped '${child.title}' before it finished.${partialAnswer(child, request)}`,
    end.turnId,
  );
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
 * did: the turn its message started, or, for an answer waiting on background
 * work, the latest follow-up that work started on its own.
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
): TurnId | null {
  const candidateEnded =
    childTurns.find((entry) => entry.turnId === request.candidateTurnId)?.completedAt ?? "";
  const finishedTurn =
    request.status === "running"
      ? childTurns.find(
          (turn) => turn.pendingMessageId === request.childMessageId && turn.state === "completed",
        )
      : request.status === "awaiting_background"
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
 * delivered; anything else is reported as interrupted, with what the child had
 * said so far, so the agent that asked can send it a message to continue.
 */
export function childDeliveryAfterRestart(
  child: OrchestrationThread,
  request: ChildDeliveryRequest,
  finishedTurnId: TurnId | null,
): ChildDelivery {
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
