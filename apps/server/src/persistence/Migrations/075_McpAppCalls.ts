import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * `mcp_app_calls`: one row per MCP tool call whose tool ships an app
 * (docs/mcp-apps.md), so its card can show the call and reach the agent that
 * made it. Written by runtime ingestion, not projected from events: the call
 * can be large, and the event log keeps only the step. A new table, nothing
 * backfilled.
 *
 * - `call_json`: the call as the card's view gets it (server, tool, resource,
 *   arguments, result), capped in size.
 * - `view_json`: the view document, once a card has read it.
 * - `provider_thread_id`: the agent session's own id when it made the call;
 *   a call the same agent makes in another session needs the user's say-so.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS mcp_app_calls (
      thread_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      participant_id TEXT,
      provider_instance_id TEXT,
      provider_thread_id TEXT,
      call_json TEXT NOT NULL,
      view_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, tool_call_id)
    )
  `;
});
