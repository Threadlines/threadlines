/**
 * CheckpointRevertLive - Revert planning/execution adapter layer.
 *
 * Implements the shared revert core used by the orchestration reactor
 * (execution) and the WebSocket API (dry-run previews). Selective reverts
 * only touch bytes provably owned by the target thread; everything else is
 * preserved or reported as a conflict.
 *
 * @module CheckpointRevertLive
 */
import type { CheckpointRef, OrchestrationThread, ThreadId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CheckpointUnavailableError } from "../Errors.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  attributedPathsForTurnRange,
  buildSelectiveRevertPlan,
  normalizeCheckpointFilePath,
  type SelectiveRevertConflict,
} from "../SelectiveRevert.ts";
import {
  CheckpointRevert,
  type CheckpointRevertContext,
  type CheckpointRevertShape,
  type SelectiveRevertOutcome,
} from "../Services/CheckpointRevert.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import type { WorktreePathState } from "../Services/CheckpointStore.ts";
import {
  checkpointPreTurnRefForThreadTurn,
  checkpointPreTurnRefForThreadTurnCount,
  checkpointRefForThreadTurn,
  normalizeWorkspacePath,
  resolveThreadWorkspaceCwd,
} from "../Utils.ts";

// Inter-turn gap scans cost two ref resolutions and one tree diff per turn;
// beyond this depth the scan is skipped and the content-hash gate alone
// guards the revert.
const MAX_CONTESTED_GAP_SCANS = 100;

type RevertCheckpointContext = OrchestrationThread["checkpoints"][number];

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function emptySelectiveOutcome(
  skippedReason?: "missing-latest-checkpoint",
): SelectiveRevertOutcome {
  return {
    mode: "selective",
    revertedPaths: [],
    revertedFileCount: 0,
    hunkRevertedFileCount: 0,
    interleavedRevertedFileCount: 0,
    conflicts: [],
    unattributedPathCount: 0,
    noopPathCount: 0,
    ...(skippedReason !== undefined ? { skippedReason } : {}),
  };
}

const make = Effect.gen(function* () {
  const checkpointStore = yield* CheckpointStore;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;

  // A thread may take the whole-checkout restore path only when it is the sole
  // owner of its checkout: a dedicated worktree that is not the project
  // workspace root and is not shared with any other thread or provider
  // session. Everything else must use selective revert so other actors' work
  // survives (issue #37).
  const isIsolatedWorkspaceForThread = Effect.fn("isIsolatedWorkspaceForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly worktreePath: string | null;
    readonly workspaceRoot: string | undefined;
    readonly cwd: string;
  }) {
    const worktreePath = input.worktreePath;
    if (!worktreePath) {
      return false;
    }
    const normalizedCwd = normalizeWorkspacePath(input.cwd);
    if (normalizeWorkspacePath(worktreePath) !== normalizedCwd) {
      return false;
    }
    if (
      input.workspaceRoot !== undefined &&
      normalizeWorkspacePath(input.workspaceRoot) === normalizedCwd
    ) {
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

  const resolveContext: CheckpointRevertShape["resolveContext"] = Effect.fn("resolveContext")(
    function* (input) {
      const thread = yield* projectionSnapshotQuery
        .getThreadDetailById(input.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (!thread) {
        return { kind: "unavailable" as const, detail: "Thread was not found in read model." };
      }

      const project = yield* projectionSnapshotQuery
        .getProjectShellById(thread.projectId)
        .pipe(Effect.map(Option.getOrUndefined));

      const sessions = yield* providerService.listSessions();
      const sessionCwd = sessions.find((session) => session.threadId === input.threadId)?.cwd;
      const cwd =
        sessionCwd ??
        resolveThreadWorkspaceCwd({
          thread,
          projects: project ? [project] : [],
        });
      if (!cwd) {
        return {
          kind: "unavailable" as const,
          detail: "No workspace directory could be resolved for this thread.",
        };
      }
      if (!isGitRepository(cwd)) {
        return {
          kind: "unavailable" as const,
          detail: "Checkpoints are unavailable because this project is not a git repository.",
        };
      }

      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      if (input.turnCount > currentTurnCount) {
        return {
          kind: "unavailable" as const,
          detail: `Checkpoint turn count ${input.turnCount} exceeds current turn count ${currentTurnCount}.`,
        };
      }

      const targetCheckpointRef =
        input.turnCount === 0
          ? checkpointRefForThreadTurn(input.threadId, 0)
          : thread.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === input.turnCount,
            )?.checkpointRef;
      if (!targetCheckpointRef) {
        return {
          kind: "unavailable" as const,
          detail: `Checkpoint ref for turn ${input.turnCount} is unavailable in read model.`,
        };
      }

      const isolated = yield* isIsolatedWorkspaceForThread({
        threadId: input.threadId,
        worktreePath: thread.worktreePath,
        workspaceRoot: project?.workspaceRoot,
        cwd,
      });

      return {
        kind: "ready" as const,
        context: {
          threadId: input.threadId,
          turnCount: input.turnCount,
          currentTurnCount,
          cwd,
          hasProviderSession: sessionCwd !== undefined,
          mode: isolated ? ("workspace" as const) : ("selective" as const),
          targetCheckpointRef,
          thread,
        },
      };
    },
  );

  // Detects attributed paths that also changed outside the thread's turn
  // windows (between one turn's completion snapshot and the next turn's
  // pre-turn snapshot). Such interleaved edits cannot be reverted at the
  // range level; they are rolled back turn by turn instead.
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

  // Shared selective core for both dry-run planning and execution. Hunk and
  // turn-level candidates are verified with real merges either way; `apply`
  // only controls whether results are written to the worktree.
  const executeSelectiveRevert = Effect.fn("executeSelectiveRevert")(function* (
    context: CheckpointRevertContext,
    options: { readonly apply: boolean },
  ) {
    const thread = context.thread;
    const targetCommit = yield* checkpointStore.resolveCheckpointCommit({
      cwd: context.cwd,
      checkpointRef: context.targetCheckpointRef,
      fallbackToHead: context.turnCount === 0,
    });
    if (!targetCommit) {
      return null;
    }

    const currentCheckpointRef =
      thread.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === context.currentTurnCount,
      )?.checkpointRef ?? checkpointRefForThreadTurn(context.threadId, context.currentTurnCount);
    const currentCommit = yield* checkpointStore.resolveCheckpointCommit({
      cwd: context.cwd,
      checkpointRef: currentCheckpointRef,
    });
    if (!currentCommit) {
      // Without the thread's last snapshot nothing can be attributed safely;
      // roll back the conversation but leave the filesystem untouched.
      yield* Effect.logWarning("selective revert skipped file restore: latest snapshot missing", {
        threadId: context.threadId,
        currentTurnCount: context.currentTurnCount,
        cwd: context.cwd,
      });
      return emptySelectiveOutcome("missing-latest-checkpoint");
    }
    if (currentCommit === targetCommit) {
      return emptySelectiveOutcome();
    }

    const entries = yield* checkpointStore.diffCheckpointEntries({
      cwd: context.cwd,
      fromCommit: targetCommit,
      toCommit: currentCommit,
    });
    if (entries.length === 0) {
      return emptySelectiveOutcome();
    }

    const attributedPaths = attributedPathsForTurnRange({
      checkpoints: thread.checkpoints,
      afterTurnCount: context.turnCount,
      throughTurnCount: context.currentTurnCount,
    });
    const contestedPaths = yield* collectContestedPaths({
      threadId: context.threadId,
      checkpoints: thread.checkpoints,
      cwd: context.cwd,
      targetTurnCount: context.turnCount,
      currentTurnCount: context.currentTurnCount,
    });

    const candidatePaths = entries
      .filter((entry) => attributedPaths.has(normalizeCheckpointFilePath(entry.path)))
      .map((entry) => entry.path);
    const worktreeStates = new Map<string, WorktreePathState>();
    if (candidatePaths.length > 0) {
      const states = yield* checkpointStore.hashWorktreePaths({
        cwd: context.cwd,
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

    const revertedPaths: string[] = [...plan.restorePaths, ...plan.deletePaths];
    if (options.apply && (plan.restorePaths.length > 0 || plan.deletePaths.length > 0)) {
      yield* checkpointStore.restoreCheckpointPaths({
        cwd: context.cwd,
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
        cwd: context.cwd,
        path: candidatePath,
        steps: [{ fromCommit: currentCommit, toCommit: targetCommit }],
        dryRun: !options.apply,
      });
      if (applied) {
        hunkRevertedFileCount += 1;
        revertedPaths.push(candidatePath);
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
        : checkpointStore.resolveCheckpointCommit({ cwd: context.cwd, checkpointRef }).pipe(
            Effect.map((commit) => {
              commitByRef.set(checkpointRef, commit);
              return commit;
            }),
          );
    for (const candidatePath of plan.contestedCandidatePaths) {
      const normalizedPath = normalizeCheckpointFilePath(candidatePath);
      const touchingCheckpoints = thread.checkpoints
        .filter(
          (checkpoint) =>
            checkpoint.checkpointTurnCount > context.turnCount &&
            checkpoint.checkpointTurnCount <= context.currentTurnCount &&
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
            checkpointPreTurnRefForThreadTurnCount(
              context.threadId,
              checkpoint.checkpointTurnCount,
            ),
          )) ??
          (yield* resolveCommitCached(
            checkpointPreTurnRefForThreadTurn(context.threadId, checkpoint.turnId),
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
              cwd: context.cwd,
              path: candidatePath,
              steps,
              dryRun: !options.apply,
            })
          : false;
      if (applied) {
        interleavedRevertedFileCount += 1;
        revertedPaths.push(candidatePath);
      } else {
        conflicts.push({ path: candidatePath, reason: "interleaved" });
      }
    }

    const outcome: SelectiveRevertOutcome = {
      mode: "selective",
      revertedPaths,
      revertedFileCount: revertedPaths.length,
      hunkRevertedFileCount,
      interleavedRevertedFileCount,
      conflicts,
      unattributedPathCount: plan.unattributedPaths.length,
      noopPathCount: plan.noopPaths.length,
    };

    if (options.apply) {
      yield* Effect.logInfo("selective revert applied", {
        threadId: context.threadId,
        targetTurnCount: context.turnCount,
        currentTurnCount: context.currentTurnCount,
        cwd: context.cwd,
        revertedFileCount: outcome.revertedFileCount,
        hunkRevertedFileCount,
        interleavedRevertedFileCount,
        conflicts: conflicts.slice(0, 10),
        unattributedPathCount: outcome.unattributedPathCount,
        noopPathCount: outcome.noopPathCount,
      });
    }

    return outcome;
  });

  const planRevert: CheckpointRevertShape["planRevert"] = Effect.fn("planRevert")(
    function* (context) {
      const targetCommit = yield* checkpointStore.resolveCheckpointCommit({
        cwd: context.cwd,
        checkpointRef: context.targetCheckpointRef,
        fallbackToHead: context.turnCount === 0,
      });
      if (!targetCommit) {
        return null;
      }
      if (context.mode === "workspace") {
        return { mode: "workspace" as const };
      }
      return yield* executeSelectiveRevert(context, { apply: false });
    },
  );

  const applyRevert: CheckpointRevertShape["applyRevert"] = Effect.fn("applyRevert")(
    function* (context) {
      if (context.mode === "workspace") {
        const restored = yield* checkpointStore.restoreCheckpoint({
          cwd: context.cwd,
          checkpointRef: context.targetCheckpointRef,
          fallbackToHead: context.turnCount === 0,
        });
        return restored ? { mode: "workspace" as const } : null;
      }
      return yield* executeSelectiveRevert(context, { apply: true });
    },
  );

  const MAX_PLAN_TRANSPORT_ITEMS = 50;

  const getRevertPlan: CheckpointRevertShape["getRevertPlan"] = Effect.fn("getRevertPlan")(
    function* (input) {
      const contextResult = yield* resolveContext({
        threadId: input.threadId,
        turnCount: input.turnCount,
      });
      if (contextResult.kind === "unavailable") {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.turnCount,
          detail: contextResult.detail,
        });
      }
      const context = contextResult.context;

      const outcome = yield* planRevert(context);
      if (outcome === null) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.turnCount,
          detail: `Filesystem checkpoint is unavailable for turn ${input.turnCount}.`,
        });
      }

      const base = {
        threadId: context.threadId,
        turnCount: context.turnCount,
        currentTurnCount: context.currentTurnCount,
        hasProviderSession: context.hasProviderSession,
      };
      if (outcome.mode === "workspace") {
        return {
          ...base,
          mode: "workspace" as const,
          revertPaths: [],
          revertFileCount: 0,
          conflicts: [],
          conflictCount: 0,
          unattributedPathCount: 0,
        };
      }
      return {
        ...base,
        mode: "selective" as const,
        revertPaths: outcome.revertedPaths.slice(0, MAX_PLAN_TRANSPORT_ITEMS),
        revertFileCount: outcome.revertedFileCount,
        conflicts: outcome.conflicts.slice(0, MAX_PLAN_TRANSPORT_ITEMS),
        conflictCount: outcome.conflicts.length,
        unattributedPathCount: outcome.unattributedPathCount,
      };
    },
  );

  return {
    resolveContext,
    planRevert,
    applyRevert,
    getRevertPlan,
  } satisfies CheckpointRevertShape;
});

export const CheckpointRevertLive = Layer.effect(CheckpointRevert, make);
