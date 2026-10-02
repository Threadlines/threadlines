/**
 * Room tools: when one room agent may make a request of another
 * (docs/design/rooms-slice-2.md, Part B). The decider enforces these rules;
 * the room MCP server reads the same ones first so a refused call gets a
 * precise outcome instead of a bare command rejection.
 */
import {
  type OrchestrationAgentRequestState,
  type OrchestrationSideTurn,
  type OrchestrationThreadParticipant,
  type RoomAgentInvite,
  type RoomAgentInviteChoice,
  type RoomAgentRef,
  type RoomAgentRequestKind,
  type RoomAgentRequestOutcome,
  ROOM_AGENT_REQUEST_LIMIT,
  type ThreadParticipantId,
  type TurnId,
} from "@threadlines/contracts";

import { activeParticipants } from "./threadParticipants.ts";

/** What the rules read from a thread. */
export interface AgentRequestThread {
  readonly participants?: ReadonlyArray<OrchestrationThreadParticipant> | undefined;
  readonly session: {
    readonly participantId?: ThreadParticipantId | null | undefined;
    readonly activeTurnId: TurnId | null;
  } | null;
  readonly sideTurn?: OrchestrationSideTurn | null | undefined;
  readonly agentRequests: OrchestrationAgentRequestState;
}

export interface AgentRequestInput {
  readonly kind: RoomAgentRequestKind;
  readonly from: RoomAgentRef;
  readonly to: RoomAgentRef;
  readonly callerTurnId: TurnId;
  readonly chainEpoch: number;
}

/**
 * Why a request is refused: `busy` (a side answer is already running),
 * `limit` (agents have used their requests until the user writes), or
 * `refused` (anything else, with a reason the calling agent can act on).
 */
export interface AgentRequestRefusal {
  readonly outcome: "refused" | "busy" | "limit";
  readonly detail: string;
}

/**
 * The room shows no notice when agents reach the limit, so the calling
 * agent's reply is where the user learns a request was not made.
 */
const LIMIT_REFUSAL: AgentRequestRefusal = {
  outcome: "limit",
  detail: `Agents have made ${ROOM_AGENT_REQUEST_LIMIT} requests since the user last wrote, so this one was not made. Say so in your reply, and wait for the user to write before asking again.`,
};

const sameAgent = (left: RoomAgentRef, right: RoomAgentRef) =>
  (left.participantId ?? null) === (right.participantId ?? null);

/** The request, or null when every rule allows it. */
export function agentRequestRefusal(
  thread: AgentRequestThread,
  input: AgentRequestInput,
): AgentRequestRefusal | null {
  const present = activeParticipants({ participants: thread.participants ?? [] });
  if (present.length === 0) {
    return { outcome: "refused", detail: "This thread has no other agents." };
  }
  const holder = thread.session?.participantId ?? null;
  if ((input.from.participantId ?? null) !== holder) {
    return {
      outcome: "refused",
      detail: "Only the agent working in this thread can make requests.",
    };
  }
  if (thread.session?.activeTurnId !== input.callerTurnId) {
    return { outcome: "refused", detail: "Requests can only be made during your own turn." };
  }
  const state = thread.agentRequests;
  if (state.hold) {
    return {
      outcome: "refused",
      detail: "The user stopped the agents. Wait for the user before asking another agent.",
    };
  }
  if (input.chainEpoch !== state.chainEpoch) {
    return { outcome: "refused", detail: "The user stopped this request." };
  }
  if (sameAgent(input.from, input.to)) {
    return { outcome: "refused", detail: "Pick another agent; you cannot ask yourself." };
  }
  const target = input.to.participantId ?? null;
  if (target !== null && !present.some((participant) => participant.id === target)) {
    return { outcome: "refused", detail: "That agent is not in this room." };
  }
  if (state.requestsSinceUser >= ROOM_AGENT_REQUEST_LIMIT) {
    return LIMIT_REFUSAL;
  }
  if (input.kind !== "hand_off" && (thread.sideTurn ?? null) !== null) {
    return {
      outcome: "busy",
      detail: "Another agent is already answering on the side. Try again once it finishes.",
    };
  }
  return null;
}

export interface AgentInviteInput {
  readonly from: RoomAgentRef;
  readonly callerTurnId: TurnId;
  readonly chainEpoch: number;
  /** The agent is brought in and its review starts at once ("without asking"). */
  readonly startsNow: boolean;
}

/**
 * Why an invite is refused, or null. The same holder, turn, Stop and limit
 * rules as other requests; besides those, a declined invite silences invites
 * until the user writes, and only one invite waits for the user at a time.
 */
export function agentInviteRefusal(
  thread: AgentRequestThread & { readonly voiceActive?: boolean | undefined },
  input: AgentInviteInput,
): AgentRequestRefusal | null {
  const holder = thread.session?.participantId ?? null;
  if ((input.from.participantId ?? null) !== holder) {
    return {
      outcome: "refused",
      detail: "Only the agent working in this thread can invite another agent.",
    };
  }
  if (thread.session?.activeTurnId !== input.callerTurnId) {
    return { outcome: "refused", detail: "Invites can only be made during your own turn." };
  }
  const state = thread.agentRequests;
  if (state.hold) {
    return {
      outcome: "refused",
      detail: "The user stopped the agents. Wait for the user before inviting another agent.",
    };
  }
  if (input.chainEpoch !== state.chainEpoch) {
    return { outcome: "refused", detail: "The user stopped this request." };
  }
  if (state.invitesPaused) {
    return {
      outcome: "refused",
      detail: "The user said not now to an invite. Do not ask again unless the user asks you to.",
    };
  }
  if (state.open.some((request) => request.status === "awaiting_user")) {
    return {
      outcome: "refused",
      detail: "An invite is already waiting for the user. Wait for the user's answer.",
    };
  }
  if (state.requestsSinceUser >= ROOM_AGENT_REQUEST_LIMIT) {
    return LIMIT_REFUSAL;
  }
  if (thread.voiceActive === true) {
    return { outcome: "refused", detail: "Voice is on. Agents cannot invite others while it is." };
  }
  if (input.startsNow && (thread.sideTurn ?? null) !== null) {
    return {
      outcome: "busy",
      detail: "Another agent is already answering on the side. Try again once it finishes.",
    };
  }
  return null;
}

/**
 * Why the user's answer to an invite cannot be applied now, or null. Checked
 * when the user answers, since the thread may have moved on while they
 * thought it over.
 */
export function agentInviteAcceptRefusal(
  thread: AgentRequestThread & { readonly voiceActive?: boolean | undefined },
  request: OrchestrationAgentRequestState["open"][number],
): string | null {
  if (request.chainEpoch !== thread.agentRequests.chainEpoch) {
    return "The agents were stopped since this was asked.";
  }
  if (thread.voiceActive === true) {
    return "Stop voice before bringing in another agent.";
  }
  if ((thread.sideTurn ?? null) !== null) {
    return "Another agent is answering on the side. Try again once it finishes.";
  }
  const caller = request.from.participantId ?? null;
  if (
    caller !== null &&
    !activeParticipants({ participants: thread.participants ?? [] }).some(
      (participant) => participant.id === caller,
    )
  ) {
    return "The agent that asked has left the thread.";
  }
  return null;
}

/** The invite waiting for the user's answer, if any. */
export const awaitingInvite = (
  state: OrchestrationAgentRequestState,
): OrchestrationAgentRequestState["open"][number] | undefined =>
  state.open.find((request) => request.kind === "invite" && request.status === "awaiting_user");

/**
 * How each room-request event changes a thread's request state. The server's
 * projector and the web store both apply events through these, so the two
 * never disagree. Each returns the same state object when nothing changes
 * (an event seen twice, say), so a client can skip re-rendering.
 */
export const agentRequestStateOn = {
  submitted: (
    state: OrchestrationAgentRequestState,
    request: OrchestrationAgentRequestState["open"][number],
  ): OrchestrationAgentRequestState =>
    state.open.some((entry) => entry.requestId === request.requestId)
      ? state
      : {
          ...state,
          open: [...state.open, request],
          requestsSinceUser: state.requestsSinceUser + 1,
        },
  updated: (
    state: OrchestrationAgentRequestState,
    update: {
      readonly requestId: OrchestrationAgentRequestState["open"][number]["requestId"];
      readonly status: OrchestrationAgentRequestState["open"][number]["status"];
      readonly replyAsMessage?: boolean | undefined;
    },
  ): OrchestrationAgentRequestState => {
    const changes = (entry: OrchestrationAgentRequestState["open"][number]) =>
      entry.requestId === update.requestId &&
      (entry.status !== update.status ||
        (update.replyAsMessage === true && entry.replyAsMessage !== true));
    return state.open.some(changes)
      ? {
          ...state,
          open: state.open.map((entry) =>
            changes(entry)
              ? {
                  ...entry,
                  status: update.status,
                  ...(update.replyAsMessage === true ? { replyAsMessage: true } : {}),
                }
              : entry,
          ),
        }
      : state;
  },
  settled: (
    state: OrchestrationAgentRequestState,
    requestId: OrchestrationAgentRequestState["open"][number]["requestId"],
    outcome: RoomAgentRequestOutcome,
  ): OrchestrationAgentRequestState =>
    state.open.some((entry) => entry.requestId === requestId)
      ? {
          ...state,
          open: state.open.filter((entry) => entry.requestId !== requestId),
          ...(outcome === "declined" ? { invitesPaused: true } : {}),
        }
      : state,
  held: (
    state: OrchestrationAgentRequestState,
    chainEpoch: number,
  ): OrchestrationAgentRequestState =>
    state.hold && state.chainEpoch === chainEpoch ? state : { ...state, hold: true, chainEpoch },
  reset: (state: OrchestrationAgentRequestState): OrchestrationAgentRequestState =>
    !state.hold && state.requestsSinceUser === 0 && !state.invitesPaused
      ? state
      : { ...state, hold: false, requestsSinceUser: 0, invitesPaused: false },
};

/**
 * An invite's record once the user answered it (or the setting answered for
 * them). The projections and the web store all apply it through this.
 */
export const withInviteChoice = (
  invite: RoomAgentInvite | undefined,
  answer: { readonly choice: RoomAgentInviteChoice; readonly automatic: boolean },
): RoomAgentInvite | undefined =>
  invite === undefined
    ? undefined
    : { ...invite, choice: answer.choice, automatic: answer.automatic };

/**
 * A message an agent queued (a reply) that was taken back before it was
 * sent: it stays in the chat, marked cancelled, and never started a turn.
 * The projections and the web store all apply it through this.
 */
export const withUnqueuedAgentMessage = <
  Message extends {
    readonly id: string;
    readonly fromAgent?: unknown;
    readonly requestOutcome?: RoomAgentRequestOutcome | undefined;
  },
>(
  message: Message,
  unqueued: { readonly messageId: string; readonly reason: "sent" | "cancelled" },
): Message =>
  unqueued.reason === "cancelled" &&
  message.id === unqueued.messageId &&
  message.fromAgent !== undefined &&
  message.requestOutcome === undefined
    ? { ...message, requestOutcome: "cancelled" }
    : message;

/**
 * Whether the user wrote a message. In a room, an agent can write a user-role
 * message too (a request or a routed reply); those never count as the user's
 * activity (inbox order, "last message from you").
 */
export const isUserWrittenMessage = (message: {
  readonly role: string;
  readonly fromAgent?: unknown;
}): boolean => message.role === "user" && message.fromAgent === undefined;
