import { describe, expect, it } from "vitest";

import {
  attributedPathsForTurnRange,
  buildSelectiveRevertPlan,
  normalizeCheckpointFilePath,
} from "./SelectiveRevert.ts";
import type { CheckpointEntry, WorktreePathState } from "./Services/CheckpointStore.ts";

function entry(overrides: Partial<CheckpointEntry> & { readonly path: string }): CheckpointEntry {
  return {
    fromOid: "target-oid",
    toOid: "expected-oid",
    hasUnsupportedMode: false,
    ...overrides,
  };
}

function fileState(path: string, oid: string | null): readonly [string, WorktreePathState] {
  return [path, { path, kind: oid === null ? "missing" : "file", oid }];
}

describe("buildSelectiveRevertPlan", () => {
  it("restores attributed paths whose current content matches the thread's last state", () => {
    const plan = buildSelectiveRevertPlan({
      entries: [entry({ path: "src/app.ts" })],
      attributedPaths: new Set(["src/app.ts"]),
      contestedPaths: new Set(),
      worktreeStates: new Map([fileState("src/app.ts", "expected-oid")]),
    });

    expect(plan.restorePaths).toEqual(["src/app.ts"]);
    expect(plan.deletePaths).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.unattributedPaths).toEqual([]);
  });

  it("deletes attributed paths the thread created after the target", () => {
    const plan = buildSelectiveRevertPlan({
      entries: [entry({ path: "src/new.ts", fromOid: null })],
      attributedPaths: new Set(["src/new.ts"]),
      contestedPaths: new Set(),
      worktreeStates: new Map([fileState("src/new.ts", "expected-oid")]),
    });

    expect(plan.restorePaths).toEqual([]);
    expect(plan.deletePaths).toEqual(["src/new.ts"]);
  });

  it("recreates attributed paths the thread deleted after the target", () => {
    const plan = buildSelectiveRevertPlan({
      entries: [entry({ path: "src/gone.ts", toOid: null })],
      attributedPaths: new Set(["src/gone.ts"]),
      contestedPaths: new Set(),
      worktreeStates: new Map([fileState("src/gone.ts", null)]),
    });

    expect(plan.restorePaths).toEqual(["src/gone.ts"]);
    expect(plan.deletePaths).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("leaves unattributed paths untouched", () => {
    const plan = buildSelectiveRevertPlan({
      entries: [entry({ path: "other-session.ts" })],
      attributedPaths: new Set(),
      contestedPaths: new Set(),
      worktreeStates: new Map(),
    });

    expect(plan.unattributedPaths).toEqual(["other-session.ts"]);
    expect(plan.restorePaths).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("marks changed regular files as hunk candidates instead of immediate conflicts", () => {
    const plan = buildSelectiveRevertPlan({
      entries: [entry({ path: "src/app.ts" })],
      attributedPaths: new Set(["src/app.ts"]),
      contestedPaths: new Set(),
      worktreeStates: new Map([fileState("src/app.ts", "foreign-oid")]),
    });

    expect(plan.hunkCandidatePaths).toEqual(["src/app.ts"]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.restorePaths).toEqual([]);
  });

  it("marks recreated-after-deletion paths as conflicts (no base to merge against)", () => {
    const plan = buildSelectiveRevertPlan({
      entries: [entry({ path: "src/gone.ts", toOid: null })],
      attributedPaths: new Set(["src/gone.ts"]),
      contestedPaths: new Set(),
      worktreeStates: new Map([fileState("src/gone.ts", "foreign-oid")]),
    });

    expect(plan.conflicts).toEqual([{ path: "src/gone.ts", reason: "changed-after-thread" }]);
    expect(plan.hunkCandidatePaths).toEqual([]);
  });

  it("marks attributed files deleted by another actor as conflicts, not hunk candidates", () => {
    const plan = buildSelectiveRevertPlan({
      entries: [entry({ path: "src/app.ts" })],
      attributedPaths: new Set(["src/app.ts"]),
      contestedPaths: new Set(),
      worktreeStates: new Map([fileState("src/app.ts", null)]),
    });

    expect(plan.conflicts).toEqual([{ path: "src/app.ts", reason: "changed-after-thread" }]);
    expect(plan.hunkCandidatePaths).toEqual([]);
  });

  it("marks contested regular files as candidates for turn-by-turn rollback", () => {
    const plan = buildSelectiveRevertPlan({
      entries: [entry({ path: "src/app.ts" })],
      attributedPaths: new Set(["src/app.ts"]),
      contestedPaths: new Set(["src/app.ts"]),
      worktreeStates: new Map([fileState("src/app.ts", "expected-oid")]),
    });

    expect(plan.contestedCandidatePaths).toEqual(["src/app.ts"]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.restorePaths).toEqual([]);
  });

  it("marks contested paths that are no longer regular files as interleaved conflicts", () => {
    const plan = buildSelectiveRevertPlan({
      entries: [entry({ path: "src/app.ts" })],
      attributedPaths: new Set(["src/app.ts"]),
      contestedPaths: new Set(["src/app.ts"]),
      worktreeStates: new Map([fileState("src/app.ts", null)]),
    });

    expect(plan.conflicts).toEqual([{ path: "src/app.ts", reason: "interleaved" }]);
    expect(plan.contestedCandidatePaths).toEqual([]);
  });

  it("treats paths already at the target state as no-ops, even when contested", () => {
    const plan = buildSelectiveRevertPlan({
      entries: [entry({ path: "src/app.ts" })],
      attributedPaths: new Set(["src/app.ts"]),
      contestedPaths: new Set(["src/app.ts"]),
      worktreeStates: new Map([fileState("src/app.ts", "target-oid")]),
    });

    expect(plan.noopPaths).toEqual(["src/app.ts"]);
    expect(plan.conflicts).toEqual([]);
  });

  it("marks symlinks, submodules, and non-file worktree paths as conflicts", () => {
    const plan = buildSelectiveRevertPlan({
      entries: [
        entry({ path: "linked.ts", hasUnsupportedMode: true }),
        entry({ path: "now-a-dir" }),
        entry({ path: "never-hashed" }),
      ],
      attributedPaths: new Set(["linked.ts", "now-a-dir", "never-hashed"]),
      contestedPaths: new Set(),
      worktreeStates: new Map([
        fileState("linked.ts", "expected-oid"),
        ["now-a-dir", { path: "now-a-dir", kind: "other", oid: null }],
      ]),
    });

    expect(plan.conflicts).toEqual([
      { path: "linked.ts", reason: "unsupported" },
      { path: "now-a-dir", reason: "changed-after-thread" },
      { path: "never-hashed", reason: "unsupported" },
    ]);
  });

  it("matches attribution across path separator and case differences", () => {
    const plan = buildSelectiveRevertPlan({
      entries: [entry({ path: "src/App.ts" })],
      attributedPaths: new Set([normalizeCheckpointFilePath("src\\app.ts")]),
      contestedPaths: new Set(),
      worktreeStates: new Map([fileState("src/App.ts", "expected-oid")]),
    });

    expect(plan.restorePaths).toEqual(["src/App.ts"]);
  });
});

describe("attributedPathsForTurnRange", () => {
  it("collects normalized paths within the half-open turn range", () => {
    const attributed = attributedPathsForTurnRange({
      checkpoints: [
        { checkpointTurnCount: 1, files: [{ path: "before.ts" }] },
        { checkpointTurnCount: 2, files: [{ path: "src\\Mixed.ts" }] },
        { checkpointTurnCount: 3, files: [{ path: "third.ts" }] },
        { checkpointTurnCount: 4, files: [{ path: "after.ts" }] },
      ],
      afterTurnCount: 1,
      throughTurnCount: 3,
    });

    expect(attributed).toEqual(new Set(["src/mixed.ts", "third.ts"]));
  });
});
