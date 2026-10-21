import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("077_ProjectionThreadSubagentsRepairClaudeRows", (it) => {
  it.effect("relinks agents to their spawn's task and drops the CLI's placeholder model", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });
      const agents = [
        // A tool row overwrote the link with the spawn call, and an API error
        // message's placeholder replaced the model.
        { spawn: "toolu_overwritten", transcript: "toolu_overwritten", model: "<synthetic>" },
        // Linked properly: nothing to do.
        { spawn: "toolu_linked", transcript: "a-linked", model: "claude-opus-5-5" },
        // No task start or real model names it: keeps its link, loses the placeholder.
        { spawn: "toolu_unstarted", transcript: "toolu_unstarted", model: "<synthetic>" },
      ];
      for (const agent of agents) {
        yield* sql`
          INSERT INTO projection_thread_subagents (
            thread_id, subagent_id, agent_thread_id, spawn_call_id, transcript_agent_id,
            resolved_model, status, created_at, updated_at
          ) VALUES (
            'thread-1', ${agent.spawn}, ${agent.spawn}, ${agent.spawn}, ${agent.transcript},
            ${agent.model}, 'interrupted', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'
          )
        `;
      }
      const forwarded = (toolCallId: string, subagentModel: string) =>
        JSON.stringify({ itemType: "collab_agent_tool_call", toolCallId, data: { subagentModel } });
      const activities = [
        // Malformed rows must not abort the migration.
        { id: "e0", kind: "task.started", payload: "{not json" },
        { id: "e1", kind: "tool.updated", payload: "{not json" },
        {
          id: "e2",
          kind: "task.started",
          payload: JSON.stringify({ taskId: "a-overwritten", toolUseId: "toolu_overwritten" }),
        },
        // The same task resumed under another call names no spawn.
        {
          id: "e3",
          kind: "task.started",
          payload: JSON.stringify({ taskId: "a-overwritten", toolUseId: "toolu_resume" }),
        },
        {
          id: "e4",
          kind: "task.started",
          payload: JSON.stringify({ taskId: "a-other", toolUseId: "toolu_linked" }),
        },
        {
          id: "e5",
          kind: "tool.updated",
          payload: forwarded("toolu_overwritten", "claude-opus-5"),
        },
        {
          id: "e6",
          kind: "tool.updated",
          payload: forwarded("toolu_overwritten", "claude-opus-5-5"),
        },
        { id: "e7", kind: "tool.updated", payload: forwarded("toolu_overwritten", "<synthetic>") },
        { id: "e8", kind: "tool.updated", payload: forwarded("toolu_unstarted", "<synthetic>") },
      ];
      for (const [sequence, activity] of activities.entries()) {
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at,
            sequence, event_sequence
          ) VALUES (
            ${activity.id}, 'thread-1', NULL, 'tool', ${activity.kind}, 'Activity',
            ${activity.payload}, '2026-10-21T00:00:00.000Z', ${sequence}, ${sequence}
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 77 });

      const migrated = yield* sql`
        SELECT subagent_id, transcript_agent_id, resolved_model
        FROM projection_thread_subagents ORDER BY subagent_id
      `;
      assert.deepEqual(migrated, [
        {
          subagent_id: "toolu_linked",
          transcript_agent_id: "a-linked",
          resolved_model: "claude-opus-5-5",
        },
        {
          subagent_id: "toolu_overwritten",
          transcript_agent_id: "a-overwritten",
          resolved_model: "claude-opus-5-5",
        },
        {
          subagent_id: "toolu_unstarted",
          transcript_agent_id: "toolu_unstarted",
          resolved_model: null,
        },
      ]);
    }),
  );
});
