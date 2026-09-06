import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("051_ProjectionThreadsBlockingUserInput", (it) => {
  it.effect("backfills mixed open questions without reviving resolved or stale requests", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, pending_user_input_count
        ) VALUES (
          'thread-1', 'project-1', 'Questions', '{"instanceId":"codex","model":"gpt-5-codex"}',
          'full-access', 'default', '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z', 3
        )
      `;
      const activities = [
        { kind: "user-input.requested", payload: { requestId: "legacy" } },
        { kind: "user-input.requested", payload: { requestId: "blocking", isBlocking: true } },
        { kind: "user-input.requested", payload: { requestId: "async", isBlocking: false } },
        { kind: "user-input.requested", payload: { requestId: "resolved" } },
        { kind: "user-input.requested", payload: { requestId: "stale" } },
        { kind: "user-input.resolved", payload: { requestId: "resolved" } },
        {
          kind: "provider.user-input.respond.failed",
          payload: { requestId: "stale", detail: "Unknown pending user-input request" },
        },
        {
          kind: "provider.user-input.respond.failed",
          payload: { requestId: "legacy", detail: "Temporary connection failure" },
        },
      ];
      for (const [index, activity] of activities.entries()) {
        // Sequence is authoritative even when delayed events have older
        // timestamps and their IDs sort before the original request.
        const reverseIndex = activities.length - index;
        const createdAt = new Date(Date.UTC(2026, 8, 5, 0, 0, reverseIndex)).toISOString();
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, tone, kind, summary, payload_json, sequence, created_at
          ) VALUES (
            ${`activity-${reverseIndex}`}, 'thread-1', 'info', ${activity.kind}, 'Question',
            ${JSON.stringify(activity.payload)}, ${index}, ${createdAt}
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 51 });
      const rows = yield* sql`
        SELECT pending_user_input_count, blocking_user_input_count
        FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(rows, [{ pending_user_input_count: 3, blocking_user_input_count: 2 }]);
    }),
  );
});
