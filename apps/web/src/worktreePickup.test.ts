import type { VcsWorktreeStatus } from "@threadlines/contracts";
import { describe, expect, it } from "vitest";

import {
  isSettledWorktree,
  pickupCandidates,
  threadTitleFromWorktree,
  worktreePathLabel,
} from "./worktreePickup";

function worktree(overrides: Partial<VcsWorktreeStatus> = {}): VcsWorktreeStatus {
  return {
    path: "/code/shop-checkout-retry",
    refName: "fix/checkout-retry",
    isRoot: false,
    dirty: false,
    dirtyUnknown: false,
    unmergedCommitCount: 2,
    unrelatedHistory: false,
    mergedByContent: false,
    missing: false,
    lockReason: null,
    managed: false,
    changedFileCount: 0,
    lastCommitAt: null,
    ...overrides,
  };
}

describe("pickupCandidates", () => {
  it("offers the worktrees made elsewhere that are on disk and that no thread works in", () => {
    const free = worktree();
    const candidates = pickupCandidates({
      worktrees: [
        free,
        worktree({ path: "/code/shop-taken", refName: "feature/taken" }),
        worktree({ path: "/code/shop-gone", missing: true }),
        worktree({ path: "/code/shop", isRoot: true }),
        worktree({ path: "/home/.threadlines/worktrees/shop/abc", managed: true }),
        // A project that sits in a linked worktree is not its own pickup.
        worktree({ path: "/code/shop-project" }),
      ],
      projectCwd: "/code/shop-project/apps/web",
      threadWorktreePaths: ["/code/shop-taken"],
    });
    expect(candidates).toEqual([free]);
  });
});

describe("isSettledWorktree", () => {
  it("counts a worktree with nothing left to ship, and never one with uncommitted changes", () => {
    expect(isSettledWorktree(worktree())).toBe(false);
    expect(isSettledWorktree(worktree({ unmergedCommitCount: 0 }))).toBe(true);
    expect(isSettledWorktree(worktree({ mergedByContent: true }))).toBe(true);
    expect(
      isSettledWorktree(worktree({ mergedByContent: true, dirty: true, changedFileCount: 3 })),
    ).toBe(false);
    // Git could not say how far ahead it is: that is not "nothing".
    expect(isSettledWorktree(worktree({ unmergedCommitCount: null }))).toBe(false);
  });
});

describe("threadTitleFromWorktree", () => {
  it("reads a branch as a title", () => {
    const title = (refName: string | null, path = "/code/shop-checkout-retry") =>
      threadTitleFromWorktree({ refName, path });
    expect(title("fix/checkout-retry")).toBe("Checkout retry");
    expect(title("will/feat/cart_totals")).toBe("Cart totals");
    expect(title("main")).toBe("Main");
    // A last part that says nothing alone keeps the parts before it.
    expect(title("release/1.2")).toBe("Release 1.2");
    // Detached: the folder names it.
    expect(title(null)).toBe("Shop checkout retry");
    expect(title(null, "C:\\code\\shop-hotfix\\")).toBe("Shop hotfix");
  });
});

describe("worktreePathLabel", () => {
  it("names a worktree by where it is from the project, or whole when it is far off", () => {
    expect(worktreePathLabel("/code/shop-checkout-retry", "/code/shop")).toBe(
      "../shop-checkout-retry",
    );
    expect(worktreePathLabel("/code/shop/.claude/worktrees/retry/", "/code/shop")).toBe(
      ".claude/worktrees/retry",
    );
    expect(worktreePathLabel("C:\\Code\\shop-retry", "c:\\code\\shop")).toBe("../shop-retry");
    expect(worktreePathLabel("/work/conductor/shop/tokyo", "/code/shop")).toBe(
      "/work/conductor/shop/tokyo",
    );
  });
});
