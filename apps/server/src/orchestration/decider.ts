import {
  DEFAULT_PROJECT_KIND,
  EMPTY_AGENT_REQUEST_STATE,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  SIDE_ANSWER_OUTCOME_ACTIVITY_KIND,
  type SideTurnId,
  type ThreadParticipantId,
} from "@threadlines/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { areFilesystemPathsEqual } from "@threadlines/shared/path";
import { findProviderAuthRetryUserMessageIndex } from "@threadlines/shared/providerAuth";
import {
  activeParticipants,
  findActiveParticipantByHandle,
  isRoomThread,
  isValidParticipantId,
  sessionSlotParticipantId,
} from "@threadlines/shared/threadParticipants";
import {
  assistantMessageModel,
  currentAgentModel,
  messageAgentModels,
  sentAgentModel,
} from "./messageAgentModels.ts";

import { isTurnAside } from "@threadlines/shared/transcriptRevert";
import { isAttachedChild } from "@threadlines/shared/childThreads";
import { isAgentOrigin } from "@threadlines/shared/roomAgentRequests";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  type AgentRequestDecision,
  cancelAgentRequestsForLeaving,
  decideAgentChainStop,
  decideAgentInviteRespond,
  decideAgentRequestDetach,
  decideAgentRequestQueue,
  decideAgentRequestSettle,
  decideAgentRequestSubmit,
  hasOpenAgentRequests,
  resetAgentRequestsForUser,
  settleAgentRequestForSideTurn,
} from "./agentRequestDecisions.ts";
import {
  findProjectById,
  listThreadsByProjectId,
  requireNonNegativeInteger,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
  requireThreadNotPinned,
  requireThreadPinned,
  requireWorkspaceProject,
} from "./commandInvariants.ts";
import {
  type ChildEventBase,
  type ChildThreadDecision,
  attachedChildrenOf,
  childArchivePlan,
  childDeletionEvents,
  childRevertRefusal,
  childrenArchivedWith,
  decideChildDeliveriesStop,
  decideChildNotesDelivered,
  decideChildRequestSettle,
  decideChildRequestUpdate,
  decideChildRespond,
  decideChildSend,
  decideChildStart,
  decideChildrenStop,
  decideParentAttachmentSet,
  isChildBeingSetUp,
  isOpenParentRequest,
  isStaleReport,
  settleParentRequestsForUnqueued,
  withinModeCeiling,
} from "./childThreadDecisions.ts";
import { childDeliveryForQuietCandidate } from "./childThreadDelivery.ts";
import { projectEvent } from "./projector.ts";
import { canReplaceThreadTitle } from "./threadTitle.ts";
import { carriedBackgroundTasks } from "./sessionBackgroundTasks.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function normalizeWorktreePath(worktreePath: string | null, workspaceRoot: string): string | null {
  return worktreePath !== null && areFilesystemPathsEqual(worktreePath, workspaceRoot)
    ? null
    : worktreePath;
}

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Omit<OrchestrationEvent, "sequence" | "type" | "payload"> {
  return {
    eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    causationEventId: null,
    correlationId: input.commandId,
    metadata: input.metadata ?? {},
  };
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

/**
 * A side answer's output is only taken while that answer is open. Once it
 * settles it is final: a late flush or step from its runtime is refused, never
 * written over the answer.
 */
function requireSideTurnOpen(
  thread: Pick<OrchestrationThread, "id" | "sideTurn">,
  command: { readonly type: string; readonly sideTurnId?: SideTurnId | undefined },
) {
  if (command.sideTurnId === undefined || thread.sideTurn?.sideTurnId === command.sideTurnId) {
    return Effect.void;
  }
  return Effect.fail(
    new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Side answer '${command.sideTurnId}' on thread '${thread.id}' is over.`,
    }),
  );
}

/** Whether a message is not recorded yet. Recent ones sit at the end. */
function isNewMessage(thread: Pick<OrchestrationThread, "messages">, messageId: MessageId) {
  return thread.messages.findLast((message) => message.id === messageId) === undefined;
}

/**
 * An assistant message's model stamp, on the write that creates it only: its
 * later deltas leave it alone, so they stay small.
 */
function assistantMessageStamp(
  thread: Pick<
    OrchestrationThread,
    "messages" | "modelSelection" | "participants" | "sentModels" | "sideTurn"
  >,
  messageId: MessageId,
  author: ThreadParticipantId | null,
  sideTurnId: SideTurnId | undefined,
) {
  return isNewMessage(thread, messageId)
    ? {
        agentModels: messageAgentModels(thread, [
          {
            participantId: author,
            modelSelection: assistantMessageModel(thread, author, sideTurnId),
          },
        ]),
      }
    : {};
}

/** One event, after any extra ones it brings; a lone event stays a lone event. */
function withLeadingEvents(
  leading: ReadonlyArray<PlannedOrchestrationEvent>,
  event: PlannedOrchestrationEvent,
): DecideOrchestrationCommandResult {
  return leading.length > 0 ? [...leading, event] : event;
}

/** Plan an agent-request decision's events, or refuse the command with its reason. */
function planAgentRequestDecision(commandType: string, decision: AgentRequestDecision) {
  return "refusal" in decision
    ? Effect.fail(new OrchestrationCommandInvariantError({ commandType, detail: decision.refusal }))
    : Effect.succeed(decision);
}

/** Plan a child-thread decision's events, or refuse the command with its reason. */
function planChildThreadDecision(commandType: string, decision: ChildThreadDecision) {
  return "refusal" in decision
    ? Effect.fail(new OrchestrationCommandInvariantError({ commandType, detail: decision.refusal }))
    : Effect.succeed(decision);
}

/** Event fields for any thread's aggregate, from one command: a family decision touches two. */
function childEventBase(
  command: Pick<OrchestrationCommand, "commandId">,
  occurredAt: string,
): ChildEventBase {
  return (threadId) =>
    withEventBase({
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt,
      commandId: command.commandId,
    });
}

/** The user wrote: the per-message child thread counts start over. */
function resetChildRequestsForUser(
  thread: OrchestrationThread,
  base: () => Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  createdAt: string,
): ReadonlyArray<PlannedOrchestrationEvent> {
  const state = thread.childRequests;
  return state.startsSinceUser === 0 && state.sendsSinceUser === 0
    ? []
    : [
        {
          ...base(),
          type: "thread.child-requests-reset",
          payload: { threadId: thread.id, createdAt },
        },
      ];
}

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<ReadonlyArray<PlannedOrchestrationEvent>, OrchestrationCommandInvariantError> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

/**
 * Child threads: the user writes to a child whose answer to its parent was
 * waiting on the child's background work. The answer so far goes back now,
 * before the user's turn, so the user taking over never changes what the
 * parent receives.
 */
function settleCandidateBeforeUserTurn(
  readModel: OrchestrationReadModel,
  child: OrchestrationThread,
  command: Pick<OrchestrationCommand, "commandId"> & { readonly createdAt: string },
): ReadonlyArray<PlannedOrchestrationEvent> {
  if (child.parentThreadId === null) {
    return [];
  }
  const parent = readModel.threads.find(
    (entry) => entry.id === child.parentThreadId && entry.deletedAt === null,
  );
  const request = parent?.childRequests.open.find(
    (entry) => entry.childThreadId === child.id && entry.status === "awaiting_background",
  );
  if (parent === undefined || request === undefined) {
    return [];
  }
  const delivery = childDeliveryForQuietCandidate(child, request);
  if (delivery === null || delivery.type !== "thread.child-request.settle") {
    return [];
  }
  const decision = decideChildRequestSettle(
    readModel,
    parent,
    { ...delivery, threadId: parent.id, createdAt: command.createdAt },
    childEventBase(command, command.createdAt),
  );
  return "refusal" in decision ? [] : decision;
}

/**
 * Child threads on Stop (or a session stop) in `thread`: what it was owed by
 * its own children will not come back, and a parent's requests still queued
 * here (taken back by the chain stop) can never be answered.
 */
function childStopEvents(
  readModel: OrchestrationReadModel,
  thread: OrchestrationThread,
  command: Pick<OrchestrationCommand, "commandId">,
  createdAt: string,
): ReadonlyArray<PlannedOrchestrationEvent> {
  const baseFor = childEventBase(command, createdAt);
  return [
    ...decideChildDeliveriesStop(readModel, thread, baseFor, createdAt, "stopped"),
    ...settleParentRequestsForUnqueued(
      readModel,
      thread,
      (thread.queuedFollowUps ?? [])
        .filter((queued) => queued.fromThread?.kind === "request")
        .map((queued) => queued.messageId),
      baseFor,
      createdAt,
    ),
  ];
}

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<DecideOrchestrationCommandResult, OrchestrationCommandInvariantError> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });

      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          kind: command.kind ?? DEFAULT_PROJECT_KIND,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireWorkspaceProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireWorkspaceProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = yield* nowIso;
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (project.kind === "general-chat" && (command.branch || command.worktreePath)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "General Chat threads do not support branches or worktrees.",
        });
      }
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      // A thread started by another thread's agent: its parent must be a live
      // thread of the same project, and not itself a child (one level deep).
      const parentThreadId = command.parentThreadId;
      if (parentThreadId !== undefined) {
        const parent = readModel.threads.find(
          (entry) => entry.id === parentThreadId && entry.deletedAt === null,
        );
        const lineageRefusal =
          parentThreadId === command.threadId
            ? "A thread cannot start itself."
            : parent === undefined
              ? `Thread '${parentThreadId}' does not exist.`
              : parent.projectId !== command.projectId
                ? "A thread can only start threads in its own project."
                : isAttachedChild(parent)
                  ? "A thread started by another thread cannot start threads itself."
                  : !withinModeCeiling(command, parent)
                    ? "A thread cannot be started with more access than the thread starting it."
                    : null;
        if (lineageRefusal !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: lineageRefusal,
          });
        }
      }
      // A thread set up as a room before its first message starts with its
      // agents: all of them are checked before any is recorded.
      const startingAgents = command.participants ?? [];
      const seenIds = new Set<string>();
      const seenHandles = new Set<string>();
      for (const agent of startingAgents) {
        const refuse = (detail: string) =>
          new OrchestrationCommandInvariantError({ commandType: command.type, detail });
        if (!isValidParticipantId(agent.id)) {
          return yield* refuse(`Agent id '${agent.id}' must be a UUID.`);
        }
        if (seenIds.has(agent.id)) {
          return yield* refuse(`Agent '${agent.id}' is listed twice.`);
        }
        const handleKey = agent.handle.trim().toLowerCase();
        if (seenHandles.has(handleKey)) {
          return yield* refuse(`Two agents are called ${agent.handle}.`);
        }
        seenIds.add(agent.id);
        seenHandles.add(handleKey);
      }
      const threadBase = () =>
        withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        });
      const createdEvent: PlannedOrchestrationEvent = {
        ...threadBase(),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: normalizeWorktreePath(command.worktreePath, project.workspaceRoot),
          ...(parentThreadId !== undefined
            ? {
                parentThreadId,
                ...(command.parentTurnId !== undefined
                  ? { parentTurnId: command.parentTurnId }
                  : {}),
                attachedToParent: command.attachedToParent === true,
              }
            : {}),
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      if (startingAgents.length === 0 && command.agentRole === undefined) {
        return createdEvent;
      }
      const ownAgentNamedEvents: Array<PlannedOrchestrationEvent> =
        command.agentRole === undefined
          ? []
          : [
              {
                ...threadBase(),
                type: "thread.participant-updated",
                payload: {
                  threadId: command.threadId,
                  participantId: null,
                  role: command.agentRole,
                  updatedAt: command.createdAt,
                },
              },
            ];
      const agentAddedEvents = startingAgents.map((agent): PlannedOrchestrationEvent => ({
        ...threadBase(),
        type: "thread.participant-added",
        payload: {
          threadId: command.threadId,
          participant: {
            id: agent.id,
            handle: agent.handle,
            ...(agent.role !== undefined ? { role: agent.role } : {}),
            modelSelection: agent.modelSelection,
            joinedAt: command.createdAt,
            leftAt: null,
          },
          updatedAt: command.createdAt,
        },
      }));
      return [createdEvent, ...ownAgentNamedEvents, ...agentAddedEvents];
    }

    case "thread.fork": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sourceThread = yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      if (sourceThread.projectId !== command.projectId) {
        // "Continue in project" forks a General Chat into a workspace
        // project; any other cross-project fork remains invalid.
        const sourceProject = findProjectById(readModel, sourceThread.projectId);
        if (sourceProject?.kind !== "general-chat") {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Source thread '${command.sourceThreadId}' belongs to a different project.`,
          });
        }
      }
      if (!sourceThread.messages.some((message) => message.id === command.sourceMessageId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Source message '${command.sourceMessageId}' does not exist on thread '${command.sourceThreadId}'.`,
        });
      }

      const createdEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: normalizeWorktreePath(command.worktreePath, project.workspaceRoot),
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const forkActivityEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: createdEvent.eventId,
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: {
            id: crypto.randomUUID() as OrchestrationEvent["eventId"],
            tone: "info",
            kind: "thread.fork.context",
            summary: "Fork context carried over",
            payload: command.forkContext,
            turnId: null,
            createdAt: command.createdAt,
          },
        },
      };
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: forkActivityEvent.eventId,
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments ?? [],
          ...(command.message.skills !== undefined ? { skills: command.message.skills } : {}),
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const startingSessionEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: userMessageEvent.eventId,
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: {
            threadId: command.threadId,
            status: "starting",
            providerName: null,
            providerInstanceId: command.modelSelection.instanceId,
            providerSessionId: null,
            providerThreadId: null,
            runtimeMode: command.runtimeMode,
            activeTurnId: null,
            lastError: null,
            updatedAt: command.createdAt,
          },
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          modelSelection: command.modelSelection,
          titleSeed: command.title,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          providerContext: command.providerContext,
          providerAttachments: command.providerAttachments,
          ...(command.message.skills !== undefined ? { skills: command.message.skills } : {}),
          // A new thread starts at the first Stop count; it can become a room
          // while this turn is prepared.
          chainEpoch: EMPTY_AGENT_REQUEST_STATE.chainEpoch,
          createdAt: command.createdAt,
        },
      };

      return [
        createdEvent,
        forkActivityEvent,
        userMessageEvent,
        startingSessionEvent,
        turnStartRequestedEvent,
      ];
    }

    case "thread.delete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      const deletedEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
      // Child threads: its family is separated (or deleted with it), and a
      // child's parent stops waiting on it.
      const withChildren = command.withChildren === true;
      const familyEvents = childDeletionEvents(
        readModel,
        thread,
        childEventBase(command, occurredAt),
        occurredAt,
        withChildren,
      );
      // Only the children the user was shown: the ones not archived. An
      // archived child is separated instead and lives on in the archive.
      const childDeletes = withChildren
        ? yield* decideCommandSequence({
            readModel,
            commands: attachedChildrenOf(readModel, thread.id)
              .filter((child) => child.archivedAt === null)
              .map((child): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: child.id,
              })),
          })
        : [];
      return familyEvents.length === 0 && childDeletes.length === 0
        ? deletedEvent
        : [...familyEvents, ...childDeletes, deletedEvent];
    }

    case "thread.archive": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      const baseFor = childEventBase(command, occurredAt);
      const archivedEvent: PlannedOrchestrationEvent = {
        ...baseFor(command.threadId),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
      // Child threads: nothing it asked for comes back any more; its settled
      // children are archived with it and its live ones separated; a child's
      // parent stops waiting on it.
      const plan = childArchivePlan(readModel, thread);
      const familyEvents: ReadonlyArray<PlannedOrchestrationEvent> = [
        ...decideChildDeliveriesStop(readModel, thread, baseFor, occurredAt, "archived"),
        ...plan.separate.map((child): PlannedOrchestrationEvent => ({
          ...baseFor(child.id),
          type: "thread.parent-attachment-set",
          payload: {
            threadId: child.id,
            attached: false,
            attachmentEpoch: child.parentAttachmentEpoch + 1,
            at: occurredAt,
          },
        })),
        ...plan.archive.map((child): PlannedOrchestrationEvent => ({
          ...baseFor(child.id),
          type: "thread.archived",
          payload: {
            threadId: child.id,
            archivedAt: occurredAt,
            withParent: true,
            updatedAt: occurredAt,
          },
        })),
        ...childDeletionEvents(readModel, thread, baseFor, occurredAt, true, "archived"),
      ];
      return familyEvents.length === 0 ? archivedEvent : [...familyEvents, archivedEvent];
    }

    case "thread.unarchive": {
      const thread = yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      const baseFor = childEventBase(command, occurredAt);
      const unarchivedEvent: PlannedOrchestrationEvent = {
        ...baseFor(command.threadId),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
      // The children its archive took along come back with it.
      const children = childrenArchivedWith(readModel, thread);
      return children.length === 0
        ? unarchivedEvent
        : [
            unarchivedEvent,
            ...children.map((child): PlannedOrchestrationEvent => ({
              ...baseFor(child.id),
              type: "thread.unarchived",
              payload: { threadId: child.id, updatedAt: occurredAt },
            })),
          ];
    }

    case "thread.pin": {
      yield* requireThreadNotPinned({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pinned",
        payload: {
          threadId: command.threadId,
          pinnedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unpin": {
      yield* requireThreadPinned({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unpinned",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    // Setting the switch to the value it already holds still emits: the event
    // is the record of the user's word, and the projector writes the same
    // value either way. There is no "no change" outcome in this decider.
    case "thread.pull-request-automation.set": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // A linked pull request holds only a merge switch: the auto-fix watch
      // needs a checkout on that branch, and the thread has one only for its own.
      const pullRequestNumber = command.pullRequestNumber;
      if (pullRequestNumber !== undefined) {
        if (command.autoFix !== undefined) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "A linked pull request has no auto-fix switch.",
          });
        }
        if (!thread.linkedPullRequests.some((linked) => linked.number === pullRequestNumber)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Pull request #${pullRequestNumber} is not linked to thread '${command.threadId}'.`,
          });
        }
      }
      const occurredAt = yield* nowIso;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pull-request-automation-changed",
        payload: {
          threadId: command.threadId,
          ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
          ...(command.autoFix === undefined ? {} : { autoFix: command.autoFix }),
          ...(command.autoMerge === undefined ? {} : { autoMerge: command.autoMerge }),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pull-request.link": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.linkedPullRequests.some((linked) => linked.number === command.number)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Pull request #${command.number} is already linked to thread '${command.threadId}'.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.pull-request-linked",
        payload: {
          threadId: command.threadId,
          number: command.number,
          url: command.url,
          linkedAt: command.createdAt,
        },
      };
    }

    case "thread.done-override.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Child threads: a wrapped parent is not woken by a late answer.
      const wrapEvents =
        command.state === "done"
          ? decideChildDeliveriesStop(
              readModel,
              thread,
              childEventBase(command, occurredAt),
              occurredAt,
              "wrapped",
            )
          : [];
      const overrideEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.done-override-set",
        payload: {
          threadId: command.threadId,
          state: command.state,
          // The client's stamp, not `occurredAt`: the inbox compares this
          // against the thread's activity to decide whether the word still
          // stands.
          at: command.at,
        },
      };
      return wrapEvents.length === 0 ? overrideEvent : [...wrapEvents, overrideEvent];
    }

    case "thread.seen.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.seen-set",
        payload: {
          threadId: command.threadId,
          // Last-write-wins, backwards included: "mark unread" sets seen to
          // just before the completion it is un-seeing.
          at: command.at,
        },
      };
    }

    case "thread.participant.add": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (!isValidParticipantId(command.participant.id)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Agent id '${command.participant.id}' must be a UUID.`,
        });
      }
      if (thread.participants.some((entry) => entry.id === command.participant.id)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Agent '${command.participant.id}' is already part of thread '${command.threadId}'.`,
        });
      }
      // Voice drives the thread's own runtime directly, which a room can not
      // route yet.
      if (thread.voiceActive === true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Stop voice before adding an agent to this thread.",
        });
      }
      if (findActiveParticipantByHandle(thread, command.participant.handle) !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `An agent called ${command.participant.handle} is already in this thread.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.participant-added",
        payload: {
          threadId: command.threadId,
          participant: {
            id: command.participant.id,
            handle: command.participant.handle,
            modelSelection: command.participant.modelSelection,
            joinedAt: command.createdAt,
            leftAt: null,
          },
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.side-turn.start": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const refuse = (detail: string) =>
        new OrchestrationCommandInvariantError({ commandType: command.type, detail });
      if (!isRoomThread(thread)) {
        return yield* refuse("Only a room can ask another agent while one works.");
      }
      // The id ends up in the side runtime's session key; see threadParticipants.
      if (!isValidParticipantId(command.sideTurnId)) {
        return yield* refuse(`Side answer id '${command.sideTurnId}' must be a UUID.`);
      }
      const participant =
        command.participantId === null
          ? null
          : (activeParticipants(thread).find((entry) => entry.id === command.participantId) ??
            null);
      if (command.participantId !== null && participant === null) {
        return yield* refuse(
          `Agent '${command.participantId}' is not in thread '${command.threadId}'.`,
        );
      }
      if (sessionSlotParticipantId(thread.session) === command.participantId) {
        return yield* refuse("That agent holds the thread. Send it a normal message instead.");
      }
      if ((thread.sideTurn ?? null) !== null) {
        return yield* refuse("Another agent is already answering. Wait for it to finish.");
      }
      if (thread.voiceActive === true) {
        return yield* refuse("Stop voice before asking another agent.");
      }
      if (thread.messages.some((message) => message.id === command.message.messageId)) {
        return yield* refuse(`Message '${command.message.messageId}' was already sent.`);
      }
      // One id, one answer: it names the runtime and the answer's message, so
      // a reused one would pick up the old answer's late words. Clients make a
      // fresh UUID per question; this catches a resend against the messages
      // the read model holds, not every id ever used.
      if (thread.messages.some((message) => message.sideTurnId === command.sideTurnId)) {
        return yield* refuse(`Side answer '${command.sideTurnId}' was already asked.`);
      }
      const base = withEventBase({
        aggregateKind: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
      });
      const answerModel =
        command.modelSelection ?? currentAgentModel(thread, command.participantId);
      const messageSent: PlannedOrchestrationEvent = {
        ...base,
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: [],
          ...(command.message.skills !== undefined ? { skills: command.message.skills } : {}),
          participantId: command.participantId,
          sideTurnId: command.sideTurnId,
          agentModels: messageAgentModels(thread, [
            { participantId: command.participantId, modelSelection: answerModel },
          ]),
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const started: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: messageSent.eventId,
        type: "thread.side-turn-started",
        payload: {
          threadId: command.threadId,
          sideTurn: {
            sideTurnId: command.sideTurnId,
            participantId: command.participantId,
            messageId: command.message.messageId,
            status: "starting",
            startedAt: command.createdAt,
          },
          modelSelection: answerModel,
        },
      };
      // The user wrote: agents may make requests again.
      return [
        messageSent,
        started,
        ...resetAgentRequestsForUser(
          thread,
          () =>
            withEventBase({
              aggregateKind: "thread",
              aggregateId: command.threadId,
              occurredAt: command.createdAt,
              commandId: command.commandId,
            }),
          command.createdAt,
        ),
      ];
    }

    case "thread.side-turn.interrupt":
    case "thread.side-turn.mark-running":
    case "thread.side-turn.settle": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sideTurn = thread.sideTurn ?? null;
      // Every side-answer command names its answer; one that is over, or was
      // never this thread's, changes nothing.
      if (sideTurn === null || sideTurn.sideTurnId !== command.sideTurnId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Side answer '${command.sideTurnId}' is not running on thread '${command.threadId}'.`,
        });
      }
      const eventBase = () =>
        withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        });
      const base = eventBase();
      if (command.type === "thread.side-turn.interrupt") {
        return {
          ...base,
          type: "thread.side-turn-interrupt-requested",
          payload: {
            threadId: command.threadId,
            sideTurnId: command.sideTurnId,
            createdAt: command.createdAt,
          },
        };
      }
      if (command.type === "thread.side-turn.mark-running") {
        return {
          ...base,
          type: "thread.side-turn-running",
          payload: {
            threadId: command.threadId,
            sideTurnId: command.sideTurnId,
            updatedAt: command.createdAt,
          },
        };
      }
      // Settling is final in one step, whichever way the answer ended
      // (finished, stopped, timed out, or cut off by a restart): its text is
      // closed, and an answer without a finished reply records why. Nothing
      // later can add to it (see the side checks on delta, complete and
      // activity.append).
      const answer = thread.messages.find(
        (message) => message.role === "assistant" && message.sideTurnId === command.sideTurnId,
      );
      const closeAnswer: PlannedOrchestrationEvent[] =
        answer !== undefined && answer.streaming
          ? [
              {
                ...eventBase(),
                type: "thread.message-sent",
                payload: {
                  threadId: command.threadId,
                  messageId: answer.id,
                  role: "assistant",
                  text: "",
                  ...(sideTurn.participantId !== null
                    ? { participantId: sideTurn.participantId }
                    : {}),
                  sideTurnId: command.sideTurnId,
                  turnId: null,
                  streaming: false,
                  completesTurn: false,
                  createdAt: command.createdAt,
                  updatedAt: command.createdAt,
                },
              },
            ]
          : [];
      const recordOutcome: PlannedOrchestrationEvent[] =
        command.outcome !== "completed" || answer === undefined
          ? [
              {
                ...eventBase(),
                type: "thread.activity-appended",
                payload: {
                  threadId: command.threadId,
                  activity: {
                    id: EventId.make(`side-answer-outcome:${command.sideTurnId}`),
                    tone: command.outcome === "failed" ? "error" : "info",
                    kind: SIDE_ANSWER_OUTCOME_ACTIVITY_KIND,
                    summary:
                      command.outcome === "failed"
                        ? "Side answer failed"
                        : command.outcome === "interrupted"
                          ? "Side answer stopped"
                          : "Side answer ended without a reply",
                    payload: {
                      outcome: command.outcome,
                      ...(command.error !== undefined ? { error: command.error } : {}),
                    },
                    turnId: null,
                    sideTurnId: command.sideTurnId,
                    participantId: sideTurn.participantId,
                    createdAt: command.createdAt,
                  },
                },
              },
            ]
          : [];
      // An agent's ask or review settles with its answer, in the same step.
      const settleRequest = settleAgentRequestForSideTurn(
        thread,
        sideTurn,
        command.outcome,
        answer,
        eventBase,
        command.createdAt,
        command.error,
        command.fromPreviousProcess === true,
      );
      return [
        ...closeAnswer,
        ...recordOutcome,
        ...settleRequest,
        {
          ...base,
          type: "thread.side-turn-settled",
          payload: {
            threadId: command.threadId,
            sideTurnId: command.sideTurnId,
            participantId: sideTurn.participantId,
            messageId: sideTurn.messageId,
            outcome: command.outcome,
            ...(answer !== undefined ? { answerMessageId: answer.id } : {}),
            ...(command.error !== undefined ? { error: command.error } : {}),
            settledAt: command.createdAt,
          },
        },
      ];
    }

    case "thread.agent-request.submit":
    case "thread.agent-request.queue":
    case "thread.agent-request.detach":
    case "thread.agent-request.settle":
    case "thread.agent-invite.respond": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const base = () =>
        withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        });
      return yield* planAgentRequestDecision(
        command.type,
        command.type === "thread.agent-request.submit"
          ? decideAgentRequestSubmit(thread, command, base)
          : command.type === "thread.agent-request.queue"
            ? decideAgentRequestQueue(thread, command, base)
            : command.type === "thread.agent-request.detach"
              ? decideAgentRequestDetach(thread, command, base)
              : command.type === "thread.agent-invite.respond"
                ? decideAgentInviteRespond(thread, command, base)
                : decideAgentRequestSettle(thread, command, base),
      );
    }

    case "thread.child.start":
    case "thread.child-request.respond":
    case "thread.child.send":
    case "thread.child-request.update":
    case "thread.child-request.settle":
    case "thread.child-notes.delivered": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const baseFor = childEventBase(command, command.createdAt);
      return yield* planChildThreadDecision(
        command.type,
        command.type === "thread.child.start"
          ? decideChildStart(readModel, thread, command, baseFor)
          : command.type === "thread.child-request.respond"
            ? decideChildRespond(readModel, thread, command, baseFor)
            : command.type === "thread.child.send"
              ? decideChildSend(readModel, thread, command, baseFor)
              : command.type === "thread.child-request.update"
                ? decideChildRequestUpdate(thread, command, baseFor)
                : command.type === "thread.child-request.settle"
                  ? decideChildRequestSettle(readModel, thread, command, baseFor)
                  : decideChildNotesDelivered(thread, command, baseFor),
      );
    }

    case "thread.parent-attachment.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return yield* planChildThreadDecision(
        command.type,
        decideParentAttachmentSet(
          readModel,
          thread,
          command,
          childEventBase(command, command.createdAt),
        ),
      );
    }

    case "thread.children.stop": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const decision = decideChildrenStop(
        readModel,
        thread,
        command,
        childEventBase(command, command.createdAt),
      );
      if ("refusal" in decision) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: decision.refusal,
        });
      }
      // The parent's requests settle first, so each child's own stop finds
      // nothing left to tell it about them.
      let nextReadModel = readModel;
      let nextSequence = readModel.snapshotSequence;
      for (const event of decision.events) {
        nextSequence += 1;
        nextReadModel = yield* projectEvent(nextReadModel, {
          ...event,
          sequence: nextSequence,
        } as OrchestrationEvent).pipe(Effect.orDie);
      }
      const stops = yield* decideCommandSequence({
        readModel: nextReadModel,
        commands: decision.childIds.map(
          (childId): Extract<OrchestrationCommand, { type: "thread.session.stop" }> => ({
            type: "thread.session.stop",
            commandId: command.commandId,
            threadId: childId,
            createdAt: command.createdAt,
          }),
        ),
      });
      return [...decision.events, ...stops];
    }

    case "thread.room-context.record": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.room-context-recorded",
        payload: {
          threadId: command.threadId,
          agentKey: command.agentKey,
          cursor: command.cursor,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.sent-model.record": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.sent-model-recorded",
        payload: {
          threadId: command.threadId,
          agentKey: command.agentKey,
          modelSelection: command.modelSelection,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.participant.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const refuse = (detail: string) =>
        new OrchestrationCommandInvariantError({ commandType: command.type, detail });
      if (!isRoomThread(thread)) {
        return yield* refuse("Only agents in a room can be renamed.");
      }
      const participant =
        command.participantId === null
          ? null
          : (activeParticipants(thread).find((entry) => entry.id === command.participantId) ??
            null);
      if (command.participantId !== null && participant === null) {
        return yield* refuse(
          `Agent '${command.participantId}' is not in thread '${command.threadId}'.`,
        );
      }
      // The thread's own agent keeps its model options with the thread.
      if (
        (command.modelOptions !== undefined || command.modelSelection !== undefined) &&
        participant === null
      ) {
        return yield* refuse("The thread's own agent takes its model from the composer.");
      }
      // A new model takes effect at the agent's next turn, so it waits until
      // the agent has nothing in flight.
      if (command.modelSelection !== undefined && participant !== null) {
        const session = thread.session;
        const holdsSlot = session !== null && sessionSlotParticipantId(session) === participant.id;
        if (
          holdsSlot &&
          (session.status === "running" ||
            session.status === "starting" ||
            (session.awaitedBackgroundTaskCount ?? session.pendingBackgroundTaskCount ?? 0) > 0)
        ) {
          return yield* refuse(
            `${participant.handle} is working. Change its model once it is done.`,
          );
        }
        if (thread.sideTurn?.participantId === participant.id) {
          return yield* refuse(
            `${participant.handle} is answering. Change its model once it is done.`,
          );
        }
        // A guest's name counts as taken: it keeps it if the user adds it.
        const namesake =
          command.handle === undefined
            ? undefined
            : findActiveParticipantByHandle(thread, command.handle);
        if (namesake !== undefined && namesake.id !== participant.id) {
          return yield* refuse(`Another agent here is already called ${command.handle}.`);
        }
        if (hasOpenAgentRequests(thread, participant.id)) {
          return yield* refuse(
            `${participant.handle} has a request from another agent in progress. Change its model once it is done.`,
          );
        }
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.participant-updated",
        payload: {
          threadId: command.threadId,
          participantId: command.participantId,
          ...(command.role !== undefined ? { role: command.role } : {}),
          ...(command.modelSelection !== undefined && participant !== null
            ? {
                modelSelection: command.modelSelection,
                ...(command.handle !== undefined ? { handle: command.handle } : {}),
              }
            : command.modelOptions !== undefined && participant !== null
              ? {
                  modelSelection: {
                    instanceId: participant.modelSelection.instanceId,
                    model: participant.modelSelection.model,
                    ...(command.modelOptions.length > 0 ? { options: command.modelOptions } : {}),
                  },
                }
              : {}),
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.participant.remove": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const participant = activeParticipants(thread).find(
        (entry) => entry.id === command.participantId,
      );
      if (participant === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Agent '${command.participantId}' is not in thread '${command.threadId}'.`,
        });
      }
      const session = thread.session;
      if (
        session !== null &&
        sessionSlotParticipantId(session) === participant.id &&
        (session.status === "running" || session.status === "starting")
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `${participant.handle} is working. Stop its turn before removing it.`,
        });
      }
      if (thread.sideTurn?.participantId === participant.id) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `${participant.handle} is answering. Stop its answer before removing it.`,
        });
      }
      const removed: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.participant-removed",
        payload: {
          threadId: command.threadId,
          participantId: participant.id,
          updatedAt: command.createdAt,
        },
      };
      const removeBase = () =>
        withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        });
      // Child threads: what it asked of its threads has nobody to go back to.
      const leavingBase = childEventBase(command, command.createdAt);
      const childEvents: ReadonlyArray<PlannedOrchestrationEvent> = [
        ...thread.childRequests.open
          .filter((request) => request.from.participantId === participant.id)
          .map((request): PlannedOrchestrationEvent => ({
            ...leavingBase(thread.id),
            type: "thread.child-request-settled",
            payload: {
              threadId: thread.id,
              requestId: request.requestId,
              childThreadId: request.childThreadId,
              outcome: "cancelled",
              error: "The agent that asked left the room.",
              settledAt: command.createdAt,
            },
          })),
        ...(thread.queuedFollowUps ?? [])
          .filter(
            (queued) =>
              queued.fromThread?.kind === "report" && queued.participantId === participant.id,
          )
          .map((queued): PlannedOrchestrationEvent => ({
            ...leavingBase(thread.id),
            type: "thread.follow-up-unqueued",
            payload: {
              threadId: thread.id,
              messageId: queued.messageId,
              reason: "cancelled",
              createdAt: command.createdAt,
            },
          })),
      ];
      return [
        ...cancelAgentRequestsForLeaving(thread, participant.id, removeBase, command.createdAt),
        ...childEvents,
        removed,
      ];
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const project = yield* requireProject({
        readModel,
        command,
        projectId: thread.projectId,
      });
      const worktreePath =
        command.worktreePath === undefined
          ? undefined
          : normalizeWorktreePath(command.worktreePath, project.workspaceRoot);
      const occurredAt = yield* nowIso;
      const metaUpdatedEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(worktreePath !== undefined ? { worktreePath } : {}),
          updatedAt: occurredAt,
        },
      } as const;

      // A checkout move with no live session applies now, so the stale
      // session-scoped effectiveCwd must stop shadowing the new checkout.
      // Emitted as a real event rather than special-cased in the folds: the
      // in-memory projector, the SQLite pipeline, and the web store all
      // already know what thread.effective-cwd-set means. Only an actual
      // move clears — branch-only updates carry the unchanged worktree path
      // and must not wipe a valid cwd-follow value.
      const checkoutChanged =
        worktreePath !== undefined &&
        (worktreePath === null || thread.worktreePath === null
          ? worktreePath !== thread.worktreePath
          : !areFilesystemPathsEqual(worktreePath, thread.worktreePath));
      const sessionInactive = thread.session == null || thread.session.status === "stopped";
      if (!checkoutChanged || !sessionInactive || thread.effectiveCwd == null) {
        return metaUpdatedEvent;
      }
      return [
        metaUpdatedEvent,
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          }),
          causationEventId: metaUpdatedEvent.eventId,
          type: "thread.effective-cwd-set",
          payload: {
            threadId: command.threadId,
            effectiveCwd: null,
            updatedAt: occurredAt,
          },
        },
      ];
    }

    case "thread.checkout.select": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const project = yield* requireProject({
        readModel,
        command,
        projectId: thread.projectId,
      });
      const worktreePath = normalizeWorktreePath(command.worktreePath, project.workspaceRoot);
      const occurredAt = yield* nowIso;
      const metaUpdatedEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          branch: command.branch,
          worktreePath,
          updatedAt: occurredAt,
        },
      } as const;
      const hasLiveWork =
        thread.session?.status === "starting" ||
        thread.session?.status === "running" ||
        thread.session?.activeTurnId != null ||
        (thread.session?.pendingBackgroundTaskCount ?? 0) > 0;
      const selectionAuthorityRequired = thread.effectiveCwd !== null || hasLiveWork;
      if (!selectionAuthorityRequired && thread.effectiveCwdSource !== "selection") {
        return metaUpdatedEvent;
      }
      if (selectionAuthorityRequired && thread.effectiveCwdSource === "selection") {
        return metaUpdatedEvent;
      }
      return [
        metaUpdatedEvent,
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          }),
          causationEventId: metaUpdatedEvent.eventId,
          type: "thread.effective-cwd-set",
          payload: {
            threadId: command.threadId,
            effectiveCwd: null,
            ...(selectionAuthorityRequired ? { effectiveCwdSource: "selection" as const } : {}),
            updatedAt: occurredAt,
          },
        },
      ];
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Child threads: nothing runs in a child before its worktree exists,
      // and a parent's request that was cancelled (stopped, separated) never
      // starts.
      if (command.fromThread === undefined && isChildBeingSetUp(readModel, targetThread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This thread is still being set up. Try again in a moment.",
        });
      }
      if (
        command.fromThread?.kind === "request" &&
        targetThread.attachedToParent &&
        !isOpenParentRequest(readModel, command.fromThread)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The request this turn answers was cancelled.",
        });
      }
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      // In a room, the turn goes to one agent. Only one agent works at a time:
      // the session slot changes hands only once its holder is done, including
      // background work it is waiting on (a test run, a helper agent), which
      // would wake it up mid-turn of another. A command it left running on
      // purpose, like a dev server, keeps running and does not hold the slot.
      const participantId = command.participantId ?? null;
      const participant =
        participantId === null
          ? null
          : (activeParticipants(targetThread).find((entry) => entry.id === participantId) ?? null);
      if (participantId !== null && participant === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Agent '${participantId}' is not in thread '${command.threadId}'.`,
        });
      }
      const slotSession = targetThread.session;
      const slotHolderId = sessionSlotParticipantId(slotSession);
      const handsOverSlot = slotSession !== null && slotHolderId !== participantId;
      if (handsOverSlot) {
        const holderName =
          slotHolderId === null
            ? "The thread's agent"
            : (targetThread.participants.find((entry) => entry.id === slotHolderId)?.handle ??
              "The agent");
        if (slotSession.status === "running" || slotSession.status === "starting") {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `${holderName} is still working. Wait for its turn to finish, or stop it.`,
          });
        }
        if (
          (slotSession.awaitedBackgroundTaskCount ?? slotSession.pendingBackgroundTaskCount ?? 0) >
          0
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `${holderName} is still waiting on background work.`,
          });
        }
        if (targetThread.voiceActive === true) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Stop voice before asking another agent.",
          });
        }
      }
      // An agent answering on the side waits until that answer is over
      // before it can take the thread; a queued message whose turn came
      // meanwhile goes out when the answer settles (the reactor holds it).
      if (
        targetThread.sideTurn !== undefined &&
        targetThread.sideTurn !== null &&
        targetThread.sideTurn.participantId === participantId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "That agent is answering on the side. Wait for it to finish, or stop its answer.",
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          ...(command.message.skills !== undefined ? { skills: command.message.skills } : {}),
          ...(participantId !== null ? { participantId } : {}),
          ...(command.fromThread !== undefined ? { fromThread: command.fromThread } : {}),
          // Named as the turn is sent (recordTurnModel). A queued message an
          // agent wrote is already recorded, with its own stamps; sending it
          // must not restamp it.
          ...(isNewMessage(targetThread, command.message.messageId)
            ? {
                agentModels: messageAgentModels(targetThread, [
                  {
                    participantId,
                    modelSelection:
                      command.modelSelection ?? sentAgentModel(targetThread, participantId),
                  },
                ]),
              }
            : {}),
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const titleSeedEvent: Omit<OrchestrationEvent, "sequence"> | null =
        command.titleSeed !== undefined &&
        targetThread.messages.length === 0 &&
        targetThread.title !== command.titleSeed &&
        canReplaceThreadTitle(targetThread.title, command.titleSeed)
          ? {
              ...withEventBase({
                aggregateKind: "thread",
                aggregateId: command.threadId,
                occurredAt: command.createdAt,
                commandId: command.commandId,
              }),
              causationEventId: userMessageEvent.eventId,
              type: "thread.meta-updated",
              payload: {
                threadId: command.threadId,
                title: command.titleSeed,
                updatedAt: command.createdAt,
              },
            }
          : null;
      const requestedModelSelection =
        command.modelSelection ?? participant?.modelSelection ?? targetThread.modelSelection;
      // A handed-over slot starts clean: the previous holder's provider ids,
      // checkout and errors describe a different runtime.
      const priorSession = handsOverSlot ? null : slotSession;
      const startingSessionEvent: Omit<OrchestrationEvent, "sequence"> | null =
        priorSession?.status === "running"
          ? null
          : {
              ...withEventBase({
                aggregateKind: "thread",
                aggregateId: command.threadId,
                occurredAt: command.createdAt,
                commandId: command.commandId,
              }),
              causationEventId: userMessageEvent.eventId,
              type: "thread.session-set",
              payload: {
                threadId: command.threadId,
                session: {
                  threadId: command.threadId,
                  status: "starting",
                  providerName: priorSession?.providerName ?? null,
                  // After a handover, the incoming agent's own last provider:
                  // the reactor compares the requested one against it to
                  // detect a provider switch.
                  providerInstanceId:
                    priorSession?.providerInstanceId ??
                    (handsOverSlot
                      ? (participant?.modelSelection.instanceId ??
                        targetThread.modelSelection.instanceId)
                      : requestedModelSelection.instanceId),
                  providerSessionId: priorSession?.providerSessionId ?? null,
                  providerThreadId: priorSession?.providerThreadId ?? null,
                  runtimeMode: targetThread.runtimeMode,
                  // The runtime is still in whatever checkout it started in;
                  // the reactor rewrites this once the session is (re)bound.
                  checkoutCwd: priorSession?.checkoutCwd ?? null,
                  participantId,
                  // Same reasoning: the live runtime still owns its background
                  // tasks. Dropping the count here would tell the reactor the
                  // session is free to be cycled into another checkout.
                  ...carriedBackgroundTasks(priorSession),
                  activeTurnId: null,
                  lastError: priorSession?.lastError ?? null,
                  updatedAt: command.createdAt,
                },
              },
            };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(participantId !== null ? { participantId } : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          ...(command.message.skills !== undefined ? { skills: command.message.skills } : {}),
          // Rooms: the Stop count this turn was asked under (stamped on every
          // thread, since one can become a room while the turn is prepared),
          // and the turn of the agent it takes the thread from, which must be
          // recorded first.
          chainEpoch: targetThread.agentRequests.chainEpoch,
          ...(handsOverSlot && targetThread.latestTurn !== null
            ? { handoverFromTurnId: targetThread.latestTurn.turnId }
            : {}),
          ...(command.fromThread !== undefined ? { fromThread: command.fromThread } : {}),
          createdAt: command.createdAt,
        },
      };
      const turnBase = () =>
        withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        });
      // Child threads: a parent's request starting its turn in the child is
      // now running there.
      const origin = command.fromThread;
      const parentForRequest =
        origin?.kind === "request"
          ? readModel.threads.find((entry) => entry.id === origin.threadId)
          : undefined;
      const answeredRequest = parentForRequest?.childRequests.open.find(
        (request) =>
          request.requestId === origin?.requestId &&
          request.childThreadId === command.threadId &&
          (request.status === "starting" || request.status === "queued"),
      );
      const requestRunningEvents: ReadonlyArray<PlannedOrchestrationEvent> =
        parentForRequest !== undefined && answeredRequest !== undefined
          ? [
              {
                ...childEventBase(command, command.createdAt)(parentForRequest.id),
                type: "thread.child-request-updated",
                payload: {
                  threadId: parentForRequest.id,
                  requestId: answeredRequest.requestId,
                  status: "running",
                  updatedAt: command.createdAt,
                },
              },
            ]
          : [];
      return [
        userMessageEvent,
        ...(titleSeedEvent ? [titleSeedEvent] : []),
        ...(startingSessionEvent ? [startingSessionEvent] : []),
        turnStartRequestedEvent,
        ...requestRunningEvents,
        // The user wrote: agents may make requests again. (A queued message
        // sent later drops these; it counted when the user queued it.) An
        // agent's message is not the user writing.
        ...(command.fromThread === undefined
          ? [
              ...resetAgentRequestsForUser(targetThread, turnBase, command.createdAt),
              ...resetChildRequestsForUser(targetThread, turnBase, command.createdAt),
              ...settleCandidateBeforeUserTurn(readModel, targetThread, command),
            ]
          : []),
      ];
    }

    case "thread.turn.retry": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const session = targetThread.session;
      if (session?.status === "running" || session?.status === "starting") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has a turn in flight and cannot retry.`,
        });
      }
      // What agents did beside a turn (an invite, an invited review) is never
      // the turn's own message, so it is never what a retry sends again.
      const turnMessages = targetThread.messages.filter((message) => !isTurnAside(message));
      const providerAuthRetryUserMessageIndex = findProviderAuthRetryUserMessageIndex(turnMessages);
      if (!session || (session.lastError === null && providerAuthRetryUserMessageIndex === null)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' has no failed turn to retry.`,
        });
      }
      const lastUserMessage =
        providerAuthRetryUserMessageIndex === null
          ? turnMessages.findLast((message) => message.role === "user")
          : turnMessages[providerAuthRetryUserMessageIndex];
      if (!lastUserMessage) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' has no user message to retry.`,
        });
      }
      // A failed turn is retried with the agent that failed it: the slot
      // still holds that agent's session.
      const retryParticipantId = sessionSlotParticipantId(session);
      if (
        retryParticipantId !== null &&
        !activeParticipants(targetThread).some((entry) => entry.id === retryParticipantId)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The agent that failed this turn is no longer in the thread.",
        });
      }
      // Mirrors thread.turn.start, but re-points at the persisted last user
      // message instead of appending a new one: the transcript keeps a single
      // bubble and attachments are reused as stored. A projected lastError is
      // carried forward (as in turn.start); providers that encode auth failure
      // as a completed assistant response can legitimately keep it null.
      const retrySessionEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: {
            threadId: command.threadId,
            status: "starting",
            participantId: retryParticipantId,
            providerName: session.providerName ?? null,
            providerInstanceId:
              session.providerInstanceId ?? targetThread.modelSelection.instanceId,
            providerSessionId: session.providerSessionId ?? null,
            providerThreadId: session.providerThreadId ?? null,
            runtimeMode: targetThread.runtimeMode,
            checkoutCwd: session.checkoutCwd ?? null,
            ...carriedBackgroundTasks(session),
            activeTurnId: null,
            lastError: session.lastError,
            updatedAt: command.createdAt,
          },
        },
      };
      const retryTurnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: retrySessionEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: lastUserMessage.id,
          // Claude uses the provider-facing message id as a command UUID and
          // ignores a repeated UUID after reporting it completed. Keep the
          // persisted transcript message id stable while giving every retry
          // attempt a fresh provider command identity.
          providerMessageId: MessageId.make(crypto.randomUUID()),
          ...(retryParticipantId !== null ? { participantId: retryParticipantId } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(lastUserMessage.skills !== undefined ? { skills: lastUserMessage.skills } : {}),
          chainEpoch: targetThread.agentRequests.chainEpoch,
          createdAt: command.createdAt,
        },
      };
      // Retrying is the user acting: agents may make requests again.
      return [
        retrySessionEvent,
        retryTurnStartRequestedEvent,
        ...resetAgentRequestsForUser(
          targetThread,
          () =>
            withEventBase({
              aggregateKind: "thread",
              aggregateId: command.threadId,
              occurredAt: command.createdAt,
              commandId: command.commandId,
            }),
          command.createdAt,
        ),
      ];
    }

    case "thread.follow-up.submit": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // In a room only the agent at work can be steered; a message for any
      // other agent waits for its turn in the queue.
      const addressedAgentId =
        command.participantId !== undefined
          ? command.participantId
          : sessionSlotParticipantId(targetThread.session);
      const canSteer =
        (command.delivery ?? "steer") === "steer" &&
        targetThread.session?.status === "running" &&
        targetThread.session.activeTurnId === command.turnId &&
        addressedAgentId === sessionSlotParticipantId(targetThread.session);
      if (!canSteer) {
        // Queued on purpose, or a steer that arrived after its turn ended (or
        // while another turn runs): hold it for the next turn instead of
        // refusing it, so the message is never lost to the race.
        const alreadyQueued = (targetThread.queuedFollowUps ?? []).some(
          (queued) => queued.messageId === command.message.messageId,
        );
        if (
          alreadyQueued ||
          targetThread.messages.some((message) => message.id === command.message.messageId)
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Message '${command.message.messageId}' was already sent on thread '${command.threadId}'.`,
          });
        }
        const userBase = () =>
          withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          });
        return withLeadingEvents(
          [
            ...resetAgentRequestsForUser(targetThread, userBase, command.createdAt),
            ...resetChildRequestsForUser(targetThread, userBase, command.createdAt),
          ],
          {
            ...userBase(),
            type: "thread.follow-up-queued",
            payload: {
              threadId: command.threadId,
              followUp: {
                messageId: command.message.messageId,
                text: command.message.text,
                attachments: command.message.attachments,
                ...(command.message.skills !== undefined ? { skills: command.message.skills } : {}),
                ...(command.modelSelection !== undefined
                  ? { modelSelection: command.modelSelection }
                  : {}),
                ...(addressedAgentId !== null ? { participantId: addressedAgentId } : {}),
                runtimeMode: command.runtimeMode ?? targetThread.runtimeMode,
                interactionMode: command.interactionMode ?? targetThread.interactionMode,
                createdAt: command.createdAt,
              },
            },
          },
        );
      }
      const steerBase = () =>
        withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        });
      return withLeadingEvents(
        [
          ...resetAgentRequestsForUser(targetThread, steerBase, command.createdAt),
          ...resetChildRequestsForUser(targetThread, steerBase, command.createdAt),
        ],
        {
          ...steerBase(),
          type: "thread.follow-up-submitted",
          payload: {
            threadId: command.threadId,
            turnId: command.turnId,
            messageId: command.message.messageId,
            role: "user",
            text: command.message.text,
            attachments: command.message.attachments,
            ...(command.message.skills !== undefined ? { skills: command.message.skills } : {}),
            // Steering goes to the agent at work.
            ...(addressedAgentId !== null ? { participantId: addressedAgentId } : {}),
            createdAt: command.createdAt,
          },
        },
      );
    }

    case "thread.follow-up.unqueue": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const unqueuing = (targetThread.queuedFollowUps ?? []).find(
        (queued) => queued.messageId === command.messageId,
      );
      if (unqueuing === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message '${command.messageId}' is not queued on thread '${command.threadId}'; it may already have been sent.`,
        });
      }
      const unqueuedEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.follow-up-unqueued",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          reason: "cancelled",
          createdAt: command.createdAt,
        },
      };
      // A parent's request taken back in its child can never be answered.
      const parentSettles =
        unqueuing.fromThread?.kind === "request"
          ? settleParentRequestsForUnqueued(
              readModel,
              targetThread,
              [command.messageId],
              childEventBase(command, command.createdAt),
              command.createdAt,
            )
          : [];
      return parentSettles.length === 0 ? unqueuedEvent : [unqueuedEvent, ...parentSettles];
    }

    case "thread.follow-up.send-queued": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const queued = (targetThread.queuedFollowUps ?? []).find(
        (entry) => entry.messageId === command.messageId,
      );
      if (!queued) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message '${command.messageId}' is not queued on thread '${command.threadId}'.`,
        });
      }
      const sendBase = () =>
        withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        });
      const unqueuedEvent: PlannedOrchestrationEvent = {
        ...sendBase(),
        type: "thread.follow-up-unqueued",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          reason: "sent",
          createdAt: command.createdAt,
        },
      };
      // A message an agent queued (a hand-off, a routed reply, or a child
      // thread's report or request) goes only to the agent it was for. If that
      // agent left, it is taken back and its request cancelled, never handed
      // to another agent.
      const fromAgent = queued.fromAgent;
      const fromThread = queued.fromThread;
      const agentQueued = isAgentOrigin(queued);
      // A child's report whose delivery was cancelled after it was queued
      // (Stop, wrap, the child separated or gone) is taken back, not sent.
      // Likewise a parent's request cancelled meanwhile (Stop, wrap) in a child
      // still in its family. A separated child keeps it: it is its own work now.
      if (
        isStaleReport(readModel, targetThread, fromThread) ||
        (fromThread?.kind === "request" &&
          targetThread.attachedToParent &&
          !isOpenParentRequest(readModel, fromThread))
      ) {
        return [{ ...unqueuedEvent, payload: { ...unqueuedEvent.payload, reason: "cancelled" } }];
      }
      // A message an agent queued carries no model: its agent's current one
      // applies (the thread's own model for the thread's own agent), so a
      // model change since it was queued is honored.
      const queuedAgentModel = !agentQueued
        ? undefined
        : queued.participantId === undefined || queued.participantId === null
          ? targetThread.modelSelection
          : activeParticipants(targetThread).find((entry) => entry.id === queued.participantId)
              ?.modelSelection;
      const queuedParticipantPresent =
        queued.participantId === undefined ||
        queued.participantId === null ||
        activeParticipants(targetThread).some((entry) => entry.id === queued.participantId);
      if (agentQueued && !queuedParticipantPresent) {
        return [
          { ...unqueuedEvent, payload: { ...unqueuedEvent.payload, reason: "cancelled" } },
          ...(fromAgent !== undefined &&
          queued.participantId !== undefined &&
          queued.participantId !== null
            ? cancelAgentRequestsForLeaving(
                targetThread,
                queued.participantId,
                sendBase,
                command.createdAt,
              ).filter(
                (event) =>
                  event.type === "thread.agent-request-settled" ||
                  event.type === "thread.side-turn-interrupt-requested",
              )
            : []),
        ];
      }
      // The user's queued message runs with the settings it was queued with,
      // applied the same way a normal send applies them before its turn
      // starts. Agent traffic never changes the thread's settings: it runs
      // with the thread's current ones, so a message queued before the user
      // narrowed access cannot widen it back. The message is stamped now, not
      // when it was queued, so it lands after the answer it waited for.
      const runtimeMode = agentQueued ? targetThread.runtimeMode : queued.runtimeMode;
      const interactionMode = agentQueued ? targetThread.interactionMode : queued.interactionMode;
      const turnEvents = yield* decideCommandSequence({
        readModel,
        commands: [
          ...(runtimeMode !== targetThread.runtimeMode
            ? [
                {
                  type: "thread.runtime-mode.set" as const,
                  commandId: command.commandId,
                  threadId: command.threadId,
                  runtimeMode,
                  createdAt: command.createdAt,
                },
              ]
            : []),
          ...(interactionMode !== targetThread.interactionMode
            ? [
                {
                  type: "thread.interaction-mode.set" as const,
                  commandId: command.commandId,
                  threadId: command.threadId,
                  interactionMode,
                  createdAt: command.createdAt,
                },
              ]
            : []),
          {
            type: "thread.turn.start",
            commandId: command.commandId,
            threadId: command.threadId,
            message: {
              messageId: queued.messageId,
              role: "user",
              text: queued.text,
              attachments: queued.attachments,
              ...(queued.skills !== undefined ? { skills: queued.skills } : {}),
            },
            ...(queued.modelSelection !== undefined
              ? { modelSelection: queued.modelSelection }
              : queuedAgentModel !== undefined
                ? { modelSelection: queuedAgentModel }
                : {}),
            // The agent it was queued for, while it is still in the thread;
            // otherwise the thread's own agent takes it.
            ...(queued.participantId !== undefined &&
            queued.participantId !== null &&
            activeParticipants(targetThread).some((entry) => entry.id === queued.participantId)
              ? { participantId: queued.participantId }
              : {}),
            runtimeMode,
            interactionMode,
            ...(fromThread !== undefined ? { fromThread } : {}),
            createdAt: command.createdAt,
          },
        ],
      });
      if (!agentQueued) {
        // It counted as the user writing when it was queued.
        return [
          unqueuedEvent,
          ...turnEvents.filter(
            (event) =>
              event.type !== "thread.agent-requests-reset" &&
              event.type !== "thread.child-requests-reset",
          ),
        ];
      }
      // The agent's message was written when it was queued; sending it keeps
      // who wrote it, and a hand-off's request is now running.
      const existing = targetThread.messages.find((message) => message.id === queued.messageId);
      const request = targetThread.agentRequests.open.find(
        (entry) => entry.requestId === queued.requestId,
      );
      const sentEvents: PlannedOrchestrationEvent[] = turnEvents
        .filter(
          (event) =>
            event.type !== "thread.agent-requests-reset" &&
            event.type !== "thread.child-requests-reset",
        )
        .map((event): PlannedOrchestrationEvent => {
          if (
            event.type !== "thread.message-sent" ||
            (event.payload as { readonly messageId?: unknown }).messageId !== queued.messageId
          ) {
            return event;
          }
          return {
            ...event,
            payload: {
              ...(event.payload as Extract<
                OrchestrationEvent,
                { type: "thread.message-sent" }
              >["payload"]),
              // It keeps its place: it was written when it was queued.
              ...(existing !== undefined ? { createdAt: existing.createdAt } : {}),
              ...(fromAgent !== undefined ? { fromAgent } : {}),
              ...(queued.requestId !== undefined ? { requestId: queued.requestId } : {}),
              ...(existing?.requestKind !== undefined ? { requestKind: existing.requestKind } : {}),
            },
          } as PlannedOrchestrationEvent;
        });
      return [
        unqueuedEvent,
        ...sentEvents,
        ...(request !== undefined &&
        request.kind === "hand_off" &&
        request.status === "queued" &&
        request.requestMessageId === queued.messageId
          ? [
              {
                ...sendBase(),
                type: "thread.agent-request-updated" as const,
                payload: {
                  threadId: command.threadId,
                  requestId: request.requestId,
                  status: "running" as const,
                  updatedAt: command.createdAt,
                },
              },
            ]
          : []),
      ];
    }

    case "thread.turn.interrupt": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const base = () =>
        withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        });
      // In a room, Stop also ends the agents' chain of requests; with child
      // threads, it ends what this thread was owed by its children, and a
      // parent's requests still queued here are taken back.
      const chainStop = [
        ...decideAgentChainStop(thread, base, command.createdAt),
        ...childStopEvents(readModel, thread, command, command.createdAt),
      ];
      const interruptEvent: PlannedOrchestrationEvent = {
        ...base(),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
      return chainStop.length > 0 ? [interruptEvent, ...chainStop] : interruptEvent;
    }

    case "thread.realtime.start": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Voice drives one agent's runtime directly; rooms do not route it yet.
      if (isRoomThread(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Voice is not available in rooms yet.",
        });
      }
      if (thread.session?.providerName !== "codex") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' does not have a Codex provider session.`,
        });
      }
      if (
        thread.session.status === "starting" ||
        thread.session.status === "stopped" ||
        thread.session.status === "error"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' does not have an active provider session.`,
        });
      }
      if (thread.voiceActive === true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has an active realtime session.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.realtime-start-requested",
        payload: {
          threadId: command.threadId,
          ...(command.outputModality !== undefined
            ? { outputModality: command.outputModality }
            : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.realtime.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.realtime-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.context-compact.request": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.context-compact-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Rewinding one agent's conversation cannot take back what the other
      // agents in a room have already read, so rooms have no revert.
      if (isRoomThread(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Revert is off in rooms: the other agents have already seen this work.",
        });
      }
      // An invited agent's review, or its answer on the way back, would land
      // after the revert and talk about work that is gone.
      if (
        thread.agentRequests.open.length > 0 ||
        (thread.queuedFollowUps ?? []).some((queued) => queued.fromAgent !== undefined)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Finish or decline the agent's request first.",
        });
      }
      // Child threads: answers on their way, or a child working on its
      // parent's request, are about work a revert would take back.
      const familyRefusal = childRevertRefusal(readModel, thread);
      if (familyRefusal !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: familyRefusal,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const base = () =>
        withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        });
      // In a room, stopping the session ends the agents' chain the same way
      // Stop does, so a turn still being prepared for an agent is dropped.
      const chainStop = [
        ...decideAgentChainStop(thread, base, command.createdAt),
        ...childStopEvents(readModel, thread, command, command.createdAt),
      ];
      const stopEvent: PlannedOrchestrationEvent = {
        ...base(),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
      return chainStop.length > 0 ? [stopEvent, ...chainStop] : stopEvent;
    }

    case "thread.session.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const project = yield* requireProject({
        readModel,
        command,
        projectId: thread.projectId,
      });
      const sessionSetEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      } as const;

      // A session stopping with a queued checkout switch applies the switch:
      // the effectiveCwd the dead session left behind must not keep pointing
      // panels at the checkout the user already moved away from. A session
      // stopping in its own configured checkout keeps its effectiveCwd, so a
      // cwd-follow into a subfolder still reads correctly after a stop.
      const configuredCheckout = thread.worktreePath ?? project.workspaceRoot;
      const sessionCheckout = command.session.checkoutCwd ?? null;
      const checkoutDiffers =
        configuredCheckout === null || sessionCheckout === null
          ? configuredCheckout !== sessionCheckout
          : !areFilesystemPathsEqual(configuredCheckout, sessionCheckout);
      const selectionSettled =
        thread.effectiveCwdSource === "selection" &&
        command.session.status !== "starting" &&
        command.session.status !== "running" &&
        command.session.activeTurnId === null &&
        (command.session.pendingBackgroundTaskCount ?? 0) === 0 &&
        (command.session.status === "stopped" || !checkoutDiffers);
      const stoppedCheckoutMove =
        command.session.status === "stopped" && checkoutDiffers && thread.effectiveCwd !== null;
      if (!selectionSettled && !stoppedCheckoutMove) {
        return sessionSetEvent;
      }
      return [
        sessionSetEvent,
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
            metadata: {},
          }),
          causationEventId: sessionSetEvent.eventId,
          type: "thread.effective-cwd-set",
          payload: {
            threadId: command.threadId,
            effectiveCwd: null,
            updatedAt: command.createdAt,
          },
        },
      ];
    }

    case "thread.realtime.state.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.realtime-state-set",
        payload: {
          threadId: command.threadId,
          active: command.active,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.effective-cwd.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // A lookup can finish after a user has explicitly moved the thread.
      // Re-check authority here, inside the serialized decider, so that stale
      // subagent inference cannot win the race after its earlier snapshot.
      if (command.effectiveCwdSource === "subagent" && thread.effectiveCwdSource === "selection") {
        const retainedAt = yield* nowIso;
        return {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: retainedAt,
            commandId: command.commandId,
            metadata: {},
          }),
          type: "thread.effective-cwd-set",
          payload: {
            threadId: command.threadId,
            effectiveCwd: null,
            effectiveCwdSource: "selection",
            updatedAt: retainedAt,
          },
        };
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.effective-cwd-set",
        payload: {
          threadId: command.threadId,
          effectiveCwd: command.effectiveCwd,
          ...(command.effectiveCwd !== null
            ? { effectiveCwdSource: command.effectiveCwdSource ?? "session" }
            : {}),
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.goal.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.goal-set-requested",
        payload: {
          threadId: command.threadId,
          ...(command.objective !== undefined ? { objective: command.objective } : {}),
          ...(command.status !== undefined ? { status: command.status } : {}),
          ...(command.tokenBudget !== undefined ? { tokenBudget: command.tokenBudget } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.goal.clear": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.goal-clear-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.goal.state.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.goal-state-set",
        payload: {
          threadId: command.threadId,
          goal: command.goal,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.user.record": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "user",
          text: command.text,
          attachments: [],
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.delta": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireSideTurnOpen(thread, command);
      // Ingestion names the agent whose runtime wrote this; the slot holder
      // is only a fallback, since the slot can change hands mid-flush.
      const authorId =
        command.participantId !== undefined
          ? command.participantId
          : sessionSlotParticipantId(thread.session);
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          ...(authorId !== null ? { participantId: authorId } : {}),
          ...assistantMessageStamp(thread, command.messageId, authorId, command.sideTurnId),
          // A side answer is never part of a main turn.
          ...(command.sideTurnId !== undefined ? { sideTurnId: command.sideTurnId } : {}),
          turnId: command.sideTurnId !== undefined ? null : (command.turnId ?? null),
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireSideTurnOpen(thread, command);
      const authorId =
        command.participantId !== undefined
          ? command.participantId
          : sessionSlotParticipantId(thread.session);
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          ...(authorId !== null ? { participantId: authorId } : {}),
          ...assistantMessageStamp(thread, command.messageId, authorId, command.sideTurnId),
          ...(command.sideTurnId !== undefined ? { sideTurnId: command.sideTurnId } : {}),
          turnId: command.sideTurnId !== undefined ? null : (command.turnId ?? null),
          streaming: false,
          completesTurn: command.sideTurnId !== undefined ? false : command.completesTurn,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.follow-up.accept": {
      const acceptingThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const steeredAgentId =
        command.participantId !== undefined
          ? command.participantId
          : sessionSlotParticipantId(acceptingThread.session);
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.follow-up-accepted",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          ...(command.message.skills !== undefined ? { skills: command.message.skills } : {}),
          ...(steeredAgentId !== null ? { participantId: steeredAgentId } : {}),
          ...(isNewMessage(acceptingThread, command.message.messageId)
            ? {
                agentModels: messageAgentModels(acceptingThread, [
                  {
                    participantId: steeredAgentId,
                    modelSelection: sentAgentModel(acceptingThread, steeredAgentId),
                  },
                ]),
              }
            : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.proposed-plan.dismiss": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const proposedPlan = thread.proposedPlans.find((entry) => entry.id === command.planId);
      if (!proposedPlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${command.planId}' does not exist on thread '${command.threadId}'.`,
        });
      }
      if (proposedPlan.implementedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${command.planId}' is already implemented and cannot be dismissed.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: {
            ...proposedPlan,
            dismissedAt: proposedPlan.dismissedAt ?? command.createdAt,
            updatedAt: command.createdAt,
          },
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          ...(command.threadDiffStat !== undefined
            ? { threadDiffStat: command.threadDiffStat }
            : {}),
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
          completesTurn: command.completesTurn,
        },
      };
    }

    case "thread.turn.diff.summary.update": {
      // Checkpoint existence is not an invariant here: the command read model
      // does not hydrate checkpoint bodies, so the projector no-ops instead
      // when the turn has no checkpoint to refresh.
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-diff-summary-updated",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          files: command.files,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.diffstat.rebase": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireNonNegativeInteger({
        commandType: command.type,
        field: "baselineTurnCount",
        value: command.baselineTurnCount,
      });
      // Forward-only. Rejecting an equal baseline is what makes the clean-
      // checkout observer idempotent: a checkout that stays clean re-derives
      // the same baseline on every poll and must not append an event each time.
      if (command.baselineTurnCount <= thread.diffStatBaselineTurnCount) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already counts its diff from turn ${thread.diffStatBaselineTurnCount}; baseline cannot move to ${command.baselineTurnCount}.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.diffstat-rebased",
        payload: {
          threadId: command.threadId,
          baselineTurnCount: command.baselineTurnCount,
          occurredAt: command.createdAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.activity.sideTurnId !== undefined) {
        yield* requireSideTurnOpen(thread, {
          type: command.type,
          sideTurnId: command.activity.sideTurnId,
        });
      }
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
