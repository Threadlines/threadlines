import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("runMigrations", (it) => {
  it.effect(
    "reads the file ahead once, before the first pending migration that reads whole tables",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // What each read-ahead found: whether migration 068's index existed yet.
        const reads: Array<boolean> = [];
        const readAhead = sql<{ readonly found: number }>`
          SELECT count(*) AS found FROM sqlite_master
          WHERE name = 'idx_orch_events_thread_maintenance'
        `.pipe(
          Effect.map(([row]) => {
            reads.push((row?.found ?? 0) > 0);
          }),
          Effect.orDie,
        );

        yield* runMigrations({ toMigrationInclusive: 50 });
        // 051 through 067 read no whole table.
        yield* runMigrations({ toMigrationInclusive: 67, readAhead });
        assert.deepStrictEqual(reads, []);

        // 068, 070 and 099 each read a whole table.
        yield* runMigrations({ readAhead });
        assert.deepStrictEqual(reads, [false]);

        // Nothing pending.
        yield* runMigrations({ readAhead });
        assert.deepStrictEqual(reads, [false]);
      }),
  );

  it.effect("drops redundant indexes in migration 126 while keeping active ordering indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'index'
      `;
      const names = new Set(indexes.map((row) => row.name));

      for (const dropped of [
        "idx_orch_events_command_id",
        "idx_orch_events_correlation_id",
        "idx_projection_thread_activities_thread_created",
        "idx_projection_thread_activities_thread_sequence",
        "idx_projection_thread_activities_thread_sequence_created_id",
        "idx_projection_thread_messages_thread_created",
      ]) {
        assert.isFalse(names.has(dropped), `expected ${dropped} to be dropped`);
      }

      for (const kept of [
        "idx_projection_thread_messages_thread_created_id",
        "idx_projection_thread_messages_event_order",
        "idx_projection_thread_activities_event_order",
        "idx_projection_thread_activities_prompt_kinds",
        "idx_projection_thread_activities_plan_updates",
        "idx_projection_thread_activities_turn",
      ]) {
        assert.isTrue(names.has(kept), `expected ${kept} to remain`);
      }

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT created_at AS "createdAt"
        FROM projection_thread_messages
        WHERE thread_id = 'thread-1'
          AND role = 'user'
          AND from_agent IS NULL
          AND from_thread IS NULL
          AND from_outside IS NULL
        ORDER BY created_at DESC
        LIMIT 1
      `;
      assert.isTrue(
        plan.some((row) => row.detail.includes("idx_projection_thread_messages_thread_created_id")),
        `expected query plan to use idx_projection_thread_messages_thread_created_id, got: ${plan.map((r) => r.detail).join("; ")}`,
      );
    }),
  );
});
