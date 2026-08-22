import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import type { WorktreeUsageThread } from "@threadlines/shared/worktreeUsage";

import { ensureWorktreeRemovable } from "./WorktreeRemovalGuard.ts";

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
