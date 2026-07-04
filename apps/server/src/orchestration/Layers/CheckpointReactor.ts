import {
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
import { normalizeCheckpointFilePath } from "../../checkpointing/SelectiveRevert.ts";
import {
  checkpointPreTurnRefForThreadTurn,
  checkpointPreTurnRefForThreadTurnCount,
  checkpointRefForThreadTurn,
  normalizeWorkspacePath,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import {
  CheckpointRevert,
  type RevertFileOutcome,
  type SelectiveRevertOutcome,
} from "../../checkpointing/Services/CheckpointRevert.ts";
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
  const checkpointRevert = yield* CheckpointRevert;
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
                revertedPaths: input.outcome.revertedPaths.slice(0, MAX_REPORTED_CONFLICT_PATHS),
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
    const failRevert = (detail: string) =>
      appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail,
        createdAt: now,
      }).pipe(
        Effect.catch(() => Effect.void),
        Effect.asVoid,
      );

    const contextResult = yield* checkpointRevert.resolveContext({
      threadId: event.payload.threadId,
      turnCount: event.payload.turnCount,
    });
    if (contextResult.kind === "unavailable") {
      yield* failRevert(contextResult.detail);
      return;
    }
    const context = contextResult.context;

    const revertOutcome = yield* checkpointRevert.applyRevert(context);
    if (revertOutcome === null) {
      yield* failRevert(
        `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
      );
      return;
    }

    // Invalidate the workspace entry cache so the @-mention file picker
    // reflects the reverted filesystem state.
    yield* workspaceEntries.invalidate(context.cwd);

    yield* appendRevertOutcomeActivity({
      threadId: event.payload.threadId,
      turnCount: event.payload.turnCount,
      outcome: revertOutcome,
      createdAt: now,
    }).pipe(Effect.catch(() => Effect.void));

    const rolledBackTurns = Math.max(0, context.currentTurnCount - event.payload.turnCount);
    if (rolledBackTurns > 0) {
      if (context.hasProviderSession) {
        const targetUserMessageId = targetUserMessageIdForCheckpointRewind({
          thread: context.thread,
          targetTurnCount: event.payload.turnCount,
        });
        yield* providerService.rollbackConversation({
          threadId: event.payload.threadId,
          numTurns: rolledBackTurns,
          ...(targetUserMessageId !== undefined ? { targetUserMessageId } : {}),
        });
      } else {
        // Files can revert without a live session, but provider conversation
        // state cannot; surface it instead of failing the whole revert.
        yield* orchestrationEngine
          .dispatch({
            type: "thread.activity.append",
            commandId: serverCommandId("checkpoint-revert-rollback-skipped"),
            threadId: event.payload.threadId,
            activity: {
              id: EventId.make(crypto.randomUUID()),
              tone: "warning",
              kind: "checkpoint.revert.rollback-skipped",
              summary:
                "Provider conversation was not rolled back: no active session. The provider may still remember reverted turns.",
              payload: {
                turnCount: event.payload.turnCount,
                rolledBackTurns,
              },
              turnId: null,
              createdAt: now,
            },
            createdAt: now,
          })
          .pipe(Effect.catch(() => Effect.void));
      }
    }

    const staleCheckpointRefs = context.thread.checkpoints
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
        cwd: context.cwd,
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
