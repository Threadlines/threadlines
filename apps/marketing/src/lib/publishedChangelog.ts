import { getCollection } from "astro:content";

import { releasedEntries, type ChangelogEntry } from "./changelog";

const LATEST_RELEASE_PAGE = "https://github.com/Threadlines/threadlines/releases/latest";
const RELEASE_TAG = /\/releases\/tag\/v(\d+\.\d+\.\d+)$/;

/**
 * The newest published stable version, read from where github.com's "latest release" page
 * redirects (a web page, so the build doesn't spend the API's small unauthenticated quota on
 * shared build machines). Throws when GitHub can't say: the build fails and Vercel keeps the
 * live site, rather than guessing and showing notes for a release that may never have shipped.
 */
async function fetchLatestReleasedVersion(): Promise<string> {
  const response = await fetch(LATEST_RELEASE_PAGE, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const location = response.headers.get("location") ?? "";
  const version = RELEASE_TAG.exec(location)?.[1];
  if (!version) {
    throw new Error(
      `Can't tell which release is published: ${LATEST_RELEASE_PAGE} answered ${response.status}` +
        (location ? ` pointing at ${location}` : " with no redirect") +
        ". Rebuild once GitHub answers.",
    );
  }
  return version;
}

let latestReleasedVersion: Promise<string> | undefined;

/**
 * Every changelog entry whose release is out. Only production builds check: a preview of the
 * release notes PR must show the new entry, and the release workflow rebuilds production once
 * the desktop release is published. One lookup per build, shared by every page.
 */
export async function getPublishedChangelog(): Promise<ReadonlyArray<ChangelogEntry>> {
  const entries = await getCollection("changelog");
  if (process.env.VERCEL_ENV !== "production") return entries;
  latestReleasedVersion ??= fetchLatestReleasedVersion();
  return releasedEntries(entries, await latestReleasedVersion);
}
