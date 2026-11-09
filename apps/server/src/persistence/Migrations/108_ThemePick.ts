import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The shared theme pick ("Same theme on all my devices"): one row beside the
 * theme library, the theme as JSON (ThemePickTheme) with the revision order
 * computers merge it by. No row until someone picks a theme.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS theme_pick (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      theme_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      revised_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
