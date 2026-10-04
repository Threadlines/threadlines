/**
 * Child threads: threads an agent starts, the answers they owe it, and the
 * family they form in the sidebar (docs/design/child-threads.md). The
 * decider enforces these rules; the room MCP server reads the same ones first
 * so a refused call gets a precise outcome instead of a bare rejection, and
 * the projections and the web store fold events through one reducer.
 */
import {
  CHILD_REQUEST_NOTE_LIMIT,
  CHILD_THREAD_SEND_LIMIT,
  CHILD_THREAD_START_LIMIT,
  CHILD_THREADS_PER_CALL,
  type ChildRequestId,
  type ChildRequestNote,
  type ChildRequestStatus,
  type OrchestrationChildRequest,
  type OrchestrationChildRequestState,
  type RoomAgentRef,
  type ThreadId,
  type ThreadParticipantId,
  type TurnId,
} from "@threadlines/contracts";

/** What the rules read from a thread an agent works in. */
export interface ChildRequestCaller {
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly attachedToParent: boolean;
  readonly session: {
    readonly participantId?: ThreadParticipantId | null | undefined;
    readonly activeTurnId: TurnId | null;
  } | null;
  readonly agentRequests: { readonly hold: boolean };
  readonly childRequests: OrchestrationChildRequestState;
}

/**
 * Why a call is refused: `limit` (the per-message budget is used up),
 * `not_allowed` (this thread or agent may not do it), or `refused` (anything
 * else, with a reason the calling agent can act on).
 */
export interface ChildRequestRefusal {
  readonly outcome: "refused" | "limit" | "not_allowed";
  readonly detail: string;
}

const sameAgent = (left: RoomAgentRef, right: RoomAgentRef) =>
  (left.participantId ?? null) === (right.participantId ?? null);

/**
 * Whether this thread is itself part of another's family. Such a thread may
 * read and list threads but not start, message or stop any: families are one
 * level deep.
 */
export const isAttachedChild = (thread: {
  readonly parentThreadId: ThreadId | null;
  readonly attachedToParent: boolean;
}): boolean => thread.parentThreadId !== null && thread.attachedToParent;

const DEPTH_REFUSAL: ChildRequestRefusal = {
  outcome: "not_allowed",
  detail:
    "This thread was started by another thread, so it cannot start, message or stop threads itself. Do the work here, or say what you need in your final reply; it goes back to the thread that started you.",
};

function callerRefusal(
  thread: ChildRequestCaller,
  input: { readonly from: RoomAgentRef; readonly callerTurnId: TurnId },
): ChildRequestRefusal | null {
  if (isAttachedChild(thread)) {
    return DEPTH_REFUSAL;
  }
  if ((input.from.participantId ?? null) !== (thread.session?.participantId ?? null)) {
    return {
      outcome: "refused",
      detail: "Only the agent working in this thread can do that.",
    };
  }
  if (thread.session?.activeTurnId !== input.callerTurnId) {
    return { outcome: "refused", detail: "This can only be done during your own turn." };
  }
  if (thread.agentRequests.hold) {
    return {
      outcome: "refused",
      detail: "The user stopped the agents. Wait for the user to write before starting work.",
    };
  }
  return null;
}

/** Why starting `count` threads is refused, or null when every rule allows it. */
export function childStartRefusal(
  thread: ChildRequestCaller,
  input: { readonly from: RoomAgentRef; readonly callerTurnId: TurnId; readonly count: number },
): ChildRequestRefusal | null {
  const caller = callerRefusal(thread, input);
  if (caller !== null) {
    return caller;
  }
  if (input.count < 1 || input.count > CHILD_THREADS_PER_CALL) {
    return {
      outcome: "refused",
      detail: `Start between 1 and ${CHILD_THREADS_PER_CALL} threads at a time.`,
    };
  }
  const used = thread.childRequests.startsSinceUser;
  if (used + input.count > CHILD_THREAD_START_LIMIT) {
    return {
      outcome: "limit",
      detail: `Agents can start ${CHILD_THREAD_START_LIMIT} threads per user message, and ${used} were already asked for since the user last wrote, so these were not started. Say so in your reply, and wait for the user before starting more.`,
    };
  }
  return null;
}

/** Why sending a message to `childThreadId` is refused, or null. */
export function childSendRefusal(
  thread: ChildRequestCaller,
  child: {
    readonly id: ThreadId;
    readonly parentThreadId: ThreadId | null;
    readonly attachedToParent: boolean;
    readonly archivedAt: string | null;
  } | null,
  input: { readonly from: RoomAgentRef; readonly callerTurnId: TurnId },
): ChildRequestRefusal | null {
  const caller = callerRefusal(thread, input);
  if (caller !== null) {
    return caller;
  }
  const ownRefusal = ownChildRefusal(thread, child);
  if (ownRefusal !== null) {
    return ownRefusal;
  }
  if (thread.childRequests.sendsSinceUser >= CHILD_THREAD_SEND_LIMIT) {
    return {
      outcome: "limit",
      detail: `Agents can send ${CHILD_THREAD_SEND_LIMIT} messages to their threads per user message, and that many were sent since the user last wrote, so this one was not. Say so in your reply, and wait for the user before sending more.`,
    };
  }
  return null;
}

/**
 * Whether `child` is one of this thread's attached children: the only threads
 * an agent may message or stop.
 */
export function ownChildRefusal(
  thread: { readonly id: ThreadId },
  child: {
    readonly parentThreadId: ThreadId | null;
    readonly attachedToParent: boolean;
    readonly archivedAt: string | null;
  } | null,
): ChildRequestRefusal | null {
  if (child === null || child.parentThreadId !== thread.id) {
    return {
      outcome: "not_allowed",
      detail: "That is not a thread you started. You can only message or stop your own threads.",
    };
  }
  if (!child.attachedToParent) {
    return {
      outcome: "not_allowed",
      detail: "The user made that thread its own, so it no longer takes work from you.",
    };
  }
  if (child.archivedAt !== null) {
    return { outcome: "refused", detail: "That thread is archived." };
  }
  return null;
}

/**
 * Why a thread cannot be put back under its parent, or null. A family is one
 * level deep: the parent may not be a child itself, and the thread may not
 * have a family of its own.
 */
export function childAttachRefusal(
  thread: {
    readonly parentThreadId: ThreadId | null;
    readonly childRequests: OrchestrationChildRequestState;
  },
  parent: {
    readonly parentThreadId: ThreadId | null;
    readonly attachedToParent: boolean;
    readonly archivedAt: string | null;
    readonly deletedAt: string | null;
  } | null,
  hasAttachedChildren: boolean,
): string | null {
  if (thread.parentThreadId === null) {
    return "This thread was not started by another thread.";
  }
  if (parent === null || parent.deletedAt !== null) {
    return "The thread that started this one is gone.";
  }
  if (parent.archivedAt !== null) {
    return "The thread that started this one is archived.";
  }
  if (isAttachedChild(parent)) {
    return "The thread that started this one is part of another thread's family.";
  }
  if (hasAttachedChildren || thread.childRequests.open.length > 0) {
    return "This thread has started threads of its own.";
  }
  return null;
}

/** Requests whose answers are still owed, as the parent's sidebar row counts them. */
export const awaitedChildRequestCount = (state: OrchestrationChildRequestState): number =>
  state.open.filter((request) => request.status !== "awaiting_user").length;

/** Whether threads the agent asked to start wait for the user's yes. */
export const hasPendingChildApproval = (state: OrchestrationChildRequestState): boolean =>
  state.open.some((request) => request.status === "awaiting_user");

/** The batch waiting for the user's answer, oldest first, if any. */
export const awaitingChildBatch = (
  state: OrchestrationChildRequestState,
): ReadonlyArray<OrchestrationChildRequest> => {
  const first = state.open.find((request) => request.status === "awaiting_user");
  return first === undefined
    ? []
    : state.open.filter(
        (request) => request.batchId === first.batchId && request.status === "awaiting_user",
      );
};

/** The notes an agent should hear at its next turn. */
export const notesFor = (
  state: OrchestrationChildRequestState,
  recipient: RoomAgentRef,
): ReadonlyArray<ChildRequestNote> =>
  state.pendingNotes.filter((note) => sameAgent(note.recipient, recipient));

/**
 * How each child-request event changes a thread's state. The server's
 * projector and the web store both apply events through these, so they never
 * disagree. Each returns the same state object when nothing changes (an
 * event seen twice), so a client can skip re-rendering.
 */
export const childRequestStateOn = {
  submitted: (
    state: OrchestrationChildRequestState,
    request: OrchestrationChildRequest,
  ): OrchestrationChildRequestState =>
    state.open.some((entry) => entry.requestId === request.requestId)
      ? state
      : {
          ...state,
          open: [...state.open, request],
          ...(request.kind === "start"
            ? { startsSinceUser: state.startsSinceUser + 1 }
            : { sendsSinceUser: state.sendsSinceUser + 1 }),
        },
  updated: (
    state: OrchestrationChildRequestState,
    update: {
      readonly requestId: ChildRequestId;
      readonly status: ChildRequestStatus;
      readonly candidateTurnId?: TurnId | undefined;
    },
  ): OrchestrationChildRequestState => {
    const changes = (entry: OrchestrationChildRequest) =>
      entry.requestId === update.requestId &&
      (entry.status !== update.status || entry.candidateTurnId !== update.candidateTurnId);
    return state.open.some(changes)
      ? {
          ...state,
          open: state.open.map((entry) => {
            if (!changes(entry)) return entry;
            const { candidateTurnId: _previous, ...rest } = entry;
            return {
              ...rest,
              status: update.status,
              ...(update.candidateTurnId !== undefined
                ? { candidateTurnId: update.candidateTurnId }
                : {}),
            };
          }),
        }
      : state;
  },
  settled: (
    state: OrchestrationChildRequestState,
    requestId: ChildRequestId,
    note: ChildRequestNote | undefined,
  ): OrchestrationChildRequestState => {
    const open = state.open.some((entry) => entry.requestId === requestId);
    const noted =
      note !== undefined && !state.pendingNotes.some((entry) => entry.requestId === requestId);
    if (!open && !noted) {
      return state;
    }
    return {
      ...state,
      open: open ? state.open.filter((entry) => entry.requestId !== requestId) : state.open,
      pendingNotes: noted
        ? [...state.pendingNotes, note].slice(-CHILD_REQUEST_NOTE_LIMIT)
        : state.pendingNotes,
    };
  },
  notesDelivered: (
    state: OrchestrationChildRequestState,
    requestIds: ReadonlyArray<ChildRequestId>,
  ): OrchestrationChildRequestState =>
    state.pendingNotes.some((note) => requestIds.includes(note.requestId))
      ? {
          ...state,
          pendingNotes: state.pendingNotes.filter((note) => !requestIds.includes(note.requestId)),
        }
      : state,
  deliveriesCancelled: (
    state: OrchestrationChildRequestState,
    deliveryEpoch: number,
  ): OrchestrationChildRequestState =>
    state.deliveryEpoch === deliveryEpoch ? state : { ...state, deliveryEpoch },
  reset: (state: OrchestrationChildRequestState): OrchestrationChildRequestState =>
    state.startsSinceUser === 0 && state.sendsSinceUser === 0
      ? state
      : { ...state, startsSinceUser: 0, sendsSinceUser: 0 },
};

/**
 * Whether a child's latest finished work is exactly what went back to its
 * parent: then the parent's agent has read it, and with the "wrap up finished
 * child threads" setting the child may be filed without the user opening it.
 * Work it did after that answer gets no such pass.
 */
export const isHandedBackCompletion = (thread: {
  readonly handedBackTurnId: TurnId | null;
  readonly latestTurn: { readonly turnId: TurnId; readonly state: string } | null;
}): boolean =>
  thread.handedBackTurnId !== null &&
  thread.latestTurn !== null &&
  thread.latestTurn.state !== "running" &&
  thread.latestTurn.turnId === thread.handedBackTurnId;
