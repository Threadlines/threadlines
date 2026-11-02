import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Two controls over phone alerts (docs/design/push-alerts.md). New columns
 * with constant defaults; no row is rewritten.
 *
 * - `push_registrations.quiet_at_computer`: the phone's own switch, to stay
 *   quiet while someone uses Threadlines on a computer. On unless it said so.
 * - `projection_projects.phone_alerts_muted`: this project's threads send no
 *   phone alerts. Events rebuild it, like the project's other fields.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const registrationColumns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('push_registrations')`;
  if (!registrationColumns.some((entry) => entry.name === "quiet_at_computer")) {
    yield* sql`
      ALTER TABLE push_registrations ADD COLUMN quiet_at_computer INTEGER NOT NULL DEFAULT 1
    `;
  }
  const projectColumns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('projection_projects')`;
  if (!projectColumns.some((entry) => entry.name === "phone_alerts_muted")) {
    yield* sql`
      ALTER TABLE projection_projects ADD COLUMN phone_alerts_muted INTEGER NOT NULL DEFAULT 0
    `;
  }
});
