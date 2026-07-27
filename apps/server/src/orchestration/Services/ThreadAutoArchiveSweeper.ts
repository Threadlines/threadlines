import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ThreadAutoArchiveSweeperShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly sweepNow: () => Effect.Effect<number, never>;
}

export class ThreadAutoArchiveSweeper extends Context.Service<
  ThreadAutoArchiveSweeper,
  ThreadAutoArchiveSweeperShape
>()("threadlines/orchestration/Services/ThreadAutoArchiveSweeper") {}
