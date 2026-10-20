/**
 * ThreadBootstrap - setting a thread up and starting its first turn.
 *
 * Two callers, one sequence (create the thread, cut its worktree, launch the
 * setup script, start the turn):
 *
 * - `runTurnStart` is a client's first send with a `bootstrap` (ws.ts). It
 *   keeps the client's command id for the final turn start and random ids for
 *   the steps before it; a retry of the same command joins the run in flight
 *   or is answered from the receipt.
 * - `startChild` sets up a thread an agent started (child threads,
 *   docs/design/child-threads.md). It runs as stages, each checked against
 *   durable state before it acts and each with ids derived from the request,
 *   so a run cut off anywhere (a crash, a restart) is resumed by running it
 *   again and never makes a second thread, worktree or turn.
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
  TurnId,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A turn start, as the client sends it (with an optional `bootstrap`). */
export type ThreadTurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

/** The stages of a child's setup, in order. */
export const ChildBootstrapStage = Schema.Literals(["create", "worktree", "setup", "turn"]);
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
 * or starts separated when it reports nothing back), or a thread on a linked
 * computer (docs/design/fleet.md), recorded as its remote origin.
 */
export type ChildBootstrapLineage =
  | {
      readonly kind: "local";
      readonly parentThreadId: ThreadId;
      /** The parent's turn whose agent started it. */
      readonly parentTurnId: TurnId;
    }
  | { readonly kind: "remote"; readonly remoteOrigin: ThreadRemoteOrigin };

/** Everything a child's setup needs, all of it saved with its request. */
export interface ChildBootstrapInput {
  readonly lineage: ChildBootstrapLineage;
  readonly projectId: ProjectId;
  readonly requestId: ChildRequestId;
  readonly childThreadId: ThreadId;
  /** The first message's id: the turn it starts answers the request. */
  readonly childMessageId: MessageId;
  readonly launch: ChildThreadLaunch;
  /** The first message's origin, `kind: "request"`. */
  readonly fromThread: ThreadMessageOrigin;
  /** When the request was made; the child is created with this stamp. */
  readonly createdAt: IsoDateTime;
  /**
   * Asked before each stage: false stops the setup there (a request
   * cancelled meanwhile, docs/design/fleet.md rev 3). Absent: always go on.
   */
  readonly checkpoint?: (stage: ChildBootstrapStage) => Effect.Effect<boolean>;
}

export interface ThreadBootstrapShape {
  /**
   * A client's turn start carrying a `bootstrap`: run it once per command id
   * (joining a run already in flight, or answering from the receipt), record
   * a failure on the thread, and resolve with the final turn start's sequence.
   */
  readonly runTurnStart: (
    command: ThreadTurnStartCommand,
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
