import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Agent invites (docs/design/rooms-agent-invites.md).
 *
 * - `projection_thread_messages.invite` (JSON): an invite request's reason,
 *   suggestion, billing, and once decided, the choice and whether it was
 *   made without asking.
 *
 * Nullable with no default, so no row is rewritten. The invite pause lives in
 * `projection_threads.agent_requests`, whose JSON decodes without it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('projection_thread_messages')`;
  if (!columns.some((entry) => entry.name === "invite")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN invite TEXT`;
  }
});
