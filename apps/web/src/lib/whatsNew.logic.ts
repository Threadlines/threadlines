/**
 * What "What's new" shows, without fetching anything: which stable notes a
 * build can show, which nightly builds a list covers, and the line the rail's
 * update card adds for a waiting update. The fetching and the version memory
 * live in `whatsNew.ts`.
 */
import {
  parseNightlyVersion,
  readReleaseBodyChanges,
  type ReleaseChange,
  type ReleaseNotesEntry,
} from "@threadlines/shared/releaseNotes";
import { compareSemverVersions } from "@threadlines/shared/semver";

/** The stable notes a build can show: every release up to its own version, newest first. */
export function releaseNotesUpTo(
  entries: ReadonlyArray<ReleaseNotesEntry>,
  appVersion: string,
): ReadonlyArray<ReleaseNotesEntry> {
  return entries.filter((entry) => compareSemverVersions(entry.version, appVersion) <= 0);
}

/** A published GitHub release, the parts "What's new" reads. */
export interface PublishedRelease {
  /** The tag without its "v". */
  readonly version: string;
  readonly body: string;
  readonly url: string;
  readonly publishedAt: string | null;
}

/** One nightly build's changes, as the list shows them. */
export interface NightlyBuildChanges {
  readonly version: string;
  readonly build: number;
  readonly publishedAt: string | null;
  readonly url: string;
  readonly changes: ReadonlyArray<ReleaseChange>;
}

/** The nightly builds a list covers: after `after` (exclusive) up to `upTo`, or just `upTo` without a start. */
export interface NightlyRange {
  readonly after: string | null;
  readonly upTo: string;
}

/**
 * The nightly builds in a range, newest first, from releases newest first.
 * `complete` says the releases reached back to the range's start, so the
 * list (and any count of it) is the whole range rather than its newest part.
 */
export function selectNightlyBuilds(
  releases: ReadonlyArray<PublishedRelease>,
  range: NightlyRange,
): { readonly builds: ReadonlyArray<NightlyBuildChanges>; readonly complete: boolean } {
  const inRange = (version: string) =>
    range.after === null
      ? version === range.upTo
      : compareSemverVersions(version, range.after) > 0 &&
        compareSemverVersions(version, range.upTo) <= 0;
  const builds = releases.flatMap((release) => {
    const nightly = parseNightlyVersion(release.version);
    if (!nightly || !inRange(release.version)) return [];
    return [
      {
        version: release.version,
        build: nightly.build,
        publishedAt: release.publishedAt,
        url: release.url,
        changes: readReleaseBodyChanges(release.body),
      },
    ];
  });
  const after = range.after;
  const complete =
    after === null
      ? builds.length > 0
      : releases.some((release) => compareSemverVersions(release.version, after) <= 0);
  return { builds: builds.toSorted((left, right) => right.build - left.build), complete };
}

/**
 * How many releases one page of the list should hold to reach back from
 * `upTo` to `after`: nightlies come a few a day, with a stable now and then,
 * so a short gap is one small page instead of a long one.
 */
export function nightlyReleasesPageSize(range: NightlyRange): number {
  const after = range.after === null ? null : parseNightlyVersion(range.after);
  const upTo = parseNightlyVersion(range.upTo);
  if (!after || !upTo) return 30;
  return Math.min(100, Math.max(10, upTo.build - after.build + 5));
}

export function countChanges(builds: ReadonlyArray<NightlyBuildChanges>): number {
  return builds.reduce((total, build) => total + build.changes.length, 0);
}

/**
 * The rail update card's line about a waiting update: a stable release's
 * title, or for a nightly how many changes it brings. Null when there is
 * nothing to say yet (still loading, GitHub unreachable, or only internal
 * changes), and the card simply leaves the line out.
 */
export function describeWaitingUpdate(input: {
  readonly targetVersion: string;
  readonly stableTitle: string | null;
  readonly nightly: { readonly count: number; readonly complete: boolean } | null;
}): string | null {
  if (parseNightlyVersion(input.targetVersion) === null) return input.stableTitle;
  const nightly = input.nightly;
  if (!nightly || nightly.count === 0) return null;
  const changes = nightly.count === 1 ? "1 change" : `${nightly.count} changes`;
  return nightly.complete ? `${changes} since yours` : `${changes} in the newest builds`;
}

/** The tag a change wears in the nightly list. */
export function releaseChangeTag(kind: ReleaseChange["kind"]): string {
  switch (kind) {
    case "new":
      return "New";
    case "fixed":
      return "Fixed";
    case "faster":
      return "Faster";
    case "changed":
      return "Changed";
  }
}
