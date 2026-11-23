/**
 * Room tools: when one room agent may make a request of another
 * (docs/design/rooms-slice-2.md, Part B). The decider enforces these rules;
 * the room MCP server reads the same ones first so a refused call gets a
 * precise outcome instead of a bare command rejection.
 */
import {
  type OrchestrationAgentRequestState,
  type OrchestrationThreadParticipant,
  type RoomAgentInvite,
  type RoomAgentInviteChoice,
  type RoomAgentBatchId,
  type RoomAgentRef,
  type RoomAgentRequestKind,
  type RoomAgentRequestOutcome,
  type ThreadParticipantId,
  type TurnId,
} from "@threadlines/contracts";

import { type SideTurnFields, sideTurnStartRefusal } from "./sideTurns.ts";
import { activeParticipants } from "./threadParticipants.ts";

/** What the rules read from a thread. */
export interface AgentRequestThread extends SideTurnFields {
  readonly participants?: ReadonlyArray<OrchestrationThreadParticipant> | undefined;
  readonly session: {
    readonly participantId?: ThreadParticipantId | null | undefined;
    readonly activeTurnId: TurnId | null;
  } | null;
  readonly agentRequests: OrchestrationAgentRequestState;
}

export interface AgentRequestInput {
  readonly kind: RoomAgentRequestKind;
  readonly from: RoomAgentRef;
  readonly to: RoomAgentRef;
  readonly callerTurnId: TurnId;
  readonly chainEpoch: number;
  /** A review asked of several agents in one call. */
  readonly batchId?: RoomAgentBatchId | undefined;
}

/**
 * Why a request is refused: `busy` (its agent is already answering on the
 * side, or the most side answers run at once), or `refused` (anything else,
 * with a reason the calling agent can act on). There is no count: agents make
 * as many requests of each other as they like, until the user stops them
 * (docs/design/agent-autonomy-no-limits.md).
 */
export interface AgentRequestRefusal {
  readonly outcome: "refused" | "busy";
  readonly detail: string;
}

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
  if (input.kind !== "hand_off") {
    const busy = sideTurnStartRefusal(thread, input.to.participantId ?? null);
    if (busy !== null) return { outcome: "busy", detail: busy };
  }
  return null;
}

export interface AgentInviteInput {
  readonly from: RoomAgentRef;
  readonly callerTurnId: TurnId;
  readonly chainEpoch: number;
}

/**
 * Why an invite is refused, or null. The same holder, turn and Stop rules as
 * other requests; besides those, a declined invite silences invites
 * until the user writes, and only one invite waits for the user at a time.
 * A side answer running is no reason: an accepted invite waits its turn.
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
  if (thread.voiceActive === true) {
    return { outcome: "refused", detail: "Voice is on. Agents cannot invite others while it is." };
  }
  return null;
}

/**
 * Why an accepted invite's review cannot start, or null. Checked when the
 * user answers, since the thread may have moved on while they thought it
 * over, and again when an invite that waited for another side answer gets
 * its turn.
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
      : { ...state, open: [...state.open, request] },
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
    options?: { readonly keepHold?: boolean | undefined },
  ): OrchestrationAgentRequestState => {
    const hold = options?.keepHold === true ? state.hold : true;
    return state.hold === hold && state.chainEpoch === chainEpoch
      ? state
      : { ...state, hold, chainEpoch };
  },
  reset: (state: OrchestrationAgentRequestState): OrchestrationAgentRequestState =>
    !state.hold && !state.invitesPaused ? state : { ...state, hold: false, invitesPaused: false },
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
 * Whether an agent wrote or queued this, not the user: a room agent's request
 * or routed reply (`fromAgent`), another thread's request or report
 * (`fromThread`, child threads), or an agent running outside Threadlines
 * (`fromOutside`, docs/design/outside-agents.md). Every "is this the user's"
 * question asks this one, so the user's messages keep their priority, their
 * place in the inbox order and their power to reset the agents' limits.
 */
export const isAgentOrigin = (entry: {
  readonly fromAgent?: unknown;
  readonly fromThread?: unknown;
  readonly fromOutside?: unknown;
}): boolean =>
  entry.fromAgent !== undefined ||
  entry.fromThread !== undefined ||
  entry.fromOutside !== undefined;

/**
 * A message an agent queued (a reply, or a child thread's report or request)
 * that was taken back before it was sent: it stays in the chat, marked
 * cancelled, and never started a turn. A lead chat's pass (`fromThread.ceiling`)
 * taken back is also `notSent`, which keeps it out of every history an agent
 * is given (`reachedAgent`). The projections and the web store all apply it
 * through this.
 */
export const withUnqueuedAgentMessage = <
  Message extends {
    readonly id: string;
    readonly fromAgent?: unknown;
    readonly fromThread?: { readonly ceiling?: unknown } | undefined;
    readonly fromOutside?: unknown;
    readonly requestOutcome?: RoomAgentRequestOutcome | undefined;
    readonly notSent?: true | undefined;
  },
>(
  message: Message,
  unqueued: { readonly messageId: string; readonly reason: "sent" | "cancelled" },
): Message => {
  if (
    unqueued.reason !== "cancelled" ||
    message.id !== unqueued.messageId ||
    !isAgentOrigin(message)
  ) {
    return message;
  }
  const outcome = message.requestOutcome === undefined;
  const notSent = message.fromThread?.ceiling !== undefined && message.notSent !== true;
  return outcome || notSent
    ? {
        ...message,
        ...(outcome ? { requestOutcome: "cancelled" as const } : {}),
        ...(notSent ? { notSent: true as const } : {}),
      }
    : message;
};

/**
 * Whether the user wrote a message. In a room, an agent can write a user-role
 * message too (a request or a routed reply), and so can another thread's
 * agent (child threads) and an outside agent; those never count as the
 * user's activity (inbox order, "last message from you").
 */
export const isUserWrittenMessage = (message: {
  readonly role: string;
  readonly fromAgent?: unknown;
  readonly fromThread?: unknown;
  readonly fromOutside?: unknown;
}): boolean => message.role === "user" && !isAgentOrigin(message);
