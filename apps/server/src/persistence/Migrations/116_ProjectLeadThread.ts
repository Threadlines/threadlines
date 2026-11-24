import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A project's lead chat (`OrchestrationProject.leadThreadId`,
 * docs/design/lead-chat.md): `lead_thread_id` on `projection_projects`, null
 * for every project before. Events rebuild it, like the project's other
 * fields.
 *
 * A new nullable column; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN lead_thread_id TEXT`;
});
