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

/** Orders "major.minor.patch" versions numerically, so 0.10.0 sorts after 0.9.0. */
export function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The newest stable version with a changelog entry. */
export function latestStableVersion(entries: ReadonlyArray<ChangelogEntry>): string {
  const versions = entries.map((entry) => entry.data.version).toSorted(compareVersions);
  const latest = versions.at(-1);
  if (!latest) throw new Error("The changelog has no entries.");
  return latest;
}
