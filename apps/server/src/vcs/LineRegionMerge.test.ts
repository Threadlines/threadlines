import { describe, expect, it } from "vitest";

import {
  mergeRegionEditsIntoCurrent,
  parseUnifiedDiffRegions,
  type LineEditRegion,
} from "./LineRegionMerge.ts";

function region(
  baseStart: number,
  baseLines: ReadonlyArray<string>,
  newLines: ReadonlyArray<string>,
): LineEditRegion {
  return { baseStart, baseLines, newLines };
}

describe("parseUnifiedDiffRegions", () => {
  it("parses deletion, insertion, and replacement hunks with -U0 style headers", () => {
    const patch = [
      "diff --git a/f.txt b/f.txt",
      "index 1111111..2222222 100644",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -14,5 +13,0 @@",
      "-",
      "-## Revert test scratchpad",
      "-",
      "-- [ ] one",
      "-- [ ] two",
      "@@ -20,1 +19,2 @@",
      "-old line",
      "+new line a",
      "+new line b",
      "@@ -25,0 +26,1 @@",
      "+inserted after 25",
      "",
    ].join("\n");

    expect(parseUnifiedDiffRegions(patch)).toEqual([
      region(14, ["", "## Revert test scratchpad", "", "- [ ] one", "- [ ] two"], []),
      region(20, ["old line"], ["new line a", "new line b"]),
      region(26, [], ["inserted after 25"]),
    ]);
  });

  it("splits change groups separated by context lines into distinct regions", () => {
    const patch = [
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -3,5 +3,5 @@",
      " ctx before",
      "-old a",
      "+new a",
      " ctx between",
      "-old b",
      "+new b",
      "",
    ].join("\n");

    expect(parseUnifiedDiffRegions(patch)).toEqual([
      region(4, ["old a"], ["new a"]),
      region(6, ["old b"], ["new b"]),
    ]);
  });

  it("returns an empty list for an empty patch", () => {
    expect(parseUnifiedDiffRegions("")).toEqual([]);
  });

  it("rejects binary stubs and missing-newline markers", () => {
    expect(parseUnifiedDiffRegions("Binary files a/x and b/x differ\n")).toBeNull();
    expect(
      parseUnifiedDiffRegions(
        [
          "--- a/f.txt",
          "+++ b/f.txt",
          "@@ -1,1 +1,1 @@",
          "-old",
          "\\ No newline at end of file",
          "+new",
          "",
        ].join("\n"),
      ),
    ).toBeNull();
  });
});

describe("mergeRegionEditsIntoCurrent", () => {
  const base = [
    "# TODO",
    "",
    "- [ ] existing item",
    "",
    "## Revert test scratchpad",
    "",
    "- [ ] one",
    "- [ ] two",
  ];
  // The thread's inverse change removes its block (base lines 4-8).
  const removeThreadBlock = region(4, base.slice(3), []);

  it("removes the thread's EOF block while keeping another session's block appended after it", () => {
    // Another session appended its own block after base line 8 (at EOF).
    const foreignBlock = ["", "## second session", "", "- [ ] theirs"];
    const currentLines = [...base, ...foreignBlock];

    const merged = mergeRegionEditsIntoCurrent({
      editRegions: [removeThreadBlock],
      driftRegions: [region(9, [], foreignBlock)],
      currentLines,
    });

    expect(merged).toEqual(["# TODO", "", "- [ ] existing item", ...foreignBlock]);
  });

  it("keeps a foreign block inserted directly before the removed region", () => {
    const foreignBlock = ["## inserted before", ""];
    const currentLines = [...base.slice(0, 3), ...foreignBlock, ...base.slice(3)];

    const merged = mergeRegionEditsIntoCurrent({
      editRegions: [removeThreadBlock],
      driftRegions: [region(4, [], foreignBlock)],
      currentLines,
    });

    expect(merged).toEqual(["# TODO", "", "- [ ] existing item", ...foreignBlock]);
  });

  it("conflicts when a foreign insertion lands inside the removed region", () => {
    const merged = mergeRegionEditsIntoCurrent({
      editRegions: [removeThreadBlock],
      driftRegions: [region(6, [], ["foreign line"])],
      currentLines: [...base.slice(0, 5), "foreign line", ...base.slice(5)],
    });

    expect(merged).toBeNull();
  });

  it("conflicts when a foreign edit overlaps the removed region", () => {
    const merged = mergeRegionEditsIntoCurrent({
      editRegions: [removeThreadBlock],
      driftRegions: [region(5, ["## Revert test scratchpad"], ["## rewritten"])],
      currentLines: [...base.slice(0, 4), "## rewritten", ...base.slice(5)],
    });

    expect(merged).toBeNull();
  });

  it("conflicts when both sides insert at the same point", () => {
    const merged = mergeRegionEditsIntoCurrent({
      editRegions: [region(9, [], ["thread line"])],
      driftRegions: [region(9, [], ["foreign line"])],
      currentLines: [...base, "foreign line"],
    });

    expect(merged).toBeNull();
  });

  it("offsets edits by earlier foreign insertions and deletions", () => {
    // Foreign work: inserted two lines after base line 1 and deleted base line 3.
    const currentLines = ["# TODO", "x1", "x2", "", ...base.slice(3), "tail"];
    const merged = mergeRegionEditsIntoCurrent({
      editRegions: [region(7, ["- [ ] one"], ["- [ ] one (restored)"])],
      driftRegions: [
        region(2, [], ["x1", "x2"]),
        region(3, ["- [ ] existing item"], []),
        region(9, [], ["tail"]),
      ],
      currentLines,
    });

    expect(merged).toEqual([
      "# TODO",
      "x1",
      "x2",
      "",
      "",
      "## Revert test scratchpad",
      "",
      "- [ ] one (restored)",
      "- [ ] two",
      "tail",
    ]);
  });

  it("bails when the current content no longer matches the expected base lines", () => {
    const merged = mergeRegionEditsIntoCurrent({
      editRegions: [region(1, ["# TODO"], ["# NEW TITLE"])],
      driftRegions: [],
      currentLines: ["# something else", ...base.slice(1)],
    });

    expect(merged).toBeNull();
  });
});
