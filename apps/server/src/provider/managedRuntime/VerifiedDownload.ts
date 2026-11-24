// @effect-diagnostics nodeBuiltinImport:off - streams the download to disk
/**
 * VerifiedDownload — fetches a release archive to disk, refusing anything
 * that isn't it: the hash (sha256 or sha512) is known up front, and so is
 * the exact size, or for a source that lists none (Antigravity's update
 * feed) a cap the download may not pass.
 *
 * @module provider/managedRuntime/VerifiedDownload
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import { ManagedRuntimeError, managedRuntimeError } from "./ManagedRuntimeStore.ts";

/** The part of `fetch` a download uses; tests pass a stub. */
export type DownloadFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The download's hash, in lowercase or uppercase hex. */
export type VerifiedDownloadDigest =
  | { readonly sha256: string; readonly sha512?: never }
  | { readonly sha512: string; readonly sha256?: never };

/** The exact size, or only a cap when the source lists none. */
export type VerifiedDownloadSize =
  | { readonly bytes: number; readonly maxBytes?: never }
  | { readonly maxBytes: number; readonly bytes?: never };

export type VerifiedDownloadInput = VerifiedDownloadDigest &
  VerifiedDownloadSize & {
    readonly fetch: DownloadFetch;
    /** The program's name as users know it, for messages. */
    readonly label: string;
    readonly url: string;
    /** Must not exist yet. */
    readonly destination: string;
    readonly signal: AbortSignal;
    readonly onReceived: (receivedBytes: number) => void;
  };

/**
 * Streams `url` to `destination`, hashing as it goes and stopping as soon as
 * it runs past the expected size or the cap. Resolves to the number of bytes
 * written. Throws a `ManagedRuntimeError`: `download` when the transfer
 * fails, `checksum` when what arrived isn't the release.
 */
export async function downloadVerified(input: VerifiedDownloadInput): Promise<number> {
  const { label } = input;
  const algorithm = input.sha512 !== undefined ? "sha512" : "sha256";
  const expectedDigest = (input.sha512 ?? input.sha256).toLowerCase();
  const exactBytes = input.bytes;
  const limit = input.bytes ?? input.maxBytes;
  const unreachable = `Couldn't download ${label}. Check your internet connection and try again.`;
  const mismatch = (detail: string) =>
    managedRuntimeError(
      "checksum",
      `The ${label} download didn't match the expected release, so nothing was installed. Try again in a few minutes.`,
      { detail },
    );
  let response: Response;
  try {
    // Servers that gzip when allowed report the compressed size as
    // content-length; ask for the bytes as published.
    response = await input.fetch(input.url, {
      headers: { "accept-encoding": "identity" },
      redirect: "follow",
      signal: input.signal,
    });
  } catch (cause) {
    throw managedRuntimeError("download", unreachable, { cause });
  }
  if (!response.ok || response.body === null) {
    throw managedRuntimeError(
      "download",
      `The ${label} download failed (HTTP ${response.status}). Try again in a few minutes.`,
      { detail: `${input.url} returned ${response.status}` },
    );
  }
  const encoding = response.headers.get("content-encoding");
  const declaredLength = response.headers.get("content-length");
  const declaredBytes =
    (encoding === null || encoding === "identity") && declaredLength !== null
      ? Number(declaredLength)
      : undefined;
  if (
    declaredBytes !== undefined &&
    (exactBytes !== undefined ? declaredBytes !== exactBytes : declaredBytes > limit)
  ) {
    await response.body.cancel().catch(() => undefined);
    throw mismatch(
      exactBytes !== undefined
        ? `server declared ${declaredLength} bytes, expected ${exactBytes}`
        : `server declared ${declaredLength} bytes, more than the ${limit} allowed`,
    );
  }

  const hash = createHash(algorithm);
  let received = 0;
  await pipeline(
    response.body,
    async function* (source: AsyncIterable<Uint8Array>) {
      try {
        for await (const chunk of source) {
          received += chunk.byteLength;
          if (received > limit) {
            throw mismatch(`received more than ${limit} bytes`);
          }
          hash.update(chunk);
          input.onReceived(received);
          yield chunk;
        }
      } catch (cause) {
        if (cause instanceof ManagedRuntimeError) throw cause;
        throw managedRuntimeError("download", unreachable, { cause });
      }
    },
    createWriteStream(input.destination, { flags: "wx", mode: 0o600 }),
    { signal: input.signal },
  );
  const digest = hash.digest("hex");
  if ((exactBytes !== undefined && received !== exactBytes) || digest !== expectedDigest) {
    throw mismatch(`received ${received} bytes with ${algorithm} ${digest}`);
  }
  return received;
}
