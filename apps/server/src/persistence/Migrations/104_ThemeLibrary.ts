import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The theme library (docs/design/custom-themes.md, "Storage and devices").
 *
 * - `theme_entries`: what the user names, keeps and deletes. `entry_id` is a
 *   UUID minted once and the same on every computer the entry reaches;
 *   `revision` and `revised_by` order every change (the higher pair wins
 *   everywhere); `deleted` marks a tombstone, kept so computers converge.
 * - `theme_contents`: each theme's content, stored once per hash and never
 *   changed. Two entries may share one (Duplicate). The summary columns
 *   (`base` to `backdrop_mode`) let the library list entries without
 *   parsing the manifest; `thumbnail` is a small PNG data URL for themes
 *   with art, filled in after the content is stored.
 *
 * New tables only; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS theme_contents (
      hash TEXT PRIMARY KEY,
      manifest_json TEXT NOT NULL,
      base TEXT NOT NULL,
      background TEXT NOT NULL,
      foreground TEXT NOT NULL,
      accent TEXT NOT NULL,
      backdrop_mode TEXT,
      thumbnail TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS theme_entries (
      entry_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      hash TEXT NOT NULL,
      revision INTEGER NOT NULL,
      revised_by TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
