export type ReleaseChannel = "stable" | "nightly";

interface StableVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

interface NightlyVersion extends StableVersion {
  readonly date: number;
  readonly runNumber: number;
}

function compareStableVersions(left: StableVersion, right: StableVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function parseStableTag(tag: string): StableVersion | undefined {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!match) return undefined;

  const [, major, minor, patch] = match;
  if (!major || !minor || !patch) return undefined;

  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
}

function compareNightlyVersions(left: NightlyVersion, right: NightlyVersion): number {
  const stableComparison = compareStableVersions(left, right);
  if (stableComparison !== 0) return stableComparison;
  if (left.date !== right.date) return left.date - right.date;
  return left.runNumber - right.runNumber;
}

function parseNightlyTag(tag: string): NightlyVersion | undefined {
  // Accept both the current `v<semver>` format and the legacy `nightly-v<semver>`
  // format so release note diffs keep working across the tag-format transition.
  const match = /^(?:nightly-)?v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/.exec(tag);
  if (!match) return undefined;

  const [, major, minor, patch, date, runNumber] = match;
  if (!major || !minor || !patch || !date || !runNumber) return undefined;

  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    date: Number(date),
    runNumber: Number(runNumber),
  };
}

export function resolvePreviousStableTag(
  currentTag: string,
  tags: ReadonlyArray<string>,
): string | undefined {
  const current = parseStableTag(currentTag);
  if (!current) {
    throw new Error(`Invalid stable release tag '${currentTag}'.`);
  }

  const candidates = tags
    .map((tag) => ({ tag, parsed: parseStableTag(tag) }))
    .filter((entry): entry is { tag: string; parsed: StableVersion } => entry.parsed !== undefined)
    .filter((entry) => compareStableVersions(entry.parsed, current) < 0)
    .toSorted((left, right) => compareStableVersions(right.parsed, left.parsed));

  return candidates[0]?.tag;
}

export function resolvePreviousNightlyTag(
  currentTag: string,
  tags: ReadonlyArray<string>,
): string | undefined {
  const current = parseNightlyTag(currentTag);
  if (!current) {
    throw new Error(`Invalid nightly release tag '${currentTag}'.`);
  }

  const candidates = tags
    .map((tag) => ({ tag, parsed: parseNightlyTag(tag) }))
    .filter((entry): entry is { tag: string; parsed: NightlyVersion } => entry.parsed !== undefined)
    .filter((entry) => compareNightlyVersions(entry.parsed, current) < 0)
    .toSorted((left, right) => compareNightlyVersions(right.parsed, left.parsed));

  return candidates[0]?.tag;
}

export function resolveLatestStableTagBeforeNightly(
  currentTag: string,
  tags: ReadonlyArray<string>,
): string | undefined {
  const current = parseNightlyTag(currentTag);
  if (!current) {
    throw new Error(`Invalid nightly release tag '${currentTag}'.`);
  }

  const candidates = tags
    .map((tag) => ({ tag, parsed: parseStableTag(tag) }))
    .filter((entry): entry is { tag: string; parsed: StableVersion } => entry.parsed !== undefined)
    .filter((entry) => compareStableVersions(entry.parsed, current) < 0)
    .toSorted((left, right) => compareStableVersions(right.parsed, left.parsed));

  return candidates[0]?.tag;
}

export function resolvePreviousReleaseTag(
  channel: ReleaseChannel,
  currentTag: string,
  tags: ReadonlyArray<string>,
): string | undefined {
  return channel === "stable"
    ? resolvePreviousStableTag(currentTag, tags)
    : resolvePreviousNightlyTag(currentTag, tags);
}

export function resolveReleaseNotesBaselineTag(
  channel: ReleaseChannel,
  currentTag: string,
  tags: ReadonlyArray<string>,
): string | undefined {
  if (channel === "stable") {
    return resolvePreviousStableTag(currentTag, tags);
  }

  return (
    resolvePreviousNightlyTag(currentTag, tags) ??
    resolveLatestStableTagBeforeNightly(currentTag, tags)
  );
}
