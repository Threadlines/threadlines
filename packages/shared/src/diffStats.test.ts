import { describe, expect, it } from "vite-plus/test";

import {
  countStructuredPatchStats,
  countTextReplacementStats,
  countUnifiedDiffStats,
} from "./diffStats.ts";

describe("countUnifiedDiffStats", () => {
  it("counts added and removed lines, skipping file headers", () => {
    const diff = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,4 @@",
      " unchanged",
      "-removed line",
      "+added line",
      "+another added line",
    ].join("\n");

    expect(countUnifiedDiffStats(diff)).toEqual({ additions: 2, deletions: 1 });
  });

  it("handles CRLF line endings and empty diffs", () => {
    expect(countUnifiedDiffStats("+one\r\n-two\r\n")).toEqual({ additions: 1, deletions: 1 });
    expect(countUnifiedDiffStats("")).toEqual({ additions: 0, deletions: 0 });
  });
});

describe("countStructuredPatchStats", () => {
  it("counts +/- lines across hunks", () => {
    expect(
      countStructuredPatchStats([
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          lines: [" context", "-old", "+new", "+extra"],
        },
        {
          oldStart: 10,
          oldLines: 1,
          newStart: 11,
          newLines: 1,
          lines: ["-before", "+after"],
        },
      ]),
    ).toEqual({ additions: 3, deletions: 2 });
  });

  it("returns null when there are no usable hunks", () => {
    expect(countStructuredPatchStats(undefined)).toBeNull();
    expect(countStructuredPatchStats([])).toBeNull();
    expect(countStructuredPatchStats([{ oldStart: 1 }])).toBeNull();
  });
});

describe("countTextReplacementStats", () => {
  it("counts the lines an edit really changed", () => {
    // A new one-line file is one line, trailing newline or not.
    expect(countTextReplacementStats(undefined, "a\n")).toEqual({ additions: 1, deletions: 0 });
    // Two separate one-line edits leave the lines between them alone.
    expect(countTextReplacementStats("one\ntwo\nthree\nfour\n", "ONE\ntwo\nthree\nFOUR\n")).toEqual(
      { additions: 2, deletions: 2 },
    );
    expect(countTextReplacementStats("a\r\nb\r\n", "a\nb\nc\n")).toEqual({
      additions: 1,
      deletions: 0,
    });
  });
});
