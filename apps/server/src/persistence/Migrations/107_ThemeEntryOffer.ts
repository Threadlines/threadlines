import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The chat offer each library entry was kept from (`theme_entries.offer_key`,
 * "<thread>/<page>", themeOfferKey), so keeping a later version of that offer
 * updates the entry instead of adding a copy. It belongs to the entry, not to
 * the content: two offers can make identical content, stored once.
 *
 * Nothing is backfilled. Content is shared, so its manifest can't say which
 * entry an offer belongs to, and a wrong offer would let an update overwrite
 * an unrelated theme; an entry without one just adds a copy when kept again.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE theme_entries ADD COLUMN offer_key TEXT`;
});
