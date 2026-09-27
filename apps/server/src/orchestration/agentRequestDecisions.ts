/**
 * Room tools: the decider's side of requests one room agent makes of another
 * (docs/design/rooms-slice-2.md, Part B). Each function returns the events to
 * plan, or a refusal to report. The rules for who may ask live in
 * `@threadlines/shared/roomAgentRequests`, shared with the room MCP server.
 */
import type {
  OrchestrationAgentRequest,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationSideTurn,
  OrchestrationSideTurnOutcome,
  OrchestrationThread,
  RoomAgentRef,
  RoomAgentRequestId,
  RoomAgentRequestOutcome,
} from "@threadlines/contracts";
import { agentRequestRefusal } from "@threadlines/shared/roomAgentRequests";
import {
  activeParticipants,
  isRoomThread,
  isValidParticipantId,
} from "@threadlines/shared/threadParticipants";

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;
type EventBase = () => Omit<OrchestrationEvent, "sequence" | "type" | "payload">;
type CommandOf<Type extends OrchestrationCommand["type"]> = Extract<
  OrchestrationCommand,
  { readonly type: Type }
>;

/** Events to plan, or why the command is refused. */
export type AgentRequestDecision = ReadonlyArray<PlannedEvent> | { readonly refusal: string };

const refuse = (refusal: string) => ({ refusal });

const findOpenRequest = (thread: OrchestrationThread, requestId: RoomAgentRequestId) =>
  thread.agentRequests.open.find((request) => request.requestId === requestId);

const isPresent = (thread: OrchestrationThread, agent: RoomAgentRef) =>
  agent.participantId === null ||
  activeParticipants(thread).some((participant) => participant.id === agent.participantId);

const settledEvent = (
  base: EventBase,
  thread: OrchestrationThread,
  request: OrchestrationAgentRequest,
  outcome: RoomAgentRequestOutcome,
  settledAt: string,
  error?: string,
): PlannedEvent => ({
  ...base(),
  type: "thread.agent-request-settled",
  payload: {
    threadId: thread.id,
    requestId: request.requestId,
    requestMessageId: request.requestMessageId,
    outcome,
    ...(error !== undefined ? { error } : {}),
    settledAt,
  },
});

/** An agent's request: its message, its record, and for asks and reviews its side answer. */
export function decideAgentRequestSubmit(
  thread: OrchestrationThread,
  command: CommandOf<"thread.agent-request.submit">,
  base: EventBase,
): AgentRequestDecision {
  if (!isRoomThread(thread)) {
    return refuse("Only a room has other agents to ask.");
  }
  const refusal = agentRequestRefusal(thread, command);
  if (refusal !== null) {
    return refuse(refusal.detail);
  }
  if (findOpenRequest(thread, command.requestId) !== undefined) {
    return refuse(`Request '${command.requestId}' was already made.`);
  }
  if (thread.messages.some((message) => message.id === command.message.messageId)) {
    return refuse(`Message '${command.message.messageId}' was already sent.`);
  }
  const answersOnTheSide = command.kind !== "hand_off";
  if (answersOnTheSide) {
    // The id ends up in the side runtime's session key; see threadParticipants.
    if (command.sideTurnId === undefined || !isValidParticipantId(command.sideTurnId)) {
      return refuse("An ask or a review needs a side answer id that is a UUID.");
    }
    const sideTurnId = command.sideTurnId;
    if (thread.messages.some((message) => message.sideTurnId === sideTurnId)) {
      return refuse(`Side answer '${sideTurnId}' was already asked.`);
    }
    if (thread.voiceActive === true) {
      return refuse("Voice is on. Agents cannot ask each other while it is.");
    }
  } else if (command.sideTurnId !== undefined) {
    return refuse("A hand-off has no side answer.");
  }
  if ((command.kind === "review") !== (command.reviewInput !== undefined)) {
    return refuse("A review, and only a review, carries its captured input.");
  }
  const target =
    command.to.participantId === null
      ? null
      : (activeParticipants(thread).find((entry) => entry.id === command.to.participantId) ?? null);
  const messageSent: PlannedEvent = {
    ...base(),
    type: "thread.message-sent",
    payload: {
      threadId: thread.id,
      messageId: command.message.messageId,
      role: "user",
      text: command.message.text,
      attachments: [],
      participantId: command.to.participantId,
      ...(command.sideTurnId !== undefined ? { sideTurnId: command.sideTurnId } : {}),
      fromAgent: command.from,
      requestId: command.requestId,
      requestKind: command.kind,
      ...(command.reviewInput !== undefined ? { reviewInput: command.reviewInput } : {}),
      turnId: null,
      streaming: false,
      createdAt: command.createdAt,
      updatedAt: command.createdAt,
    },
  };
  const submitted: PlannedEvent = {
    ...base(),
    type: "thread.agent-request-submitted",
    payload: {
      threadId: thread.id,
      request: {
        requestId: command.requestId,
        kind: command.kind,
        from: command.from,
        to: command.to,
        callerTurnId: command.callerTurnId,
        chainEpoch: command.chainEpoch,
        // A hand-off waits for the turn that made it to complete.
        status: answersOnTheSide ? "running" : "pending",
        requestMessageId: command.message.messageId,
        ...(command.sideTurnId !== undefined ? { sideTurnId: command.sideTurnId } : {}),
        createdAt: command.createdAt,
      },
    },
  };
  if (!answersOnTheSide || command.sideTurnId === undefined) {
    return [messageSent, submitted];
  }
  const sideTurn: OrchestrationSideTurn = {
    sideTurnId: command.sideTurnId,
    participantId: command.to.participantId,
    messageId: command.message.messageId,
    status: "starting",
    startedAt: command.createdAt,
    kind: command.kind === "review" ? "review" : "ask",
    askedBy: command.from,
    requestId: command.requestId,
  };
  return [
    messageSent,
    submitted,
    {
      ...base(),
      type: "thread.side-turn-started",
      payload: {
        threadId: thread.id,
        sideTurn,
        modelSelection: target?.modelSelection ?? thread.modelSelection,
      },
    },
  ];
}

/**
 * The turn that made a hand-off completed: its target's turn joins the queue.
 * The queued entry carries no model: the target's current one applies when it
 * runs, so a model change in between is picked up rather than overruled.
 */
export function decideAgentRequestQueue(
  thread: OrchestrationThread,
  command: CommandOf<"thread.agent-request.queue">,
  base: EventBase,
): AgentRequestDecision {
  const request = findOpenRequest(thread, command.requestId);
  if (request === undefined || request.kind !== "hand_off" || request.status !== "pending") {
    return refuse(`Request '${command.requestId}' is not a hand-off waiting to be queued.`);
  }
  if (!isPresent(thread, request.to)) {
    return [
      settledEvent(
        base,
        thread,
        request,
        "cancelled",
        command.createdAt,
        "The agent left the room.",
      ),
    ];
  }
  const message = thread.messages.find((entry) => entry.id === request.requestMessageId);
  if (message === undefined) {
    return [
      settledEvent(base, thread, request, "failed", command.createdAt, "The request was lost."),
    ];
  }
  return [
    {
      ...base(),
      type: "thread.follow-up-queued",
      payload: {
        threadId: thread.id,
        followUp: {
          messageId: request.requestMessageId,
          text: message.text,
          attachments: [],
          ...(request.to.participantId !== null ? { participantId: request.to.participantId } : {}),
          fromAgent: request.from,
          requestId: request.requestId,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: command.createdAt,
        },
      },
    },
    {
      ...base(),
      type: "thread.agent-request-updated",
      payload: {
        threadId: thread.id,
        requestId: request.requestId,
        status: "queued",
        updatedAt: command.createdAt,
      },
    },
  ];
}

/**
 * A hand-off is over. An answered one queues its target's reply back to the
 * caller in the same step, unless Stop came since or the caller left. The
 * reply's message id comes from the caller of this command, derived from the
 * request, so routing it twice finds it already sent.
 */
export function decideAgentRequestSettle(
  thread: OrchestrationThread,
  command: CommandOf<"thread.agent-request.settle">,
  base: EventBase,
): AgentRequestDecision {
  const request = findOpenRequest(thread, command.requestId);
  if (request === undefined) {
    return refuse(`Request '${command.requestId}' is not open.`);
  }
  // An ask or review settles with its side answer, unless that answer is
  // already gone (a restart) or ran out of time, and then it is closed
  // directly; its side answer is stopped next and finds it already closed.
  if (
    request.kind !== "hand_off" &&
    thread.sideTurn?.requestId === request.requestId &&
    command.outcome !== "timeout"
  ) {
    return refuse("Asks and reviews settle with their side answer.");
  }
  const settled = settledEvent(
    base,
    thread,
    request,
    command.outcome,
    command.createdAt,
    command.error,
  );
  const reply = command.reply;
  if (
    command.outcome !== "answered" ||
    reply === undefined ||
    request.chainEpoch !== thread.agentRequests.chainEpoch ||
    !isPresent(thread, request.from) ||
    thread.messages.some((message) => message.id === reply.messageId)
  ) {
    return [settled];
  }
  return [
    settled,
    {
      ...base(),
      type: "thread.message-sent",
      payload: {
        threadId: thread.id,
        messageId: reply.messageId,
        role: "user",
        text: reply.text,
        attachments: [],
        participantId: request.from.participantId,
        fromAgent: request.to,
        requestId: request.requestId,
        requestKind: "reply",
        turnId: null,
        streaming: false,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      },
    },
    {
      ...base(),
      type: "thread.follow-up-queued",
      payload: {
        threadId: thread.id,
        followUp: {
          messageId: reply.messageId,
          text: reply.text,
          attachments: [],
          ...(request.from.participantId !== null
            ? { participantId: request.from.participantId }
            : {}),
          fromAgent: request.to,
          requestId: request.requestId,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: command.createdAt,
        },
      },
    },
  ];
}

/** An ask or review settles with its side answer, in the same step. */
export function settleAgentRequestForSideTurn(
  thread: OrchestrationThread,
  sideTurn: OrchestrationSideTurn,
  outcome: OrchestrationSideTurnOutcome,
  answered: boolean,
  base: EventBase,
  settledAt: string,
  error?: string,
): ReadonlyArray<PlannedEvent> {
  const request =
    sideTurn.requestId === undefined ? undefined : findOpenRequest(thread, sideTurn.requestId);
  if (request === undefined) {
    return [];
  }
  const mapped: RoomAgentRequestOutcome =
    outcome === "completed"
      ? answered
        ? "answered"
        : "failed"
      : outcome === "failed"
        ? "failed"
        : "stopped";
  return [settledEvent(base, thread, request, mapped, settledAt, error)];
}

/**
 * Stop in a room ends the agents' chain for good: the hold goes on, the epoch
 * moves, every open request is stopped, an agent's side answer is stopped,
 * and messages agents queued are taken back. The user's own side answer and
 * queued messages are left alone.
 */
export function decideAgentChainStop(
  thread: OrchestrationThread,
  base: EventBase,
  createdAt: string,
): ReadonlyArray<PlannedEvent> {
  if (!isRoomThread(thread)) {
    return [];
  }
  const state = thread.agentRequests;
  const sideTurn = thread.sideTurn ?? null;
  return [
    {
      ...base(),
      type: "thread.agent-requests-held",
      payload: { threadId: thread.id, chainEpoch: state.chainEpoch + 1, createdAt },
    },
    ...state.open.map((request) => settledEvent(base, thread, request, "stopped", createdAt)),
    ...(sideTurn !== null && sideTurn.askedBy !== undefined && sideTurn.status !== "cancelling"
      ? [
          {
            ...base(),
            type: "thread.side-turn-interrupt-requested" as const,
            payload: { threadId: thread.id, sideTurnId: sideTurn.sideTurnId, createdAt },
          },
        ]
      : []),
    ...(thread.queuedFollowUps ?? [])
      .filter((queued) => queued.fromAgent !== undefined)
      .map((queued): PlannedEvent => ({
        ...base(),
        type: "thread.follow-up-unqueued",
        payload: {
          threadId: thread.id,
          messageId: queued.messageId,
          reason: "cancelled",
          createdAt,
        },
      })),
  ];
}

/** The user wrote: the hold comes off and the agents' count starts over. */
export function resetAgentRequestsForUser(
  thread: OrchestrationThread,
  base: EventBase,
  createdAt: string,
): ReadonlyArray<PlannedEvent> {
  const state = thread.agentRequests;
  if (!state.hold && state.requestsSinceUser === 0) {
    return [];
  }
  return [
    {
      ...base(),
      type: "thread.agent-requests-reset",
      payload: { threadId: thread.id, createdAt },
    },
  ];
}

/**
 * An agent leaves: requests to or from it are cancelled, and messages agents
 * queued for it or from it are taken back instead of going to another agent.
 */
export function cancelAgentRequestsForLeaving(
  thread: OrchestrationThread,
  participantId: OrchestrationThread["participants"][number]["id"],
  base: EventBase,
  createdAt: string,
): ReadonlyArray<PlannedEvent> {
  const involves = (agent: RoomAgentRef) => agent.participantId === participantId;
  return [
    ...thread.agentRequests.open
      .filter((request) => involves(request.from) || involves(request.to))
      .map((request) =>
        settledEvent(base, thread, request, "cancelled", createdAt, "The agent left the room."),
      ),
    ...(thread.queuedFollowUps ?? [])
      .filter(
        (queued) =>
          queued.fromAgent !== undefined &&
          (queued.participantId === participantId || involves(queued.fromAgent)),
      )
      .map((queued): PlannedEvent => ({
        ...base(),
        type: "thread.follow-up-unqueued",
        payload: {
          threadId: thread.id,
          messageId: queued.messageId,
          reason: "cancelled",
          createdAt,
        },
      })),
  ];
}

/** Whether an agent has requests waiting on it or from it. */
export const hasOpenAgentRequests = (
  thread: OrchestrationThread,
  participantId: OrchestrationThread["participants"][number]["id"],
): boolean =>
  thread.agentRequests.open.some(
    (request) =>
      request.from.participantId === participantId || request.to.participantId === participantId,
  );
