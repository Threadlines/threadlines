import { replaceAgentCheckBacks, sameCheckBacks } from "@threadlines/shared/checkBacks";
import {
  applyLinkedPullRequestSwitches,
  applyPullRequestLinked,
} from "@threadlines/shared/linkedPullRequests";
import { applyPullRequestDismissed } from "@threadlines/shared/pullRequestDismissals";
import { sameAwaitedBackgroundTasks } from "@threadlines/shared/awaitedBackgroundTasks";
import { compareTranscriptOrder } from "@threadlines/shared/transcriptOrder";
import type {
  EnvironmentId,
  OrchestrationAgentRequestState,
  OrchestrationCheckpointSummary,
  OrchestrationChildRequestState,
  OrchestrationEvent,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationAgentPage,
  OrchestrationCommandRequest,
  OrchestrationCommandRun,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent,
  OrchestrationSession,
  OrchestrationSessionStatus,
  OrchestrationSideTurn,
  OrchestrationSubagent,
  OrchestrationThread,
  OrchestrationThreadShell,
  OrchestrationWorkflowRun,
  OrchestrationThreadActivity,
  OrchestrationCheckBack,
  OrchestrationThreadGoal,
  OrchestrationThreadMove,
  ProjectId,
  RemoteChildStart,
  LocalChildStart,
  RemoteChildThread,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadMovedFrom,
  ThreadRemoteOrigin,
} from "@threadlines/contracts";
import {
  EMPTY_AGENT_REQUEST_STATE,
  EMPTY_CHILD_REQUEST_STATE,
  isProviderDriverKind,
  ProviderDriverKind,
} from "@threadlines/contracts";
import type { OutsideAgentRef, ThreadId, ThreadScheduledRun, TurnId } from "@threadlines/contracts";
import * as Schema from "effect/Schema";
import { resolveModelSlugForProvider } from "@threadlines/shared/model";
import { retainThreadActivities } from "@threadlines/shared/threadActivityRetention";
import { effectiveCwdOf } from "@threadlines/shared/threadCwd";
import {
  MAX_THREAD_ACTIVITIES,
  MAX_THREAD_CHECKPOINTS,
  MAX_THREAD_MESSAGES,
  MAX_THREAD_PROPOSED_PLANS,
} from "@threadlines/shared/threadLimits";
import { create, type StateCreator } from "zustand";
import {
  type ChatAttachment,
  type ChatMessage,
  type Project,
  type ProposedPlan,
  type SidebarThreadSummary,
  type Thread,
  type ThreadSession,
  type ThreadShell,
  type ThreadTurnState,
  type TurnDiffSummary,
} from "./types";
import { resolveEnvironmentHttpUrl } from "./environments/runtime";
import { attachmentPreviewRoutePath } from "./lib/attachmentPreviewQuery";
import { keyedMemo } from "./lib/derivationMemo";
import { createBatchedNotifications } from "./lib/batchedNotifications";
import { sanitizeThreadErrorMessage } from "./rpc/transportError";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  findLatestProposedPlan,
  hasActionableProposedPlan,
  isWaitingOnBackgroundTasks,
  isBlockingUserInput,
  sumTurnDiffStats,
} from "./session-logic";
import { getThreadFromEnvironmentState } from "./threadDerivation";
import { threadMoveStatus } from "./threadMove";
import {
  roomSideModelSelection,
  roomSideRole,
  roomSlotModelSelection,
  roomSlotRole,
} from "./rooms";
import { applyRoomAgentUpdate } from "@threadlines/shared/threadParticipants";
import {
  agentRequestStateOn,
  awaitingInvite,
  isUserWrittenMessage,
  withInviteChoice,
  withUnqueuedAgentMessage,
} from "@threadlines/shared/roomAgentRequests";
import { applyAgentPagePublication } from "@threadlines/shared/agentPages";
import {
  applyWorkflowRunPatch,
  retainWorkflowRunsAfterRevert,
} from "@threadlines/shared/workflowRuns";
import {
  applyCommandRequestDismissed,
  applyCommandRequested,
  applyCommandRunProgress,
  applyCommandRunStarted,
} from "@threadlines/shared/commandRuns";
import { retainTurnItemsAfterRevert, revertMessages } from "@threadlines/shared/transcriptRevert";
import {
  projectSubagentActivity,
  retainSubagentsAfterRevert,
} from "@threadlines/shared/subagentProjection";
import {
  awaitedChildRequestCount,
  childRequestStateOn,
  hasPendingChildApproval,
  remoteChildStartsOf,
  localChildStartsOf,
} from "@threadlines/shared/childThreads";
const isProviderDriverKindValue = Schema.is(ProviderDriverKind);

export interface EnvironmentState {
  projectIds: ProjectId[];
  projectById: Record<ProjectId, Project>;

  // ---------------------------------------------------------------------------
  // Thread bookkeeping — written by BOTH shell stream and detail stream.
  // Both streams ensure the thread is registered here; the bookkeeping is
  // additive (append-only IDs) so concurrent writes are safe.
  // ---------------------------------------------------------------------------
  threadIds: ThreadId[];
  threadIdsByProjectId: Record<ProjectId, ThreadId[]>;

  // ---------------------------------------------------------------------------
  // Thread shell / session / turn — written by BOTH shell stream and detail
  // stream.  The shell stream is the *authoritative* source (server pre-
  // computes these from the projection pipeline), but the detail stream also
  // writes them so the active thread has up-to-date state even if the shell
  // event hasn't arrived yet.  Structural equality checks in both write
  // functions prevent unnecessary React re-renders when both streams deliver
  // equivalent data.
  // ---------------------------------------------------------------------------
  threadShellById: Record<ThreadId, ThreadShell>;
  threadSessionById: Record<ThreadId, ThreadSession | null>;
  threadTurnStateById: Record<ThreadId, ThreadTurnState>;

  // ---------------------------------------------------------------------------
  // Thread detail content — written ONLY by the detail stream
  // (writeThreadState / syncServerThreadDetail).  The shell stream never
  // touches these.
  // ---------------------------------------------------------------------------
  /**
   * Each thread's messages and activities, in thread order: the very lists
   * its `Thread` exposes. They change on every streamed event and run to
   * thousands, so a change swaps in the new list rather than rebuilding an
   * index of every entry.
   */
  messagesByThreadId: Record<ThreadId, ChatMessage[]>;
  activitiesByThreadId: Record<ThreadId, OrchestrationThreadActivity[]>;
  proposedPlanIdsByThreadId: Record<ThreadId, string[]>;
  proposedPlanByThreadId: Record<ThreadId, Record<string, ProposedPlan>>;
  turnDiffIdsByThreadId: Record<ThreadId, TurnId[]>;
  turnDiffSummaryByThreadId: Record<ThreadId, Record<TurnId, TurnDiffSummary>>;
  /** Room tools: open agent requests, the Stop hold and the limit's count. */
  agentRequestsByThreadId: Record<ThreadId, OrchestrationAgentRequestState>;
  /** Agent pages per thread (OrchestrationAgentPage); absent until a thread's detail loads. */
  pagesByThreadId?: Record<ThreadId, ReadonlyArray<OrchestrationAgentPage>>;
  /** Workflow runs per thread (OrchestrationWorkflowRun); absent until a thread's detail loads. */
  workflowRunsByThreadId?: Record<ThreadId, ReadonlyArray<OrchestrationWorkflowRun>>;
  /**
   * Every agent each thread has spawned (OrchestrationSubagent), uncapped like
   * the server's roster: the activity window drops a long-running agent's
   * spawn, and this is what still names it. Absent until a thread's detail
   * loads; activity events fold into it the way the server projects them.
   */
  subagentsByThreadId?: Record<ThreadId, ReadonlyArray<OrchestrationSubagent>>;
  /** Suggested commands per thread (docs/terminal-command-runs.md); absent until a thread's detail loads. */
  commandRequestsByThreadId?: Record<ThreadId, ReadonlyArray<OrchestrationCommandRequest>>;
  commandRunsByThreadId?: Record<ThreadId, ReadonlyArray<OrchestrationCommandRun>>;
  /**
   * Threads whose detail snapshot has landed (syncServerThreadDetail). Events
   * and optimistic writes fill the detail slices too, so only this says a
   * thread's messages are its history rather than a partial view: until then
   * the chat says it is loading, not that the thread is empty. Dropped with
   * the thread, or by `markThreadDetailUnloaded` when its detail feed ends.
   */
  threadDetailLoadedById?: Record<ThreadId, true>;
  /** Child threads: what each thread's agent asked of the threads it started. */
  childRequestsByThreadId: Record<ThreadId, OrchestrationChildRequestState>;

  // ---------------------------------------------------------------------------
  // Sidebar summary — written by the shell stream and provisionally by the
  // detail stream. Shell summaries are pre-computed server-side with fields
  // like latestUserMessageAt, hasPendingApprovals, etc.; detail summaries keep
  // the active thread visible while shell projection catches up.
  // ---------------------------------------------------------------------------
  sidebarThreadSummaryById: Record<ThreadId, SidebarThreadSummary>;
  /**
   * Threads whose agent's scheduled-task change waits for the user, from this
   * computer's scheduled tasks feed (setScheduleApprovalThreads). Every
   * summary written here carries it as `pendingScheduleApproval`.
   */
  scheduleApprovalThreadIds?: Record<ThreadId, true>;

  bootstrapComplete: boolean;
}

export interface AppState {
  activeEnvironmentId: EnvironmentId | null;
  environmentStateById: Record<string, EnvironmentState>;
}

const initialEnvironmentState: EnvironmentState = {
  projectIds: [],
  projectById: {},
  threadIds: [],
  threadIdsByProjectId: {},
  threadShellById: {},
  threadSessionById: {},
  threadTurnStateById: {},
  messagesByThreadId: {},
  activitiesByThreadId: {},
  proposedPlanIdsByThreadId: {},
  proposedPlanByThreadId: {},
  turnDiffIdsByThreadId: {},
  turnDiffSummaryByThreadId: {},
  agentRequestsByThreadId: {},
  pagesByThreadId: {},
  workflowRunsByThreadId: {},
  subagentsByThreadId: {},
  commandRequestsByThreadId: {},
  commandRunsByThreadId: {},
  threadDetailLoadedById: {},
  childRequestsByThreadId: {},
  sidebarThreadSummaryById: {},
  bootstrapComplete: false,
};

const initialState: AppState = {
  activeEnvironmentId: null,
  environmentStateById: {},
};

const EMPTY_THREAD_IDS: ThreadId[] = [];
const EMPTY_SUBAGENTS: ReadonlyArray<OrchestrationSubagent> = [];

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// Accepts the open `instanceId` string carried on `ModelSelection`; malformed
// values pass through unchanged, while valid slugs use any registered alias
// table for model normalization.
function normalizeModelSelection<T extends { instanceId: string; model: string }>(selection: T): T {
  if (!isProviderDriverKind(selection.instanceId)) {
    return selection;
  }
  return {
    ...selection,
    model: resolveModelSlugForProvider(selection.instanceId, selection.model),
  };
}

function mapProjectScripts(scripts: ReadonlyArray<Project["scripts"][number]>): Project["scripts"] {
  return scripts.map((script) => ({ ...script }));
}

function mapSession(session: OrchestrationSession): ThreadSession {
  return {
    provider: toLegacyProvider(session.providerName),
    providerInstanceId: session.providerInstanceId ?? undefined,
    providerSessionId: session.providerSessionId ?? undefined,
    providerThreadId: session.providerThreadId ?? undefined,
    status: toLegacySessionStatus(session.status),
    orchestrationStatus: session.status,
    checkoutCwd: session.checkoutCwd ?? undefined,
    ...(session.participantId ? { participantId: session.participantId } : {}),
    activeTurnId: session.activeTurnId ?? undefined,
    pendingBackgroundTaskCount: session.pendingBackgroundTaskCount ?? 0,
    // An older server does not split the count: it awaited every task.
    awaitedBackgroundTaskCount:
      session.awaitedBackgroundTaskCount ?? session.pendingBackgroundTaskCount ?? 0,
    ...(session.awaitedBackgroundTasks?.length
      ? { awaitedBackgroundTasks: session.awaitedBackgroundTasks }
      : {}),
    ...(session.startup?.phase === "launching"
      ? { launchingInstanceId: session.startup.providerInstanceId }
      : {}),
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    ...(session.lastError ? { lastError: session.lastError } : {}),
  };
}

/**
 * A session update applied over the thread's current session. One that does
 * not name the slot holder keeps the current one, and one that leaves out the
 * startup phase keeps that (see OrchestrationSession).
 */
function mapSessionUpdate(
  session: OrchestrationSession,
  current: ThreadSession | null | undefined,
): ThreadSession {
  return {
    ...mapSession(session),
    ...(session.participantId === undefined && current?.participantId
      ? { participantId: current.participantId }
      : {}),
    ...(session.startup === undefined && current?.launchingInstanceId
      ? { launchingInstanceId: current.launchingInstanceId }
      : {}),
  };
}

function resolveSessionProviderFromModelSelection(input: {
  modelSelection: Thread["modelSelection"];
  previousSession: ThreadSession | null | undefined;
}): ProviderDriverKind {
  const instanceId = input.modelSelection.instanceId;
  return isProviderDriverKindValue(instanceId)
    ? instanceId
    : (input.previousSession?.provider ?? ProviderDriverKind.make("codex"));
}

function mapMessage(environmentId: EnvironmentId, message: OrchestrationMessage): ChatMessage {
  const attachments = message.attachments?.map((attachment): ChatAttachment =>
    attachment.type === "image"
      ? {
          type: "image",
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          previewUrl: resolveEnvironmentHttpUrl({
            environmentId,
            pathname: attachmentPreviewRoutePath(attachment.id),
          }),
        }
      : {
          type: "file",
          kind: attachment.kind,
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        },
  );

  return {
    id: message.id,
    role: message.role,
    text: message.text,
    turnId: message.turnId,
    createdAt: message.createdAt,
    ...(message.eventSequence !== undefined ? { eventSequence: message.eventSequence } : {}),
    streaming: message.streaming,
    ...(message.streaming ? {} : { completedAt: message.updatedAt }),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(message.skills !== undefined ? { skills: [...message.skills] } : {}),
    ...(message.participantId ? { participantId: message.participantId } : {}),
    ...(message.sideTurnId ? { sideTurnId: message.sideTurnId } : {}),
    ...(message.fromAgent ? { fromAgent: message.fromAgent } : {}),
    ...(message.requestId ? { requestId: message.requestId } : {}),
    ...(message.requestKind ? { requestKind: message.requestKind } : {}),
    ...(message.requestOutcome ? { requestOutcome: message.requestOutcome } : {}),
    ...(message.requestError ? { requestError: message.requestError } : {}),
    ...(message.reviewInput ? { reviewInput: message.reviewInput } : {}),
    ...(message.invite ? { invite: message.invite } : {}),
    ...(message.fromThread ? { fromThread: message.fromThread } : {}),
    ...(message.fromOutside ? { fromOutside: message.fromOutside } : {}),
    ...(message.agentModels ? { agentModels: message.agentModels } : {}),
    ...(message.sentFrom ? { sentFrom: message.sentFrom } : {}),
    ...(message.imported ? { imported: true as const } : {}),
  };
}

/**
 * A thread's place in a family of child threads, as every web copy of it
 * carries it: normalized so a missing field and its empty value read alike.
 */
function threadLineage(thread: {
  readonly parentThreadId?: ThreadId | null | undefined;
  readonly parentTurnId?: TurnId | null | undefined;
  readonly attachedToParent?: boolean | undefined;
  readonly handedBackAt?: string | null | undefined;
  readonly handedBackTurnId?: TurnId | null | undefined;
  readonly scheduledRun?: ThreadScheduledRun | null | undefined;
  readonly outsideOrigin?: OutsideAgentRef | null | undefined;
}): Pick<
  ThreadShell,
  | "parentThreadId"
  | "parentTurnId"
  | "attachedToParent"
  | "handedBackAt"
  | "handedBackTurnId"
  | "scheduledRun"
  | "outsideOrigin"
> {
  return {
    parentThreadId: thread.parentThreadId ?? null,
    parentTurnId: thread.parentTurnId ?? null,
    attachedToParent: thread.attachedToParent ?? false,
    handedBackAt: thread.handedBackAt ?? null,
    handedBackTurnId: thread.handedBackTurnId ?? null,
    scheduledRun: thread.scheduledRun ?? null,
    outsideOrigin: thread.outsideOrigin ?? null,
  };
}

/**
 * A parent's answers still owed and its pending approval. The detail stream
 * knows its open requests and counts them the way the server does; without
 * them, the shell's counts stand.
 */
function childRequestCounts(thread: {
  readonly childRequests?: OrchestrationChildRequestState | undefined;
  readonly awaitedChildThreadCount?: number | undefined;
  readonly pendingChildApproval?: boolean | undefined;
}): { awaitedChildThreadCount: number; pendingChildApproval: boolean } {
  return thread.childRequests !== undefined
    ? {
        awaitedChildThreadCount: awaitedChildRequestCount(thread.childRequests),
        pendingChildApproval: hasPendingChildApproval(thread.childRequests),
      }
    : {
        awaitedChildThreadCount: thread.awaitedChildThreadCount ?? 0,
        pendingChildApproval: thread.pendingChildApproval ?? false,
      };
}

/**
 * The parts of a thread's family it has no thread for (docs/design/fleet.md):
 * the thread on another computer whose agent started it, and on a parent its
 * children on linked computers and the ones it started here (one being set up
 * has no thread yet). A loaded thread's open requests know them first-hand;
 * without them, the shell's copies stand. Empty lists are left out, so two
 * copies of the same family compare alike.
 */
function remoteFamily(thread: {
  readonly remoteOrigin?: ThreadRemoteOrigin | null | undefined;
  readonly childRequests?: OrchestrationChildRequestState | undefined;
  readonly remoteChildren?: ReadonlyArray<RemoteChildThread> | undefined;
  readonly remoteChildStarts?: ReadonlyArray<RemoteChildStart> | undefined;
  readonly localChildStarts?: ReadonlyArray<LocalChildStart> | undefined;
}): Pick<
  ThreadShell,
  "remoteOrigin" | "remoteChildren" | "remoteChildStarts" | "localChildStarts"
> {
  const children =
    thread.childRequests !== undefined
      ? (thread.childRequests.remoteChildren ?? [])
      : (thread.remoteChildren ?? []);
  const starts =
    thread.childRequests !== undefined
      ? remoteChildStartsOf(thread.childRequests)
      : (thread.remoteChildStarts ?? []);
  const localStarts =
    thread.childRequests !== undefined
      ? localChildStartsOf(thread.childRequests)
      : (thread.localChildStarts ?? []);
  return {
    ...(thread.remoteOrigin ? { remoteOrigin: thread.remoteOrigin } : {}),
    ...(children.length > 0 ? { remoteChildren: children } : {}),
    ...(starts.length > 0 ? { remoteChildStarts: starts } : {}),
    ...(localStarts.length > 0 ? { localChildStarts: localStarts } : {}),
  };
}

function remoteOriginsEqual(
  left: ThreadRemoteOrigin | null | undefined,
  right: ThreadRemoteOrigin | null | undefined,
): boolean {
  const a = left ?? null;
  const b = right ?? null;
  return a === null || b === null
    ? a === b
    : a.linkDeviceId === b.linkDeviceId &&
        a.environmentId === b.environmentId &&
        a.environmentPinned === b.environmentPinned &&
        a.environmentLabel === b.environmentLabel &&
        a.threadId === b.threadId &&
        a.threadTitle === b.threadTitle;
}

function remoteChildrenEqual(
  left: ReadonlyArray<RemoteChildThread> | undefined,
  right: ReadonlyArray<RemoteChildThread> | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return (
    a.length === b.length &&
    a.every((child, index) => {
      const other = b[index]!;
      return (
        child.environmentId === other.environmentId &&
        child.threadId === other.threadId &&
        child.label === other.label &&
        child.title === other.title &&
        child.cachedStatus === other.cachedStatus &&
        child.updatedAt === other.updatedAt
      );
    })
  );
}

function localChildStartsEqual(
  left: ReadonlyArray<LocalChildStart> | undefined,
  right: ReadonlyArray<LocalChildStart> | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return (
    a.length === b.length &&
    a.every((child, index) => {
      const other = b[index]!;
      return (
        child.requestId === other.requestId &&
        child.childThreadId === other.childThreadId &&
        child.title === other.title
      );
    })
  );
}

function remoteChildStartsEqual(
  left: ReadonlyArray<RemoteChildStart> | undefined,
  right: ReadonlyArray<RemoteChildStart> | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return (
    a.length === b.length &&
    a.every((start, index) => {
      const other = b[index]!;
      return (
        start.requestId === other.requestId &&
        start.environmentId === other.environmentId &&
        start.label === other.label &&
        start.title === other.title &&
        start.status === other.status
      );
    })
  );
}

/**
 * A thread's move either way (docs/design/fleet.md, Part 3): leaving for a
 * linked computer, or arrived from one. Nulls are left out, so two copies of
 * the same thread compare alike.
 */
function threadMoves(thread: {
  readonly move?: OrchestrationThreadMove | null | undefined;
  readonly movedFrom?: ThreadMovedFrom | null | undefined;
}): Pick<ThreadShell, "move" | "movedFrom"> {
  return {
    ...(thread.move ? { move: thread.move } : {}),
    ...(thread.movedFrom ? { movedFrom: thread.movedFrom } : {}),
  };
}

function threadMovesEqual(
  left: OrchestrationThreadMove | null | undefined,
  right: OrchestrationThreadMove | null | undefined,
): boolean {
  const a = left ?? null;
  const b = right ?? null;
  return a === null || b === null
    ? a === b
    : a.transferId === b.transferId &&
        a.target.environmentId === b.target.environmentId &&
        a.target.label === b.target.label &&
        a.agent.instanceId === b.agent.instanceId &&
        a.agent.model === b.agent.model &&
        a.phase === b.phase &&
        a.sentBytes === b.sentBytes &&
        a.totalBytes === b.totalBytes &&
        a.cancelRequested === b.cancelRequested &&
        a.startedAt === b.startedAt &&
        a.movedAway?.threadId === b.movedAway?.threadId &&
        a.movedAway?.movedAt === b.movedAway?.movedAt;
}

function movedFromEqual(
  left: ThreadMovedFrom | null | undefined,
  right: ThreadMovedFrom | null | undefined,
): boolean {
  const a = left ?? null;
  const b = right ?? null;
  return a === null || b === null
    ? a === b
    : a.environmentId === b.environmentId &&
        a.label === b.label &&
        a.threadId === b.threadId &&
        a.movedAt === b.movedAt;
}

/** The child-thread fields a sidebar row reads, from a shell or a loaded thread. */
function sidebarLineage(
  thread: Pick<
    ThreadShell,
    | "parentThreadId"
    | "parentTurnId"
    | "attachedToParent"
    | "handedBackAt"
    | "handedBackTurnId"
    | "awaitedChildThreadCount"
    | "pendingChildApproval"
    | "queuedFollowUps"
    | "scheduledRun"
    | "outsideOrigin"
    | "remoteOrigin"
    | "remoteChildren"
    | "remoteChildStarts"
    | "localChildStarts"
    | "move"
  >,
): Pick<
  SidebarThreadSummary,
  | "parentThreadId"
  | "parentTurnId"
  | "attachedToParent"
  | "handedBackAt"
  | "handedBackTurnId"
  | "awaitedChildThreadCount"
  | "pendingChildApproval"
  | "queuedFollowUpCount"
  | "scheduledRun"
  | "outsideOrigin"
  | "remoteOrigin"
  | "remoteChildren"
  | "remoteChildStarts"
  | "localChildStarts"
  | "moveStatus"
> {
  const moveStatus = threadMoveStatus(thread.move);
  return {
    scheduledRun: thread.scheduledRun ?? null,
    outsideOrigin: thread.outsideOrigin ?? null,
    parentThreadId: thread.parentThreadId ?? null,
    parentTurnId: thread.parentTurnId ?? null,
    attachedToParent: thread.attachedToParent ?? false,
    handedBackAt: thread.handedBackAt ?? null,
    handedBackTurnId: thread.handedBackTurnId ?? null,
    awaitedChildThreadCount: thread.awaitedChildThreadCount ?? 0,
    pendingChildApproval: thread.pendingChildApproval ?? false,
    queuedFollowUpCount: thread.queuedFollowUps?.length ?? 0,
    ...remoteFamily(thread),
    ...(moveStatus !== undefined ? { moveStatus } : {}),
  };
}

function mapProposedPlan(proposedPlan: OrchestrationProposedPlan): ProposedPlan {
  return {
    id: proposedPlan.id,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
    dismissedAt: proposedPlan.dismissedAt,
    createdAt: proposedPlan.createdAt,
    ...(proposedPlan.eventSequence !== undefined
      ? { eventSequence: proposedPlan.eventSequence }
      : {}),
    updatedAt: proposedPlan.updatedAt,
  };
}

function mapTurnDiffSummary(checkpoint: OrchestrationCheckpointSummary): TurnDiffSummary {
  return {
    turnId: checkpoint.turnId,
    completedAt: checkpoint.completedAt,
    status: checkpoint.status,
    assistantMessageId: checkpoint.assistantMessageId ?? undefined,
    checkpointTurnCount: checkpoint.checkpointTurnCount,
    checkpointRef: checkpoint.checkpointRef,
    files: checkpoint.files.map((file) => ({ ...file })),
    ...(checkpoint.threadDiffStat !== undefined
      ? { threadDiffStat: { ...checkpoint.threadDiffStat } }
      : {}),
  };
}

function mapProject(
  project:
    | OrchestrationReadModel["projects"][number]
    | OrchestrationShellSnapshot["projects"][number],
  environmentId: EnvironmentId,
): Project {
  return {
    id: project.id,
    environmentId,
    kind: project.kind,
    name: project.title,
    cwd: project.workspaceRoot,
    repositoryIdentity: project.repositoryIdentity ?? null,
    defaultModelSelection: project.defaultModelSelection
      ? normalizeModelSelection(project.defaultModelSelection)
      : null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    scripts: mapProjectScripts(project.scripts),
  };
}

function mapThread(thread: OrchestrationThread, environmentId: EnvironmentId): Thread {
  return {
    id: thread.id,
    environmentId,
    codexThreadId:
      thread.session?.providerName === "codex" ? (thread.session.providerThreadId ?? null) : null,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: normalizeModelSelection(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    session: thread.session ? mapSession(thread.session) : null,
    messages: thread.messages.map((message) => mapMessage(environmentId, message)),
    proposedPlans: thread.proposedPlans.map(mapProposedPlan),
    pages: thread.pages ?? [],
    commandRequests: thread.commandRequests ?? [],
    commandRuns: thread.commandRuns ?? [],
    error: sanitizeThreadErrorMessage(thread.session?.lastError),
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    pullRequestAutoFix: thread.pullRequestAutoFix ?? false,
    pullRequestAutoMerge: thread.pullRequestAutoMerge ?? null,
    linkedPullRequests: thread.linkedPullRequests ?? [],
    ...dismissedPullRequestsField(thread.dismissedPullRequests),
    queuedFollowUps: thread.queuedFollowUps ?? [],
    participants: thread.participants ?? [],
    sideTurn: thread.sideTurn ?? null,
    ...(thread.agentRole !== undefined ? { agentRole: thread.agentRole } : {}),
    agentRequests: thread.agentRequests,
    childRequests: thread.childRequests,
    ...threadLineage(thread),
    ...childRequestCounts(thread),
    ...(thread.remoteOrigin ? { remoteOrigin: thread.remoteOrigin } : {}),
    ...threadMoves(thread),
    doneOverride: thread.doneOverride,
    lastSeenAt: thread.lastSeenAt,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    pendingSourceProposedPlan: thread.latestTurn?.sourceProposedPlan,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    effectiveCwd: effectiveCwdOf(thread).effectiveCwd,
    goal: thread.goal,
    ...(thread.checkBacks && thread.checkBacks.length > 0 ? { checkBacks: thread.checkBacks } : {}),
    voiceActive: thread.voiceActive ?? false,
    diffStatBaselineTurnCount: thread.diffStatBaselineTurnCount ?? 0,
    turnDiffSummaries: thread.checkpoints.map(mapTurnDiffSummary),
    activities: thread.activities.map((activity) => ({ ...activity })),
    subagents: thread.subagents ?? [],
    workflowRuns: thread.workflowRuns ?? [],
  };
}

function mapThreadShell(
  thread: OrchestrationThreadShell,
  environmentId: EnvironmentId,
): {
  shell: ThreadShell;
  session: ThreadSession | null;
  turnState: ThreadTurnState;
  summary: SidebarThreadSummary;
} {
  const shell: ThreadShell = {
    id: thread.id,
    environmentId,
    codexThreadId:
      thread.session?.providerName === "codex" ? (thread.session.providerThreadId ?? null) : null,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: normalizeModelSelection(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    error: sanitizeThreadErrorMessage(thread.session?.lastError),
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    pullRequestAutoFix: thread.pullRequestAutoFix ?? false,
    pullRequestAutoMerge: thread.pullRequestAutoMerge ?? null,
    linkedPullRequests: thread.linkedPullRequests ?? [],
    ...dismissedPullRequestsField(thread.dismissedPullRequests),
    queuedFollowUps: thread.queuedFollowUps ?? [],
    participants: thread.participants ?? [],
    sideTurn: thread.sideTurn ?? null,
    ...(thread.agentRole !== undefined ? { agentRole: thread.agentRole } : {}),
    ...threadLineage(thread),
    awaitedChildThreadCount: thread.awaitedChildThreadCount,
    pendingChildApproval: thread.pendingChildApproval,
    ...remoteFamily(thread),
    ...threadMoves(thread),
    doneOverride: thread.doneOverride,
    lastSeenAt: thread.lastSeenAt,
    updatedAt: thread.updatedAt,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    effectiveCwd: effectiveCwdOf(thread).effectiveCwd,
    goal: thread.goal,
    ...(thread.checkBacks && thread.checkBacks.length > 0 ? { checkBacks: thread.checkBacks } : {}),
    voiceActive: thread.voiceActive ?? false,
    diffStatBaselineTurnCount: thread.diffStatBaselineTurnCount ?? 0,
  };
  const session = thread.session ? mapSession(thread.session) : null;
  const turnState: ThreadTurnState = {
    latestTurn: thread.latestTurn,
    pendingSourceProposedPlan: thread.latestTurn?.sourceProposedPlan,
  };
  const summary: SidebarThreadSummary = {
    id: thread.id,
    environmentId,
    projectId: thread.projectId,
    title: thread.title,
    interactionMode: thread.interactionMode,
    session,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    doneOverride: thread.doneOverride,
    lastSeenAt: thread.lastSeenAt,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    effectiveCwd: effectiveCwdOf(thread).effectiveCwd,
    latestUserMessageAt: thread.latestUserMessageAt,
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
    hasBlockingUserInput: thread.hasBlockingUserInput ?? thread.hasPendingUserInput,
    ...(thread.checkBacks && thread.checkBacks.length > 0 ? { checkBacks: thread.checkBacks } : {}),
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
    cumulativeDiffStat: thread.cumulativeDiffStat,
    linkedPullRequests: thread.linkedPullRequests ?? [],
    participants: thread.participants ?? [],
    sideTurn: thread.sideTurn ?? null,
    ...(thread.agentRole !== undefined ? { agentRole: thread.agentRole } : {}),
    roomSlotModelSelection: roomSlotModelSelection(thread),
    roomSlotRole: roomSlotRole(thread),
    roomSideModelSelection: roomSideModelSelection(thread),
    roomSideRole: roomSideRole(thread),
    ...sidebarLineage(shell),
  };
  return {
    shell,
    session,
    turnState,
    summary,
  };
}

function toThreadShell(thread: Thread): ThreadShell {
  return {
    id: thread.id,
    environmentId: thread.environmentId,
    codexThreadId: thread.codexThreadId,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    error: thread.error,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    pullRequestAutoFix: thread.pullRequestAutoFix ?? false,
    pullRequestAutoMerge: thread.pullRequestAutoMerge ?? null,
    linkedPullRequests: thread.linkedPullRequests ?? [],
    ...dismissedPullRequestsField(thread.dismissedPullRequests),
    queuedFollowUps: thread.queuedFollowUps ?? [],
    participants: thread.participants ?? [],
    sideTurn: thread.sideTurn ?? null,
    ...(thread.agentRole !== undefined ? { agentRole: thread.agentRole } : {}),
    ...threadLineage(thread),
    ...childRequestCounts(thread),
    ...remoteFamily(thread),
    ...threadMoves(thread),
    doneOverride: thread.doneOverride,
    lastSeenAt: thread.lastSeenAt,
    updatedAt: thread.updatedAt,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    effectiveCwd: effectiveCwdOf(thread).effectiveCwd,
    goal: thread.goal,
    ...(thread.checkBacks && thread.checkBacks.length > 0 ? { checkBacks: thread.checkBacks } : {}),
    voiceActive: thread.voiceActive ?? false,
    diffStatBaselineTurnCount: thread.diffStatBaselineTurnCount ?? 0,
  };
}

function toThreadTurnState(thread: Thread): ThreadTurnState {
  return {
    latestTurn: thread.latestTurn,
    ...(thread.pendingSourceProposedPlan
      ? { pendingSourceProposedPlan: thread.pendingSourceProposedPlan }
      : {}),
  };
}

function latestIso(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left.localeCompare(right) >= 0 ? left : right;
}

/**
 * When the latest message a person wrote was sent, in transcript order. One
 * pass, remembered per messages list: a summary is rebuilt on every streamed
 * event, and a reply streaming leaves the list's user messages as they were.
 */
const latestUserWrittenMessageAt = keyedMemo((messages: Thread["messages"]): string | null => {
  let latest: ChatMessage | undefined;
  for (const message of messages) {
    if (
      isUserWrittenMessage(message) &&
      (latest === undefined || compareTranscriptOrder(message, latest) >= 0)
    ) {
      latest = message;
    }
  }
  return latest?.createdAt ?? null;
});

/** The prompts a thread's activities leave open, derived once per activities list. */
const openPromptsOf = keyedMemo((activities: Thread["activities"]) => {
  const pendingUserInputs = derivePendingUserInputs(activities);
  return {
    hasPendingApprovals: derivePendingApprovals(activities).length > 0,
    hasPendingUserInput: pendingUserInputs.length > 0,
    hasBlockingUserInput: pendingUserInputs.some(isBlockingUserInput),
  };
});

function toSidebarThreadSummary(
  thread: Thread,
  previous: SidebarThreadSummary | undefined,
): SidebarThreadSummary {
  const latestUserMessageAt = latestIso(
    previous?.latestUserMessageAt ?? null,
    latestUserWrittenMessageAt(thread.messages),
  );
  const latestProposedPlan = findLatestProposedPlan(
    thread.proposedPlans,
    thread.latestTurn?.turnId ?? null,
  );
  const hasActivityEvidence = thread.activities.length > 0;
  const openPrompts = hasActivityEvidence ? openPromptsOf(thread.activities) : null;
  const hasProposedPlanEvidence = thread.proposedPlans.length > 0;
  // The detail stream carries per-turn summaries, not the server's rollup, so
  // the open thread recomputes it rather than going stale behind the sidebar.
  const hasTurnDiffEvidence = thread.turnDiffSummaries.length > 0;

  return {
    id: thread.id,
    environmentId: thread.environmentId,
    projectId: thread.projectId,
    title: thread.title,
    interactionMode: thread.interactionMode,
    session: thread.session,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    doneOverride: thread.doneOverride,
    lastSeenAt: thread.lastSeenAt,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    effectiveCwd: effectiveCwdOf(thread).effectiveCwd,
    latestUserMessageAt,
    hasPendingApprovals: openPrompts
      ? openPrompts.hasPendingApprovals
      : (previous?.hasPendingApprovals ?? false),
    // An agent's invite waiting for the user needs them the same way.
    hasPendingUserInput:
      (openPrompts ? openPrompts.hasPendingUserInput : (previous?.hasPendingUserInput ?? false)) ||
      (thread.agentRequests !== undefined && awaitingInvite(thread.agentRequests) !== undefined),
    hasBlockingUserInput: openPrompts
      ? openPrompts.hasBlockingUserInput
      : (previous?.hasBlockingUserInput ?? previous?.hasPendingUserInput ?? false),
    ...(thread.checkBacks && thread.checkBacks.length > 0 ? { checkBacks: thread.checkBacks } : {}),
    hasActionableProposedPlan: hasProposedPlanEvidence
      ? hasActionableProposedPlan(latestProposedPlan)
      : (previous?.hasActionableProposedPlan ?? false),
    cumulativeDiffStat: hasTurnDiffEvidence
      ? sumTurnDiffStats(thread.turnDiffSummaries, thread.diffStatBaselineTurnCount ?? 0)
      : (previous?.cumulativeDiffStat ?? null),
    linkedPullRequests: thread.linkedPullRequests ?? [],
    participants: thread.participants ?? [],
    sideTurn: thread.sideTurn ?? null,
    ...(thread.agentRole !== undefined ? { agentRole: thread.agentRole } : {}),
    roomSlotModelSelection: roomSlotModelSelection(thread),
    roomSlotRole: roomSlotRole(thread),
    roomSideModelSelection: roomSideModelSelection(thread),
    roomSideRole: roomSideRole(thread),
    ...sidebarLineage({
      ...threadLineage(thread),
      ...childRequestCounts(thread),
      ...remoteFamily(thread),
      ...threadMoves(thread),
      queuedFollowUps: thread.queuedFollowUps ?? [],
    }),
  };
}

function sourceProposedPlansEqual(
  left: OrchestrationLatestTurn["sourceProposedPlan"] | undefined,
  right: OrchestrationLatestTurn["sourceProposedPlan"] | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return left.threadId === right.threadId && left.planId === right.planId;
}

function latestTurnsEqual(
  left: OrchestrationLatestTurn | null | undefined,
  right: OrchestrationLatestTurn | null | undefined,
): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  return (
    left.turnId === right.turnId &&
    left.state === right.state &&
    left.requestedAt === right.requestedAt &&
    left.startedAt === right.startedAt &&
    left.completedAt === right.completedAt &&
    left.assistantMessageId === right.assistantMessageId &&
    sourceProposedPlansEqual(left.sourceProposedPlan, right.sourceProposedPlan)
  );
}

function threadSessionsEqual(
  left: ThreadSession | null | undefined,
  right: ThreadSession | null | undefined,
): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  // The background-task fields count too: two updates can share a timestamp
  // (a task relisted as an agent in the same millisecond), and the second
  // must not be dropped as a repeat of the first.
  return (
    left.provider === right.provider &&
    left.status === right.status &&
    left.orchestrationStatus === right.orchestrationStatus &&
    left.activeTurnId === right.activeTurnId &&
    left.participantId === right.participantId &&
    left.launchingInstanceId === right.launchingInstanceId &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.lastError === right.lastError &&
    left.pendingBackgroundTaskCount === right.pendingBackgroundTaskCount &&
    left.awaitedBackgroundTaskCount === right.awaitedBackgroundTaskCount &&
    sameAwaitedBackgroundTasks(left.awaitedBackgroundTasks, right.awaitedBackgroundTasks)
  );
}

export function doneOverridesEqual(
  left: SidebarThreadSummary["doneOverride"],
  right: SidebarThreadSummary["doneOverride"],
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.state === right.state && left.at === right.at;
}

function threadDiffStatsEqual(
  left: SidebarThreadSummary["cumulativeDiffStat"],
  right: SidebarThreadSummary["cumulativeDiffStat"],
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.additions === right.additions && left.deletions === right.deletions;
}

/** Absent when none, so a thread with none carries no field. */
function dismissedPullRequestsField(
  dismissed: readonly number[] | undefined,
): Pick<ThreadShell, "dismissedPullRequests"> {
  return dismissed && dismissed.length > 0 ? { dismissedPullRequests: dismissed } : {};
}

function dismissedPullRequestsEqual(
  left: readonly number[] | undefined,
  right: readonly number[] | undefined,
): boolean {
  const leftList = left ?? [];
  const rightList = right ?? [];
  return (
    leftList.length === rightList.length &&
    leftList.every((number, index) => number === rightList[index])
  );
}

function linkedPullRequestsEqual(
  left: SidebarThreadSummary["linkedPullRequests"],
  right: SidebarThreadSummary["linkedPullRequests"],
): boolean {
  const leftList = left ?? [];
  const rightList = right ?? [];
  return (
    leftList.length === rightList.length &&
    leftList.every((linked, index) => {
      const other = rightList[index];
      return (
        other !== undefined &&
        linked.number === other.number &&
        linked.url === other.url &&
        linked.autoFix === other.autoFix &&
        linked.autoMerge === other.autoMerge
      );
    })
  );
}

/** Queue entries never change in place, so their ids decide equality. */
function queuedFollowUpsEqual(
  left: ThreadShell["queuedFollowUps"],
  right: ThreadShell["queuedFollowUps"],
): boolean {
  const leftList = left ?? [];
  const rightList = right ?? [];
  return (
    leftList.length === rightList.length &&
    leftList.every((queued, index) => queued.messageId === rightList[index]?.messageId)
  );
}

/** Whether two participant lists say the same about every agent, by what the chat shows of them. */
function participantsEqual(
  left: ThreadShell["participants"],
  right: ThreadShell["participants"],
): boolean {
  const leftList = left ?? [];
  const rightList = right ?? [];
  return (
    leftList.length === rightList.length &&
    leftList.every((participant, index) => {
      const other = rightList[index];
      return (
        other !== undefined &&
        participant.id === other.id &&
        participant.handle === other.handle &&
        participant.leftAt === other.leftAt &&
        participant.role === other.role &&
        participant.modelSelection.instanceId === other.modelSelection.instanceId &&
        participant.modelSelection.model === other.modelSelection.model &&
        JSON.stringify(participant.modelSelection.options ?? []) ===
          JSON.stringify(other.modelSelection.options ?? [])
      );
    })
  );
}

/** The summary with whether a scheduled-task card waits for the user in its thread. */
function withScheduleApproval(
  state: EnvironmentState,
  summary: SidebarThreadSummary,
): SidebarThreadSummary {
  const pending = state.scheduleApprovalThreadIds?.[summary.id] === true;
  return (summary.pendingScheduleApproval ?? false) === pending
    ? summary
    : { ...summary, pendingScheduleApproval: pending };
}

function sidebarThreadSummariesEqual(
  left: SidebarThreadSummary | undefined,
  right: SidebarThreadSummary,
): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.title === right.title &&
    left.interactionMode === right.interactionMode &&
    threadSessionsEqual(left.session, right.session) &&
    left.createdAt === right.createdAt &&
    left.archivedAt === right.archivedAt &&
    left.pinnedAt === right.pinnedAt &&
    doneOverridesEqual(left.doneOverride, right.doneOverride) &&
    left.lastSeenAt === right.lastSeenAt &&
    left.updatedAt === right.updatedAt &&
    latestTurnsEqual(left.latestTurn, right.latestTurn) &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.effectiveCwd === right.effectiveCwd &&
    left.latestUserMessageAt === right.latestUserMessageAt &&
    left.hasPendingApprovals === right.hasPendingApprovals &&
    left.hasPendingUserInput === right.hasPendingUserInput &&
    left.hasBlockingUserInput === right.hasBlockingUserInput &&
    left.hasActionableProposedPlan === right.hasActionableProposedPlan &&
    threadDiffStatsEqual(left.cumulativeDiffStat, right.cumulativeDiffStat) &&
    linkedPullRequestsEqual(left.linkedPullRequests, right.linkedPullRequests) &&
    participantsEqual(left.participants, right.participants) &&
    sideTurnsEqual(left.sideTurn, right.sideTurn) &&
    (left.roomSlotModelSelection?.instanceId ?? null) ===
      (right.roomSlotModelSelection?.instanceId ?? null) &&
    (left.roomSlotModelSelection?.model ?? null) ===
      (right.roomSlotModelSelection?.model ?? null) &&
    (left.roomSideModelSelection?.instanceId ?? null) ===
      (right.roomSideModelSelection?.instanceId ?? null) &&
    (left.roomSideModelSelection?.model ?? null) ===
      (right.roomSideModelSelection?.model ?? null) &&
    (left.agentRole ?? null) === (right.agentRole ?? null) &&
    (left.roomSlotRole ?? null) === (right.roomSlotRole ?? null) &&
    (left.roomSideRole ?? null) === (right.roomSideRole ?? null) &&
    (left.parentThreadId ?? null) === (right.parentThreadId ?? null) &&
    (left.parentTurnId ?? null) === (right.parentTurnId ?? null) &&
    (left.attachedToParent ?? false) === (right.attachedToParent ?? false) &&
    (left.handedBackAt ?? null) === (right.handedBackAt ?? null) &&
    (left.handedBackTurnId ?? null) === (right.handedBackTurnId ?? null) &&
    (left.awaitedChildThreadCount ?? 0) === (right.awaitedChildThreadCount ?? 0) &&
    checkBackListsEqual(left.checkBacks, right.checkBacks) &&
    (left.pendingChildApproval ?? false) === (right.pendingChildApproval ?? false) &&
    (left.pendingScheduleApproval ?? false) === (right.pendingScheduleApproval ?? false) &&
    (left.queuedFollowUpCount ?? 0) === (right.queuedFollowUpCount ?? 0) &&
    scheduledRunsEqual(left.scheduledRun, right.scheduledRun) &&
    outsideOriginsEqual(left.outsideOrigin, right.outsideOrigin) &&
    remoteOriginsEqual(left.remoteOrigin, right.remoteOrigin) &&
    remoteChildrenEqual(left.remoteChildren, right.remoteChildren) &&
    remoteChildStartsEqual(left.remoteChildStarts, right.remoteChildStarts) &&
    localChildStartsEqual(left.localChildStarts, right.localChildStarts) &&
    left.moveStatus === right.moveStatus
  );
}

function scheduledRunsEqual(
  left: ThreadScheduledRun | null | undefined,
  right: ThreadScheduledRun | null | undefined,
): boolean {
  const a = left ?? null;
  const b = right ?? null;
  return a === null || b === null
    ? a === b
    : a.taskId === b.taskId &&
        a.taskName === b.taskName &&
        a.slotUtc === b.slotUtc &&
        (a.event ?? false) === (b.event ?? false);
}

function outsideOriginsEqual(
  left: OutsideAgentRef | null | undefined,
  right: OutsideAgentRef | null | undefined,
): boolean {
  const a = left ?? null;
  const b = right ?? null;
  return a === null || b === null
    ? a === b
    : a.connectionId === b.connectionId && a.name === b.name;
}

function sideTurnsEqual(
  left: OrchestrationSideTurn | null | undefined,
  right: OrchestrationSideTurn | null | undefined,
): boolean {
  const a = left ?? null;
  const b = right ?? null;
  return a === null || b === null
    ? a === b
    : a.sideTurnId === b.sideTurnId &&
        a.status === b.status &&
        a.participantId === b.participantId &&
        a.kind === b.kind &&
        a.askedBy?.participantId === b.askedBy?.participantId &&
        a.requestId === b.requestId;
}

/**
 * A changed shell, keeping the participants it had while they are the same.
 * The server pushes a whole shell again on every update a streaming turn
 * makes, and what the chat builds from the participants (agent names and
 * labels) should keep its identity across them.
 */
function withKeptParticipants(previous: ThreadShell | undefined, next: ThreadShell): ThreadShell {
  const kept = previous?.participants;
  return kept !== undefined &&
    kept !== next.participants &&
    participantsEqual(kept, next.participants)
    ? { ...next, participants: kept }
    : next;
}

function threadShellsEqual(left: ThreadShell | undefined, right: ThreadShell): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.environmentId === right.environmentId &&
    left.codexThreadId === right.codexThreadId &&
    left.projectId === right.projectId &&
    left.title === right.title &&
    left.modelSelection === right.modelSelection &&
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode &&
    left.error === right.error &&
    left.createdAt === right.createdAt &&
    left.archivedAt === right.archivedAt &&
    left.pinnedAt === right.pinnedAt &&
    left.pullRequestAutoFix === right.pullRequestAutoFix &&
    left.pullRequestAutoMerge === right.pullRequestAutoMerge &&
    linkedPullRequestsEqual(left.linkedPullRequests, right.linkedPullRequests) &&
    dismissedPullRequestsEqual(left.dismissedPullRequests, right.dismissedPullRequests) &&
    queuedFollowUpsEqual(left.queuedFollowUps, right.queuedFollowUps) &&
    participantsEqual(left.participants, right.participants) &&
    sideTurnsEqual(left.sideTurn, right.sideTurn) &&
    (left.agentRole ?? null) === (right.agentRole ?? null) &&
    (left.parentThreadId ?? null) === (right.parentThreadId ?? null) &&
    (left.parentTurnId ?? null) === (right.parentTurnId ?? null) &&
    (left.attachedToParent ?? false) === (right.attachedToParent ?? false) &&
    (left.handedBackAt ?? null) === (right.handedBackAt ?? null) &&
    (left.handedBackTurnId ?? null) === (right.handedBackTurnId ?? null) &&
    (left.awaitedChildThreadCount ?? 0) === (right.awaitedChildThreadCount ?? 0) &&
    (left.pendingChildApproval ?? false) === (right.pendingChildApproval ?? false) &&
    scheduledRunsEqual(left.scheduledRun, right.scheduledRun) &&
    outsideOriginsEqual(left.outsideOrigin, right.outsideOrigin) &&
    remoteOriginsEqual(left.remoteOrigin, right.remoteOrigin) &&
    remoteChildrenEqual(left.remoteChildren, right.remoteChildren) &&
    remoteChildStartsEqual(left.remoteChildStarts, right.remoteChildStarts) &&
    localChildStartsEqual(left.localChildStarts, right.localChildStarts) &&
    threadMovesEqual(left.move, right.move) &&
    movedFromEqual(left.movedFrom, right.movedFrom) &&
    doneOverridesEqual(left.doneOverride, right.doneOverride) &&
    left.lastSeenAt === right.lastSeenAt &&
    left.updatedAt === right.updatedAt &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.effectiveCwd === right.effectiveCwd &&
    left.voiceActive === right.voiceActive &&
    left.diffStatBaselineTurnCount === right.diffStatBaselineTurnCount &&
    threadGoalsEqual(left.goal, right.goal) &&
    checkBackListsEqual(left.checkBacks, right.checkBacks)
  );
}

function checkBackListsEqual(
  left: ReadonlyArray<OrchestrationCheckBack> | undefined,
  right: ReadonlyArray<OrchestrationCheckBack> | undefined,
): boolean {
  const leftList = left ?? [];
  const rightList = right ?? [];
  return (
    sameCheckBacks(leftList, rightList) &&
    leftList.every(
      (checkBack, index) => checkBack.participantId === rightList[index]?.participantId,
    )
  );
}

function threadGoalsEqual(
  left: OrchestrationThreadGoal | null,
  right: OrchestrationThreadGoal | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null) {
    return false;
  }
  return (
    left.objective === right.objective &&
    left.status === right.status &&
    left.tokenBudget === right.tokenBudget &&
    left.tokensUsed === right.tokensUsed &&
    left.timeUsedSeconds === right.timeUsedSeconds &&
    left.updatedAt === right.updatedAt &&
    left.checks === right.checks &&
    left.lastCheck === right.lastCheck
  );
}

function threadTurnStatesEqual(left: ThreadTurnState | undefined, right: ThreadTurnState): boolean {
  return (
    left !== undefined &&
    latestTurnsEqual(left.latestTurn, right.latestTurn) &&
    sourceProposedPlansEqual(left.pendingSourceProposedPlan, right.pendingSourceProposedPlan)
  );
}

function appendId<T extends string>(ids: readonly T[], id: T): T[] {
  return ids.includes(id) ? [...ids] : [...ids, id];
}

function removeId<T extends string>(ids: readonly T[], id: T): T[] {
  return ids.filter((value) => value !== id);
}

function buildProposedPlanSlice(thread: Thread): {
  ids: string[];
  byId: Record<string, ProposedPlan>;
} {
  return {
    ids: thread.proposedPlans.map((plan) => plan.id),
    byId: Object.fromEntries(
      thread.proposedPlans.map((plan) => [plan.id, plan] as const),
    ) as Record<string, ProposedPlan>,
  };
}

function buildTurnDiffSlice(thread: Thread): {
  ids: TurnId[];
  byId: Record<TurnId, TurnDiffSummary>;
} {
  return {
    ids: thread.turnDiffSummaries.map((summary) => summary.turnId),
    byId: Object.fromEntries(
      thread.turnDiffSummaries.map((summary) => [summary.turnId, summary] as const),
    ) as Record<TurnId, TurnDiffSummary>,
  };
}

function getProjects(state: EnvironmentState): Project[] {
  return state.projectIds.flatMap((projectId) => {
    const project = state.projectById[projectId];
    return project ? [project] : [];
  });
}

function getThreads(state: EnvironmentState): Thread[] {
  return state.threadIds.flatMap((threadId) => {
    const thread = getThreadFromEnvironmentState(state, threadId);
    return thread ? [thread] : [];
  });
}

/**
 * Ensure a thread is registered in the bookkeeping indices (threadIds,
 * threadIdsByProjectId).  Shared by both the shell stream and detail stream
 * write paths — the bookkeeping is additive (append-only IDs) so concurrent
 * writes from both streams are safe.
 */
function ensureThreadRegistered(
  state: EnvironmentState,
  threadId: ThreadId,
  nextProjectId: ProjectId,
  previousProjectId: ProjectId | undefined,
): EnvironmentState {
  let nextState = state;

  if (!state.threadIds.includes(threadId)) {
    nextState = {
      ...nextState,
      threadIds: [...nextState.threadIds, threadId],
    };
  }

  if (previousProjectId !== nextProjectId) {
    let threadIdsByProjectId = nextState.threadIdsByProjectId;
    if (previousProjectId) {
      const previousIds = threadIdsByProjectId[previousProjectId] ?? EMPTY_THREAD_IDS;
      const nextIds = removeId(previousIds, threadId);
      if (nextIds.length === 0) {
        const { [previousProjectId]: _removed, ...rest } = threadIdsByProjectId;
        threadIdsByProjectId = rest as Record<ProjectId, ThreadId[]>;
      } else if (!arraysEqual(previousIds, nextIds)) {
        threadIdsByProjectId = {
          ...threadIdsByProjectId,
          [previousProjectId]: nextIds,
        };
      }
    }
    const projectThreadIds = threadIdsByProjectId[nextProjectId] ?? EMPTY_THREAD_IDS;
    const nextProjectThreadIds = appendId(projectThreadIds, threadId);
    if (!arraysEqual(projectThreadIds, nextProjectThreadIds)) {
      threadIdsByProjectId = {
        ...threadIdsByProjectId,
        [nextProjectId]: nextProjectThreadIds,
      };
    }
    if (threadIdsByProjectId !== nextState.threadIdsByProjectId) {
      nextState = {
        ...nextState,
        threadIdsByProjectId,
      };
    }
  }

  return nextState;
}

/**
 * Write thread state from the **detail stream** (per-thread subscription).
 *
 * Owns: messages, activities, proposed plans, turn diff summaries.
 * Also writes threadShellById / threadSessionById / threadTurnStateById so
 * the active thread has up-to-date state even if the shell stream event
 * hasn't arrived yet (both streams use structural equality checks to avoid
 * unnecessary re-renders when delivering equivalent data).
 * In practice the detail stream also writes a provisional sidebar summary; the
 * shell stream remains authoritative when it arrives.
 */
function writeThreadState(
  state: EnvironmentState,
  nextThread: Thread,
  previousThread?: Thread,
): EnvironmentState {
  const nextShell = toThreadShell(nextThread);
  const nextTurnState = toThreadTurnState(nextThread);
  const nextSummary = withScheduleApproval(
    state,
    toSidebarThreadSummary(nextThread, state.sidebarThreadSummaryById[nextThread.id]),
  );
  const previousShell = state.threadShellById[nextThread.id];
  const previousTurnState = state.threadTurnStateById[nextThread.id];

  let nextState = ensureThreadRegistered(
    state,
    nextThread.id,
    nextThread.projectId,
    previousThread?.projectId,
  );

  if (!threadShellsEqual(previousShell, nextShell)) {
    nextState = {
      ...nextState,
      threadShellById: {
        ...nextState.threadShellById,
        [nextThread.id]: withKeptParticipants(previousShell, nextShell),
      },
    };
  }

  if (!threadSessionsEqual(previousThread?.session ?? null, nextThread.session)) {
    nextState = {
      ...nextState,
      threadSessionById: {
        ...nextState.threadSessionById,
        [nextThread.id]: nextThread.session,
      },
    };
  }

  if (!threadTurnStatesEqual(previousTurnState, nextTurnState)) {
    nextState = {
      ...nextState,
      threadTurnStateById: {
        ...nextState.threadTurnStateById,
        [nextThread.id]: nextTurnState,
      },
    };
  }

  if (!sidebarThreadSummariesEqual(state.sidebarThreadSummaryById[nextThread.id], nextSummary)) {
    nextState = {
      ...nextState,
      sidebarThreadSummaryById: {
        ...nextState.sidebarThreadSummaryById,
        [nextThread.id]: nextSummary,
      },
    };
  }

  if (previousThread?.messages !== nextThread.messages) {
    nextState = {
      ...nextState,
      messagesByThreadId: {
        ...nextState.messagesByThreadId,
        [nextThread.id]: nextThread.messages,
      },
    };
  }

  if (previousThread?.activities !== nextThread.activities) {
    nextState = {
      ...nextState,
      activitiesByThreadId: {
        ...nextState.activitiesByThreadId,
        [nextThread.id]: nextThread.activities,
      },
    };
  }

  if (previousThread?.proposedPlans !== nextThread.proposedPlans) {
    const nextProposedPlanSlice = buildProposedPlanSlice(nextThread);
    nextState = {
      ...nextState,
      proposedPlanIdsByThreadId: {
        ...nextState.proposedPlanIdsByThreadId,
        [nextThread.id]: nextProposedPlanSlice.ids,
      },
      proposedPlanByThreadId: {
        ...nextState.proposedPlanByThreadId,
        [nextThread.id]: nextProposedPlanSlice.byId,
      },
    };
  }

  if (nextThread.pages !== undefined && previousThread?.pages !== nextThread.pages) {
    nextState = {
      ...nextState,
      pagesByThreadId: {
        ...nextState.pagesByThreadId,
        [nextThread.id]: nextThread.pages,
      },
    };
  }

  if (
    nextThread.workflowRuns !== undefined &&
    previousThread?.workflowRuns !== nextThread.workflowRuns
  ) {
    nextState = {
      ...nextState,
      workflowRunsByThreadId: {
        ...nextState.workflowRunsByThreadId,
        [nextThread.id]: nextThread.workflowRuns,
      },
    };
  }

  if (nextThread.subagents !== undefined && previousThread?.subagents !== nextThread.subagents) {
    nextState = {
      ...nextState,
      subagentsByThreadId: {
        ...nextState.subagentsByThreadId,
        [nextThread.id]: nextThread.subagents,
      },
    };
  }

  if (
    nextThread.commandRequests !== undefined &&
    previousThread?.commandRequests !== nextThread.commandRequests
  ) {
    nextState = {
      ...nextState,
      commandRequestsByThreadId: {
        ...nextState.commandRequestsByThreadId,
        [nextThread.id]: nextThread.commandRequests,
      },
    };
  }

  if (
    nextThread.commandRuns !== undefined &&
    previousThread?.commandRuns !== nextThread.commandRuns
  ) {
    nextState = {
      ...nextState,
      commandRunsByThreadId: {
        ...nextState.commandRunsByThreadId,
        [nextThread.id]: nextThread.commandRuns,
      },
    };
  }

  if (
    nextThread.agentRequests !== undefined &&
    previousThread?.agentRequests !== nextThread.agentRequests
  ) {
    nextState = {
      ...nextState,
      agentRequestsByThreadId: {
        ...nextState.agentRequestsByThreadId,
        [nextThread.id]: nextThread.agentRequests,
      },
    };
  }

  if (
    nextThread.childRequests !== undefined &&
    previousThread?.childRequests !== nextThread.childRequests
  ) {
    nextState = {
      ...nextState,
      childRequestsByThreadId: {
        ...nextState.childRequestsByThreadId,
        [nextThread.id]: nextThread.childRequests,
      },
    };
  }

  if (previousThread?.turnDiffSummaries !== nextThread.turnDiffSummaries) {
    const nextTurnDiffSlice = buildTurnDiffSlice(nextThread);
    nextState = {
      ...nextState,
      turnDiffIdsByThreadId: {
        ...nextState.turnDiffIdsByThreadId,
        [nextThread.id]: nextTurnDiffSlice.ids,
      },
      turnDiffSummaryByThreadId: {
        ...nextState.turnDiffSummaryByThreadId,
        [nextThread.id]: nextTurnDiffSlice.byId,
      },
    };
  }

  return nextState;
}

/**
 * Write thread state from the **shell stream** (all-threads subscription).
 *
 * Owns: sidebarThreadSummaryById (pre-computed server-side sidebar data).
 * Also writes threadShellById / threadSessionById / threadTurnStateById as
 * the authoritative source for these fields.  The detail stream may also
 * write them for the focused thread (see writeThreadState); structural
 * equality checks prevent unnecessary re-renders.
 * Does NOT write message/activity/proposedPlan/turnDiff content — that is
 * detail-stream-only.
 */
function writeThreadShellState(
  state: EnvironmentState,
  nextThread: {
    shell: ThreadShell;
    session: ThreadSession | null;
    turnState: ThreadTurnState;
    summary: SidebarThreadSummary;
  },
): EnvironmentState {
  const previousShell = state.threadShellById[nextThread.shell.id];

  let nextState = ensureThreadRegistered(
    state,
    nextThread.shell.id,
    nextThread.shell.projectId,
    previousShell?.projectId,
  );

  if (!threadShellsEqual(previousShell, nextThread.shell)) {
    nextState = {
      ...nextState,
      threadShellById: {
        ...nextState.threadShellById,
        [nextThread.shell.id]: withKeptParticipants(previousShell, nextThread.shell),
      },
    };
  }

  if (
    !threadSessionsEqual(state.threadSessionById[nextThread.shell.id] ?? null, nextThread.session)
  ) {
    nextState = {
      ...nextState,
      threadSessionById: {
        ...nextState.threadSessionById,
        [nextThread.shell.id]: nextThread.session,
      },
    };
  }

  if (
    !threadTurnStatesEqual(state.threadTurnStateById[nextThread.shell.id], nextThread.turnState)
  ) {
    nextState = {
      ...nextState,
      threadTurnStateById: {
        ...nextState.threadTurnStateById,
        [nextThread.shell.id]: nextThread.turnState,
      },
    };
  }

  const nextSummary = withScheduleApproval(state, nextThread.summary);
  if (
    !sidebarThreadSummariesEqual(state.sidebarThreadSummaryById[nextThread.shell.id], nextSummary)
  ) {
    nextState = {
      ...nextState,
      sidebarThreadSummaryById: {
        ...nextState.sidebarThreadSummaryById,
        [nextThread.shell.id]: nextSummary,
      },
    };
  }

  return nextState;
}

function retainThreadScopedRecord<T>(
  record: Record<ThreadId, T>,
  nextThreadIds: ReadonlySet<ThreadId>,
): Record<ThreadId, T> {
  return Object.fromEntries(
    Object.entries(record).flatMap(([threadId, value]) =>
      nextThreadIds.has(threadId as ThreadId) ? [[threadId, value] as const] : [],
    ),
  ) as Record<ThreadId, T>;
}

function removeThreadState(state: EnvironmentState, threadId: ThreadId): EnvironmentState {
  const shell = state.threadShellById[threadId];
  if (!shell) {
    return state;
  }

  const nextThreadIds = removeId(state.threadIds, threadId);
  const currentProjectThreadIds = state.threadIdsByProjectId[shell.projectId] ?? EMPTY_THREAD_IDS;
  const nextProjectThreadIds = removeId(currentProjectThreadIds, threadId);
  const nextThreadIdsByProjectId =
    nextProjectThreadIds.length === 0
      ? (() => {
          const { [shell.projectId]: _removed, ...rest } = state.threadIdsByProjectId;
          return rest as Record<ProjectId, ThreadId[]>;
        })()
      : {
          ...state.threadIdsByProjectId,
          [shell.projectId]: nextProjectThreadIds,
        };

  const { [threadId]: _removedShell, ...threadShellById } = state.threadShellById;
  const { [threadId]: _removedSession, ...threadSessionById } = state.threadSessionById;
  const { [threadId]: _removedTurnState, ...threadTurnStateById } = state.threadTurnStateById;
  const { [threadId]: _removedMessages, ...messagesByThreadId } = state.messagesByThreadId;
  const { [threadId]: _removedActivities, ...activitiesByThreadId } = state.activitiesByThreadId;
  const { [threadId]: _removedPlanIds, ...proposedPlanIdsByThreadId } =
    state.proposedPlanIdsByThreadId;
  const { [threadId]: _removedPlans, ...proposedPlanByThreadId } = state.proposedPlanByThreadId;
  const { [threadId]: _removedTurnDiffIds, ...turnDiffIdsByThreadId } = state.turnDiffIdsByThreadId;
  const { [threadId]: _removedTurnDiffs, ...turnDiffSummaryByThreadId } =
    state.turnDiffSummaryByThreadId;
  const { [threadId]: _removedAgentRequests, ...agentRequestsByThreadId } =
    state.agentRequestsByThreadId;
  const { [threadId]: _removedPages, ...pagesByThreadId } = state.pagesByThreadId ?? {};
  const { [threadId]: _removedWorkflowRuns, ...workflowRunsByThreadId } =
    state.workflowRunsByThreadId ?? {};
  const { [threadId]: _removedSubagents, ...subagentsByThreadId } = state.subagentsByThreadId ?? {};
  const { [threadId]: _removedCommandRequests, ...commandRequestsByThreadId } =
    state.commandRequestsByThreadId ?? {};
  const { [threadId]: _removedCommandRuns, ...commandRunsByThreadId } =
    state.commandRunsByThreadId ?? {};
  const { [threadId]: _removedDetailLoaded, ...threadDetailLoadedById } =
    state.threadDetailLoadedById ?? {};
  const { [threadId]: _removedChildRequests, ...childRequestsByThreadId } =
    state.childRequestsByThreadId;
  const { [threadId]: _removedSidebarSummary, ...sidebarThreadSummaryById } =
    state.sidebarThreadSummaryById;

  return {
    ...state,
    threadIds: nextThreadIds,
    threadIdsByProjectId: nextThreadIdsByProjectId,
    threadShellById,
    threadSessionById,
    threadTurnStateById,
    messagesByThreadId,
    activitiesByThreadId,
    proposedPlanIdsByThreadId,
    proposedPlanByThreadId,
    turnDiffIdsByThreadId,
    turnDiffSummaryByThreadId,
    agentRequestsByThreadId,
    pagesByThreadId,
    workflowRunsByThreadId,
    subagentsByThreadId,
    commandRequestsByThreadId,
    commandRunsByThreadId,
    threadDetailLoadedById,
    childRequestsByThreadId,
    sidebarThreadSummaryById,
  };
}

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") {
    return "error" as const;
  }
  if (status === "missing") {
    return "interrupted" as const;
  }
  return "completed" as const;
}

function turnDiffEventCompletesTurn(
  thread: Pick<Thread, "session">,
  payload: { readonly turnId: string; readonly completesTurn?: boolean | undefined },
): boolean {
  if (payload.completesTurn !== undefined) {
    return payload.completesTurn;
  }
  const activeTurnId = thread.session?.activeTurnId ?? null;
  return activeTurnId === null || activeTurnId !== payload.turnId;
}

function assistantMessageEventCompletesTurn(input: {
  readonly streaming: boolean;
  readonly completesTurn?: boolean | undefined;
  readonly activeTurnId: string | null;
  readonly eventTurnId: string;
}): boolean {
  if (input.streaming) {
    return false;
  }
  if (input.completesTurn !== undefined) {
    return input.completesTurn;
  }
  return input.activeTurnId === null || input.activeTurnId !== input.eventTurnId;
}

function compareActivities(
  left: Thread["activities"][number],
  right: Thread["activities"][number],
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

function capTail<T>(entries: readonly T[], limit: number): T[] {
  return entries.length > limit ? entries.slice(-limit) : [...entries];
}

function upsertThreadMessage(
  messages: ReadonlyArray<ChatMessage>,
  message: ChatMessage,
): ChatMessage[] {
  // From the end: what changes is nearly always the newest message, streaming.
  const existingIndex = messages.findLastIndex((entry) => entry.id === message.id);
  if (existingIndex === -1) {
    return capTail([...messages, message], MAX_THREAD_MESSAGES);
  }

  const existingMessage = messages[existingIndex];
  if (!existingMessage) {
    return capTail([...messages, message], MAX_THREAD_MESSAGES);
  }

  const nextMessage: ChatMessage = {
    ...existingMessage,
    text: message.streaming
      ? `${existingMessage.text}${message.text}`
      : message.text.length > 0
        ? message.text
        : existingMessage.text,
    streaming: message.streaming,
    ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
    ...(message.streaming
      ? existingMessage.completedAt !== undefined
        ? { completedAt: existingMessage.completedAt }
        : {}
      : message.completedAt !== undefined
        ? { completedAt: message.completedAt }
        : {}),
    ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
    ...(message.fromAgent !== undefined ? { fromAgent: message.fromAgent } : {}),
    ...(message.requestId !== undefined ? { requestId: message.requestId } : {}),
    ...(message.requestKind !== undefined ? { requestKind: message.requestKind } : {}),
    ...(message.reviewInput !== undefined ? { reviewInput: message.reviewInput } : {}),
    ...(message.invite !== undefined ? { invite: message.invite } : {}),
    ...(message.fromThread !== undefined ? { fromThread: message.fromThread } : {}),
    ...(message.fromOutside !== undefined ? { fromOutside: message.fromOutside } : {}),
    ...(message.imported ? { imported: true as const } : {}),
    // The write that created the message stamps it; an optimistic copy has
    // none, so the server's first write fills it in.
    ...(existingMessage.agentModels === undefined && message.agentModels !== undefined
      ? { agentModels: message.agentModels }
      : {}),
    // Stamped by the server; an optimistic copy has none.
    ...(existingMessage.sentFrom === undefined && message.sentFrom !== undefined
      ? { sentFrom: message.sentFrom }
      : {}),
  };
  const nextMessages = messages.slice();
  nextMessages[existingIndex] = nextMessage;
  return capTail(nextMessages, MAX_THREAD_MESSAGES);
}

function upsertThreadActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity[] {
  const existingIndex = activities.findLastIndex((entry) => entry.id === activity.id);
  const nextActivity = {
    ...activity,
    ...(existingIndex !== -1 ? { eventSequence: activities[existingIndex]?.eventSequence } : {}),
  };
  if (
    existingIndex === -1 &&
    (activities.length === 0 ||
      compareActivities(activities[activities.length - 1]!, activity) <= 0)
  ) {
    return retainThreadActivities([...activities, nextActivity], MAX_THREAD_ACTIVITIES);
  }

  const nextActivities =
    existingIndex === -1
      ? [...activities, nextActivity]
      : [
          ...activities.slice(0, existingIndex),
          nextActivity,
          ...activities.slice(existingIndex + 1),
        ];
  return retainThreadActivities(nextActivities.toSorted(compareActivities), MAX_THREAD_ACTIVITIES);
}

function buildLatestTurn(params: {
  previous: Thread["latestTurn"];
  turnId: NonNullable<Thread["latestTurn"]>["turnId"];
  state: NonNullable<Thread["latestTurn"]>["state"];
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"];
  sourceProposedPlan?: Thread["pendingSourceProposedPlan"];
}): NonNullable<Thread["latestTurn"]> {
  const resolvedPlan =
    params.previous?.turnId === params.turnId
      ? params.previous.sourceProposedPlan
      : params.sourceProposedPlan;
  return {
    turnId: params.turnId,
    state: params.state,
    requestedAt: params.requestedAt,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    assistantMessageId: params.assistantMessageId,
    ...(resolvedPlan ? { sourceProposedPlan: resolvedPlan } : {}),
  };
}

/** The same list when no summary changes, so a streamed reply leaves it (and what reads it) alone. */
function rebindTurnDiffSummariesForAssistantMessage(
  turnDiffSummaries: TurnDiffSummary[],
  turnId: TurnId,
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"],
): TurnDiffSummary[] {
  if (
    !turnDiffSummaries.some(
      (summary) => summary.turnId === turnId && summary.assistantMessageId !== assistantMessageId,
    )
  ) {
    return turnDiffSummaries;
  }
  return turnDiffSummaries.map((summary) =>
    summary.turnId !== turnId || summary.assistantMessageId === assistantMessageId
      ? summary
      : { ...summary, assistantMessageId: assistantMessageId ?? undefined },
  );
}

function revertThreadMessages(
  messages: ReadonlyArray<ChatMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
) {
  return revertMessages({
    messages,
    idOf: (message) => message.id,
    retainedTurnIds,
    turnCount,
  });
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  retainedTurnIds: ReadonlySet<string>,
): OrchestrationThreadActivity[] {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  retainedTurnIds: ReadonlySet<string>,
): ProposedPlan[] {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

function toLegacyProvider(providerName: string | null): ProviderDriverKind {
  if (isProviderDriverKindValue(providerName)) {
    return providerName;
  }
  return ProviderDriverKind.make("codex");
}

function updateThreadState(
  state: EnvironmentState,
  threadId: ThreadId,
  updater: (thread: Thread) => Thread,
): EnvironmentState {
  const currentThread = getThreadFromEnvironmentState(state, threadId);
  if (!currentThread) {
    return state;
  }
  const nextThread = updater(currentThread);
  if (nextThread === currentThread) {
    return state;
  }
  return writeThreadState(state, nextThread, currentThread);
}

/** Apply a change to one thread's room request state (room tools). */
function updateAgentRequestState(
  state: EnvironmentState,
  threadId: ThreadId,
  change: (current: OrchestrationAgentRequestState) => OrchestrationAgentRequestState,
): EnvironmentState {
  return updateThreadState(state, threadId, (thread) => {
    const current = thread.agentRequests ?? EMPTY_AGENT_REQUEST_STATE;
    const next = change(current);
    return next === current ? thread : { ...thread, agentRequests: next };
  });
}

/** Apply a change to one thread's child-thread request state. */
function updateChildRequestState(
  state: EnvironmentState,
  threadId: ThreadId,
  change: (current: OrchestrationChildRequestState) => OrchestrationChildRequestState,
): EnvironmentState {
  return updateThreadState(state, threadId, (thread) => {
    const current = thread.childRequests ?? EMPTY_CHILD_REQUEST_STATE;
    const next = change(current);
    return next === current ? thread : { ...thread, childRequests: next };
  });
}

/**
 * Apply a step of one move to a thread's `move`: only while that move is the
 * thread's own, so a late step of a move that already ended changes nothing.
 * The change returns null to clear it (the move was dropped).
 */
function updateThreadMove(
  state: EnvironmentState,
  threadId: ThreadId,
  transferId: OrchestrationThreadMove["transferId"],
  change: (current: OrchestrationThreadMove) => OrchestrationThreadMove | null,
): EnvironmentState {
  return updateThreadState(state, threadId, (thread) => {
    if (!thread.move || thread.move.transferId !== transferId) return thread;
    const next = change(thread.move);
    if (next !== null) return { ...thread, move: next };
    const { move: _dropped, ...rest } = thread;
    return rest;
  });
}

function buildProjectState(
  projects: ReadonlyArray<Project>,
): Pick<EnvironmentState, "projectIds" | "projectById"> {
  return {
    projectIds: projects.map((project) => project.id),
    projectById: Object.fromEntries(
      projects.map((project) => [project.id, project] as const),
    ) as Record<ProjectId, Project>,
  };
}

function getStoredEnvironmentState(
  state: AppState,
  environmentId: EnvironmentId,
): EnvironmentState {
  return state.environmentStateById[environmentId] ?? initialEnvironmentState;
}

function commitEnvironmentState(
  state: AppState,
  environmentId: EnvironmentId,
  nextEnvironmentState: EnvironmentState,
): AppState {
  const currentEnvironmentState = state.environmentStateById[environmentId];
  const environmentStateById =
    currentEnvironmentState === nextEnvironmentState
      ? state.environmentStateById
      : {
          ...state.environmentStateById,
          [environmentId]: nextEnvironmentState,
        };

  if (environmentStateById === state.environmentStateById) {
    return state;
  }

  return {
    ...state,
    environmentStateById,
  };
}

function syncEnvironmentShellSnapshot(
  state: EnvironmentState,
  snapshot: OrchestrationShellSnapshot,
  environmentId: EnvironmentId,
): EnvironmentState {
  const nextProjects = snapshot.projects.map((project) => mapProject(project, environmentId));
  const nextThreadIds = new Set(snapshot.threads.map((thread) => thread.id));
  let nextState: EnvironmentState = {
    ...state,
    ...buildProjectState(nextProjects),
    threadIds: [],
    threadIdsByProjectId: {},
    threadShellById: {},
    threadSessionById: {},
    threadTurnStateById: {},
    sidebarThreadSummaryById: {},
    messagesByThreadId: retainThreadScopedRecord(state.messagesByThreadId, nextThreadIds),
    activitiesByThreadId: retainThreadScopedRecord(state.activitiesByThreadId, nextThreadIds),
    proposedPlanIdsByThreadId: retainThreadScopedRecord(
      state.proposedPlanIdsByThreadId,
      nextThreadIds,
    ),
    proposedPlanByThreadId: retainThreadScopedRecord(state.proposedPlanByThreadId, nextThreadIds),
    turnDiffIdsByThreadId: retainThreadScopedRecord(state.turnDiffIdsByThreadId, nextThreadIds),
    turnDiffSummaryByThreadId: retainThreadScopedRecord(
      state.turnDiffSummaryByThreadId,
      nextThreadIds,
    ),
    agentRequestsByThreadId: retainThreadScopedRecord(state.agentRequestsByThreadId, nextThreadIds),
    pagesByThreadId: retainThreadScopedRecord(state.pagesByThreadId ?? {}, nextThreadIds),
    workflowRunsByThreadId: retainThreadScopedRecord(
      state.workflowRunsByThreadId ?? {},
      nextThreadIds,
    ),
    subagentsByThreadId: retainThreadScopedRecord(state.subagentsByThreadId ?? {}, nextThreadIds),
    commandRequestsByThreadId: retainThreadScopedRecord(
      state.commandRequestsByThreadId ?? {},
      nextThreadIds,
    ),
    commandRunsByThreadId: retainThreadScopedRecord(
      state.commandRunsByThreadId ?? {},
      nextThreadIds,
    ),
    threadDetailLoadedById: retainThreadScopedRecord(
      state.threadDetailLoadedById ?? {},
      nextThreadIds,
    ),
    childRequestsByThreadId: retainThreadScopedRecord(state.childRequestsByThreadId, nextThreadIds),
    bootstrapComplete: true,
  };

  for (const thread of snapshot.threads) {
    nextState = writeThreadShellState(nextState, mapThreadShell(thread, environmentId));
  }

  return nextState;
}

export function syncServerShellSnapshot(
  state: AppState,
  snapshot: OrchestrationShellSnapshot,
  environmentId: EnvironmentId,
): AppState {
  return commitEnvironmentState(
    state,
    environmentId,
    syncEnvironmentShellSnapshot(
      getStoredEnvironmentState(state, environmentId),
      snapshot,
      environmentId,
    ),
  );
}

export function syncServerThreadDetail(
  state: AppState,
  thread: OrchestrationThread,
  environmentId: EnvironmentId,
): AppState {
  const environmentState = getStoredEnvironmentState(state, environmentId);
  const previousThread = getThreadFromEnvironmentState(environmentState, thread.id);
  const nextEnvironmentState = writeThreadState(
    environmentState,
    mapThread(thread, environmentId),
    previousThread,
  );
  return commitEnvironmentState(
    state,
    environmentId,
    nextEnvironmentState.threadDetailLoadedById?.[thread.id]
      ? nextEnvironmentState
      : {
          ...nextEnvironmentState,
          threadDetailLoadedById: {
            ...nextEnvironmentState.threadDetailLoadedById,
            [thread.id]: true,
          },
        },
  );
}

/**
 * The thread's detail feed ended (its subscription was released and
 * disposed): what the store holds may fall behind, so the chat waits for the
 * next snapshot before it calls an empty thread empty.
 */
export function markThreadDetailUnloaded(state: AppState, threadRef: ScopedThreadRef): AppState {
  const environmentState = state.environmentStateById[threadRef.environmentId];
  if (!environmentState?.threadDetailLoadedById?.[threadRef.threadId]) {
    return state;
  }
  const { [threadRef.threadId]: _unloaded, ...threadDetailLoadedById } =
    environmentState.threadDetailLoadedById;
  return commitEnvironmentState(state, threadRef.environmentId, {
    ...environmentState,
    threadDetailLoadedById,
  });
}

function applyEnvironmentOrchestrationEvent(
  state: EnvironmentState,
  event: OrchestrationEvent,
  environmentId: EnvironmentId,
): EnvironmentState {
  switch (event.type) {
    case "project.created": {
      const nextProject = mapProject(
        {
          id: event.payload.projectId,
          kind: event.payload.kind,
          title: event.payload.title,
          workspaceRoot: event.payload.workspaceRoot,
          repositoryIdentity: event.payload.repositoryIdentity ?? null,
          defaultModelSelection: event.payload.defaultModelSelection,
          scripts: event.payload.scripts,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          deletedAt: null,
        },
        environmentId,
      );
      const existingProjectId =
        state.projectIds.find(
          (projectId) =>
            projectId === event.payload.projectId ||
            state.projectById[projectId]?.cwd === event.payload.workspaceRoot,
        ) ?? null;
      let projectById = state.projectById;
      let projectIds = state.projectIds;

      if (existingProjectId !== null && existingProjectId !== nextProject.id) {
        const { [existingProjectId]: _removedProject, ...restProjectById } = state.projectById;
        projectById = {
          ...restProjectById,
          [nextProject.id]: nextProject,
        };
        projectIds = state.projectIds.map((projectId) =>
          projectId === existingProjectId ? nextProject.id : projectId,
        );
      } else {
        projectById = {
          ...state.projectById,
          [nextProject.id]: nextProject,
        };
        projectIds =
          existingProjectId === null && !state.projectIds.includes(nextProject.id)
            ? [...state.projectIds, nextProject.id]
            : state.projectIds;
      }

      return {
        ...state,
        projectById,
        projectIds,
      };
    }

    case "project.meta-updated": {
      const project = state.projectById[event.payload.projectId];
      if (!project) {
        return state;
      }
      const nextProject: Project = {
        ...project,
        ...(event.payload.title !== undefined ? { name: event.payload.title } : {}),
        ...(event.payload.workspaceRoot !== undefined ? { cwd: event.payload.workspaceRoot } : {}),
        ...(event.payload.repositoryIdentity !== undefined
          ? { repositoryIdentity: event.payload.repositoryIdentity ?? null }
          : {}),
        ...(event.payload.defaultModelSelection !== undefined
          ? {
              defaultModelSelection: event.payload.defaultModelSelection
                ? normalizeModelSelection(event.payload.defaultModelSelection)
                : null,
            }
          : {}),
        ...(event.payload.scripts !== undefined
          ? { scripts: mapProjectScripts(event.payload.scripts) }
          : {}),
        updatedAt: event.payload.updatedAt,
      };
      return {
        ...state,
        projectById: {
          ...state.projectById,
          [event.payload.projectId]: nextProject,
        },
      };
    }

    case "project.deleted": {
      if (!state.projectById[event.payload.projectId]) {
        return state;
      }
      const { [event.payload.projectId]: _removedProject, ...projectById } = state.projectById;
      return {
        ...state,
        projectById,
        projectIds: removeId(state.projectIds, event.payload.projectId),
      };
    }

    case "thread.created": {
      const previousThread = getThreadFromEnvironmentState(state, event.payload.threadId);
      const nextThread = mapThread(
        {
          id: event.payload.threadId,
          projectId: event.payload.projectId,
          title: event.payload.title,
          modelSelection: event.payload.modelSelection,
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          branch: event.payload.branch,
          worktreePath: event.payload.worktreePath,
          effectiveCwd: null,
          goal: null,
          voiceActive: false,
          latestTurn: null,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
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
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
          diffStatBaselineTurnCount: 0,
          agentRequests: EMPTY_AGENT_REQUEST_STATE,
          parentThreadId: event.payload.parentThreadId ?? null,
          parentTurnId: event.payload.parentTurnId ?? null,
          attachedToParent: event.payload.attachedToParent ?? false,
          parentAttachmentEpoch: 0,
          handedBackAt: null,
          handedBackTurnId: null,
          archivedWithParentAt: null,
          childRequests: EMPTY_CHILD_REQUEST_STATE,
          scheduledRun: event.payload.scheduledRun ?? null,
          outsideOrigin: event.payload.outsideOrigin ?? null,
          ...(event.payload.movedFrom ? { movedFrom: event.payload.movedFrom } : {}),
        },
        environmentId,
      );
      return writeThreadState(state, nextThread, previousThread);
    }

    case "thread.deleted":
      return removeThreadState(state, event.payload.threadId);

    case "thread.archived":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: event.payload.archivedAt,
        updatedAt: event.payload.updatedAt,
      }));

    case "thread.unarchived":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: null,
        updatedAt: event.payload.updatedAt,
      }));

    case "thread.pinned":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        pinnedAt: event.payload.pinnedAt,
        updatedAt: event.payload.updatedAt,
      }));

    case "thread.unpinned":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        pinnedAt: null,
        updatedAt: event.payload.updatedAt,
      }));

    case "thread.pull-request-automation-changed": {
      const { autoFix, autoMerge, pullRequestNumber } = event.payload;
      // A numbered change is the switches of one pull request held by number.
      if (pullRequestNumber !== undefined) {
        return updateThreadState(state, event.payload.threadId, (thread) => ({
          ...thread,
          linkedPullRequests: applyLinkedPullRequestSwitches(thread.linkedPullRequests, {
            pullRequestNumber,
            autoFix,
            autoMerge,
          }),
          updatedAt: event.payload.updatedAt,
        }));
      }
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        ...(autoFix === undefined ? {} : { pullRequestAutoFix: autoFix }),
        ...(autoMerge === undefined ? {} : { pullRequestAutoMerge: autoMerge }),
        updatedAt: event.payload.updatedAt,
      }));
    }

    // Found in the conversation, not done to the thread: `updatedAt` stays.
    case "thread.participant-added":
      return updateThreadState(state, event.payload.threadId, (thread) =>
        (thread.participants ?? []).some((entry) => entry.id === event.payload.participant.id)
          ? thread
          : {
              ...thread,
              participants: [...(thread.participants ?? []), event.payload.participant],
              updatedAt: event.payload.updatedAt,
            },
      );

    case "thread.participant-updated":
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const { participants, agentRole } = applyRoomAgentUpdate(
          { participants: thread.participants ?? [], agentRole: thread.agentRole },
          event.payload,
        );
        const { agentRole: _previous, ...rest } = thread;
        return {
          ...rest,
          participants,
          ...(agentRole !== undefined ? { agentRole } : {}),
          updatedAt: event.payload.updatedAt,
        };
      });

    case "thread.participant-removed":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        participants: (thread.participants ?? []).map((entry) =>
          entry.id === event.payload.participantId && entry.leftAt === null
            ? { ...entry, leftAt: event.payload.updatedAt }
            : entry,
        ),
        updatedAt: event.payload.updatedAt,
      }));

    case "thread.pull-request-linked":
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const linkedPullRequests = applyPullRequestLinked(thread.linkedPullRequests, event.payload);
        return linkedPullRequests === null ? thread : { ...thread, linkedPullRequests };
      });

    // Closing a row is not work on the thread: `updatedAt` stays.
    case "thread.pull-request-dismissed":
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const dismissedPullRequests = applyPullRequestDismissed(
          thread.dismissedPullRequests,
          event.payload,
        );
        return dismissedPullRequests === null ? thread : { ...thread, dismissedPullRequests };
      });

    case "thread.follow-up-queued":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        queuedFollowUps: [
          ...(thread.queuedFollowUps ?? []).filter(
            (queued) => queued.messageId !== event.payload.followUp.messageId,
          ),
          event.payload.followUp,
        ],
      }));

    case "thread.follow-up-unqueued":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        queuedFollowUps: (thread.queuedFollowUps ?? []).filter(
          (queued) => queued.messageId !== event.payload.messageId,
        ),
        messages: thread.messages.some((message) => message.id === event.payload.messageId)
          ? thread.messages.map((message) => withUnqueuedAgentMessage(message, event.payload))
          : thread.messages,
      }));

    // Neither event moves `updatedAt`: filing or reading a thread is not work
    // on it, and the inbox weighs both stamps against real activity.
    case "thread.done-override-set":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        doneOverride: { state: event.payload.state, at: event.payload.at },
      }));

    case "thread.seen-set":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        lastSeenAt: event.payload.at,
      }));

    case "thread.meta-updated":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: normalizeModelSelection(event.payload.modelSelection) }
          : {}),
        ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
        ...(event.payload.worktreePath !== undefined
          ? { worktreePath: event.payload.worktreePath }
          : {}),
        updatedAt: event.payload.updatedAt,
      }));

    case "thread.runtime-mode-set":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        runtimeMode: event.payload.runtimeMode,
        updatedAt: event.payload.updatedAt,
      }));

    case "thread.interaction-mode-set":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        interactionMode: event.payload.interactionMode,
        updatedAt: event.payload.updatedAt,
      }));

    case "thread.effective-cwd-set":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        effectiveCwd: effectiveCwdOf(event.payload).effectiveCwd,
        updatedAt: event.payload.updatedAt,
      }));

    case "thread.goal-state-set":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        goal: event.payload.goal,
        updatedAt: event.payload.updatedAt,
      }));

    case "thread.check-backs-set":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        checkBacks: replaceAgentCheckBacks(thread.checkBacks ?? [], event.payload),
        updatedAt: event.payload.updatedAt,
      }));

    case "thread.realtime-state-set":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        voiceActive: event.payload.active,
        updatedAt: event.payload.updatedAt,
      }));

    // The open thread recomputes its own badge from per-turn summaries, so it
    // has to learn the new baseline here. Otherwise the detail stream would
    // keep overwriting the reset the shell push just delivered.
    case "thread.diffstat-rebased":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        diffStatBaselineTurnCount: Math.max(
          thread.diffStatBaselineTurnCount ?? 0,
          event.payload.baselineTurnCount,
        ),
        updatedAt: event.payload.occurredAt,
      }));

    case "thread.turn-start-requested":
      return updateThreadState(state, event.payload.threadId, (thread) => {
        // A turn for a room agent carries that agent's model; the thread's own
        // agent keeps its selection.
        const participantId = event.payload.participantId ?? null;
        const requestedModelSelection =
          event.payload.modelSelection !== undefined
            ? normalizeModelSelection(event.payload.modelSelection)
            : undefined;
        const modelSelection =
          participantId === null && requestedModelSelection !== undefined
            ? requestedModelSelection
            : thread.modelSelection;
        const participants =
          participantId !== null && requestedModelSelection !== undefined
            ? (thread.participants ?? []).map((entry) =>
                entry.id === participantId
                  ? { ...entry, modelSelection: requestedModelSelection }
                  : entry,
              )
            : thread.participants;
        const sessionModelSelection =
          participantId === null
            ? modelSelection
            : (requestedModelSelection ??
              participants?.find((entry) => entry.id === participantId)?.modelSelection ??
              modelSelection);
        const shouldPreserveRunningSession =
          thread.session?.orchestrationStatus === "running" || thread.session?.status === "running";
        const session = shouldPreserveRunningSession
          ? thread.session
          : ({
              provider: resolveSessionProviderFromModelSelection({
                modelSelection: sessionModelSelection,
                previousSession: thread.session,
              }),
              providerInstanceId: sessionModelSelection.instanceId,
              ...(participantId !== null ? { participantId } : {}),
              status: "connecting",
              orchestrationStatus: "starting",
              // Only the server's launch sets or clears the mark, as there.
              ...(thread.session?.launchingInstanceId
                ? { launchingInstanceId: thread.session.launchingInstanceId }
                : {}),
              createdAt: thread.session?.createdAt ?? event.payload.createdAt,
              updatedAt: event.payload.createdAt,
              ...(thread.session?.lastError ? { lastError: thread.session.lastError } : {}),
            } satisfies ThreadSession);
        return {
          ...thread,
          modelSelection,
          ...(participants !== undefined ? { participants } : {}),
          session,
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          pendingSourceProposedPlan: event.payload.sourceProposedPlan,
          updatedAt: event.occurredAt,
        };
      });

    case "thread.follow-up-submitted":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        updatedAt: event.payload.createdAt,
      }));

    case "thread.follow-up-accepted":
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const message = mapMessage(thread.environmentId, {
          id: event.payload.messageId,
          eventSequence: event.sequence,
          role: event.payload.role,
          text: event.payload.text,
          ...(event.payload.attachments !== undefined
            ? { attachments: event.payload.attachments }
            : {}),
          ...(event.payload.participantId !== undefined
            ? { participantId: event.payload.participantId }
            : {}),
          ...(event.payload.agentModels !== undefined
            ? { agentModels: event.payload.agentModels }
            : {}),
          ...(event.payload.sentFrom !== undefined ? { sentFrom: event.payload.sentFrom } : {}),
          turnId: event.payload.turnId,
          streaming: false,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.createdAt,
        });
        return {
          ...thread,
          messages: upsertThreadMessage(thread.messages, message),
          updatedAt: event.payload.createdAt,
        };
      });

    case "thread.turn-interrupt-requested": {
      if (event.payload.turnId === undefined) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const latestTurn = thread.latestTurn;
        if (latestTurn === null || latestTurn.turnId !== event.payload.turnId) {
          return thread;
        }
        return {
          ...thread,
          latestTurn: buildLatestTurn({
            previous: latestTurn,
            turnId: event.payload.turnId,
            state: "interrupted",
            requestedAt: latestTurn.requestedAt,
            startedAt: latestTurn.startedAt ?? event.payload.createdAt,
            completedAt: latestTurn.completedAt ?? event.payload.createdAt,
            assistantMessageId: latestTurn.assistantMessageId,
          }),
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.message-sent":
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const message = mapMessage(thread.environmentId, {
          id: event.payload.messageId,
          eventSequence: event.sequence,
          role: event.payload.role,
          text: event.payload.text,
          ...(event.payload.attachments !== undefined
            ? { attachments: event.payload.attachments }
            : {}),
          ...(event.payload.participantId !== undefined
            ? { participantId: event.payload.participantId }
            : {}),
          ...(event.payload.sideTurnId !== undefined
            ? { sideTurnId: event.payload.sideTurnId }
            : {}),
          ...(event.payload.fromAgent !== undefined ? { fromAgent: event.payload.fromAgent } : {}),
          ...(event.payload.requestId !== undefined ? { requestId: event.payload.requestId } : {}),
          ...(event.payload.requestKind !== undefined
            ? { requestKind: event.payload.requestKind }
            : {}),
          ...(event.payload.reviewInput !== undefined
            ? { reviewInput: event.payload.reviewInput }
            : {}),
          ...(event.payload.invite !== undefined ? { invite: event.payload.invite } : {}),
          ...(event.payload.fromThread !== undefined
            ? { fromThread: event.payload.fromThread }
            : {}),
          ...(event.payload.fromOutside !== undefined
            ? { fromOutside: event.payload.fromOutside }
            : {}),
          ...(event.payload.agentModels !== undefined
            ? { agentModels: event.payload.agentModels }
            : {}),
          ...(event.payload.sentFrom !== undefined ? { sentFrom: event.payload.sentFrom } : {}),
          ...(event.payload.imported ? { imported: true } : {}),
          turnId: event.payload.turnId,
          streaming: event.payload.streaming,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
        });
        const messages = upsertThreadMessage(thread.messages, message);
        // Brought over by a move: the turns it names are the other
        // computer's, never this one's latest.
        if (event.payload.imported) {
          return { ...thread, messages, updatedAt: event.occurredAt };
        }
        const turnDiffSummaries =
          event.payload.role === "assistant" && event.payload.turnId !== null
            ? rebindTurnDiffSummariesForAssistantMessage(
                thread.turnDiffSummaries,
                event.payload.turnId,
                event.payload.messageId,
              )
            : thread.turnDiffSummaries;
        const completesTurn = assistantMessageEventCompletesTurn({
          streaming: event.payload.streaming,
          completesTurn: event.payload.completesTurn,
          activeTurnId: thread.session?.activeTurnId ?? null,
          eventTurnId: event.payload.turnId ?? "",
        });
        const latestTurn: Thread["latestTurn"] =
          event.payload.role === "assistant" &&
          event.payload.turnId !== null &&
          (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.turnId,
                state: !completesTurn
                  ? (thread.latestTurn?.state ?? "running")
                  : thread.latestTurn?.state === "interrupted"
                    ? "interrupted"
                    : thread.latestTurn?.state === "error"
                      ? "error"
                      : "completed",
                requestedAt:
                  thread.latestTurn?.turnId === event.payload.turnId
                    ? thread.latestTurn.requestedAt
                    : event.payload.createdAt,
                startedAt:
                  thread.latestTurn?.turnId === event.payload.turnId
                    ? (thread.latestTurn.startedAt ?? event.payload.createdAt)
                    : event.payload.createdAt,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
                completedAt: !completesTurn
                  ? thread.latestTurn?.turnId === event.payload.turnId
                    ? (thread.latestTurn.completedAt ?? null)
                    : null
                  : event.payload.updatedAt,
                assistantMessageId: event.payload.messageId,
              })
            : thread.latestTurn;
        return {
          ...thread,
          messages,
          turnDiffSummaries,
          latestTurn,
          updatedAt: event.occurredAt,
        };
      });

    case "thread.session-set":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        session: mapSessionUpdate(event.payload.session, thread.session),
        error: sanitizeThreadErrorMessage(event.payload.session.lastError),
        latestTurn:
          event.payload.session.status === "running" && event.payload.session.activeTurnId !== null
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.session.activeTurnId,
                state: "running",
                requestedAt:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? thread.latestTurn.requestedAt
                    : event.payload.session.updatedAt,
                startedAt:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? (thread.latestTurn.startedAt ?? event.payload.session.updatedAt)
                    : event.payload.session.updatedAt,
                completedAt: null,
                assistantMessageId:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? thread.latestTurn.assistantMessageId
                    : null,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
              })
            : event.payload.session.status === "interrupted" &&
                thread.latestTurn?.state === "running"
              ? buildLatestTurn({
                  previous: thread.latestTurn,
                  turnId: thread.latestTurn.turnId,
                  state: "interrupted",
                  requestedAt: thread.latestTurn.requestedAt,
                  startedAt: thread.latestTurn.startedAt ?? event.payload.session.updatedAt,
                  completedAt: thread.latestTurn.completedAt ?? event.payload.session.updatedAt,
                  assistantMessageId: thread.latestTurn.assistantMessageId,
                  sourceProposedPlan: thread.latestTurn.sourceProposedPlan,
                })
              : thread.latestTurn,
        updatedAt: event.occurredAt,
      }));

    case "thread.session-stop-requested":
      return updateThreadState(state, event.payload.threadId, (thread) =>
        thread.session === null
          ? thread
          : {
              ...thread,
              session: {
                ...thread.session,
                status: "closed",
                orchestrationStatus: "stopped",
                activeTurnId: undefined,
                updatedAt: event.payload.createdAt,
              },
              updatedAt: event.occurredAt,
            },
      );

    case "thread.proposed-plan-upserted":
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const existingPlan = thread.proposedPlans.find(
          (entry) => entry.id === event.payload.proposedPlan.id,
        );
        const proposedPlan = mapProposedPlan({
          ...event.payload.proposedPlan,
          eventSequence: existingPlan ? existingPlan.eventSequence : event.sequence,
        });
        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== proposedPlan.id),
          proposedPlan,
        ]
          .toSorted(compareTranscriptOrder)
          .slice(-MAX_THREAD_PROPOSED_PLANS);
        return {
          ...thread,
          proposedPlans,
          updatedAt: event.occurredAt,
        };
      });

    case "thread.page-published":
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const current = thread.pages ?? [];
        const pages = applyAgentPagePublication(current, event.payload.page, {
          sequence: event.sequence,
          occurredAt: event.occurredAt,
        });
        return pages === current ? thread : { ...thread, pages };
      });

    // Suggested commands (docs/terminal-command-runs.md).
    case "thread.command-requested":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        commandRequests: applyCommandRequested(
          thread.commandRequests ?? [],
          event.payload.request,
          {
            sequence: event.sequence,
            occurredAt: event.occurredAt,
          },
        ),
      }));

    case "thread.command-request-dismissed":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        commandRequests: applyCommandRequestDismissed(
          thread.commandRequests ?? [],
          event.payload,
          event.occurredAt,
        ),
      }));

    case "thread.command-run-started":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        commandRuns: applyCommandRunStarted(thread.commandRuns ?? [], event.payload.run, {
          sequence: event.sequence,
          occurredAt: event.occurredAt,
        }),
      }));

    case "thread.command-run-updated":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        commandRuns: applyCommandRunProgress(
          thread.commandRuns ?? [],
          event.payload.progress,
          event.occurredAt,
        ),
      }));

    case "thread.turn-diff-completed":
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const checkpoint = mapTurnDiffSummary({
          turnId: event.payload.turnId,
          checkpointTurnCount: event.payload.checkpointTurnCount,
          checkpointRef: event.payload.checkpointRef,
          status: event.payload.status,
          files: event.payload.files,
          ...(event.payload.threadDiffStat !== undefined
            ? { threadDiffStat: event.payload.threadDiffStat }
            : {}),
          assistantMessageId: event.payload.assistantMessageId,
          completedAt: event.payload.completedAt,
        });
        const existing = thread.turnDiffSummaries.find(
          (entry) => entry.turnId === checkpoint.turnId,
        );
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return thread;
        }
        const turnDiffSummaries = [
          ...thread.turnDiffSummaries.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted(
            (left, right) =>
              (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
              (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
          )
          .slice(-MAX_THREAD_CHECKPOINTS);
        const completesTurn = turnDiffEventCompletesTurn(thread, event.payload);
        const latestTurn =
          completesTurn &&
          (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.turnId,
                state: checkpointStatusToLatestTurnState(event.payload.status),
                requestedAt: thread.latestTurn?.requestedAt ?? event.payload.completedAt,
                startedAt: thread.latestTurn?.startedAt ?? event.payload.completedAt,
                completedAt: event.payload.completedAt,
                assistantMessageId: event.payload.assistantMessageId,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
              })
            : thread.latestTurn;
        return {
          ...thread,
          turnDiffSummaries,
          latestTurn,
          updatedAt: event.occurredAt,
        };
      });

    // A turn no checkpoint ends (a checkout without git, a failed capture).
    // Only the turn still running settles.
    case "thread.turn-completed":
      return updateThreadState(state, event.payload.threadId, (thread) =>
        thread.latestTurn?.turnId === event.payload.turnId && thread.latestTurn.state === "running"
          ? {
              ...thread,
              latestTurn: buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.turnId,
                state: event.payload.state,
                requestedAt: thread.latestTurn.requestedAt,
                startedAt: thread.latestTurn.startedAt ?? event.payload.completedAt,
                completedAt: event.payload.completedAt,
                assistantMessageId: thread.latestTurn.assistantMessageId,
                sourceProposedPlan: thread.latestTurn.sourceProposedPlan,
              }),
            }
          : thread,
      );

    // Live refresh of an in-flight turn's file summary. Only the files move;
    // ref/status/turn count (and thread updatedAt) stay with the completion
    // event so streaming updates don't churn ordering or lifecycle state.
    case "thread.turn-diff-summary-updated":
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const existing = thread.turnDiffSummaries.find(
          (entry) => entry.turnId === event.payload.turnId,
        );
        if (!existing) {
          return thread;
        }
        return {
          ...thread,
          turnDiffSummaries: thread.turnDiffSummaries.map((entry) =>
            entry.turnId === event.payload.turnId
              ? { ...entry, files: event.payload.files.map((file) => ({ ...file })) }
              : entry,
          ),
        };
      });

    case "thread.reverted":
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const turnDiffSummaries = thread.turnDiffSummaries
          .filter(
            (entry) =>
              entry.checkpointTurnCount !== undefined &&
              entry.checkpointTurnCount <= event.payload.turnCount,
          )
          .toSorted(
            (left, right) =>
              (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
              (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
          )
          .slice(-MAX_THREAD_CHECKPOINTS);
        const retainedTurnIds = new Set(turnDiffSummaries.map((entry) => entry.turnId));
        const reverted = revertThreadMessages(
          thread.messages,
          retainedTurnIds,
          event.payload.turnCount,
        );
        const messages = reverted.messages.slice(-MAX_THREAD_MESSAGES);
        // Pages go with the messages after the cut (agentPages.ts).
        const pages = retainTurnItemsAfterRevert(thread.pages ?? [], reverted);
        const commandRequests = retainTurnItemsAfterRevert(thread.commandRequests ?? [], reverted);
        const commandRuns = retainTurnItemsAfterRevert(thread.commandRuns ?? [], reverted);
        const proposedPlans = retainThreadProposedPlansAfterRevert(
          thread.proposedPlans,
          retainedTurnIds,
        ).slice(-MAX_THREAD_PROPOSED_PLANS);
        const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);
        const subagents = retainSubagentsAfterRevert(thread.subagents ?? [], retainedTurnIds);
        const latestCheckpoint = turnDiffSummaries.at(-1) ?? null;
        // Only runs of the turns the revert removed go: runs are never capped.
        const workflowRuns = retainWorkflowRunsAfterRevert(
          thread.workflowRuns ?? [],
          new Set(
            thread.turnDiffSummaries
              .filter(
                (entry) =>
                  entry.checkpointTurnCount !== undefined &&
                  entry.checkpointTurnCount > event.payload.turnCount,
              )
              .map((entry) => entry.turnId),
          ),
        );

        return {
          ...thread,
          turnDiffSummaries,
          messages,
          proposedPlans,
          pages,
          commandRequests,
          commandRuns,
          activities,
          subagents,
          workflowRuns,
          pendingSourceProposedPlan: undefined,
          latestTurn:
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(
                    (latestCheckpoint.status ?? "ready") as "ready" | "missing" | "error",
                  ),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                },
          updatedAt: event.occurredAt,
        };
      });

    case "thread.activity-appended":
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const activity = { ...event.payload.activity, eventSequence: event.sequence };
        // The same fold the server's projector runs, so the roster stays what
        // a fresh snapshot would say once this activity leaves the window.
        const currentSubagents = thread.subagents ?? EMPTY_SUBAGENTS;
        const subagents = projectSubagentActivity(currentSubagents, activity);
        return {
          ...thread,
          activities: upsertThreadActivity(thread.activities, activity),
          ...(subagents !== currentSubagents ? { subagents } : {}),
          updatedAt: event.occurredAt,
        };
      });

    // Only what changed in one run (see @threadlines/shared/workflowRuns).
    // The thread's updatedAt is left alone: a run's progress is not news.
    case "thread.workflow-run-recorded":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        workflowRuns: applyWorkflowRunPatch(
          thread.workflowRuns ?? [],
          event.payload.patch,
          event.occurredAt,
          event.sequence,
        ),
      }));

    // A room's side answer in progress; see OrchestrationThread.sideTurn.
    case "thread.side-turn-started":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        sideTurn: event.payload.sideTurn,
        updatedAt: event.occurredAt,
      }));

    case "thread.side-turn-running":
    case "thread.side-turn-interrupt-requested":
    case "thread.side-turn-settled":
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const current = thread.sideTurn ?? null;
        // Events for an answer that is no longer the current one change nothing.
        if (current === null || current.sideTurnId !== event.payload.sideTurnId) {
          return thread;
        }
        return {
          ...thread,
          sideTurn:
            event.type === "thread.side-turn-settled"
              ? null
              : {
                  ...current,
                  status: event.type === "thread.side-turn-running" ? "running" : "cancelling",
                },
          updatedAt: event.occurredAt,
        };
      });

    // Room tools: requests agents make of each other. The request message and
    // any side turn arrive in their own events beside these.
    case "thread.agent-request-submitted":
      return updateAgentRequestState(state, event.payload.threadId, (current) =>
        agentRequestStateOn.submitted(current, event.payload.request),
      );

    case "thread.agent-request-updated": {
      const next = updateAgentRequestState(state, event.payload.threadId, (current) =>
        agentRequestStateOn.updated(current, event.payload),
      );
      const inviteChoice = event.payload.inviteChoice;
      if (inviteChoice === undefined) {
        return next;
      }
      // The user's answer to an invite stays on its request message.
      return updateThreadState(next, event.payload.threadId, (thread) => ({
        ...thread,
        messages: thread.messages.map((message) => {
          if (message.id !== inviteChoice.requestMessageId) return message;
          const invite = withInviteChoice(message.invite, inviteChoice);
          return invite === undefined ? message : { ...message, invite };
        }),
      }));
    }

    // Over: the request leaves the open set and its message keeps the outcome.
    case "thread.agent-request-settled":
      return updateThreadState(
        updateAgentRequestState(state, event.payload.threadId, (current) =>
          agentRequestStateOn.settled(current, event.payload.requestId, event.payload.outcome),
        ),
        event.payload.threadId,
        (thread) => {
          const { requestMessageId, outcome, error } = event.payload;
          const requestMessage = thread.messages.find((message) => message.id === requestMessageId);
          return requestMessage === undefined || requestMessage.requestOutcome === outcome
            ? thread
            : {
                ...thread,
                messages: thread.messages.map((message) =>
                  message === requestMessage
                    ? {
                        ...message,
                        requestOutcome: outcome,
                        ...(error !== undefined ? { requestError: error } : {}),
                      }
                    : message,
                ),
              };
        },
      );

    case "thread.agent-requests-held":
      return updateAgentRequestState(state, event.payload.threadId, (current) =>
        agentRequestStateOn.held(current, event.payload.chainEpoch),
      );

    case "thread.agent-requests-reset":
      return updateAgentRequestState(state, event.payload.threadId, agentRequestStateOn.reset);

    // Child threads: what this thread's agent asked of the threads it
    // started, folded through the reducer the server's projector uses.
    case "thread.child-request-submitted":
      return updateChildRequestState(state, event.payload.threadId, (current) =>
        childRequestStateOn.submitted(current, event.payload.request),
      );

    case "thread.child-request-updated":
      return updateChildRequestState(state, event.payload.threadId, (current) =>
        childRequestStateOn.updated(current, event.payload),
      );

    case "thread.child-request-settled":
      return updateChildRequestState(state, event.payload.threadId, (current) =>
        childRequestStateOn.settled(current, event.payload.requestId, event.payload.note),
      );

    case "thread.child-notes-delivered":
      return updateChildRequestState(state, event.payload.threadId, (current) =>
        childRequestStateOn.notesDelivered(current, event.payload.requestIds),
      );

    case "thread.child-deliveries-cancelled":
      return updateChildRequestState(state, event.payload.threadId, (current) =>
        childRequestStateOn.deliveriesCancelled(current, event.payload.deliveryEpoch),
      );

    case "thread.child-requests-reset":
      return updateChildRequestState(state, event.payload.threadId, childRequestStateOn.reset);

    // Children on linked computers (docs/design/fleet.md), kept on the parent.
    case "thread.remote-child-updated":
      return updateChildRequestState(state, event.payload.threadId, (current) =>
        childRequestStateOn.remoteChildUpdated(current, event.payload.child),
      );

    case "thread.remote-cancel-queued":
      return updateChildRequestState(state, event.payload.threadId, (current) =>
        childRequestStateOn.remoteCancelQueued(current, event.payload.cancel),
      );

    case "thread.remote-cancels-delivered":
      return updateChildRequestState(state, event.payload.threadId, (current) =>
        childRequestStateOn.remoteCancelsDelivered(current, event.payload.requestIds),
      );

    // Moving to a linked computer (docs/design/fleet.md, Part 3). Each step
    // names its move, so a late one from a move that already ended is
    // dropped. Like a done mark, none moves `updatedAt`.
    case "thread.move-started":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        move: {
          transferId: event.payload.transferId,
          target: event.payload.target,
          agent: event.payload.agent,
          phase: "exporting",
          cancelRequested: false,
          startedAt: event.payload.startedAt,
        },
      }));

    case "thread.move-progressed":
      return updateThreadMove(state, event.payload.threadId, event.payload.transferId, (move) => {
        const { sentBytes: _sent, totalBytes: _total, ...rest } = move;
        return {
          ...rest,
          phase: event.payload.phase,
          ...(event.payload.sentBytes !== undefined ? { sentBytes: event.payload.sentBytes } : {}),
          ...(event.payload.totalBytes !== undefined
            ? { totalBytes: event.payload.totalBytes }
            : {}),
        };
      });

    case "thread.move-cancel-requested":
      return updateThreadMove(state, event.payload.threadId, event.payload.transferId, (move) => ({
        ...move,
        cancelRequested: true,
      }));

    // Its activity ("Couldn't move to …") arrives on its own.
    case "thread.move-aborted":
      return updateThreadMove(state, event.payload.threadId, event.payload.transferId, () => null);

    case "thread.moved-away":
      return updateThreadMove(state, event.payload.threadId, event.payload.transferId, (move) => ({
        ...move,
        movedAway: { threadId: event.payload.movedThreadId, movedAt: event.payload.movedAt },
      }));

    // The seed debt is the server's alone; nothing here shows it.
    case "thread.history-seed-delivered":
      return state;

    // On a child. Like a done mark, neither moves `updatedAt`: the inbox
    // weighs both against real activity.
    case "thread.handed-back":
      return updateThreadState(state, event.payload.threadId, (thread) =>
        thread.handedBackTurnId === event.payload.turnId &&
        thread.handedBackAt === event.payload.handedBackAt
          ? thread
          : {
              ...thread,
              handedBackAt: event.payload.handedBackAt,
              handedBackTurnId: event.payload.turnId,
            },
      );

    case "thread.parent-attachment-set":
      return updateThreadState(state, event.payload.threadId, (thread) =>
        (thread.attachedToParent ?? false) === event.payload.attached
          ? thread
          : { ...thread, attachedToParent: event.payload.attached },
      );

    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
      return state;
  }

  return state;
}

function applyEnvironmentShellEvent(
  state: EnvironmentState,
  event: OrchestrationShellStreamEvent,
  environmentId: EnvironmentId,
): EnvironmentState {
  switch (event.kind) {
    case "project-upserted": {
      const nextProject = mapProject(event.project, environmentId);
      const existingProjectId =
        state.projectIds.find(
          (projectId) =>
            projectId === event.project.id ||
            state.projectById[projectId]?.cwd === event.project.workspaceRoot,
        ) ?? null;
      let projectById = state.projectById;
      let projectIds = state.projectIds;

      if (existingProjectId !== null && existingProjectId !== nextProject.id) {
        const { [existingProjectId]: _removedProject, ...restProjectById } = state.projectById;
        projectById = {
          ...restProjectById,
          [nextProject.id]: nextProject,
        };
        projectIds = state.projectIds.map((projectId) =>
          projectId === existingProjectId ? nextProject.id : projectId,
        );
      } else {
        projectById = {
          ...state.projectById,
          [nextProject.id]: nextProject,
        };
        projectIds =
          existingProjectId === null && !state.projectIds.includes(nextProject.id)
            ? [...state.projectIds, nextProject.id]
            : state.projectIds;
      }

      return {
        ...state,
        projectById,
        projectIds,
      };
    }
    case "project-removed": {
      if (!state.projectById[event.projectId]) {
        return state;
      }
      const { [event.projectId]: _removedProject, ...projectById } = state.projectById;
      return {
        ...state,
        projectById,
        projectIds: removeId(state.projectIds, event.projectId),
      };
    }
    case "thread-upserted":
      return writeThreadShellState(state, mapThreadShell(event.thread, environmentId));
    case "thread-removed":
      return removeThreadState(state, event.threadId);
  }
}

export function applyOrchestrationEvents(
  state: AppState,
  events: ReadonlyArray<OrchestrationEvent>,
  environmentId: EnvironmentId,
): AppState {
  if (events.length === 0) {
    return state;
  }
  const currentEnvironmentState = getStoredEnvironmentState(state, environmentId);
  const nextEnvironmentState = events.reduce(
    (nextState, event) => applyEnvironmentOrchestrationEvent(nextState, event, environmentId),
    currentEnvironmentState,
  );
  return commitEnvironmentState(state, environmentId, nextEnvironmentState);
}

function getEnvironmentEntries(
  state: AppState,
): ReadonlyArray<readonly [EnvironmentId, EnvironmentState]> {
  return Object.entries(state.environmentStateById) as unknown as ReadonlyArray<
    readonly [EnvironmentId, EnvironmentState]
  >;
}

export function selectEnvironmentState(
  state: AppState,
  environmentId: EnvironmentId | null | undefined,
): EnvironmentState {
  return environmentId ? getStoredEnvironmentState(state, environmentId) : initialEnvironmentState;
}

export function selectProjectsForEnvironment(
  state: AppState,
  environmentId: EnvironmentId | null | undefined,
): Project[] {
  return getProjects(selectEnvironmentState(state, environmentId));
}

export function selectThreadsForEnvironment(
  state: AppState,
  environmentId: EnvironmentId | null | undefined,
): Thread[] {
  return getThreads(selectEnvironmentState(state, environmentId));
}

export function selectProjectsAcrossEnvironments(state: AppState): Project[] {
  return getEnvironmentEntries(state).flatMap(([, environmentState]) =>
    getProjects(environmentState),
  );
}

/** Projects with workspace capabilities — excludes the hidden General Chats system project. */
export function selectWorkspaceProjectsAcrossEnvironments(state: AppState): Project[] {
  return selectProjectsAcrossEnvironments(state).filter(
    (project) => project.kind !== "general-chat",
  );
}

/** The hidden system project backing General Chat threads, when the server has created it. */
export function selectGeneralChatsProjectAcrossEnvironments(state: AppState): Project | null {
  return (
    selectProjectsAcrossEnvironments(state).find((project) => project.kind === "general-chat") ??
    null
  );
}

export function selectThreadsAcrossEnvironments(state: AppState): Thread[] {
  return getEnvironmentEntries(state).flatMap(([, environmentState]) =>
    getThreads(environmentState),
  );
}

/** Like `selectThreadsAcrossEnvironments` but returns stable `ThreadShell` references from the store (no derived data). */
export function selectThreadShellsAcrossEnvironments(state: AppState): ThreadShell[] {
  return getEnvironmentEntries(state).flatMap(([, environmentState]) =>
    environmentState.threadIds.flatMap((threadId) => {
      const shell = environmentState.threadShellById[threadId];
      return shell ? [shell] : [];
    }),
  );
}

/** One environment's sidebar rows in thread order, kept until a row or the order changes. */
const sidebarThreadsOfEnvironment = keyedMemo(
  (
    summaries: Record<ThreadId, SidebarThreadSummary>,
    threadIds: readonly ThreadId[],
    environmentId: EnvironmentId,
  ): ReadonlyArray<SidebarThreadSummary> =>
    threadIds.flatMap((threadId) => {
      const thread = summaries[threadId];
      return thread && thread.environmentId === environmentId ? [thread] : [];
    }),
);

let lastSidebarThreads: {
  readonly parts: ReadonlyArray<ReadonlyArray<SidebarThreadSummary>>;
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
} | null = null;

/**
 * Every environment's sidebar rows. The same list (by identity) until a row
 * changes: many mounted hooks read it on every store write, and most writes
 * (a streamed message) leave every row as it was.
 */
export function selectSidebarThreadsAcrossEnvironments(
  state: AppState,
): ReadonlyArray<SidebarThreadSummary> {
  const parts = getEnvironmentEntries(state).map(([environmentId, environmentState]) =>
    sidebarThreadsOfEnvironment(
      environmentState.sidebarThreadSummaryById,
      environmentState.threadIds,
      environmentId,
    ),
  );
  if (parts.length === 1) return parts[0]!;
  const last = lastSidebarThreads;
  if (
    last !== null &&
    last.parts.length === parts.length &&
    parts.every((part, index) => part === last.parts[index])
  ) {
    return last.threads;
  }
  const threads = parts.flat();
  lastSidebarThreads = { parts, threads };
  return threads;
}

/**
 * Sidebar threads with live agent work, across every environment: the session
 * is running a turn, or the turn settled and background provider tasks
 * (subagents, deferred commands) will start it back up on their own, or an
 * agent in a room is answering on the side. Drives the
 * taskbar badge and, through {@link selectRunningSidebarThreadsByLocation},
 * the quit and update warnings, so a thread that is only waiting on its
 * subagents must not read as finished here.
 */
export function selectRunningSidebarThreadsAcrossEnvironments(
  state: AppState,
): SidebarThreadSummary[] {
  return selectSidebarThreadsAcrossEnvironments(state).filter(isSidebarThreadRunning);
}

/** Whether a sidebar thread has live agent work; see {@link selectRunningSidebarThreadsAcrossEnvironments}. */
export function isSidebarThreadRunning(thread: SidebarThreadSummary): boolean {
  return (
    thread.session?.status === "running" ||
    thread.session?.orchestrationStatus === "running" ||
    isWaitingOnBackgroundTasks(thread.latestTurn, thread.session) ||
    (thread.sideTurn ?? null) !== null
  );
}

/**
 * Whether a thread runs on this device's own server, the one the desktop app
 * starts and stops. Until the primary environment is known every thread
 * counts as local, so a warning about stopping work errs toward asking.
 */
export function isThreadOnPrimaryEnvironment(
  thread: { readonly environmentId: string },
  primaryEnvironmentId: EnvironmentId | null,
): boolean {
  return primaryEnvironmentId === null || thread.environmentId === primaryEnvironmentId;
}

export interface RunningSidebarThreadsByLocation {
  /** On this device's server: quitting or restarting the desktop app stops them. */
  readonly local: SidebarThreadSummary[];
  /** On other computers, which keep running them while this app is closed. */
  readonly remote: SidebarThreadSummary[];
}

/** Running threads split by whether closing this app would stop them. */
export function selectRunningSidebarThreadsByLocation(
  state: AppState,
  primaryEnvironmentId: EnvironmentId | null,
): RunningSidebarThreadsByLocation {
  const local: SidebarThreadSummary[] = [];
  const remote: SidebarThreadSummary[] = [];
  for (const thread of selectRunningSidebarThreadsAcrossEnvironments(state)) {
    (isThreadOnPrimaryEnvironment(thread, primaryEnvironmentId) ? local : remote).push(thread);
  }
  return { local, remote };
}

export function selectSidebarThreadsForProjectRef(
  state: AppState,
  ref: ScopedProjectRef | null | undefined,
): SidebarThreadSummary[] {
  if (!ref) {
    return [];
  }

  const environmentState = selectEnvironmentState(state, ref.environmentId);
  const threadIds = environmentState.threadIdsByProjectId[ref.projectId] ?? EMPTY_THREAD_IDS;
  return threadIds.flatMap((threadId) => {
    const thread = environmentState.sidebarThreadSummaryById[threadId];
    return thread ? [thread] : [];
  });
}

export function selectSidebarThreadsForProjectRefs(
  state: AppState,
  refs: readonly ScopedProjectRef[],
): SidebarThreadSummary[] {
  if (refs.length === 0) return [];
  if (refs.length === 1) return selectSidebarThreadsForProjectRef(state, refs[0]);
  return refs.flatMap((ref) => selectSidebarThreadsForProjectRef(state, ref));
}

export function selectBootstrapCompleteForActiveEnvironment(state: AppState): boolean {
  return selectEnvironmentState(state, state.activeEnvironmentId).bootstrapComplete;
}

export function selectProjectByRef(
  state: AppState,
  ref: ScopedProjectRef | null | undefined,
): Project | undefined {
  return ref
    ? selectEnvironmentState(state, ref.environmentId).projectById[ref.projectId]
    : undefined;
}

export function selectThreadByRef(
  state: AppState,
  ref: ScopedThreadRef | null | undefined,
): Thread | undefined {
  return ref
    ? getThreadFromEnvironmentState(selectEnvironmentState(state, ref.environmentId), ref.threadId)
    : undefined;
}

export function selectThreadExistsByRef(
  state: AppState,
  ref: ScopedThreadRef | null | undefined,
): boolean {
  return ref
    ? selectEnvironmentState(state, ref.environmentId).threadShellById[ref.threadId] !== undefined
    : false;
}

/**
 * Whether the store lists this thread as `selectThreadsAcrossEnvironments`
 * returns it (registered in its environment's `threadIds`, with a shell),
 * without building every thread to find out.
 */
export function selectThreadListedByRef(
  state: AppState,
  ref: ScopedThreadRef | null | undefined,
): boolean {
  if (!ref) {
    return false;
  }
  const environmentState = selectEnvironmentState(state, ref.environmentId);
  return (
    environmentState.threadShellById[ref.threadId]?.environmentId === ref.environmentId &&
    environmentState.threadIds.includes(ref.threadId)
  );
}

/** Whether the thread's detail snapshot has landed (see `threadDetailLoadedById`). */
export function selectThreadDetailLoaded(
  state: AppState,
  ref: ScopedThreadRef | null | undefined,
): boolean {
  return ref
    ? selectEnvironmentState(state, ref.environmentId).threadDetailLoadedById?.[ref.threadId] ===
        true
    : false;
}

export function selectSidebarThreadSummaryByRef(
  state: AppState,
  ref: ScopedThreadRef | null | undefined,
): SidebarThreadSummary | undefined {
  return ref
    ? selectEnvironmentState(state, ref.environmentId).sidebarThreadSummaryById[ref.threadId]
    : undefined;
}

export function selectThreadIdsByProjectRef(
  state: AppState,
  ref: ScopedProjectRef | null | undefined,
): ThreadId[] {
  return ref
    ? (selectEnvironmentState(state, ref.environmentId).threadIdsByProjectId[ref.projectId] ??
        EMPTY_THREAD_IDS)
    : EMPTY_THREAD_IDS;
}

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  if (state.activeEnvironmentId === null) {
    return state;
  }

  const nextEnvironmentState = updateThreadState(
    getStoredEnvironmentState(state, state.activeEnvironmentId),
    threadId,
    (thread) => {
      if (thread.error === error) return thread;
      return { ...thread, error };
    },
  );
  return commitEnvironmentState(state, state.activeEnvironmentId, nextEnvironmentState);
}

export function applyOrchestrationEvent(
  state: AppState,
  event: OrchestrationEvent,
  environmentId: EnvironmentId,
): AppState {
  return commitEnvironmentState(
    state,
    environmentId,
    applyEnvironmentOrchestrationEvent(
      getStoredEnvironmentState(state, environmentId),
      event,
      environmentId,
    ),
  );
}

const projectRemovedListeners = new Set<
  (environmentId: EnvironmentId, projectId: ProjectId) => void
>();

/**
 * Called when an environment says a project was deleted -- the event itself,
 * not a project missing from a list, which also happens when two projects
 * share a folder and one stands in for the other.
 */
export function onProjectRemoved(
  listener: (environmentId: EnvironmentId, projectId: ProjectId) => void,
): () => void {
  projectRemovedListeners.add(listener);
  return () => {
    projectRemovedListeners.delete(listener);
  };
}

export function applyShellEvent(
  state: AppState,
  event: OrchestrationShellStreamEvent,
  environmentId: EnvironmentId,
): AppState {
  return commitEnvironmentState(
    state,
    environmentId,
    applyEnvironmentShellEvent(
      getStoredEnvironmentState(state, environmentId),
      event,
      environmentId,
    ),
  );
}

export function setActiveEnvironmentId(state: AppState, environmentId: EnvironmentId): AppState {
  if (state.activeEnvironmentId === environmentId) {
    return state;
  }

  return {
    ...state,
    activeEnvironmentId: environmentId,
  };
}

export function removeEnvironmentState(state: AppState, environmentId: EnvironmentId): AppState {
  if (!state.environmentStateById[environmentId] && state.activeEnvironmentId !== environmentId) {
    return state;
  }

  const { [environmentId]: _removed, ...environmentStateById } = state.environmentStateById;
  return {
    ...state,
    activeEnvironmentId:
      state.activeEnvironmentId === environmentId ? null : state.activeEnvironmentId,
    environmentStateById,
  };
}

export function setThreadBranch(
  state: AppState,
  threadRef: ScopedThreadRef,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  const nextEnvironmentState = updateThreadState(
    getStoredEnvironmentState(state, threadRef.environmentId),
    threadRef.threadId,
    (thread) => {
      if (thread.branch === branch && thread.worktreePath === worktreePath) return thread;
      const cwdChanged = thread.worktreePath !== worktreePath;
      return {
        ...thread,
        branch,
        worktreePath,
        ...(cwdChanged ? { session: null } : {}),
      };
    },
  );
  return commitEnvironmentState(state, threadRef.environmentId, nextEnvironmentState);
}

/** Optimistically applies the user's checkout selection, including the cwd
 * surfaces should show while the provider catches up. */
export function selectThreadCheckout(
  state: AppState,
  threadRef: ScopedThreadRef,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  const environmentState = getStoredEnvironmentState(state, threadRef.environmentId);
  const nextEnvironmentState = updateThreadState(environmentState, threadRef.threadId, (thread) => {
    const cwdChanged = thread.worktreePath !== worktreePath;
    return {
      ...thread,
      branch,
      worktreePath,
      // `effectiveCwd` is observed runtime state, not the configured checkout.
      // The server keeps a separate selection marker while old work settles.
      effectiveCwd: null,
      ...(cwdChanged ? { session: null } : {}),
    };
  });
  return commitEnvironmentState(state, threadRef.environmentId, nextEnvironmentState);
}

/**
 * Restores a checkout snapshot captured before an optimistic
 * a branch/checkout update, including the session an optimistic cwd change
 * clears and the effective cwd an explicit selection replaces.
 */
export function restoreThreadCheckout(
  state: AppState,
  threadRef: ScopedThreadRef,
  snapshot: {
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly session: ThreadSession | null;
    readonly effectiveCwd?: string | null;
  },
): AppState {
  const nextEnvironmentState = updateThreadState(
    getStoredEnvironmentState(state, threadRef.environmentId),
    threadRef.threadId,
    (thread) => ({
      ...thread,
      branch: snapshot.branch,
      worktreePath: snapshot.worktreePath,
      session: snapshot.session,
      ...(snapshot.effectiveCwd !== undefined ? { effectiveCwd: snapshot.effectiveCwd } : {}),
    }),
  );
  return commitEnvironmentState(state, threadRef.environmentId, nextEnvironmentState);
}

/**
 * The threads on one computer whose agent's scheduled-task change waits for
 * the user, from that computer's waiting requests (ScheduledTasksSync). Their
 * rows need the user like any other approval: Pending Approval in the
 * sidebar and inbox, and in every count of what needs the user.
 */
export function setScheduleApprovalThreads(
  state: AppState,
  environmentId: EnvironmentId,
  threadIds: Iterable<ThreadId>,
): AppState {
  const environmentState = state.environmentStateById[environmentId];
  // Nothing of this computer is here yet: its shell writes read the next call.
  if (environmentState === undefined) return state;
  const next: Record<ThreadId, true> = {};
  for (const threadId of threadIds) next[threadId] = true;
  const previous = environmentState.scheduleApprovalThreadIds ?? {};
  const changed = new Set([...Object.keys(previous), ...Object.keys(next)] as ThreadId[]);
  for (const threadId of changed) {
    if (previous[threadId] === next[threadId]) changed.delete(threadId);
  }
  if (changed.size === 0) return state;
  const nextEnvironmentState: EnvironmentState = {
    ...environmentState,
    scheduleApprovalThreadIds: next,
  };
  const summaries = { ...environmentState.sidebarThreadSummaryById };
  for (const threadId of changed) {
    const summary = summaries[threadId];
    if (summary !== undefined)
      summaries[threadId] = withScheduleApproval(nextEnvironmentState, summary);
  }
  return commitEnvironmentState(state, environmentId, {
    ...nextEnvironmentState,
    sidebarThreadSummaryById: summaries,
  });
}

interface AppStore extends AppState {
  setActiveEnvironmentId: (environmentId: EnvironmentId) => void;
  removeEnvironmentState: (environmentId: EnvironmentId) => void;
  syncServerShellSnapshot: (
    snapshot: OrchestrationShellSnapshot,
    environmentId: EnvironmentId,
  ) => void;
  syncServerThreadDetail: (thread: OrchestrationThread, environmentId: EnvironmentId) => void;
  markThreadDetailUnloaded: (threadRef: ScopedThreadRef) => void;
  applyOrchestrationEvent: (event: OrchestrationEvent, environmentId: EnvironmentId) => void;
  applyOrchestrationEvents: (
    events: ReadonlyArray<OrchestrationEvent>,
    environmentId: EnvironmentId,
  ) => void;
  applyShellEvent: (event: OrchestrationShellStreamEvent, environmentId: EnvironmentId) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setScheduleApprovalThreads: (environmentId: EnvironmentId, threadIds: Iterable<ThreadId>) => void;
  setThreadBranch: (
    threadRef: ScopedThreadRef,
    branch: string | null,
    worktreePath: string | null,
  ) => void;
  selectThreadCheckout: (
    threadRef: ScopedThreadRef,
    branch: string | null,
    worktreePath: string | null,
  ) => void;
  restoreThreadCheckout: (
    threadRef: ScopedThreadRef,
    snapshot: {
      readonly branch: string | null;
      readonly worktreePath: string | null;
      readonly session: ThreadSession | null;
      readonly effectiveCwd?: string | null;
    },
  ) => void;
}

const storeNotifications = createBatchedNotifications();

/**
 * Runs `write` against the store, telling subscribers about it within a
 * tenth of a second instead of at once (see createBatchedNotifications). For
 * writes nothing on screen waits on this instant, such as events for threads
 * no open chat shows: a burst of them costs one render, not one each.
 */
export const deferStoreNotifications = storeNotifications.batch;

/** Tells the store's subscribers about every write still waiting in a batch, now. */
export const flushStoreNotifications = storeNotifications.flush;

const createAppStore: StateCreator<AppStore, [], []> = (set) => ({
  ...initialState,
  setActiveEnvironmentId: (environmentId) =>
    set((state) => setActiveEnvironmentId(state, environmentId)),
  removeEnvironmentState: (environmentId) =>
    set((state) => removeEnvironmentState(state, environmentId)),
  syncServerShellSnapshot: (snapshot, environmentId) =>
    set((state) => syncServerShellSnapshot(state, snapshot, environmentId)),
  syncServerThreadDetail: (thread, environmentId) =>
    set((state) => syncServerThreadDetail(state, thread, environmentId)),
  markThreadDetailUnloaded: (threadRef) =>
    set((state) => markThreadDetailUnloaded(state, threadRef)),
  applyOrchestrationEvent: (event, environmentId) =>
    set((state) => applyOrchestrationEvent(state, event, environmentId)),
  applyOrchestrationEvents: (events, environmentId) =>
    set((state) => applyOrchestrationEvents(state, events, environmentId)),
  applyShellEvent: (event, environmentId) => {
    set((state) => applyShellEvent(state, event, environmentId));
    if (event.kind === "project-removed") {
      for (const listener of projectRemovedListeners) listener(environmentId, event.projectId);
    }
  },
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setScheduleApprovalThreads: (environmentId, threadIds) =>
    set((state) => setScheduleApprovalThreads(state, environmentId, threadIds)),
  setThreadBranch: (threadRef, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadRef, branch, worktreePath)),
  selectThreadCheckout: (threadRef, branch, worktreePath) =>
    set((state) => selectThreadCheckout(state, threadRef, branch, worktreePath)),
  restoreThreadCheckout: (threadRef, snapshot) =>
    set((state) => restoreThreadCheckout(state, threadRef, snapshot)),
});

export const useStore = create<AppStore>()(storeNotifications.middleware(createAppStore));
