/**
 * Rooms: the barrier between one agent's turn being recorded and the next
 * agent writing to the same checkout (docs/design/rooms-slice-2.md, Part B,
 * "Handover checkpoint barrier").
 *
 * The checkpoint reactor opens a room turn when it starts and finishes it once
 * its final capture is done (published, refused, or not needed). Every capture
 * runs under its thread's lock and refuses a turn that is closed. Handing the
 * thread to another agent waits for the open turn's final capture, for a
 * bounded time, then closes that turn under the same lock. So the next agent
 * is never let in while a capture of the previous turn is running, and no
 * capture of it can start afterwards: the previous turn's checkpoint either
 * reflects only its own work or does not exist.
 *
 * In memory: captures and provider turns do not outlive the process.
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

interface OpenTurn {
  readonly turnId: string;
  /** The agent working the turn. Null: the thread's own agent. */
  readonly participantId: string | null;
  readonly finished: Deferred.Deferred<void>;
}

interface ThreadGate {
  readonly lock: Semaphore.Semaphore;
  open: OpenTurn | null;
  readonly closed: Set<string>;
}

const MAX_CLOSED_TURNS_PER_THREAD = 64;
const gates = new Map<string, ThreadGate>();

const gateFor = (threadId: string) =>
  Effect.gen(function* () {
    const existing = gates.get(threadId);
    if (existing !== undefined) {
      return existing;
    }
    const created: ThreadGate = {
      lock: yield* Semaphore.make(1),
      open: null,
      closed: new Set(),
    };
    gates.set(threadId, created);
    return created;
  });

const finish = (gate: ThreadGate, turnId: string) =>
  Effect.gen(function* () {
    const open = gate.open;
    if (open === null || open.turnId !== turnId) {
      return;
    }
    gate.open = null;
    yield* Deferred.succeed(open.finished, undefined);
  });

export const checkpointHandover = {
  /** A room turn started: its final capture is now owed. */
  turnStarted: (threadId: string, turnId: string, participantId: string | null) =>
    Effect.gen(function* () {
      const gate = yield* gateFor(threadId);
      const previous = gate.open;
      gate.open = { turnId, participantId, finished: yield* Deferred.make<void>() };
      // A turn that starts after another supersedes it; nothing waits on the old one now.
      if (previous !== null) {
        yield* Deferred.succeed(previous.finished, undefined);
      }
    }),

  /** The turn's final capture is done, or will not happen. Idempotent. */
  finalCaptureFinished: (threadId: string, turnId: string) =>
    Effect.gen(function* () {
      const gate = gates.get(threadId);
      if (gate !== undefined) {
        yield* finish(gate, turnId);
      }
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
   * Whether a turn for `participantId` has to wait for another agent's turn to
   * be recorded first.
   */
  mustWait: (threadId: string, participantId: string | null): boolean => {
    const open = gates.get(threadId)?.open ?? null;
    return open !== null && open.participantId !== participantId;
  },

  /**
   * Hand the thread to `participantId`: wait for another agent's open turn to
   * be recorded, at most `wait`, then close that turn for good under the
   * lock (which waits out a capture already running).
   */
  handOver: (threadId: string, participantId: string | null, wait: Duration.Input) =>
    Effect.gen(function* () {
      const gate = gates.get(threadId);
      const open = gate?.open ?? null;
      if (gate === undefined || open === null || open.participantId === participantId) {
        return;
      }
      const recorded = yield* Deferred.await(open.finished).pipe(Effect.timeoutOption(wait));
      if (Option.isNone(recorded)) {
        yield* Effect.logWarning(
          "handover did not wait any longer for the previous turn's checkpoint",
          { threadId, turnId: open.turnId },
        );
      }
      yield* gate.lock.withPermits(1)(
        Effect.gen(function* () {
          gate.closed.add(open.turnId);
          if (gate.closed.size > MAX_CLOSED_TURNS_PER_THREAD) {
            const oldest = gate.closed.values().next().value;
            if (oldest !== undefined) gate.closed.delete(oldest);
          }
          yield* finish(gate, open.turnId);
        }),
      );
    }),
};
