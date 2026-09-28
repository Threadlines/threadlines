/**
 * Room tools: the decider's side of requests one room agent makes of another
 * (docs/design/rooms-slice-2.md, Part B). Each function returns the events to
 * plan, or a refusal to report. The rules for who may ask live in
 * `@threadlines/shared/roomAgentRequests`, shared with the room MCP server.
 */
import {
  MessageId,
  type OrchestrationAgentRequest,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSideTurn,
  type OrchestrationSideTurnOutcome,
  type OrchestrationThread,
  type OrchestrationThreadParticipant,
  type RoomAgentRef,
  type RoomAgentRequestId,
  type RoomAgentRequestOutcome,
} from "@threadlines/contracts";
import {
  agentInviteAcceptRefusal,
  agentInviteRefusal,
  agentRequestRefusal,
} from "@threadlines/shared/roomAgentRequests";
import {
  activeParticipants,
  findActiveParticipantByHandle,
  hasAgentRecords,
  isRoomThread,
  isValidParticipantId,
} from "@threadlines/shared/threadParticipants";

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;
type EventBase = () => Omit<OrchestrationEvent, "sequence" | "type" | "payload">;
type CommandOf<Type extends OrchestrationCommand["type"]> = Extract<
  OrchestrationCommand,
  { readonly type: Type }
>;

/** How much of a hand-off's reply goes back to the agent that handed off. */
const HAND_OFF_REPLY_CHAR_LIMIT = 24_000;

/** A hand-off's reply as the agent that handed off receives it. */
export function handOffReplyText(text: string | undefined): string {
  const trimmed = text?.trim() ?? "";
  if (trimmed.length === 0) {
    return "(The agent finished without writing a reply.)";
  }
  return trimmed.length > HAND_OFF_REPLY_CHAR_LIMIT
    ? `${trimmed.slice(0, HAND_OFF_REPLY_CHAR_LIMIT)} [clipped; the full reply is in the chat]`
    : trimmed;
}

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
  if (command.kind === "invite") {
    return decideAgentInviteSubmit(thread, command, base);
  }
  if (command.invite !== undefined) {
    return refuse("Only an invite brings in another agent.");
  }
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

/** The review message an accepted invite's side answer answers. */
export const inviteReviewMessageId = (requestId: RoomAgentRequestId) =>
  MessageId.make(`invite-review:${requestId}`);

/** The message an invite's review comes back to its caller as. */
export const inviteReplyMessageId = (requestId: RoomAgentRequestId) =>
  MessageId.make(`invite-reply:${requestId}`);

/**
 * An agent asks the user to bring in an agent the thread does not have, for
 * an independent review (docs/design/rooms-agent-invites.md). The agent is
 * recorded as a guest in the same step, so its review keeps an author. The
 * invite waits for the user, unless `autoChoice` (the "without asking"
 * setting) decides it now.
 */
function decideAgentInviteSubmit(
  thread: OrchestrationThread,
  command: CommandOf<"thread.agent-request.submit">,
  base: EventBase,
): AgentRequestDecision {
  const invite = command.invite;
  if (invite === undefined) {
    return refuse("An invite names the agent it brings in.");
  }
  const refusal = agentInviteRefusal(thread, {
    from: command.from,
    callerTurnId: command.callerTurnId,
    chainEpoch: command.chainEpoch,
    startsNow: invite.autoChoice !== undefined,
  });
  if (refusal !== null) {
    return refuse(refusal.detail);
  }
  const guestId = command.to.participantId;
  // The id ends up in the side runtime's session key; see threadParticipants.
  if (guestId === null || !isValidParticipantId(guestId)) {
    return refuse("An invite brings in a new agent, named by a UUID.");
  }
  if (thread.participants.some((participant) => participant.id === guestId)) {
    return refuse(`Agent '${guestId}' was already brought into this thread.`);
  }
  if (findActiveParticipantByHandle(thread, invite.guest.handle) !== undefined) {
    return refuse(`An agent called ${invite.guest.handle} is already in this thread.`);
  }
  if (findOpenRequest(thread, command.requestId) !== undefined) {
    return refuse(`Request '${command.requestId}' was already made.`);
  }
  if (
    thread.messages.some(
      (message) =>
        message.id === command.message.messageId ||
        message.id === inviteReviewMessageId(command.requestId),
    )
  ) {
    return refuse(`Message '${command.message.messageId}' was already sent.`);
  }
  const sideTurnId = command.sideTurnId;
  if (sideTurnId === undefined || !isValidParticipantId(sideTurnId)) {
    return refuse("An invite needs a side answer id that is a UUID.");
  }
  if (thread.messages.some((message) => message.sideTurnId === sideTurnId)) {
    return refuse(`Side answer '${sideTurnId}' was already asked.`);
  }
  if (command.reviewInput === undefined) {
    return refuse("An invite carries the changes its review is of.");
  }
  const guest: OrchestrationThreadParticipant = {
    id: guestId,
    handle: invite.guest.handle,
    modelSelection: invite.guest.modelSelection,
    joinedAt: command.createdAt,
    leftAt: command.createdAt,
    guest: true,
  };
  const request: OrchestrationAgentRequest = {
    requestId: command.requestId,
    kind: "invite",
    from: command.from,
    to: command.to,
    callerTurnId: command.callerTurnId,
    chainEpoch: command.chainEpoch,
    status: invite.autoChoice !== undefined ? "running" : "awaiting_user",
    requestMessageId: command.message.messageId,
    sideTurnId,
    createdAt: command.createdAt,
  };
  const recorded: ReadonlyArray<PlannedEvent> = [
    {
      ...base(),
      type: "thread.participant-added",
      payload: { threadId: thread.id, participant: guest, updatedAt: command.createdAt },
    },
    {
      ...base(),
      type: "thread.message-sent",
      payload: {
        threadId: thread.id,
        messageId: command.message.messageId,
        role: "user",
        text: command.message.text,
        attachments: [],
        participantId: guestId,
        fromAgent: command.from,
        requestId: command.requestId,
        requestKind: "invite",
        reviewInput: command.reviewInput,
        invite: {
          reason: invite.reason,
          suggestion: invite.suggestion,
          billing: invite.billing,
          ...(invite.autoChoice !== undefined
            ? { choice: invite.autoChoice, automatic: true }
            : {}),
        },
        turnId: null,
        streaming: false,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      },
    },
    {
      ...base(),
      type: "thread.agent-request-submitted",
      payload: { threadId: thread.id, request },
    },
  ];
  if (invite.autoChoice === undefined) {
    return recorded;
  }
  return [
    ...recorded,
    ...inviteAcceptedEvents({
      thread,
      request,
      guest,
      text: command.message.text,
      reviewInput: command.reviewInput,
      choice: invite.autoChoice,
      automatic: true,
      base,
      createdAt: command.createdAt,
    }),
  ];
}

/**
 * The user's answer to an invite. Declining settles it and pauses invites
 * until the user writes. Accepting checks again what may have changed while
 * the user thought it over, then brings the agent in and starts its review.
 */
export function decideAgentInviteRespond(
  thread: OrchestrationThread,
  command: CommandOf<"thread.agent-invite.respond">,
  base: EventBase,
): AgentRequestDecision {
  const request = findOpenRequest(thread, command.requestId);
  if (request === undefined || request.kind !== "invite" || request.status !== "awaiting_user") {
    return refuse("This invite was already answered or is over.");
  }
  if (command.choice === "decline") {
    return [settledEvent(base, thread, request, "declined", command.createdAt)];
  }
  const refusal = agentInviteAcceptRefusal(thread, request);
  if (refusal !== null) {
    return refuse(refusal);
  }
  const guest = thread.participants.find(
    (participant) => participant.id === request.to.participantId && participant.guest === true,
  );
  const message = thread.messages.find((entry) => entry.id === request.requestMessageId);
  if (guest === undefined || message === undefined || message.reviewInput === undefined) {
    return refuse("This invite's record is incomplete. Ask the agent to invite again.");
  }
  // Its name is kept free for it (see findActiveParticipantByHandle), so the
  // room and the chat keep calling it the same.
  if (
    command.choice === "teammate" &&
    activeParticipants(thread).some(
      (participant) => participant.handle.toLowerCase() === guest.handle.toLowerCase(),
    )
  ) {
    return refuse(`An agent called ${guest.handle} is already in this thread.`);
  }
  return inviteAcceptedEvents({
    thread,
    request,
    guest,
    text: message.text,
    reviewInput: message.reviewInput,
    choice: command.choice,
    automatic: false,
    base,
    createdAt: command.createdAt,
  });
}

/**
 * An invite accepted, by the user or by the setting: for a teammate, the
 * guest joins the thread (under a free name); the review is sent as its own
 * message, so the chat shows it like any independent review; its side answer
 * starts.
 */
function inviteAcceptedEvents(input: {
  readonly thread: OrchestrationThread;
  readonly request: OrchestrationAgentRequest;
  readonly guest: OrchestrationThreadParticipant;
  readonly text: string;
  readonly reviewInput: NonNullable<OrchestrationThread["messages"][number]["reviewInput"]>;
  readonly choice: "review" | "teammate";
  readonly automatic: boolean;
  readonly base: EventBase;
  readonly createdAt: string;
}): ReadonlyArray<PlannedEvent> {
  const { thread, request, guest, base, createdAt } = input;
  const sideTurnId = request.sideTurnId;
  if (sideTurnId === undefined) {
    return [];
  }
  const reviewMessageId = inviteReviewMessageId(request.requestId);
  const sideTurn: OrchestrationSideTurn = {
    sideTurnId,
    participantId: guest.id,
    messageId: reviewMessageId,
    status: "starting",
    startedAt: createdAt,
    kind: "review",
    askedBy: request.from,
    requestId: request.requestId,
  };
  return [
    ...(input.choice === "teammate"
      ? [
          {
            ...base(),
            type: "thread.participant-updated" as const,
            payload: {
              threadId: thread.id,
              participantId: guest.id,
              joined: true as const,
              updatedAt: createdAt,
            },
          },
        ]
      : []),
    ...(input.automatic
      ? []
      : [
          {
            ...base(),
            type: "thread.agent-request-updated" as const,
            payload: {
              threadId: thread.id,
              requestId: request.requestId,
              status: "running" as const,
              inviteChoice: {
                requestMessageId: request.requestMessageId,
                choice: input.choice,
                automatic: false,
              },
              updatedAt: createdAt,
            },
          },
        ]),
    {
      ...base(),
      type: "thread.message-sent",
      payload: {
        threadId: thread.id,
        messageId: reviewMessageId,
        role: "user",
        text: input.text,
        attachments: [],
        participantId: guest.id,
        sideTurnId,
        fromAgent: request.from,
        requestId: request.requestId,
        requestKind: "review",
        reviewInput: input.reviewInput,
        turnId: null,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      },
    },
    {
      ...base(),
      type: "thread.side-turn-started",
      payload: { threadId: thread.id, sideTurn, modelSelection: guest.modelSelection },
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
    ...replyEvents(base, thread, request, reply.messageId, reply.text, command.createdAt),
  ];
}

/** A request's answer, sent and queued back to the agent that made it. */
function replyEvents(
  base: EventBase,
  thread: OrchestrationThread,
  request: OrchestrationAgentRequest,
  messageId: MessageId,
  text: string,
  createdAt: string,
): ReadonlyArray<PlannedEvent> {
  return [
    {
      ...base(),
      type: "thread.message-sent",
      payload: {
        threadId: thread.id,
        messageId,
        role: "user",
        text,
        attachments: [],
        participantId: request.from.participantId,
        fromAgent: request.to,
        requestId: request.requestId,
        requestKind: "reply",
        turnId: null,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      },
    },
    {
      ...base(),
      type: "thread.follow-up-queued",
      payload: {
        threadId: thread.id,
        followUp: {
          messageId,
          text,
          attachments: [],
          ...(request.from.participantId !== null
            ? { participantId: request.from.participantId }
            : {}),
          fromAgent: request.to,
          requestId: request.requestId,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt,
        },
      },
    },
  ];
}

/** An ask, review or invite settles with its side answer, in the same step. */
export function settleAgentRequestForSideTurn(
  thread: OrchestrationThread,
  sideTurn: OrchestrationSideTurn,
  outcome: OrchestrationSideTurnOutcome,
  /** Its answer, when it wrote one; final by the time it settles. */
  answer: { readonly text: string } | undefined,
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
      ? answer !== undefined
        ? "answered"
        : "failed"
      : outcome === "failed"
        ? "failed"
        : "stopped";
  const settled = settledEvent(base, thread, request, mapped, settledAt, error);
  // An invite's caller did not wait on a tool call for this: the review
  // comes back to it as its next message, like a hand-off's reply, unless
  // Stop came since or it left.
  const replyId = inviteReplyMessageId(request.requestId);
  if (
    request.kind !== "invite" ||
    mapped !== "answered" ||
    request.chainEpoch !== thread.agentRequests.chainEpoch ||
    !isPresent(thread, request.from) ||
    thread.messages.some((message) => message.id === replyId)
  ) {
    return [settled];
  }
  return [
    settled,
    ...replyEvents(base, thread, request, replyId, handOffReplyText(answer?.text), settledAt),
  ];
}

/**
 * Stop ends the agents' chain for good: the hold goes on, the epoch moves,
 * every open request (an invite waiting for the user included) is stopped,
 * an agent's side answer is stopped, and messages agents queued are taken
 * back. The user's own side answer and queued messages are left alone.
 */
export function decideAgentChainStop(
  thread: OrchestrationThread,
  base: EventBase,
  createdAt: string,
): ReadonlyArray<PlannedEvent> {
  const state = thread.agentRequests;
  // Outside rooms only invites make requests. A thread that never had one has
  // no chain to end; one that did still moves its epoch, so a review's reply
  // already on its way to a turn is caught too.
  if (
    !hasAgentRecords(thread) &&
    state.open.length === 0 &&
    !(thread.queuedFollowUps ?? []).some((queued) => queued.fromAgent !== undefined)
  ) {
    return [];
  }
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

/** The user wrote: the hold comes off, invites resume and the agents' count starts over. */
export function resetAgentRequestsForUser(
  thread: OrchestrationThread,
  base: EventBase,
  createdAt: string,
): ReadonlyArray<PlannedEvent> {
  const state = thread.agentRequests;
  if (!state.hold && state.requestsSinceUser === 0 && !state.invitesPaused) {
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
 * An agent leaves: requests to or from it are cancelled (with a side answer
 * one of them started), and messages agents queued for it or from it are
 * taken back instead of going to another agent.
 */
export function cancelAgentRequestsForLeaving(
  thread: OrchestrationThread,
  participantId: OrchestrationThread["participants"][number]["id"],
  base: EventBase,
  createdAt: string,
): ReadonlyArray<PlannedEvent> {
  const involves = (agent: RoomAgentRef) => agent.participantId === participantId;
  const cancelled = thread.agentRequests.open.filter(
    (request) => involves(request.from) || involves(request.to),
  );
  // A side answer one of them started has nobody to go back to.
  const sideTurn = thread.sideTurn ?? null;
  const orphanedSideTurn =
    sideTurn !== null &&
    sideTurn.status !== "cancelling" &&
    cancelled.some((request) => request.requestId === sideTurn.requestId)
      ? sideTurn
      : null;
  return [
    ...cancelled.map((request) =>
      settledEvent(base, thread, request, "cancelled", createdAt, "The agent left the room."),
    ),
    ...(orphanedSideTurn !== null
      ? [
          {
            ...base(),
            type: "thread.side-turn-interrupt-requested" as const,
            payload: { threadId: thread.id, sideTurnId: orphanedSideTurn.sideTurnId, createdAt },
          },
        ]
      : []),
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
