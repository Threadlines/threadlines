import { describe, expect, it } from "vite-plus/test";

import { findWorktreeBlockingThreads, type WorktreeUsageThread } from "./worktreeUsage.ts";

const WORKTREE = "/repo/.worktrees/feature";
const OTHER = "/repo/.worktrees/other";

const thread = (overrides: Partial<WorktreeUsageThread> = {}): WorktreeUsageThread => ({
  id: "thread-a",
  title: "Feature work",
  worktreePath: null,
  ...overrides,
});

describe("findWorktreeBlockingThreads", () => {
  // The incident: an agent merged its PR and deleted the worktree it was
  // running in, leaving its own thread with nowhere to run.
  it("blocks a path a live session is running in", () => {
    const blocking = findWorktreeBlockingThreads({
      worktreePath: WORKTREE,
      threads: [
        thread({ worktreePath: WORKTREE, session: { status: "running", checkoutCwd: WORKTREE } }),
      ],
    });
    expect(blocking).toEqual([
      { threadId: "thread-a", title: "Feature work", hasLiveSession: true },
    ]);
  });

  it("blocks a path a thread is bound to even with no session running", () => {
    const blocking = findWorktreeBlockingThreads({
      worktreePath: WORKTREE,
      threads: [thread({ worktreePath: WORKTREE, session: null })],
    });
    expect(blocking.length).toBe(1);
    expect(blocking[0]?.hasLiveSession).toBe(false);
  });

  // Deleting a thread stops its session and clears it from the projection
  // first, so the app's own cleanup of a now-orphaned worktree still works.
  it("allows removal once no thread is bound and no session runs there", () => {
    expect(
      findWorktreeBlockingThreads({
        worktreePath: WORKTREE,
        threads: [
          thread({ worktreePath: OTHER, session: { status: "ready", checkoutCwd: OTHER } }),
        ],
      }),
    ).toEqual([]);
  });

  it("ignores a stopped session that merely remembers the path", () => {
    expect(
      findWorktreeBlockingThreads({
        worktreePath: WORKTREE,
        threads: [
          thread({ worktreePath: null, session: { status: "stopped", checkoutCwd: WORKTREE } }),
        ],
      }),
    ).toEqual([]);
  });

  // The agent can move itself into a worktree mid-session without the thread's
  // configured checkout ever pointing there.
  it("blocks a path a session wandered into", () => {
    const blocking = findWorktreeBlockingThreads({
      worktreePath: WORKTREE,
      threads: [
        thread({ worktreePath: null, effectiveCwd: WORKTREE, session: { status: "running" } }),
      ],
    });
    expect(blocking.length).toBe(1);
    expect(blocking[0]?.hasLiveSession).toBe(true);
  });

  it("matches paths across trailing separators and case", () => {
    const blocking = findWorktreeBlockingThreads({
      worktreePath: WORKTREE,
      threads: [thread({ worktreePath: `${WORKTREE}/` })],
    });
    expect(blocking.length).toBe(1);
  });
});
