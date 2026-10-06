import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("067_ProjectionThreadSubagentsProvider", (it) => {
  it.effect("files earlier codex exec agents under Codex and leaves the rest unset", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 66 });
      const rows = [
        // As stored: the agent id keeps the prefix, while the transcript id
        // was relinked to Claude's task id.
        { id: "codex-exec:8f0e", agentThreadId: "codex-exec:8f0e", role: "codex" },
        // A Claude agent that merely has "codex" as its role is not a codex exec run.
        { id: "toolu_claude", agentThreadId: "toolu_claude", role: "codex" },
        // A codex exec run whose rollout was never found: nothing identifies it.
        { id: "pending:toolu_lost", agentThreadId: null, role: "codex" },
      ];
      for (const row of rows) {
        yield* sql`
          INSERT INTO projection_thread_subagents (
            thread_id, subagent_id, agent_thread_id, transcript_agent_id, role, status,
            created_at, updated_at
          ) VALUES (
            'thread-1', ${row.id}, ${row.agentThreadId}, 'b09bok1s0', ${row.role}, 'completed',
            '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z'
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 67 });

      const migrated = yield* sql`
        SELECT subagent_id, agent_provider, session_provider
        FROM projection_thread_subagents ORDER BY subagent_id
      `;
      assert.deepEqual(migrated, [
        { subagent_id: "codex-exec:8f0e", agent_provider: "codex", session_provider: null },
        { subagent_id: "pending:toolu_lost", agent_provider: null, session_provider: null },
        { subagent_id: "toolu_claude", agent_provider: null, session_provider: null },
      ]);
    }),
  );
});
