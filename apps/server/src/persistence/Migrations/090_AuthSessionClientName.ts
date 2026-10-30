import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * `auth_sessions.client_name`: the name the computer's user gave a device's
 * sign-in, shown instead of `client_label` (what the device called itself).
 * Null until renamed. A new column only: no existing row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;
  if (!sessionColumns.some((column) => column.name === "client_name")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN client_name TEXT
    `;
  }
});
