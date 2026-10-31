/**
 * Answers adapters' outsideWorkLookup from the thread shells (see
 * provider/outsideWorkLookup.ts): a session key's agent is marked while its
 * thread lists it in `outsideWork`.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { parseSessionKey } from "@threadlines/shared/threadParticipants";

import { outsideWorkLookup } from "../../provider/outsideWorkLookup.ts";
import { isOutsideMarked } from "../outsideTurns.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

export const OutsideWorkLookupLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery;
    yield* outsideWorkLookup.provide((sessionKey) => {
      const target = parseSessionKey(sessionKey);
      return Effect.gen(function* () {
        // An archived thread still counts: its runtimes stop after it's archived.
        const shell = yield* snapshots.getThreadShellById(target.threadId);
        if (Option.isSome(shell)) return isOutsideMarked(shell.value, target.participantId);
        const detail = yield* snapshots.getThreadDetailById(target.threadId, {
          includeArchived: true,
        });
        return Option.isSome(detail) ? isOutsideMarked(detail.value, target.participantId) : false;
      }).pipe(
        // Can't tell: refuse, rather than let outside work schedule itself.
        Effect.orElseSucceed(() => true),
      );
    });
  }),
);
