/**
 * Which lane each provider turn was admitted to, decided once, by ingestion,
 * when the turn starts.
 *
 * In a room, a runtime that does not hold the thread can still start a turn
 * by itself (background work it left running woke it up); ingestion rejects
 * and interrupts that turn. The checkpoint reactor reads provider events on
 * its own schedule, so by the time it looks, the thread may have changed
 * hands. It asks this registry instead of re-deriving the lane from who holds
 * the thread when it gets there: a main turn's late completion after a
 * handover still checkpoints, and a rejected wake-up never does.
 *
 * In memory: provider turns do not outlive the process.
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export type TurnLane = "main" | "rejected";

/** How long a reader waits for ingestion to decide before assuming main. */
const DECISION_WAIT = Duration.seconds(3);
const MAX_REMEMBERED_TURNS = 1_000;

const decisions = new Map<string, Deferred.Deferred<TurnLane>>();

const keyOf = (sessionKey: string, providerTurnId: string) =>
  `${sessionKey}\u0000${providerTurnId}`;

const entryFor = (key: string) =>
  Effect.gen(function* () {
    const existing = decisions.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = yield* Deferred.make<TurnLane>();
    decisions.set(key, created);
    if (decisions.size > MAX_REMEMBERED_TURNS) {
      const oldest = decisions.keys().next().value;
      if (oldest !== undefined) decisions.delete(oldest);
    }
    return created;
  });

export const turnAdmission = {
  /** Record the lane a turn was admitted to. The first decision stands. */
  decide: (sessionKey: string, providerTurnId: string, lane: TurnLane) =>
    entryFor(keyOf(sessionKey, providerTurnId)).pipe(
      Effect.flatMap((deferred) => Deferred.succeed(deferred, lane)),
      Effect.asVoid,
    ),
  /**
   * The lane a turn was admitted to. A turn nobody decided on in time (its
   * thread gone, or started before this process) keeps the old behavior:
   * main.
   */
  laneOf: (sessionKey: string, providerTurnId: string) =>
    entryFor(keyOf(sessionKey, providerTurnId)).pipe(
      Effect.flatMap((deferred) =>
        Deferred.await(deferred).pipe(Effect.timeoutOption(DECISION_WAIT)),
      ),
      Effect.map((lane) => Option.getOrElse(lane, (): TurnLane => "main")),
    ),
};
