/**
 * ComputerLinkReactors: starts both sides of computer links with the other
 * reactors (docs/design/fleet.md): RemoteChildReactor for children this
 * computer's agents started on linked computers, and LinkRequests for what
 * linked computers asked of this one. Started after the orchestration
 * reactor has settled the sessions the previous process left, so a turn
 * that restart cut off already reads as cut off.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import { ThreadMoves } from "../moves/ThreadMoves.ts";
import { LinkMoves } from "./LinkMoves.ts";
import { LinkRequests } from "./LinkRequests.ts";
import { RemoteChildReactor } from "./RemoteChildReactor.ts";

export interface ComputerLinkReactorsShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ComputerLinkReactors extends Context.Service<
  ComputerLinkReactors,
  ComputerLinkReactorsShape
>()("threadlines/links/ComputerLinkReactors") {}

export const ComputerLinkReactorsLive = Layer.effect(
  ComputerLinkReactors,
  Effect.gen(function* () {
    const remoteChildren = yield* RemoteChildReactor;
    const linkRequests = yield* LinkRequests;
    const linkMoves = yield* LinkMoves;
    const threadMoves = yield* ThreadMoves;
    return ComputerLinkReactors.of({
      start: () =>
        Effect.gen(function* () {
          yield* linkRequests.startReactor();
          yield* linkMoves.startReactor();
          yield* threadMoves.startReactor();
          yield* remoteChildren.start();
        }),
    });
  }),
);
