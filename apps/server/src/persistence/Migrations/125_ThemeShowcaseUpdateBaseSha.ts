import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * When a Showcase share updates an already-listed theme (docs/design/custom-themes.md,
 * "Showcase"): `update_base_sha` records the SHA-256 of the theme file on `main`
 * when the update started (null for shares that add a new theme), and
 * `published_file_sha` records the SHA-256 of the file this share writes.
 *
 * New columns only; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE theme_showcase_submissions ADD COLUMN update_base_sha TEXT`;
  yield* sql`ALTER TABLE theme_showcase_submissions ADD COLUMN published_file_sha TEXT`;
});
