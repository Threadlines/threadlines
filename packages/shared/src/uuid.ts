import * as Effect from "effect/Effect";

/**
 * Cryptographically random UUIDv4.
 *
 * Effect 4.0.0-beta.97 moved UUID generation from `Random` onto the `Crypto`
 * service, which has no default implementation. Threading that service through
 * every caller buys us nothing on our supported runtimes (Node >= 22 and every
 * evergreen browser ship `crypto.randomUUID`), so this wrapper keeps UUIDs
 * dependency-free.
 */
export const randomUUIDv4: Effect.Effect<string> = Effect.sync(() =>
  globalThis.crypto.randomUUID(),
);
