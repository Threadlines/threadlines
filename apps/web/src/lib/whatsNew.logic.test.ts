import { describe, expect, it } from "vite-plus/test";

import {
  describeWaitingUpdate,
  nightlyReleasesPageSize,
  type PublishedRelease,
  selectNightlyBuilds,
} from "./whatsNew.logic";

const release = (version: string, body = ""): PublishedRelease => ({
  version,
  body,
  url: `https://github.com/Threadlines/threadlines/releases/tag/v${version}`,
  publishedAt: null,
});
const fix = (text: string) =>
  `## What's Changed\n\n- fix: ${text} by @who in https://github.com/x/y/pull/1`;

describe("selectNightlyBuilds", () => {
  it("keeps the builds after the one you had, and says when the list reaches it", () => {
    const releases = [
      release("0.8.1-nightly.20261030.356", fix("newest")),
      release("0.8.1-nightly.20261029.355", fix("middle")),
      release("0.8.0"),
      release("0.8.0-nightly.20261028.354", fix("before the stable release")),
    ];

    const sinceStable = selectNightlyBuilds(releases, {
      after: "0.8.0",
      upTo: "0.8.1-nightly.20261030.356",
    });
    expect(sinceStable.builds.map((build) => build.build)).toEqual([356, 355]);
    expect(sinceStable.complete).toBe(true);

    // The page ran out before reaching build 340: the list is only its newest part.
    const partial = selectNightlyBuilds(releases.slice(0, 2), {
      after: "0.8.0-nightly.20261020.340",
      upTo: "0.8.1-nightly.20261030.356",
    });
    expect(partial.complete).toBe(false);

    const ownBuildOnly = selectNightlyBuilds(releases, {
      after: null,
      upTo: "0.8.1-nightly.20261029.355",
    });
    expect(ownBuildOnly.builds.map((build) => build.changes[0]?.text)).toEqual(["Middle"]);
  });

  it("sizes the first page to the gap between builds", () => {
    expect(
      nightlyReleasesPageSize({
        after: "0.8.0-nightly.20261028.350",
        upTo: "0.8.0-nightly.20261028.354",
      }),
    ).toBe(10);
    expect(nightlyReleasesPageSize({ after: "0.8.0", upTo: "0.8.1-nightly.20261030.356" })).toBe(
      30,
    );
  });
});

describe("describeWaitingUpdate", () => {
  it("names a stable release by its title and a nightly by its count of changes", () => {
    expect(
      describeWaitingUpdate({
        targetVersion: "0.9.0",
        stableTitle: "Fleet: your computers work as one",
        nightly: null,
      }),
    ).toBe("Fleet: your computers work as one");
    const nightly = (count: number, complete: boolean) =>
      describeWaitingUpdate({
        targetVersion: "0.8.1-nightly.20261030.356",
        stableTitle: null,
        nightly: { count, complete },
      });
    expect(nightly(7, true)).toBe("7 changes since yours");
    expect(nightly(1, true)).toBe("1 change since yours");
    expect(nightly(12, false)).toBe("12 changes in the newest builds");
    expect(nightly(0, true)).toBeNull();
  });
});
