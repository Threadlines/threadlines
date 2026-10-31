import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The Work level for outside agents (docs/design/assistants.md, "Build plan:
 * step 3"). New nullable or defaulted columns and a trigger; no row is
 * rewritten.
 *
 * - `projection_threads.outside_work_json`: the agents outside text reached
 *   whose Threadlines tools are limited (OrchestrationOutsideWork). Null: none.
 * - `outside_agent_connections.work_level`: 1 when the user granted Work. The
 *   `access` column keeps `start` for such a connection, so an older build,
 *   which knows only `see` and `start`, reads it as Start and never fails to
 *   decode it.
 * - `outside_agent_connections.grant_writes`: bumped by every grant change
 *   this build and later make. The trigger clears `work_level` when the grant
 *   changes without it, which only an older build does: Change there (to See
 *   and back to Start, say) can't bring Work back after an upgrade.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('projection_threads')`;
  if (!threadColumns.some((entry) => entry.name === "outside_work_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN outside_work_json TEXT`;
  }

  const connectionColumns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('outside_agent_connections')`;
  const has = (name: string) => connectionColumns.some((entry) => entry.name === name);
  if (!has("work_level")) {
    yield* sql`ALTER TABLE outside_agent_connections ADD COLUMN work_level INTEGER NOT NULL DEFAULT 0`;
  }
  if (!has("grant_writes")) {
    yield* sql`ALTER TABLE outside_agent_connections ADD COLUMN grant_writes INTEGER NOT NULL DEFAULT 0`;
  }

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS outside_agent_connections_work_needs_new_build
    AFTER UPDATE OF access, max_runtime_mode, project_ids_json ON outside_agent_connections
    WHEN NEW.grant_writes IS OLD.grant_writes AND NEW.work_level <> 0
    BEGIN
      UPDATE outside_agent_connections SET work_level = 0
      WHERE connection_id = NEW.connection_id;
    END
  `;
});
