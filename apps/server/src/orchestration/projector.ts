import { compareTranscriptOrder } from "@threadlines/shared/transcriptOrder";
import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationSideTurnStatus,
  SideTurnId,
  ThreadId,
} from "@threadlines/contracts";
import {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
} from "@threadlines/contracts";
import {
  MAX_THREAD_ACTIVITIES,
  MAX_THREAD_CHECKPOINTS,
  MAX_THREAD_MESSAGES,
  MAX_THREAD_PROPOSED_PLANS,
} from "@threadlines/shared/threadLimits";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { retainThreadActivities } from "@threadlines/shared/threadActivityRetention";
import { applyRoomAgentUpdate, recordTurnModel } from "@threadlines/shared/threadParticipants";
import {
  agentRequestStateOn,
  withInviteChoice,
  withUnqueuedAgentMessage,
} from "@threadlines/shared/roomAgentRequests";
import { retainMessagesAfterRevert } from "@threadlines/shared/transcriptRevert";
import { childRequestStateOn } from "@threadlines/shared/childThreads";

import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from "./Errors.ts";
import {
  MessageSentPayloadSchema,
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
  ThreadActivityAppendedPayload,
  ThreadArchivedPayload,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  ThreadDoneOverrideSetPayload,
  ThreadInteractionModeSetPayload,
  ThreadMetaUpdatedPayload,
  ThreadPinnedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadSeenSetPayload,
  ThreadUnarchivedPayload,
  ThreadUnpinnedPayload,
  ThreadPullRequestAutomationChangedPayload,
  ThreadPullRequestLinkedPayload,
  ThreadParticipantAddedPayload,
  ThreadParticipantRemovedPayload,
  ThreadParticipantUpdatedPayload,
  ThreadRoomContextRecordedPayload,
  ThreadSentModelRecordedPayload,
  ThreadAgentRequestSubmittedPayload,
  ThreadAgentRequestUpdatedPayload,
  ThreadAgentRequestSettledPayload,
  ThreadAgentRequestsHeldPayload,
  ThreadAgentRequestsResetPayload,
  ThreadChildDeliveriesCancelledPayload,
  ThreadChildNotesDeliveredPayload,
  ThreadChildRequestSettledPayload,
  ThreadChildRequestSubmittedPayload,
  ThreadChildRequestUpdatedPayload,
  ThreadChildRequestsResetPayload,
  ThreadHandedBackPayload,
  ThreadParentAttachmentSetPayload,
  ThreadSideTurnInterruptRequestedPayload,
  ThreadSideTurnRunningPayload,
  ThreadSideTurnSettledPayload,
  ThreadSideTurnStartedPayload,
  ThreadRevertedPayload,
  ThreadSessionSetPayload,
  ThreadRealtimeStateSetPayload,
  ThreadEffectiveCwdSetPayload,
  ThreadGoalStateSetPayload,
  ThreadFollowUpSubmittedPayload,
  ThreadTurnStartRequestedPayload,
  ThreadFollowUpAcceptedPayload,
  ThreadFollowUpQueuedPayload,
  ThreadFollowUpUnqueuedPayload,
  ThreadTurnDiffCompletedPayload,
  ThreadTurnCompletedPayload,
  ThreadTurnDiffSummaryUpdatedPayload,
  ThreadDiffStatRebasedPayload,
} from "./Schemas.ts";
import { projectSubagentActivity } from "./subagentProjection.ts";

type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "projectId">>;

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") return "error" as const;
  if (status === "missing") return "interrupted" as const;
  return "completed" as const;
}

function turnDiffEventCompletesTurn(
  thread: Pick<OrchestrationThread, "session">,
  payload: { readonly turnId: string; readonly completesTurn?: boolean | undefined },
) {
  if (payload.completesTurn !== undefined) {
    return payload.completesTurn;
  }
  const activeTurnId = thread.session?.activeTurnId ?? null;
  return activeTurnId === null || activeTurnId !== payload.turnId;
}

/**
 * Moves the thread's side answer to a new status, but only the side answer
 * named: an event about one that is already over changes nothing.
 */
function updateSideTurnStatus(
  model: OrchestrationReadModel,
  threadId: ThreadId,
  sideTurnId: SideTurnId,
  next: (status: OrchestrationSideTurnStatus) => OrchestrationSideTurnStatus,
): OrchestrationReadModel {
  const sideTurn = model.threads.find((entry) => entry.id === threadId)?.sideTurn ?? null;
  if (sideTurn === null || sideTurn.sideTurnId !== sideTurnId) {
    return model;
  }
  return {
    ...model,
    threads: updateThread(model.threads, threadId, {
      sideTurn: { ...sideTurn, status: next(sideTurn.status) },
    }),
  };
}

/** Apply a change to one thread's child-thread request state. */
function updateChildRequests(
  base: OrchestrationReadModel,
  threadId: ThreadId,
  change: (state: OrchestrationThread["childRequests"]) => OrchestrationThread["childRequests"],
): OrchestrationReadModel {
  const thread = base.threads.find((entry) => entry.id === threadId);
  if (thread === undefined) {
    return base;
  }
  const next = change(thread.childRequests);
  return next === thread.childRequests
    ? base
    : { ...base, threads: updateThread(base.threads, threadId, { childRequests: next }) };
}

/** Apply a change to one thread's room request state. */
function updateAgentRequests(
  base: OrchestrationReadModel,
  threadId: ThreadId,
  change: (state: OrchestrationThread["agentRequests"]) => OrchestrationThread["agentRequests"],
): OrchestrationReadModel {
  const thread = base.threads.find((entry) => entry.id === threadId);
  if (thread === undefined) {
    return base;
  }
  return {
    ...base,
    threads: updateThread(base.threads, threadId, {
      agentRequests: change(thread.agentRequests),
    }),
  };
}

function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): OrchestrationThread[] {
  return threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread));
}

/**
 * A message's model stamps come from the write that created it: a later write
 * only fills them in when it has none. The SQL projection keeps the same rule.
 */
function keptAgentModels(
  existing: Pick<OrchestrationMessage, "agentModels">,
  incoming: Pick<OrchestrationMessage, "agentModels">,
): Pick<OrchestrationMessage, "agentModels"> {
  const agentModels = existing.agentModels ?? incoming.agentModels;
  return agentModels !== undefined ? { agentModels } : {};
}

function decodeForEvent<A>(
  schema: Schema.Decoder<A, never>,
  value: unknown,
  eventType: OrchestrationEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(toProjectorDecodeError(`${eventType}:${field}`)),
  );
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  return retainMessagesAfterRevert({
    messages,
    idOf: (message) => message.id,
    retainedTurnIds,
    turnCount,
  });
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadSubagentsAfterRevert(
  subagents: ReadonlyArray<NonNullable<OrchestrationThread["subagents"]>[number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<NonNullable<OrchestrationThread["subagents"]>[number]> {
  return subagents.filter(
    (subagent) => subagent.turnId === null || retainedTurnIds.has(subagent.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<OrchestrationThread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["proposedPlans"][number]> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.eventSequence !== undefined || right.eventSequence !== undefined) {
    return compareTranscriptOrder(left, right);
  }
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    updatedAt: nowIso,
  };
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "project.created":
      return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.projects.find((entry) => entry.id === payload.projectId);
          const nextProject = {
            id: payload.projectId,
            kind: payload.kind,
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
            defaultModelSelection: payload.defaultModelSelection,
            scripts: payload.scripts,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };

          return {
            ...nextBase,
            projects: existing
              ? nextBase.projects.map((entry) =>
                  entry.id === payload.projectId ? nextProject : entry,
                )
              : [...nextBase.projects, nextProject],
          };
        }),
      );

    case "project.meta-updated":
      return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.workspaceRoot !== undefined
                    ? { workspaceRoot: payload.workspaceRoot }
                    : {}),
                  ...(payload.defaultModelSelection !== undefined
                    ? { defaultModelSelection: payload.defaultModelSelection }
                    : {}),
                  ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                  updatedAt: payload.updatedAt,
                }
              : project,
          ),
        })),
      );

    case "project.deleted":
      return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : project,
          ),
        })),
      );

    case "thread.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread: OrchestrationThread = yield* decodeForEvent(
          OrchestrationThread,
          {
            id: payload.threadId,
            projectId: payload.projectId,
            title: payload.title,
            modelSelection: payload.modelSelection,
            runtimeMode: payload.runtimeMode,
            interactionMode: payload.interactionMode,
            branch: payload.branch,
            worktreePath: payload.worktreePath,
            parentThreadId: payload.parentThreadId ?? null,
            parentTurnId: payload.parentTurnId ?? null,
            attachedToParent: payload.attachedToParent ?? false,
            voiceActive: false,
            latestTurn: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            pinnedAt: null,
            pullRequestAutoFix: false,
            pullRequestAutoMerge: null,
            linkedPullRequests: [],
            participants: [],
            doneOverride: null,
            lastSeenAt: null,
            deletedAt: null,
            messages: [],
            activities: [],
            subagents: [],
            checkpoints: [],
            session: null,
            queuedFollowUps: [],
          },
          event.type,
          "thread",
        );
        const existing = nextBase.threads.find((entry) => entry.id === thread.id);
        return {
          ...nextBase,
          threads: existing
            ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
            : [...nextBase.threads, thread],
        };
      });

    case "thread.deleted":
      return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            deletedAt: payload.deletedAt,
            updatedAt: payload.deletedAt,
          }),
        })),
      );

    case "thread.archived":
      return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: payload.archivedAt,
            archivedWithParentAt: payload.withParent === true ? payload.archivedAt : null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unarchived":
      return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: null,
            archivedWithParentAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.pinned":
      return decodeForEvent(ThreadPinnedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinnedAt: payload.pinnedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unpinned":
      return decodeForEvent(ThreadUnpinnedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinnedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.pull-request-automation-changed":
      return decodeForEvent(
        ThreadPullRequestAutomationChangedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const { autoMerge, pullRequestNumber } = payload;
          // A numbered change is the switch of one linked pull request.
          if (pullRequestNumber !== undefined) {
            const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
            if (thread === undefined || autoMerge === undefined) {
              return nextBase;
            }
            return {
              ...nextBase,
              threads: updateThread(nextBase.threads, payload.threadId, {
                linkedPullRequests: thread.linkedPullRequests.map((linked) =>
                  linked.number === pullRequestNumber ? { ...linked, autoMerge } : linked,
                ),
                updatedAt: payload.updatedAt,
              }),
            };
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              ...(payload.autoFix === undefined ? {} : { pullRequestAutoFix: payload.autoFix }),
              ...(autoMerge === undefined ? {} : { pullRequestAutoMerge: autoMerge }),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    // Found in the conversation, not done to the thread, so it leaves
    // `updatedAt` where the agent's message put it.
    case "thread.pull-request-linked":
      return decodeForEvent(
        ThreadPullRequestLinkedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (
            thread === undefined ||
            thread.linkedPullRequests.some((linked) => linked.number === payload.number)
          ) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              linkedPullRequests: [
                ...thread.linkedPullRequests,
                { number: payload.number, url: payload.url, autoMerge: null },
              ],
            }),
          };
        }),
      );

    case "thread.participant-added":
      return decodeForEvent(
        ThreadParticipantAddedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (
            thread === undefined ||
            thread.participants.some((entry) => entry.id === payload.participant.id)
          ) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              participants: [...thread.participants, payload.participant],
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.participant-updated":
      return decodeForEvent(
        ThreadParticipantUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (thread === undefined) {
            return nextBase;
          }
          const { participants, agentRole } = applyRoomAgentUpdate(thread, payload);
          const { agentRole: _previous, ...rest } = thread;
          const next: OrchestrationThread = {
            ...rest,
            participants,
            ...(agentRole !== undefined ? { agentRole } : {}),
            updatedAt: payload.updatedAt,
          };
          return {
            ...nextBase,
            threads: nextBase.threads.map((entry) => (entry.id === thread.id ? next : entry)),
          };
        }),
      );

    case "thread.side-turn-started":
      return decodeForEvent(
        ThreadSideTurnStartedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            sideTurn: { ...payload.sideTurn, modelSelection: payload.modelSelection },
            updatedAt: event.occurredAt,
          }),
        })),
      );

    case "thread.side-turn-running":
      return decodeForEvent(
        ThreadSideTurnRunningPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) =>
          updateSideTurnStatus(nextBase, payload.threadId, payload.sideTurnId, (status) =>
            status === "cancelling" ? "cancelling" : "running",
          ),
        ),
      );

    case "thread.side-turn-interrupt-requested":
      return decodeForEvent(
        ThreadSideTurnInterruptRequestedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) =>
          updateSideTurnStatus(nextBase, payload.threadId, payload.sideTurnId, () => "cancelling"),
        ),
      );

    case "thread.side-turn-settled":
      return decodeForEvent(
        ThreadSideTurnSettledPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if ((thread?.sideTurn ?? null)?.sideTurnId !== payload.sideTurnId) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              sideTurn: null,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.room-context-recorded":
      return decodeForEvent(
        ThreadRoomContextRecordedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (thread === undefined) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              roomContext: { ...(thread.roomContext ?? {}), [payload.agentKey]: payload.cursor },
            }),
          };
        }),
      );

    case "thread.sent-model-recorded":
      return decodeForEvent(
        ThreadSentModelRecordedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (thread === undefined) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              sentModels: {
                ...(thread.sentModels ?? {}),
                [payload.agentKey]: payload.modelSelection,
              },
            }),
          };
        }),
      );

    case "thread.agent-request-submitted":
      return decodeForEvent(
        ThreadAgentRequestSubmittedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) =>
          updateAgentRequests(nextBase, payload.threadId, (state) =>
            agentRequestStateOn.submitted(state, payload.request),
          ),
        ),
      );

    case "thread.agent-request-updated":
      return decodeForEvent(
        ThreadAgentRequestUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const next = updateAgentRequests(nextBase, payload.threadId, (state) =>
            agentRequestStateOn.updated(state, payload),
          );
          const inviteChoice = payload.inviteChoice;
          const thread = next.threads.find((entry) => entry.id === payload.threadId);
          if (inviteChoice === undefined || thread === undefined) {
            return next;
          }
          // The user's answer to an invite stays on its request message.
          return {
            ...next,
            threads: updateThread(next.threads, payload.threadId, {
              messages: thread.messages.map((message) => {
                if (message.id !== inviteChoice.requestMessageId) return message;
                const invite = withInviteChoice(message.invite, inviteChoice);
                return invite === undefined ? message : { ...message, invite };
              }),
            }),
          };
        }),
      );

    case "thread.agent-request-settled":
      return decodeForEvent(
        ThreadAgentRequestSettledPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const next = updateAgentRequests(nextBase, payload.threadId, (state) =>
            agentRequestStateOn.settled(state, payload.requestId, payload.outcome),
          );
          const thread = next.threads.find((entry) => entry.id === payload.threadId);
          if (thread === undefined) {
            return next;
          }
          // The outcome stays on the request's message after the request is gone.
          return {
            ...next,
            threads: updateThread(next.threads, payload.threadId, {
              messages: thread.messages.map((message) =>
                message.id === payload.requestMessageId
                  ? {
                      ...message,
                      requestOutcome: payload.outcome,
                      ...(payload.error !== undefined ? { requestError: payload.error } : {}),
                    }
                  : message,
              ),
            }),
          };
        }),
      );

    case "thread.agent-requests-held":
      return decodeForEvent(
        ThreadAgentRequestsHeldPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) =>
          updateAgentRequests(nextBase, payload.threadId, (state) =>
            agentRequestStateOn.held(state, payload.chainEpoch),
          ),
        ),
      );

    case "thread.agent-requests-reset":
      return decodeForEvent(
        ThreadAgentRequestsResetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) =>
          updateAgentRequests(nextBase, payload.threadId, agentRequestStateOn.reset),
        ),
      );

    case "thread.child-request-submitted":
      return decodeForEvent(
        ThreadChildRequestSubmittedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) =>
          updateChildRequests(nextBase, payload.threadId, (state) =>
            childRequestStateOn.submitted(state, payload.request),
          ),
        ),
      );

    case "thread.child-request-updated":
      return decodeForEvent(
        ThreadChildRequestUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) =>
          updateChildRequests(nextBase, payload.threadId, (state) =>
            childRequestStateOn.updated(state, payload),
          ),
        ),
      );

    case "thread.child-request-settled":
      return decodeForEvent(
        ThreadChildRequestSettledPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) =>
          updateChildRequests(nextBase, payload.threadId, (state) =>
            childRequestStateOn.settled(state, payload.requestId, payload.note),
          ),
        ),
      );

    case "thread.child-notes-delivered":
      return decodeForEvent(
        ThreadChildNotesDeliveredPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) =>
          updateChildRequests(nextBase, payload.threadId, (state) =>
            childRequestStateOn.notesDelivered(state, payload.requestIds),
          ),
        ),
      );

    case "thread.child-deliveries-cancelled":
      return decodeForEvent(
        ThreadChildDeliveriesCancelledPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) =>
          updateChildRequests(nextBase, payload.threadId, (state) =>
            childRequestStateOn.deliveriesCancelled(state, payload.deliveryEpoch),
          ),
        ),
      );

    case "thread.child-requests-reset":
      return decodeForEvent(
        ThreadChildRequestsResetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) =>
          updateChildRequests(nextBase, payload.threadId, childRequestStateOn.reset),
        ),
      );

    // Neither moves `updatedAt`: a handed-back answer and a family change
    // are not work on the child.
    case "thread.handed-back":
      return decodeForEvent(ThreadHandedBackPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            handedBackAt: payload.handedBackAt,
            handedBackTurnId: payload.turnId,
          }),
        })),
      );

    case "thread.parent-attachment-set":
      return decodeForEvent(
        ThreadParentAttachmentSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            attachedToParent: payload.attached,
            parentAttachmentEpoch: payload.attachmentEpoch,
          }),
        })),
      );

    case "thread.participant-removed":
      return decodeForEvent(
        ThreadParticipantRemovedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (thread === undefined) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              participants: thread.participants.map((entry) =>
                entry.id === payload.participantId && entry.leftAt === null
                  ? { ...entry, leftAt: payload.updatedAt }
                  : entry,
              ),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    // A room agent's model follows the composer the same way the thread's own
    // agent's does, but it lives on the participant, not the thread.
    case "thread.turn-start-requested":
      return decodeForEvent(
        ThreadTurnStartRequestedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const participantId = payload.participantId ?? null;
          const modelSelection = payload.modelSelection;
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (thread === undefined) {
            return nextBase;
          }
          const participants =
            participantId === null || modelSelection === undefined
              ? thread.participants
              : thread.participants.map((entry) =>
                  entry.id === participantId ? { ...entry, modelSelection } : entry,
                );
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              participants,
              // What the turn is sent with, and its messages stamped with.
              sentModels: recordTurnModel(
                { ...thread, participants },
                participantId,
                modelSelection,
              ),
            }),
          };
        }),
      );

    // Neither lifecycle event touches `updatedAt`: filing or reading a thread
    // is not work on it, and the inbox weighs these stamps against activity.
    case "thread.done-override-set":
      return decodeForEvent(
        ThreadDoneOverrideSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            doneOverride: { state: payload.state, at: payload.at },
          }),
        })),
      );

    case "thread.seen-set":
      return decodeForEvent(ThreadSeenSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            lastSeenAt: payload.at,
          }),
        })),
      );

    case "thread.meta-updated":
      return decodeForEvent(ThreadMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.modelSelection !== undefined
              ? { modelSelection: payload.modelSelection }
              : {}),
            ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
            ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.runtime-mode-set":
      return decodeForEvent(ThreadRuntimeModeSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            runtimeMode: payload.runtimeMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.interaction-mode-set":
      return decodeForEvent(
        ThreadInteractionModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            interactionMode: payload.interactionMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.message-sent":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          MessageSentPayloadSchema,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            eventSequence: event.sequence,
            role: payload.role,
            text: payload.text,
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            ...(payload.skills !== undefined ? { skills: payload.skills } : {}),
            ...(payload.participantId !== undefined
              ? { participantId: payload.participantId }
              : {}),
            ...(payload.sideTurnId !== undefined ? { sideTurnId: payload.sideTurnId } : {}),
            ...(payload.fromAgent !== undefined ? { fromAgent: payload.fromAgent } : {}),
            ...(payload.requestId !== undefined ? { requestId: payload.requestId } : {}),
            ...(payload.requestKind !== undefined ? { requestKind: payload.requestKind } : {}),
            ...(payload.reviewInput !== undefined ? { reviewInput: payload.reviewInput } : {}),
            ...(payload.invite !== undefined ? { invite: payload.invite } : {}),
            ...(payload.fromThread !== undefined ? { fromThread: payload.fromThread } : {}),
            ...(payload.agentModels !== undefined ? { agentModels: payload.agentModels } : {}),
            turnId: payload.turnId,
            streaming: payload.streaming,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
          event.type,
          "message",
        );

        const existingMessage = thread.messages.find((entry) => entry.id === message.id);
        const messages = existingMessage
          ? thread.messages.map((entry) =>
              entry.id === message.id
                ? {
                    ...entry,
                    text: message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                    streaming: message.streaming,
                    updatedAt: message.updatedAt,
                    turnId: message.turnId,
                    ...(message.attachments !== undefined
                      ? { attachments: message.attachments }
                      : {}),
                    ...(message.skills !== undefined ? { skills: message.skills } : {}),
                    ...keptAgentModels(entry, message),
                  }
                : entry,
            )
          : [...thread.messages, message];
        const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: cappedMessages,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.follow-up-submitted":
      return decodeForEvent(
        ThreadFollowUpSubmittedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            updatedAt: payload.createdAt,
          }),
        })),
      );

    case "thread.follow-up-accepted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadFollowUpAcceptedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            eventSequence: event.sequence,
            role: payload.role,
            text: payload.text,
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            ...(payload.skills !== undefined ? { skills: payload.skills } : {}),
            ...(payload.participantId !== undefined
              ? { participantId: payload.participantId }
              : {}),
            ...(payload.agentModels !== undefined ? { agentModels: payload.agentModels } : {}),
            turnId: payload.turnId,
            streaming: false,
            createdAt: payload.createdAt,
            updatedAt: payload.createdAt,
          },
          event.type,
          "message",
        );

        const existingMessage = thread.messages.find((entry) => entry.id === message.id);
        const messages = existingMessage
          ? thread.messages.map((entry) =>
              entry.id === message.id
                ? {
                    ...message,
                    eventSequence: entry.eventSequence,
                    ...keptAgentModels(entry, message),
                  }
                : entry,
            )
          : [...thread.messages, message];

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: messages.slice(-MAX_THREAD_MESSAGES),
            updatedAt: payload.createdAt,
          }),
        };
      });

    case "thread.follow-up-queued":
      return decodeForEvent(ThreadFollowUpQueuedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              queuedFollowUps: [
                ...(thread.queuedFollowUps ?? []).filter(
                  (queued) => queued.messageId !== payload.followUp.messageId,
                ),
                payload.followUp,
              ],
              updatedAt: payload.followUp.createdAt,
            }),
          };
        }),
      );

    case "thread.follow-up-unqueued":
      return decodeForEvent(
        ThreadFollowUpUnqueuedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              queuedFollowUps: (thread.queuedFollowUps ?? []).filter(
                (queued) => queued.messageId !== payload.messageId,
              ),
              messages: thread.messages.map((message) =>
                withUnqueuedAgentMessage(message, payload),
              ),
            }),
          };
        }),
      );

    case "thread.session-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadSessionSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const decodedSession: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          "session",
        );
        // An update that does not name the slot holder keeps the current one.
        const session: OrchestrationSession =
          decodedSession.participantId !== undefined
            ? decodedSession
            : { ...decodedSession, participantId: thread.session?.participantId ?? null };

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            session,
            latestTurn:
              session.status === "running" && session.activeTurnId !== null
                ? {
                    turnId: session.activeTurnId,
                    state: "running",
                    requestedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.requestedAt
                        : session.updatedAt,
                    startedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? (thread.latestTurn.startedAt ?? session.updatedAt)
                        : session.updatedAt,
                    completedAt: null,
                    assistantMessageId:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.assistantMessageId
                        : null,
                  }
                : (session.status === "interrupted" || session.status === "stopped") &&
                    thread.latestTurn?.state === "running"
                  ? {
                      ...thread.latestTurn,
                      state: "interrupted",
                      startedAt: thread.latestTurn.startedAt ?? session.updatedAt,
                      completedAt: thread.latestTurn.completedAt ?? session.updatedAt,
                    }
                  : thread.latestTurn,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.realtime-state-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadRealtimeStateSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            voiceActive: payload.active,
            updatedAt: payload.updatedAt,
          }),
        };
      });

    case "thread.effective-cwd-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadEffectiveCwdSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        if (!nextBase.threads.some((entry) => entry.id === payload.threadId)) {
          return nextBase;
        }
        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            effectiveCwd: payload.effectiveCwd,
            effectiveCwdSource:
              payload.effectiveCwdSource ?? (payload.effectiveCwd === null ? null : "session"),
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.goal-state-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadGoalStateSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        if (!nextBase.threads.some((entry) => entry.id === payload.threadId)) {
          return nextBase;
        }
        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            goal: payload.goal,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.proposed-plan-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadProposedPlanUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const existingPlan = thread.proposedPlans.find(
          (entry) => entry.id === payload.proposedPlan.id,
        );
        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
          {
            ...payload.proposedPlan,
            eventSequence: existingPlan ? existingPlan.eventSequence : event.sequence,
          },
        ]
          .toSorted(compareTranscriptOrder)
          .slice(-MAX_THREAD_PROPOSED_PLANS);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            proposedPlans,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-diff-completed":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnDiffCompletedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const checkpoint = yield* decodeForEvent(
          OrchestrationCheckpointSummary,
          {
            turnId: payload.turnId,
            checkpointTurnCount: payload.checkpointTurnCount,
            checkpointRef: payload.checkpointRef,
            status: payload.status,
            files: payload.files,
            ...(payload.threadDiffStat !== undefined
              ? { threadDiffStat: payload.threadDiffStat }
              : {}),
            assistantMessageId: payload.assistantMessageId,
            completedAt: payload.completedAt,
          },
          event.type,
          "checkpoint",
        );

        // Do not let a placeholder (status "missing") overwrite a checkpoint
        // that has already been captured with a real git ref (status "ready").
        // ProviderRuntimeIngestion may fire multiple turn.diff.updated events
        // per turn; without this guard later placeholders would clobber the
        // real capture dispatched by CheckpointReactor.
        const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return nextBase;
        }

        const checkpoints = [
          ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
          .slice(-MAX_THREAD_CHECKPOINTS);
        const completesTurn = turnDiffEventCompletesTurn(thread, payload);
        const latestTurn = completesTurn
          ? {
              turnId: payload.turnId,
              state: checkpointStatusToLatestTurnState(payload.status),
              requestedAt:
                thread.latestTurn?.turnId === payload.turnId
                  ? thread.latestTurn.requestedAt
                  : payload.completedAt,
              startedAt:
                thread.latestTurn?.turnId === payload.turnId
                  ? (thread.latestTurn.startedAt ?? payload.completedAt)
                  : payload.completedAt,
              completedAt: payload.completedAt,
              assistantMessageId: payload.assistantMessageId,
            }
          : thread.latestTurn;

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            checkpoints,
            latestTurn,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-completed":
      return decodeForEvent(ThreadTurnCompletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          // Only the turn still running settles: a late event for an older
          // turn, or one a checkpoint already ended, changes nothing.
          if (
            !thread?.latestTurn ||
            thread.latestTurn.turnId !== payload.turnId ||
            thread.latestTurn.state !== "running"
          ) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              latestTurn: {
                ...thread.latestTurn,
                state: payload.state,
                completedAt: payload.completedAt,
              },
            }),
          };
        }),
      );

    case "thread.turn-diff-summary-updated":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnDiffSummaryUpdatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        // Only refresh a checkpoint that already exists for this turn; the
        // placeholder/complete flow owns creation, turn counts, and status.
        const existing = thread.checkpoints.find((entry) => entry.turnId === payload.turnId);
        if (!existing) {
          return nextBase;
        }

        const checkpoints = thread.checkpoints.map((entry) =>
          entry.turnId === payload.turnId ? { ...entry, files: payload.files } : entry,
        );

        // Deliberately no updatedAt bump: summary refreshes stream many times
        // per turn and must not churn thread ordering or lifecycle state.
        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            checkpoints,
          }),
        };
      });

    case "thread.diffstat-rebased":
      return decodeForEvent(
        ThreadDiffStatRebasedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              // Clamped rather than assigned: the decider rejects backwards
              // baselines, so replaying an out-of-order event must not undo a
              // later rebase either.
              diffStatBaselineTurnCount: Math.max(
                thread.diffStatBaselineTurnCount,
                payload.baselineTurnCount,
              ),
              updatedAt: payload.occurredAt,
            }),
          };
        }),
      );

    case "thread.reverted":
      return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const checkpoints = thread.checkpoints
            .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);
          const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          ).slice(-MAX_THREAD_PROPOSED_PLANS);
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);
          const subagents = retainThreadSubagentsAfterRevert(
            thread.subagents ?? [],
            retainedTurnIds,
          );

          const latestCheckpoint = checkpoints.at(-1) ?? null;
          const latestTurn =
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId,
                };

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages,
              proposedPlans,
              activities,
              subagents,
              latestTurn,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const existingActivity = thread.activities.find(
            (entry) => entry.id === payload.activity.id,
          );
          const activities = retainThreadActivities(
            [
              ...thread.activities.filter((entry) => entry.id !== payload.activity.id),
              {
                ...payload.activity,
                eventSequence: existingActivity ? existingActivity.eventSequence : event.sequence,
              },
            ].toSorted(compareThreadActivities),
            MAX_THREAD_ACTIVITIES,
          );
          const subagents = projectSubagentActivity(thread.subagents ?? [], {
            ...payload.activity,
            eventSequence: event.sequence,
          });

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities,
              subagents,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    default:
      return Effect.succeed(nextBase);
  }
}
