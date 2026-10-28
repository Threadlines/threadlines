/**
 * ThreadBootstrap - see Services/ThreadBootstrap.ts.
 *
 * Both callers build a setup plan and hand it to one staged run
 * (docs/design/thread-setup-state.md):
 *
 * 1. worktree: a worktree on the plan's branch, reusing one an interrupted
 *    run left (or its branch alone, if git stopped between making the branch
 *    and checking it out). Skipped for a thread that has one, and for work in
 *    the project folder. Nothing is recorded: the thread doesn't exist yet.
 * 2. start: `thread.start`, one decision that makes the thread (or gives one
 *    made earlier without a message its checkout), records the setup
 *    script's claim and starts the first work: a turn, or a goal set on a
 *    draft. Its receipt is the first work's; an accepted one means the whole
 *    setup is done.
 * 3. the setup script, launched after the start by the run that committed
 *    it. The claim came with the start, so it launches at most once: a run
 *    that finds the start already accepted never launches it, and a crash
 *    between the two skips it. It never fails the setup.
 *
 * Every id derives from the plan's key (the client's command id, or the
 * request's; childRequestIds.ts), so a command a crashed run already got
 * through is answered from its receipt.
 *
 * @module ThreadBootstrapLive
 */
import {
  type ChildThreadLaunch,
  CommandId,
  EventId,
  OrchestrationDispatchCommandError,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProjectId,
  type ThreadBootstrapCreateThread,
  type ThreadId,
} from "@threadlines/contracts";
import { worktreeFolderNameForBranch } from "@threadlines/shared/git";
import { setupProjectScript } from "@threadlines/shared/projectScripts";
import { basename, join } from "node:path";

import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../../project/Services/ProjectSetupScriptRunner.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import {
  childRequestCommandId,
  childWorktreeBranch,
  derivedUuid,
  firstSendWorktreeBranch,
} from "../childRequestIds.ts";
import { withinModeCeiling } from "../childThreadDecisions.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ChildBootstrapError,
  type ChildBootstrapInput,
  type ChildBootstrapStage,
  ThreadBootstrap,
  type ThreadBootstrapShape,
  type ThreadGoalSetCommand,
  type ThreadTurnStartCommand,
} from "../Services/ThreadBootstrap.ts";
import {
  BootstrapTurnStartRuns,
  BootstrapTurnStartRunsLive,
  makeSingleFlight,
} from "./BootstrapTurnStartRuns.ts";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Setup activities an older build recorded on a thread it left half-made:
 * its script was claimed (or settled) then, and is never launched again.
 */
const SETUP_DONE_KINDS: ReadonlySet<string> = new Set([
  "setup-script.requested",
  "setup-script.started",
  "setup-script.skipped",
  "setup-script.failed",
]);

/**
 * The reason git locks a worktree with while `git worktree add` makes it
 * (untranslated: GitVcsDriver runs the add with `LC_ALL=C`).
 */
const GIT_ADDING_LOCK_REASON = "initializing";

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
  worktree: "Couldn't set up its worktree",
  turn: "Couldn't start its first turn",
};

/** A setup stopped at `stage`, with what stopped it. */
class SetupStageFailure extends Data.TaggedError("SetupStageFailure")<{
  readonly stage: ChildBootstrapStage;
  readonly cause: unknown;
}> {}

/** A worktree on a setup's branch that someone locked on purpose: left alone. */
class LockedWorktreeError extends Data.TaggedError("LockedWorktreeError")<{
  readonly path: string;
  readonly reason: string;
}> {
  get detail(): string {
    return `${this.path} is locked (${this.reason || "no reason given"}). Unlock or remove it, then try again.`;
  }
}

const failedAt = (stage: ChildBootstrapStage) => (cause: unknown) =>
  new SetupStageFailure({ stage, cause });

/**
 * Logs and drops a step's failure or defect, never an interruption: the
 * server stopping mid-step still stops the run, which then resumes.
 */
const logFailures =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning(message, { cause: Cause.pretty(cause) }),
      ),
    );

/** Where a setup cuts its worktree from. */
type WorktreeBase =
  /** The latest of a branch: its upstream when the local one has fallen behind. */
  | { readonly kind: "fresh"; readonly branch: string }
  /** Exactly this ref (a child's launch saved it when it was asked for). */
  | { readonly kind: "ref"; readonly ref: string };

/** Everything one setup needs, whichever caller asked for it. */
interface SetupPlan {
  readonly threadId: ThreadId;
  /** Ids for the steps after the start, fixed by the plan's key. */
  readonly ids: {
    readonly command: (step: string) => CommandId;
    readonly activity: (kind: string) => EventId;
  };
  /** The thread to make; absent when the caller only names one that exists. */
  readonly create: ThreadBootstrapCreateThread | undefined;
  readonly worktree:
    | {
        readonly projectCwd: string;
        readonly branch: string;
        readonly base: WorktreeBase;
      }
    | undefined;
  readonly runSetup: boolean;
  /**
   * The first work (a turn, or a goal set on a draft); its command id is the
   * start's, and its receipt the setup's.
   */
  readonly first:
    | Omit<ThreadTurnStartCommand, "bootstrap">
    | Omit<ThreadGoalSetCommand, "bootstrap">;
  /** Before each stage: fails to stop the setup there. */
  readonly proceed: (stage: ChildBootstrapStage) => Effect.Effect<void, SetupStageFailure>;
  /** A thread that already exists is brought within the plan first (a child's modes). */
  readonly fitExisting?: (
    thread: OrchestrationThread,
  ) => Effect.Effect<OrchestrationThread, SetupStageFailure>;
}

/** The worktree a setup works in, and whether this run made it (and its branch). */
interface PlacedWorktree {
  readonly path: string;
  readonly branch: string;
  readonly madeWorktree: boolean;
  readonly madeBranch: boolean;
}

const make = Effect.gen(function* () {
  const { worktreesDir } = yield* ServerConfig;
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

  const refreshGitStatus = (cwd: string) =>
    vcsStatusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  /** The thread as the read model has it; archived and deleted threads read as gone. */
  const readThread = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrUndefined));

  // ---------------------------------------------------------------------------
  // The stages
  // ---------------------------------------------------------------------------

  /**
   * Stage 1: the plan's worktree, made once. Its branch is the plan's alone
   * (named from the plan's key), so one already on it is an earlier run's:
   *
   * - unlocked: that run made it; it is used.
   * - locked `initializing`: git was still adding it when a crash cut it
   *   short, so it may be half checked out. Nothing has worked in it (the
   *   thread doesn't exist yet), so it goes, and the worktree is made again.
   * - locked for any other reason: someone pinned it on purpose; it is left
   *   alone and the setup stops, saying so.
   *
   * A worktree made again from a branch an earlier run left gets a folder of
   * its own, never the usual one: a cut-off git may still be running there
   * and clean that folder up when it fails.
   */
  const ensureWorktree = (worktree: NonNullable<SetupPlan["worktree"]>) =>
    Effect.gen(function* () {
      const cwd = worktree.projectCwd;
      const existing = (yield* gitWorkflow.listWorktrees({ cwd })).find(
        (entry) => entry.branch === worktree.branch,
      );
      if (existing !== undefined) {
        if (existing.lockReason === undefined) {
          return {
            path: existing.path,
            branch: worktree.branch,
            madeWorktree: false,
            madeBranch: false,
          } satisfies PlacedWorktree;
        }
        if (existing.lockReason !== GIT_ADDING_LOCK_REASON) {
          return yield* new LockedWorktreeError({
            path: existing.path,
            reason: existing.lockReason,
          });
        }
        yield* gitWorkflow.removeWorktree({ cwd, path: existing.path, force: true, unlock: true });
      }
      const refs = yield* gitWorkflow.listRefs({ cwd, query: worktree.branch, refresh: true });
      const branchExists = refs.refs.some(
        (ref) => ref.name === worktree.branch && ref.isRemote !== true,
      );
      const created = branchExists
        ? yield* gitWorkflow.createWorktree({
            cwd,
            refName: worktree.branch,
            path: `${join(worktreesDir, basename(cwd), worktreeFolderNameForBranch(worktree.branch))}-${crypto.randomUUID().slice(0, 4)}`,
          })
        : yield* gitWorkflow.createWorktree({
            cwd,
            refName:
              worktree.base.kind === "ref"
                ? worktree.base.ref
                : (yield* gitWorkflow.resolveFreshWorktreeBase({
                    cwd,
                    branch: worktree.base.branch,
                  })).refName,
            newRefName: worktree.branch,
            path: null,
          });
      yield* refreshGitStatus(created.worktree.path);
      return {
        path: created.worktree.path,
        branch: created.worktree.refName,
        madeWorktree: true,
        madeBranch: !branchExists,
      } satisfies PlacedWorktree;
    });

  /**
   * A start the decider refused for good leaves no thread to hold the
   * worktree this run made: it goes, and its branch with it, without force,
   * so one with anything in it stays. One this run found is never touched.
   */
  const removeMadeWorktree = (projectCwd: string, placed: PlacedWorktree) =>
    Effect.gen(function* () {
      if (!placed.madeWorktree) {
        return;
      }
      yield* gitWorkflow.removeWorktree({ cwd: projectCwd, path: placed.path, force: false });
      if (placed.madeBranch) {
        yield* gitWorkflow.deleteBranch({ cwd: projectCwd, branchName: placed.branch });
      }
    }).pipe(logFailures("thread setup could not remove the worktree of a refused start"));

  /**
   * The setup script's claim, made part of the start: only when the plan asks
   * for setup in a worktree, the project has a script to run there, and an
   * older build's run hasn't claimed it already.
   */
  const setupClaimFor = (
    plan: SetupPlan,
    projectId: ProjectId,
    existing: OrchestrationThread | undefined,
    worktreePath: string | null,
  ) =>
    Effect.gen(function* () {
      if (!plan.runSetup || worktreePath === null) {
        return undefined;
      }
      if (existing?.activities.some((activity) => SETUP_DONE_KINDS.has(activity.kind))) {
        return undefined;
      }
      const project = yield* projectionSnapshotQuery
        .getProjectShellById(projectId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (project === undefined || setupProjectScript(project.scripts) === null) {
        return undefined;
      }
      return {
        id: plan.ids.activity("setup-script.requested"),
        tone: "info",
        kind: "setup-script.requested",
        summary: "Starting setup script",
        payload: { worktreePath },
        turnId: null,
        createdAt: yield* nowIso,
      } satisfies OrchestrationThreadActivity;
    });

  /** One setup activity after the start, with ids fixed by the plan. */
  const appendSetupActivity = (
    plan: SetupPlan,
    activity: {
      readonly kind: "setup-script.started" | "setup-script.skipped" | "setup-script.failed";
      readonly summary: string;
      readonly tone: "info" | "error";
      readonly payload: Record<string, unknown>;
    },
  ) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: plan.ids.command(activity.kind),
        threadId: plan.threadId,
        activity: {
          id: plan.ids.activity(activity.kind),
          tone: activity.tone,
          kind: activity.kind,
          summary: activity.summary,
          payload: activity.payload,
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    });

  /** Stage 3: the claimed setup script, started in a terminal; nothing waits on it. */
  const launchSetupScript = (plan: SetupPlan, projectId: ProjectId, worktreePath: string) =>
    Effect.gen(function* () {
      const launched = yield* projectSetupScriptRunner
        .runForThread({
          threadId: plan.threadId,
          projectId,
          ...(plan.worktree !== undefined ? { projectCwd: plan.worktree.projectCwd } : {}),
          worktreePath,
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(launched)) {
        // The server stopping is not the script failing to start.
        if (Cause.hasInterrupts(launched.cause)) {
          return yield* Effect.interrupt;
        }
        const detail = plainDetail(Cause.squash(launched.cause));
        yield* Effect.logWarning("thread setup could not launch its setup script", {
          threadId: plan.threadId,
          worktreePath,
          detail,
        });
        return yield* appendSetupActivity(plan, {
          kind: "setup-script.failed",
          summary: "Setup script failed to start",
          tone: "error",
          payload: { detail, worktreePath },
        });
      }
      if (launched.value.status !== "started") {
        // Its script was removed in the moment since the claim.
        return yield* appendSetupActivity(plan, {
          kind: "setup-script.skipped",
          summary: "Setup script skipped",
          tone: "info",
          payload: { reason: "no-script" },
        });
      }
      yield* appendSetupActivity(plan, {
        kind: "setup-script.started",
        summary: "Setup script started",
        tone: "info",
        payload: {
          scriptId: launched.value.scriptId,
          scriptName: launched.value.scriptName,
          terminalId: launched.value.terminalId,
          worktreePath,
        },
      });
    }).pipe(logFailures("thread setup could not record its setup script"));

  /** The whole setup, from wherever an earlier run of the same plan stopped. */
  const runSetup = (plan: SetupPlan) =>
    Effect.gen(function* () {
      const startId = plan.first.commandId;
      // Accepted: the thread, its claim and its first work landed together,
      // and the run that made them launched the script.
      const receipt = yield* orchestrationEngine
        .getCommandReceipt(startId)
        .pipe(Effect.mapError(failedAt("turn")));
      if (Option.isSome(receipt)) {
        if (receipt.value.status === "accepted") {
          return { sequence: receipt.value.resultSequence };
        }
        return yield* failedAt("turn")(
          new OrchestrationCommandPreviouslyRejectedError({
            commandId: startId,
            detail: receipt.value.error ?? "Previously rejected.",
          }),
        );
      }

      yield* plan.proceed("worktree");
      const found = yield* readThread(plan.threadId).pipe(Effect.mapError(failedAt("worktree")));
      const existing =
        found !== undefined && plan.fitExisting !== undefined
          ? yield* plan.fitExisting(found)
          : found;
      const placed =
        plan.worktree === undefined || (existing?.worktreePath ?? null) !== null
          ? undefined
          : yield* ensureWorktree(plan.worktree).pipe(Effect.mapError(failedAt("worktree")));

      yield* plan.proceed("turn");
      const projectId = existing?.projectId ?? plan.create?.projectId;
      const worktreePath =
        placed?.path ?? existing?.worktreePath ?? plan.create?.worktreePath ?? null;
      const claim =
        projectId === undefined
          ? undefined
          : yield* setupClaimFor(plan, projectId, existing, worktreePath).pipe(
              Effect.mapError(failedAt("turn")),
            );
      const started = yield* orchestrationEngine
        .dispatch({
          type: "thread.start",
          commandId: startId,
          threadId: plan.threadId,
          ...(existing === undefined && plan.create !== undefined
            ? {
                create: {
                  ...plan.create,
                  ...(placed !== undefined
                    ? { branch: placed.branch, worktreePath: placed.path }
                    : {}),
                },
              }
            : {}),
          ...(existing !== undefined && placed !== undefined
            ? { checkout: { branch: placed.branch, worktreePath: placed.path } }
            : {}),
          ...(claim !== undefined ? { setupScriptClaim: claim } : {}),
          first: plan.first,
        })
        .pipe(
          Effect.tapError((error) =>
            placed !== undefined &&
            plan.worktree !== undefined &&
            isOrchestrationCommandInvariantError(error)
              ? removeMadeWorktree(plan.worktree.projectCwd, placed)
              : Effect.void,
          ),
          Effect.mapError(failedAt("turn")),
        );
      if (claim !== undefined && projectId !== undefined && worktreePath !== null) {
        yield* launchSetupScript(plan, projectId, worktreePath);
      }
      return started;
    });

  // ---------------------------------------------------------------------------
  // A client's first send
  // ---------------------------------------------------------------------------

  // The client re-sends a command whose socket dropped or whose response was
  // slow, so the setup is keyed by the command id: a retry joins the run in
  // flight, finishes one a restart cut off, or is answered from the receipt
  // the start left, exactly as a plain dispatch would answer it.
  const clientPlan = (command: ThreadTurnStartCommand | ThreadGoalSetCommand): SetupPlan => {
    const { bootstrap, ...first } = command;
    const key = command.commandId;
    const prepare = bootstrap?.prepareWorktree;
    return {
      threadId: command.threadId,
      ids: {
        command: (step) => CommandId.make(`server:first-send:${key}:${step}`),
        activity: (kind) => EventId.make(derivedUuid("first-send-setup-activity", key, kind)),
      },
      create: bootstrap?.createThread,
      worktree:
        prepare === undefined
          ? undefined
          : {
              projectCwd: prepare.projectCwd,
              // Named by the command, not the client, so no other setup can
              // ever find, use or remove this run's worktree.
              branch: firstSendWorktreeBranch(key),
              base: { kind: "fresh", branch: prepare.baseBranch },
            },
      runSetup: bootstrap?.runSetupScript === true,
      first,
      proceed: () => Effect.void,
    };
  };

  // Whatever stopped the setup (a stage's failure, or a defect in git), as
  // the error a plain dispatch would answer with. A refusal the caller acts
  // on by type (an outside agent's turn above its ceiling) keeps its type.
  const toDispatchCommandError = (failure: unknown) => {
    const cause = failure instanceof SetupStageFailure ? failure.cause : failure;
    return isOrchestrationDispatchCommandError(cause)
      ? cause
      : new OrchestrationDispatchCommandError({
          message: plainDetail(cause),
          ...(isOrchestrationCommandInvariantError(cause) && cause.refusal !== undefined
            ? { refusal: cause.refusal }
            : {}),
          cause,
        });
  };

  const runClientStart = (command: ThreadTurnStartCommand | ThreadGoalSetCommand) =>
    bootstrapTurnStartRuns.run(
      command.commandId,
      runSetup(clientPlan(command)).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.fail(toDispatchCommandError(Cause.squash(cause))),
        ),
      ),
    );

  // ---------------------------------------------------------------------------
  // Child threads
  // ---------------------------------------------------------------------------

  /**
   * A child an older build created before its first turn keeps the access it
   * was created with; the launch may have been narrowed since (its parent's
   * access went down). It is narrowed to the launch before anything runs.
   */
  const narrowChildModes = (input: ChildBootstrapInput, thread: OrchestrationThread) =>
    Effect.gen(function* () {
      if (withinModeCeiling(thread, input.launch)) {
        return thread;
      }
      const at = yield* nowIso;
      if (thread.runtimeMode !== input.launch.runtimeMode) {
        yield* orchestrationEngine.dispatch({
          type: "thread.runtime-mode.set",
          commandId: childRequestCommandId(input.requestId, "narrow-runtime"),
          threadId: input.childThreadId,
          runtimeMode: input.launch.runtimeMode,
          createdAt: at,
        });
      }
      if (thread.interactionMode !== input.launch.interactionMode) {
        yield* orchestrationEngine.dispatch({
          type: "thread.interaction-mode.set",
          commandId: childRequestCommandId(input.requestId, "narrow-interaction"),
          threadId: input.childThreadId,
          interactionMode: input.launch.interactionMode,
          createdAt: at,
        });
      }
      return {
        ...thread,
        runtimeMode: input.launch.runtimeMode,
        interactionMode: input.launch.interactionMode,
      };
    });

  const childCreate = (
    input: ChildBootstrapInput,
    launch: ChildThreadLaunch,
  ): ThreadBootstrapCreateThread => ({
    projectId: input.projectId,
    title: launch.title,
    modelSelection: launch.modelSelection,
    runtimeMode: launch.runtimeMode,
    interactionMode: launch.interactionMode,
    branch: null,
    worktreePath: null,
    ...(input.lineage.kind === "local"
      ? {
          parentThreadId: input.lineage.parentThreadId,
          parentTurnId: input.lineage.parentTurnId,
          attachedToParent: launch.reportBack,
        }
      : input.lineage.kind === "remote"
        ? { remoteOrigin: input.lineage.remoteOrigin }
        : { scheduledRun: input.lineage.scheduledRun }),
    createdAt: input.createdAt,
  });

  const childPlan = (input: ChildBootstrapInput) =>
    Effect.gen(function* () {
      const { launch } = input;
      const workspace = launch.workspace;
      const checkpoint = input.checkpoint;
      return {
        threadId: input.childThreadId,
        ids: {
          command: (step) => childRequestCommandId(input.requestId, step),
          activity: (kind) =>
            EventId.make(derivedUuid("child-setup-activity", input.requestId, kind)),
        },
        create: childCreate(input, launch),
        worktree:
          workspace.kind === "worktree"
            ? {
                projectCwd: workspace.projectCwd,
                branch: childWorktreeBranch(input.requestId),
                base: { kind: "ref", ref: workspace.baseRef },
              }
            : undefined,
        runSetup: launch.runSetup,
        first: {
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
          ...(input.fromThread !== undefined ? { fromThread: input.fromThread } : {}),
          createdAt: yield* nowIso,
        },
        proceed: (stage) =>
          checkpoint === undefined
            ? Effect.void
            : checkpoint(stage).pipe(
                Effect.flatMap((go) =>
                  go ? Effect.void : Effect.fail(failedAt(stage)(new Error("it was cancelled."))),
                ),
              ),
        fitExisting: (thread) =>
          narrowChildModes(input, thread).pipe(Effect.mapError(failedAt("worktree"))),
      } satisfies SetupPlan;
    });

  const startChild: ThreadBootstrapShape["startChild"] = (input) =>
    childRuns.run(
      input.requestId,
      childPlan(input).pipe(
        Effect.flatMap(runSetup),
        Effect.mapError(
          (failure) =>
            new ChildBootstrapError({
              stage: failure.stage,
              detail: `${STAGE_FAILURE[failure.stage]}: ${plainDetail(failure.cause)}`,
              cause: failure.cause,
            }),
        ),
      ),
    );

  return {
    runTurnStart: runClientStart,
    runGoalStart: runClientStart,
    startChild,
  } satisfies ThreadBootstrapShape;
});

/**
 * One instance serves the WebSocket routes and the reactor: a retried turn
 * start must find the run in flight whichever socket it arrives on.
 */
export const ThreadBootstrapLive = Layer.effect(ThreadBootstrap, make).pipe(
  Layer.provide(BootstrapTurnStartRunsLive),
);
