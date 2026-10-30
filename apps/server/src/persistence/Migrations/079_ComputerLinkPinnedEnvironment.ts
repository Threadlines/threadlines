import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Computer links know who they are for (docs/design/fleet.md, "Links RPC for
 * clients").
 *
 * - `relay_invites.joiner_environment_id`: the computer a link invite was
 *   made for, as the app that asked for it named it.
 * - `relay_devices.link_environment_pinned`: 1 when `link_environment_id`
 *   came from that invite (fixed for good), 0 when it is only what the
 *   linked computer said about itself.
 *
 * Nullable or defaulted columns only; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const inviteColumns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('relay_invites')`;
  if (!inviteColumns.some((entry) => entry.name === "joiner_environment_id")) {
    yield* sql`ALTER TABLE relay_invites ADD COLUMN joiner_environment_id TEXT`;
  }

  const deviceColumns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('relay_devices')`;
  if (!deviceColumns.some((entry) => entry.name === "link_environment_pinned")) {
    yield* sql`
      ALTER TABLE relay_devices ADD COLUMN link_environment_pinned INTEGER NOT NULL DEFAULT 0
    `;
  }
});
