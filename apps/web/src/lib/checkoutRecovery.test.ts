import { describe, expect, it } from "vite-plus/test";

import {
  seedDraftWorktreePath,
  selectCheckoutRecovery,
  shouldShowCheckoutPicker,
} from "./checkoutRecovery";

const WORKTREE = "/repo/.worktrees/feature";
const PROJECT = "/repo";

const missingStatus = { isRepo: false, pathMissing: true } as const;
const emptyDirStatus = { isRepo: false } as const;
const healthyStatus = { isRepo: true } as const;

describe("selectCheckoutRecovery", () => {
  it("offers both ways out when the worktree is gone and its branch still exists", () => {
    expect(
      selectCheckoutRecovery({
        cwd: WORKTREE,
        projectCwd: PROJECT,
        branch: "feature/x",
        status: missingStatus,
        branchExists: true,
      }),
    ).toEqual({
      cwd: WORKTREE,
      label: "feature",
      projectCwd: PROJECT,
      branch: "feature/x",
      canSwitchToProjectRoot: true,
      canRecreateWorktree: true,
    });
  });

  it("withholds recreate when the branch is gone from the repository", () => {
    const recovery = selectCheckoutRecovery({
      cwd: WORKTREE,
      projectCwd: PROJECT,
      branch: "feature/x",
      status: missingStatus,
      branchExists: false,
    });
    expect(recovery?.canRecreateWorktree).toBe(false);
    expect(recovery?.canSwitchToProjectRoot).toBe(true);
  });

  it("withholds recreate until the branch lookup answers", () => {
    expect(
      selectCheckoutRecovery({
        cwd: WORKTREE,
        projectCwd: PROJECT,
        branch: "feature/x",
        status: missingStatus,
        branchExists: undefined,
      })?.canRecreateWorktree,
    ).toBe(false);
  });

  // A directory that exists but holds no repository is the "Initialize Git"
  // case, which must keep working; only a missing path is a recovery case.
  it("stays silent for a directory that is simply not a repository", () => {
    expect(
      selectCheckoutRecovery({
        cwd: WORKTREE,
        projectCwd: PROJECT,
        branch: null,
        status: emptyDirStatus,
      }),
    ).toBeNull();
  });

  it("stays silent while the status is unknown", () => {
    expect(
      selectCheckoutRecovery({
        cwd: WORKTREE,
        projectCwd: PROJECT,
        branch: null,
        status: null,
      }),
    ).toBeNull();
  });

  it("offers nothing to switch to when the project root itself is the missing path", () => {
    const recovery = selectCheckoutRecovery({
      cwd: PROJECT,
      projectCwd: PROJECT,
      branch: "main",
      status: missingStatus,
      branchExists: true,
    });
    expect(recovery?.canSwitchToProjectRoot).toBe(false);
    expect(recovery?.canRecreateWorktree).toBe(false);
  });
});

describe("shouldShowCheckoutPicker", () => {
  // The regression this exists for: hiding the picker for a deleted checkout
  // removed the only control that could move the thread back to the project
  // root, turning one broken thread into a bricked project.
  it("keeps the picker visible for a missing checkout when the project root is a repository", () => {
    expect(
      shouldShowCheckoutPicker({
        selectedStatus: missingStatus,
        projectRootStatus: healthyStatus,
      }),
    ).toBe(true);
  });

  it("hides the picker when the project root is not a repository either", () => {
    expect(
      shouldShowCheckoutPicker({
        selectedStatus: missingStatus,
        projectRootStatus: emptyDirStatus,
      }),
    ).toBe(false);
  });

  it("hides the picker for a directory that exists but is not a repository", () => {
    expect(
      shouldShowCheckoutPicker({
        selectedStatus: emptyDirStatus,
        projectRootStatus: healthyStatus,
      }),
    ).toBe(false);
  });

  it("stays visible while the status is still loading", () => {
    expect(
      shouldShowCheckoutPicker({ selectedStatus: undefined, projectRootStatus: undefined }),
    ).toBe(true);
  });
});

describe("seedDraftWorktreePath", () => {
  // Without this, a draft started from a thread whose worktree was deleted
  // inherits the dead path and is born broken.
  it("drops an inherited checkout that is known to be missing", () => {
    expect(
      seedDraftWorktreePath({
        requested: undefined,
        inherited: WORKTREE,
        projectChanged: false,
        isCheckoutMissing: (cwd) => cwd === WORKTREE,
      }),
    ).toBeNull();
  });

  it("inherits a checkout that is still there", () => {
    expect(
      seedDraftWorktreePath({
        requested: undefined,
        inherited: WORKTREE,
        projectChanged: false,
        isCheckoutMissing: () => false,
      }),
    ).toBe(WORKTREE);
  });

  it("passes an explicitly chosen path through even when it reads as missing", () => {
    expect(
      seedDraftWorktreePath({
        requested: WORKTREE,
        inherited: null,
        projectChanged: false,
        isCheckoutMissing: () => true,
      }),
    ).toBe(WORKTREE);
  });

  it("drops the inherited checkout on a project change", () => {
    expect(
      seedDraftWorktreePath({
        requested: undefined,
        inherited: WORKTREE,
        projectChanged: true,
        isCheckoutMissing: () => false,
      }),
    ).toBeNull();
  });
});
