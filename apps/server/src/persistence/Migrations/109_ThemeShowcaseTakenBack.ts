import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Whether a share that wasn't added was taken back by the person who shared
 * it (docs/design/custom-themes.md, "Showcase"): `taken_back` on
 * `theme_showcase_submissions`, null until the pull request's close has been
 * looked at, so shares from before this are looked at once.
 *
 * A new column only; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE theme_showcase_submissions ADD COLUMN taken_back INTEGER`;
});
