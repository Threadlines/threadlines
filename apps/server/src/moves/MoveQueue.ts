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
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ThreadId,
  ThreadMoveError,
  type ThreadMoveHold,
  ThreadMoveRequestId,
  type ThreadMoveQueueInput,
  type ThreadMoveQueueResult,
  type ThreadMoveRequester,
  type ThreadMoveRetryInput,
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
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  firstMoveBlock,
  moveWaitsOf,
  sameMoveStatus,
  type ThreadMoveRefusalEntry,
  threadMoveRefusals,
} from "../orchestration/threadMoveDecisions.ts";
import type { ProviderStopConfirmation } from "../provider/Services/ProviderAdapter.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { type QueuedMoveStart, ThreadMoves, type ThreadMovesShape } from "./ThreadMoves.ts";
import { makeThreadMoveContextReader, type ThreadMoveContext } from "./threadMoveView.ts";

export interface MoveQueueShape {
  readonly queue: (
    input: ThreadMoveQueueInput & { readonly requestedBy?: ThreadMoveRequester },
  ) => Effect.Effect<ThreadMoveQueueResult, ThreadMoveError>;
  readonly unqueue: (input: ThreadMoveUnqueueInput) => Effect.Effect<void, ThreadMoveError>;
  readonly retry: (input: ThreadMoveRetryInput) => Effect.Effect<void, ThreadMoveError>;
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
  readonly quiesce: (threadId: ThreadId) => Effect.Effect<ProviderStopConfirmation>;
  readonly checkQueue: ThreadMovesShape["checkQueue"];
  readonly startQueued: ThreadMovesShape["startQueued"];
  /** v1's cancel of the thread's move under way. */
  readonly cancelMove: ThreadMovesShape["cancel"];
  /** The wait before trying a held move again, by how many times it was held. */
  readonly retryDelay?: (attempt: number) => Duration.Duration;
  /** How long to gather a burst of changes before looking. */
  readonly settleDelay?: Duration.Duration;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const moveError = (detail: string) => new ThreadMoveError({ detail });

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
  threadMoveRefusals({ projects: [], threads: [thread] }, thread);

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
        const refusals = threadMoveRefusals(context.view, context.thread);
        if (yield* settleRefusals(threadId, pending, refusals)) return;
        yield* report(threadId, pending, [], pending.hold ?? null);

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
        const outcome: QueuedMoveStart = yield* deps.startQueued({
          threadId,
          requestId,
          targetEnvironmentId: pending.target.environmentId,
          agent: pending.agent,
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
    // The service.
    // -------------------------------------------------------------------------

    const queue: MoveQueueShape["queue"] = (input) =>
      Effect.gen(function* () {
        const { label } = yield* deps.checkQueue({
          threadId: input.threadId,
          targetEnvironmentId: input.targetEnvironmentId,
          agent: input.agent,
        });
        const requestId = ThreadMoveRequestId.make(randomUUID());
        yield* deps
          .dispatch({
            type: "thread.move.queue",
            commandId: CommandId.make(`server:thread-move-queue:${requestId}:queue`),
            threadId: input.threadId,
            requestId,
            target: { environmentId: input.targetEnvironmentId, label },
            agent: input.agent,
            mode: input.mode,
            requestedBy: input.requestedBy ?? { kind: "user" },
            createdAt: yield* nowIso,
          })
          .pipe(Effect.mapError((error) => moveError(error.message)));
        return { requestId };
      });

    const unqueue: MoveQueueShape["unqueue"] = (input) =>
      Effect.gen(function* () {
        const read = deps.readThread(input.threadId);
        const thread = yield* read;
        if (thread === null) return;
        if (thread.pendingMove?.requestId === input.requestId) {
          yield* deps
            .dispatch({
              type: "thread.move.unqueue",
              commandId: commandId(input.requestId, "unqueue"),
              threadId: input.threadId,
              requestId: input.requestId,
              createdAt: yield* nowIso,
            })
            .pipe(Effect.mapError((error) => moveError(error.message)));
        }
        // Read after the cancel: a start the decider took first is now the
        // thread's move, and the Cancel cancels its transfer instead.
        const move = (yield* read)?.move ?? null;
        if (move === null || move.queuedRequestId !== input.requestId) return;
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

    return MoveQueue.of({ queue, unqueue, retry, startReactor });
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
      quiesce: providers.quiesceThread,
      checkQueue: threadMoves.checkQueue,
      startQueued: threadMoves.startQueued,
      cancelMove: threadMoves.cancel,
    });
  }),
);
