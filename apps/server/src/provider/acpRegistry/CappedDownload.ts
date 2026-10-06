// @effect-diagnostics nodeBuiltinImport:off - streams the download to disk
/**
 * CappedDownload — fetches a file whose size isn't known up front: at most
 * `maxBytes` are accepted, and the sha256 of what arrived is returned for
 * the caller to judge. The counterpart of `VerifiedDownload`, which knows
 * the exact size and hash before it starts.
 *
 * @module provider/acpRegistry/CappedDownload
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import { pipeline } from "node:stream/promises";

import { ManagedRuntimeError, managedRuntimeError } from "../managedRuntime/ManagedRuntimeStore.ts";
import type { DownloadFetch } from "../managedRuntime/VerifiedDownload.ts";

export interface CappedDownloadInput {
  readonly fetch: DownloadFetch;
  /** The program's name as users know it, for messages. */
  readonly label: string;
  readonly url: string;
  /** The largest download accepted. */
  readonly maxBytes: number;
  /** Must not exist yet. */
  readonly destination: string;
  readonly signal: AbortSignal;
  /** `totalBytes` is the size the server declared, when it declared one. */
  readonly onReceived: (receivedBytes: number, totalBytes: number | undefined) => void;
}

export interface CappedDownloadResult {
  /** Lowercase hex. */
  readonly sha256: string;
  readonly bytes: number;
}

const formatSize = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.max(1, Math.ceil(bytes / 1024 ** 2))} MB`;

/**
 * Streams `url` to `destination`, hashing as it goes and stopping as soon as
 * it runs past `maxBytes`. Throws a `ManagedRuntimeError`: `download` when
 * the transfer fails or is too large, `diskFull` when the declared size
 * doesn't fit on the disk.
 */
export async function downloadCapped(input: CappedDownloadInput): Promise<CappedDownloadResult> {
  const { label, maxBytes } = input;
  const unreachable = `Couldn't download ${label}. Check your internet connection and try again.`;
  const tooLarge = (detail: string) =>
    managedRuntimeError(
      "download",
      `The ${label} download is larger than the ${formatSize(maxBytes)} Threadlines allows, so nothing was installed.`,
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
    await response.body?.cancel().catch(() => undefined);
    throw managedRuntimeError(
      "download",
      `The ${label} download failed (HTTP ${response.status}). Try again in a few minutes.`,
      { detail: `${input.url} returned ${response.status}` },
    );
  }
  const encoding = response.headers.get("content-encoding");
  const declaredHeader = response.headers.get("content-length");
  const declared =
    (encoding === null || encoding === "identity") &&
    declaredHeader !== null &&
    /^\d+$/u.test(declaredHeader)
      ? Number(declaredHeader)
      : undefined;
  if (declared !== undefined) {
    const refusal =
      declared > maxBytes
        ? tooLarge(`server declared ${declared} bytes`)
        : await NodeFS.statfs(NodePath.dirname(input.destination)).then(
            (stats) => {
              const free = stats.bavail * stats.bsize;
              return free < declared
                ? managedRuntimeError(
                    "diskFull",
                    `${label} is a ${formatSize(declared)} download, and only ${formatSize(free)} of disk space is free. Free up some space and try again.`,
                  )
                : undefined;
            },
            () => undefined,
          );
    if (refusal) {
      await response.body.cancel().catch(() => undefined);
      throw refusal;
    }
  }

  const hash = createHash("sha256");
  let received = 0;
  const reader = response.body.getReader();
  // A read that is waiting on a stalled server ends when the body is
  // cancelled, whether or not `fetch` itself reacts to the signal.
  const cancelBody = () => void reader.cancel().catch(() => undefined);
  input.signal.addEventListener("abort", cancelBody, { once: true });
  try {
    await pipeline(
      async function* () {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > maxBytes) throw tooLarge(`received more than ${maxBytes} bytes`);
            hash.update(value);
            input.onReceived(received, declared);
            yield value;
          }
        } catch (cause) {
          if (cause instanceof ManagedRuntimeError) throw cause;
          throw managedRuntimeError("download", unreachable, { cause });
        } finally {
          cancelBody();
        }
        // Cancelled, not complete.
        input.signal.throwIfAborted();
      },
      createWriteStream(input.destination, { flags: "wx", mode: 0o600 }),
      { signal: input.signal },
    );
  } finally {
    input.signal.removeEventListener("abort", cancelBody);
  }
  if (declared !== undefined && received !== declared) {
    throw managedRuntimeError("download", unreachable, {
      detail: `received ${received} bytes of the ${declared} the server declared`,
    });
  }
  return { sha256: hash.digest("hex"), bytes: received };
}
