import {
  EnvironmentId,
  GitCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VcsWorktreeInUseError,
  type VcsRef,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_COMPOSER_RUNTIME_MODE, DEFAULT_INTERACTION_MODE, type Thread } from "./types";
import {
  describeWorktreeNotes,
  describeWorktreeRemovalError,
  formatWorktreePathForDisplay,
  getOrphanedWorktreePathForThread,
  getVcsRefBadge,
  isWorktreeSafeToDelete,
  summarizeWorktreeSelection,
  type WorktreeCleanupRow,
} from "./worktreeCleanup";

const localEnvironmentId = EnvironmentId.make("environment-local");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    codexThreadId: null,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_COMPOSER_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    doneOverride: null,
    lastSeenAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    effectiveCwd: null,
    goal: null,
    ...overrides,
  };
}

describe("getOrphanedWorktreePathForThread", () => {
  it("returns null when the target thread does not exist", () => {
    const result = getOrphanedWorktreePathForThread([], ThreadId.make("missing-thread"));
    expect(result).toBeNull();
  });

  it("returns null when the target thread has no worktree", () => {
    const threads = [makeThread()];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBeNull();
  });

  it("returns the path when no other thread links to that worktree", () => {
    const threads = [makeThread({ worktreePath: "/tmp/repo/worktrees/feature-a" })];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });

  it("returns null when another thread links to the same worktree", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBeNull();
  });

  // An archived thread can bring its checkout back through checkout recovery,
  // so its link has to count in both directions.
  it("returns null when only an archived thread links to the same worktree", () => {
    const result = getOrphanedWorktreePathForThread(
      [makeThread({ worktreePath: "/tmp/repo/worktrees/feature-a" })],
      ThreadId.make("thread-1"),
      [{ id: "thread-archived", worktreePath: "/tmp/repo/worktrees/feature-a" }],
    );
    expect(result).toBeNull();
  });

  it("resolves an archived target thread against the live threads", () => {
    const archived = [{ id: "thread-archived", worktreePath: "/tmp/repo/worktrees/feature-a" }];
    expect(
      getOrphanedWorktreePathForThread(
        [makeThread({ worktreePath: "/tmp/repo/worktrees/feature-b" })],
        "thread-archived",
        archived,
      ),
    ).toBe("/tmp/repo/worktrees/feature-a");
    expect(
      getOrphanedWorktreePathForThread(
        [makeThread({ worktreePath: "/tmp/repo/worktrees/feature-a" })],
        "thread-archived",
        archived,
      ),
    ).toBeNull();
  });

  it("ignores threads linked to different worktrees", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-b",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });
});

describe("worktree cleanup selection", () => {
  function makeRow(overrides: Partial<WorktreeCleanupRow> = {}): WorktreeCleanupRow {
    return {
      path: "/repo/.worktrees/feature",
      refName: "feature",
      dirty: false,
      dirtyUnknown: false,
      unmergedCommitCount: 0,
      unrelatedHistory: false,
      mergedByContent: false,
      missing: false,
      lockReason: null,
      state: "unused",
      archivedThreadTitles: [],
      blockingThreadTitles: [],
      archiveUnknown: false,
      ...overrides,
    };
  }

  // Only these get pre-checked, so the bar for "safe" has to stay strict.
  it("treats a row as safe only when nothing at all would be lost", () => {
    expect(isWorktreeSafeToDelete(makeRow())).toBe(true);
    expect(isWorktreeSafeToDelete(makeRow({ dirty: true }))).toBe(false);
    expect(isWorktreeSafeToDelete(makeRow({ unmergedCommitCount: 2 }))).toBe(false);
    expect(
      isWorktreeSafeToDelete(makeRow({ state: "archived", archivedThreadTitles: ["Old work"] })),
    ).toBe(false);
    expect(isWorktreeSafeToDelete(makeRow({ state: "in-use" }))).toBe(false);
    expect(isWorktreeSafeToDelete(makeRow({ unrelatedHistory: true }))).toBe(false);
    // An unknown count is not a promise that the branch is merged.
    expect(isWorktreeSafeToDelete(makeRow({ unmergedCommitCount: null }))).toBe(false);
    // Unknown is never clean: an unreadable status or archive list blocks it.
    expect(isWorktreeSafeToDelete(makeRow({ dirty: true, dirtyUnknown: true }))).toBe(false);
    expect(isWorktreeSafeToDelete(makeRow({ archiveUnknown: true }))).toBe(false);
    // A lock usually means an agent is still working there.
    expect(isWorktreeSafeToDelete(makeRow({ lockReason: "" }))).toBe(false);
  });

  // Squash merges ship a branch under new commits, and a folder that is
  // already gone holds nothing; both are safe even with commits "not on main".
  it("treats squash-merged branches and vanished folders as safe", () => {
    expect(
      isWorktreeSafeToDelete(makeRow({ unmergedCommitCount: 13, mergedByContent: true })),
    ).toBe(true);
    expect(isWorktreeSafeToDelete(makeRow({ missing: true, unmergedCommitCount: null }))).toBe(
      true,
    );
    expect(
      isWorktreeSafeToDelete(
        makeRow({ mergedByContent: true, unmergedCommitCount: 2, dirty: true }),
      ),
    ).toBe(false);
    expect(
      describeWorktreeNotes(makeRow({ unmergedCommitCount: 13, mergedByContent: true }), "main"),
    ).toEqual([]);
  });

  it("names every risk on the row", () => {
    expect(describeWorktreeNotes(makeRow(), "main")).toEqual([]);
    expect(
      describeWorktreeNotes(
        makeRow({
          dirty: true,
          unmergedCommitCount: 1,
          state: "archived",
          archivedThreadTitles: ["Old work"],
        }),
        "main",
      ),
    ).toEqual(["uncommitted changes", "1 commit not on main", "archived thread points here"]);
    expect(describeWorktreeNotes(makeRow({ unmergedCommitCount: 3 }), null)).toEqual([
      "3 commits not on the default branch",
    ]);
    expect(
      describeWorktreeNotes(makeRow({ refName: null, unmergedCommitCount: null }), "main"),
    ).toEqual(["detached checkout"]);
    expect(
      describeWorktreeNotes(
        makeRow({
          dirty: true,
          dirtyUnknown: true,
          unmergedCommitCount: null,
          lockReason: "claude agent (pid 42)",
          archiveUnknown: true,
        }),
        "main",
      ),
    ).toEqual([
      "locked: claude agent (pid 42)",
      "couldn't check for uncommitted changes",
      "couldn't compare with main",
      "couldn't check archived threads",
    ]);
    expect(
      describeWorktreeNotes(makeRow({ missing: true, unmergedCommitCount: null }), "main"),
    ).toEqual(["folder already gone"]);
  });

  // Counting against a base the branch never touched reports its whole history
  // as unshipped work, which is how "1731 commits not on main" happened.
  it("says the histories are unrelated instead of counting them", () => {
    expect(
      describeWorktreeNotes(makeRow({ unrelatedHistory: true, unmergedCommitCount: null }), "main"),
    ).toEqual(["no shared history with main"]);
    expect(
      describeWorktreeNotes(makeRow({ unrelatedHistory: true, unmergedCommitCount: null }), null),
    ).toEqual(["no shared history with the default branch"]);
  });

  it("counts the ticked rows and flags when any of them is risky", () => {
    const safe = makeRow({ path: "/repo/.worktrees/safe" });
    const risky = makeRow({ path: "/repo/.worktrees/risky", dirty: true });

    expect(summarizeWorktreeSelection([safe, risky], new Set(["/repo/.worktrees/safe"]))).toEqual({
      count: 1,
      hasRisky: false,
    });
    expect(summarizeWorktreeSelection([safe, risky], new Set([safe.path, risky.path]))).toEqual({
      count: 2,
      hasRisky: true,
    });
    expect(summarizeWorktreeSelection([safe, risky], new Set())).toEqual({
      count: 0,
      hasRisky: false,
    });
  });
});

describe("describeWorktreeRemovalError", () => {
  const gitError = (detail: string) =>
    new GitCommandError({
      operation: "GitVcsDriver.removeWorktree",
      command: "git worktree remove --force /repo/.worktrees/feature",
      cwd: "/repo",
      detail,
    });

  // Rows used to show the whole nested git error: command lines, cwd and full
  // paths, two or three times over.
  it("turns removal failures into one plain sentence", () => {
    expect(
      describeWorktreeRemovalError(
        new VcsWorktreeInUseError({
          worktreePath: "/repo/.worktrees/feature",
          blockingThreads: [{ threadId: "thread-1", title: "Fix login", hasLiveSession: true }],
        }),
      ),
    ).toBe('Now in use by "Fix login".');
    expect(describeWorktreeRemovalError(gitError("git worktree remove --force x timed out."))).toBe(
      "Deleting took too long. Try again to finish.",
    );
    expect(
      describeWorktreeRemovalError(
        gitError("error: failed to delete '/repo/.worktrees/feature': Permission denied"),
      ),
    ).toBe("Some files are still open. Close anything using this folder, then try again.");
    expect(
      describeWorktreeRemovalError(
        gitError("fatal: working trees containing submodules cannot be moved or removed"),
      ),
    ).toBe("Working trees containing submodules cannot be moved or removed.");
  });
});

describe("getVcsRefBadge", () => {
  function makeRef(overrides: Partial<VcsRef> = {}): VcsRef {
    return {
      name: "feature",
      current: false,
      isDefault: false,
      worktreePath: null,
      ...overrides,
    };
  }

  it("tags a branch checked out in a secondary worktree", () => {
    const ref = makeRef({ worktreePath: "/repo/.worktrees/feature", isDefault: true });
    expect(getVcsRefBadge(ref, "/repo")).toBe("worktree");
  });

  // The panel's picker looks at whichever checkout is being viewed, which may
  // itself be a worktree; the badge must compare against the project root.
  it("does not tag the branch that occupies the project's root checkout", () => {
    const ref = makeRef({ worktreePath: "/repo", isDefault: true });
    expect(getVcsRefBadge(ref, "/repo")).toBe("default");
  });

  it("prefers current over every other tag", () => {
    const ref = makeRef({ current: true, worktreePath: "/repo/.worktrees/feature" });
    expect(getVcsRefBadge(ref, "/repo")).toBe("current");
  });

  it("falls back to remote and then default", () => {
    expect(getVcsRefBadge(makeRef({ isRemote: true, isDefault: true }), "/repo")).toBe("remote");
    expect(getVcsRefBadge(makeRef({ isDefault: true }), "/repo")).toBe("default");
    expect(getVcsRefBadge(makeRef(), "/repo")).toBeNull();
  });
});

describe("formatWorktreePathForDisplay", () => {
  it("shows only the last path segment for unix-like paths", () => {
    const result = formatWorktreePathForDisplay(
      "/Users/julius/.threadlines/worktrees/threadlines-mvp/threadlines-4e609bb8",
    );
    expect(result).toBe("threadlines-4e609bb8");
  });

  it("normalizes windows separators before selecting the final segment", () => {
    const result = formatWorktreePathForDisplay(
      "C:\\Users\\julius\\.threadlines\\worktrees\\threadlines-mvp\\threadlines-4e609bb8",
    );
    expect(result).toBe("threadlines-4e609bb8");
  });

  it("uses the final segment even when outside ~/.threadlines/worktrees", () => {
    const result = formatWorktreePathForDisplay("/tmp/custom-worktrees/my-worktree");
    expect(result).toBe("my-worktree");
  });

  it("ignores trailing slashes", () => {
    const result = formatWorktreePathForDisplay("/tmp/custom-worktrees/my-worktree/");
    expect(result).toBe("my-worktree");
  });
});
