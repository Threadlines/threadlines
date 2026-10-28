/**
 * ThreadBootstrap - setting a thread up and starting its first turn.
 *
 * Two callers, one staged run (docs/design/thread-setup-state.md): cut the
 * worktree, then make the thread with its first turn in one decision
 * (`thread.start`), then launch the setup script it claimed. No thread
 * exists before it can work where it should, and every stage checks durable
 * state first, so running the setup again after a cut (a crash, a restart)
 * finishes it and never makes a second thread, worktree or turn.
 *
 * - `runTurnStart` is a client's first send with a `bootstrap` (ws.ts, and
 *   outside agents' `thread_start`); `runGoalStart` a goal the client sets on
 *   a draft, the same setup with the goal as its first work. Their ids derive
 *   from the client's command id, whose receipt is the start's; a retry of
 *   the same command joins the run in flight, finishes an interrupted one, or
 *   is answered from the receipt.
 * - `startChild` sets up a thread an agent started (child threads,
 *   docs/design/child-threads.md), a scheduled task's run, or one a linked
 *   computer asked for (docs/design/fleet.md). Its ids derive from the
 *   request; its owner runs it again after a restart.
 *
 * @module ThreadBootstrap
 */
import type {
  ChildRequestId,
  ChildThreadLaunch,
  IsoDateTime,
  MessageId,
  OrchestrationCommand,
  OrchestrationDispatchCommandError,
  ProjectId,
  ThreadId,
  ThreadMessageOrigin,
  ThreadRemoteOrigin,
  ThreadScheduledRun,
  TurnId,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A turn start, as the client sends it (with an optional `bootstrap`). */
export type ThreadTurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

/** A goal set, as the client sends it (with an optional `bootstrap`). */
export type ThreadGoalSetCommand = Extract<OrchestrationCommand, { type: "thread.goal.set" }>;

/**
 * The stages of a child's setup, in order: its worktree, then its start (the
 * thread and its first turn together). The setup script after the start is
 * not a stage: nothing can stop it once the thread exists, and it never
 * fails the setup.
 */
export const ChildBootstrapStage = Schema.Literals(["worktree", "turn"]);
export type ChildBootstrapStage = typeof ChildBootstrapStage.Type;

/**
 * A child's setup stopped at `stage`. `detail` is one plain sentence fit to
 * show the agent that asked ("Couldn't create its worktree: ..."); running
 * `startChild` again resumes from this stage.
 */
export class ChildBootstrapError extends Schema.TaggedError<ChildBootstrapError>()(
  "ChildBootstrapError",
  {
    stage: ChildBootstrapStage,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Where a child comes from: a thread on this computer (it joins that family,
 * or starts separated when it reports nothing back), a thread on a linked
 * computer (docs/design/fleet.md), recorded as its remote origin, or a
 * scheduled task's run, recorded as such and in no family.
 */
export type ChildBootstrapLineage =
  | {
      readonly kind: "local";
      readonly parentThreadId: ThreadId;
      /** The parent's turn whose agent started it. */
      readonly parentTurnId: TurnId;
    }
  | { readonly kind: "remote"; readonly remoteOrigin: ThreadRemoteOrigin }
  | { readonly kind: "scheduled"; readonly scheduledRun: ThreadScheduledRun };

/** Everything a child's setup needs, all of it saved with its request. */
export interface ChildBootstrapInput {
  readonly lineage: ChildBootstrapLineage;
  readonly projectId: ProjectId;
  readonly requestId: ChildRequestId;
  readonly childThreadId: ThreadId;
  /** The first message's id: the turn it starts answers the request. */
  readonly childMessageId: MessageId;
  readonly launch: ChildThreadLaunch;
  /** The first message's origin, `kind: "request"`; none for a scheduled run. */
  readonly fromThread?: ThreadMessageOrigin | undefined;
  /** When the request was made; the child is created with this stamp. */
  readonly createdAt: IsoDateTime;
  /**
   * Asked before each stage: false stops the setup there (a request
   * cancelled meanwhile, docs/design/fleet.md rev 3); nothing is made after
   * the last one but the thread itself. Absent: always go on.
   */
  readonly checkpoint?: (stage: ChildBootstrapStage) => Effect.Effect<boolean>;
}

export interface ThreadBootstrapShape {
  /**
   * A client's turn start carrying a `bootstrap`: run it once per command id
   * (joining a run already in flight, finishing one a restart cut off, or
   * answering from the receipt) and resolve with the start's sequence. A
   * failure before the start leaves no thread; the caller has the reason.
   */
  readonly runTurnStart: (
    command: ThreadTurnStartCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
  /**
   * A goal set on a draft, carrying a `bootstrap`: the same setup as
   * `runTurnStart`, with the goal in the first turn's place, so the agent
   * starts on it in the thread's worktree and never in the project folder.
   */
  readonly runGoalStart: (
    command: ThreadGoalSetCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
  /**
   * Set a child thread up and start its first turn, resuming whatever an
   * earlier run of the same request left done. Resolves with the turn
   * start's sequence once it is accepted; does not wait for the turn.
   */
  readonly startChild: (
    input: ChildBootstrapInput,
  ) => Effect.Effect<{ readonly sequence: number }, ChildBootstrapError>;
}

export class ThreadBootstrap extends Context.Service<ThreadBootstrap, ThreadBootstrapShape>()(
  "threadlines/orchestration/Services/ThreadBootstrap",
) {}
