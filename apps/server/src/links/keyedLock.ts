import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * One holder per key at a time: `lock(key)(effect)` runs `effect` once no
 * other effect holds that key, and other keys go on meanwhile. Used for work
 * that must not interleave with other work on the same thing (a link
 * request's stages, a computer's links being made). A key is forgotten once
 * nothing holds or waits for it.
 */
export const makeKeyedLock = () => {
  const locks = new Map<string, { readonly semaphore: Semaphore.Semaphore; holders: number }>();
  return (key: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        let entry = locks.get(key);
        if (entry === undefined) {
          entry = { semaphore: Semaphore.makeUnsafe(1), holders: 0 };
          locks.set(key, entry);
        }
        const held = entry;
        held.holders += 1;
        return held.semaphore
          .withPermits(1)(effect)
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                held.holders -= 1;
                if (held.holders === 0) locks.delete(key);
              }),
            ),
          );
      });
};
