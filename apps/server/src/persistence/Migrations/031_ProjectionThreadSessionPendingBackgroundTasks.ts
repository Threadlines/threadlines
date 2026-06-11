import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!columns.some((column) => column.name === "pending_background_task_count")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN pending_background_task_count INTEGER NOT NULL DEFAULT 0
    `;
  }
});
