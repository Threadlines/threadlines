import { describe, expect, it } from "vite-plus/test";

import {
  describeNightlyLead,
  describeNightlyUpdate,
  describeWaitingUpdate,
  type NightlyBuildChanges,
  nightlyReleasesPageSize,
  planNightlyList,
  type PublishedRelease,
  selectNightlyBuilds,
  splitNightlyBuilds,
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

const build = (number: number, texts: ReadonlyArray<string>): NightlyBuildChanges => ({
  version: `0.8.1-nightly.20261029.${number}`,
  build: number,
  publishedAt: null,
  url: "",
  changes: texts.map((text) => ({ kind: "fixed" as const, text })),
});

describe("a nightly's list", () => {
  it("covers the builds since the one you had, back to the last stable release", () => {
    const plan = planNightlyList({
      appVersion: "0.8.1-nightly.20261029.357",
      previousVersion: "0.8.1-nightly.20261029.356",
      lastStableVersion: "0.8.0",
    });
    expect(plan).toEqual({
      since: "0.8.1-nightly.20261029.356",
      range: { after: "0.8.0", upTo: "0.8.1-nightly.20261029.357" },
    });
    // Coming from before the stable release, the list starts there instead.
    expect(
      planNightlyList({
        appVersion: "0.8.1-nightly.20261029.357",
        previousVersion: "0.8.0-nightly.20261028.354",
        lastStableVersion: "0.8.0",
      }).range.after,
    ).toBe("0.8.0-nightly.20261028.354");

    const builds = [build(357, ["Explorer shows a file with a comma"]), build(356, ["What's new"])];
    const { fresh, earlier } = splitNightlyBuilds(builds, plan.since, plan.range.upTo);
    expect(fresh.map((entry) => entry.build)).toEqual([357]);
    expect(earlier.map((entry) => entry.build)).toEqual([356]);
    const appVersion = plan.range.upTo;
    expect(describeNightlyLead({ fresh, since: plan.since, freshComplete: true, appVersion })).toBe(
      "1 change since build 356, the one you had before",
    );
    expect(
      describeNightlyLead({ fresh: [], since: plan.since, freshComplete: true, appVersion }),
    ).toBe("GitHub doesn't list this build's changes yet.");
    // Build 358's own release isn't published yet: only the builds before it are known.
    expect(
      describeNightlyLead({
        fresh,
        since: plan.since,
        freshComplete: true,
        appVersion: "0.8.1-nightly.20261029.358",
      }),
    ).toBe("1 change since build 356. This build's own notes aren't on GitHub yet.");
  });

  it("words the notice after a nightly by its changes, and has none for internal ones", () => {
    const since = "0.8.1-nightly.20261029.355";
    const appVersion = "0.8.1-nightly.20261029.357";
    const notice = (
      fresh: ReadonlyArray<NightlyBuildChanges>,
      complete = true,
      version = appVersion,
    ) => describeNightlyUpdate({ fresh, since, complete, appVersion: version });
    expect(notice([build(357, ["Explorer shows a file"])])).toBe("Explorer shows a file");
    expect(notice([build(357, ["A", "B"]), build(356, ["C"])])).toBe("3 changes since build 355");
    expect(notice([build(357, ["A", "B"])], false)).toBe("At least 2 changes since build 355");
    // Updated to 358 before its release was published: 356 and 357 are all that's known.
    expect(notice([build(357, ["A"])], true, "0.8.1-nightly.20261029.358")).toBe(
      "At least 1 change since build 355",
    );
    expect(notice([build(357, [])])).toBeNull();
  });
});
