/**
 * Child threads: threads an agent starts, the answers they owe it, and the
 * family they form in the sidebar (docs/design/child-threads.md). The
 * decider enforces these rules; the room MCP server reads the same ones first
 * so a refused call gets a precise outcome instead of a bare rejection, and
 * the projections and the web store fold events through one reducer.
 */
import {
  CHILD_REQUEST_NOTE_LIMIT,
  CHILD_THREADS_PER_CALL,
  type ChildRequestId,
  type ChildRequestNote,
  type ChildRequestStatus,
  type OrchestrationChildRequest,
  type OrchestrationChildRequestState,
  type RemoteChildCancel,
  type RemoteChildRequest,
  type FamilyRemoteChild,
  type LeadPassCeiling,
  type RemoteChildStart,
  type RemoteChildThread,
  type RemoteThreadFiling,
  type RoomAgentRef,
  type LocalChildStart,
  type MessageId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type ThreadParticipantId,
  type TurnId,
} from "@threadlines/contracts";

import { exceedsRuntimeMode, saferRuntimeMode } from "./runtimeMode.ts";
import { isRoomThread } from "./threadParticipants.ts";

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
 * Why a call is refused: `not_allowed` (this thread or agent may not do it),
 * or `refused` (anything else, with a reason the calling agent can act on).
 * There is no count: agents start and message as many threads as they like,
 * until the user stops them (docs/design/agent-autonomy-no-limits.md).
 */
export interface ChildRequestRefusal {
  readonly outcome: "refused" | "not_allowed";
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
  input: {
    readonly from: RoomAgentRef;
    readonly callerTurnId: TurnId;
    readonly count: number;
  },
): ChildRequestRefusal | null {
  const caller = callerRefusal(thread, input);
  if (caller !== null) {
    return caller;
  }
  // No fan-out (docs/design/lead-chat.md): one message in a lead chat must
  // not start threads through every thread it is passed to. Messaging this
  // thread's own children still works, within the pass's ceiling
  // (childSendRefusal).
  if (thread.childRequests.passCeiling !== undefined) {
    return {
      outcome: "not_allowed",
      detail:
        "This thread is working on something the lead chat passed on. Do the work here, or say what should be started.",
    };
  }
  if (input.count < 1 || input.count > CHILD_THREADS_PER_CALL) {
    return {
      outcome: "refused",
      detail: `Start between 1 and ${CHILD_THREADS_PER_CALL} threads at a time.`,
    };
  }
  return null;
}

/**
 * Why sending a message to `childThreadId` is refused, or null. `child`'s
 * modes are absent for a thread on another computer, whose access this
 * computer can't hold to a pass's ceiling.
 */
export function childSendRefusal(
  thread: ChildRequestCaller,
  child: {
    readonly id: ThreadId;
    readonly parentThreadId: ThreadId | null;
    readonly attachedToParent: boolean;
    readonly archivedAt: string | null;
    readonly runtimeMode?: RuntimeMode | undefined;
    readonly interactionMode?: ProviderInteractionMode | undefined;
  } | null,
  input: {
    readonly from: RoomAgentRef;
    readonly callerTurnId: TurnId;
  },
): ChildRequestRefusal | null {
  const caller = callerRefusal(thread, input);
  if (caller !== null) {
    return caller;
  }
  const ownRefusal = ownChildRefusal(thread, child);
  if (ownRefusal !== null) {
    return ownRefusal;
  }
  // Work the lead chat passed on keeps its ceiling when it is handed down:
  // a pass never reaches a thread with more access than the lead's.
  const passCeiling = thread.childRequests.passCeiling;
  if (passCeiling !== undefined && child !== null) {
    if (child.runtimeMode === undefined || child.interactionMode === undefined) {
      return {
        outcome: "not_allowed",
        detail:
          "This thread is working on something the lead chat passed on, and that thread is on another computer. Do the work here, or tell the user, who can send it there.",
      };
    }
    if (
      !withinModeCeiling(
        { runtimeMode: child.runtimeMode, interactionMode: child.interactionMode },
        passCeiling,
      )
    ) {
      return {
        outcome: "not_allowed",
        detail:
          "This thread is working on something the lead chat passed on, and that thread has more access than the lead chat. Do the work here, or tell the user, who can send it there.",
      };
    }
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

/** Whether `child` asks for no more than `ceiling` allows. Plan is narrower than default. */
export function withinModeCeiling(
  child: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
  ceiling: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
): boolean {
  return (
    !exceedsRuntimeMode(child.runtimeMode, ceiling.runtimeMode) &&
    (ceiling.interactionMode !== "plan" || child.interactionMode === "plan")
  );
}

/** The narrower of two ceilings: no more access than either allows. */
export function narrowerModeCeiling(
  left: LeadPassCeiling | undefined,
  right: LeadPassCeiling,
): LeadPassCeiling {
  if (left === undefined) return right;
  const narrower = {
    runtimeMode: saferRuntimeMode(left.runtimeMode, right.runtimeMode),
    interactionMode:
      left.interactionMode === "plan" || right.interactionMode === "plan"
        ? ("plan" as const)
        : ("default" as const),
  };
  return narrower.runtimeMode === left.runtimeMode &&
    narrower.interactionMode === left.interactionMode
    ? left
    : narrower;
}

/**
 * What a `started` record without a ceiling holds the thread to: the least
 * access there is. Every decision that records one sends the pass's ceiling.
 */
const SAFEST_PASS_CEILING: LeadPassCeiling = {
  runtimeMode: "approval-required",
  interactionMode: "plan",
};

/** What the pass rules read from the thread a lead chat passes a message to. */
export interface LeadPassTarget {
  readonly id: ThreadId;
  readonly projectId: string;
  readonly parentThreadId: ThreadId | null;
  readonly attachedToParent: boolean;
  readonly archivedAt: string | null;
  readonly deletedAt?: string | null | undefined;
  readonly participants: Parameters<typeof isRoomThread>[0]["participants"];
  readonly remoteOrigin?: unknown;
  readonly outsideOrigin?: unknown;
  readonly move?: unknown;
  readonly pendingMove?: unknown;
  readonly agentRequests: { readonly hold: boolean };
  readonly latestTurn: { readonly state: string } | null;
}

/**
 * Why the project's lead chat may not pass a message to `target`, a thread it
 * did not start (docs/design/lead-chat.md, "Tools"), or null. The caller has
 * already sent a thread it started down the child path. `isLead` is whether
 * the caller is its project's lead chat now.
 */
export function leadPassRefusal(
  lead: ChildRequestCaller & { readonly projectId: string },
  target: LeadPassTarget | null,
  input: {
    readonly from: RoomAgentRef;
    readonly callerTurnId: TurnId;
    readonly isLead: boolean;
  },
): ChildRequestRefusal | null {
  const caller = callerRefusal(lead, input);
  if (caller !== null) {
    return caller;
  }
  if (!input.isLead) {
    return {
      outcome: "not_allowed",
      detail: "That is not a thread you started. You can only message or stop your own threads.",
    };
  }
  if (target === null || (target.deletedAt ?? null) !== null) {
    return { outcome: "refused", detail: "That thread is gone." };
  }
  if (target.id === lead.id) {
    return { outcome: "refused", detail: "That is this thread." };
  }
  if (target.projectId !== lead.projectId) {
    return { outcome: "refused", detail: "That thread is in another project." };
  }
  if (target.archivedAt !== null) {
    return { outcome: "refused", detail: "That thread is archived." };
  }
  if (isAttachedChild(target)) {
    return {
      outcome: "not_allowed",
      detail:
        "Another thread started that one and still owns it. Message the thread that started it.",
    };
  }
  if (isRoomThread(target)) {
    return { outcome: "not_allowed", detail: "Rooms take work from the user." };
  }
  if ((target.remoteOrigin ?? null) !== null || (target.outsideOrigin ?? null) !== null) {
    return {
      outcome: "not_allowed",
      detail: "That thread was started from another computer or by an outside agent.",
    };
  }
  if ((target.move ?? null) !== null || (target.pendingMove ?? null) !== null) {
    return { outcome: "refused", detail: "That thread is moving to another computer." };
  }
  // What it was last told to stop doing, or failed at, holds its queue until
  // the user writes there: a pass would sit there unseen.
  if (target.agentRequests.hold || target.latestTurn?.state === "interrupted") {
    return {
      outcome: "refused",
      detail: "The user stopped that thread. It takes work again once they write there.",
    };
  }
  if (target.latestTurn?.state === "error") {
    return {
      outcome: "refused",
      detail: "That thread's last turn failed. It takes work again once the user writes there.",
    };
  }
  return null;
}

/**
 * Why a stored message can't start a turn in `thread` now: it is a pass whose
 * ceiling is under the thread's access at this moment. Every decision that
 * starts a turn from a stored message asks (send-queued, retry, resend).
 */
export function passCeilingRefusal(
  message: {
    readonly fromThread?:
      | { readonly ceiling?: Parameters<typeof withinModeCeiling>[1] | undefined }
      | undefined;
  },
  thread: Parameters<typeof withinModeCeiling>[0],
): string | null {
  const ceiling = message.fromThread?.ceiling;
  return ceiling === undefined || withinModeCeiling(thread, ceiling)
    ? null
    : "Not run: this thread has more access than the lead chat.";
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

const sameRemoteRequest = (
  left: RemoteChildRequest | undefined,
  right: RemoteChildRequest,
): boolean =>
  left !== undefined &&
  left.environmentId === right.environmentId &&
  left.label === right.label &&
  left.threadId === right.threadId &&
  left.status === right.status;

/** Two filings say the same, so a watch only hears a change. */
export function sameRemoteThreadFiling(
  left: RemoteThreadFiling | undefined,
  right: RemoteThreadFiling | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.handedBackAt === right.handedBackAt &&
    left.pinned === right.pinned &&
    left.override?.state === right.override?.state &&
    left.override?.at === right.override?.at &&
    left.lastActivityAt === right.lastActivityAt &&
    left.seenAt === right.seenAt &&
    left.unseen === right.unseen &&
    left.waiting === right.waiting &&
    left.archived === right.archived
  );
}

const sameRemoteChild = (left: RemoteChildThread, right: RemoteChildThread): boolean =>
  left.label === right.label &&
  left.title === right.title &&
  left.handle === right.handle &&
  left.attachmentEpoch === right.attachmentEpoch &&
  left.cachedStatus === right.cachedStatus &&
  left.updatedAt === right.updatedAt &&
  sameRemoteThreadFiling(left.filing, right.filing) &&
  left.override?.state === right.override?.state &&
  left.override?.at === right.override?.at;

/** A parent's record of its child on a linked computer, if it has one. */
export const remoteChildOf = (
  state: OrchestrationChildRequestState,
  threadId: ThreadId,
): RemoteChildThread | undefined =>
  (state.remoteChildren ?? []).find((entry) => entry.threadId === threadId);

/**
 * A parent's children on linked computers as its family shows them, each
 * marked `followed` while a request to it is open (FamilyRemoteChild). The
 * thread shell carries these, and the web store derives them the same way
 * from a loaded thread.
 */
export const remoteChildrenOf = (
  state: OrchestrationChildRequestState,
): ReadonlyArray<FamilyRemoteChild> =>
  (state.remoteChildren ?? []).map((child) => ({
    ...child,
    followed: state.open.some(
      (request) =>
        request.remote?.environmentId === child.environmentId &&
        request.remote.threadId === child.threadId,
    ),
  }));

/**
 * Starts asked of linked computers whose thread hasn't started there yet
 * (sending, or waiting for that computer's user): the parent's family shows
 * them until the child does. A start waiting for an Allow may already carry
 * the id its thread will have; it counts until the parent records the child.
 * The thread shell carries these, and the web store derives them the same
 * way from a loaded thread.
 */
export const remoteChildStartsOf = (
  state: OrchestrationChildRequestState,
): ReadonlyArray<RemoteChildStart> =>
  state.open.flatMap((request): RemoteChildStart[] =>
    request.kind === "start" &&
    request.remote !== undefined &&
    (request.remote.threadId === null ||
      !(state.remoteChildren ?? []).some(
        (child) =>
          child.environmentId === request.remote?.environmentId &&
          child.threadId === request.remote.threadId,
      )) &&
    request.launch !== undefined
      ? [
          {
            requestId: request.requestId,
            environmentId: request.remote.environmentId,
            label: request.remote.label,
            title: request.launch.title,
            status: request.remote.status,
            createdAt: request.createdAt,
          },
        ]
      : [],
  );

/**
 * Whether a request is a start on this computer that is still setting its
 * child up: the child's thread is made only when its start commits, with its
 * first turn (docs/design/thread-setup-state.md), which moves the request on.
 */
export const isSettingUpChildStart = (request: OrchestrationChildRequest): boolean =>
  request.kind === "start" && request.remote === undefined && request.status === "starting";

/**
 * The children a parent started here whose start request is still open, past
 * the user's yes: being set up (no thread yet), or at work for it. The parent's
 * family stands in for any whose thread isn't in its list, so a child shows
 * while it is set up, and the hand-over to its own row has no gap whichever of
 * the parent's update or the child's thread arrives first. A child that is
 * archived or deleted settles its request, so none is stood in for forever.
 * The thread shell carries these, and the web store derives them the same way
 * from a loaded thread.
 */
export const localChildStartsOf = (
  state: OrchestrationChildRequestState,
): ReadonlyArray<LocalChildStart> =>
  state.open.flatMap((request): LocalChildStart[] =>
    request.kind === "start" &&
    request.remote === undefined &&
    request.status !== "awaiting_user" &&
    request.launch !== undefined
      ? [
          {
            requestId: request.requestId,
            childThreadId: request.childThreadId,
            title: request.launch.title,
            createdAt: request.createdAt,
          },
        ]
      : [],
  );

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
      : { ...state, open: [...state.open, request] },
  updated: (
    state: OrchestrationChildRequestState,
    update: {
      readonly requestId: ChildRequestId;
      readonly status: ChildRequestStatus;
      readonly candidateTurnId?: TurnId | undefined;
      readonly remote?: RemoteChildRequest | undefined;
      readonly childMessageId?: MessageId | undefined;
    },
  ): OrchestrationChildRequestState => {
    const changes = (entry: OrchestrationChildRequest) =>
      entry.requestId === update.requestId &&
      (entry.status !== update.status ||
        entry.candidateTurnId !== update.candidateTurnId ||
        (update.childMessageId !== undefined && entry.childMessageId !== update.childMessageId) ||
        (update.remote !== undefined && !sameRemoteRequest(entry.remote, update.remote)));
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
              ...(update.remote !== undefined ? { remote: update.remote } : {}),
              ...(update.childMessageId !== undefined
                ? { childMessageId: update.childMessageId }
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
  /** A cancel or stop owed to a linked computer, kept until it confirms. */
  remoteCancelQueued: (
    state: OrchestrationChildRequestState,
    cancel: RemoteChildCancel,
  ): OrchestrationChildRequestState => {
    const cancels = state.remoteCancels ?? [];
    return cancels.some((entry) => entry.requestId === cancel.requestId)
      ? state
      : { ...state, remoteCancels: [...cancels, cancel] };
  },
  /**
   * A child on a linked computer, new or changed; kept after its requests
   * settle. `removed`: it came home and is a child here again, so its record goes.
   */
  remoteChildUpdated: (
    state: OrchestrationChildRequestState,
    child: RemoteChildThread,
    removed?: boolean,
  ): OrchestrationChildRequestState => {
    const children = state.remoteChildren ?? [];
    const index = children.findIndex(
      (entry) => entry.environmentId === child.environmentId && entry.threadId === child.threadId,
    );
    if (removed === true) {
      if (index < 0) return state;
      const rest = children.filter((_, at) => at !== index);
      const { remoteChildren: _gone, ...without } = state;
      return rest.length > 0 ? { ...state, remoteChildren: rest } : without;
    }
    if (index >= 0 && sameRemoteChild(children[index]!, child)) {
      return state;
    }
    return {
      ...state,
      remoteChildren:
        index >= 0
          ? children.map((entry, at) => (at === index ? child : entry))
          : [...children, child],
    };
  },
  /** Cancels a linked computer confirmed leave the outbox. */
  remoteCancelsDelivered: (
    state: OrchestrationChildRequestState,
    requestIds: ReadonlyArray<ChildRequestId>,
  ): OrchestrationChildRequestState =>
    (state.remoteCancels ?? []).some((entry) => requestIds.includes(entry.requestId))
      ? {
          ...state,
          remoteCancels: (state.remoteCancels ?? []).filter(
            (entry) => !requestIds.includes(entry.requestId),
          ),
        }
      : state,
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
  /**
   * The user wrote: a pass's block on starting threads lifts. With
   * `keepsPassBlock` (a turn Threadlines started for them, recorded before
   * agents could message threads freely) nothing changes.
   */
  reset: (
    state: OrchestrationChildRequestState,
    options?: { readonly keepsPassBlock?: boolean | undefined },
  ): OrchestrationChildRequestState => {
    const liftsBlock = state.passCeiling !== undefined && options?.keepsPassBlock !== true;
    if (!liftsBlock) {
      return state;
    }
    const { passCeiling: _block, ...rest } = state;
    return rest;
  },
  /** The lead chat's passes (`thread.lead-pass-recorded`); see its payload. */
  leadPass: (
    state: OrchestrationChildRequestState,
    pass: {
      readonly kind: "sent" | "refused" | "started" | "not-run";
      readonly note?: ChildRequestNote | undefined;
      readonly ceiling?: LeadPassCeiling | undefined;
    },
  ): OrchestrationChildRequestState => {
    switch (pass.kind) {
      // Its mark is on the message, not on the thread's requests.
      case "sent":
      case "not-run":
        return state;
      case "started": {
        const passCeiling = narrowerModeCeiling(
          state.passCeiling,
          pass.ceiling ?? SAFEST_PASS_CEILING,
        );
        return passCeiling === state.passCeiling ? state : { ...state, passCeiling };
      }
      case "refused": {
        const note = pass.note;
        return note === undefined ||
          state.pendingNotes.some((entry) => entry.requestId === note.requestId)
          ? state
          : {
              ...state,
              pendingNotes: [...state.pendingNotes, note].slice(-CHILD_REQUEST_NOTE_LIMIT),
            };
      }
    }
  },
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
