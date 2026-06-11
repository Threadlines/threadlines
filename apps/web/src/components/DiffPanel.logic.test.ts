import type { FileDiffMetadata } from "@pierre/diffs/react";
import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildWorkingTreeStatusDigest,
  computeFileDiffStat,
  formatDiffFileCount,
  resolveActiveDiffFileIndex,
  resolveTurnDiffSummaryStats,
  sumDiffFileStats,
} from "./DiffPanel.logic";

function makeFileDiff(hunks: Array<{ additionLines: number; deletionLines: number }>) {
  return { hunks } as unknown as FileDiffMetadata;
}

function makeStatus(input: {
  isRepo?: boolean;
  refName?: string | null;
  files?: Array<{
    path: string;
    indexStatus?: string | null;
    worktreeStatus?: string | null;
    insertions: number;
    deletions: number;
  }>;
}): VcsStatusResult {
  return {
    isRepo: input.isRepo ?? true,
    refName: input.refName ?? "main",
    workingTree: { files: input.files ?? [] },
  } as unknown as VcsStatusResult;
}

describe("computeFileDiffStat", () => {
  it("sums addition and deletion lines across hunks", () => {
    const fileDiff = makeFileDiff([
      { additionLines: 3, deletionLines: 1 },
      { additionLines: 2, deletionLines: 0 },
    ]);

    expect(computeFileDiffStat(fileDiff)).toEqual({ additions: 5, deletions: 1 });
  });

  it("returns zeros for a file without hunks", () => {
    expect(computeFileDiffStat(makeFileDiff([]))).toEqual({ additions: 0, deletions: 0 });
  });
});

describe("sumDiffFileStats", () => {
  it("sums stats and handles the empty list", () => {
    expect(sumDiffFileStats([])).toEqual({ additions: 0, deletions: 0 });
    expect(
      sumDiffFileStats([
        { additions: 1, deletions: 2 },
        { additions: 3, deletions: 4 },
      ]),
    ).toEqual({ additions: 4, deletions: 6 });
  });
});

describe("formatDiffFileCount", () => {
  it("pluralizes", () => {
    expect(formatDiffFileCount(1)).toBe("1 file");
    expect(formatDiffFileCount(3)).toBe("3 files");
  });
});

describe("resolveTurnDiffSummaryStats", () => {
  it("omits line stats when no file carries numeric counts", () => {
    const stats = resolveTurnDiffSummaryStats({
      files: [{ path: "a.ts" }, { path: "b.ts" }],
    });

    expect(stats).toEqual({ fileCount: 2, lineStats: null });
  });

  it("sums counts and treats missing values as zero once any file has stats", () => {
    const stats = resolveTurnDiffSummaryStats({
      files: [
        { path: "a.ts", additions: 4, deletions: 1 },
        { path: "b.ts", additions: 2 },
        { path: "c.ts" },
      ],
    });

    expect(stats).toEqual({ fileCount: 3, lineStats: { additions: 6, deletions: 1 } });
  });
});

describe("buildWorkingTreeStatusDigest", () => {
  it("returns null without a repo", () => {
    expect(buildWorkingTreeStatusDigest(null)).toBeNull();
    expect(buildWorkingTreeStatusDigest(makeStatus({ isRepo: false }))).toBeNull();
  });

  it("is stable across file ordering", () => {
    const first = makeStatus({
      files: [
        { path: "a.ts", worktreeStatus: "modified", insertions: 1, deletions: 0 },
        { path: "b.ts", indexStatus: "added", insertions: 5, deletions: 2 },
      ],
    });
    const second = makeStatus({
      files: [
        { path: "b.ts", indexStatus: "added", insertions: 5, deletions: 2 },
        { path: "a.ts", worktreeStatus: "modified", insertions: 1, deletions: 0 },
      ],
    });

    expect(buildWorkingTreeStatusDigest(first)).toBe(buildWorkingTreeStatusDigest(second));
  });

  it("changes when file stats, statuses, or the ref change", () => {
    const base = makeStatus({
      files: [{ path: "a.ts", worktreeStatus: "modified", insertions: 1, deletions: 0 }],
    });

    expect(buildWorkingTreeStatusDigest(base)).not.toBe(
      buildWorkingTreeStatusDigest(
        makeStatus({
          files: [{ path: "a.ts", worktreeStatus: "modified", insertions: 2, deletions: 0 }],
        }),
      ),
    );
    expect(buildWorkingTreeStatusDigest(base)).not.toBe(
      buildWorkingTreeStatusDigest(
        makeStatus({
          files: [
            {
              path: "a.ts",
              indexStatus: "modified",
              worktreeStatus: null,
              insertions: 1,
              deletions: 0,
            },
          ],
        }),
      ),
    );
    expect(buildWorkingTreeStatusDigest(base)).not.toBe(
      buildWorkingTreeStatusDigest(
        makeStatus({
          refName: "feature/x",
          files: [{ path: "a.ts", worktreeStatus: "modified", insertions: 1, deletions: 0 }],
        }),
      ),
    );
  });
});

describe("resolveActiveDiffFileIndex", () => {
  it("returns -1 for an empty list", () => {
    expect(resolveActiveDiffFileIndex([], 0)).toBe(-1);
  });

  it("returns the last file whose top is at or above the reading line", () => {
    const tops = [8, 400, 900];

    expect(resolveActiveDiffFileIndex(tops, 0, 48)).toBe(0);
    expect(resolveActiveDiffFileIndex(tops, 360, 48)).toBe(1);
    expect(resolveActiveDiffFileIndex(tops, 900, 48)).toBe(2);
  });

  it("clamps to the first file before any top is reached", () => {
    expect(resolveActiveDiffFileIndex([200, 500], 0, 0)).toBe(0);
  });
});
