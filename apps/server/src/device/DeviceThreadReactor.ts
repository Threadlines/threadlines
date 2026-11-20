/**
 * A thread put away lets go of its devices (docs/design/devices.md): archived,
 * deleted, or moved to another computer, its device sessions end (and with
 * them their agent-device sessions and launchers). The devices keep running.
 *
 * At startup, sessions reloaded from claims.json whose thread was put away
 * while the server was down end the same way, like the secret requests'
 * startup sweep (secrets/AgentSecretRequests.ts).
 */
import type { OrchestrationThread, ThreadId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { DeviceService } from "./DeviceService.ts";

const isPutAway = (thread: OrchestrationThread | undefined) =>
  thread === undefined ||
  thread.deletedAt !== null ||
  thread.archivedAt !== null ||
  (thread.move ?? null) !== null;

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const devices = yield* DeviceService;
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;

    yield* Stream.runForEach(engine.streamDomainEvents, (event) => {
      switch (event.type) {
        case "thread.archived":
        case "thread.move-started":
        case "thread.deleted":
          return devices.releaseThread(event.payload.threadId);
        default:
          return Effect.void;
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("device thread cleanup stopped", { cause })),
      Effect.forkScoped,
    );

    yield* Effect.gen(function* () {
      const { sessions } = yield* devices.state;
      const threads = new Set<ThreadId>(sessions.map((session) => session.threadId));
      for (const threadId of threads) {
        const read = yield* snapshots
          .getThreadDetailById(threadId, { includeArchived: true })
          .pipe(Effect.map(Option.getOrUndefined), Effect.result);
        // A thread whose read failed keeps its devices: never released blind.
        if (read._tag === "Failure") continue;
        if (isPutAway(read.success)) yield* devices.releaseThread(threadId);
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("device claim recovery failed", { cause })),
      Effect.forkScoped,
    );
  }),
);
