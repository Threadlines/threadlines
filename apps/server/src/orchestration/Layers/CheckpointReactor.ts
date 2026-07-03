import {
  type CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationCheckpointFile,
  type OrchestrationThreadActivity,
  type ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@threadlines/shared/DrainableWorker";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import {
  attributedPathsForTurnRange,
  buildSelectiveRevertPlan,
  normalizeCheckpointFilePath,
  type SelectiveRevertConflict,
} from "../../checkpointing/SelectiveRevert.ts";
import type { WorktreePathState } from "../../checkpointing/Services/CheckpointStore.ts";
import {
  checkpointPreTurnRefForThreadTurn,
  checkpointPreTurnRefForThreadTurnCount,
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { WorkspaceEntries } from "../../workspace/Services/WorkspaceEntries.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function normalizeWorkspacePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

function cloneCheckpointFiles(
  files: ReadonlyArray<OrchestrationCheckpointFile> | undefined,
): OrchestrationCheckpointFile[] | undefined {
  return files?.map((file) => ({ ...file }));
}

function sharedCheckoutFilesFromDerivedDiff(input: {
  readonly derivedFiles: ReadonlyArray<OrchestrationCheckpointFile>;
  readonly providerSummaryFiles: ReadonlyArray<OrchestrationCheckpointFile> | undefined;
}): OrchestrationCheckpointFile[] | null {
  const providerFiles = input.providerSummaryFiles;
  if (input.derivedFiles.length === 0) {
    return [];
  }
  if (providerFiles === undefined) {
    return null;
  }

  const providerPaths = new Set(
    providerFiles.map((file) => normalizeCheckpointFilePath(file.path)),
  );
  const onlyContainsProviderPaths = input.derivedFiles.every((file) =>
    providerPaths.has(normalizeCheckpointFilePath(file.path)),
  );

  return onlyContainsProviderPaths ? input.derivedFiles.map((file) => ({ ...file })) : null;
}

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

function targetUserMessageIdForCheckpointRewind(input: {
  readonly thread: {
    readonly messages: ReadonlyArray<{
      readonly id: MessageId;
      readonly role: string;
      readonly createdAt: string;
    }>;
  };
  readonly targetTurnCount: number;
}): MessageId | undefined {
  const userMessages = input.thread.messages
    .filter((message) => message.role === "user")
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );

  // Native provider file checkpointing rewinds to the state at a user message.
  // To keep turns 0..N, target the first user message being removed: N + 1.
  return userMessages[input.targetTurnCount]?.id;
}

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

const MAX_REPORTED_CONFLICT_PATHS = 50;
// Inter-turn gap scans cost two ref resolutions and one tree diff per turn;
// beyond this depth the scan is skipped and the content-hash gate alone
// guards the revert.
const MAX_CONTESTED_GAP_SCANS = 100;

type SelectiveRevertOutcome = {
  readonly mode: "selective";
  /** Total files brought back to the target state (exact, hunk, and turn-level). */
  readonly revertedFileCount: number;
  /** Subset of revertedFileCount restored via hunk-level inverse patch. */
  readonly hunkRevertedFileCount: number;
  /** Subset of revertedFileCount restored via turn-by-turn rollback. */
  readonly interleavedRevertedFileCount: number;
  readonly conflicts: ReadonlyArray<SelectiveRevertConflict>;
  readonly unattributedPathCount: number;
  readonly noopPathCount: number;
  readonly skippedReason?: "missing-latest-checkpoint";
};

type RevertFileOutcome = { readonly mode: "workspace" } | SelectiveRevertOutcome;

function emptySelectiveOutcome(
  skippedReason?: "missing-latest-checkpoint",
): SelectiveRevertOutcome {
  return {
    mode: "selective",
    revertedFileCount: 0,
    hunkRevertedFileCount: 0,
    interleavedRevertedFileCount: 0,
    conflicts: [],
    unattributedPathCount: 0,
    noopPathCount: 0,
    ...(skippedReason !== undefined ? { skippedReason } : {}),
  };
}

interface RevertCheckpointContext {
  readonly turnId: TurnId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly files: ReadonlyArray<OrchestrationCheckpointFile>;
}

const MAX_SUMMARY_CONFLICT_PATHS = 3;

// The timeline renders only the summary text, so it must answer "what
// happened to my files" on its own; the payload carries the full details.
function selectiveRevertSummary(outcome: SelectiveRevertOutcome): string {
  const fileCount = (count: number): string => `${count} file${count === 1 ? "" : "s"}`;

  if (outcome.conflicts.length > 0) {
    const listed = outcome.conflicts
      .slice(0, MAX_SUMMARY_CONFLICT_PATHS)
      .map((conflict) => conflict.path)
      .join(", ");
    const overflow = outcome.conflicts.length - MAX_SUMMARY_CONFLICT_PATHS;
    const suffix = overflow > 0 ? ` and ${overflow} more` : "";
    return `Reverted ${fileCount(outcome.revertedFileCount)}; left ${fileCount(
      outcome.conflicts.length,
    )} with conflicting edits untouched: ${listed}${suffix}`;
  }
  if (outcome.revertedFileCount > 0) {
    return `Reverted ${fileCount(outcome.revertedFileCount)} for this thread`;
  }
  return "No file changes to revert for this thread";
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore;
  const receiptBus = yield* RuntimeReceiptBus;
  const workspaceEntries = yield* WorkspaceEntries;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-revert-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: "error",
        kind: "checkpoint.revert.failed",
        summary: "Checkpoint revert failed",
        payload: {
          turnCount: input.turnCount,
          detail: input.detail,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  // Journals the outcome of a checkpoint revert so shared-checkout users can
  // audit what was restored and what was left untouched.
  const appendRevertOutcomeActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly outcome: RevertFileOutcome;
    readonly createdAt: string;
  }) => {
    const summary =
      input.outcome.mode === "workspace"
        ? "Workspace restored to checkpoint"
        : selectiveRevertSummary(input.outcome);
    const tone =
      input.outcome.mode === "selective" && input.outcome.conflicts.length > 0
        ? ("warning" as const)
        : ("info" as const);

    return orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-revert-outcome"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone,
        kind: "checkpoint.reverted",
        summary,
        payload:
          input.outcome.mode === "workspace"
            ? { turnCount: input.turnCount, mode: "workspace" }
            : {
                turnCount: input.turnCount,
                mode: "selective",
                revertedFileCount: input.outcome.revertedFileCount,
                hunkRevertedFileCount: input.outcome.hunkRevertedFileCount,
                interleavedRevertedFileCount: input.outcome.interleavedRevertedFileCount,
                conflictPathCount: input.outcome.conflicts.length,
                conflictPaths: input.outcome.conflicts
                  .slice(0, MAX_REPORTED_CONFLICT_PATHS)
                  .map((conflict) => conflict.path),
                conflicts: input.outcome.conflicts.slice(0, MAX_REPORTED_CONFLICT_PATHS),
                unattributedPathCount: input.outcome.unattributedPathCount,
                noopPathCount: input.outcome.noopPathCount,
                ...(input.outcome.skippedReason !== undefined
                  ? { skippedReason: input.outcome.skippedReason }
                  : {}),
              },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  };

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-capture-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: "error",
        kind: "checkpoint.capture.failed",
        summary: "Checkpoint capture failed",
        payload: {
          detail: input.detail,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const appendCheckpointFileChangeActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly turnCount: number;
    readonly files: ReadonlyArray<OrchestrationCheckpointFile>;
    readonly createdAt: string;
  }) => {
    if (input.files.length === 0) {
      return Effect.void;
    }

    const activityId = EventId.make(
      `checkpoint-files:${input.threadId}:${input.turnId}:${input.turnCount}`,
    );
    const files = input.files.map((file) => ({ ...file }));

    return orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-file-change-activity"),
      threadId: input.threadId,
      activity: {
        id: activityId,
        tone: "tool",
        kind: "tool.completed",
        summary: "Changed files",
        payload: {
          itemType: "file_change",
          status: "completed",
          title: "File change",
          data: {
            files,
          },
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      } satisfies OrchestrationThreadActivity,
      createdAt: input.createdAt,
    });
  };

  const resolveSessionRuntimeForThread = Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.cwd
      ? Option.some({ threadId: session.threadId, cwd: session.cwd })
      : Option.none();
  });

  const hasConcurrentSessionInWorkspace = Effect.fn("hasConcurrentSessionInWorkspace")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
    }): Effect.fn.Return<boolean> {
      const sessions = yield* providerService.listSessions();
      const targetCwd = normalizeWorkspacePath(input.cwd);
      return sessions.some((session) => {
        if (sameId(session.threadId, input.threadId) || !session.cwd) {
          return false;
        }
        if (session.status !== "running" && !session.activeTurnId) {
          return false;
        }
        return normalizeWorkspacePath(session.cwd) === targetCwd;
      });
    },
  );

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadProjects = Effect.fn("resolveThreadProjects")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    return project ? [project] : [];
  });

  const isGitWorkspace = (cwd: string) => isGitRepository(cwd);

  // A thread may take the whole-checkout restore path only when it is the sole
  // owner of its checkout: a dedicated worktree that is not the project
  // workspace root and is not shared with any other thread or provider
  // session. Everything else must use selective revert so other actors' work
  // survives (issue #37).
  const isIsolatedWorkspaceForThread = Effect.fn("isIsolatedWorkspaceForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly cwd: string;
  }) {
    const worktreePath = input.thread.worktreePath;
    if (!worktreePath) {
      return false;
    }
    const normalizedCwd = normalizeWorkspacePath(input.cwd);
    if (normalizeWorkspacePath(worktreePath) !== normalizedCwd) {
      return false;
    }

    const projects = yield* resolveThreadProjects(input.thread.projectId);
    const workspaceRoot = projects[0]?.workspaceRoot;
    if (workspaceRoot !== undefined && normalizeWorkspacePath(workspaceRoot) === normalizedCwd) {
      return false;
    }

    const shellSnapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const sharedWithThread = shellSnapshot.threads.some(
      (shell) =>
        !sameId(shell.id, input.threadId) &&
        shell.worktreePath !== null &&
        normalizeWorkspacePath(shell.worktreePath) === normalizedCwd,
    );
    if (sharedWithThread) {
      return false;
    }

    // Any other provider session in the same checkout makes it shared,
    // regardless of run state: an idle session's work is still on disk.
    const sessions = yield* providerService.listSessions();
    const sharedWithSession = sessions.some(
      (session) =>
        !sameId(session.threadId, input.threadId) &&
        !!session.cwd &&
        normalizeWorkspacePath(session.cwd) === normalizedCwd,
    );
    return !sharedWithSession;
  });

  // Detects attributed paths that also changed outside the thread's turn
  // windows (between one turn's completion snapshot and the next turn's
  // pre-turn snapshot). Such interleaved edits cannot be separated at the
  // file level, so they become conflicts instead of silent overwrites.
  const collectContestedPaths = Effect.fn("collectContestedPaths")(function* (input: {
    readonly threadId: ThreadId;
    readonly checkpoints: ReadonlyArray<RevertCheckpointContext>;
    readonly cwd: string;
    readonly targetTurnCount: number;
    readonly currentTurnCount: number;
  }) {
    const contested = new Set<string>();
    if (input.currentTurnCount - input.targetTurnCount > MAX_CONTESTED_GAP_SCANS) {
      yield* Effect.logWarning("selective revert skipped the inter-turn gap scan", {
        threadId: input.threadId,
        targetTurnCount: input.targetTurnCount,
        currentTurnCount: input.currentTurnCount,
      });
      return contested;
    }

    for (
      let turnCount = input.targetTurnCount + 1;
      turnCount <= input.currentTurnCount;
      turnCount += 1
    ) {
      const checkpoint = input.checkpoints.find((entry) => entry.checkpointTurnCount === turnCount);
      let preTurnCommit = yield* checkpointStore.resolveCheckpointCommit({
        cwd: input.cwd,
        checkpointRef: checkpointPreTurnRefForThreadTurnCount(input.threadId, turnCount),
      });
      if (!preTurnCommit && checkpoint) {
        preTurnCommit = yield* checkpointStore.resolveCheckpointCommit({
          cwd: input.cwd,
          checkpointRef: checkpointPreTurnRefForThreadTurn(input.threadId, checkpoint.turnId),
        });
      }
      if (!preTurnCommit) {
        continue;
      }

      const previousCheckpointRef =
        input.checkpoints.find((entry) => entry.checkpointTurnCount === turnCount - 1)
          ?.checkpointRef ?? checkpointRefForThreadTurn(input.threadId, turnCount - 1);
      const previousCommit = yield* checkpointStore.resolveCheckpointCommit({
        cwd: input.cwd,
        checkpointRef: previousCheckpointRef,
        fallbackToHead: turnCount - 1 === 0,
      });
      if (!previousCommit || previousCommit === preTurnCommit) {
        continue;
      }

      const gapEntries = yield* checkpointStore.diffCheckpointEntries({
        cwd: input.cwd,
        fromCommit: previousCommit,
        toCommit: preTurnCommit,
      });
      for (const entry of gapEntries) {
        contested.add(normalizeCheckpointFilePath(entry.path));
      }
    }

    return contested;
  });

  // Shared-checkout revert: restores only paths that are attributed to this
  // thread after the target checkpoint and whose current content provably
  // matches the thread's last captured state. Returns null when the target
  // checkpoint cannot be resolved.
  const performSelectiveRevert = Effect.fn("performSelectiveRevert")(function* (input: {
    readonly threadId: ThreadId;
    readonly checkpoints: ReadonlyArray<RevertCheckpointContext>;
    readonly cwd: string;
    readonly targetTurnCount: number;
    readonly currentTurnCount: number;
    readonly targetCheckpointRef: CheckpointRef;
  }): Effect.fn.Return<SelectiveRevertOutcome | null, CheckpointStoreError> {
    const targetCommit = yield* checkpointStore.resolveCheckpointCommit({
      cwd: input.cwd,
      checkpointRef: input.targetCheckpointRef,
      fallbackToHead: input.targetTurnCount === 0,
    });
    if (!targetCommit) {
      return null;
    }

    const currentCheckpointRef =
      input.checkpoints.find((entry) => entry.checkpointTurnCount === input.currentTurnCount)
        ?.checkpointRef ?? checkpointRefForThreadTurn(input.threadId, input.currentTurnCount);
    const currentCommit = yield* checkpointStore.resolveCheckpointCommit({
      cwd: input.cwd,
      checkpointRef: currentCheckpointRef,
    });
    if (!currentCommit) {
      // Without the thread's last snapshot nothing can be attributed safely;
      // roll back the conversation but leave the filesystem untouched.
      yield* Effect.logWarning("selective revert skipped file restore: latest snapshot missing", {
        threadId: input.threadId,
        currentTurnCount: input.currentTurnCount,
        cwd: input.cwd,
      });
      return emptySelectiveOutcome("missing-latest-checkpoint");
    }
    if (currentCommit === targetCommit) {
      return emptySelectiveOutcome();
    }

    const entries = yield* checkpointStore.diffCheckpointEntries({
      cwd: input.cwd,
      fromCommit: targetCommit,
      toCommit: currentCommit,
    });
    if (entries.length === 0) {
      return emptySelectiveOutcome();
    }

    const attributedPaths = attributedPathsForTurnRange({
      checkpoints: input.checkpoints,
      afterTurnCount: input.targetTurnCount,
      throughTurnCount: input.currentTurnCount,
    });
    const contestedPaths = yield* collectContestedPaths({
      threadId: input.threadId,
      checkpoints: input.checkpoints,
      cwd: input.cwd,
      targetTurnCount: input.targetTurnCount,
      currentTurnCount: input.currentTurnCount,
    });

    const candidatePaths = entries
      .filter((entry) => attributedPaths.has(normalizeCheckpointFilePath(entry.path)))
      .map((entry) => entry.path);
    const worktreeStates = new Map<string, WorktreePathState>();
    if (candidatePaths.length > 0) {
      const states = yield* checkpointStore.hashWorktreePaths({
        cwd: input.cwd,
        paths: candidatePaths,
      });
      for (const state of states) {
        worktreeStates.set(state.path, state);
      }
    }

    const plan = buildSelectiveRevertPlan({
      entries,
      attributedPaths,
      contestedPaths,
      worktreeStates,
    });

    if (plan.restorePaths.length > 0 || plan.deletePaths.length > 0) {
      yield* checkpointStore.restoreCheckpointPaths({
        cwd: input.cwd,
        checkpointCommit: targetCommit,
        restorePaths: plan.restorePaths,
        deletePaths: plan.deletePaths,
      });
    }

    // Files another actor edited after the thread's last checkpoint: undo
    // just the thread's hunks when they apply cleanly against the current
    // content; overlapping edits stay conflicts.
    const conflicts: SelectiveRevertConflict[] = [...plan.conflicts];
    let hunkRevertedFileCount = 0;
    for (const candidatePath of plan.hunkCandidatePaths) {
      const applied = yield* checkpointStore.restoreCheckpointFileEdits({
        cwd: input.cwd,
        path: candidatePath,
        steps: [{ fromCommit: currentCommit, toCommit: targetCommit }],
      });
      if (applied) {
        hunkRevertedFileCount += 1;
      } else {
        conflicts.push({ path: candidatePath, reason: "changed-after-thread" });
      }
    }

    // Files also edited between the thread's turns: a single range-level
    // inverse would destroy the interleaved foreign work, so roll the
    // thread's own turns back one at a time instead. Any turn window that
    // cannot be resolved or merged cleanly leaves the file untouched.
    let interleavedRevertedFileCount = 0;
    const commitByRef = new Map<CheckpointRef, string | null>();
    const resolveCommitCached = (checkpointRef: CheckpointRef) =>
      commitByRef.has(checkpointRef)
        ? Effect.succeed(commitByRef.get(checkpointRef) ?? null)
        : checkpointStore.resolveCheckpointCommit({ cwd: input.cwd, checkpointRef }).pipe(
            Effect.map((commit) => {
              commitByRef.set(checkpointRef, commit);
              return commit;
            }),
          );
    for (const candidatePath of plan.contestedCandidatePaths) {
      const normalizedPath = normalizeCheckpointFilePath(candidatePath);
      const touchingCheckpoints = input.checkpoints
        .filter(
          (checkpoint) =>
            checkpoint.checkpointTurnCount > input.targetTurnCount &&
            checkpoint.checkpointTurnCount <= input.currentTurnCount &&
            checkpoint.files.some(
              (file) => normalizeCheckpointFilePath(file.path) === normalizedPath,
            ),
        )
        .toSorted((left, right) => right.checkpointTurnCount - left.checkpointTurnCount);

      let steps: Array<{ fromCommit: string; toCommit: string }> | null =
        touchingCheckpoints.length > 0 ? [] : null;
      for (const checkpoint of touchingCheckpoints) {
        if (steps === null) {
          break;
        }
        const postCommit = yield* resolveCommitCached(checkpoint.checkpointRef);
        const preCommit =
          (yield* resolveCommitCached(
            checkpointPreTurnRefForThreadTurnCount(input.threadId, checkpoint.checkpointTurnCount),
          )) ??
          (yield* resolveCommitCached(
            checkpointPreTurnRefForThreadTurn(input.threadId, checkpoint.turnId),
          ));
        if (!postCommit || !preCommit) {
          steps = null;
          break;
        }
        if (postCommit !== preCommit) {
          steps.push({ fromCommit: postCommit, toCommit: preCommit });
        }
      }

      const applied =
        steps !== null && steps.length > 0
          ? yield* checkpointStore.restoreCheckpointFileEdits({
              cwd: input.cwd,
              path: candidatePath,
              steps,
            })
          : false;
      if (applied) {
        interleavedRevertedFileCount += 1;
      } else {
        conflicts.push({ path: candidatePath, reason: "interleaved" });
      }
    }

    yield* Effect.logInfo("selective revert applied", {
      threadId: input.threadId,
      targetTurnCount: input.targetTurnCount,
      currentTurnCount: input.currentTurnCount,
      cwd: input.cwd,
      restoredPathCount: plan.restorePaths.length,
      deletedPathCount: plan.deletePaths.length,
      hunkRevertedFileCount,
      interleavedRevertedFileCount,
      conflicts: conflicts.slice(0, 10),
      unattributedPathCount: plan.unattributedPaths.length,
      noopPathCount: plan.noopPaths.length,
    });

    return {
      mode: "selective",
      revertedFileCount:
        plan.restorePaths.length +
        plan.deletePaths.length +
        hunkRevertedFileCount +
        interleavedRevertedFileCount,
      hunkRevertedFileCount,
      interleavedRevertedFileCount,
      conflicts,
      unattributedPathCount: plan.unattributedPaths.length,
      noopPathCount: plan.noopPaths.length,
    };
  });

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined> {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));

    if (!cwd) {
      return undefined;
    }
    if (!isGitWorkspace(cwd)) {
      return undefined;
    }
    return cwd;
  });

  // Shared tail for both capture paths: creates the git checkpoint ref, diffs
  // it against the previous turn, then dispatches the domain events to update
  // the orchestration read model.
  const captureAndDispatchCheckpoint = Effect.fn("captureAndDispatchCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
    };
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly providerSummaryFiles: ReadonlyArray<OrchestrationCheckpointFile> | undefined;
    readonly refreshSharedCheckoutSummaryFromCheckpoint: boolean;
    readonly createdAt: string;
  }) {
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);
    const preTurnCheckpointRef = checkpointPreTurnRefForThreadTurn(input.threadId, input.turnId);
    const preTurnCountCheckpointRef = checkpointPreTurnRefForThreadTurnCount(
      input.threadId,
      input.turnCount,
    );

    const fromCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: fromCheckpointRef,
    });
    const preTurnCountCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: preTurnCountCheckpointRef,
    });
    const preTurnCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: preTurnCheckpointRef,
    });
    if (!fromCheckpointExists && !preTurnCountCheckpointExists && !preTurnCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing summary baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
    });

    // Invalidate the workspace entry cache so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* workspaceEntries.invalidate(input.cwd);

    const summaryFromCheckpointRef = preTurnCountCheckpointExists
      ? preTurnCountCheckpointRef
      : preTurnCheckpointExists
        ? preTurnCheckpointRef
        : fromCheckpointRef;
    const hasConcurrentSession = yield* hasConcurrentSessionInWorkspace({
      threadId: input.threadId,
      cwd: input.cwd,
    });
    const files = yield* checkpointStore
      .diffCheckpoints({
        cwd: input.cwd,
        fromCheckpointRef: summaryFromCheckpointRef,
        toCheckpointRef: targetCheckpointRef,
        fallbackFromToHead: false,
        ignoreWhitespace: false,
      })
      .pipe(
        Effect.map((diff) =>
          parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
            path: file.path,
            kind: "modified" as const,
            additions: file.additions,
            deletions: file.deletions,
          })),
        ),
        Effect.flatMap((derivedFiles) => {
          if (!hasConcurrentSession) {
            return Effect.succeed(derivedFiles);
          }

          if (!input.refreshSharedCheckoutSummaryFromCheckpoint) {
            const providerFiles = cloneCheckpointFiles(input.providerSummaryFiles);
            if (providerFiles !== undefined) {
              return Effect.succeed(providerFiles);
            }

            return Effect.logWarning("skipping shared-checkout checkpoint file summary", {
              threadId: input.threadId,
              turnId: input.turnId,
              turnCount: input.turnCount,
              cwd: input.cwd,
              derivedFileCount: derivedFiles.length,
              providerFileCount: 0,
            }).pipe(Effect.as([]));
          }

          const sharedCheckoutFiles = sharedCheckoutFilesFromDerivedDiff({
            derivedFiles,
            providerSummaryFiles: input.providerSummaryFiles,
          });
          if (sharedCheckoutFiles !== null) {
            return Effect.succeed(sharedCheckoutFiles);
          }

          return Effect.logWarning("skipping shared-checkout checkpoint file summary", {
            threadId: input.threadId,
            turnId: input.turnId,
            turnCount: input.turnCount,
            cwd: input.cwd,
            derivedFileCount: derivedFiles.length,
            providerFileCount: input.providerSummaryFiles?.length ?? 0,
          }).pipe(Effect.as(cloneCheckpointFiles(input.providerSummaryFiles) ?? []));
        }),
        Effect.catch((error) => {
          const fallbackFiles = cloneCheckpointFiles(input.providerSummaryFiles);
          if (fallbackFiles !== undefined) {
            return Effect.logWarning("failed to derive checkpoint file summary", {
              threadId: input.threadId,
              turnId: input.turnId,
              turnCount: input.turnCount,
              detail: error.message,
              fallback: "provider-summary",
            }).pipe(Effect.as(fallbackFiles));
          }

          return Effect.gen(function* () {
            yield* appendCaptureFailureActivity({
              threadId: input.threadId,
              turnId: input.turnId,
              detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
              createdAt: input.createdAt,
            });
            yield* Effect.logWarning("failed to derive checkpoint file summary", {
              threadId: input.threadId,
              turnId: input.turnId,
              turnCount: input.turnCount,
              detail: error.message,
            });
            return [];
          });
        }),
      );

    const assistantMessageId =
      input.assistantMessageId ??
      input.thread.messages
        .toReversed()
        .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id ??
      MessageId.make(`assistant:${input.turnId}`);

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* appendCheckpointFileChangeActivity({
      threadId: input.threadId,
      turnId: input.turnId,
      turnCount: input.turnCount,
      files,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: input.turnCount,
          status: input.status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // Captures a real git checkpoint when a turn completes via a runtime event.
  const captureCheckpointFromTurnCompletion = Effect.fn("captureCheckpointFromTurnCompletion")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      // When a primary turn is active, only that turn may produce completion checkpoints.
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: true,
      });
      if (!checkpointCwd) {
        return;
      }

      // If an early diff event already created a placeholder or real checkpoint
      // for this turn, refresh that same turn count. The capture path will only
      // keep provider-reported summaries for shared checkouts; otherwise the
      // final checkpoint diff is authoritative.
      const existingCheckpoint = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId,
      );
      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const nextTurnCount = existingCheckpoint
        ? existingCheckpoint.checkpointTurnCount
        : currentTurnCount + 1;
      const providerSummaryFiles = existingCheckpoint?.files;

      yield* captureAndDispatchCheckpoint({
        threadId: thread.id,
        turnId,
        thread,
        cwd: checkpointCwd,
        turnCount: nextTurnCount,
        status: checkpointStatusFromRuntime(event.payload.state),
        assistantMessageId: undefined,
        providerSummaryFiles,
        refreshSharedCheckoutSummaryFromCheckpoint: true,
        createdAt: event.createdAt,
      });
    },
  );

  // Captures a real git checkpoint when a placeholder checkpoint (status "missing")
  // is detected via a domain event. This replaces the placeholder with a real
  // git-ref-based checkpoint.
  //
  // ProviderRuntimeIngestion creates placeholder checkpoints on turn.diff.updated
  // events from the Codex runtime. This handler fires when the corresponding
  // domain event arrives, allowing the reactor to capture the actual filesystem
  // state into a git ref and dispatch a replacement checkpoint.
  const captureCheckpointFromPlaceholder = Effect.fn("captureCheckpointFromPlaceholder")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>,
  ) {
    const { threadId, turnId, checkpointTurnCount, status } = event.payload;

    // Only replace placeholders; skip events from our own real captures.
    if (status !== "missing") {
      return;
    }

    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      yield* Effect.logWarning("checkpoint capture from placeholder skipped: thread not found", {
        threadId,
      });
      return;
    }

    // If a real checkpoint already exists for this turn, skip.
    if (
      thread.checkpoints.some(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
      )
    ) {
      yield* Effect.logDebug(
        "checkpoint capture from placeholder skipped: real checkpoint already exists",
        { threadId, turnId },
      );
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: true,
    });
    if (!checkpointCwd) {
      return;
    }

    yield* captureAndDispatchCheckpoint({
      threadId,
      turnId,
      thread,
      cwd: checkpointCwd,
      turnCount: checkpointTurnCount,
      status: "ready",
      assistantMessageId: event.payload.assistantMessageId ?? undefined,
      providerSummaryFiles: event.payload.files,
      refreshSharedCheckoutSummaryFromCheckpoint: false,
      createdAt: event.payload.completedAt,
    });
  });

  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: false,
      });
      if (!checkpointCwd) {
        return;
      }

      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const baselineCheckpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount);
      const baselineExists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      if (!baselineExists) {
        yield* checkpointStore.captureCheckpoint({
          cwd: checkpointCwd,
          checkpointRef: baselineCheckpointRef,
        });
        yield* receiptBus.publish({
          type: "checkpoint.baseline.captured",
          threadId: thread.id,
          checkpointTurnCount: currentTurnCount,
          checkpointRef: baselineCheckpointRef,
          createdAt: event.createdAt,
        });
      }

      const preTurnCheckpointRef = checkpointPreTurnRefForThreadTurn(thread.id, turnId);
      const preTurnCheckpointExists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: preTurnCheckpointRef,
      });
      if (!preTurnCheckpointExists) {
        yield* checkpointStore.captureCheckpoint({
          cwd: checkpointCwd,
          checkpointRef: preTurnCheckpointRef,
        });
      }
    },
  );

  const refreshLocalGitStatusFromTurnCompletion = Effect.fn(
    "refreshLocalGitStatusFromTurnCompletion",
  )(function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId);
    if (Option.isNone(sessionRuntime)) {
      return;
    }

    yield* vcsStatusBroadcaster.refreshLocalStatus(sessionRuntime.value.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh local git status after turn completion", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          cwd: sessionRuntime.value.cwd,
          detail: error.message,
        }),
      ),
    );
  });

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    "ensurePreTurnBaselineFromDomainTurnStart",
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      if (
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, currentTurnCount);
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (!baselineExists) {
      yield* checkpointStore.captureCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      yield* receiptBus.publish({
        type: "checkpoint.baseline.captured",
        threadId,
        checkpointTurnCount: currentTurnCount,
        checkpointRef: baselineCheckpointRef,
        createdAt: event.occurredAt,
      });
    }

    const preTurnCountCheckpointRef = checkpointPreTurnRefForThreadTurnCount(
      threadId,
      currentTurnCount + 1,
    );
    const preTurnCountCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: preTurnCountCheckpointRef,
    });
    if (!preTurnCountCheckpointExists) {
      yield* checkpointStore.captureCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: preTurnCountCheckpointRef,
      });
    }
  });

  const handleRevertRequested = Effect.fn("handleRevertRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was not found in read model.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.payload.threadId);
    if (Option.isNone(sessionRuntime)) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "No active provider session with workspace cwd is bound to this thread.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }
    if (!isGitWorkspace(sessionRuntime.value.cwd)) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Checkpoints are unavailable because this project is not a git repository.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (event.payload.turnCount > currentTurnCount) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const targetCheckpointRef =
      event.payload.turnCount === 0
        ? checkpointRefForThreadTurn(event.payload.threadId, 0)
        : thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
          )?.checkpointRef;

    if (!targetCheckpointRef) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const isolatedWorkspace = yield* isIsolatedWorkspaceForThread({
      threadId: event.payload.threadId,
      thread,
      cwd: sessionRuntime.value.cwd,
    });

    let revertOutcome: RevertFileOutcome;
    if (isolatedWorkspace) {
      const restored = yield* checkpointStore.restoreCheckpoint({
        cwd: sessionRuntime.value.cwd,
        checkpointRef: targetCheckpointRef,
        fallbackToHead: event.payload.turnCount === 0,
      });
      if (!restored) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }
      revertOutcome = { mode: "workspace" };
    } else {
      const selectiveOutcome = yield* performSelectiveRevert({
        threadId: event.payload.threadId,
        checkpoints: thread.checkpoints,
        cwd: sessionRuntime.value.cwd,
        targetTurnCount: event.payload.turnCount,
        currentTurnCount,
        targetCheckpointRef,
      });
      if (selectiveOutcome === null) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }
      revertOutcome = selectiveOutcome;
    }

    // Invalidate the workspace entry cache so the @-mention file picker
    // reflects the reverted filesystem state.
    yield* workspaceEntries.invalidate(sessionRuntime.value.cwd);

    yield* appendRevertOutcomeActivity({
      threadId: event.payload.threadId,
      turnCount: event.payload.turnCount,
      outcome: revertOutcome,
      createdAt: now,
    }).pipe(Effect.catch(() => Effect.void));

    const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
    if (rolledBackTurns > 0) {
      const targetUserMessageId = targetUserMessageIdForCheckpointRewind({
        thread,
        targetTurnCount: event.payload.turnCount,
      });
      yield* providerService.rollbackConversation({
        threadId: sessionRuntime.value.threadId,
        numTurns: rolledBackTurns,
        ...(targetUserMessageId !== undefined ? { targetUserMessageId } : {}),
      });
    }

    const staleCheckpointRefs = thread.checkpoints
      .filter((checkpoint) => checkpoint.checkpointTurnCount > event.payload.turnCount)
      .flatMap((checkpoint) => [
        checkpoint.checkpointRef,
        checkpointPreTurnRefForThreadTurn(event.payload.threadId, checkpoint.turnId),
        checkpointPreTurnRefForThreadTurnCount(
          event.payload.threadId,
          checkpoint.checkpointTurnCount,
        ),
      ]);

    if (staleCheckpointRefs.length > 0) {
      yield* checkpointStore.deleteCheckpointRefs({
        cwd: sessionRuntime.value.cwd,
        checkpointRefs: staleCheckpointRefs,
      });
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: now,
          }),
        ),
        Effect.asVoid,
      );
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendRevertFailureActivity({
              threadId: event.payload.threadId,
              turnCount: event.payload.turnCount,
              detail: error.message,
              createdAt,
            }),
          ),
        ),
      );
      return;
    }

    // When ProviderRuntimeIngestion creates a placeholder checkpoint (status "missing")
    // from a turn.diff.updated runtime event, capture the real git checkpoint to
    // replace it. The providerService.streamEvents PubSub does not reliably deliver
    // turn.completed runtime events to this reactor (shared subscription), so
    // reacting to the domain event is the reliable path.
    if (event.type === "thread.turn-diff-completed") {
      yield* captureCheckpointFromPlaceholder(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.payload.threadId,
              turnId: event.payload.turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
    }
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "turn.started") {
      yield* ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "turn.completed") {
      const turnId = toTurnId(event.turnId);
      yield* refreshLocalGitStatusFromTurnCompletion(event);
      yield* captureCheckpointFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.threadId,
              turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<void, CheckpointStoreError | OrchestrationDispatchError, never> =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested" &&
          event.type !== "thread.turn-diff-completed"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (event.type !== "turn.started" && event.type !== "turn.completed") {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
