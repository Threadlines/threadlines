import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  // The inbox's Active/Wrapped split used to live in each browser's
  // localStorage, so a phone and a desktop disagreed about it. Existing rows
  // stay NULL, which reads as "the user never filed this thread" and "never
  // seen" -- the same starting point a device with empty storage had.
  if (!columns.some((column) => column.name === "done_override")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN done_override TEXT
    `;
  }
  if (!columns.some((column) => column.name === "done_override_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN done_override_at TEXT
    `;
  }
  if (!columns.some((column) => column.name === "last_seen_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN last_seen_at TEXT
    `;
  }
});
