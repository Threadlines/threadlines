/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  CheckpointRef,
  IsoDateTime,
  MessageId,
  OrchestrationMessage,
  OrchestrationCheckpointSummary,
  OrchestrationProject,
  OrchestrationProjectCatalogSnapshot,
  OrchestrationProjectShell,
  OrchestrationReadModel,
  OrchestrationSession,
  OrchestrationShellSnapshot,
  OrchestrationSideTurn,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadMove,
  OrchestrationThreadShell,
  OutsideAgentConnectionId,
  ProjectId,
  ThreadId,
  TurnId,
  OrchestrationWorkflowRun,
  OrchestrationSecretRequest,
  OrchestrationSettingsChangeRequest,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
  readonly leadChatCount?: number;
  readonly projectsWithBriefCount?: number;
  readonly projectNoteCount?: number;
}

export interface ProjectionSnapshotSequence {
  readonly snapshotSequence: number;
}

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

export interface ProjectionFullThreadDiffContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly latestCheckpointTurnCount: number;
  readonly toCheckpointRef: CheckpointRef | null;
  /** Every path the thread's turn summaries report through `toTurnCount`. */
  readonly attributedFilePaths: ReadonlyArray<string>;
}

/**
 * One row per non-deleted thread: where it works, where its diff rollup
 * currently starts, and the newest completed turn it could start from. Narrow
 * on purpose -- the clean-checkout observer runs this on every fresh git status
 * and must not hydrate a shell snapshot to do it.
 */
export interface ProjectionThreadDiffStatBaseline {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly effectiveCwd: string | null;
  readonly baselineTurnCount: number;
  /** Null when the thread has no completed turn with a checkpoint yet. */
  readonly latestCompletedCheckpointTurnCount: number | null;
}

/**
 * Another thread's workspace whose turn activity overlapped a capture window.
 */
export interface ProjectionThreadTurnOverlap {
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly effectiveCwd: string | null;
}

/**
 * Minimal active-thread state needed to guard and route high-frequency
 * `content.delta` runtime events without hydrating full thread shells or
 * computing diff-stat rollups.
 */
export interface ProjectionThreadIngestionContext {
  readonly id: ThreadId;
  readonly session: OrchestrationSession | null;
  readonly sideTurn: OrchestrationSideTurn | null;
  readonly sideTurns: ReadonlyArray<OrchestrationSideTurn>;
}

/**
 * Narrow move record for startup recovery and cleanup, avoiding a full
 * read-model hydration when scanning for in-flight or completed moves.
 */
export interface ProjectionThreadMoveSummary {
  readonly threadId: ThreadId;
  readonly deletedAt: IsoDateTime | null;
  readonly move: OrchestrationThreadMove;
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read only project metadata for administrative project commands.
   * Thread projections and project runtime configuration are deliberately
   * excluded from this query.
   */
  readonly getProjectCatalog: () => Effect.Effect<
    OrchestrationProjectCatalogSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read the lightweight command snapshot used to bootstrap the in-memory
   * orchestration engine. Thread messages are hydrated (capped to the same
   * per-thread tail the projector keeps in memory) because decider invariants
   * consult message history (turn retry, fork source lookup); activity and
   * checkpoint bodies are not hydrated.
   */
  readonly getCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read the latest orchestration shell snapshot.
   *
   * Returns only projects and thread shell summaries so clients can bootstrap
   * lightweight navigation state without hydrating every thread body.
   */
  /**
   * Workflow runs still recorded as running, with their threads. Used once
   * at startup: their runtimes were the previous process's.
   */
  readonly listRunningWorkflowRuns: () => Effect.Effect<
    ReadonlyArray<{ readonly threadId: ThreadId; readonly run: OrchestrationWorkflowRun }>,
    ProjectionRepositoryError
  >;

  /**
   * Archived threads' sessions and side answers, for settling what a
   * previous process left running. Used once at startup; it builds none of
   * the archive page's shell (no repositories, no diff stats).
   */
  readonly listArchivedThreadsLiveState: () => Effect.Effect<
    ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly session: OrchestrationSession | null;
      readonly sideTurns: ReadonlyArray<OrchestrationSideTurn>;
    }>,
    ProjectionRepositoryError
  >;

  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read archived thread shell summaries for the archive page.
   *
   * This query is separate from the main shell snapshot so archived threads
   * are never bootstrapped into normal navigation state.
   */
  readonly getArchivedShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest projection snapshot sequence without hydrating read-model
   * entities.
   */
  readonly getSnapshotSequence: () => Effect.Effect<
    ProjectionSnapshotSequence,
    ProjectionRepositoryError
  >;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Read the active project for an exact workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read a single active project shell row by id.
   */
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;

  /**
   * Whether an active project has muted its phone alerts. Reads only the
   * project's row: unlike a shell, it asks git nothing, so it can run often.
   */
  readonly isProjectPhoneAlertsMuted: (
    projectId: ProjectId,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;

  /**
   * Read only the narrow context needed to compute a full-thread diff from
   * checkpoint 0 to a specific turn count.
   */
  readonly getFullThreadDiffContext: (
    threadId: ThreadId,
    toTurnCount: number,
  ) => Effect.Effect<Option.Option<ProjectionFullThreadDiffContext>, ProjectionRepositoryError>;

  /**
   * Read every non-deleted thread's working directory and diff-rollup baseline.
   *
   * Archived threads are included: their badge is derived the same way, so
   * leaving them behind would make an unarchived thread report a stale total.
   */
  readonly listThreadDiffStatBaselines: () => Effect.Effect<
    ReadonlyArray<ProjectionThreadDiffStatBaseline>,
    ProjectionRepositoryError
  >;

  /**
   * Read the workspaces of every other thread that had a turn overlapping the
   * window starting at `sinceIso` (a turn that started or completed at/after
   * that stamp). Checkpoint capture uses this to decide whether a checkout was
   * shared at any point during a turn — a session that finished seconds before
   * capture still contaminated the window's git diff.
   */
  readonly listThreadTurnOverlapsSince: (input: {
    readonly excludeThreadId: ThreadId;
    readonly sinceIso: string;
  }) => Effect.Effect<ReadonlyArray<ProjectionThreadTurnOverlap>, ProjectionRepositoryError>;

  /**
   * Read the ids of non-deleted threads with at least one open room agent
   * request (`agentRequests.open`), without hydrating thread detail. Restart
   * cleanup uses it to skip the room threads that have nothing to close.
   */
  readonly listThreadIdsWithOpenAgentRequests: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProjectionRepositoryError
  >;

  /**
   * Agents' settings changes an answer was in the middle of making
   * (`claimed`), with their threads. Used once at startup to settle them
   * from what the settings hold (AgentSettingsChanges).
   */
  readonly listClaimedSettingsChanges: () => Effect.Effect<
    ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly request: OrchestrationSettingsChangeRequest;
    }>,
    ProjectionRepositoryError
  >;

  /**
   * Every live thread's key requests (docs/design/secret-requests.md). Used
   * at startup to settle claimed ones and to set saved files' expiry timers
   * (AgentSecretRequests).
   */
  readonly listSecretRequests: () => Effect.Effect<
    ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly secretRequests: ReadonlyArray<OrchestrationSecretRequest>;
    }>,
    ProjectionRepositoryError
  >;

  /**
   * Thread shells picked by id, by project, by the thread that started them
   * (child threads, `parentThreadId`) or by the outside agent that started
   * them (docs/design/outside-agents.md), built from those threads' rows
   * alone: no other thread, no repository identities and no diff rollups
   * (`cumulativeDiffStat` reads null). For callers that must not rebuild
   * the sidebar's whole snapshot to answer one question. Newest activity
   * first; archived threads only with `includeArchived`.
   */
  readonly listThreadShells: (input: {
    readonly threadIds?: ReadonlyArray<ThreadId>;
    readonly projectIds?: ReadonlyArray<ProjectId>;
    readonly parentThreadId?: ThreadId;
    readonly outsideConnectionId?: OutsideAgentConnectionId;
    readonly includeArchived?: boolean;
  }) => Effect.Effect<ReadonlyArray<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Read a single active thread shell row by id.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Read the minimal active-thread state needed for high-frequency runtime
   * delta ingestion (session slot/instance guards and live side-turns).
   */
  readonly getThreadIngestionContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadIngestionContext>, ProjectionRepositoryError>;

  /**
   * List threads that currently carry a move record (in-flight or moved-away),
   * including deleted rows so startup can clean up stale export directories.
   */
  readonly listThreadsWithMove: () => Effect.Effect<
    ReadonlyArray<ProjectionThreadMoveSummary>,
    ProjectionRepositoryError
  >;

  /**
   * List thread ids whose projected session is not stopped or that still carry
   * non-empty check-backs, so startup session reconciliation can skip
   * historical stopped threads.
   */
  readonly listThreadIdsNeedingStartupReconciliation?: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProjectionRepositoryError
  >;

  /**
   * Whether any non-deleted thread currently uses `path` as its worktree or
   * effective working directory.
   */
  readonly isThreadWorkspacePathInUse: (
    path: string,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id; with
   * `includeArchived`, an archived one too (a move packs a thread archived
   * while it moves).
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
    options?: { readonly includeArchived?: boolean },
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read every activity of one turn, in thread order. Thread detail keeps only
   * the newest `MAX_THREAD_ACTIVITIES` rows; this is how a client reads the
   * steps of an older turn that fell out of that window.
   */
  readonly getTurnActivities: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) => Effect.Effect<ReadonlyArray<OrchestrationThreadActivity>, ProjectionRepositoryError>;

  /**
   * Read one message of a thread, without the rest of its history: for work
   * that runs on every event of a streaming reply.
   */
  readonly getThreadMessage: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<Option.Option<OrchestrationMessage>, ProjectionRepositoryError>;

  /** Whether a turn has any message from the thread's agent yet. */
  readonly hasAssistantMessageForTurn: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("threadlines/orchestration/Services/ProjectionSnapshotQuery") {}
