import type { ProjectSetupProgress } from "@threadlines/contracts";

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

const UNIT_BYTES: Record<string, number> = {
  bytes: 1,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
};

/** The bytes git says it has received ("286.46 MiB | 19.23 MiB/s"), or null. */
export function receivedBytesOf(detail: string | null): number | null {
  const match = /^([\d.]+)\s*(bytes|KiB|MiB|GiB)\b/i.exec(detail?.trim() ?? "");
  if (match === null) return null;
  const amount = Number(match[1]);
  const unit = UNIT_BYTES[match[2]!.toLowerCase()];
  return Number.isFinite(amount) && unit !== undefined ? Math.round(amount * unit) : null;
}

/**
 * The percent to show for a progress line. While git receives objects its
 * own percent counts objects, so a repository whose bytes sit in a few large
 * files reads 98% with most of the download still to come: measured against
 * the expected size instead, held at 99% until git itself says 100%.
 */
export function displayClonePercent(
  progress: Omit<ProjectSetupProgress, "stalled">,
  expectedBytes: number | undefined,
): number | null {
  if (
    progress.phase !== "Receiving objects" ||
    progress.percent === 100 ||
    expectedBytes === undefined ||
    expectedBytes <= 0
  ) {
    return progress.percent;
  }
  const received = receivedBytesOf(progress.detail);
  if (received === null) return progress.percent;
  return Math.min(99, Math.floor((received / expectedBytes) * 100));
}
