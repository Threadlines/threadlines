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
