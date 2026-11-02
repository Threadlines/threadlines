import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * MCP Events subscriptions (docs/design/assistants.md, "Build plan: step 5"):
 * an assistant that subscribes gets a target of kind `subscription`. New
 * nullable or defaulted columns; no row is rewritten.
 *
 * - `assistant_targets.subscription_id`: the id the subscriber is given
 *   (`sub_…`), derived from its connection, callback, event and arguments;
 *   unique among subscriptions.
 * - `assistant_targets.arguments_json`: the arguments as sent, canonical
 *   JSON; the id comes from them, the project filter from resolving them.
 * - `assistant_targets.signing_secret`: the secret store entry holding the
 *   subscriber's `whsec_` key. Null for addresses the user added, whose key
 *   has a fixed entry. `previous_signing_secret` and `previous_signing_until`:
 *   the key a refresh replaced, still signing alongside until then.
 * - `assistant_event_state.began_at_seq`: the record's last `seq` when it last
 *   turned on; a cursor from before it may have missed what happened while
 *   the record was off.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const targetColumns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('assistant_targets')`;
  const has = (name: string) => targetColumns.some((entry) => entry.name === name);
  if (!has("subscription_id")) {
    yield* sql`ALTER TABLE assistant_targets ADD COLUMN subscription_id TEXT`;
  }
  if (!has("arguments_json")) {
    yield* sql`ALTER TABLE assistant_targets ADD COLUMN arguments_json TEXT`;
  }
  if (!has("signing_secret")) {
    yield* sql`ALTER TABLE assistant_targets ADD COLUMN signing_secret TEXT`;
  }
  if (!has("previous_signing_secret")) {
    yield* sql`ALTER TABLE assistant_targets ADD COLUMN previous_signing_secret TEXT`;
  }
  if (!has("previous_signing_until")) {
    yield* sql`ALTER TABLE assistant_targets ADD COLUMN previous_signing_until TEXT`;
  }
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS assistant_targets_subscription
    ON assistant_targets (subscription_id)
    WHERE subscription_id IS NOT NULL
  `;
  const stateColumns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('assistant_event_state')`;
  if (!stateColumns.some((entry) => entry.name === "began_at_seq")) {
    yield* sql`ALTER TABLE assistant_event_state ADD COLUMN began_at_seq INTEGER NOT NULL DEFAULT 0`;
  }
});
