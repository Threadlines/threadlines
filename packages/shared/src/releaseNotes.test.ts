import { describe, expect, it } from "vite-plus/test";

import {
  advanceVersionHistory,
  classifyReleaseChange,
  formatReleaseNotesBlock,
  parseNightlyVersion,
  parseReleaseNotesBlock,
  readReleaseBodyChanges,
} from "./releaseNotes.ts";

describe("classifyReleaseChange", () => {
  it("sorts conventional titles and leaves out what users wouldn't notice", () => {
    expect(classifyReleaseChange("fix(web): a command card ends the agent's line (#577)")).toEqual({
      kind: "fixed",
      text: "A command card ends the agent's line",
    });
    expect(classifyReleaseChange("feat: rename computers from the Fleet list")).toEqual({
      kind: "new",
      text: "Rename computers from the Fleet list",
    });
    expect(classifyReleaseChange("perf(server): fewer snapshot reads")?.kind).toBe("faster");
    expect(classifyReleaseChange("docs(release): prepare the 0.8.0 changelog")).toBeNull();
    expect(classifyReleaseChange("feat(telemetry): wait-time reports")).toBeNull();
    expect(classifyReleaseChange("fix(marketing): hero poster")).toBeNull();
    expect(classifyReleaseChange("chore(deps): bump vite")).toBeNull();
    expect(classifyReleaseChange("Bump shiki from 3.1 to 3.2")).toBeNull();
    // A scope the app has keeps a mixed list.
    expect(classifyReleaseChange("fix(web,telemetry): a thing")?.kind).toBe("fixed");
    expect(classifyReleaseChange("Cache diagnostics reads")).toEqual({
      kind: "changed",
      text: "Cache diagnostics reads",
    });
  });
});

describe("release body notes", () => {
  it("round-trips the hidden block, even when a title holds a comment's end", () => {
    const block = formatReleaseNotesBlock({
      title: "Fleet: your computers work as one",
      changes: [{ kind: "fixed", text: "Arrows --> no longer end comments", pullRequest: 12 }],
    });
    // The first "--" after the comment opens is the one that closes it.
    expect(block.indexOf("--", "<!--".length)).toBe(block.length - "-->".length);
    const body = `## Highlights\n\nWords.\n\n${block}\n`;
    expect(parseReleaseNotesBlock(body)).toEqual({
      v: 1,
      title: "Fleet: your computers work as one",
      changes: [{ kind: "fixed", text: "Arrows --> no longer end comments", pullRequest: 12 }],
    });
    expect(readReleaseBodyChanges(body)).toEqual([
      { kind: "fixed", text: "Arrows --> no longer end comments", pullRequest: 12 },
    ]);
  });

  it("reads the What's Changed bullets of a body written before the block", () => {
    const body = [
      "## What's Changed",
      "",
      "- fix: a computer still on 0.7.1 keeps working by [@badcuban](https://github.com/badcuban) in https://github.com/Threadlines/threadlines/pull/688",
      "- docs(marketing): record the Fleet video by [@badcuban](https://github.com/badcuban) in https://github.com/Threadlines/threadlines/pull/690",
      "- feat(web): rename computers by @badcuban in https://github.com/Threadlines/threadlines/pull/691",
      "- Handle updater diagnostics in [#43](https://github.com/Threadlines/threadlines/pull/43)",
      "",
      "### Direct changes",
      "",
      "- [`62ae093`](https://github.com/Threadlines/threadlines/commit/62ae093) Cache diagnostics reads",
      "",
      "**Full Changelog**: https://github.com/Threadlines/threadlines/compare/a...b",
      "- not a change",
    ].join("\n");
    expect(readReleaseBodyChanges(body)).toEqual([
      { kind: "fixed", text: "A computer still on 0.7.1 keeps working", pullRequest: 688 },
      { kind: "new", text: "Rename computers", pullRequest: 691 },
      { kind: "changed", text: "Handle updater diagnostics", pullRequest: 43 },
      { kind: "changed", text: "Cache diagnostics reads" },
    ]);
  });

  it("finds nothing in a body with neither", () => {
    expect(readReleaseBodyChanges("Just words.")).toEqual([]);
    expect(parseReleaseNotesBlock("<!-- threadlines-release-notes {broken -->")).toBeNull();
  });
});

describe("parseNightlyVersion", () => {
  it("reads a nightly's stable version, day and build", () => {
    expect(parseNightlyVersion("0.8.0-nightly.20261028.354")).toEqual({
      triple: "0.8.0",
      day: "20261028",
      build: 354,
    });
    expect(parseNightlyVersion("v0.8.1-nightly.20261029.355")?.build).toBe(355);
    expect(parseNightlyVersion("0.8.0")).toBeNull();
  });
});

describe("advanceVersionHistory", () => {
  it("announces a fresh install never, and the first launch after an older build that kept no record", () => {
    const fresh = advanceVersionHistory({
      record: null,
      appVersion: "0.9.0",
      hasEarlierData: false,
    });
    expect(fresh.newerThanAnyBefore).toBe(false);
    expect(fresh.record).toEqual({ current: "0.9.0", previous: null, newest: "0.9.0" });

    const updated = advanceVersionHistory({
      record: null,
      appVersion: "0.9.0",
      hasEarlierData: true,
    });
    expect(updated.newerThanAnyBefore).toBe(true);
    expect(updated.previousVersion).toBeNull();
  });

  it("keeps the version before this one across relaunches, and announces each version once", () => {
    const launch = (
      record: Parameters<typeof advanceVersionHistory>[0]["record"],
      appVersion: string,
    ) => advanceVersionHistory({ record, appVersion, hasEarlierData: true });

    const first = launch({ current: "0.8.0", previous: "0.7.1", newest: "0.8.0" }, "0.8.1");
    expect(first).toMatchObject({ previousVersion: "0.8.0", newerThanAnyBefore: true });
    const relaunch = launch(first.record, "0.8.1");
    expect(relaunch).toMatchObject({ previousVersion: "0.8.0", newerThanAnyBefore: false });
    expect(relaunch.record).toBe(first.record);

    // Back to an older build and forward again: 0.8.1 was already announced.
    const back = launch(relaunch.record, "0.8.0");
    expect(back.newerThanAnyBefore).toBe(false);
    const forward = launch(back.record, "0.8.1");
    expect(forward).toMatchObject({ previousVersion: "0.8.0", newerThanAnyBefore: false });

    // A nightly after its stable release is newer; the stable before it isn't.
    const nightly = launch(forward.record, "0.8.2-nightly.20261030.360");
    expect(nightly.newerThanAnyBefore).toBe(true);
    expect(launch(nightly.record, "0.8.1").newerThanAnyBefore).toBe(false);
  });
});
