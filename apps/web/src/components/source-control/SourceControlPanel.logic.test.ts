import { describe, expect, it } from "vitest";

import {
  buildCommitGraphRows,
  formatCommitGraphDateTime,
  formatCommitGraphParentSummary,
  formatCommitGraphTimestamp,
  getCommitGraphRefKind,
  getVisibleCommitGraphRefs,
  normalizeCommitGraphRefName,
} from "./SourceControlPanel.logic";

describe("SourceControlPanel.logic", () => {
  it("formats recent commit timestamps", () => {
    expect(
      formatCommitGraphTimestamp("2026-05-25T12:00:00.000Z", new Date("2026-05-25T13:30:00.000Z")),
    ).toBe("1h ago");
  });

  it("formats absolute commit dates", () => {
    expect(formatCommitGraphDateTime("2026-05-25T12:00:00.000Z", "en-US", "UTC")).toBe(
      "May 25, 2026, 12:00 PM",
    );
    expect(formatCommitGraphDateTime("not-a-date")).toBe("");
  });

  it("summarizes commit parent counts", () => {
    expect(formatCommitGraphParentSummary(0)).toBe("Root commit");
    expect(formatCommitGraphParentSummary(1)).toBe("1 parent");
    expect(formatCommitGraphParentSummary(2)).toBe("2 parents - merge commit");
  });

  it("normalizes decorated ref names", () => {
    expect(normalizeCommitGraphRefName("refs/heads/feature/source-control")).toBe(
      "feature/source-control",
    );
    expect(normalizeCommitGraphRefName("refs/remotes/origin/main")).toBe("origin/main");
    expect(normalizeCommitGraphRefName("refs/tags/v1.0.0")).toBe("v1.0.0");
  });

  it("classifies commit graph refs for chip styling", () => {
    expect(getCommitGraphRefKind("main", "main")).toBe("current");
    expect(getCommitGraphRefKind("origin/main", "main")).toBe("current");
    expect(getCommitGraphRefKind("upstream/release", "main")).toBe("remote");
    expect(getCommitGraphRefKind("refs/tags/v1.0.0", "main")).toBe("tag");
    expect(getCommitGraphRefKind("feature/source-control", "main")).toBe("branch");
  });

  it("hides symbolic remote HEAD refs from graph decorations", () => {
    expect(
      getVisibleCommitGraphRefs([
        "main",
        "origin/main",
        "origin/HEAD",
        "refs/remotes/upstream/HEAD",
        "HEAD",
      ]),
    ).toEqual(["main", "origin/main"]);
  });

  it("lays out merge commits across multiple graph lanes", () => {
    const [mergeRow, firstParentRow, sideParentRow, baseRow] = buildCommitGraphRows([
      { sha: "merge", parents: ["main-parent", "side-parent"], refs: ["main"] },
      { sha: "main-parent", parents: ["base"], refs: [] },
      { sha: "side-parent", parents: ["base"], refs: ["origin/feature"] },
      { sha: "base", parents: [], refs: [] },
    ]);

    expect(mergeRow?.layout.lane).toBe(0);
    expect(mergeRow?.layout.parentPaths).toEqual([
      { fromLane: 0, toLane: 0 },
      { fromLane: 0, toLane: 1 },
    ]);
    expect(firstParentRow?.layout.bottomLanes).toEqual([0, 1]);
    expect(sideParentRow?.layout.parentPaths).toEqual([{ fromLane: 1, toLane: 0 }]);
    expect(baseRow?.layout.lane).toBe(0);
  });
});
