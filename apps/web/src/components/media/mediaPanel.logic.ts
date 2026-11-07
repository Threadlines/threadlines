/**
 * What the Media tab shows, from the entries the server lists: search, sort,
 * and the groups (by type or by thread). Pure, so the panel only renders.
 */
import type {
  OrchestrationMediaKind,
  OrchestrationProjectMediaEntry,
} from "@threadlines/contracts";
import { MEDIA_KIND_ORDER } from "@threadlines/shared/media";

import { pluralize } from "../../lib/utils";

export type MediaEntry = OrchestrationProjectMediaEntry;
export type MediaScope = "thread" | "project";
export type MediaSort = "newest" | "oldest" | "name";
export type MediaGroupBy = "type" | "thread";

export const MEDIA_KIND_LABELS: Readonly<Record<OrchestrationMediaKind, string>> = {
  picture: "Pictures",
  video: "Videos",
  audio: "Audio",
  document: "Documents",
};

/** The singular nouns the launcher row counts in. */
const MEDIA_KIND_NOUNS: Readonly<Record<OrchestrationMediaKind, string>> = {
  picture: "picture",
  video: "video",
  audio: "audio file",
  document: "document",
};

export interface MediaGroup {
  readonly key: string;
  readonly label: string;
  /** Files with something to look at (see `mediaShowsAsTile`), as a grid. */
  readonly tiles: ReadonlyArray<MediaEntry>;
  /** The rest, as rows under the grid. */
  readonly rows: ReadonlyArray<MediaEntry>;
}

/**
 * Whether a file gets a tile with a picture: pictures, PDFs (their first
 * page) and videos (their first frame, once played). Sound files and other
 * documents have nothing to show, so they are rows.
 */
export function mediaShowsAsTile(entry: Pick<MediaEntry, "mediaKind" | "relativePath">): boolean {
  switch (entry.mediaKind) {
    case "picture":
    case "video":
      return true;
    case "document":
      return entry.relativePath.toLowerCase().endsWith(".pdf");
    case "audio":
      return false;
  }
}

function splitGroup(key: string, label: string, entries: ReadonlyArray<MediaEntry>): MediaGroup {
  return {
    key,
    label,
    tiles: entries.filter(mediaShowsAsTile),
    rows: entries.filter((entry) => !mediaShowsAsTile(entry)),
  };
}

/** A file's own name, from its path inside the thread's folder. */
export function mediaFileName(entry: Pick<MediaEntry, "relativePath">): string {
  const parts = entry.relativePath.split(/[\\/]/u);
  return parts.at(-1) ?? entry.relativePath;
}

/** The folder a file sits in inside the thread's folder, "" at the top. */
export function mediaFolder(entry: Pick<MediaEntry, "relativePath">): string {
  const parts = entry.relativePath.split(/[\\/]/u);
  return parts.slice(0, -1).join("/");
}

/** One identity per file on disk: two threads that share a checkout list it once. */
export function mediaEntryKey(entry: Pick<MediaEntry, "cwd" | "relativePath" | "source">): string {
  if (entry.source) return JSON.stringify(entry.source);
  return `${entry.cwd}\u0000${entry.relativePath}`;
}

function compareEntries(sort: MediaSort) {
  return (left: MediaEntry, right: MediaEntry): number => {
    if (sort === "name") {
      return (
        mediaFileName(left).localeCompare(mediaFileName(right), undefined, {
          sensitivity: "base",
          numeric: true,
        }) || left.relativePath.localeCompare(right.relativePath)
      );
    }
    const byTime = left.changedAt.localeCompare(right.changedAt);
    return sort === "newest" ? -byTime : byTime;
  };
}

/** Whether a search matches a file: every word, in its name or folder. */
function matchesQuery(entry: MediaEntry, words: ReadonlyArray<string>): boolean {
  if (words.length === 0) {
    return true;
  }
  const haystack = `${entry.relativePath} ${entry.threadTitle}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * The groups the tab shows. Groups with nothing in them are left out. By
 * type, in the fixed order Pictures, Videos, Audio, Documents; by thread, the
 * thread with the newest change first, each reading as its own small Media
 * tab (its tiles, then its rows).
 */
export function buildMediaGroups(input: {
  readonly entries: ReadonlyArray<MediaEntry>;
  readonly query: string;
  readonly sort: MediaSort;
  readonly groupBy: MediaGroupBy;
}): ReadonlyArray<MediaGroup> {
  const words = input.query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const visible = input.entries
    .filter((entry) => matchesQuery(entry, words))
    .toSorted(compareEntries(input.sort));

  if (input.groupBy === "type") {
    return MEDIA_KIND_ORDER.flatMap((kind) => {
      const entries = visible.filter((entry) => entry.mediaKind === kind);
      return entries.length === 0 ? [] : [splitGroup(kind, MEDIA_KIND_LABELS[kind], entries)];
    });
  }

  const byThread = new Map<string, MediaEntry[]>();
  for (const entry of visible) {
    const list = byThread.get(entry.threadId);
    if (list) {
      list.push(entry);
    } else {
      byThread.set(entry.threadId, [entry]);
    }
  }
  const newest = (entries: ReadonlyArray<MediaEntry>) =>
    entries.reduce((latest, entry) => (entry.changedAt > latest ? entry.changedAt : latest), "");
  return [...byThread.entries()]
    .toSorted(([, left], [, right]) => newest(right).localeCompare(newest(left)))
    .map(([threadId, entries]) =>
      splitGroup(threadId, entries[0]?.threadTitle.trim() || "Untitled thread", entries),
    );
}

/** How many files of each kind, for the launcher row. */
export function countMediaByKind(
  entries: ReadonlyArray<Pick<MediaEntry, "mediaKind">>,
): Readonly<Record<OrchestrationMediaKind, number>> {
  const counts = { picture: 0, video: 0, audio: 0, document: 0 };
  for (const entry of entries) {
    counts[entry.mediaKind] += 1;
  }
  return counts;
}

/** "6 pictures, 1 video", or null when there is nothing. */
export function describeMediaCounts(
  counts: Readonly<Record<OrchestrationMediaKind, number>>,
): string | null {
  const parts = MEDIA_KIND_ORDER.flatMap((kind) =>
    counts[kind] > 0 ? [pluralize(counts[kind], MEDIA_KIND_NOUNS[kind])] : [],
  );
  return parts.length === 0 ? null : parts.join(", ");
}

/**
 * Changes whenever the thread's turn summaries do, so the thread's listing
 * refetches as turns land without polling.
 */
export function turnSummariesRevision(
  summaries: ReadonlyArray<{
    readonly turnId: string;
    readonly completedAt: string;
    readonly files: ReadonlyArray<unknown>;
  }> | null,
): string {
  if (!summaries || summaries.length === 0) {
    return "none";
  }
  const last = summaries.at(-1);
  const fileCount = summaries.reduce((total, summary) => total + summary.files.length, 0);
  return `${summaries.length}:${last?.turnId ?? ""}:${last?.completedAt ?? ""}:${fileCount}`;
}
