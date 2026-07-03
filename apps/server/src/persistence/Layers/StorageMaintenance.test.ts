import { MAX_THREAD_ACTIVITIES } from "@threadlines/shared/threadLimits";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { StorageMaintenance } from "../Services/StorageMaintenance.ts";
import { StorageMaintenanceLive } from "./StorageMaintenance.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(StorageMaintenanceLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const NOW_ISO = "2026-07-03T00:00:00.000Z";

function insertEvent(
  sql: SqlClient.SqlClient,
  input: {
    readonly sequence: number;
    readonly streamId: string;
    readonly eventType: string;
  },
) {
  return sql`
    INSERT INTO orchestration_events (
      sequence, event_id, aggregate_kind, stream_id, stream_version,
      event_type, occurred_at, command_id, causation_event_id,
      correlation_id, actor_kind, payload_json, metadata_json
    )
    VALUES (
      ${input.sequence}, ${`evt-${input.sequence}`}, 'thread', ${input.streamId},
      ${input.sequence}, ${input.eventType}, ${NOW_ISO}, NULL, NULL, NULL,
      'provider', '{}', '{}'
    )
  `;
}

function insertReceipt(
  sql: SqlClient.SqlClient,
  input: { readonly commandId: string; readonly acceptedAt: string },
) {
  return sql`
    INSERT INTO orchestration_command_receipts (
      command_id, aggregate_kind, aggregate_id, accepted_at,
      result_sequence, status, error
    )
    VALUES (${input.commandId}, 'thread', 'thread-x', ${input.acceptedAt}, 1, 'accepted', NULL)
  `;
}

function setProjectorCheckpoint(sql: SqlClient.SqlClient, lastAppliedSequence: number) {
  return sql`
    INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
    VALUES ('test-projector', ${lastAppliedSequence}, ${NOW_ISO})
    ON CONFLICT (projector)
    DO UPDATE SET last_applied_sequence = excluded.last_applied_sequence
  `;
}

const countEvents = (sql: SqlClient.SqlClient, streamId: string) =>
  sql<{ readonly count: number }>`
    SELECT COUNT(*) AS "count" FROM orchestration_events WHERE stream_id = ${streamId}
  `.pipe(Effect.map((rows) => rows[0]?.count ?? -1));

layer("StorageMaintenance", (it) => {
  it.effect("prunes command receipts past the TTL and keeps fresh ones", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storageMaintenance = yield* StorageMaintenance;

      // Offsets are computed from the same clock the implementation reads,
      // so the test holds under both the test clock and the wall clock.
      const nowMillis = yield* Clock.currentTimeMillis;
      const isoAt = (offsetMillis: number) =>
        DateTime.formatIso(DateTime.makeUnsafe(nowMillis + offsetMillis));
      const thirtyDaysAgoIso = isoAt(-30 * 24 * 60 * 60 * 1000);
      const oneMinuteAgoIso = isoAt(-60_000);

      yield* insertReceipt(sql, { commandId: "cmd-old-1", acceptedAt: thirtyDaysAgoIso });
      yield* insertReceipt(sql, { commandId: "cmd-old-2", acceptedAt: thirtyDaysAgoIso });
      yield* insertReceipt(sql, { commandId: "cmd-fresh", acceptedAt: oneMinuteAgoIso });

      const report = yield* storageMaintenance.runOnce;

      assert.equal(report.deletedReceipts, 2);
      const remaining = yield* sql<{ readonly commandId: string }>`
        SELECT command_id AS "commandId" FROM orchestration_command_receipts
      `;
      assert.deepStrictEqual(
        remaining.map((row) => row.commandId),
        ["cmd-fresh"],
      );
    }),
  );

  it.effect("prunes fully projected events of deleted threads but keeps the tombstone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storageMaintenance = yield* StorageMaintenance;

      // thread-gone: created + activities + deleted, all below the checkpoint.
      yield* insertEvent(sql, {
        sequence: 100,
        streamId: "thread-gone",
        eventType: "thread.created",
      });
      yield* insertEvent(sql, {
        sequence: 101,
        streamId: "thread-gone",
        eventType: "thread.activity-appended",
      });
      yield* insertEvent(sql, {
        sequence: 102,
        streamId: "thread-gone",
        eventType: "thread.message-sent",
      });
      yield* insertEvent(sql, {
        sequence: 103,
        streamId: "thread-gone",
        eventType: "thread.deleted",
      });
      // thread-alive: must stay untouched.
      yield* insertEvent(sql, {
        sequence: 110,
        streamId: "thread-alive",
        eventType: "thread.created",
      });
      yield* sql`
        INSERT INTO checkpoint_diff_blobs (thread_id, from_turn_count, to_turn_count, diff, created_at)
        VALUES ('thread-gone', 0, 1, 'diff', ${NOW_ISO})
      `;
      yield* setProjectorCheckpoint(sql, 200);

      const report = yield* storageMaintenance.runOnce;

      assert.equal(report.deletedThreadEvents, 3);
      assert.equal(report.deletedDiffBlobs, 1);
      assert.equal(yield* countEvents(sql, "thread-gone"), 1);
      const tombstone = yield* sql<{ readonly eventType: string }>`
        SELECT event_type AS "eventType" FROM orchestration_events WHERE stream_id = 'thread-gone'
      `;
      assert.equal(tombstone[0]?.eventType, "thread.deleted");
      assert.equal(yield* countEvents(sql, "thread-alive"), 1);
    }),
  );

  it.effect("does not prune a deleted thread whose deletion is not fully projected", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storageMaintenance = yield* StorageMaintenance;

      yield* insertEvent(sql, {
        sequence: 300,
        streamId: "thread-lagging",
        eventType: "thread.created",
      });
      yield* insertEvent(sql, {
        sequence: 301,
        streamId: "thread-lagging",
        eventType: "thread.deleted",
      });
      // Checkpoint sits before the deletion event: a projector has not
      // applied it yet, so nothing may be pruned.
      yield* setProjectorCheckpoint(sql, 300);

      const report = yield* storageMaintenance.runOnce;

      assert.equal(report.deletedThreadEvents, 0);
      assert.equal(yield* countEvents(sql, "thread-lagging"), 2);
    }),
  );

  it.effect("trims activity events beyond the per-thread projection cap", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storageMaintenance = yield* StorageMaintenance;

      const base = 10_000;
      const excess = 25;
      const total = MAX_THREAD_ACTIVITIES + excess;
      yield* insertEvent(sql, {
        sequence: base - 1,
        streamId: "thread-busy",
        eventType: "thread.created",
      });
      for (let index = 0; index < total; index += 1) {
        yield* insertEvent(sql, {
          sequence: base + index,
          streamId: "thread-busy",
          eventType: "thread.activity-appended",
        });
      }
      yield* setProjectorCheckpoint(sql, base + total + 10);

      const report = yield* storageMaintenance.runOnce;

      assert.equal(report.deletedActivityEvents, excess);
      const remainingActivities = yield* sql<{ readonly count: number; readonly oldest: number }>`
        SELECT COUNT(*) AS "count", MIN(sequence) AS "oldest"
        FROM orchestration_events
        WHERE stream_id = 'thread-busy' AND event_type = 'thread.activity-appended'
      `;
      assert.equal(remainingActivities[0]?.count, MAX_THREAD_ACTIVITIES);
      // The oldest surviving activity is exactly the cap-th newest.
      assert.equal(remainingActivities[0]?.oldest, base + excess);
      // Non-activity events for the thread are untouched.
      assert.equal(yield* countEvents(sql, "thread-busy"), MAX_THREAD_ACTIVITIES + 1);
    }),
  );

  it.effect("caps activity pruning at the projector checkpoint", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storageMaintenance = yield* StorageMaintenance;

      const base = 50_000;
      const excess = 30;
      const total = MAX_THREAD_ACTIVITIES + excess;
      for (let index = 0; index < total; index += 1) {
        yield* insertEvent(sql, {
          sequence: base + index,
          streamId: "thread-partial",
          eventType: "thread.activity-appended",
        });
      }
      // Checkpoint splits the prunable range: only the first 10 excess
      // events are fully projected.
      yield* setProjectorCheckpoint(sql, base + 9);

      const report = yield* storageMaintenance.runOnce;

      assert.equal(report.deletedActivityEvents, 10);
    }),
  );
});
