import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";

import {
  ensureWorktreeRemovable,
  findWorktreeBlockingThreads,
  type WorktreeUsageThread,
} from "./WorktreeRemovalGuard.ts";

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
    assert.deepStrictEqual(blocking, [
      { threadId: "thread-a", title: "Feature work", hasLiveSession: true },
    ]);
  });

  it("blocks a path a thread is bound to even with no session running", () => {
    const blocking = findWorktreeBlockingThreads({
      worktreePath: WORKTREE,
      threads: [thread({ worktreePath: WORKTREE, session: null })],
    });
    assert.strictEqual(blocking.length, 1);
    assert.isFalse(blocking[0]?.hasLiveSession);
  });

  // Deleting a thread stops its session and clears it from the projection
  // first, so the app's own cleanup of a now-orphaned worktree still works.
  it("allows removal once no thread is bound and no session runs there", () => {
    assert.deepStrictEqual(
      findWorktreeBlockingThreads({
        worktreePath: WORKTREE,
        threads: [
          thread({ worktreePath: OTHER, session: { status: "ready", checkoutCwd: OTHER } }),
        ],
      }),
      [],
    );
  });

  it("ignores a stopped session that merely remembers the path", () => {
    assert.deepStrictEqual(
      findWorktreeBlockingThreads({
        worktreePath: WORKTREE,
        threads: [
          thread({ worktreePath: null, session: { status: "stopped", checkoutCwd: WORKTREE } }),
        ],
      }),
      [],
    );
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
    assert.strictEqual(blocking.length, 1);
    assert.isTrue(blocking[0]?.hasLiveSession);
  });

  it("matches paths across trailing separators and case", () => {
    const blocking = findWorktreeBlockingThreads({
      worktreePath: WORKTREE,
      threads: [thread({ worktreePath: `${WORKTREE}/` })],
    });
    assert.strictEqual(blocking.length, 1);
  });
});

describe("ensureWorktreeRemovable", () => {
  it.effect("fails with the blocking threads named", () =>
    Effect.gen(function* () {
      const exit = yield* ensureWorktreeRemovable({
        worktreePath: WORKTREE,
        readThreads: Effect.succeed([
          thread({ worktreePath: WORKTREE, session: { status: "running", checkoutCwd: WORKTREE } }),
        ]),
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
      assert.strictEqual((error as { _tag?: string })?._tag, "VcsWorktreeInUseError");
      assert.include(String((error as { message?: string })?.message), "Feature work");
    }),
  );

  it.effect("succeeds when nothing uses the path", () =>
    Effect.gen(function* () {
      yield* ensureWorktreeRemovable({
        worktreePath: WORKTREE,
        readThreads: Effect.succeed([thread({ worktreePath: OTHER })]),
      });
    }),
  );

  // The guard protects against a common mistake; it must not become a reason
  // that deleting a folder stops working when an unrelated query fails.
  it.effect("allows removal when the thread list cannot be read", () =>
    Effect.gen(function* () {
      yield* ensureWorktreeRemovable({
        worktreePath: WORKTREE,
        readThreads: Effect.fail(new Error("projection unavailable")),
      });
    }),
  );
});
