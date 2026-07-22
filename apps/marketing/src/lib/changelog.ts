import type { CollectionEntry } from "astro:content";

export type ChangelogEntry = CollectionEntry<"changelog">;

export function sortChangelogEntries(
  entries: ReadonlyArray<ChangelogEntry>,
): ReadonlyArray<ChangelogEntry> {
  return entries.toSorted((left, right) => right.data.date.getTime() - left.data.date.getTime());
}

export function changelogEntryPath(entry: ChangelogEntry): string {
  return `/changelog/${entry.id}`;
}

export function formatReleaseDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
