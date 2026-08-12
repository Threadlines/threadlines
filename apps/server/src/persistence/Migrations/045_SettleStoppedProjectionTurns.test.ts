import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("045_SettleStoppedProjectionTurns", (it) => {
  it.effect("interrupts only the stale latest turn of a stopped session", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 44 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'thread-stopped',
            'project-1',
            'Stopped thread',
            '{"instanceId":"claudeAgent","model":"claude-opus-4-7"}',
            'full-access',
            'default',
            NULL,
            NULL,
            'turn-stale',
            '2026-04-30T05:31:38.850Z',
            '2026-05-29T02:10:42.333Z',
            NULL
          ),
          (
            'thread-running',
            'project-1',
            'Running thread',
            '{"instanceId":"claudeAgent","model":"claude-opus-4-7"}',
            'full-access',
            'default',
            NULL,
            NULL,
            'turn-live',
            '2026-04-30T05:31:38.850Z',
            '2026-04-30T05:32:00.000Z',
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          active_turn_id,
          last_error,
          updated_at,
          runtime_mode
        )
        VALUES
          (
            'thread-stopped',
            'stopped',
            'claudeAgent',
            NULL,
            NULL,
            '2026-05-29T02:10:42.333Z',
            'full-access'
          ),
          (
            'thread-running',
            'running',
            'claudeAgent',
            'turn-live',
            NULL,
            '2026-04-30T05:32:00.000Z',
            'full-access'
          )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-stopped',
            'turn-stale',
            'message-stale',
            NULL,
            'running',
            '2026-04-30T05:31:38.850Z',
            '2026-04-30T05:31:38.850Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-running',
            'turn-live',
            'message-live',
            NULL,
            'running',
            '2026-04-30T05:31:38.850Z',
            '2026-04-30T05:31:38.850Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-stopped',
            'turn-older',
            'message-older',
            NULL,
            'running',
            '2026-04-30T05:20:00.000Z',
            '2026-04-30T05:20:00.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 45 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly turnId: string;
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          state,
          completed_at AS "completedAt"
        FROM projection_turns
        ORDER BY thread_id ASC, turn_id ASC
      `;
      assert.deepStrictEqual(rows, [
        {
          threadId: "thread-running",
          turnId: "turn-live",
          state: "running",
          completedAt: null,
        },
        {
          threadId: "thread-stopped",
          turnId: "turn-older",
          state: "running",
          completedAt: null,
        },
        {
          threadId: "thread-stopped",
          turnId: "turn-stale",
          state: "interrupted",
          completedAt: "2026-05-29T02:10:42.333Z",
        },
      ]);
    }),
  );

  it.effect("backfills checkpoint capture time separately from turn completion", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 45 });
      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-checkpoint',
            'turn-checkpoint',
            NULL,
            'assistant-checkpoint',
            'completed',
            '2026-06-01T00:00:00.000Z',
            '2026-06-01T00:00:00.000Z',
            '2026-06-01T00:00:05.000Z',
            1,
            'refs/threadlines/checkpoints/thread-checkpoint/turn/1',
            'ready',
            '[]'
          ),
          (
            'thread-no-checkpoint',
            'turn-no-checkpoint',
            NULL,
            NULL,
            'completed',
            '2026-06-01T00:00:00.000Z',
            '2026-06-01T00:00:00.000Z',
            '2026-06-01T00:00:03.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 46 });

      const rows = yield* sql<{
        readonly turnId: string;
        readonly completedAt: string | null;
        readonly checkpointCompletedAt: string | null;
      }>`
        SELECT
          turn_id AS "turnId",
          completed_at AS "completedAt",
          checkpoint_completed_at AS "checkpointCompletedAt"
        FROM projection_turns
        WHERE thread_id IN ('thread-checkpoint', 'thread-no-checkpoint')
        ORDER BY turn_id ASC
      `;
      assert.deepStrictEqual(rows, [
        {
          turnId: "turn-checkpoint",
          completedAt: "2026-06-01T00:00:05.000Z",
          checkpointCompletedAt: "2026-06-01T00:00:05.000Z",
        },
        {
          turnId: "turn-no-checkpoint",
          completedAt: "2026-06-01T00:00:03.000Z",
          checkpointCompletedAt: null,
        },
      ]);
    }),
  );
});
