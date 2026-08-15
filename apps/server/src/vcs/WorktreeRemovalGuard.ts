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
 * @module WorktreeRemovalGuard
 */
import * as Effect from "effect/Effect";
import { VcsWorktreeInUseError } from "@threadlines/contracts";

import { normalizeWorkspacePath } from "../checkpointing/Utils.ts";

/** The subset of a thread shell this guard reads. */
export interface WorktreeUsageThread {
  readonly id: string;
  readonly title?: string | null | undefined;
  readonly worktreePath: string | null;
  readonly effectiveCwd?: string | null | undefined;
  readonly session?:
    | {
        readonly status: string;
        readonly checkoutCwd?: string | null | undefined;
      }
    | null
    | undefined;
}

export interface WorktreeBlockingThread {
  readonly threadId: string;
  readonly title: string | null;
  readonly hasLiveSession: boolean;
}

const samePath = (left: string | null | undefined, right: string): boolean =>
  typeof left === "string" &&
  left.length > 0 &&
  normalizeWorkspacePath(left) === normalizeWorkspacePath(right);

/**
 * A session counts as live unless it has been stopped. `error` and
 * `interrupted` sessions still own a runtime that can be resumed in place, so
 * they block too; only an explicitly stopped session releases the folder.
 */
const hasLiveSessionIn = (thread: WorktreeUsageThread, worktreePath: string): boolean => {
  const session = thread.session;
  if (!session || session.status === "stopped") {
    return false;
  }
  return (
    samePath(session.checkoutCwd, worktreePath) ||
    samePath(thread.effectiveCwd, worktreePath) ||
    samePath(thread.worktreePath, worktreePath)
  );
};

/**
 * Threads that still use `worktreePath`, either as their configured checkout or
 * as the directory a live session is actually running in. Pure so the policy is
 * testable without a database.
 */
export function findWorktreeBlockingThreads(input: {
  readonly worktreePath: string;
  readonly threads: ReadonlyArray<WorktreeUsageThread>;
}): ReadonlyArray<WorktreeBlockingThread> {
  const blocking: WorktreeBlockingThread[] = [];
  for (const thread of input.threads) {
    const live = hasLiveSessionIn(thread, input.worktreePath);
    const bound = samePath(thread.worktreePath, input.worktreePath);
    if (!live && !bound) {
      continue;
    }
    blocking.push({
      threadId: thread.id,
      title: thread.title?.trim() || null,
      hasLiveSession: live,
    });
  }
  return blocking;
}

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
