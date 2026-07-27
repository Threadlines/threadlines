import { randomUUID } from "node:crypto";

import { CommandId } from "@threadlines/contracts";
import { selectAutoArchiveCandidates } from "@threadlines/shared/threadAutoArchive";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadAutoArchiveSweeper,
  type ThreadAutoArchiveSweeperShape,
} from "../Services/ThreadAutoArchiveSweeper.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 15 * 60 * 1_000;

export interface ThreadAutoArchiveSweeperLiveOptions {
  readonly sweepIntervalMs?: number;
}

const makeThreadAutoArchiveSweeper = (options?: ThreadAutoArchiveSweeperLiveOptions) =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const lastObservedInactiveDaysRef = yield* Ref.make<number | null>(null);
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    // The interval fiber, the settings-change fiber, and `sweepNow` all reach
    // for the same candidate set. Serialize them so two sweeps can't both
    // dispatch `thread.archive` for one thread and leave the loser logging a
    // rejected-command warning.
    const sweepSemaphore = yield* Semaphore.make(1);

    const runSweep = Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("thread.auto-archive.settings-read-failed", { cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
      if (settings === null || settings.autoArchiveInactiveThreadsDays === 0) {
        return {
          archivedCount: 0,
          inactiveDays: settings?.autoArchiveInactiveThreadsDays ?? 0,
        };
      }

      const inactiveDays = settings.autoArchiveInactiveThreadsDays;
      const snapshot = yield* projectionSnapshotQuery
        .getShellSnapshot()
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("thread.auto-archive.snapshot-query-failed", { cause }).pipe(
              Effect.as(null),
            ),
          ),
        );
      if (snapshot === null) {
        return { archivedCount: 0, inactiveDays };
      }

      const nowMs = yield* Clock.currentTimeMillis;
      const candidates = selectAutoArchiveCandidates({
        threads: snapshot.threads,
        inactiveDays,
        nowMs,
      });
      let archivedCount = 0;

      for (const thread of candidates) {
        // `thread.archive` carries no timestamp: the decider stamps
        // `archivedAt` from its own clock when it accepts the command.
        const command = {
          type: "thread.archive" as const,
          commandId: CommandId.make(`thread-auto-archive:${thread.id}:${randomUUID()}`),
          threadId: thread.id,
        };
        const archived = yield* orchestrationEngine.dispatch(command).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("thread.auto-archive.dispatch-failed", {
              threadId: thread.id,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (archived) {
          archivedCount += 1;
        }
      }

      if (archivedCount > 0) {
        yield* Effect.logInfo("thread.auto-archive.sweep-complete", {
          archivedCount,
          inactiveDays,
        });
      }

      return { archivedCount, inactiveDays };
    });

    const sweep = sweepSemaphore.withPermits(1)(runSweep);

    const sweepNow: ThreadAutoArchiveSweeperShape["sweepNow"] = () =>
      sweep.pipe(Effect.map(({ archivedCount }) => archivedCount));

    const start: ThreadAutoArchiveSweeperShape["start"] = () =>
      Effect.gen(function* () {
        const initialSettings = yield* serverSettings.getSettings.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("thread.auto-archive.settings-read-failed", { cause }).pipe(
              Effect.as(null),
            ),
          ),
        );
        if (initialSettings !== null) {
          yield* Ref.set(
            lastObservedInactiveDaysRef,
            initialSettings.autoArchiveInactiveThreadsDays,
          );
        }

        yield* Effect.forkScoped(
          sweep.pipe(Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs)))),
        );
        yield* Effect.forkScoped(
          Stream.runForEach(serverSettings.streamChanges, (settings) =>
            Effect.gen(function* () {
              const changed = yield* Ref.modify(lastObservedInactiveDaysRef, (previous) => [
                previous !== settings.autoArchiveInactiveThreadsDays,
                settings.autoArchiveInactiveThreadsDays,
              ]);
              if (changed) {
                yield* sweep;
              }
            }),
          ),
        );

        yield* Effect.logInfo("thread.auto-archive.started", {
          sweepIntervalMs,
        });
      });

    return {
      start,
      sweepNow,
    } satisfies ThreadAutoArchiveSweeperShape;
  });

export const makeThreadAutoArchiveSweeperLive = (options?: ThreadAutoArchiveSweeperLiveOptions) =>
  Layer.effect(ThreadAutoArchiveSweeper, makeThreadAutoArchiveSweeper(options));

export const ThreadAutoArchiveSweeperLive = makeThreadAutoArchiveSweeperLive();
