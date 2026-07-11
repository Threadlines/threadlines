import { describe, expect, it } from "vite-plus/test";

import { countStructuredPatchStats, countUnifiedDiffStats } from "./diffStats.ts";

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
