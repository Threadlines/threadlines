import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import type { WorktreeUsageThread } from "@threadlines/shared/worktreeUsage";

import { ensureWorktreeRemovable } from "./WorktreeRemovalGuard.ts";

/** A failure the code under test only passes along. */
class TestFailure extends Data.TaggedError("TestFailure")<{ readonly message: string }> {}

const WORKTREE = "/repo/.worktrees/feature";
const OTHER = "/repo/.worktrees/other";

const thread = (overrides: Partial<WorktreeUsageThread> = {}): WorktreeUsageThread => ({
  id: "thread-a",
  title: "Feature work",
  worktreePath: null,
  ...overrides,
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

  // git names a worktree by its real path; a thread can record the same
  // folder through a symlink, and must still be in the way.
  it.effect("sees a thread that recorded the folder through a symlink", () => {
    const base = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "guard-")));
    const real = NodePath.join(base, "feature");
    const linked = NodePath.join(base, "linked");
    NodeFs.mkdirSync(real);
    NodeFs.symlinkSync(real, linked);
    return Effect.gen(function* () {
      const exit = yield* ensureWorktreeRemovable({
        worktreePath: real,
        readThreads: Effect.succeed([thread({ worktreePath: linked })]),
      }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));

      // Another folder beside it is still free to go.
      yield* ensureWorktreeRemovable({
        worktreePath: NodePath.join(base, "other"),
        readThreads: Effect.succeed([thread({ worktreePath: linked })]),
      });
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFs.rmSync(base, { recursive: true, force: true }))),
    );
  });

  // The guard protects against a common mistake; it must not become a reason
  // that deleting a folder stops working when an unrelated query fails.
  it.effect("allows removal when the thread list cannot be read", () =>
    Effect.gen(function* () {
      yield* ensureWorktreeRemovable({
        worktreePath: WORKTREE,
        readThreads: Effect.fail(new TestFailure({ message: "projection unavailable" })),
      });
    }),
  );
});
