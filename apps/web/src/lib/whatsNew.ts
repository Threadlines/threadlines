/**
 * Where "What's new" gets its words, and what it remembers.
 *
 * - Stable notes ship in the app (`virtual:release-notes`, built from the
 *   marketing site's changelog files), loaded only when the dialog or the
 *   post-update notice needs them.
 * - Anything the app doesn't have yet comes from the repository's GitHub
 *   releases: the waiting update the rail button offers, and the nightly
 *   builds since the one you had. One release-list page usually covers it;
 *   a long gap pages back a few times and then says the list is partial.
 * - Which version ran before this one: the desktop keeps it in its state
 *   folder (the page's own storage moves with the backend's port), a browser
 *   in localStorage, claimed under a Web Lock so two tabs opened together
 *   announce an update once.
 */
import { useQuery } from "@tanstack/react-query";
import type { DesktopUpdateState } from "@threadlines/contracts";
import {
  advanceVersionHistory,
  parseNightlyVersion,
  parseReleaseNotesBlock,
  RELEASE_NOTES_REPOSITORY,
  VersionHistoryRecord,
} from "@threadlines/shared/releaseNotes";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { APP_BUILD_CHANNEL_LABEL, APP_VERSION } from "../branding";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import {
  countChanges,
  describeWaitingUpdate,
  nightlyReleasesPageSize,
  type NightlyRange,
  type PublishedRelease,
  selectNightlyBuilds,
} from "./whatsNew.logic";

/** The stable notes, newest first; a chunk of their own, fetched on first use. */
export function loadReleaseNotes() {
  return import("virtual:release-notes").then((module) => module.default);
}

const GITHUB_API_URL = `https://api.github.com/repos/${RELEASE_NOTES_REPOSITORY}`;
/** How many full pages (100 releases each) a nightly list reads before it settles for being partial. */
const MAX_RELEASE_PAGES = 4;

const GitHubRelease = Schema.Struct({
  tag_name: Schema.String,
  body: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  published_at: Schema.NullOr(Schema.String),
  draft: Schema.Boolean,
});
const decodeGitHubRelease = Schema.decodeUnknownOption(GitHubRelease);
const decodeGitHubReleases = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));

function toPublishedRelease(raw: unknown): PublishedRelease | null {
  const release = Option.getOrNull(decodeGitHubRelease(raw));
  if (!release || release.draft) return null;
  return {
    version: release.tag_name.replace(/^v/, ""),
    body: release.body ?? "",
    url: release.html_url,
    publishedAt: release.published_at,
  };
}

/** GitHub didn't answer with releases: offline, rate-limited (60 an hour without sign-in), or down. */
export class ReleasesUnavailableError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "GitHub didn't answer." : `GitHub answered ${status}.`);
  }
}

async function fetchGitHub(path: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API_URL}${path}`, {
      headers: { Accept: "application/vnd.github+json" },
    });
  } catch {
    throw new ReleasesUnavailableError(null);
  }
  return response;
}

/** One release by version, or null when there is none (yet). */
export async function fetchRelease(version: string): Promise<PublishedRelease | null> {
  const response = await fetchGitHub(`/releases/tags/v${encodeURIComponent(version)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new ReleasesUnavailableError(response.status);
  return toPublishedRelease(await response.json());
}

/** The nightly builds in a range, newest first, and whether the list reaches its start. */
export async function fetchNightlyBuilds(range: NightlyRange) {
  if (range.after === null) {
    const release = await fetchRelease(range.upTo);
    return selectNightlyBuilds(release ? [release] : [], range);
  }
  // One page sized to the gap usually covers it. When newer releases push the
  // range further back than that, page through full pages from the top.
  const sized = await fetchReleasePages(range, nightlyReleasesPageSize(range), 1);
  if (sized.selection.complete || sized.exhausted) return sized.selection;
  return (await fetchReleasePages(range, 100, MAX_RELEASE_PAGES)).selection;
}

async function fetchReleasePages(range: NightlyRange, pageSize: number, maxPages: number) {
  const releases: Array<PublishedRelease> = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await fetchGitHub(`/releases?per_page=${pageSize}&page=${page}`);
    if (!response.ok) throw new ReleasesUnavailableError(response.status);
    const batch = Option.getOrElse(decodeGitHubReleases(await response.json()), () => []);
    for (const raw of batch) {
      const release = toPublishedRelease(raw);
      if (release) releases.push(release);
    }
    const selection = selectNightlyBuilds(releases, range);
    // A short page is the last one: there is nothing further back.
    const exhausted = batch.length < pageSize;
    if (selection.complete || exhausted) return { selection, exhausted };
  }
  return { selection: selectNightlyBuilds(releases, range), exhausted: false };
}

// Release notes never change once published; one fetch a session is plenty,
// and keeps a session well inside GitHub's 60-an-hour limit.
const RELEASE_QUERY_OPTIONS = {
  staleTime: 30 * 60_000,
  gcTime: 60 * 60_000,
  retry: 1,
  refetchOnWindowFocus: false,
} as const;

export function useNightlyBuilds(range: NightlyRange | null) {
  return useQuery({
    queryKey: ["whats-new", "nightly-builds", range?.after ?? null, range?.upTo ?? null],
    queryFn: () => fetchNightlyBuilds(range!),
    enabled: range !== null,
    ...RELEASE_QUERY_OPTIONS,
  });
}

/**
 * The rail update card's line about the waiting update: its title for a
 * stable release, its count of changes for a nightly. Fetched only while the
 * card shows; null until known, or when GitHub can't say.
 */
export function useWaitingUpdateLine(state: DesktopUpdateState | null): string | null {
  const target = state?.downloadedVersion ?? state?.availableVersion ?? null;
  const nightlyTarget = target !== null && parseNightlyVersion(target) !== null;
  const stable = useQuery({
    queryKey: ["whats-new", "release", target],
    queryFn: () => fetchRelease(target!),
    enabled: target !== null && !nightlyTarget,
    ...RELEASE_QUERY_OPTIONS,
  });
  const nightly = useNightlyBuilds(
    target !== null && nightlyTarget ? { after: APP_VERSION, upTo: target } : null,
  );
  if (target === null) return null;
  return describeWaitingUpdate({
    targetVersion: target,
    stableTitle: stable.data ? (parseReleaseNotesBlock(stable.data.body)?.title ?? null) : null,
    nightly: nightly.data
      ? { count: countChanges(nightly.data.builds), complete: nightly.data.complete }
      : null,
  });
}

const VERSION_HISTORY_STORAGE_KEY = "threadlines:whats-new:v1";
const VERSION_HISTORY_LOCK = "threadlines:whats-new";

function readBrowserVersionHistory(): VersionHistoryRecord | null {
  try {
    return getLocalStorageItem(VERSION_HISTORY_STORAGE_KEY, VersionHistoryRecord);
  } catch {
    return null;
  }
}

/** The version that ran on this device before this one; null when it's unknown. */
export function readPreviousAppVersion(): string | null {
  const bridge = window.desktopBridge;
  if (bridge) return bridge.getPreviousAppVersion?.() ?? null;
  const record = readBrowserVersionHistory();
  if (!record) return null;
  // Before this launch's claim has run, the record still names the one before.
  return record.current === APP_VERSION ? record.previous : record.current;
}

/**
 * Moves the device's record on to this version, and says whether this is the
 * one launch that announces it. A browser with no record starts one silently:
 * it can't tell an update from a first visit, so it announces nothing until
 * the next version.
 */
export async function claimUpdateNotice(): Promise<boolean> {
  if (APP_BUILD_CHANNEL_LABEL === "Dev") return false;
  const bridge = window.desktopBridge;
  if (bridge) return (await bridge.claimUpdateNotice?.()) ?? false;
  const advance = () => {
    const record = readBrowserVersionHistory();
    const next = advanceVersionHistory({ record, appVersion: APP_VERSION, hasEarlierData: false });
    if (next.record !== record) {
      try {
        setLocalStorageItem(VERSION_HISTORY_STORAGE_KEY, next.record, VersionHistoryRecord);
      } catch {
        // Without storage every visit looks like the first: nothing is announced.
        return false;
      }
    }
    return next.newerThanAnyBefore;
  };
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks ? locks.request(VERSION_HISTORY_LOCK, advance) : advance();
}
