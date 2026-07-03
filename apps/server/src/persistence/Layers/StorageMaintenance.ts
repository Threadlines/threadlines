import { MAX_THREAD_ACTIVITIES } from "@threadlines/shared/threadLimits";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { toPersistenceSqlError, type PersistenceSqlError } from "../Errors.ts";
import { ProjectionStateRepository } from "../Services/ProjectionState.ts";
import { ProjectionStateRepositoryLive } from "./ProjectionState.ts";
import {
  StorageMaintenance,
  type StorageMaintenanceReport,
  type StorageMaintenanceShape,
} from "../Services/StorageMaintenance.ts";

/**
 * Receipts only guard command idempotency (client retries after reconnects,
 * provider redeliveries within a turn). Nothing legitimately re-dispatches a
 * command a week later, so anything older is dead weight.
 */
const RECEIPT_TTL = Duration.days(7);

/**
 * Rows deleted per statement. Each batch runs in its own short transaction
 * so the synchronous driver never blocks the event loop for long, even when
 * the first run on a long-lived database prunes hundreds of thousands of
 * rows.
 */
const DELETE_BATCH_SIZE = 5_000;

const INITIAL_DELAY = Duration.minutes(2);
const RUN_INTERVAL = Duration.hours(6);

const storageMaintenanceEnabled = () =>
  (process.env.THREADLINES_STORAGE_MAINTENANCE ?? "1") !== "0";

const makeStorageMaintenance = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectionStateRepository = yield* ProjectionStateRepository;

  /**
   * Runs one bounded DELETE and returns the affected row count. The delete
   * and the `changes()` read share a transaction so interleaved statements
   * from other fibers (the single connection is shared) cannot skew the
   * count.
   */
  const deleteBatch = (statement: Effect.Effect<unknown, SqlError>) =>
    sql.withTransaction(
      statement.pipe(
        Effect.flatMap(() => sql<{ readonly changes: number }>`SELECT changes() AS changes`),
        Effect.map((rows) => rows[0]?.changes ?? 0),
      ),
    );

  const deleteAllBatches = (makeStatement: () => Effect.Effect<unknown, SqlError>) =>
    Effect.gen(function* () {
      let total = 0;
      for (;;) {
        const deleted = yield* deleteBatch(makeStatement());
        total += deleted;
        if (deleted < DELETE_BATCH_SIZE) {
          return total;
        }
      }
    });

  const pruneExpiredReceipts = Effect.gen(function* () {
    const nowMillis = yield* Clock.currentTimeMillis;
    const cutoffIso = DateTime.formatIso(
      DateTime.makeUnsafe(nowMillis - Duration.toMillis(RECEIPT_TTL)),
    );
    return yield* deleteAllBatches(
      () => sql`
        DELETE FROM orchestration_command_receipts
        WHERE command_id IN (
          SELECT command_id
          FROM orchestration_command_receipts
          WHERE accepted_at < ${cutoffIso}
          LIMIT ${DELETE_BATCH_SIZE}
        )
      `,
    );
  });

  const readDeletedThreads = (minAppliedSequence: number) =>
    sql<{ readonly threadId: string; readonly deletedSequence: number }>`
      SELECT stream_id AS "threadId", sequence AS "deletedSequence"
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND event_type = 'thread.deleted'
        AND sequence <= ${minAppliedSequence}
    `;

  /**
   * Removes a deleted thread's events below its `thread.deleted` event. The
   * deletion event itself is kept as a tombstone so consumers replaying the
   * tail of the log still observe the removal.
   */
  const pruneDeletedThreadEvents = (minAppliedSequence: number) =>
    Effect.gen(function* () {
      const deletedThreads = yield* readDeletedThreads(minAppliedSequence);
      let deletedEvents = 0;
      let deletedDiffBlobs = 0;

      for (const thread of deletedThreads) {
        deletedEvents += yield* deleteAllBatches(
          () => sql`
            DELETE FROM orchestration_events
            WHERE sequence IN (
              SELECT sequence
              FROM orchestration_events
              WHERE aggregate_kind = 'thread'
                AND stream_id = ${thread.threadId}
                AND sequence < ${thread.deletedSequence}
              LIMIT ${DELETE_BATCH_SIZE}
            )
          `,
        );
        deletedDiffBlobs += yield* deleteBatch(
          sql`DELETE FROM checkpoint_diff_blobs WHERE thread_id = ${thread.threadId}`,
        );
      }

      return { deletedEvents, deletedDiffBlobs };
    });

  /**
   * Trims `thread.activity-appended` events to the newest
   * `MAX_THREAD_ACTIVITIES` per thread. The activity projection already
   * trims to the same cap, so pruned events are invisible to rebuilds.
   */
  const pruneActivityEventsBeyondCap = (minAppliedSequence: number) =>
    Effect.gen(function* () {
      const overCapThreads = yield* sql<{ readonly threadId: string }>`
        SELECT stream_id AS "threadId"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND event_type = 'thread.activity-appended'
        GROUP BY stream_id
        HAVING COUNT(*) > ${MAX_THREAD_ACTIVITIES}
      `;

      let deletedEvents = 0;
      for (const thread of overCapThreads) {
        const cutoffRows = yield* sql<{ readonly sequence: number }>`
          SELECT sequence
          FROM orchestration_events
          WHERE aggregate_kind = 'thread'
            AND stream_id = ${thread.threadId}
            AND event_type = 'thread.activity-appended'
          ORDER BY sequence DESC
          LIMIT 1 OFFSET ${MAX_THREAD_ACTIVITIES - 1}
        `;
        const cutoffSequence = cutoffRows[0]?.sequence;
        if (cutoffSequence === undefined) {
          continue;
        }

        deletedEvents += yield* deleteAllBatches(
          () => sql`
            DELETE FROM orchestration_events
            WHERE sequence IN (
              SELECT sequence
              FROM orchestration_events
              WHERE aggregate_kind = 'thread'
                AND stream_id = ${thread.threadId}
                AND event_type = 'thread.activity-appended'
                AND sequence < ${cutoffSequence}
                AND sequence <= ${minAppliedSequence}
              LIMIT ${DELETE_BATCH_SIZE}
            )
          `,
        );
      }
      return deletedEvents;
    });

  const readPageStats = Effect.gen(function* () {
    const freeRows = yield* sql<{ readonly pages: number }>`
      SELECT freelist_count AS "pages" FROM pragma_freelist_count
    `;
    const totalRows = yield* sql<{ readonly pages: number }>`
      SELECT page_count AS "pages" FROM pragma_page_count
    `;
    return {
      freePages: freeRows[0]?.pages ?? 0,
      totalPages: totalRows[0]?.pages ?? 0,
    };
  }).pipe(
    // Purely informational; a build without pragma table-valued functions
    // must not fail the maintenance pass.
    Effect.orElseSucceed(() => ({ freePages: 0, totalPages: 0 })),
  );

  const runOnce: StorageMaintenanceShape["runOnce"] = Effect.gen(function* () {
    const startedAtMillis = yield* Clock.currentTimeMillis;

    const deletedReceipts = yield* pruneExpiredReceipts;

    // Event pruning is gated on the slowest projector: everything at or
    // below this sequence is fully materialized everywhere.
    const minAppliedSequence = yield* projectionStateRepository.minLastAppliedSequence();
    let deletedThreadEvents = 0;
    let deletedActivityEvents = 0;
    let deletedDiffBlobs = 0;
    if (minAppliedSequence !== null) {
      const deletedThreadResult = yield* pruneDeletedThreadEvents(minAppliedSequence);
      deletedThreadEvents = deletedThreadResult.deletedEvents;
      deletedDiffBlobs = deletedThreadResult.deletedDiffBlobs;
      deletedActivityEvents = yield* pruneActivityEventsBeyondCap(minAppliedSequence);
    }

    const anythingDeleted =
      deletedReceipts + deletedThreadEvents + deletedActivityEvents + deletedDiffBlobs > 0;
    if (anythingDeleted) {
      // Fold the (potentially large) WAL back into the main file so a big
      // prune does not leave a WAL the same size as the pruned data.
      yield* sql`PRAGMA wal_checkpoint(TRUNCATE);`.pipe(Effect.ignore);
    }

    const pageStats = yield* readPageStats;
    const report: StorageMaintenanceReport = {
      deletedReceipts,
      deletedThreadEvents,
      deletedActivityEvents,
      deletedDiffBlobs,
      freePages: pageStats.freePages,
      totalPages: pageStats.totalPages,
      durationMillis: (yield* Clock.currentTimeMillis) - startedAtMillis,
    };

    if (anythingDeleted) {
      yield* Effect.logInfo("storage maintenance pruned rows").pipe(
        Effect.annotateLogs({ ...report }),
      );
    } else {
      yield* Effect.logDebug("storage maintenance found nothing to prune").pipe(
        Effect.annotateLogs({ durationMillis: report.durationMillis }),
      );
    }
    return report;
  }).pipe(
    Effect.catchTag("SqlError", (sqlError) =>
      Effect.fail(toPersistenceSqlError("StorageMaintenance.runOnce:query")(sqlError)),
    ),
  );

  return { runOnce } satisfies StorageMaintenanceShape;
});

export const StorageMaintenanceLive = Layer.effect(StorageMaintenance, makeStorageMaintenance).pipe(
  Layer.provide(ProjectionStateRepositoryLive),
);

const logMaintenanceFailure = (error: PersistenceSqlError) =>
  Effect.logWarning("storage maintenance run failed", { error });

/**
 * Periodic driver: one pass shortly after boot (delayed so it never
 * competes with startup), then every `RUN_INTERVAL`. Failures are logged
 * and the schedule keeps going. Disable with
 * `THREADLINES_STORAGE_MAINTENANCE=0`.
 */
export const StorageMaintenanceDaemonLive = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!storageMaintenanceEnabled()) {
      yield* Effect.logInfo("storage maintenance disabled via THREADLINES_STORAGE_MAINTENANCE=0");
      return;
    }
    const storageMaintenance = yield* StorageMaintenance;
    const scheduledRun = storageMaintenance.runOnce.pipe(
      Effect.asVoid,
      Effect.catchTag("PersistenceSqlError", logMaintenanceFailure),
    );

    yield* Effect.forkScoped(
      Effect.sleep(INITIAL_DELAY).pipe(
        Effect.andThen(
          Effect.forever(scheduledRun.pipe(Effect.andThen(Effect.sleep(RUN_INTERVAL)))),
        ),
      ),
    );
  }),
).pipe(Layer.provide(StorageMaintenanceLive));
