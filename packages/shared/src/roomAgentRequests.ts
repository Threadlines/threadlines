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
  type RoomAgentRef,
  type RoomAgentRequestKind,
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
    return {
      outcome: "limit",
      detail: `Agents have made ${ROOM_AGENT_REQUEST_LIMIT} requests since the user last wrote. Wait for the user.`,
    };
  }
  if (input.kind !== "hand_off" && (thread.sideTurn ?? null) !== null) {
    return {
      outcome: "busy",
      detail: "Another agent is already answering on the side. Try again once it finishes.",
    };
  }
  return null;
}

/** Whether agents have used all their requests until the user writes. */
export const agentRequestLimitReached = (state: OrchestrationAgentRequestState): boolean =>
  state.requestsSinceUser >= ROOM_AGENT_REQUEST_LIMIT;

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
    requestId: OrchestrationAgentRequestState["open"][number]["requestId"],
    status: OrchestrationAgentRequestState["open"][number]["status"],
  ): OrchestrationAgentRequestState =>
    state.open.some((entry) => entry.requestId === requestId && entry.status !== status)
      ? {
          ...state,
          open: state.open.map((entry) =>
            entry.requestId === requestId ? { ...entry, status } : entry,
          ),
        }
      : state,
  settled: (
    state: OrchestrationAgentRequestState,
    requestId: OrchestrationAgentRequestState["open"][number]["requestId"],
  ): OrchestrationAgentRequestState =>
    state.open.some((entry) => entry.requestId === requestId)
      ? { ...state, open: state.open.filter((entry) => entry.requestId !== requestId) }
      : state,
  held: (
    state: OrchestrationAgentRequestState,
    chainEpoch: number,
  ): OrchestrationAgentRequestState =>
    state.hold && state.chainEpoch === chainEpoch ? state : { ...state, hold: true, chainEpoch },
  reset: (state: OrchestrationAgentRequestState): OrchestrationAgentRequestState =>
    !state.hold && state.requestsSinceUser === 0
      ? state
      : { ...state, hold: false, requestsSinceUser: 0 },
};
