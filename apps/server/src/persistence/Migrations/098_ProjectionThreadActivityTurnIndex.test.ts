import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("098_ProjectionThreadActivityTurnIndex", (it) => {
  it.effect("serves one turn's activities in order from the turn index, not a thread scan", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 98 });

      // The shape of ProjectionSnapshotQuery's listThreadActivityRowsByTurn.
      const plan = yield* sql
        .unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN
          SELECT * FROM projection_thread_activities
          WHERE thread_id = 'thread-1' AND turn_id = 'turn-1'
          ORDER BY event_sequence ASC, sequence ASC, created_at ASC, activity_id ASC`,
        )
        .pipe(Effect.map((rows) => rows.map((row) => row.detail).join("\n")));

      assert.include(plan, "idx_projection_thread_activities_turn (thread_id=? AND turn_id=?)");
      assert.notInclude(plan, "TEMP B-TREE");
    }),
  );
});
