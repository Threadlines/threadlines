// @effect-diagnostics cryptoRandomUUIDInEffect:off
import * as Effect from "effect/Effect";

const BYTE_TO_HEX: ReadonlyArray<string> = Array.from({ length: 256 }, (_unused, byte) =>
  byte.toString(16).padStart(2, "0"),
);

const hexAt = (bytes: Uint8Array, index: number): string => BYTE_TO_HEX[bytes[index] ?? 0] ?? "00";

/**
 * Cryptographically random UUIDv4 that also works in insecure browser contexts.
 *
 * `crypto.randomUUID` is secure-context only. A phone paired over plain
 * `http://<lan-ip>:<port>` gets `undefined` for it, so every direct call site
 * threw `crypto.randomUUID is not a function` and took the app down with it.
 * `crypto.getRandomValues` has no such restriction, so fall back to formatting
 * RFC 4122 v4 bytes by hand when the one-shot API is missing.
 *
 * Effect 4.0.0-beta.97 moved UUID generation from `Random` onto the `Crypto`
 * service, which has no default implementation. Threading that service through
 * every caller buys us nothing, so this wrapper keeps UUIDs dependency-free.
 */
export function randomUUIDv4Sync(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }

  if (typeof webCrypto?.getRandomValues !== "function") {
    throw new Error("No Web Crypto random source is available to generate a UUID.");
  }

  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  // Version 4 (random) and RFC 4122 variant bits.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  return [
    `${hexAt(bytes, 0)}${hexAt(bytes, 1)}${hexAt(bytes, 2)}${hexAt(bytes, 3)}`,
    `${hexAt(bytes, 4)}${hexAt(bytes, 5)}`,
    `${hexAt(bytes, 6)}${hexAt(bytes, 7)}`,
    `${hexAt(bytes, 8)}${hexAt(bytes, 9)}`,
    `${hexAt(bytes, 10)}${hexAt(bytes, 11)}${hexAt(bytes, 12)}${hexAt(bytes, 13)}${hexAt(bytes, 14)}${hexAt(bytes, 15)}`,
  ].join("-");
}

export const randomUUIDv4: Effect.Effect<string> = Effect.sync(randomUUIDv4Sync);
