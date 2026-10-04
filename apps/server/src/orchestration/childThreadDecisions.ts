/**
 * Child threads: the decider's side of threads an agent starts, the answers
 * they owe it, and the family they form (docs/design/child-threads.md). Each
 * function returns the events to plan, or a refusal to report. A decision can
 * touch both ends of a family (a settle writes the report into the parent and
 * marks the child handed back), so events are based per thread through
 * `baseFor`. The rules for who may ask live in `@threadlines/shared/childThreads`,
 * shared with the room MCP server.
 */
import {
  ChildRequestBatchId,
  type ChildRequestId,
  type ChildRequestOutcome,
  MessageId,
  type OrchestrationChildRequest,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationQueuedFollowUp,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@threadlines/contracts";
import {
  childAttachRefusal,
  childSendRefusal,
  childStartRefusal,
  isAttachedChild,
  ownChildRefusal,
} from "@threadlines/shared/childThreads";
import {
  APPROVAL_ACTIVITY_KINDS,
  collectOpenPendingRequests,
  countPendingUserInputs,
} from "@threadlines/shared/pendingRequests";
import { isAgentOrigin } from "@threadlines/shared/roomAgentRequests";
import { activeParticipants } from "@threadlines/shared/threadParticipants";

import { handOffReplyText } from "./agentRequestDecisions.ts";
import { currentAgentModel, messageAgentModels } from "./messageAgentModels.ts";

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;
/** Event fields for an event on `threadId`'s aggregate, from the command being decided. */
export type ChildEventBase = (
  threadId: ThreadId,
) => Omit<OrchestrationEvent, "sequence" | "type" | "payload">;
type CommandOf<Type extends OrchestrationCommand["type"]> = Extract<
  OrchestrationCommand,
  { readonly type: Type }
>;

/** Events to plan, or why the command is refused. */
export type ChildThreadDecision = ReadonlyArray<PlannedEvent> | { readonly refusal: string };

const refuse = (refusal: string) => ({ refusal });

const RUNTIME_MODE_RANK: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

/** Whether `child` asks for no more than `ceiling` allows. Plan is narrower than default. */
export function withinModeCeiling(
  child: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
  ceiling: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
): boolean {
  return (
    RUNTIME_MODE_RANK[child.runtimeMode] <= RUNTIME_MODE_RANK[ceiling.runtimeMode] &&
    (ceiling.interactionMode !== "plan" || child.interactionMode === "plan")
  );
}

/**
 * A launch narrowed to its parent's access now: a request approved after the
 * parent's access was lowered starts with the lower access, never the access
 * it was asked under.
 */
export function clampLaunchToCeiling<
  Launch extends {
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  },
>(
  launch: Launch,
  ceiling: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
): Launch {
  return {
    ...launch,
    runtimeMode:
      RUNTIME_MODE_RANK[launch.runtimeMode] <= RUNTIME_MODE_RANK[ceiling.runtimeMode]
        ? launch.runtimeMode
        : ceiling.runtimeMode,
    interactionMode: ceiling.interactionMode === "plan" ? "plan" : launch.interactionMode,
  };
}

/**
 * Whether a child is still being set up (its start request is `starting`):
 * nothing may run in it yet, or it would run before its worktree exists.
 */
export function isChildBeingSetUp(
  readModel: OrchestrationReadModel,
  thread: Pick<OrchestrationThread, "id" | "parentThreadId">,
): boolean {
  if (thread.parentThreadId === null) {
    return false;
  }
  const parent = readModel.threads.find((entry) => entry.id === thread.parentThreadId);
  return (
    parent?.childRequests.open.some(
      (request) =>
        request.childThreadId === thread.id &&
        request.kind === "start" &&
        request.status === "starting",
    ) ?? false
  );
}

/** Whether a parent's request is still open: the only kind a child may still run. */
export function isOpenParentRequest(
  readModel: OrchestrationReadModel,
  origin: { readonly threadId: ThreadId; readonly requestId: ChildRequestId },
): boolean {
  return (
    readModel.threads
      .find((entry) => entry.id === origin.threadId)
      ?.childRequests.open.some((request) => request.requestId === origin.requestId) ?? false
  );
}

const findThread = (readModel: OrchestrationReadModel, threadId: ThreadId) =>
  readModel.threads.find((thread) => thread.id === threadId && thread.deletedAt === null) ?? null;

/** The live threads in `parent`'s family. */
export const attachedChildrenOf = (readModel: OrchestrationReadModel, parentId: ThreadId) =>
  readModel.threads.filter(
    (thread) =>
      thread.deletedAt === null && thread.parentThreadId === parentId && thread.attachedToParent,
  );

const isPresent = (thread: OrchestrationThread, agent: { readonly participantId: unknown }) =>
  agent.participantId === null ||
  activeParticipants(thread).some((participant) => participant.id === agent.participantId);

const requestsFor = (parent: OrchestrationThread, childThreadId: ThreadId) =>
  parent.childRequests.open.filter((request) => request.childThreadId === childThreadId);

const settledEvent = (
  baseFor: ChildEventBase,
  parent: OrchestrationThread,
  request: OrchestrationChildRequest,
  outcome: ChildRequestOutcome,
  settledAt: string,
  options: { readonly error?: string | undefined; readonly note?: string | undefined } = {},
): PlannedEvent => ({
  ...baseFor(parent.id),
  type: "thread.child-request-settled",
  payload: {
    threadId: parent.id,
    requestId: request.requestId,
    childThreadId: request.childThreadId,
    outcome,
    ...(options.error !== undefined ? { error: options.error } : {}),
    ...(options.note !== undefined
      ? {
          note: {
            requestId: request.requestId,
            recipient: request.from,
            text: options.note,
            createdAt: settledAt,
          },
        }
      : {}),
    settledAt,
  },
});

/** Reports from `childThreadId` still queued in `parent`, taken back. */
const unqueueReportsFrom = (
  baseFor: ChildEventBase,
  parent: OrchestrationThread,
  childThreadId: ThreadId | null,
  createdAt: string,
): ReadonlyArray<PlannedEvent> =>
  (parent.queuedFollowUps ?? [])
    .filter(
      (queued) =>
        queued.fromThread?.kind === "report" &&
        (childThreadId === null || queued.fromThread.threadId === childThreadId),
    )
    .map((queued): PlannedEvent => ({
      ...baseFor(parent.id),
      type: "thread.follow-up-unqueued",
      payload: {
        threadId: parent.id,
        messageId: queued.messageId,
        reason: "cancelled",
        createdAt,
      },
    }));

const titleOf = (readModel: OrchestrationReadModel, request: OrchestrationChildRequest) =>
  findThread(readModel, request.childThreadId)?.title ?? request.launch?.title ?? "a thread";

/**
 * Every open request of `parent` (optionally only those for one child) is
 * over without an answer: each settles with `outcome`, and the agent that
 * asked hears of it at its next turn, one note per agent.
 */
function settleOpenRequests(
  readModel: OrchestrationReadModel,
  baseFor: ChildEventBase,
  parent: OrchestrationThread,
  requests: ReadonlyArray<OrchestrationChildRequest>,
  outcome: ChildRequestOutcome,
  createdAt: string,
  noteFor: (titles: ReadonlyArray<string>) => string,
): ReadonlyArray<PlannedEvent> {
  const noted = new Set<string>();
  return requests.map((request) => {
    const recipient = request.from.participantId ?? "primary";
    if (noted.has(recipient)) {
      return settledEvent(baseFor, parent, request, outcome, createdAt);
    }
    noted.add(recipient);
    const titles = requests
      .filter((entry) => (entry.from.participantId ?? "primary") === recipient)
      .map((entry) => titleOf(readModel, entry));
    return settledEvent(baseFor, parent, request, outcome, createdAt, { note: noteFor(titles) });
  });
}

const quotedList = (titles: ReadonlyArray<string>) =>
  titles.length === 1
    ? `'${titles[0]}'`
    : `${titles.length} threads (${titles.map((title) => `'${title}'`).join(", ")})`;

/** Start threads (`thread.child.start`). */
export function decideChildStart(
  readModel: OrchestrationReadModel,
  parent: OrchestrationThread,
  command: CommandOf<"thread.child.start">,
  baseFor: ChildEventBase,
): ChildThreadDecision {
  const refusal = childStartRefusal(parent, {
    from: command.from,
    callerTurnId: command.callerTurnId,
    count: command.children.length,
  });
  if (refusal !== null) {
    return refuse(refusal.detail);
  }
  const seen = new Set<string>();
  for (const child of command.children) {
    if (
      seen.has(child.childThreadId) ||
      readModel.threads.some((thread) => thread.id === child.childThreadId)
    ) {
      return refuse(`Thread '${child.childThreadId}' already exists.`);
    }
    seen.add(child.childThreadId);
    if (!withinModeCeiling(child.launch, parent)) {
      return refuse("A thread cannot be started with more access than the thread starting it.");
    }
  }
  return command.children.map((child): PlannedEvent => ({
    ...baseFor(parent.id),
    type: "thread.child-request-submitted",
    payload: {
      threadId: parent.id,
      request: {
        requestId: child.requestId,
        batchId: command.batchId,
        kind: "start",
        from: command.from,
        callerTurnId: command.callerTurnId,
        deliveryEpoch: parent.childRequests.deliveryEpoch,
        status: command.mode === "ask" ? "awaiting_user" : "starting",
        childThreadId: child.childThreadId,
        childMessageId: child.childMessageId,
        launch: child.launch,
        createdAt: command.createdAt,
      },
      createdAt: command.createdAt,
    },
  }));
}

/** The user's yes or no to starting a batch (`thread.child-request.respond`). */
export function decideChildRespond(
  readModel: OrchestrationReadModel,
  parent: OrchestrationThread,
  command: CommandOf<"thread.child-request.respond">,
  baseFor: ChildEventBase,
): ChildThreadDecision {
  const batch = parent.childRequests.open.filter(
    (request) => request.batchId === command.batchId && request.status === "awaiting_user",
  );
  if (batch.length === 0) {
    return refuse("Those threads are no longer waiting for an answer.");
  }
  if (command.choice === "decline") {
    return settleOpenRequests(
      readModel,
      baseFor,
      parent,
      batch,
      "declined",
      command.createdAt,
      (titles) =>
        `The user said not now to starting ${quotedList(titles)}. Don't ask again unless the user asks you to.`,
    );
  }
  return batch.map((request): PlannedEvent => ({
    ...baseFor(parent.id),
    type: "thread.child-request-updated",
    payload: {
      threadId: parent.id,
      requestId: request.requestId,
      status: "starting",
      updatedAt: command.createdAt,
    },
  }));
}

/** A message from an agent to one of its children (`thread.child.send`). */
export function decideChildSend(
  readModel: OrchestrationReadModel,
  parent: OrchestrationThread,
  command: CommandOf<"thread.child.send">,
  baseFor: ChildEventBase,
): ChildThreadDecision {
  const child = findThread(readModel, command.childThreadId);
  const refusal = childSendRefusal(parent, child, {
    from: command.from,
    callerTurnId: command.callerTurnId,
  });
  if (refusal !== null || child === null) {
    return refuse(refusal?.detail ?? "That thread is gone.");
  }
  if (isChildBeingSetUp(readModel, child)) {
    return refuse("That thread is still being set up. Send it a message once it has started.");
  }
  if (
    child.messages.some((message) => message.id === command.childMessageId) ||
    parent.childRequests.open.some((request) => request.requestId === command.requestId)
  ) {
    return refuse("That message was already sent.");
  }
  const fromThread = {
    threadId: parent.id,
    requestId: command.requestId,
    kind: "request" as const,
  };
  return [
    {
      ...baseFor(parent.id),
      type: "thread.child-request-submitted",
      payload: {
        threadId: parent.id,
        request: {
          requestId: command.requestId,
          // A send is its own batch of one.
          batchId: ChildRequestBatchId.make(command.requestId),
          kind: "send",
          from: command.from,
          callerTurnId: command.callerTurnId,
          deliveryEpoch: parent.childRequests.deliveryEpoch,
          status: "queued",
          childThreadId: child.id,
          childMessageId: command.childMessageId,
          createdAt: command.createdAt,
        },
        createdAt: command.createdAt,
      },
    },
    {
      ...baseFor(child.id),
      type: "thread.message-sent",
      payload: {
        threadId: child.id,
        messageId: command.childMessageId,
        role: "user",
        text: command.text,
        attachments: [],
        fromThread,
        turnId: null,
        streaming: false,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      },
    },
    {
      ...baseFor(child.id),
      type: "thread.follow-up-queued",
      payload: {
        threadId: child.id,
        followUp: {
          messageId: command.childMessageId,
          text: command.text,
          attachments: [],
          fromThread,
          runtimeMode: child.runtimeMode,
          interactionMode: child.interactionMode,
          createdAt: command.createdAt,
        },
      },
    },
  ];
}

/** A request moved on (`thread.child-request.update`). */
export function decideChildRequestUpdate(
  parent: OrchestrationThread,
  command: CommandOf<"thread.child-request.update">,
  baseFor: ChildEventBase,
): ChildThreadDecision {
  const request = parent.childRequests.open.find((entry) => entry.requestId === command.requestId);
  if (request === undefined) {
    return refuse(`Request '${command.requestId}' is not open.`);
  }
  if (request.status === "awaiting_user" && command.status !== "awaiting_user") {
    return refuse("That request is waiting for the user.");
  }
  return [
    {
      ...baseFor(parent.id),
      type: "thread.child-request-updated",
      payload: {
        threadId: parent.id,
        requestId: request.requestId,
        status: command.status,
        ...(command.candidateTurnId !== undefined
          ? { candidateTurnId: command.candidateTurnId }
          : {}),
        updatedAt: command.createdAt,
      },
    },
  ];
}

/** The id of the report a request's answer is delivered as, so routing it twice finds it sent. */
export const childReportMessageId = (requestId: ChildRequestId) =>
  MessageId.make(`child-report:${requestId}`);

/**
 * A request is over (`thread.child-request.settle`). An answer (or a failure
 * the asking agent must hear of) is written into the parent as a report and
 * queued for the agent that asked, in the same step, unless its delivery was
 * cancelled meanwhile: Stop or wrap moved the parent's epoch, the child was
 * separated or is gone, or the asking agent left. Only a report actually
 * written marks the child handed back.
 */
export function decideChildRequestSettle(
  readModel: OrchestrationReadModel,
  parent: OrchestrationThread,
  command: CommandOf<"thread.child-request.settle">,
  baseFor: ChildEventBase,
): ChildThreadDecision {
  const request = parent.childRequests.open.find((entry) => entry.requestId === command.requestId);
  if (request === undefined) {
    return refuse(`Request '${command.requestId}' is not open.`);
  }
  const settled = settledEvent(baseFor, parent, request, command.outcome, command.createdAt, {
    error: command.error,
    note: command.note,
  });
  const reply = command.reply;
  const child = findThread(readModel, request.childThreadId);
  if (
    reply === undefined ||
    child === null ||
    !child.attachedToParent ||
    child.parentThreadId !== parent.id ||
    request.deliveryEpoch !== parent.childRequests.deliveryEpoch ||
    parent.archivedAt !== null ||
    !isPresent(parent, request.from) ||
    parent.messages.some((message) => message.id === reply.messageId)
  ) {
    return [settled];
  }
  const fromThread = {
    threadId: child.id,
    requestId: request.requestId,
    kind: "report" as const,
    deliveryEpoch: parent.childRequests.deliveryEpoch,
    attachmentEpoch: child.parentAttachmentEpoch,
  };
  const text = reply.text;
  const participantId = request.from.participantId;
  return [
    settled,
    {
      ...baseFor(parent.id),
      type: "thread.message-sent",
      payload: {
        threadId: parent.id,
        messageId: reply.messageId,
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
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      },
    },
    {
      ...baseFor(parent.id),
      type: "thread.follow-up-queued",
      payload: {
        threadId: parent.id,
        followUp: {
          messageId: reply.messageId,
          text,
          attachments: [],
          ...(participantId !== null ? { participantId } : {}),
          fromThread,
          runtimeMode: parent.runtimeMode,
          interactionMode: parent.interactionMode,
          createdAt: command.createdAt,
        },
      },
    },
    {
      ...baseFor(child.id),
      type: "thread.handed-back",
      payload: { threadId: child.id, turnId: reply.turnId, handedBackAt: command.createdAt },
    },
  ];
}

/** Notes went out with an agent's turn (`thread.child-notes.delivered`). */
export function decideChildNotesDelivered(
  parent: OrchestrationThread,
  command: CommandOf<"thread.child-notes.delivered">,
  baseFor: ChildEventBase,
): ChildThreadDecision {
  if (
    !parent.childRequests.pendingNotes.some((note) => command.requestIds.includes(note.requestId))
  ) {
    return refuse("Those notes were already delivered.");
  }
  return [
    {
      ...baseFor(parent.id),
      type: "thread.child-notes-delivered",
      payload: {
        threadId: parent.id,
        requestIds: command.requestIds,
        createdAt: command.createdAt,
      },
    },
  ];
}

/**
 * Separate a thread from its parent's family, or put it back
 * (`thread.parent-attachment.set`). Separating cancels what its parent was
 * still owed from it, and takes back its reports still queued there.
 */
export function decideParentAttachmentSet(
  readModel: OrchestrationReadModel,
  child: OrchestrationThread,
  command: CommandOf<"thread.parent-attachment.set">,
  baseFor: ChildEventBase,
): ChildThreadDecision {
  if (child.parentThreadId === null) {
    return refuse("This thread was not started by another thread.");
  }
  if (child.attachedToParent === command.attached) {
    return refuse(
      command.attached ? "It is already in its family." : "It is already its own thread.",
    );
  }
  const parent = findThread(readModel, child.parentThreadId);
  const attachmentEvent: PlannedEvent = {
    ...baseFor(child.id),
    type: "thread.parent-attachment-set",
    payload: {
      threadId: child.id,
      attached: command.attached,
      attachmentEpoch: child.parentAttachmentEpoch + 1,
      at: command.createdAt,
    },
  };
  if (command.attached) {
    const refusal = childAttachRefusal(
      child,
      parent,
      attachedChildrenOf(readModel, child.id).length > 0,
    );
    return refusal !== null ? refuse(refusal) : [attachmentEvent];
  }
  return [
    attachmentEvent,
    ...separationEvents(readModel, baseFor, parent, child, command.createdAt),
  ];
}

/** What the parent loses when `child` leaves its family. */
function separationEvents(
  readModel: OrchestrationReadModel,
  baseFor: ChildEventBase,
  parent: OrchestrationThread | null,
  child: OrchestrationThread,
  createdAt: string,
): ReadonlyArray<PlannedEvent> {
  if (parent === null) {
    return [];
  }
  return [
    ...settleOpenRequests(
      readModel,
      baseFor,
      parent,
      requestsFor(parent, child.id),
      "cancelled",
      createdAt,
      (titles) =>
        `The user made ${quotedList(titles)} its own thread, so its answer won't come back to you.`,
    ),
    ...unqueueReportsFrom(baseFor, parent, child.id, createdAt),
  ];
}

/** Whether a child has work going: a turn, a start, background work, or work it asked for. */
export function childHasLiveWork(thread: OrchestrationThread): boolean {
  const session = thread.session;
  const latestTurnId = thread.latestTurn?.turnId ?? null;
  return (
    // Waiting on the user counts too: an approval, a question, a plan to act on.
    collectOpenPendingRequests(thread.activities, APPROVAL_ACTIVITY_KINDS).length > 0 ||
    countPendingUserInputs(thread.activities).pendingUserInputCount > 0 ||
    thread.proposedPlans.some(
      (plan) =>
        latestTurnId !== null &&
        plan.turnId === latestTurnId &&
        plan.implementedAt === null &&
        plan.dismissedAt === null,
    ) ||
    thread.latestTurn?.state === "running" ||
    session?.status === "running" ||
    session?.status === "starting" ||
    (session?.awaitedBackgroundTaskCount ?? session?.pendingBackgroundTaskCount ?? 0) > 0 ||
    (thread.queuedFollowUps ?? []).length > 0 ||
    (thread.sideTurn ?? null) !== null ||
    thread.childRequests.open.length > 0
  );
}

/**
 * Stop threads in a parent's family (`thread.children.stop`): the parent's
 * requests for them settle stopped, its agent hears of it at its next turn,
 * and each child's whole session is stopped (decided by the caller, which
 * appends `thread.session.stop` for every child returned).
 */
export function decideChildrenStop(
  readModel: OrchestrationReadModel,
  parent: OrchestrationThread,
  command: CommandOf<"thread.children.stop">,
  baseFor: ChildEventBase,
):
  | { readonly events: ReadonlyArray<PlannedEvent>; readonly childIds: ReadonlyArray<ThreadId> }
  | { readonly refusal: string } {
  const targets =
    command.childThreadIds === undefined
      ? attachedChildrenOf(readModel, parent.id).filter(
          (child) => childHasLiveWork(child) || requestsFor(parent, child.id).length > 0,
        )
      : command.childThreadIds.map((id) => findThread(readModel, id));
  const children: OrchestrationThread[] = [];
  for (const child of targets) {
    const refusal = ownChildRefusal(parent, child);
    if (refusal !== null || child === null) {
      return refuse(refusal?.detail ?? "That thread is gone.");
    }
    children.push(child);
  }
  if (children.length === 0) {
    return refuse("None of its threads are working.");
  }
  const stoppedIds = new Set(children.map((child) => child.id));
  return {
    events: [
      ...settleOpenRequests(
        readModel,
        baseFor,
        parent,
        parent.childRequests.open.filter((request) => stoppedIds.has(request.childThreadId)),
        "stopped",
        command.createdAt,
        (titles) =>
          `${quotedList(titles)} ${titles.length === 1 ? "was" : "were"} stopped, so no answer will come back.`,
      ),
      // An answer a child gave just before it was stopped does not come back
      // either: queued ones are taken back, and one already on its way to a
      // turn is cut off by moving the child's delivery epoch.
      ...children.flatMap((child): ReadonlyArray<PlannedEvent> => [
        ...unqueueReportsFrom(baseFor, parent, child.id, command.createdAt),
        {
          ...baseFor(child.id),
          type: "thread.parent-attachment-set",
          payload: {
            threadId: child.id,
            attached: true,
            attachmentEpoch: child.parentAttachmentEpoch + 1,
            at: command.createdAt,
          },
        },
      ]),
    ],
    childIds: children.map((child) => child.id),
  };
}

/**
 * Stop in a parent, or the parent was wrapped or archived: no answer asked
 * for so far comes back. The delivery epoch moves (catching a report already
 * on its way to a turn), every open request settles, and reports still
 * queued are taken back. The children keep running.
 */
export function decideChildDeliveriesStop(
  readModel: OrchestrationReadModel,
  parent: OrchestrationThread,
  baseFor: ChildEventBase,
  createdAt: string,
  cause: "stopped" | "wrapped" | "archived",
): ReadonlyArray<PlannedEvent> {
  const open = parent.childRequests.open;
  // Stop's chain stop already takes back every message agents queued, these
  // reports included; wrapping and archiving have no chain stop to do it.
  const unqueueReports = cause !== "stopped";
  const hasQueuedReports = (parent.queuedFollowUps ?? []).some(
    (queued) => queued.fromThread?.kind === "report",
  );
  // A report already taken off the queue and being prepared leaves nothing
  // open and nothing queued; while the thread has a family the epoch moves
  // anyway, so that report is caught before it is sent.
  if (
    open.length === 0 &&
    !hasQueuedReports &&
    attachedChildrenOf(readModel, parent.id).length === 0
  ) {
    return [];
  }
  const outcome: ChildRequestOutcome = cause === "stopped" ? "stopped" : "cancelled";
  const why =
    cause === "stopped"
      ? "The user stopped you."
      : cause === "wrapped"
        ? "The user wrapped up this thread."
        : "The user archived this thread.";
  return [
    {
      ...baseFor(parent.id),
      type: "thread.child-deliveries-cancelled",
      payload: {
        threadId: parent.id,
        deliveryEpoch: parent.childRequests.deliveryEpoch + 1,
        createdAt,
      },
    },
    ...settleOpenRequests(
      readModel,
      baseFor,
      parent,
      open,
      outcome,
      createdAt,
      (titles) =>
        `${why} ${quotedList(titles)} ${titles.length === 1 ? "keeps" : "keep"} running unless stopped, but no answer will come back to you.`,
    ),
    ...(unqueueReports ? unqueueReportsFrom(baseFor, parent, null, createdAt) : []),
  ];
}

/**
 * A parent's request messages taken back in its child before they ran (the
 * user unqueued one, or Stop in the child): those requests can never be
 * answered, so they settle cancelled and the asking agent hears of it.
 */
export function settleParentRequestsForUnqueued(
  readModel: OrchestrationReadModel,
  child: OrchestrationThread,
  messageIds: ReadonlyArray<MessageId>,
  baseFor: ChildEventBase,
  createdAt: string,
): ReadonlyArray<PlannedEvent> {
  if (child.parentThreadId === null || messageIds.length === 0) {
    return [];
  }
  const parent = findThread(readModel, child.parentThreadId);
  if (parent === null) {
    return [];
  }
  const requests = parent.childRequests.open.filter(
    (request) => request.childThreadId === child.id && messageIds.includes(request.childMessageId),
  );
  return settleOpenRequests(
    readModel,
    baseFor,
    parent,
    requests,
    "cancelled",
    createdAt,
    (titles) => `Your message to ${quotedList(titles)} was taken back before it ran.`,
  );
}

/**
 * A thread is deleted. A parent's family is separated (or, with
 * `withChildren`, deleted by the caller); a child's open requests on its
 * parent are cancelled and its queued reports taken back.
 */
export function childDeletionEvents(
  readModel: OrchestrationReadModel,
  thread: OrchestrationThread,
  baseFor: ChildEventBase,
  createdAt: string,
  withChildren: boolean,
  verb: "deleted" | "archived" = "deleted",
): ReadonlyArray<PlannedEvent> {
  // Children deleted along with it need nothing; the rest (all of them, or
  // with `withChildren` the archived ones) are separated.
  const familyEvents = attachedChildrenOf(readModel, thread.id)
    .filter((child) => !withChildren || child.archivedAt !== null)
    .map((child): PlannedEvent => ({
      ...baseFor(child.id),
      type: "thread.parent-attachment-set",
      payload: {
        threadId: child.id,
        attached: false,
        attachmentEpoch: child.parentAttachmentEpoch + 1,
        at: createdAt,
      },
    }));
  const parent =
    thread.parentThreadId !== null && thread.attachedToParent
      ? findThread(readModel, thread.parentThreadId)
      : null;
  return [
    ...familyEvents,
    ...(parent !== null
      ? [
          ...settleOpenRequests(
            readModel,
            baseFor,
            parent,
            requestsFor(parent, thread.id),
            "cancelled",
            createdAt,
            (titles) => `The user ${verb} ${quotedList(titles)}, so no answer will come back.`,
          ),
          ...unqueueReportsFrom(baseFor, parent, thread.id, createdAt),
        ]
      : []),
  ];
}

/**
 * What archiving a parent does to its family: settled children archive with
 * it (stamped, so unarchiving the parent brings them back), live ones are
 * separated first and keep running on their own.
 */
export function childArchivePlan(
  readModel: OrchestrationReadModel,
  parent: OrchestrationThread,
): {
  readonly archive: ReadonlyArray<OrchestrationThread>;
  readonly separate: ReadonlyArray<OrchestrationThread>;
} {
  const children = attachedChildrenOf(readModel, parent.id).filter(
    (child) => child.archivedAt === null,
  );
  // A child its parent still has a request open for is at work for it, even
  // one with nothing running yet because it is still being set up.
  const live = (child: OrchestrationThread) =>
    childHasLiveWork(child) || requestsFor(parent, child.id).length > 0;
  return {
    archive: children.filter((child) => !live(child)),
    separate: children.filter(live),
  };
}

/** The children an unarchive of `parent` brings back: those its archive took along. */
export const childrenArchivedWith = (
  readModel: OrchestrationReadModel,
  parent: OrchestrationThread,
) =>
  parent.archivedAt === null
    ? []
    : readModel.threads.filter(
        (thread) =>
          thread.deletedAt === null &&
          thread.parentThreadId === parent.id &&
          thread.archivedAt !== null &&
          thread.archivedWithParentAt === parent.archivedAt,
      );

/**
 * Whether a revert would land work out from under a family: a parent with
 * requests or reports still owed, or a child working on its parent's request.
 */
export function childRevertRefusal(
  readModel: OrchestrationReadModel,
  thread: OrchestrationThread,
): string | null {
  if (
    thread.childRequests.open.length > 0 ||
    (thread.queuedFollowUps ?? []).some((queued) => queued.fromThread?.kind === "report")
  ) {
    return "Finish or stop its threads first: their answers are about work a revert would take back.";
  }
  if (thread.parentThreadId !== null && thread.attachedToParent) {
    const parent = findThread(readModel, thread.parentThreadId);
    if (parent !== null && requestsFor(parent, thread.id).length > 0) {
      return "This thread is working on its parent's request. Let it finish, or stop it first.";
    }
  }
  return null;
}

/**
 * A queued report whose delivery was cancelled after it was queued (Stop,
 * wrap, the child separated or gone): sending it is refused and it is taken
 * back instead.
 */
export function isStaleReport(
  readModel: OrchestrationReadModel,
  parent: OrchestrationThread,
  origin: OrchestrationQueuedFollowUp["fromThread"],
): boolean {
  if (origin === undefined || origin.kind !== "report") {
    return false;
  }
  const child = findThread(readModel, origin.threadId);
  return (
    origin.deliveryEpoch !== parent.childRequests.deliveryEpoch ||
    child === null ||
    child.parentThreadId !== parent.id ||
    !child.attachedToParent ||
    origin.attachmentEpoch !== child.parentAttachmentEpoch
  );
}

/** The text an answer is delivered as: the child's last reply, clipped like a hand-off's. */
export const childReportText = (text: string | undefined) => handOffReplyText(text);

/** Whether an entry is agent traffic, which never changes the thread's settings when sent. */
export const isAgentQueued = (queued: {
  readonly fromAgent?: unknown;
  readonly fromThread?: unknown;
}) => isAgentOrigin(queued);

export { isAttachedChild };
