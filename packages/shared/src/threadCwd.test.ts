import { describe, expect, it } from "vite-plus/test";

import { effectiveCwdOf } from "./threadCwd.ts";

describe("effectiveCwdOf", () => {
  it("replays an old subagent guess as no move, and keeps what the session reported", () => {
    // History recorded before Oct 2026 can still hold a checkout guessed from
    // an isolated subagent; it never moved the thread's own agent.
    expect(
      effectiveCwdOf({
        effectiveCwd: "/repo/.claude/worktrees/a",
        effectiveCwdSource: "subagent",
      }),
    ).toEqual({ effectiveCwd: null, effectiveCwdSource: null });
    expect(effectiveCwdOf({ effectiveCwd: "/repo/.claude/worktrees/a" })).toEqual({
      effectiveCwd: "/repo/.claude/worktrees/a",
      effectiveCwdSource: "session",
    });
    expect(effectiveCwdOf({ effectiveCwd: null, effectiveCwdSource: "selection" })).toEqual({
      effectiveCwd: null,
      effectiveCwdSource: "selection",
    });
  });
});
