/**
 * Refuses to delete a worktree that something is still working in.
 *
 * Removing the folder out from under a live session is precisely what bricks a
 * thread: its next turn fails inside the provider SDK with an error that blames
 * the CLI, and the thread has no way back. The app therefore declines its own
 * removal requests rather than performing them, and names the threads that are
 * in the way so the user can stop or move them first.
 *
 * There is deliberately no force override. Every blocking condition already has
 * a resolution in the existing UI (stop the session, switch the thread's
 * checkout, delete the thread), so an override would only exist to let someone
 * skip the step that keeps the thread usable.
 *
 * The classification itself lives in `@threadlines/shared/worktreeUsage` so the
 * client's cleanup list greys out exactly the folders this guard would refuse.
 *
 * @module WorktreeRemovalGuard
 */
import * as Effect from "effect/Effect";
import { VcsWorktreeInUseError } from "@threadlines/contracts";
import {
  findWorktreeBlockingThreads,
  type WorktreeUsageThread,
} from "@threadlines/shared/worktreeUsage";

/**
 * Fails with {@link VcsWorktreeInUseError} when the path is still in use.
 *
 * Reading the thread list is best-effort by design: if the projection cannot be
 * queried we let the removal through rather than blocking a legitimate cleanup
 * on an unrelated failure. The guard exists to catch the common case, not to be
 * an availability dependency of deleting a folder.
 */
export const ensureWorktreeRemovable = <E>(input: {
  readonly worktreePath: string;
  readonly readThreads: Effect.Effect<ReadonlyArray<WorktreeUsageThread>, E>;
}): Effect.Effect<void, VcsWorktreeInUseError> =>
  Effect.gen(function* () {
    const threads = yield* input.readThreads.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("worktree removal guard could not read threads; allowing removal", {
          worktreePath: input.worktreePath,
          detail: cause.toString(),
        }).pipe(Effect.as([] as ReadonlyArray<WorktreeUsageThread>)),
      ),
    );
    const blockingThreads = findWorktreeBlockingThreads({
      worktreePath: input.worktreePath,
      threads,
    });
    if (blockingThreads.length === 0) {
      return;
    }
    return yield* new VcsWorktreeInUseError({
      worktreePath: input.worktreePath,
      blockingThreads,
    });
  });
