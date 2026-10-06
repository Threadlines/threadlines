import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Who runs each child agent (see OrchestrationSubagent):
 *
 * - `agent_provider`: the provider its launcher named, when that is not the
 *   launching session's own.
 * - `session_provider`, `session_provider_instance_id`: the provider and
 *   instance of the session that reported it.
 *
 * All NULL on agents recorded before this was tracked: those ran on their
 * thread's provider, which is what readers fall back to.
 *
 * The one case that fallback gets wrong is a `codex exec` run a Claude session
 * launched, so those rows are filled in here. Only such a run was ever given
 * an agent id with the `codex-exec:` prefix, which makes the match exact. The
 * agent id is what is matched because the transcript id does not keep the
 * prefix: the task stream relinks it to Claude's task id. A run whose rollout
 * was never found has no such id and stays NULL.
 *
 * The update reads the roster table once (one row per agent a thread ever
 * spawned, not per event) and rewrites only the matching rows. Timed on a
 * 2.9 GB install with 597k events and 132 roster rows: about 10 ms.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const existing = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('projection_thread_subagents')`;
  for (const column of ["agent_provider", "session_provider", "session_provider_instance_id"]) {
    if (!existing.some((entry) => entry.name === column)) {
      yield* sql.unsafe(`ALTER TABLE projection_thread_subagents ADD COLUMN ${column} TEXT`);
    }
  }

  yield* sql`
    UPDATE projection_thread_subagents
    SET agent_provider = 'codex'
    WHERE agent_provider IS NULL AND agent_thread_id LIKE 'codex-exec:%'
  `;
});
