import { describe, expect, it } from "vitest";

import {
  buildSourceControlFileTree,
  buildCommitGraphDetailRefs,
  buildCommitGraphDisplayRefs,
  buildCommitGraphRows,
  formatCommitGraphDateTime,
  formatCommitGraphParentSummary,
  formatCommitGraphTimestamp,
  getCommitGraphRefKind,
  getVisibleCommitGraphRefs,
  normalizeCommitGraphRefName,
  resolveCommitGraphErrorPresentation,
  resolveSourceControlPrimaryAction,
  takeCommitGraphRowRefs,
} from "./SourceControlPanel.logic";
import type { VcsStatusResult } from "@threadlines/contracts";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "development",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("SourceControlPanel.logic", () => {
  it("surfaces push as the primary action when a clean branch is ahead of upstream", () => {
    expect(
      resolveSourceControlPrimaryAction({
        status: status({ aheadCount: 3 }),
        hasCommitMessage: false,
        commitAndPushDisabledReason: "No working tree changes.",
        pushDisabledReason: null,
      }),
    ).toEqual({
      action: "push",
      label: "Push 3 commits",
      disabledReason: null,
      icon: "upload",
    });
  });

  it("keeps commit and push primary when the working tree has changes", () => {
    expect(
      resolveSourceControlPrimaryAction({
        status: status({ hasWorkingTreeChanges: true }),
        hasCommitMessage: true,
        commitAndPushDisabledReason: null,
        pushDisabledReason: "Commit changes first.",
      }),
    ).toEqual({
      action: "commit_push",
      label: "Commit & push",
      disabledReason: null,
      icon: "sparkles",
    });
  });

  it("surfaces publish branch as the primary action when no upstream is configured", () => {
    expect(
      resolveSourceControlPrimaryAction({
        status: status({ hasUpstream: false }),
        hasCommitMessage: false,
        commitAndPushDisabledReason: "No working tree changes.",
        pushDisabledReason: null,
      }),
    ).toEqual({
      action: "push",
      label: "Publish branch",
      disabledReason: null,
      icon: "upload",
    });
  });

  it("keeps ordinary commit graph failures generic", () => {
    expect(resolveCommitGraphErrorPresentation(new Error("graph unavailable"))).toEqual({
      title: "Graph failed to load",
      description: null,
      repairCommand: null,
    });
  });

  it("explains local Git metadata corruption for commit graph failures", () => {
    expect(
      resolveCommitGraphErrorPresentation(
        new Error(
          "Git command failed in GitVcsDriver.commitGraph: git log --all --topo-order (C:\\repo) - fatal: bad object refs/remotes/origin/HEAD",
        ),
      ),
    ).toEqual({
      title: "Local Git metadata needs repair",
      description: "Git reported corrupt or missing objects. Repair the repository, then retry.",
      repairCommand: "git fetch --refetch --prune origin",
    });
  });

  it("builds a compact source-control file tree with directory stats", () => {
    const tree = buildSourceControlFileTree([
      {
        path: "apps/web/src/components/source-control/SourceControlPanel.tsx",
        insertions: 2,
        deletions: 1,
      },
      {
        path: "apps/web/src/components/source-control/SourceControlPanel.browser.tsx",
        insertions: 11,
        deletions: 1,
      },
      { path: "package.json", insertions: 1, deletions: 0 },
    ]);

    expect(tree).toHaveLength(2);
    const [directoryNode, fileNode] = tree;
    expect(directoryNode?.kind).toBe("directory");
    expect(directoryNode).toMatchObject({
      name: "apps/web/src/components/source-control",
      path: "apps/web/src/components/source-control",
      insertions: 13,
      deletions: 2,
      fileCount: 2,
    });
    expect(directoryNode?.kind === "directory" ? directoryNode.children : []).toMatchObject([
      {
        kind: "file",
        name: "SourceControlPanel.browser.tsx",
        path: "apps/web/src/components/source-control/SourceControlPanel.browser.tsx",
      },
      {
        kind: "file",
        name: "SourceControlPanel.tsx",
        path: "apps/web/src/components/source-control/SourceControlPanel.tsx",
      },
    ]);
    expect(fileNode).toMatchObject({
      kind: "file",
      name: "package.json",
      path: "package.json",
    });
  });

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
    expect(getCommitGraphRefKind("v0.0.18-nightly.20260602", "main")).toBe("tag");
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

  it("collapses same-named remote branches into the local chip", () => {
    expect(buildCommitGraphDisplayRefs(["main", "origin/main", "origin/HEAD"], "main")).toEqual([
      { refName: "main", label: "main", kind: "current", cloudBadge: "synced" },
    ]);
  });

  it("collapses remotes with nested branch names and multiple remotes", () => {
    expect(
      buildCommitGraphDisplayRefs(
        ["feature/graph", "origin/feature/graph", "upstream/feature/graph"],
        "main",
      ),
    ).toEqual([
      { refName: "feature/graph", label: "feature/graph", kind: "branch", cloudBadge: "synced" },
    ]);
  });

  it("strips the primary remote prefix from remote-only chips", () => {
    expect(buildCommitGraphDisplayRefs(["origin/feature/remote-only"], "main")).toEqual([
      {
        refName: "origin/feature/remote-only",
        label: "feature/remote-only",
        kind: "remote",
        cloudBadge: "remote",
      },
    ]);
  });

  it("keeps non-primary remote prefixes on remote-only chips", () => {
    expect(buildCommitGraphDisplayRefs(["upstream/release"], "main")).toEqual([
      {
        refName: "upstream/release",
        label: "upstream/release",
        kind: "remote",
        cloudBadge: "remote",
      },
    ]);
  });

  it("marks a remote-only current branch as remote, not local", () => {
    expect(buildCommitGraphDisplayRefs(["origin/main"], "main")).toEqual([
      { refName: "origin/main", label: "main", kind: "current", cloudBadge: "remote" },
    ]);
  });

  it("does not pair remote branches with same-named tags", () => {
    expect(buildCommitGraphDisplayRefs(["refs/tags/v1.0.0", "origin/v1.0.0"], "main")).toEqual([
      { refName: "refs/tags/v1.0.0", label: "v1.0.0", kind: "tag", cloudBadge: "none" },
      { refName: "origin/v1.0.0", label: "v1.0.0", kind: "remote", cloudBadge: "remote" },
    ]);
  });

  it("orders display refs so the most relevant ref survives truncation", () => {
    expect(
      buildCommitGraphDisplayRefs(
        ["origin/feature/other", "refs/tags/v1.0.0", "feature/side", "main"],
        "main",
      ).map((displayRef) => displayRef.label),
    ).toEqual(["main", "feature/side", "v1.0.0", "feature/other"]);
  });

  it("keeps synced remotes as separate full-label chips in the detail refs", () => {
    expect(
      buildCommitGraphDetailRefs(
        ["main", "origin/main", "origin/HEAD", "refs/tags/v1.0.0"],
        "main",
      ),
    ).toEqual([
      { refName: "main", label: "main", kind: "current", cloudBadge: "none" },
      { refName: "origin/main", label: "origin/main", kind: "current", cloudBadge: "remote" },
      { refName: "refs/tags/v1.0.0", label: "v1.0.0", kind: "tag", cloudBadge: "none" },
    ]);
  });

  it("pairs row chips only when both labels stay legible", () => {
    const shortPair = buildCommitGraphDisplayRefs(["main", "refs/tags/v1.0.0"], "main");
    expect(takeCommitGraphRowRefs(shortPair)).toEqual({
      rendered: shortPair,
      hiddenCount: 0,
    });

    const longPair = buildCommitGraphDisplayRefs(
      ["refs/tags/v0.1.1-nightly.20260703", "refs/tags/v0.1.1"],
      "main",
    );
    expect(takeCommitGraphRowRefs(longPair)).toEqual({
      rendered: [longPair[0]],
      hiddenCount: 1,
    });
  });

  it("counts refs beyond the rendered row chips in the hidden badge", () => {
    const refs = buildCommitGraphDisplayRefs(["main", "dev", "refs/tags/v1.0.0"], "main");
    expect(takeCommitGraphRowRefs(refs)).toEqual({
      rendered: [refs[0], refs[1]],
      hiddenCount: 1,
    });
    expect(takeCommitGraphRowRefs([])).toEqual({ rendered: [], hiddenCount: 0 });
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

  it("keeps side-branch lanes alive when a merge side parent is interleaved before the first parent", () => {
    const [mergeRow, sideParentRow, firstParentRow, baseRow] = buildCommitGraphRows([
      { sha: "merge", parents: ["main-parent", "side-parent"], refs: ["origin/main"] },
      { sha: "side-parent", parents: ["base"], refs: ["feature"] },
      { sha: "main-parent", parents: ["base"], refs: [] },
      { sha: "base", parents: [], refs: ["main"] },
    ]);

    expect(mergeRow?.layout.parentPaths).toEqual([
      { fromLane: 0, toLane: 0 },
      { fromLane: 0, toLane: 1 },
    ]);
    expect(sideParentRow?.layout.lane).toBe(1);
    expect(sideParentRow?.layout.parentPaths).toEqual([{ fromLane: 1, toLane: 1 }]);
    expect(sideParentRow?.layout.bottomLanes).toEqual([0, 1]);
    expect(firstParentRow?.layout.topLanes).toEqual([0, 1]);
    expect(firstParentRow?.layout.parentPaths).toEqual([
      { fromLane: 0, toLane: 0 },
      { fromLane: 1, toLane: 0 },
    ]);
    expect(firstParentRow?.layout.bottomLanes).toEqual([0]);
    expect(baseRow?.layout.lane).toBe(0);
  });

  it("keeps a single lane for linear history", () => {
    const rows = buildCommitGraphRows([
      { sha: "c3", parents: ["c2"], refs: ["main"] },
      { sha: "c2", parents: ["c1"], refs: [] },
      { sha: "c1", parents: [], refs: [] },
    ]);

    expect(rows.every((row) => row.layout.lane === 0)).toBe(true);
    expect(rows[0]?.layout.laneCount).toBe(1);
    expect(rows[0]?.layout.parentPaths).toEqual([{ fromLane: 0, toLane: 0 }]);
    expect(rows[0]?.layout.topLanes).toEqual([]);
    expect(rows[1]?.layout.topLanes).toEqual([0]);
    expect(rows[1]?.layout.bottomLanes).toEqual([0]);
    expect(rows[2]?.layout.bottomLanes).toEqual([]);
  });

  it("splits a side branch into its own lane and merges it back", () => {
    const [tipRow, sideTipRow, baseRow] = buildCommitGraphRows([
      { sha: "tip", parents: ["base"], refs: ["main"] },
      { sha: "side", parents: ["base"], refs: ["origin/feature"] },
      { sha: "base", parents: [], refs: [] },
    ]);

    expect(tipRow?.layout.lane).toBe(0);
    expect(tipRow?.layout.bottomLanes).toEqual([0]);
    expect(sideTipRow?.layout.lane).toBe(1);
    expect(sideTipRow?.layout.isNewTip).toBe(true);
    expect(sideTipRow?.layout.topLanes).toEqual([0]);
    expect(sideTipRow?.layout.parentPaths).toEqual([{ fromLane: 1, toLane: 0 }]);
    expect(sideTipRow?.layout.bottomLanes).toEqual([0]);
    expect(baseRow?.layout.lane).toBe(0);
  });

  it("keeps unrelated lanes in place when a branch line merges into an existing lane", () => {
    // Mirrors the shape that broke in production: two long-lived side branches
    // (perf, theme) around main. When main-tip consumed its parent from lane 2,
    // lane compaction used to shift the theme branch from lane 3 into lane 2,
    // detaching its line from the rows above.
    const rows = buildCommitGraphRows([
      { sha: "perf-tip", parents: ["perf-mid", "main-tip"], refs: ["origin/perf"] },
      { sha: "perf-mid", parents: ["perf-base", "shared"], refs: [] },
      { sha: "perf-base", parents: ["trunk"], refs: [] },
      { sha: "theme-tip", parents: ["theme-mid", "main-tip"], refs: ["origin/theme"] },
      { sha: "main-tip", parents: ["shared"], refs: ["main"] },
      { sha: "theme-mid", parents: ["theme-base", "shared"], refs: [] },
      { sha: "shared", parents: ["trunk"], refs: [] },
      { sha: "theme-base", parents: ["trunk"], refs: [] },
      { sha: "trunk", parents: [], refs: [] },
    ]);

    const themeTipRow = rows[3];
    const mainTipRow = rows[4];
    const themeMidRow = rows[5];
    const themeBaseRow = rows[7];

    expect(themeTipRow?.layout.lane).toBe(3);
    expect(themeTipRow?.layout.parentPaths).toEqual([
      { fromLane: 3, toLane: 3 },
      { fromLane: 3, toLane: 1 },
    ]);
    expect(mainTipRow?.layout.lane).toBe(1);
    expect(mainTipRow?.layout.parentPaths).toEqual([
      { fromLane: 1, toLane: 1 },
      { fromLane: 2, toLane: 1 },
    ]);
    expect(mainTipRow?.layout.bottomLanes).toEqual([0, 1, 3]);
    expect(themeMidRow?.layout.lane).toBe(3);
    expect(themeMidRow?.layout.topLanes).toEqual([0, 1, 3]);
    expect(themeBaseRow?.layout.lane).toBe(3);
    expect(themeBaseRow?.layout.parentPaths).toEqual([{ fromLane: 3, toLane: 0 }]);

    for (let index = 0; index < rows.length - 1; index += 1) {
      expect(rows[index + 1]?.layout.topLanes).toEqual(rows[index]?.layout.bottomLanes);
    }
  });

  it("reuses a freed lane for a later branch tip", () => {
    const rows = buildCommitGraphRows([
      { sha: "top", parents: ["mid", "side-1", "side-2"], refs: ["main"] },
      { sha: "side-1", parents: ["mid"], refs: [] },
      { sha: "late-tip", parents: ["mid"], refs: ["origin/late"] },
      { sha: "side-2", parents: ["mid"], refs: [] },
      { sha: "mid", parents: [], refs: [] },
    ]);

    const lateTipRow = rows[2];
    expect(lateTipRow?.layout.lane).toBe(1);
    expect(lateTipRow?.layout.isNewTip).toBe(true);
    expect(lateTipRow?.layout.topLanes).toEqual([0, 2]);
    expect(lateTipRow?.layout.parentPaths).toEqual([{ fromLane: 1, toLane: 0 }]);
    expect(rows[0]?.layout.laneCount).toBe(3);
  });

  it("keeps lane counts per row so quiet rows are not indented by distant merges", () => {
    const rows = buildCommitGraphRows([
      { sha: "top", parents: ["mid", "side-1", "side-2"], refs: ["main"] },
      { sha: "side-1", parents: ["mid"], refs: [] },
      { sha: "side-2", parents: ["mid"], refs: [] },
      { sha: "mid", parents: [], refs: [] },
    ]);

    expect(rows.map((row) => row.layout.laneCount)).toEqual([3, 3, 3, 1]);
  });

  it("preserves lane continuity through rows that also carry ref decorations", () => {
    const rows = buildCommitGraphRows([
      { sha: "merge", parents: ["main-parent", "side-parent"], refs: ["main", "origin/main"] },
      { sha: "main-parent", parents: ["base"], refs: ["v1.0.0"] },
      { sha: "side-parent", parents: ["base"], refs: ["origin/feature"] },
      { sha: "base", parents: [], refs: [] },
    ]);

    for (let index = 0; index < rows.length - 1; index += 1) {
      const current = rows[index];
      const next = rows[index + 1];
      if (!current || !next) {
        continue;
      }
      expect(next.layout.topLanes).toEqual(current.layout.bottomLanes);
    }
    expect(rows[1]?.visibleRefs).toEqual(["v1.0.0"]);
    expect(rows[2]?.visibleRefs).toEqual(["origin/feature"]);
  });
});
