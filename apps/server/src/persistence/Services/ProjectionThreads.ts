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
  ModelSelection,
  NonNegativeInt,
  OrchestrationThreadGoal,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadDoneOverrideState,
  ThreadEffectiveCwdSource,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

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
