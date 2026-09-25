import { describe, expect, it } from "vite-plus/test";

import { estimateThreadUncommittedDiffStat, parseTurnDiffFilesFromUnifiedDiff } from "./Diffs.ts";

describe("parseTurnDiffFilesFromUnifiedDiff", () => {
  it("returns empty list for empty diff", () => {
    expect(parseTurnDiffFilesFromUnifiedDiff("")).toEqual([]);
  });

  it("parses per-file additions and deletions", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,3 @@",
      " one",
      "-two",
      "+two updated",
      "+three",
      "diff --git a/src/b.ts b/src/b.ts",
      "index 3333333..4444444 100644",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -3,2 +3,0 @@",
      "-old",
      "-stale",
      "",
    ].join("\n");

    expect(parseTurnDiffFilesFromUnifiedDiff(diff)).toEqual([
      { path: "a.txt", additions: 2, deletions: 1 },
      { path: "src/b.ts", additions: 0, deletions: 2 },
    ]);
  });

  it("parses rename-only diffs with zero line changes", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "",
    ].join("\n");

    expect(parseTurnDiffFilesFromUnifiedDiff(diff)).toEqual([
      { path: "src/new.ts", additions: 0, deletions: 0 },
    ]);
  });

  it("normalizes CRLF input before parsing", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1,2 @@",
      "-one",
      "+one updated",
      "+two",
      "",
    ].join("\r\n");

    expect(parseTurnDiffFilesFromUnifiedDiff(diff)).toEqual([
      { path: "a.txt", additions: 2, deletions: 1 },
    ]);
  });
});

describe("estimateThreadUncommittedDiffStat", () => {
  it("counts each path once, capped by what is still uncommitted there", () => {
    const stat = estimateThreadUncommittedDiffStat({
      turnFiles: [
        [
          // Pulled in by a merge, now committed: nothing uncommitted remains.
          { path: "merged/huge.ts", additions: 5_000, deletions: 1_200 },
          { path: "src/feature.ts", additions: 100, deletions: 0 },
        ],
        [
          // A later turn rewrites 30 of the lines it added earlier.
          { path: "src/feature.ts", additions: 30, deletions: 30 },
          { path: "src\\Shared.ts", additions: 4, deletions: 1 },
        ],
      ],
      uncommittedFiles: [
        { path: "src/feature.ts", additions: 100, deletions: 0 },
        // Another thread also edits this file; only this thread's share counts.
        { path: "src/shared.ts", additions: 40, deletions: 9 },
        // Never touched by the thread.
        { path: "notes.md", additions: 7, deletions: 0 },
      ],
    });

    expect(stat).toEqual({ additions: 104, deletions: 1 });
  });

  it("follows a rename to the old name and spends each path's share once", () => {
    const stat = estimateThreadUncommittedDiffStat({
      turnFiles: [
        [{ path: "a.txt", additions: 5, deletions: 0 }],
        // A later turn only renamed it.
        [{ path: "b.txt", additions: 0, deletions: 0 }],
        [{ path: "c.txt", additions: 5, deletions: 0 }],
      ],
      uncommittedFiles: [
        { path: "b.txt", previousPath: "a.txt", additions: 5, deletions: 0 },
        // Two files that differ only by case on a case-sensitive checkout
        // cannot both claim c.txt's five lines.
        { path: "c.txt", additions: 5, deletions: 0 },
        { path: "C.txt", additions: 5, deletions: 0 },
      ],
    });

    expect(stat).toEqual({ additions: 10, deletions: 0 });
  });
});
