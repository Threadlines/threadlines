/**
 * ThreadBootstrap - see Services/ThreadBootstrap.ts.
 *
 * `runTurnStart` is the WebSocket path's bootstrap, moved here unchanged so
 * child threads can share its pieces. `startChild` is the staged version:
 *
 * 1. create: `thread.create` with the child's id, unless it exists.
 * 2. worktree: a worktree on the request's branch, reusing one an
 *    interrupted run left, then `thread.meta.update`. Skipped once the thread
 *    has a worktree, and for children working in the project folder.
 * 3. setup: the project's setup script, launched once. Done when the thread
 *    has a `setup-script.started`, `.skipped` or `.failed` activity; the
 *    runner starts the script in a terminal and returns, so nothing waits on
 *    it, and a launched script is never launched again.
 * 4. turn: `thread.turn.start` with the request's message. Its receipt is the
 *    proof the whole setup is done.
 *
 * Every command id derives from the request (childRequestIds.ts), so a
 * command a crashed run already got through is answered from its receipt.
 *
 * @module ThreadBootstrapLive
 */
import {
  CommandId,
  EventId,
  OrchestrationDispatchCommandError,
  type OrchestrationThread,
} from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../../project/Services/ProjectSetupScriptRunner.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { childRequestCommandId, childWorktreeBranch, derivedUuid } from "../childRequestIds.ts";
import { OrchestrationCommandPreviouslyRejectedError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ChildBootstrapError,
  type ChildBootstrapInput,
  type ChildBootstrapStage,
  ThreadBootstrap,
  type ThreadBootstrapShape,
  type ThreadTurnStartCommand,
} from "../Services/ThreadBootstrap.ts";
import {
  BootstrapTurnStartRuns,
  BootstrapTurnStartRunsLive,
  makeSingleFlight,
} from "./BootstrapTurnStartRuns.ts";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** Activities that mark a child's setup stage done; see the module comment. */
const SETUP_DONE_KINDS: ReadonlySet<string> = new Set([
  "setup-script.started",
  "setup-script.skipped",
  "setup-script.failed",
]);

/** An error's own words: a decider's or git's detail, else its message. */
const plainDetail = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    if ("detail" in error && typeof error.detail === "string" && error.detail.trim() !== "") {
      return error.detail.trim();
    }
    if ("message" in error && typeof error.message === "string" && error.message.trim() !== "") {
      return error.message.trim();
    }
  }
  return "unknown error";
};

const STAGE_FAILURE: Record<ChildBootstrapStage, string> = {
  create: "Couldn't create the thread",
  worktree: "Couldn't set up its worktree",
  setup: "Couldn't run its setup script",
  turn: "Couldn't start its first turn",
};

const stageError = (stage: ChildBootstrapStage) => (cause: unknown) =>
  new ChildBootstrapError({
    stage,
    detail: `${STAGE_FAILURE[stage]}: ${plainDetail(cause)}`,
    cause,
  });

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
  const bootstrapTurnStartRuns = yield* BootstrapTurnStartRuns;
  const childRuns = yield* makeSingleFlight<
    string,
    { readonly sequence: number },
    ChildBootstrapError
  >();

  const serverCommandId = (tag: string) => CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

  const appendThreadActivity = (input: {
    readonly threadId: ThreadTurnStartCommand["threadId"];
    readonly kind: string;
    readonly summary: string;
    readonly createdAt: string;
    readonly payload: Record<string, unknown>;
    readonly tone: "info" | "error";
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("setup-script-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: input.tone,
        kind: input.kind,
        summary: input.summary,
        payload: input.payload,
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const appendSetupScriptActivity = (input: {
    readonly threadId: ThreadTurnStartCommand["threadId"];
    readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
    readonly summary: string;
    readonly createdAt: string;
    readonly payload: Record<string, unknown>;
    readonly tone: "info" | "error";
  }) => appendThreadActivity(input);

  const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
    isOrchestrationDispatchCommandError(cause)
      ? cause
      : new OrchestrationDispatchCommandError({
          message: cause instanceof Error ? cause.message : fallbackMessage,
          cause,
        });

  const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
    const error = Cause.squash(cause);
    return isOrchestrationDispatchCommandError(error)
      ? error
      : new OrchestrationDispatchCommandError({
          message:
            error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
          cause,
        });
  };

  const refreshGitStatus = (cwd: string) =>
    vcsStatusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  // ---------------------------------------------------------------------------
  // The WebSocket path
  // ---------------------------------------------------------------------------

  // The client re-sends a command whose socket dropped or whose response
  // was slow, so the whole bootstrap has to be idempotent under the
  // command id: a retry joins the run in flight, and a retry that lands
  // after the run finished is answered from the receipt the final turn
  // start left, exactly as a plain dispatch would answer it.
  const runBootstrapTurnStart = (
    command: ThreadTurnStartCommand,
  ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
    Effect.gen(function* () {
      const receipt = yield* orchestrationEngine
        .getCommandReceipt(command.commandId)
        .pipe(
          Effect.mapError((cause) =>
            toDispatchCommandError(cause, "Failed to read orchestration command receipt"),
          ),
        );
      if (Option.isSome(receipt)) {
        if (receipt.value.status === "accepted") {
          return { sequence: receipt.value.resultSequence };
        }
        return yield* toDispatchCommandError(
          new OrchestrationCommandPreviouslyRejectedError({
            commandId: command.commandId,
            detail: receipt.value.error ?? "Previously rejected.",
          }),
          "Command previously rejected.",
        );
      }

      const bootstrap = command.bootstrap;
      const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
      let createdThread = false;
      let targetProjectId = bootstrap?.createThread?.projectId;
      let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
      let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

      const recordBootstrapFailure = (dispatchError: OrchestrationDispatchCommandError) =>
        Effect.gen(function* () {
          const failedAt = yield* nowIso;
          const detail = dispatchError.message.trim() || "Failed to bootstrap thread turn.";
          const requestedModelSelection =
            finalTurnStartCommand.modelSelection ?? bootstrap?.createThread?.modelSelection;

          yield* appendThreadActivity({
            threadId: command.threadId,
            kind: "bootstrap.turn-start.failed",
            summary: "Thread bootstrap failed",
            createdAt: failedAt,
            payload: {
              detail,
              message: finalTurnStartCommand.message,
              modelSelection: requestedModelSelection ?? null,
              runtimeMode: finalTurnStartCommand.runtimeMode,
              interactionMode: finalTurnStartCommand.interactionMode,
              prepareWorktree: bootstrap?.prepareWorktree ?? null,
              worktreePath: targetWorktreePath,
            },
            tone: "error",
          }).pipe(Effect.ignoreCause({ log: true }));

          yield* orchestrationEngine
            .dispatch({
              type: "thread.session.set",
              commandId: serverCommandId("bootstrap-session-error"),
              threadId: command.threadId,
              session: {
                threadId: command.threadId,
                status: "error",
                providerName: null,
                ...(requestedModelSelection
                  ? { providerInstanceId: requestedModelSelection.instanceId }
                  : {}),
                providerSessionId: null,
                providerThreadId: null,
                runtimeMode: finalTurnStartCommand.runtimeMode,
                activeTurnId: null,
                pendingBackgroundTaskCount: 0,
                lastError: detail,
                updatedAt: failedAt,
              },
              createdAt: failedAt,
            })
            .pipe(Effect.ignoreCause({ log: true }));
        });

      const recordSetupScriptLaunchFailure = (input: {
        readonly error: unknown;
        readonly requestedAt: string;
        readonly worktreePath: string;
      }) => {
        const detail =
          input.error instanceof Error ? input.error.message : "Unknown setup failure.";
        return appendSetupScriptActivity({
          threadId: command.threadId,
          kind: "setup-script.failed",
          summary: "Setup script failed to start",
          createdAt: input.requestedAt,
          payload: {
            detail,
            worktreePath: input.worktreePath,
          },
          tone: "error",
        }).pipe(
          Effect.ignoreCause({ log: false }),
          Effect.flatMap(() =>
            Effect.logWarning("bootstrap turn start failed to launch setup script", {
              threadId: command.threadId,
              worktreePath: input.worktreePath,
              detail,
            }),
          ),
        );
      };

      const recordSetupScriptStarted = (input: {
        readonly requestedAt: string;
        readonly worktreePath: string;
        readonly scriptId: string;
        readonly scriptName: string;
        readonly terminalId: string;
      }) =>
        Effect.gen(function* () {
          const startedAt = yield* nowIso;
          const payload = {
            scriptId: input.scriptId,
            scriptName: input.scriptName,
            terminalId: input.terminalId,
            worktreePath: input.worktreePath,
          };
          yield* Effect.all([
            appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.requested",
              summary: "Starting setup script",
              createdAt: input.requestedAt,
              payload,
              tone: "info",
            }),
            appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.started",
              summary: "Setup script started",
              createdAt: startedAt,
              payload,
              tone: "info",
            }),
          ]).pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              Effect.logWarning(
                "bootstrap turn start launched setup script but failed to record setup activity",
                {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  scriptId: input.scriptId,
                  terminalId: input.terminalId,
                  detail: error.message,
                },
              ),
            ),
          );
        });

      const runSetupProgram = () =>
        Effect.gen(function* () {
          if (!bootstrap?.runSetupScript || !targetWorktreePath) {
            return;
          }
          const worktreePath = targetWorktreePath;
          const requestedAt = yield* nowIso;
          yield* projectSetupScriptRunner
            .runForThread({
              threadId: command.threadId,
              ...(targetProjectId ? { projectId: targetProjectId } : {}),
              ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
              worktreePath,
            })
            .pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  recordSetupScriptLaunchFailure({
                    error,
                    requestedAt,
                    worktreePath,
                  }),
                onSuccess: (setupResult) => {
                  if (setupResult.status !== "started") {
                    return Effect.void;
                  }
                  return recordSetupScriptStarted({
                    requestedAt,
                    worktreePath,
                    scriptId: setupResult.scriptId,
                    scriptName: setupResult.scriptName,
                    terminalId: setupResult.terminalId,
                  });
                },
              }),
            );
        });

      const bootstrapProgram = Effect.gen(function* () {
        if (bootstrap?.createThread) {
          yield* orchestrationEngine.dispatch({
            type: "thread.create",
            commandId: serverCommandId("bootstrap-thread-create"),
            threadId: command.threadId,
            projectId: bootstrap.createThread.projectId,
            title: bootstrap.createThread.title,
            modelSelection: bootstrap.createThread.modelSelection,
            runtimeMode: bootstrap.createThread.runtimeMode,
            interactionMode: bootstrap.createThread.interactionMode,
            branch: bootstrap.createThread.branch,
            worktreePath: bootstrap.createThread.worktreePath,
            ...(bootstrap.createThread.participants !== undefined
              ? { participants: bootstrap.createThread.participants }
              : {}),
            ...(bootstrap.createThread.agentRole !== undefined
              ? { agentRole: bootstrap.createThread.agentRole }
              : {}),
            createdAt: bootstrap.createThread.createdAt,
          });
          createdThread = true;
        }

        if (bootstrap?.prepareWorktree) {
          // "From main" means the latest main: start from the upstream
          // when the local branch has fallen behind it.
          const base = yield* gitWorkflow.resolveFreshWorktreeBase({
            cwd: bootstrap.prepareWorktree.projectCwd,
            branch: bootstrap.prepareWorktree.baseBranch,
          });
          const worktree = yield* gitWorkflow.createWorktree({
            cwd: bootstrap.prepareWorktree.projectCwd,
            refName: base.refName,
            newRefName: bootstrap.prepareWorktree.branch,
            path: null,
          });
          targetWorktreePath = worktree.worktree.path;
          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: serverCommandId("bootstrap-thread-meta-update"),
            threadId: command.threadId,
            branch: worktree.worktree.refName,
            worktreePath: targetWorktreePath,
          });
          yield* refreshGitStatus(targetWorktreePath);
        }

        yield* runSetupProgram();

        return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
      });

      return yield* bootstrapProgram.pipe(
        Effect.catchCause((cause) => {
          const dispatchError = toBootstrapDispatchCommandCauseError(cause);
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.fail(dispatchError);
          }
          return (createdThread ? recordBootstrapFailure(dispatchError) : Effect.void).pipe(
            Effect.flatMap(() => Effect.fail(dispatchError)),
          );
        }),
      );
    });

  const runTurnStart: ThreadBootstrapShape["runTurnStart"] = (command) =>
    bootstrapTurnStartRuns.run(command.commandId, runBootstrapTurnStart(command));

  // ---------------------------------------------------------------------------
  // Child threads
  // ---------------------------------------------------------------------------

  /** The child as the read model has it; archived and deleted threads read as gone. */
  const readChild = (input: ChildBootstrapInput, stage: ChildBootstrapStage) =>
    projectionSnapshotQuery
      .getThreadDetailById(input.childThreadId)
      .pipe(Effect.map(Option.getOrUndefined), Effect.mapError(stageError(stage)));

  const goneError = (stage: ChildBootstrapStage) =>
    new ChildBootstrapError({
      stage,
      detail: `${STAGE_FAILURE[stage]}: the thread was archived or deleted while it was being set up.`,
    });

  /** Stage 1: the thread, created once. */
  const ensureChildThread = (input: ChildBootstrapInput) =>
    Effect.gen(function* () {
      const existing = yield* readChild(input, "create");
      if (existing !== undefined) {
        return existing;
      }
      const { launch } = input;
      yield* orchestrationEngine
        .dispatch({
          type: "thread.create",
          commandId: childRequestCommandId(input.requestId, "create"),
          threadId: input.childThreadId,
          projectId: input.projectId,
          title: launch.title,
          modelSelection: launch.modelSelection,
          runtimeMode: launch.runtimeMode,
          interactionMode: launch.interactionMode,
          branch: null,
          worktreePath: null,
          parentThreadId: input.parentThreadId,
          parentTurnId: input.parentTurnId,
          attachedToParent: launch.reportBack,
          createdAt: input.createdAt,
        })
        .pipe(Effect.mapError(stageError("create")));
      const created = yield* readChild(input, "create");
      if (created === undefined) {
        return yield* goneError("create");
      }
      return created;
    });

  /**
   * Stage 2: the child's own worktree. A worktree already on the request's
   * branch is one an interrupted run made; so is the branch alone, if git
   * stopped between making the branch and checking it out.
   */
  const ensureChildWorktree = (input: ChildBootstrapInput, thread: OrchestrationThread) =>
    Effect.gen(function* () {
      const workspace = input.launch.workspace;
      if (workspace.kind !== "worktree" || thread.worktreePath !== null) {
        return thread;
      }
      const cwd = workspace.projectCwd;
      const branch = childWorktreeBranch(input.requestId);
      const existing = (yield* gitWorkflow.listWorktrees({ cwd })).find(
        (entry) => entry.branch === branch,
      );
      let worktree: { readonly path: string; readonly refName: string };
      if (existing !== undefined) {
        worktree = { path: existing.path, refName: branch };
      } else {
        const refs = yield* gitWorkflow.listRefs({ cwd, query: branch, refresh: true });
        const branchExists = refs.refs.some((ref) => ref.name === branch && ref.isRemote !== true);
        const created = yield* gitWorkflow.createWorktree(
          branchExists
            ? { cwd, refName: branch, path: null }
            : { cwd, refName: workspace.baseRef, newRefName: branch, path: null },
        );
        worktree = created.worktree;
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: childRequestCommandId(input.requestId, "meta"),
        threadId: input.childThreadId,
        branch: worktree.refName,
        worktreePath: worktree.path,
      });
      yield* refreshGitStatus(worktree.path);
      return { ...thread, branch: worktree.refName, worktreePath: worktree.path };
    }).pipe(Effect.mapError(stageError("worktree")));

  /** One setup activity, with ids fixed by the request so a retry records it once. */
  const appendChildSetupActivity = (
    input: ChildBootstrapInput,
    activity: {
      readonly kind:
        | "setup-script.requested"
        | "setup-script.started"
        | "setup-script.skipped"
        | "setup-script.failed";
      readonly summary: string;
      readonly tone: "info" | "error";
      readonly payload: Record<string, unknown>;
      readonly createdAt: string;
    },
  ) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: childRequestCommandId(input.requestId, activity.kind),
      threadId: input.childThreadId,
      activity: {
        id: EventId.make(derivedUuid("child-setup-activity", input.requestId, activity.kind)),
        tone: activity.tone,
        kind: activity.kind,
        summary: activity.summary,
        payload: activity.payload,
        turnId: null,
        createdAt: activity.createdAt,
      },
      createdAt: activity.createdAt,
    });

  /** Stage 3: the setup script, launched at most once. */
  const ensureChildSetup = (input: ChildBootstrapInput, thread: OrchestrationThread) =>
    Effect.gen(function* () {
      if (thread.activities.some((activity) => SETUP_DONE_KINDS.has(activity.kind))) {
        return;
      }
      const requestedAt = yield* nowIso;
      const skip = (reason: string) =>
        appendChildSetupActivity(input, {
          kind: "setup-script.skipped",
          summary: "Setup script skipped",
          tone: "info",
          payload: { reason },
          createdAt: requestedAt,
        });
      const worktreePath = thread.worktreePath;
      if (!input.launch.runSetup) {
        return yield* skip("not-requested");
      }
      if (input.launch.workspace.kind !== "worktree" || worktreePath === null) {
        return yield* skip("no-worktree");
      }
      const launched = yield* projectSetupScriptRunner
        .runForThread({
          threadId: input.childThreadId,
          projectId: input.projectId,
          projectCwd: input.launch.workspace.projectCwd,
          worktreePath,
        })
        .pipe(Effect.result);
      if (launched._tag === "Failure") {
        yield* appendChildSetupActivity(input, {
          kind: "setup-script.failed",
          summary: "Setup script failed to start",
          tone: "error",
          payload: { detail: launched.failure.message, worktreePath },
          createdAt: requestedAt,
        });
        return;
      }
      if (launched.success.status !== "started") {
        return yield* skip("no-script");
      }
      const payload = {
        scriptId: launched.success.scriptId,
        scriptName: launched.success.scriptName,
        terminalId: launched.success.terminalId,
        worktreePath,
      };
      yield* appendChildSetupActivity(input, {
        kind: "setup-script.requested",
        summary: "Starting setup script",
        tone: "info",
        payload,
        createdAt: requestedAt,
      });
      yield* appendChildSetupActivity(input, {
        kind: "setup-script.started",
        summary: "Setup script started",
        tone: "info",
        payload,
        createdAt: yield* nowIso,
      });
    }).pipe(Effect.asVoid, Effect.mapError(stageError("setup")));

  /** Stage 4: the first turn, answering the request. */
  const startChildTurn = (input: ChildBootstrapInput) =>
    Effect.gen(function* () {
      const { launch } = input;
      return yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: childRequestCommandId(input.requestId, "turn"),
        threadId: input.childThreadId,
        message: {
          messageId: input.childMessageId,
          role: "user",
          text: launch.prompt,
          attachments: [],
        },
        modelSelection: launch.modelSelection,
        runtimeMode: launch.runtimeMode,
        interactionMode: launch.interactionMode,
        fromThread: input.fromThread,
        createdAt: yield* nowIso,
      });
    }).pipe(Effect.mapError(stageError("turn")));

  const runChild = (input: ChildBootstrapInput) =>
    Effect.gen(function* () {
      // The first turn's receipt means an earlier run finished everything.
      const turnReceipt = yield* orchestrationEngine
        .getCommandReceipt(childRequestCommandId(input.requestId, "turn"))
        .pipe(Effect.mapError(stageError("turn")));
      if (Option.isSome(turnReceipt)) {
        if (turnReceipt.value.status === "accepted") {
          return { sequence: turnReceipt.value.resultSequence };
        }
        return yield* stageError("turn")({
          detail: turnReceipt.value.error ?? "it was refused earlier.",
        });
      }
      const created = yield* ensureChildThread(input);
      const placed = yield* ensureChildWorktree(input, created);
      yield* ensureChildSetup(input, placed);
      return yield* startChildTurn(input);
    });

  const startChild: ThreadBootstrapShape["startChild"] = (input) =>
    childRuns.run(input.requestId, runChild(input));

  return { runTurnStart, startChild } satisfies ThreadBootstrapShape;
});

/**
 * One instance serves the WebSocket routes and the reactor: a retried turn
 * start must find the run in flight whichever socket it arrives on.
 */
export const ThreadBootstrapLive = Layer.effect(ThreadBootstrap, make).pipe(
  Layer.provide(BootstrapTurnStartRunsLive),
);
