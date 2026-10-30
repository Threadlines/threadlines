/**
 * Limits per outside agent connection (docs/design/outside-agents.md,
 * "Limits per connection"), in memory: a restart starts them over, except
 * the daily starts, which the request rows count (OutsideAgentRequests).
 *
 * - Calls: 120 a minute, every tool. Over it, a call answers `limit` with
 *   the seconds until the oldest call in the minute falls out.
 * - Running: at most 4 of its threads at once, counted by the caller from
 *   live thread state plus the starts and sends the connection has in
 *   flight. `admit` holds the connection's lock while the caller counts and
 *   decides, and keeps an admitted call in flight until it answers, so two
 *   calls can't both take the last place. Sends never queue, so every turn
 *   a connection causes passes through here; nothing is reserved for later.
 * - Starts: 50 a day.
 */
import type { OrchestrationThreadShell, ThreadId } from "@threadlines/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { makeKeyedLock } from "../links/keyedLock.ts";

export const CONNECT_CALLS_PER_MINUTE = 120;
export const CONNECT_RUNNING_THREADS = 4;
export const CONNECT_STARTS_PER_DAY = 50;
const MINUTE_MS = 60_000;

/**
 * Whether a thread counts toward its connection's running threads: a turn
 * running or about to start, including one waiting on the user (an approval
 * or a question inside it).
 */
export const countsAsRunning = (
  thread: Pick<
    OrchestrationThreadShell,
    "session" | "latestTurn" | "hasPendingApprovals" | "hasPendingUserInput"
  >,
): boolean =>
  thread.latestTurn?.state === "running" ||
  thread.hasPendingApprovals ||
  thread.hasPendingUserInput ||
  (thread.session !== null &&
    (thread.session.activeTurnId !== null ||
      thread.session.status === "running" ||
      thread.session.status === "starting"));

export interface ConnectLimits {
  /** Counts one call; the seconds to wait instead when the connection made too many this minute. */
  readonly call: (connectionId: string) => Effect.Effect<number | null>;
  /** The threads a connection's starts and sends are working on now. */
  readonly inFlight: (connectionId: string) => ReadonlySet<ThreadId>;
  /**
   * Runs one start or send for `threadId`. `decide` runs under the
   * connection's lock and sees its threads in flight; it returns a refusal
   * (answered as is) or null to go on, and whatever it claims meanwhile (the
   * request row) is in place before the lock is let go. `work` then runs with
   * the thread counted in flight until it answers.
   *
   * `after` is work that goes on once `work` answered (an assistant's start
   * answers before its setup): forked into its scope, with the thread still
   * counted in flight until it ends.
   */
  readonly admit: <A, Refusal, E1, R1, E2, R2>(input: {
    readonly connectionId: string;
    readonly threadId: ThreadId;
    readonly decide: (inFlight: ReadonlySet<ThreadId>) => Effect.Effect<Refusal | null, E1, R1>;
    readonly work: Effect.Effect<A, E2, R2>;
    readonly after?: { readonly run: Effect.Effect<void>; readonly scope: Scope.Scope };
  }) => Effect.Effect<{ readonly refused: Refusal } | { readonly done: A }, E1 | E2, R1 | R2>;
}

export function makeConnectLimits(): ConnectLimits {
  const calls = new Map<string, Array<number>>();
  const flights = new Map<string, Set<ThreadId>>();
  const lock = makeKeyedLock();

  const call: ConnectLimits["call"] = (connectionId) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      const recent = (calls.get(connectionId) ?? []).filter((at) => at > now - MINUTE_MS);
      calls.set(connectionId, recent);
      if (recent.length >= CONNECT_CALLS_PER_MINUTE) {
        return Math.max(1, Math.ceil((recent[0]! + MINUTE_MS - now) / 1000));
      }
      recent.push(now);
      return null;
    });

  const inFlight: ConnectLimits["inFlight"] = (connectionId) =>
    flights.get(connectionId) ?? new Set();

  const leave = (connectionId: string, threadId: ThreadId) =>
    Effect.sync(() => {
      const set = flights.get(connectionId);
      set?.delete(threadId);
      if (set !== undefined && set.size === 0) flights.delete(connectionId);
    });

  const admit: ConnectLimits["admit"] = (input) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const refused = yield* restore(
          lock(input.connectionId)(
            Effect.gen(function* () {
              const refusal = yield* input.decide(inFlight(input.connectionId));
              if (refusal === null) {
                const set = flights.get(input.connectionId) ?? new Set<ThreadId>();
                set.add(input.threadId);
                flights.set(input.connectionId, set);
              }
              return refusal;
            }),
          ),
        );
        if (refused !== null) return { refused };
        const left = leave(input.connectionId, input.threadId);
        const after = input.after;
        if (after === undefined) {
          const done = yield* restore(input.work).pipe(Effect.ensuring(left));
          return { done };
        }
        const done = yield* restore(input.work).pipe(Effect.onError(() => left));
        yield* after.run.pipe(
          Effect.interruptible,
          Effect.ensuring(left),
          Effect.forkIn(after.scope),
        );
        return { done };
      }),
    );

  return { call, inFlight, admit };
}
