/**
 * Per-file diff statistics shared by provider adapters and the client.
 *
 * Adapters attach `{ path, additions, deletions }` entries to file-change
 * runtime events (`payload.data.changes`) so the client can render exact
 * per-file +/- counts without waiting on checkpoint diffs. The client uses
 * the same counters to derive stats from raw unified diffs (e.g. Codex
 * patch payloads).
 */

export interface FileChangeStat {
  readonly path: string;
  readonly kind?: "add" | "update" | "delete" | undefined;
  readonly additions: number;
  readonly deletions: number;
}

export interface DiffLineStats {
  readonly additions: number;
  readonly deletions: number;
}

/** Counts added/removed lines in a unified diff body, ignoring the
 *  `+++`/`---` file headers. */
export function countUnifiedDiffStats(diff: string): DiffLineStats {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

/** Counts +/- lines across `structuredPatch` hunks as emitted by Claude
 *  Code's file tools (jsdiff hunks: lines prefixed `+`, `-`, or a space). */
export function countStructuredPatchStats(hunks: unknown): DiffLineStats | null {
  if (!Array.isArray(hunks)) {
    return null;
  }
  let additions = 0;
  let deletions = 0;
  let sawHunk = false;
  for (const hunk of hunks) {
    if (!hunk || typeof hunk !== "object") {
      continue;
    }
    const lines = (hunk as { lines?: unknown }).lines;
    if (!Array.isArray(lines)) {
      continue;
    }
    sawHunk = true;
    for (const line of lines) {
      if (typeof line !== "string") {
        continue;
      }
      if (line.startsWith("+")) {
        additions += 1;
      } else if (line.startsWith("-")) {
        deletions += 1;
      }
    }
  }
  return sawHunk ? { additions, deletions } : null;
}
