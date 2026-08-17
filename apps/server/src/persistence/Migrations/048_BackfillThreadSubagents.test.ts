import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

interface SubagentRow {
  readonly thread_id: string;
  readonly subagent_id: string;
  readonly agent_thread_id: string | null;
  readonly spawn_call_id: string | null;
  readonly role: string | null;
  readonly objective: string | null;
  readonly status: string;
}

layer("048_BackfillThreadSubagents", (it) => {
  it.effect("rebuilds Claude and Codex rosters and survives hostile rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 47 });

      const insertActivity = (input: {
        threadId: string;
        activityId: string;
        kind: string;
        payload: string;
        turnId?: string | null;
        createdAt?: string;
      }) => sql`
        INSERT INTO projection_thread_activities (
          thread_id, activity_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES (
          ${input.threadId}, ${input.activityId}, ${input.turnId ?? null}, 'tool',
          ${input.kind}, 'Subagent task', ${input.payload}, NULL,
          ${input.createdAt ?? "2026-08-15T00:00:00.000Z"}
        )
      `;

      // Claude-shaped thread: spawn + task link + settle.
      yield* insertActivity({
        threadId: "thread-claude",
        activityId: "c1",
        kind: "tool.started",
        turnId: "turn-1",
        payload: JSON.stringify({
          itemType: "collab_agent_tool_call",
          toolCallId: "toolu_spawn",
          status: "inProgress",
          data: {
            toolName: "Agent",
            input: { description: "Fix the bug trio", subagent_type: "claude" },
          },
        }),
      });
      yield* insertActivity({
        threadId: "thread-claude",
        activityId: "c2",
        kind: "task.completed",
        payload: JSON.stringify({
          taskId: "task-1",
          status: "completed",
          toolUseId: "toolu_spawn",
        }),
        createdAt: "2026-08-15T00:05:00.000Z",
      });

      // Codex-shaped thread reproducing the pending-spawn/late-id collision
      // that used to violate the roster's unique keys and abort the migration.
      yield* insertActivity({
        threadId: "thread-codex",
        activityId: "x1",
        kind: "tool.updated",
        turnId: "turn-2",
        payload: JSON.stringify({
          itemType: "collab_agent_tool_call",
          data: {
            item: { id: "call-1", tool: "spawnAgent", status: "inProgress", prompt: "Review" },
          },
        }),
      });
      yield* insertActivity({
        threadId: "thread-codex",
        activityId: "x2",
        kind: "tool.updated",
        payload: JSON.stringify({
          itemType: "collab_agent_tool_call",
          data: {
            item: {
              id: "call-2",
              tool: "wait",
              status: "inProgress",
              receiverThreadIds: ["agent-x"],
            },
          },
        }),
        createdAt: "2026-08-15T00:01:00.000Z",
      });
      yield* insertActivity({
        threadId: "thread-codex",
        activityId: "x3",
        kind: "tool.updated",
        payload: JSON.stringify({
          itemType: "collab_agent_tool_call",
          data: {
            item: {
              id: "call-1",
              tool: "spawnAgent",
              status: "completed",
              agentThreadId: "agent-x",
            },
          },
        }),
        createdAt: "2026-08-15T00:02:00.000Z",
      });

      // Malformed payload row: json_extract raises on it unless filtered.
      yield* insertActivity({
        threadId: "thread-broken",
        activityId: "b1",
        kind: "task.progress",
        payload: "not json",
      });

      // Orphan roster row whose thread has no roster-moving activities left.
      yield* sql`
        INSERT INTO projection_thread_subagents (
          thread_id, subagent_id, status, created_at, updated_at
        ) VALUES ('thread-gone', 'stale-agent', 'running', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 48 });

      const rows = (yield* sql`
        SELECT thread_id, subagent_id, agent_thread_id, spawn_call_id, role, objective, status
        FROM projection_thread_subagents
        ORDER BY thread_id ASC
      `) as unknown as ReadonlyArray<SubagentRow>;

      assert.deepStrictEqual(
        rows.map((row) => row.thread_id),
        ["thread-claude", "thread-codex"],
      );

      const claude = rows[0];
      assert.strictEqual(claude?.subagent_id, "toolu_spawn");
      assert.strictEqual(claude?.role, "claude");
      assert.strictEqual(claude?.objective, "Fix the bug trio");
      assert.strictEqual(claude?.status, "completed");

      const codex = rows[1];
      assert.strictEqual(codex?.agent_thread_id, "agent-x");
      assert.strictEqual(codex?.spawn_call_id, "call-1");
      assert.strictEqual(codex?.objective, "Review");
    }),
  );
});
