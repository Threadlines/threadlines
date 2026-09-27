/**
 * Rooms: the barrier between one agent's turn being recorded and the next
 * agent writing to the same checkout (docs/design/rooms-slice-2.md, Part B,
 * "Handover checkpoint barrier").
 *
 * A turn is registered as owing its final capture as soon as it is accepted
 * (and again when the checkpoint reactor sees it start), whether or not its
 * thread is a room yet. The checkpoint reactor marks it finished once its
 * final capture is done, skipped, or not needed. Every capture runs under its
 * thread's lock and refuses a turn that is closed. Handing the thread to
 * another agent names the previous turn: it waits for that turn to finish,
 * for a bounded time, then closes it for good under the same lock, which
 * waits out a capture already running. So the next agent is never let in
 * while the previous turn is being captured, and no capture of it can start
 * afterwards, not even a repeated one.
 *
 * In memory: captures and provider turns do not outlive the process, so a
 * turn this process never saw has nothing in flight and is closed at once.
 */
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

/**
 * How long a turn for another agent waits for the previous turn's checkpoint
 * before closing that turn anyway. A test without the checkpoint reactor sets
 * it to zero.
 */
export const HandoverCaptureWait = Context.Reference<Duration.Duration>(
  "threadlines/HandoverCaptureWait",
  { defaultValue: () => Duration.seconds(10) },
);

interface ThreadGate {
  readonly lock: Semaphore.Semaphore;
  /** Turns owing their final capture, each with what finishing it resolves. */
  readonly pending: Map<string, Deferred.Deferred<void>>;
  readonly closed: Set<string>;
}

const MAX_TURNS_PER_THREAD = 64;
const gates = new Map<string, ThreadGate>();

const gateFor = (threadId: string) =>
  Effect.gen(function* () {
    const existing = gates.get(threadId);
    if (existing !== undefined) {
      return existing;
    }
    const created: ThreadGate = {
      lock: yield* Semaphore.make(1),
      pending: new Map(),
      closed: new Set(),
    };
    gates.set(threadId, created);
    return created;
  });

const remember = <T>(entries: Map<string, T> | Set<string>) => {
  if (entries.size > MAX_TURNS_PER_THREAD) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
};

export const checkpointHandover = {
  /** A turn was accepted or started: its final capture is now owed. Idempotent. */
  turnStarted: (threadId: string, turnId: string) =>
    Effect.gen(function* () {
      const gate = yield* gateFor(threadId);
      if (gate.pending.has(turnId) || gate.closed.has(turnId)) {
        return;
      }
      gate.pending.set(turnId, yield* Deferred.make<void>());
      remember(gate.pending);
    }),

  /** The turn's final capture is done, or will not happen. Idempotent. */
  finalCaptureFinished: (threadId: string, turnId: string) =>
    Effect.gen(function* () {
      const gate = gates.get(threadId);
      const finished = gate?.pending.get(turnId);
      if (gate === undefined || finished === undefined) {
        return;
      }
      gate.pending.delete(turnId);
      yield* Deferred.succeed(finished, undefined);
    }),

  /**
   * Run a capture of a turn under its thread's lock. A turn closed by a
   * handover is not captured: None.
   */
  capture: <A, E, R>(threadId: string, turnId: string, run: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const gate = yield* gateFor(threadId);
      return yield* gate.lock.withPermits(1)(
        gate.closed.has(turnId)
          ? Effect.logInfo("checkpoint capture skipped: the thread was handed to another agent", {
              threadId,
              turnId,
            }).pipe(Effect.as(Option.none<A>()))
          : run.pipe(Effect.map(Option.some)),
      );
    }),

  /**
   * The thread goes to another agent after `turnId`: wait for that turn to be
   * recorded, at most `wait`, then close it for good under the lock.
   */
  handOver: (threadId: string, turnId: string, wait: Duration.Input) =>
    Effect.gen(function* () {
      const gate = yield* gateFor(threadId);
      const finished = gate.pending.get(turnId);
      if (finished !== undefined) {
        const recorded = yield* Deferred.await(finished).pipe(Effect.timeoutOption(wait));
        if (Option.isNone(recorded)) {
          yield* Effect.logWarning(
            "handover did not wait any longer for the previous turn's checkpoint",
            { threadId, turnId },
          );
        }
      }
      yield* gate.lock.withPermits(1)(
        Effect.gen(function* () {
          gate.closed.add(turnId);
          remember(gate.closed);
          const stillOwed = gate.pending.get(turnId);
          gate.pending.delete(turnId);
          if (stillOwed !== undefined) {
            yield* Deferred.succeed(stillOwed, undefined);
          }
        }),
      );
    }),
};
