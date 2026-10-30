import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("070_ProjectionThreadActivityKindIndexes", (it) => {
  it.effect("serves prompt and plan lookups from partial indexes, not a thread scan", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 70 });

      const planFor = (query: string) =>
        sql
          .unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
          .pipe(Effect.map((rows) => rows.map((row) => row.detail).join("\n")));

      // The literal kind list both the thread snapshot and the shell summary
      // query with; a partial index is only usable when it matches exactly.
      const promptPlan = yield* planFor(`
        SELECT * FROM projection_thread_activities
        WHERE thread_id = 'thread-1'
          AND kind IN (
            'approval.requested', 'approval.resolved', 'provider.approval.respond.failed',
            'user-input.requested', 'user-input.resolved', 'provider.user-input.respond.failed'
          )
      `);
      assert.include(promptPlan, "idx_projection_thread_activities_prompt_kinds");

      const planUpdatePlan = yield* planFor(`
        SELECT * FROM projection_thread_activities
        WHERE thread_id = 'thread-1' AND kind = 'turn.plan.updated'
        ORDER BY event_sequence DESC, sequence DESC, created_at DESC, activity_id DESC
        LIMIT 1
      `);
      assert.include(planUpdatePlan, "idx_projection_thread_activities_plan_updates");
    }),
  );
});
