/**
 * Reads of files Threadlines doesn't control (the user's `~/.gemini`, a
 * project's skills, the agent's profile) that can never hang or balloon.
 *
 * The open never blocks: a FIFO or device opens at once and is then refused
 * because only a regular file is read, judged from the open handle, so a
 * path swapped after a check can't slip anything else in. Reads stop at a
 * byte cap.
 *
 * @module provider/antigravity/AntigravityFileReads
 */
import { constants } from "node:fs";
import * as fs from "node:fs/promises";

const OPEN_FOLLOW = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
const OPEN_NO_FOLLOW = OPEN_FOLLOW | (constants.O_NOFOLLOW ?? 0);

export interface OpenedRegularFile {
  readonly handle: fs.FileHandle;
  readonly size: number;
}

/**
 * Opens `path` when it is a regular file; undefined for anything else, a
 * missing file, or (with `followLink: false`) a link at the last step.
 */
export async function openRegularFile(
  path: string,
  options: { readonly followLink: boolean },
): Promise<OpenedRegularFile | undefined> {
  const handle = await fs
    .open(path, options.followLink ? OPEN_FOLLOW : OPEN_NO_FOLLOW)
    .catch(() => undefined);
  if (!handle) return undefined;
  const stat = await handle.stat().catch(() => undefined);
  if (!stat?.isFile()) {
    await handle.close();
    return undefined;
  }
  return { handle, size: stat.size };
}

/**
 * Reads at most `maxBytes` from an already-open regular file handle, sizing
 * the initial buffer from `expectedSize` rather than `maxBytes + 1` so small
 * files avoid megabyte allocations while still refusing a file that grew past
 * `maxBytes` after `stat`.
 */
export async function readOpenedRegularFile(
  handle: fs.FileHandle,
  options: {
    readonly maxBytes: number;
    readonly expectedSize?: number;
    readonly from?: number;
  },
): Promise<Buffer | undefined> {
  const from = options.from ?? 0;
  const maxBytes = options.maxBytes;
  const limit = maxBytes + 1;
  const expected =
    options.expectedSize !== undefined ? Math.max(0, options.expectedSize - from) : 4096;
  const initialCapacity = Math.min(limit, Math.max(1, expected + 1));
  let buffer = Buffer.allocUnsafe(initialCapacity);
  let total = 0;
  while (total < limit) {
    if (total === buffer.length) {
      const nextCapacity = Math.min(limit, Math.max(buffer.length * 2, total + 4096));
      const next = Buffer.allocUnsafe(nextCapacity);
      buffer.copy(next, 0, 0, total);
      buffer = next;
    }
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, from + total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total > maxBytes ? undefined : buffer.subarray(0, total);
}

/** The bytes of a regular file of at most `maxBytes`; undefined otherwise. */
export async function readRegularFile(
  path: string,
  options: { readonly maxBytes: number; readonly followLink: boolean },
): Promise<Buffer | undefined> {
  const opened = await openRegularFile(path, options);
  if (!opened) return undefined;
  try {
    if (opened.size > options.maxBytes) return undefined;
    return await readOpenedRegularFile(opened.handle, {
      maxBytes: options.maxBytes,
      expectedSize: opened.size,
    });
  } finally {
    await opened.handle.close();
  }
}
