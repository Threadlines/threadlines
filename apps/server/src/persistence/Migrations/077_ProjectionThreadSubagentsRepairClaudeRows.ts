import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Repairs two things the roster fold used to get wrong for Claude agents.
 *
 * The transcript link. Claude names an agent's later runs by its task id, and
 * the fold replaced that link with the spawn call id whenever the agent's
 * Agent tool row updated (a forwarded message, say). An agent resumed after
 * that matched no row: the Agents panel showed it stopped while the thread
 * waited on it. The spawn's own task start still names the task, so each row
 * whose link is its spawn call id takes the task id from that start. A row
 * with no such start left (an adapter that predates the task stream) keeps
 * what it has.
 *
 * The model. A message the CLI wrote itself (an API error) carries the
 * placeholder model `<synthetic>`, and the fold took it for the agent's. Such
 * a row takes the last real model the agent's messages named, or none.
 *
 * Statuses are left alone: this runs at server start, after every provider
 * process (and every agent in it) ended, so no row can be running.
 *
 * The json_valid guards matter: json_extract raises on malformed JSON, and one
 * corrupt row must not abort the migration. Only the affected rows are
 * visited, each through the thread's activity index. Timed on a 4 GB install
 * with 821k activities and 202 roster rows (15 links affected, 14 relinked;
 * one placeholder model): 0.04 s on a fresh copy; the same link lookups read
 * from the live file took 2.1 s, nearly all of it disk reads.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE projection_thread_subagents
    SET transcript_agent_id = COALESCE(
      (
        SELECT json_extract(activity.payload_json, '$.taskId')
        FROM projection_thread_activities AS activity
        WHERE activity.thread_id = projection_thread_subagents.thread_id
          AND activity.kind = 'task.started'
          AND json_valid(activity.payload_json)
          AND json_extract(activity.payload_json, '$.toolUseId') =
            projection_thread_subagents.spawn_call_id
          AND json_extract(activity.payload_json, '$.taskId') IS NOT NULL
        ORDER BY activity.event_sequence, activity.sequence, activity.created_at
        LIMIT 1
      ),
      transcript_agent_id
    )
    WHERE spawn_call_id IS NOT NULL
      AND transcript_agent_id = spawn_call_id
  `;
  yield* sql`
    UPDATE projection_thread_subagents
    SET resolved_model = (
      SELECT json_extract(activity.payload_json, '$.data.subagentModel')
      FROM projection_thread_activities AS activity
      WHERE activity.thread_id = projection_thread_subagents.thread_id
        AND activity.kind IN ('tool.started', 'tool.updated', 'tool.completed')
        AND json_valid(activity.payload_json)
        AND json_extract(activity.payload_json, '$.toolCallId') =
          projection_thread_subagents.spawn_call_id
        AND json_extract(activity.payload_json, '$.data.subagentModel') IS NOT NULL
        AND json_extract(activity.payload_json, '$.data.subagentModel') <> '<synthetic>'
      ORDER BY activity.event_sequence DESC, activity.sequence DESC, activity.created_at DESC
      LIMIT 1
    )
    WHERE resolved_model = '<synthetic>'
  `;
});
