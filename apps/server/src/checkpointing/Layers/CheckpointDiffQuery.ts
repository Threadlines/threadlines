import {
  type CheckpointRef,
  type OrchestrationCheckpointSummary,
  OrchestrationGetTurnDiffResult,
  type ThreadId,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { readRevisionFileResult } from "../../media/revisionFile.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CheckpointInvariantError, CheckpointUnavailableError } from "../Errors.ts";
import {
  checkpointPreTurnRefForThreadTurn,
  checkpointPreTurnRefForThreadTurnCount,
  checkpointRefForThreadTurn,
} from "../Utils.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import {
  CheckpointDiffQuery,
  type CheckpointDiffQueryShape,
} from "../Services/CheckpointDiffQuery.ts";

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

// Checkpoint refs capture the whole checkout. In a shared checkout that can
// include writes from other concurrent threads, and anywhere it includes files
// that only changed because HEAD moved (a merge of main, say). Turn summaries
// keep just the paths attributed to the thread, so patches are scoped to them.
function attributedDiffPaths(paths: Iterable<string>): string[] {
  return [...new Set([...paths].map((path) => path.replaceAll("\\", "/")))];
}

function buildTurnDiffResult(
  input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  },
  diff: string,
): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    diff,
  };
}

/**
 * The name `path` had at the start of a range: a rename inside the range
 * (`previousPath` on a later turn's entry) is followed back, newest turn
 * first, so a renamed picture's Before is read under its old name. Null when
 * no turn in the range touched the path at all, which keeps reads to the
 * files the thread's own turns changed.
 */
export function pathAtRangeStart(
  checkpointsInRange: ReadonlyArray<OrchestrationCheckpointSummary>,
  path: string,
): string | null {
  const normalize = (value: string) => value.replaceAll("\\", "/");
  let name = normalize(path);
  let touched = false;
  const newestFirst = checkpointsInRange.toSorted(
    (left, right) => right.checkpointTurnCount - left.checkpointTurnCount,
  );
  for (const checkpoint of newestFirst) {
    const entry = checkpoint.files.find((file) => normalize(file.path) === name);
    if (!entry) {
      continue;
    }
    touched = true;
    if (entry.previousPath !== undefined) {
      name = normalize(entry.previousPath);
    }
  }
  return touched ? name : null;
}

const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore;

  // A single turn's change starts from the snapshot taken just before that
  // turn ran, when one was kept (by turn count, then by turn id), so writes
  // between turns never show as the turn's own. Any wider range starts from
  // the previous turn's end.
  const resolveSingleTurnFromRef = Effect.fn("CheckpointDiffQuery.resolveSingleTurnFromRef")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly workspaceCwd: string;
      readonly toCheckpoint: OrchestrationCheckpointSummary;
      readonly fallback: CheckpointRef;
    }) {
      const preTurnCountCheckpointRef = checkpointPreTurnRefForThreadTurnCount(
        input.threadId,
        input.toCheckpoint.checkpointTurnCount,
      );
      if (
        yield* checkpointStore.hasCheckpointRef({
          cwd: input.workspaceCwd,
          checkpointRef: preTurnCountCheckpointRef,
        })
      ) {
        return preTurnCountCheckpointRef;
      }
      const preTurnCheckpointRef = checkpointPreTurnRefForThreadTurn(
        input.threadId,
        input.toCheckpoint.turnId,
      );
      if (
        yield* checkpointStore.hasCheckpointRef({
          cwd: input.workspaceCwd,
          checkpointRef: preTurnCheckpointRef,
        })
      ) {
        return preTurnCheckpointRef;
      }
      return input.fallback;
    },
  );

  const getTurnDiff: CheckpointDiffQueryShape["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;
      yield* Effect.annotateCurrentSpan({
        "checkpoint.thread_id": input.threadId,
        "checkpoint.from_turn_count": input.fromTurnCount,
        "checkpoint.to_turn_count": input.toTurnCount,
        "checkpoint.ignore_whitespace": ignoreWhitespace,
      });

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff: OrchestrationGetTurnDiffResultType = {
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          diff: "",
        };
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointInvariantError({
            operation,
            detail: "Computed turn diff result does not satisfy contract schema.",
          });
        }
        return emptyDiff;
      }

      const threadContext = yield* projectionSnapshotQuery
        .getThreadCheckpointContext(input.threadId)
        .pipe(Effect.withSpan("checkpoint.turnDiff.lookupContext"));
      if (Option.isNone(threadContext)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Thread '${input.threadId}' not found.`,
        });
      }

      const maxTurnCount = threadContext.value.checkpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Turn diff range exceeds current turn count: requested ${input.toTurnCount}, current ${maxTurnCount}.`,
        });
      }

      const workspaceCwd = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;
      if (!workspaceCwd) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Workspace path missing for thread '${input.threadId}' when computing turn diff.`,
        });
      }

      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? checkpointRefForThreadTurn(input.threadId, 0)
          : threadContext.value.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === input.fromTurnCount,
            )?.checkpointRef;
      if (!fromCheckpointRef) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          detail: `Checkpoint ref is unavailable for turn ${input.fromTurnCount}.`,
        });
      }

      const toCheckpoint = threadContext.value.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === input.toTurnCount,
      );
      if (!toCheckpoint) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Checkpoint ref is unavailable for turn ${input.toTurnCount}.`,
        });
      }
      const effectiveFromCheckpointRef =
        input.toTurnCount === input.fromTurnCount + 1
          ? yield* resolveSingleTurnFromRef({
              threadId: input.threadId,
              workspaceCwd,
              toCheckpoint,
              fallback: fromCheckpointRef,
            })
          : fromCheckpointRef;

      const attributedFilePaths = attributedDiffPaths(
        threadContext.value.checkpoints
          .filter(
            (checkpoint) =>
              checkpoint.checkpointTurnCount > input.fromTurnCount &&
              checkpoint.checkpointTurnCount <= input.toTurnCount,
          )
          .flatMap((checkpoint) => checkpoint.files.map((file) => file.path)),
      );

      const diff =
        attributedFilePaths.length === 0
          ? ""
          : yield* checkpointStore
              .diffCheckpoints({
                cwd: workspaceCwd,
                fromCheckpointRef: effectiveFromCheckpointRef,
                toCheckpointRef: toCheckpoint.checkpointRef,
                fallbackFromToHead: false,
                ignoreWhitespace,
                filePaths: attributedFilePaths,
              })
              .pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints"));

      const turnDiff = buildTurnDiffResult(input, diff);
      if (!isTurnDiffResult(turnDiff)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: "Computed turn diff result does not satisfy contract schema.",
        });
      }

      return turnDiff;
    },
  );

  const getFullThreadDiff: CheckpointDiffQueryShape["getFullThreadDiff"] = Effect.fn(
    "CheckpointDiffQuery.getFullThreadDiff",
  )(function* (input) {
    const operation = "CheckpointDiffQuery.getFullThreadDiff";
    const ignoreWhitespace = input.ignoreWhitespace ?? true;
    yield* Effect.annotateCurrentSpan({
      "checkpoint.thread_id": input.threadId,
      "checkpoint.from_turn_count": 0,
      "checkpoint.to_turn_count": input.toTurnCount,
      "checkpoint.ignore_whitespace": ignoreWhitespace,
      "checkpoint.diff_kind": "full-thread",
    });

    if (input.toTurnCount === 0) {
      const emptyDiff = buildTurnDiffResult(
        {
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: 0,
        },
        "",
      );
      if (!isTurnDiffResult(emptyDiff)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: "Computed full thread diff result does not satisfy contract schema.",
        });
      }
      return emptyDiff satisfies OrchestrationGetFullThreadDiffResult;
    }

    const threadContext = yield* projectionSnapshotQuery
      .getFullThreadDiffContext(input.threadId, input.toTurnCount)
      .pipe(Effect.withSpan("checkpoint.fullThread.lookupContext"));

    if (Option.isNone(threadContext)) {
      return yield* new CheckpointInvariantError({
        operation,
        detail: `Thread '${input.threadId}' not found.`,
      });
    }

    if (input.toTurnCount > threadContext.value.latestCheckpointTurnCount) {
      return yield* new CheckpointUnavailableError({
        threadId: input.threadId,
        turnCount: input.toTurnCount,
        detail: `Turn diff range exceeds current turn count: requested ${input.toTurnCount}, current ${threadContext.value.latestCheckpointTurnCount}.`,
      });
    }

    const workspaceCwd = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;
    if (!workspaceCwd) {
      return yield* new CheckpointInvariantError({
        operation,
        detail: `Workspace path missing for thread '${input.threadId}' when computing full thread diff.`,
      });
    }

    if (!threadContext.value.toCheckpointRef) {
      return yield* new CheckpointUnavailableError({
        threadId: input.threadId,
        turnCount: input.toTurnCount,
        detail: `Checkpoint ref is unavailable for turn ${input.toTurnCount}.`,
      });
    }

    const attributedFilePaths = attributedDiffPaths(threadContext.value.attributedFilePaths);
    const diff =
      attributedFilePaths.length === 0
        ? ""
        : yield* checkpointStore
            .diffCheckpoints({
              cwd: workspaceCwd,
              fromCheckpointRef: checkpointRefForThreadTurn(input.threadId, 0),
              toCheckpointRef: threadContext.value.toCheckpointRef as CheckpointRef,
              fallbackFromToHead: false,
              ignoreWhitespace,
              filePaths: attributedFilePaths,
            })
            .pipe(Effect.withSpan("checkpoint.fullThread.diffCheckpoints"));

    const turnDiff = buildTurnDiffResult(
      {
        threadId: input.threadId,
        fromTurnCount: 0,
        toTurnCount: input.toTurnCount,
      },
      diff,
    );
    if (!isTurnDiffResult(turnDiff)) {
      return yield* new CheckpointInvariantError({
        operation,
        detail: "Computed full thread diff result does not satisfy contract schema.",
      });
    }

    return turnDiff satisfies OrchestrationGetFullThreadDiffResult;
  });

  const getTurnFile: CheckpointDiffQueryShape["getTurnFile"] = Effect.fn(
    "CheckpointDiffQuery.getTurnFile",
  )(function* (input) {
    const operation = "CheckpointDiffQuery.getTurnFile";
    const toTurnCount =
      input.range.kind === "turn" ? input.range.turnCount : input.range.toTurnCount;
    const fromTurnCount = input.range.kind === "turn" ? toTurnCount - 1 : 0;
    yield* Effect.annotateCurrentSpan({
      "checkpoint.thread_id": input.threadId,
      "checkpoint.range_kind": input.range.kind,
      "checkpoint.to_turn_count": toTurnCount,
      "checkpoint.side": input.side,
    });
    const missing = { kind: "missing" as const, relativePath: input.path };

    const threadContext = yield* projectionSnapshotQuery
      .getThreadCheckpointContext(input.threadId)
      .pipe(Effect.withSpan("checkpoint.turnFile.lookupContext"));
    if (Option.isNone(threadContext)) {
      return yield* new CheckpointInvariantError({
        operation,
        detail: `Thread '${input.threadId}' not found.`,
      });
    }
    const workspaceCwd = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;
    if (!workspaceCwd) {
      return yield* new CheckpointInvariantError({
        operation,
        detail: `Workspace path missing for thread '${input.threadId}' when reading a turn file.`,
      });
    }
    const checkpoints = threadContext.value.checkpoints;
    const toCheckpoint = checkpoints.find(
      (checkpoint) => checkpoint.checkpointTurnCount === toTurnCount,
    );
    if (!toCheckpoint) {
      return missing;
    }
    const inRange = checkpoints.filter(
      (checkpoint) =>
        checkpoint.checkpointTurnCount > fromTurnCount &&
        checkpoint.checkpointTurnCount <= toTurnCount,
    );
    // Only the files this thread's turns in the range changed are read, the
    // same files the Diff tab's patch for the range is scoped to.
    const startPath = pathAtRangeStart(inRange, input.path);
    if (startPath === null) {
      return missing;
    }

    if (input.side === "after") {
      return yield* readRevisionFileResult({
        checkpointStore,
        cwd: workspaceCwd,
        revision: toCheckpoint.checkpointRef,
        path: input.path,
      });
    }

    const rangeStartRef =
      fromTurnCount === 0
        ? checkpointRefForThreadTurn(input.threadId, 0)
        : checkpoints.find((checkpoint) => checkpoint.checkpointTurnCount === fromTurnCount)
            ?.checkpointRef;
    if (!rangeStartRef) {
      return missing;
    }
    const fromRef =
      input.range.kind === "turn"
        ? yield* resolveSingleTurnFromRef({
            threadId: input.threadId,
            workspaceCwd,
            toCheckpoint,
            fallback: rangeStartRef,
          })
        : rangeStartRef;
    // Older records carry no rename; the patch the caller is showing does.
    const beforePath =
      startPath === input.path.replaceAll("\\", "/") && input.previousPath !== undefined
        ? input.previousPath
        : startPath;
    return yield* readRevisionFileResult({
      checkpointStore,
      cwd: workspaceCwd,
      revision: fromRef,
      path: beforePath,
      displayPath: input.path,
    });
  });

  return {
    getTurnDiff,
    getFullThreadDiff,
    getTurnFile,
  } satisfies CheckpointDiffQueryShape;
});

export const CheckpointDiffQueryLive = Layer.effect(CheckpointDiffQuery, make);
