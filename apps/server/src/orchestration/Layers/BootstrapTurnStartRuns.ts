/**
 * BootstrapTurnStartRuns - one bootstrap turn start per command id.
 *
 * A bootstrap turn start (create the thread, cut a worktree, launch the setup
 * script, start the turn) is several engine dispatches under one client
 * command id, so the engine's per-command receipts cannot make it idempotent
 * on their own. The client re-sends a command whose socket dropped or whose
 * response was slow, and a second run would fail on `thread.create` after the
 * first run already created the thread.
 *
 * This service runs each command id once. The run is forked into the
 * service's own scope so a dropped socket does not abort a half-done
 * bootstrap, and a retry that arrives while it is still running joins that
 * run's result. Retries that arrive after the run finished are answered from
 * the command receipt by the caller.
 *
 * @module BootstrapTurnStartRuns
 */
import type { CommandId, OrchestrationDispatchCommandError } from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

export interface BootstrapTurnStartResult {
  readonly sequence: number;
}

type BootstrapTurnStartRun = Effect.Effect<
  BootstrapTurnStartResult,
  OrchestrationDispatchCommandError
>;

export interface BootstrapTurnStartRunsShape {
  /** Run `bootstrap` for `commandId`, or join the run already in flight for it. */
  readonly run: (commandId: CommandId, bootstrap: BootstrapTurnStartRun) => BootstrapTurnStartRun;
}

export class BootstrapTurnStartRuns extends Context.Service<
  BootstrapTurnStartRuns,
  BootstrapTurnStartRunsShape
>()("threadlines/orchestration/BootstrapTurnStartRuns") {}

export const makeBootstrapTurnStartRuns = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const inflight = new Map<
    CommandId,
    Deferred.Deferred<BootstrapTurnStartResult, OrchestrationDispatchCommandError>
  >();

  const run: BootstrapTurnStartRunsShape["run"] = (commandId, bootstrap) =>
    Effect.gen(function* () {
      const existing = inflight.get(commandId);
      if (existing) {
        return yield* Deferred.await(existing);
      }
      const result = yield* Deferred.make<
        BootstrapTurnStartResult,
        OrchestrationDispatchCommandError
      >();
      inflight.set(commandId, result);
      yield* bootstrap.pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Exit.isSuccess(exit)
            ? Deferred.succeed(result, exit.value)
            : Deferred.failCause(result, exit.cause),
        ),
        // Dropped only after the result is settled (and, on success, after the
        // engine wrote the receipt), so a retry never finds neither a run in
        // flight nor a receipt.
        Effect.ensuring(
          Effect.sync(() => {
            inflight.delete(commandId);
          }),
        ),
        Effect.forkIn(scope),
      );
      return yield* Deferred.await(result);
    });

  return { run } satisfies BootstrapTurnStartRunsShape;
});

export const BootstrapTurnStartRunsLive = Layer.effect(
  BootstrapTurnStartRuns,
  makeBootstrapTurnStartRuns,
);
