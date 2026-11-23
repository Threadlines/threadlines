/**
 * ProjectionThreadRepository - Projection repository interface for threads.
 *
 * Owns persistence operations for projected thread records in the
 * orchestration read model.
 *
 * @module ProjectionThreadRepository
 */
import {
  IsoDateTime,
  MessageId,
  ModelSelection,
  NonNegativeInt,
  OrchestrationCheckBack,
  OrchestrationThreadGoal,
  OrchestrationQueuedFollowUp,
  OrchestrationThreadLinkedPullRequest,
  OrchestrationThreadParticipant,
  OrchestrationRoomContextCursor,
  OrchestrationSideTurn,
  PositiveInt,
  ProjectId,
  RoomAgentRole,
  ProviderInteractionMode,
  PullRequestMergeMethod,
  RuntimeMode,
  ThreadDoneOverrideState,
  ThreadEffectiveCwdSource,
  ThreadId,
  TurnId,
  OrchestrationAgentRequestState,
  OrchestrationChildRequestState,
  OrchestrationSecretRequest,
  OrchestrationSettingsChangeRequest,
  OrchestrationThreadMove,
  ThreadPendingMove,
  ThreadMovedFrom,
  ThreadNativeSession,
  ThreadMoveOutcome,
  ThreadMoveRestore,
  ThreadAdoptedFromLink,
  ThreadRemoteOrigin,
  OrchestrationOutsideWork,
  OutsideAgentRef,
  ThreadScheduledRun,
  ThreadWorktreeOrigin,
} from "@threadlines/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

const SideTurnList = Schema.Array(OrchestrationSideTurn);

/**
 * `projection_threads.side_turn`: the live side answers as a JSON array, or
 * SQL null when none. A row written while a thread ran one side answer at a
 * time holds a single object; it reads as a list of one, so no row is
 * rewritten.
 */
export const ProjectionSideTurnsJson = Schema.fromJsonString(
  Schema.Union([SideTurnList, OrchestrationSideTurn]),
).pipe(
  Schema.decodeTo(
    Schema.toType(SideTurnList),
    SchemaTransformation.transform({
      decode: (stored) => ("sideTurnId" in stored ? [stored] : stored),
      encode: (sideTurns) => sideTurns,
    }),
  ),
);

/** The column's value for a list: null when it is empty. */
export const sideTurnsColumnValue = (
  sideTurns: ReadonlyArray<typeof OrchestrationSideTurn.Encoded> | null | undefined,
): string | null =>
  sideTurns === null || sideTurns === undefined || sideTurns.length === 0
    ? null
    : JSON.stringify(sideTurns);

export const ProjectionThread = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  effectiveCwd: Schema.NullOr(Schema.String),
  /**
   * Why `effectiveCwd` holds what it holds. Optional so rows written before
   * migration 044 decode; absent reads as session-sourced, matching the
   * migration's backfill.
   */
  effectiveCwdSource: Schema.optional(Schema.NullOr(ThreadEffectiveCwdSource)),
  goal: Schema.NullOr(OrchestrationThreadGoal),
  /** See OrchestrationThread.checkBacks. Optional so rows written before
   *  migration 074 decode; absent or null means none. */
  checkBacks: Schema.optional(Schema.NullOr(Schema.Array(OrchestrationCheckBack))),
  voiceActive: Schema.optional(NonNegativeInt),
  /**
   * Turn count the thread's cumulative diff rollup starts after. See
   * `OrchestrationThreadShell.diffStatBaselineTurnCount`. Optional so rows
   * written before migration 041 decode; absent means 0.
   */
  diffStatBaselineTurnCount: Schema.optional(NonNegativeInt),
  latestTurnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  pinnedAt: Schema.NullOr(IsoDateTime),
  /**
   * Whether the server watches this thread's pull request. Optional so rows
   * written before migration 052 decode; absent reads as 0 (off), which is
   * what the migration's column default gives every existing row.
   */
  pullRequestAutoFix: Schema.optional(NonNegativeInt),
  /**
   * How the server merges this thread's pull request once its checks pass, or
   * null while it has not been asked. Optional so rows written before
   * migration 053 decode; absent reads as null.
   */
  pullRequestAutoMerge: Schema.optional(Schema.NullOr(PullRequestMergeMethod)),
  /**
   * Pull requests the agent opened on other branches and linked in the thread;
   * see `OrchestrationThreadShell.linkedPullRequests`. Optional so rows written
   * before migration 054 decode; absent reads as none.
   */
  linkedPullRequests: Schema.optional(Schema.Array(OrchestrationThreadLinkedPullRequest)),
  /**
   * Pull requests whose row the user closed above the composer; see
   * `OrchestrationThreadShell.dismissedPullRequests`. Optional so rows written
   * before migration 076 decode; absent or null means none.
   */
  dismissedPullRequests: Schema.optional(Schema.NullOr(Schema.Array(PositiveInt))),
  /**
   * Messages waiting for the running turn to finish; see
   * `OrchestrationThreadShell.queuedFollowUps`. Optional so rows written before
   * migration 055 decode; absent reads as none.
   */
  queuedFollowUps: Schema.optional(Schema.Array(OrchestrationQueuedFollowUp)),
  /**
   * Agents added next to the thread's own agent; see
   * `OrchestrationThreadShell.participants`. Optional so rows written before
   * migration 056 decode; absent reads as none.
   */
  participants: Schema.optional(Schema.Array(OrchestrationThreadParticipant)),
  /**
   * The side answers in progress; see `OrchestrationThreadShell.sideTurns`.
   * Optional so rows written before migration 059 decode; null or absent:
   * none. Stored in `side_turn` (ProjectionSideTurnsJson).
   */
  sideTurns: Schema.optional(Schema.NullOr(Schema.Array(OrchestrationSideTurn))),
  /**
   * Per agent, what its conversation has been told; see
   * `OrchestrationThread.roomContext`. Optional so rows written before
   * migration 059 decode; absent reads as nothing told yet.
   */
  roomContext: Schema.optional(Schema.Record(Schema.String, OrchestrationRoomContextCursor)),
  /**
   * Per agent, the model its last turn was sent with; see
   * `OrchestrationThread.sentModels`. Optional so rows written before
   * migration 063 decode; absent reads as nothing recorded yet.
   */
  sentModels: Schema.optional(Schema.Record(Schema.String, ModelSelection)),
  /**
   * The user's name for the thread's own agent; see
   * `OrchestrationThreadShell.agentRole`. Optional so rows written before
   * migration 060 decode.
   */
  agentRole: Schema.optional(Schema.NullOr(RoomAgentRole)),
  /**
   * Room tools: open agent requests, the Stop hold and the limit's count; see
   * `OrchestrationThread.agentRequests`. Optional so rows written before
   * migration 061 decode; absent or null reads as none.
   */
  agentRequests: Schema.optional(Schema.NullOr(OrchestrationAgentRequestState)),
  /**
   * Child threads: lineage, family and hand-back; see
   * `OrchestrationThread.parentThreadId` and the fields after it. Optional so
   * rows written before migration 066 decode; absent reads as none.
   */
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  parentTurnId: Schema.optional(Schema.NullOr(TurnId)),
  attachedToParent: Schema.optional(Schema.NullOr(NonNegativeInt)),
  stopsWithParent: Schema.optional(Schema.NullOr(NonNegativeInt)),
  parentAttachmentEpoch: Schema.optional(Schema.NullOr(NonNegativeInt)),
  handedBackAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  handedBackTurnId: Schema.optional(Schema.NullOr(TurnId)),
  archivedWithParentAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** See `OrchestrationThread.remoteOrigin`. Absent or null reads as none. */
  remoteOrigin: Schema.optional(Schema.NullOr(ThreadRemoteOrigin)),
  /** See `OrchestrationThread.adoptedFromLink`. Absent or null reads as none. */
  adoptedFromLink: Schema.optional(Schema.NullOr(ThreadAdoptedFromLink)),
  /** See `OrchestrationThread.scheduledRun`. Absent or null reads as none. */
  scheduledRun: Schema.optional(Schema.NullOr(ThreadScheduledRun)),
  /** See `OrchestrationThread.worktreeOrigin`. Absent or null reads as none. */
  worktreeOrigin: Schema.optional(Schema.NullOr(ThreadWorktreeOrigin)),
  /** See `OrchestrationThread.outsideOrigin`. Absent or null reads as none. */
  outsideOrigin: Schema.optional(Schema.NullOr(OutsideAgentRef)),
  /** See `OrchestrationThread.outsideWork`. Absent, null or empty reads as none. */
  outsideWork: Schema.optional(Schema.NullOr(Schema.Array(OrchestrationOutsideWork))),
  /** See `OrchestrationThread.move`. Absent or null reads as none. */
  move: Schema.optional(Schema.NullOr(OrchestrationThreadMove)),
  /** See `OrchestrationThread.pendingMove`. Absent or null reads as none. */
  pendingMove: Schema.optional(Schema.NullOr(ThreadPendingMove)),
  /** See `OrchestrationThread.movedFrom`. Absent or null reads as none. */
  movedFrom: Schema.optional(Schema.NullOr(ThreadMovedFrom)),
  /** See `OrchestrationThread.lastMoveOutcome`. Absent or null reads as none. */
  lastMoveOutcome: Schema.optional(Schema.NullOr(ThreadMoveOutcome)),
  /** See `OrchestrationThread.moveRestoreOwed`. Absent or null reads as none. */
  moveRestoreOwed: Schema.optional(Schema.NullOr(ThreadMoveRestore)),
  /** See `OrchestrationThread.historySeedOwed`, as 0 or 1. Absent or null reads as 0. */
  historySeedOwed: Schema.optional(Schema.NullOr(NonNegativeInt)),
  /** See `OrchestrationThread.historySeedMessageId`. Absent or null reads as none. */
  historySeedMessageId: Schema.optional(Schema.NullOr(MessageId)),
  /** See `OrchestrationThread.nativeSession`. Absent or null reads as none. */
  nativeSession: Schema.optional(Schema.NullOr(ThreadNativeSession)),
  /** On a parent: see `OrchestrationThread.childRequests`. Absent or null reads as none. */
  childRequests: Schema.optional(Schema.NullOr(OrchestrationChildRequestState)),
  /**
   * See `OrchestrationThread.settingsRequests`. Optional so rows written
   * before migration 097 decode; absent, null or empty reads as none.
   */
  settingsRequests: Schema.optional(
    Schema.NullOr(Schema.Array(OrchestrationSettingsChangeRequest)),
  ),
  /**
   * See `OrchestrationThread.secretRequests`. Optional so rows written before
   * migration 121 decode; absent, null or empty reads as none.
   */
  secretRequests: Schema.optional(Schema.NullOr(Schema.Array(OrchestrationSecretRequest))),
  /**
   * The user's explicit inbox filing and its stamp. Optional so rows written
   * before migration 042 decode; absent reads as "never filed". Kept as two
   * columns rather than a struct so the pair matches the projection table.
   */
  doneOverride: Schema.optional(Schema.NullOr(ThreadDoneOverrideState)),
  doneOverrideAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** When the user last saw the thread; see migration 042. */
  lastSeenAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  pendingApprovalCount: NonNegativeInt,
  pendingUserInputCount: NonNegativeInt,
  blockingUserInputCount: NonNegativeInt,
  hasActionableProposedPlan: NonNegativeInt,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionThread = typeof ProjectionThread.Type;

export const GetProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionThreadInput = typeof GetProjectionThreadInput.Type;

export const DeleteProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadInput = typeof DeleteProjectionThreadInput.Type;

export const ListProjectionThreadsByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionThreadsByProjectInput = typeof ListProjectionThreadsByProjectInput.Type;

export const ListProjectionThreadsByRemoteLinkInput = Schema.Struct({
  linkDeviceId: Schema.String,
});
export type ListProjectionThreadsByRemoteLinkInput =
  typeof ListProjectionThreadsByRemoteLinkInput.Type;

export const ListProjectionAdoptedChildrenInput = Schema.Struct({
  parentThreadId: ThreadId,
});
export type ListProjectionAdoptedChildrenInput = typeof ListProjectionAdoptedChildrenInput.Type;

/**
 * ProjectionThreadRepositoryShape - Service API for projected thread records.
 */
export interface ProjectionThreadRepositoryShape {
  /**
   * Insert or replace a projected thread row.
   *
   * Upserts by `threadId`.
   */
  readonly upsert: (thread: ProjectionThread) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected thread row by id.
   */
  readonly getById: (
    input: GetProjectionThreadInput,
  ) => Effect.Effect<Option.Option<ProjectionThread>, ProjectionRepositoryError>;

  /**
   * List projected threads for a project.
   *
   * Returned in deterministic creation order.
   */
  readonly listByProjectId: (
    input: ListProjectionThreadsByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThread>, ProjectionRepositoryError>;

  /**
   * Ids of the threads a linked computer's link started here
   * (`remoteOrigin.linkDeviceId`), archived ones included, deleted ones not.
   */
  readonly listIdsByRemoteLink: (
    input: ListProjectionThreadsByRemoteLinkInput,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionRepositoryError>;

  /**
   * Ids of `parentThreadId`'s children that it took back over a link when it
   * moved here (`adoptedFromLink`), deleted ones included.
   */
  readonly listAdoptedChildIds: (
    input: ListProjectionAdoptedChildrenInput,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionRepositoryError>;

  /** Ids of `parentThreadId`'s attached children that aren't deleted. */
  readonly listAttachedChildIds: (
    input: ListProjectionAdoptedChildrenInput,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionRepositoryError>;

  /**
   * Soft-delete a projected thread row by id.
   */
  readonly deleteById: (
    input: DeleteProjectionThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadRepository - Service tag for thread projection persistence.
 */
export class ProjectionThreadRepository extends Context.Service<
  ProjectionThreadRepository,
  ProjectionThreadRepositoryShape
>()("threadlines/persistence/Services/ProjectionThreads/ProjectionThreadRepository") {}
