/**
 * Reading a provider's usage right now, for a decision that can't wait for
 * the next periodic check (a usage limit just hit, or a thread about to
 * continue after one).
 *
 * @module freshProviderSnapshot
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

/** How long a usage decision waits for a fresh check before going with the reading it has. */
export const FRESH_PROVIDER_SNAPSHOT_WAIT = Duration.seconds(15);

/**
 * Runs `refresh` and waits up to `wait` for it, then goes on with `current`.
 * The check is never cut off: it may be an agent's CLI renewing its sign-in,
 * and stopping that midway signs the user out (docs/providers/claude.md). It
 * finishes in the background and publishes its reading as usual.
 */
export const freshOrCurrentSnapshot = <A>(
  refresh: Effect.Effect<A>,
  current: Effect.Effect<A>,
  wait: Duration.Input = FRESH_PROVIDER_SNAPSHOT_WAIT,
): Effect.Effect<A> =>
  Effect.gen(function* () {
    const check = yield* Effect.forkDetach(refresh);
    const fresh = yield* Fiber.join(check).pipe(Effect.timeoutOption(wait));
    return Option.isSome(fresh) ? fresh.value : yield* current;
  });
