import { randomUUID } from "node:crypto";

import { CommandId } from "@threadlines/contracts";
import { makeDrainableWorker } from "@threadlines/shared/DrainableWorker";
import { normalizeFilesystemPathForComparison } from "@threadlines/shared/path";
import { resolveThreadWorkingCwd } from "@threadlines/shared/threadCwd";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  VcsStatusBroadcaster,
  type VcsLocalStatusObservation,
} from "../../vcs/VcsStatusBroadcaster.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadDiffStatBaselineReactor,
  type ThreadDiffStatBaselineReactorShape,
} from "../Services/ThreadDiffStatBaselineReactor.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * A checkout counts as clean when it is a repository with nothing uncommitted.
 * A non-repository has no notion of "committed", so it never rebases anything;
 * a partially committed tree is still dirty and deliberately rebases nothing
 * either, since we cannot tell which thread's work was the part that landed.
 */
function isCleanCheckout(observation: VcsLocalStatusObservation): boolean {
  return observation.local.isRepo && !observation.local.hasWorkingTreeChanges;
}

export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;

  const rebaseThreadsForCleanCheckout = Effect.fn("rebaseThreadsForCleanCheckout")(function* (
    observation: VcsLocalStatusObservation,
  ) {
    const baselines = yield* projectionSnapshotQuery.listThreadDiffStatBaselines().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("thread.diffstat.baseline-query-failed", {
          cwd: observation.cwd,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(null)),
      ),
    );
    if (baselines === null) {
      return;
    }

    const observedCwd = normalizeFilesystemPathForComparison(observation.cwd);
    for (const candidate of baselines) {
      // Same precedence the web uses to decide which checkout a thread's
      // workspace surfaces act on, so the badge resets for exactly the threads
      // a user would say were working in the checkout they just committed.
      const threadCwd = resolveThreadWorkingCwd({
        projectCwd: candidate.workspaceRoot,
        worktreePath: candidate.worktreePath,
        effectiveCwd: candidate.effectiveCwd,
      });
      if (threadCwd === null) {
        continue;
      }
      if (normalizeFilesystemPathForComparison(threadCwd) !== observedCwd) {
        continue;
      }

      const nextBaseline = candidate.latestCompletedCheckpointTurnCount;
      // Nothing to reset (no completed turn), or already reset. The second case
      // is the dedupe that keeps a checkout which simply stays clean from
      // appending an event on every status refresh.
      if (nextBaseline === null || nextBaseline <= candidate.baselineTurnCount) {
        continue;
      }

      const createdAt = yield* nowIso;
      yield* orchestrationEngine
        .dispatch({
          type: "thread.diffstat.rebase",
          commandId: CommandId.make(`thread-diffstat-rebase:${candidate.threadId}:${randomUUID()}`),
          threadId: candidate.threadId,
          baselineTurnCount: nextBaseline,
          createdAt,
        })
        .pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning("thread.diffstat.rebase-dispatch-failed", {
              threadId: candidate.threadId,
              baselineTurnCount: nextBaseline,
              cause: Cause.pretty(cause),
            }),
          ),
        );
    }
  });

  // Only clean observations reach the queue, so the worker never has to re-ask.
  const worker = yield* makeDrainableWorker(rebaseThreadsForCleanCheckout);

  const start: ThreadDiffStatBaselineReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(vcsStatusBroadcaster.observeLocalStatus(), (observation) =>
        // Filtering before the queue keeps a dirty checkout's every-two-minute
        // refresh from costing a projection query.
        isCleanCheckout(observation) ? worker.enqueue(observation) : Effect.void,
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDiffStatBaselineReactorShape;
});

export const ThreadDiffStatBaselineReactorLive = Layer.effect(ThreadDiffStatBaselineReactor, make);
