import type { PullRequestDiffResult } from "@threadlines/contracts";

/** The patch cap the wire enforces; past it the tail is dropped. */
export const PULL_REQUEST_DIFF_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Holds a patch to the wire cap, whichever host produced it. The viewer parses
 * whole files, so an over-cap or host-truncated patch is cut back to the last
 * complete `diff --git` block instead of ending mid-hunk. A single file bigger
 * than the cap has no such boundary, so it is cut at its last whole line.
 */
export function capPullRequestDiff(input: {
  readonly patch: string;
  readonly truncated: boolean;
  readonly maxBytes?: number;
}): PullRequestDiffResult {
  const maxBytes = input.maxBytes ?? PULL_REQUEST_DIFF_MAX_BYTES;
  const buffer = Buffer.from(input.patch, "utf8");
  if (buffer.length <= maxBytes && !input.truncated) {
    return { patch: input.patch, truncated: false };
  }

  const limit = Math.min(buffer.length, maxBytes);
  const fileBoundary = buffer.lastIndexOf("\ndiff --git ", limit - 1, "utf8");
  if (fileBoundary >= 0) {
    return { patch: buffer.subarray(0, fileBoundary + 1).toString("utf8"), truncated: true };
  }

  if (buffer.length <= maxBytes) {
    return { patch: input.patch, truncated: true };
  }

  const lineBoundary = buffer.lastIndexOf("\n", limit - 1, "utf8");
  const cut = lineBoundary >= 0 ? lineBoundary + 1 : limit;
  return { patch: buffer.subarray(0, cut).toString("utf8"), truncated: true };
}
