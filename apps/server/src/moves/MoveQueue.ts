// @effect-diagnostics nodeBuiltinImport:off
/**
 * Moves that wait for their thread to be free (docs/design/fleet.md, Part
 * 3b), on the computer the thread leaves. `queue` checks the link and records
 * the thread's pending move; `unqueue` cancels it, or the transfer it already
 * started; `retry` looks again now at a held one.
 *
 * The reactor watches threads with a pending move, and the links. For each:
 * something only the user can clear ends the wait (`queue-end`, "Didn't
 * move: …"); a wait is reported and left alone; a free thread goes through
 * the barrier: `thread.move.quiesce` (the session fence goes up and its
 * sessions stop), `ProviderService.quiesceThread` (every driver proves its
 * agent's processes are gone), a fresh look (a provider turn that slipped
 * in sends it back to waiting), and then `ThreadMoves.startQueued`, whose
 * `thread.move.start` ends the pending move in the same decision. An
 * unreachable target, or a stop that can't be proven, holds the move and
 * tries again, from 15 seconds backing off to 2 minutes; a link that
 * changes or comes back tries at once.
 */
import { randomUUID } from "node:crypto";

import {
  CommandId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ThreadId,
  ThreadMoveBatchId,
  type ThreadMoveBatchMember,
  type ThreadMoveBatchStatus,
  ThreadMoveError,
  type ThreadMoveHold,
  ThreadMoveRequestId,
  type ThreadMoveQueueInput,
  type ThreadMoveQueueManyInput,
  type ThreadMoveQueueManyResult,
  type ThreadMoveQueueResult,
  type ThreadMoveRequester,
  type ThreadMoveRetryInput,
  type ThreadMoveSetModeInput,
  type ThreadMoveUnqueueInput,
  type ThreadMoveWait,
  type ThreadPendingMove,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { ComputerLinks } from "../links/ComputerLinks.ts";
import { derivedUuid } from "../orchestration/childRequestIds.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  firstMoveBlock,
  isRestorePaid,
  moveWaitsOf,
  restoreMessageText,
  sameMoveStatus,
  type ThreadMoveRefusalEntry,
  threadMoveRefusals,
} from "../orchestration/threadMoveDecisions.ts";
import type { ProviderStopConfirmation } from "../provider/Services/ProviderAdapter.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import {
  ThreadMoveBatchRepository,
  type ThreadMoveBatchMemberRow,
  type ThreadMoveBatchRepositoryShape,
  type ThreadMoveBatchRow,
} from "./ThreadMoveBatchRepository.ts";
import {
  type DescribedTarget,
  type QueuedMoveStart,
  ThreadMoves,
  type ThreadMovesShape,
} from "./ThreadMoves.ts";
import { makeThreadMoveContextReader, type ThreadMoveContext } from "./threadMoveView.ts";

export interface MoveQueueShape {
  readonly queue: (
    input: ThreadMoveQueueInput & { readonly requestedBy?: ThreadMoveRequester },
  ) => Effect.Effect<ThreadMoveQueueResult, ThreadMoveError>;
  readonly unqueue: (input: ThreadMoveUnqueueInput) => Effect.Effect<void, ThreadMoveError>;
  readonly retry: (input: ThreadMoveRetryInput) => Effect.Effect<void, ThreadMoveError>;
  /**
   * Queues a move for each thread to one computer, as one batch
   * (docs/design/fleet.md, Part 3c): each through the same path as `queue`,
   * decided on its own, so one refused doesn't stop the others. The batch is
   * recorded before the first thread is queued.
   */
  readonly queueMany: (
    input: ThreadMoveQueueManyInput,
  ) => Effect.Effect<ThreadMoveQueueManyResult, ThreadMoveError>;
  /** "Stop the agents and move now" for the waiting move `requestId`; one that started is left alone. */
  readonly setMode: (input: ThreadMoveSetModeInput) => Effect.Effect<void, ThreadMoveError>;
  /** Where every thread of a batch stands. */
  readonly batchStatus: (
    batchId: ThreadMoveBatchId,
  ) => Effect.Effect<ThreadMoveBatchStatus, ThreadMoveError>;
  /** Watch queued moves: the ones the last process left, and every one from now on. */
  readonly startReactor: () => Effect.Effect<void, never, Scope.Scope>;
}

export class MoveQueue extends Context.Service<MoveQueue, MoveQueueShape>()(
  "threadlines/moves/MoveQueue",
) {}

/** What the move queue needs, narrowed so tests can run it on the real decider. */
export interface MoveQueueDeps {
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<unknown, { readonly message: string }>;
  /** Subscribed when run, so nothing published after is missed. */
  readonly subscribeEvents: Effect.Effect<Stream.Stream<OrchestrationEvent>, never, Scope.Scope>;
  /** Something about the links changed: one added, removed, its access, or its connection. */
  readonly linkChanges: Stream.Stream<unknown>;
  /** The thread, archived ones too; null when it's gone. A read that fails is a defect: the look is tried again. */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThread | null>;
  /** What the move checks read about a thread (threadMoveView.ts); null when it's gone. */
  readonly readContext: (threadId: ThreadId) => Effect.Effect<ThreadMoveContext | null>;
  /** Threads with a queued move, for the startup scan. */
  readonly pendingThreadIds: Effect.Effect<ReadonlyArray<ThreadId>>;
  /** Threads a move that didn't happen still owes (moveRestoreOwed), for the startup scan. */
  readonly restoreOwedThreadIds: Effect.Effect<ReadonlyArray<ThreadId>>;
  /** Whether the thread's agent sets itself check-backs (the put-back message says what to do). */
  readonly setsCheckBacks: (thread: OrchestrationThread) => Effect.Effect<boolean>;
  readonly quiesce: (threadId: ThreadId) => Effect.Effect<ProviderStopConfirmation>;
  readonly checkQueue: ThreadMovesShape["checkQueue"];
  readonly checkCarry: ThreadMovesShape["checkCarry"];
  /** Every linked computer, described once, for a batch. */
  readonly describeTargets: ThreadMovesShape["describeTargets"];
  readonly startQueued: ThreadMovesShape["startQueued"];
  readonly batches: Pick<ThreadMoveBatchRepositoryShape, "upsert" | "get">;
  /** What a batch's status reads of one thread, archived and deleted ones too; null when it's gone. */
  readonly readMoveState: (threadId: ThreadId) => Effect.Effect<BatchThreadState | null>;
  /** v1's cancel of the thread's move under way. */
  readonly cancelMove: ThreadMovesShape["cancel"];
  /** The wait before trying a held move again, by how many times it was held. */
  readonly retryDelay?: (attempt: number) => Duration.Duration;
  /** How long to gather a burst of changes before looking. */
  readonly settleDelay?: Duration.Duration;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const moveError = (detail: string) => new ThreadMoveError({ detail });

/** What `moves.batchStatus` reads of one thread: its title and its move state. */
export type BatchThreadState = Pick<
  OrchestrationThread,
  "title" | "deletedAt" | "pendingMove" | "move" | "lastMoveOutcome"
>;

/**
 * Where one thread of a batch stands, from the queued move it got
 * (`member.requestId`), the refusal it got instead, and its move state now.
 * Its outcome for that request is final; its queued move or its move for
 * that request is still going. Anything else (deleted mid-move, or a move it
 * no longer has) is final as not moved.
 */
export function batchMemberStatus(
  member: ThreadMoveBatchMemberRow,
  refusal: string | undefined,
  thread: BatchThreadState | null,
): ThreadMoveBatchMember {
  // A refused member's id was named before it was refused and never queued
  // anything: it stays out, so no client sends it on (setMode, unqueue).
  const base = {
    threadId: member.threadId,
    ...(thread !== null && thread.title.trim().length > 0 ? { title: thread.title } : {}),
    ...(member.requestId !== undefined && refusal === undefined
      ? { requestId: member.requestId }
      : {}),
  };
  const notMoved = (words: string): ThreadMoveBatchMember => ({
    ...base,
    state: "not_moved",
    final: true,
    words,
  });
  if (refusal !== undefined) return notMoved(refusal);
  if (thread === null) return notMoved("This thread is gone.");
  const requestId = member.requestId;
  if (requestId === undefined) return notMoved("This thread wasn't queued.");
  const outcome = thread.lastMoveOutcome ?? null;
  if (outcome !== null && outcome.requestId === requestId) {
    return {
      ...base,
      state: outcome.result,
      final: true,
      ...(outcome.words !== undefined ? { words: outcome.words } : {}),
    };
  }
  const pending = thread.pendingMove ?? null;
  const move = thread.move ?? null;
  const going =
    (pending !== null && pending.requestId === requestId) ||
    (move !== null && move.queuedRequestId === requestId && move.movedAway === undefined);
  if (thread.deletedAt !== null && going) return notMoved("This thread was deleted.");
  if (pending !== null && pending.requestId === requestId) {
    return {
      ...base,
      state: pending.stage === "quiescing" ? "stopping" : "waiting",
      final: false,
      ...(pending.waitsFor !== undefined && pending.waitsFor.length > 0
        ? { waitsFor: pending.waitsFor }
        : {}),
      ...(pending.hold !== undefined && pending.hold !== null ? { hold: pending.hold } : {}),
    };
  }
  if (move !== null && move.queuedRequestId === requestId) {
    return move.movedAway !== undefined
      ? { ...base, state: "moved", final: true }
      : { ...base, state: "moving", final: false, phase: move.phase };
  }
  return notMoved("This thread's move ended without an answer.");
}

/** 15 s, 30 s, 1 min, then every 2 min. */
const defaultRetryDelay = (attempt: number) =>
  Duration.seconds(Math.min(15 * 2 ** Math.max(0, attempt), 120));

/** How long after a quiesce it is asked again for a session the projection still shows. */
const REQUIESCE_AFTER_MS = 10_000;

/** A session as projected, to tell whether it changed since the last quiesce. */
const sessionMark = (thread: OrchestrationThread) => {
  const session = thread.session;
  return session === null
    ? "none"
    : `${session.status}:${session.activeTurnId ?? ""}:${session.updatedAt}`;
};

/** A thread's move checks, from the thread alone: no other thread or project. */
const localRefusals = (thread: OrchestrationThread) =>
  threadMoveRefusals(
    { projects: [], threads: [thread] },
    thread,
    // What the target said it takes, when the move was queued.
    thread.pendingMove?.targetTakes,
  );

interface TrackedMove {
  requestId: ThreadMoveRequestId;
  running: boolean;
  again: boolean;
  timer: Fiber.Fiber<void> | null;
  timerDueMs: number;
  /** How many times in a row it was held (unreachable, unconfirmed). */
  holds: number;
  quiescedAtMs: number;
  /** The session the last quiesce saw (sessionMark). */
  quiescedSession: string;
}

export const makeMoveQueue = (
  deps: MoveQueueDeps,
): Effect.Effect<MoveQueueShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const retryDelay = deps.retryDelay ?? defaultRetryDelay;
    const settleDelay = deps.settleDelay ?? Duration.millis(250);
    const tracked = new Map<ThreadId, TrackedMove>();

    const dispatchIgnoringRefusal = (command: OrchestrationCommand) =>
      deps.dispatch(command).pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          Effect.logInfo("move queue: a command was refused", {
            type: command.type,
            detail: error.message,
          }),
        ),
      );

    const commandId = (requestId: string, step: string) =>
      CommandId.make(`server:thread-move-queue:${requestId}:${step}:${randomUUID()}`);

    /**
     * Says what the move waits for and what holds it, when that changed: the
     * engine refuses a command that records nothing.
     */
    const report = (
      threadId: ThreadId,
      pending: ThreadPendingMove,
      waitsFor: ReadonlyArray<ThreadMoveWait>,
      hold: ThreadMoveHold | null,
    ) =>
      Effect.gen(function* () {
        if (sameMoveStatus(pending, waitsFor, hold)) return;
        const requestId = pending.requestId;
        yield* dispatchIgnoringRefusal({
          type: "thread.move.queue-status",
          commandId: commandId(requestId, "status"),
          threadId,
          requestId,
          waitsFor: [...waitsFor],
          hold,
          createdAt: yield* nowIso,
        });
      });

    const end = (
      threadId: ThreadId,
      requestId: ThreadMoveRequestId,
      reason: "blocked" | "gone",
      words: string,
    ) =>
      Effect.gen(function* () {
        yield* dispatchIgnoringRefusal({
          type: "thread.move.queue-end",
          commandId: commandId(requestId, "end"),
          threadId,
          requestId,
          reason,
          words,
          createdAt: yield* nowIso,
        });
      });

    // -------------------------------------------------------------------------
    // Scheduling: one look per thread at a time; changes while it looks ask
    // for another; a held move has one timer.
    // -------------------------------------------------------------------------

    const schedule = (threadId: ThreadId, delay: Duration.Duration): Effect.Effect<void> =>
      Effect.gen(function* () {
        const entry = tracked.get(threadId);
        if (entry === undefined) return;
        const dueMs = Date.now() + Duration.toMillis(delay);
        if (entry.timer !== null && entry.timerDueMs <= dueMs) return;
        if (entry.timer !== null) yield* Fiber.interrupt(entry.timer);
        entry.timerDueMs = dueMs;
        entry.timer = yield* Effect.sleep(delay).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              entry.timer = null;
              return run(threadId);
            }),
          ),
          Effect.forkIn(scope),
        );
      });

    const run = (threadId: ThreadId): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = tracked.get(threadId);
        if (entry === undefined) return Effect.void;
        if (entry.running) {
          entry.again = true;
          return Effect.void;
        }
        entry.running = true;
        const once = evaluate(threadId, entry).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("move queue: looking at a queued move failed", {
              threadId,
              cause,
            }).pipe(Effect.andThen(schedule(threadId, retryDelay(entry.holds)))),
          ),
        );
        const loop: Effect.Effect<void> = Effect.suspend(() => {
          entry.again = false;
          return once.pipe(
            Effect.andThen(
              Effect.suspend(() =>
                entry.again && tracked.get(threadId) === entry ? loop : Effect.void,
              ),
            ),
          );
        });
        return loop.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              entry.running = false;
            }),
          ),
        );
      });

    /** Watches a thread's queued move `requestId`, replacing an older one. */
    const track = (threadId: ThreadId, requestId: ThreadMoveRequestId) =>
      Effect.sync(() => {
        const existing = tracked.get(threadId);
        if (existing !== undefined) {
          if (existing.requestId === requestId) return;
          existing.requestId = requestId;
          existing.holds = 0;
          existing.quiescedAtMs = 0;
          existing.quiescedSession = "";
          return;
        }
        tracked.set(threadId, {
          requestId,
          running: false,
          again: false,
          timer: null,
          timerDueMs: 0,
          holds: 0,
          quiescedAtMs: 0,
          quiescedSession: "",
        });
      });

    const forget = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const entry = tracked.get(threadId);
        if (entry === undefined) return;
        tracked.delete(threadId);
        if (entry.timer !== null) yield* Fiber.interrupt(entry.timer);
      });

    const held = (threadId: ThreadId, entry: TrackedMove) =>
      Effect.suspend(() => {
        const delay = retryDelay(entry.holds);
        entry.holds += 1;
        return schedule(threadId, delay);
      });

    // -------------------------------------------------------------------------
    // One look at one queued move.
    // -------------------------------------------------------------------------

    /** Reports what it waits for, or ends it when something only the user can clear stands in the way. */
    const settleRefusals = (
      threadId: ThreadId,
      pending: ThreadPendingMove,
      refusals: ReadonlyArray<ThreadMoveRefusalEntry>,
    ) =>
      Effect.gen(function* () {
        const block = firstMoveBlock(refusals);
        if (block !== null) {
          const gone = block.code === "archived" || block.code === "deleted";
          yield* end(threadId, pending.requestId, gone ? "gone" : "blocked", block.words);
          return true;
        }
        if (refusals.length > 0) {
          yield* report(threadId, pending, moveWaitsOf(refusals), null);
          return true;
        }
        return false;
      });

    const evaluate = (threadId: ThreadId, entry: TrackedMove) =>
      Effect.gen(function* () {
        const thread = yield* deps.readThread(threadId);
        const pending = thread?.pendingMove ?? null;
        if (thread === null || pending === null) return yield* forget(threadId);
        // A newer queued move than the one this was watching: watch it instead.
        yield* track(threadId, pending.requestId);
        const requestId = pending.requestId;
        // From the thread alone first: while it works, nothing else needs reading.
        if (yield* settleRefusals(threadId, pending, localRefusals(thread))) return;
        const context = yield* deps.readContext(threadId);
        if (context === null) return yield* forget(threadId);
        const refusals = threadMoveRefusals(
          context.view,
          context.thread,
          context.thread.pendingMove?.targetTakes,
        );
        if (yield* settleRefusals(threadId, pending, refusals)) return;
        // Before anything is stopped: whether the target takes what the thread
        // carries (docs/design/fleet.md, Part 3e). One that doesn't ends the
        // move here, with nothing to put back; one that can't be reached holds
        // it, its agent still at work.
        if (pending.stage === "waiting") {
          const carried = yield* deps.checkCarry({
            threadId,
            targetEnvironmentId: pending.target.environmentId,
            label: pending.target.label,
          });
          if (carried.kind === "blocked") {
            yield* end(threadId, requestId, "blocked", carried.words);
            return;
          }
          if (carried.kind === "unreachable") {
            yield* report(threadId, pending, [], {
              kind: "target_unreachable",
              words: carried.words,
            });
            return yield* held(threadId, entry);
          }
        }
        // Waiting, only that answer held it; it is in now.
        yield* report(
          threadId,
          pending,
          [],
          pending.stage === "waiting" ? null : (pending.hold ?? null),
        );

        // The barrier: the fence goes up and its sessions stop.
        if (pending.stage === "waiting" || !sessionStopped(thread)) {
          // Asked again once the session changed since (a turn that slipped
          // in and ended), or the stop never showed.
          if (
            pending.stage === "waiting" ||
            sessionMark(thread) !== entry.quiescedSession ||
            Date.now() - entry.quiescedAtMs > REQUIESCE_AFTER_MS
          ) {
            entry.quiescedAtMs = Date.now();
            entry.quiescedSession = sessionMark(thread);
            yield* dispatchIgnoringRefusal({
              type: "thread.move.quiesce",
              commandId: commandId(requestId, "quiesce"),
              threadId,
              requestId,
              createdAt: yield* nowIso,
            });
          }
        }
        // Only a move the projection shows quiescing, as this request, ends
        // the thread's sessions: a look begun before a Cancel must not stop
        // the work the user started after it (its quiesce was refused).
        const fenced = (yield* deps.readThread(threadId))?.pendingMove ?? null;
        if (fenced === null || fenced.requestId !== requestId || fenced.stage !== "quiescing") {
          entry.again = true;
          return;
        }
        // Every driver proves its agent's processes are gone.
        const confirmation = yield* deps.quiesce(threadId);
        if (!confirmation.confirmed) {
          const latest = (yield* deps.readThread(threadId))?.pendingMove ?? null;
          if (latest === null || latest.requestId !== requestId) return;
          yield* report(threadId, latest, [], {
            kind: "stop_unconfirmed",
            words: `Couldn't confirm the agent stopped: ${confirmation.reason}.`,
          });
          return yield* held(threadId, entry);
        }
        // A turn that slipped in before the fence sends it back to waiting.
        const after = yield* deps.readThread(threadId);
        if (after === null || after.pendingMove?.requestId !== requestId) {
          entry.again = true;
          return;
        }
        if (yield* settleRefusals(threadId, after.pendingMove, localRefusals(after))) return;
        if (after.pendingMove.stage !== "quiescing" || !sessionStopped(after)) {
          // The stop is still landing in the projection; its event looks again.
          return yield* schedule(threadId, retryDelay(0));
        }
        // No agent named: the target's suggestion now, or it can't go.
        const outcome: QueuedMoveStart = yield* deps.startQueued({
          threadId,
          requestId,
          targetEnvironmentId: pending.target.environmentId,
          agent: pending.agent,
          roomAgents: pending.roomAgents,
        });
        switch (outcome.kind) {
          case "started":
            yield* forget(threadId);
            return;
          case "unreachable":
            yield* report(threadId, after.pendingMove, [], {
              kind: "target_unreachable",
              words: outcome.words,
            });
            return yield* held(threadId, entry);
          case "blocked":
            yield* end(threadId, requestId, "blocked", outcome.words);
            return;
          case "busy":
            return yield* schedule(threadId, retryDelay(0));
        }
      });

    // -------------------------------------------------------------------------
    // Put back (docs/design/fleet.md, Part 3e): what a move that didn't happen
    // owes the thread, from the record its end left (moveRestoreOwed).
    // -------------------------------------------------------------------------

    /** Threads being paid now, so two events for one thread pay once. */
    const paying = new Set<ThreadId>();

    /**
     * Pays what the thread is owed, in one decision that clears the record:
     * the goal that was working is on again and its agent is told (with its
     * check-backs to set again), and the queue that waited is sent. A thread
     * that queued another move since carries it there instead. Fails, and is
     * tried again, while the record stays.
     */
    const payRestore = (
      threadId: ThreadId,
      options: { readonly attempt?: number; readonly startup?: boolean } = {},
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const attempt = options.attempt ?? 0;
        if (paying.has(threadId)) return;
        paying.add(threadId);
        yield* Effect.gen(function* () {
          const thread = yield* deps.readThread(threadId);
          const owed = thread?.moveRestoreOwed ?? null;
          if (thread === null || owed === null) return;
          if ((thread.pendingMove ?? null) !== null || (thread.move ?? null) !== null) return;
          const now = yield* nowIso;
          // Paid, with its last steps left: the reactor takes them as turns
          // end. Only a restart in between needs this: the message it wrote
          // (or the queue after it) is sent, or once all of it went, the
          // goal is given back and the record clears.
          if (isRestorePaid(owed)) {
            if (options.startup !== true) return;
            const busy =
              thread.session?.status === "running" || thread.session?.status === "starting";
            if (busy) return;
            const head = (thread.queuedFollowUps ?? [])[0];
            if (head !== undefined) {
              yield* deps.dispatch({
                type: "thread.follow-up.send-queued",
                commandId: CommandId.make(
                  `server:thread-move-restore:${threadId}:${owed.at}:${head.messageId}`,
                ),
                threadId,
                messageId: head.messageId,
                createdAt: now,
              });
              return;
            }
            const goal = thread.goal;
            if (
              owed.goalOwed === true &&
              (goal?.status === "active" || goal?.status === "paused")
            ) {
              // A resume: the provider is given the goal the thread reads.
              yield* deps.dispatch({
                type: "thread.goal.set",
                commandId: CommandId.make(`server:thread-move-restore:${threadId}:${owed.at}:goal`),
                threadId,
                status: "active",
                createdAt: now,
              });
            }
            yield* deps.dispatch({
              type: "thread.move.restore",
              commandId: CommandId.make(
                `server:thread-move-restore:${threadId}:${owed.at}:finished`,
              ),
              threadId,
              at: owed.at,
              finished: true,
              createdAt: now,
            });
            return;
          }
          const text = restoreMessageText(thread, owed, now, yield* deps.setsCheckBacks(thread));
          const busy =
            thread.session?.status === "running" || thread.session?.status === "starting";
          // Told something, the message goes first and the queue follows it;
          // nothing to tell, an idle thread sends its queue now. A turn at
          // work sends it as it ends, as always.
          const head = (thread.queuedFollowUps ?? [])[0];
          // A send that was refused once isn't tried again: the queue is left
          // for the user, and what was owed is still paid.
          const sendQueued =
            attempt === 0 && text === null && owed.queued === true && !busy && head !== undefined
              ? head.messageId
              : undefined;
          yield* deps.dispatch({
            type: "thread.move.restore",
            commandId: CommandId.make(`server:thread-move-restore:${threadId}:${owed.at}`),
            threadId,
            at: owed.at,
            ...(text !== null
              ? {
                  message: {
                    messageId: MessageId.make(derivedUuid("move-restore", threadId, owed.at)),
                    text,
                  },
                }
              : {}),
            ...(sendQueued !== undefined ? { sendQueued } : {}),
            createdAt: now,
          });
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("move queue: what a move owed couldn't be put back yet", {
              threadId,
              detail: error.message,
            }).pipe(
              // A restart tries again after the last of these.
              Effect.andThen(
                attempt >= 3
                  ? Effect.void
                  : Effect.sleep(retryDelay(attempt)).pipe(
                      Effect.andThen(
                        Effect.suspend(() =>
                          payRestore(threadId, { ...options, attempt: attempt + 1 }),
                        ),
                      ),
                      Effect.forkIn(scope),
                      Effect.asVoid,
                    ),
              ),
            ),
          ),
          Effect.ensuring(Effect.sync(() => paying.delete(threadId))),
        );
      });

    // -------------------------------------------------------------------------
    // The service.
    // -------------------------------------------------------------------------

    /** Checks one move and records it as the thread's queued move: `queue`, and each of a batch. */
    const queueOne = (
      input: ThreadMoveQueueInput & { readonly requestedBy?: ThreadMoveRequester },
      batch?: {
        readonly batchId: ThreadMoveBatchId;
        readonly targets: ReadonlyArray<DescribedTarget>;
        /** Recorded in the batch before it is queued. */
        readonly requestId: ThreadMoveRequestId;
      },
    ) =>
      Effect.gen(function* () {
        const { label, takes } = yield* deps.checkQueue({
          threadId: input.threadId,
          targetEnvironmentId: input.targetEnvironmentId,
          agent: input.agent,
          roomAgents: input.roomAgents,
          targets: batch?.targets,
        });
        const requestId = batch?.requestId ?? ThreadMoveRequestId.make(randomUUID());
        yield* deps
          .dispatch({
            type: "thread.move.queue",
            commandId: CommandId.make(`server:thread-move-queue:${requestId}:queue`),
            threadId: input.threadId,
            requestId,
            target: { environmentId: input.targetEnvironmentId, label },
            ...(input.agent !== undefined ? { agent: input.agent } : {}),
            ...(input.roomAgents !== undefined ? { roomAgents: input.roomAgents } : {}),
            mode: input.mode,
            requestedBy: input.requestedBy ?? { kind: "user" },
            ...(batch !== undefined ? { batchId: batch.batchId } : {}),
            targetTakes: takes,
            createdAt: yield* nowIso,
          })
          .pipe(Effect.mapError((error) => moveError(error.message)));
        return { requestId, label };
      });

    const queue: MoveQueueShape["queue"] = (input) =>
      queueOne(input).pipe(Effect.map(({ requestId }) => ({ requestId })));

    const unrecorded = () => moveError("The moves couldn't be recorded. Try again.");

    const queueMany: MoveQueueShape["queueMany"] = (input) =>
      Effect.gen(function* () {
        const batchId = ThreadMoveBatchId.make(randomUUID());
        const threadIds = [...new Set(input.threadIds)];
        const targets = yield* deps.describeTargets;
        const described = targets.find(
          (entry) => entry.environmentId === input.targetEnvironmentId,
        );
        const targetLabel = Option.match(described?.described ?? Option.none(), {
          onNone: () => described?.label ?? "the other computer",
          onSome: (peer) => peer.label,
        });
        const planned = threadIds.map((threadId) => ({
          threadId,
          requestId: ThreadMoveRequestId.make(randomUUID()),
        }));
        const row: ThreadMoveBatchRow = {
          batchId,
          targetEnvironmentId: input.targetEnvironmentId,
          targetLabel,
          createdAt: yield* nowIso,
          // Each member's queued move is named before any is queued, so a
          // batch cut short (a crash, a failed write) still knows every move
          // it made; one never queued reads as not moved.
          members: planned,
          refused: [],
        };
        yield* deps.batches.upsert(row).pipe(Effect.mapError(unrecorded));
        const queued: Array<{ threadId: ThreadId; requestId: ThreadMoveRequestId }> = [];
        const refused: Array<{ threadId: ThreadId; words: string }> = [];
        for (const member of planned) {
          const requestId = member.requestId;
          const one = yield* queueOne(
            {
              threadId: member.threadId,
              targetEnvironmentId: input.targetEnvironmentId,
              mode: input.mode,
            },
            { batchId, targets, requestId },
          ).pipe(Effect.result);
          if (one._tag === "Success") {
            queued.push({ threadId: member.threadId, requestId });
          } else {
            refused.push({ threadId: member.threadId, words: one.failure.detail });
          }
        }
        // The refusals' words; without them a refused member still reads as
        // not moved, so a failed write here doesn't undo the queued moves.
        yield* deps.batches.upsert({ ...row, refused }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("move queue: a batch's refusals couldn't be recorded", {
              batchId,
              cause: error,
            }),
          ),
        );
        return { batchId, queued, refused } satisfies ThreadMoveQueueManyResult;
      });

    const setMode: MoveQueueShape["setMode"] = (input) =>
      Effect.gen(function* () {
        const read = deps.readThread(input.threadId);
        const thread = yield* read;
        if (thread === null) return yield* moveError("That thread doesn't exist.");
        // Already started, ended or replaced: left alone.
        if (thread.pendingMove?.requestId !== input.requestId) return;
        const refused = yield* deps
          .dispatch({
            type: "thread.move.set-mode",
            commandId: commandId(input.requestId, "set-mode"),
            threadId: input.threadId,
            requestId: input.requestId,
            mode: input.mode,
            createdAt: yield* nowIso,
          })
          .pipe(
            Effect.as(null),
            Effect.catch((error) => Effect.succeed(error.message)),
          );
        if (refused === null) return;
        // A start that won the race (the frozen thread refuses it): nothing to switch.
        if ((yield* read)?.pendingMove?.requestId === input.requestId) {
          return yield* moveError(refused);
        }
      });

    const batchStatus: MoveQueueShape["batchStatus"] = (batchId) =>
      Effect.gen(function* () {
        const found = yield* deps.batches
          .get(batchId)
          .pipe(Effect.mapError(() => moveError("The moves couldn't be read.")));
        if (Option.isNone(found)) return yield* moveError("Those moves aren't known here.");
        const batch = found.value;
        const refusals = new Map(batch.refused.map((entry) => [entry.threadId, entry.words]));
        const members = yield* Effect.forEach(batch.members, (member) =>
          deps
            .readMoveState(member.threadId)
            .pipe(
              Effect.map((thread) =>
                batchMemberStatus(member, refusals.get(member.threadId), thread),
              ),
            ),
        );
        return {
          batchId,
          target: { environmentId: batch.targetEnvironmentId, label: batch.targetLabel },
          createdAt: batch.createdAt,
          members,
          final: members.every((member) => member.final),
        } satisfies ThreadMoveBatchStatus;
      });

    const unqueue: MoveQueueShape["unqueue"] = (input) =>
      Effect.gen(function* () {
        const read = deps.readThread(input.threadId);
        const thread = yield* read;
        if (thread === null) return;
        let refused: string | null = null;
        if (thread.pendingMove?.requestId === input.requestId) {
          refused = yield* deps
            .dispatch({
              type: "thread.move.unqueue",
              commandId: commandId(input.requestId, "unqueue"),
              threadId: input.threadId,
              requestId: input.requestId,
              createdAt: yield* nowIso,
            })
            .pipe(
              Effect.as(null),
              Effect.catch((error) => Effect.succeed(error.message)),
            );
        }
        // Read after the cancel: a start the decider took first (the frozen
        // thread refuses the unqueue then) is now the thread's move, and the
        // Cancel cancels its transfer instead.
        const after = yield* read;
        const move = after?.move ?? null;
        if (move === null || move.queuedRequestId !== input.requestId) {
          if (refused !== null && after?.pendingMove?.requestId === input.requestId) {
            return yield* moveError(refused);
          }
          return;
        }
        if (move.movedAway !== undefined) {
          return yield* moveError(`This thread already moved to ${move.target.label}.`);
        }
        if (!move.cancelRequested) yield* deps.cancelMove(input.threadId);
      });

    const retry: MoveQueueShape["retry"] = (input) =>
      Effect.gen(function* () {
        const entry = tracked.get(input.threadId);
        if (entry === undefined || entry.requestId !== input.requestId) {
          return yield* moveError("That move isn't waiting anymore.");
        }
        entry.holds = 0;
        yield* schedule(input.threadId, Duration.zero);
      });

    const startReactor: MoveQueueShape["startReactor"] = () =>
      Effect.gen(function* () {
        // Subscribed before the scan, so a change during it isn't missed.
        const events = yield* deps.subscribeEvents;
        // The moves the last process left, read off the startup path.
        yield* Effect.gen(function* () {
          for (const threadId of yield* deps.pendingThreadIds) {
            const pending = (yield* deps.readThread(threadId))?.pendingMove ?? null;
            if (pending !== null) {
              yield* track(threadId, pending.requestId);
              yield* schedule(threadId, Duration.zero);
            }
          }
          // What moves that didn't happen still owe (a restart before it was paid).
          for (const threadId of yield* deps.restoreOwedThreadIds) {
            yield* payRestore(threadId, { startup: true });
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("move queue: the queued moves couldn't be read", { cause }),
          ),
          Effect.forkScoped,
        );
        const lookAtAll = (delay: Duration.Duration, fresh: boolean) =>
          Effect.forEach(
            [...tracked.entries()],
            ([threadId, entry]) => {
              if (fresh) entry.holds = 0;
              return schedule(threadId, delay);
            },
            { discard: true },
          );
        yield* events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type === "thread.move-queued") {
                yield* track(event.payload.threadId, event.payload.pendingMove.requestId);
                return yield* schedule(event.payload.threadId, Duration.zero);
              }
              if (event.type === "thread.move-queue-ended") {
                const entry = tracked.get(event.payload.threadId);
                if (entry?.requestId === event.payload.requestId) {
                  yield* forget(event.payload.threadId);
                }
                return;
              }
              // A move that didn't happen owes the thread what it took.
              if (
                event.type === "thread.move-restore-set" &&
                event.payload.moveRestoreOwed !== null
              ) {
                return yield* payRestore(event.payload.threadId).pipe(
                  Effect.forkIn(scope),
                  Effect.asVoid,
                );
              }
              // Another thread working in the same folder holds a move: any
              // session change anywhere is a reason to look again.
              if (event.type === "thread.session-set") {
                return yield* lookAtAll(settleDelay, false);
              }
              const threadId = "threadId" in event.payload ? event.payload.threadId : undefined;
              if (threadId !== undefined && tracked.has(threadId)) {
                yield* schedule(threadId, settleDelay);
              }
            }),
          ),
          Effect.forkScoped,
        );
        // A link added, removed, changed or back: held moves try again at once.
        yield* deps.linkChanges.pipe(
          Stream.runForEach(() => lookAtAll(settleDelay, true)),
          Effect.catchCause((cause) =>
            Effect.logWarning("move queue: link changes stopped", { cause }),
          ),
          Effect.forkScoped,
        );
      });

    return MoveQueue.of({
      queue,
      unqueue,
      retry,
      queueMany,
      setMode,
      batchStatus,
      startReactor,
    });
  });

/** Whether the thread's agent has no session left, as projected. */
const sessionStopped = (thread: OrchestrationThread) =>
  thread.session === null || thread.session.status === "stopped";

export const MoveQueueLive = Layer.effect(
  MoveQueue,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    const providers = yield* ProviderService;
    const threadMoves = yield* ThreadMoves;
    const links = yield* ComputerLinks;
    const batches = yield* ThreadMoveBatchRepository;
    const threadRows = yield* ProjectionThreadRepository;
    const sql = yield* SqlClient.SqlClient;
    const readContext = yield* makeThreadMoveContextReader;
    return yield* makeMoveQueue({
      dispatch: engine.dispatch,
      subscribeEvents: engine.subscribeDomainEvents,
      linkChanges: links.changes.pipe(Stream.orDie),
      readThread: (threadId) =>
        snapshots
          .getThreadDetailById(threadId, { includeArchived: true })
          .pipe(Effect.map(Option.getOrNull), Effect.orDie),
      readContext: (threadId) => readContext(threadId).pipe(Effect.orDie),
      pendingThreadIds: sql<{ readonly threadId: ThreadId }>`
        SELECT thread_id AS "threadId"
        FROM projection_threads
        WHERE pending_move_json IS NOT NULL AND deleted_at IS NULL
      `.pipe(
        Effect.map((rows) => rows.map((row) => row.threadId)),
        Effect.orDie,
      ),
      restoreOwedThreadIds: sql<{ readonly threadId: ThreadId }>`
        SELECT thread_id AS "threadId"
        FROM projection_threads
        WHERE move_restore_owed_json IS NOT NULL AND deleted_at IS NULL
      `.pipe(
        Effect.map((rows) => rows.map((row) => row.threadId)),
        Effect.orDie,
      ),
      setsCheckBacks: (thread) =>
        providers.getCapabilities(thread.modelSelection.instanceId).pipe(
          Effect.map((capabilities) => capabilities.checkBacks === "supported"),
          Effect.orElseSucceed(() => false),
        ),
      quiesce: providers.quiesceThread,
      checkQueue: threadMoves.checkQueue,
      checkCarry: threadMoves.checkCarry,
      describeTargets: threadMoves.describeTargets,
      startQueued: threadMoves.startQueued,
      cancelMove: threadMoves.cancel,
      batches,
      // The row alone: a batch's status reads each member's move state, not
      // its messages.
      readMoveState: (threadId) =>
        threadRows.getById({ threadId }).pipe(
          Effect.map((row) =>
            Option.isNone(row)
              ? null
              : {
                  title: row.value.title,
                  deletedAt: row.value.deletedAt,
                  pendingMove: row.value.pendingMove ?? null,
                  move: row.value.move ?? null,
                  lastMoveOutcome: row.value.lastMoveOutcome ?? null,
                },
          ),
          Effect.orDie,
        ),
    });
  }),
);
