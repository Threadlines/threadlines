import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_subagents (
      thread_id TEXT NOT NULL,
      subagent_id TEXT NOT NULL,
      agent_thread_id TEXT,
      parent_agent_thread_id TEXT,
      spawn_call_id TEXT,
      transcript_agent_id TEXT,
      turn_id TEXT,
      agent_path TEXT,
      parent_agent_path TEXT,
      tree_depth INTEGER NOT NULL DEFAULT 0,
      nickname TEXT,
      role TEXT,
      objective TEXT,
      status TEXT NOT NULL,
      requested_model TEXT,
      resolved_model TEXT,
      reasoning_effort TEXT,
      model_provenance TEXT,
      reasoning_effort_provenance TEXT,
      result_body TEXT,
      result_created_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, subagent_id)
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_thread_subagents_agent
    ON projection_thread_subagents(thread_id, agent_thread_id)
    WHERE agent_thread_id IS NOT NULL
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_thread_subagents_spawn
    ON projection_thread_subagents(thread_id, spawn_call_id)
    WHERE spawn_call_id IS NOT NULL
  `;

  // Backfill the durable identity fields from the uncapped activity projection.
  // Rich effective settings are filled by new semantic metadata activities.
  yield* sql`
    WITH collab AS (
      SELECT
        thread_id,
        turn_id,
        json_extract(payload_json, '$.data.item.agentThreadId') AS agent_thread_id,
        CASE
          WHEN json_extract(payload_json, '$.data.item.tool') = 'spawnAgent'
          THEN json_extract(payload_json, '$.data.item.id')
          ELSE NULL
        END AS spawn_call_id,
        json_extract(payload_json, '$.data.item.agentPath') AS agent_path,
        COALESCE(
          json_extract(payload_json, '$.data.item.agentNickname'),
          json_extract(payload_json, '$.data.item.agent_nickname'),
          json_extract(payload_json, '$.data.item.nickname')
        ) AS nickname,
        COALESCE(
          json_extract(payload_json, '$.data.item.agentRole'),
          json_extract(payload_json, '$.data.item.role')
        ) AS role,
        json_extract(payload_json, '$.data.item.prompt') AS objective,
        json_extract(payload_json, '$.data.item.model') AS requested_model,
        json_extract(payload_json, '$.data.item.resolvedModel') AS resolved_model,
        json_extract(payload_json, '$.data.item.reasoningEffort') AS reasoning_effort,
        json_extract(payload_json, '$.data.item.kind') AS native_kind,
        created_at
      FROM projection_thread_activities
      WHERE json_extract(payload_json, '$.itemType') = 'collab_agent_tool_call'
        AND json_extract(payload_json, '$.data.item.agentThreadId') IS NOT NULL
    ), grouped AS (
      SELECT
        thread_id,
        agent_thread_id,
        MIN(turn_id) AS turn_id,
        MIN(spawn_call_id) AS spawn_call_id,
        MAX(agent_path) AS agent_path,
        MAX(nickname) AS nickname,
        MAX(role) AS role,
        MAX(objective) AS objective,
        MAX(requested_model) AS requested_model,
        MAX(resolved_model) AS resolved_model,
        MAX(reasoning_effort) AS reasoning_effort,
        MAX(CASE WHEN native_kind = 'interrupted' THEN 1 ELSE 0 END) AS interrupted,
        MAX(CASE WHEN native_kind = 'completed' THEN 1 ELSE 0 END) AS completed,
        MIN(created_at) AS created_at,
        MAX(created_at) AS updated_at
      FROM collab
      GROUP BY thread_id, agent_thread_id
    )
    INSERT OR IGNORE INTO projection_thread_subagents (
      thread_id, subagent_id, agent_thread_id, parent_agent_thread_id, spawn_call_id, transcript_agent_id,
      turn_id, agent_path, parent_agent_path, tree_depth, nickname, role, objective,
      status, requested_model, resolved_model, reasoning_effort, model_provenance,
      reasoning_effort_provenance, result_body, result_created_at, created_at, updated_at
    )
    SELECT
      thread_id, agent_thread_id, agent_thread_id, NULL, spawn_call_id, agent_thread_id,
      turn_id, agent_path, NULL,
      MAX(0, (LENGTH(agent_path) - LENGTH(REPLACE(agent_path, '/', ''))) - 2),
      nickname, role, objective,
      CASE
        WHEN interrupted > 0 THEN 'interrupted'
        WHEN completed > 0 THEN 'completed'
        ELSE 'running'
      END,
      requested_model, resolved_model, reasoning_effort,
      CASE WHEN requested_model IS NOT NULL THEN 'explicit' ELSE NULL END,
      CASE WHEN reasoning_effort IS NOT NULL THEN 'explicit' ELSE NULL END,
      NULL, NULL, created_at, updated_at
    FROM grouped
  `;
});
