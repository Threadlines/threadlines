// @effect-diagnostics nodeBuiltinImport:off - streams the download to disk
/**
 * VerifiedDownload — fetches a pinned release archive to disk: the exact
 * size and sha256 are known up front, and anything else is refused.
 *
 * @module provider/managedRuntime/VerifiedDownload
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import { ManagedRuntimeError, managedRuntimeError } from "./ManagedRuntimeStore.ts";

/** The part of `fetch` a download uses; tests pass a stub. */
export type DownloadFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface VerifiedDownloadInput {
  readonly fetch: DownloadFetch;
  /** The program's name as users know it, for messages. */
  readonly label: string;
  readonly url: string;
  /** Lowercase or uppercase hex. */
  readonly sha256: string;
  readonly bytes: number;
  /** Must not exist yet. */
  readonly destination: string;
  readonly signal: AbortSignal;
  readonly onReceived: (receivedBytes: number) => void;
}

/**
 * Streams `url` to `destination`, hashing as it goes and stopping as soon as
 * it runs past the expected size. Throws a `ManagedRuntimeError`: `download`
 * when the transfer fails, `checksum` when what arrived isn't the release.
 */
export async function downloadVerified(input: VerifiedDownloadInput): Promise<void> {
  const { label } = input;
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
  if (
    (encoding === null || encoding === "identity") &&
    declaredLength !== null &&
    Number(declaredLength) !== input.bytes
  ) {
    await response.body.cancel().catch(() => undefined);
    throw mismatch(`server declared ${declaredLength} bytes, expected ${input.bytes}`);
  }

  const hash = createHash("sha256");
  let received = 0;
  await pipeline(
    response.body,
    async function* (source: AsyncIterable<Uint8Array>) {
      try {
        for await (const chunk of source) {
          received += chunk.byteLength;
          if (received > input.bytes) {
            throw mismatch(`received more than ${input.bytes} bytes`);
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
  if (received !== input.bytes || digest !== input.sha256.toLowerCase()) {
    throw mismatch(`received ${received} bytes with sha256 ${digest}`);
  }
}
