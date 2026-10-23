import type { ProjectSetupProgress } from "@threadlines/contracts";
import { parseGitTransferProgress } from "@threadlines/shared/git";

/**
 * Git's clone progress, as `git clone --progress` writes it to stderr:
 * lines like "Receiving objects:  24% (1200/5000), 168.80 MiB | 20.69 MiB/s",
 * each rewritten in place with `\r`. The last whole line wins.
 */

const PROGRESS_LINE =
  /^(?:remote:\s*)?([A-Za-z][A-Za-z ]+?):\s+(\d{1,3})%(?:\s*\([^)]*\))?,?\s*(.*)$/;

/** The latest progress in `text` (any chunk of stderr), or null when it holds none. */
export function parseCloneProgress(text: string): Omit<ProjectSetupProgress, "stalled"> | null {
  const lines = text.split(/[\r\n]+/).filter((line) => line.trim().length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = PROGRESS_LINE.exec(lines[index]!.trim());
    if (match === null) continue;
    const percent = Math.min(100, Number(match[2]));
    const detail = match[3]?.replace(/,?\s*done\.?$/, "").trim() ?? "";
    return { phase: match[1]!.trim(), percent, detail: detail.length > 0 ? detail : null };
  }
  return null;
}

/** The bytes git says it has received ("286.46 MiB | 19.23 MiB/s"), or null. */
export const receivedBytesOf = (detail: string | null): number | null =>
  parseGitTransferProgress(detail)?.receivedBytes ?? null;

/** Where each of git's local phases lands on the one bar: [start, share]. */
const PHASE_SHARES: Record<string, readonly [number, number]> = {
  "Receiving objects": [0, 90],
  "Resolving deltas": [90, 7],
  "Updating files": [97, 3],
  "Checking out files": [97, 3],
};

/**
 * One percent for the whole clone, for one progress line. Each of git's
 * phases counts 0 to 100 on its own; here they share one bar: receiving fills
 * it to 90, resolving deltas to 97, writing the files to 100. The server-side
 * phases before the download (counting, compressing) give no number.
 * Receiving counts objects in git's own percent, so a repository whose bytes
 * sit in a few large files would read 98% with most of the download to come:
 * with `expectedBytes`, it is the bytes received against it instead, held
 * short of the phase's end until git says it's done. The caller keeps the
 * bar from going back.
 */
export function overallClonePercent(
  progress: Omit<ProjectSetupProgress, "stalled">,
  expectedBytes: number | undefined,
): number | null {
  const share = progress.phase === null ? undefined : PHASE_SHARES[progress.phase];
  if (share === undefined || progress.percent === null) return null;
  let phasePercent = progress.percent;
  if (
    progress.phase === "Receiving objects" &&
    progress.percent < 100 &&
    expectedBytes !== undefined &&
    expectedBytes > 0
  ) {
    const received = receivedBytesOf(progress.detail);
    if (received !== null) phasePercent = Math.min(99, (received / expectedBytes) * 100);
  }
  return Math.floor(share[0] + (share[1] * phasePercent) / 100);
}
