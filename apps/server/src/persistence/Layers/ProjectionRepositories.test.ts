import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProjectId, ThreadId, ProviderInstanceId } from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";

const projectionRepositoriesLayer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

projectionRepositoriesLayer("Projection repositories", (it) => {
  it.effect("stores SQL NULL for missing project model options", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* projects.upsert({
        projectId: ProjectId.make("project-null-options"),
        kind: "workspace",
        title: "Null options project",
        workspaceRoot: "/tmp/project-null-options",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        scripts: [],
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly defaultModelSelection: string | null;
      }>`
        SELECT default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_projects row to exist.");
      }

      assert.strictEqual(
        row.defaultModelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        }),
      );

      const persisted = yield* projects.getById({
        projectId: ProjectId.make("project-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.defaultModelSelection, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      });
    }),
  );

  it.effect("stores JSON for thread model options", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* threads.upsert({
        threadId: ThreadId.make("thread-null-options"),
        projectId: ProjectId.make("project-null-options"),
        title: "Null options thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        effectiveCwd: null,
        goal: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        pinnedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        blockingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly modelSelection: string | null;
      }>`
        SELECT model_selection_json AS "modelSelection"
        FROM projection_threads
        WHERE thread_id = 'thread-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_threads row to exist.");
      }

      assert.strictEqual(
        row.modelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        }),
      );

      const persisted = yield* threads.getById({
        threadId: ThreadId.make("thread-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.modelSelection, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      });
    }),
  );
});

it.effect("backfills transcript order from first events without changing timestamps", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 49 });
    const before = "2026-09-05T15:00:00.000Z";
    const after = "2026-09-05T14:00:00.000Z";
    const agentActivity = (completed: boolean) => ({
      threadId: "thread-clock",
      activity: {
        id: "activity-clock",
        turnId: null,
        tone: "tool",
        kind: "tool.updated",
        summary: "Agent",
        createdAt: after,
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            subagentLiveText: completed ? null : "Reading files",
            item: {
              id: "spawn-clock",
              tool: "spawnAgent",
              agentThreadId: "agent-clock",
              status: completed ? "completed" : "inProgress",
              agentsStates: completed
                ? { "agent-clock": { status: "completed", message: "Done" } }
                : {},
            },
          },
        },
      },
    });
    const events = [
      ["thread.message-sent", { messageId: "message-clock" }],
      ["thread.activity-appended", agentActivity(false)],
      ["thread.proposed-plan-upserted", { proposedPlan: { id: "plan-clock" } }],
      ["thread.message-sent", { messageId: "message-clock" }],
      ["thread.activity-appended", agentActivity(true)],
      ["thread.proposed-plan-upserted", { proposedPlan: { id: "plan-clock" } }],
      ["thread.follow-up-accepted", { messageId: "follow-up-clock" }],
    ] as const;
    for (const [index, [type, payload]] of events.entries()) {
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES (
          ${`clock-${index}`}, 'thread', 'thread-clock', ${index + 1}, ${type},
          ${index === 0 ? before : after}, 'provider', ${JSON.stringify(payload)}, '{}'
        )
      `;
    }
    for (const messageId of ["message-clock", "follow-up-clock", "legacy-clock"]) {
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (${messageId}, 'thread-clock', NULL, 'user', 'text', 0, ${before}, ${after})
      `;
    }
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
      ) VALUES ('activity-clock', 'thread-clock', NULL, 'tool', 'tool.started', 'tool', '{}', 900, ${after})
    `;
    yield* sql`
      INSERT INTO projection_thread_proposed_plans (
        plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at
      ) VALUES ('plan-clock', 'thread-clock', NULL, 'plan', ${after}, ${after})
    `;
    yield* sql`
      INSERT INTO projection_thread_subagents (
        thread_id, subagent_id, agent_thread_id, status, result_body, result_created_at, created_at, updated_at
      ) VALUES ('thread-clock', 'agent-clock', 'agent-clock', 'completed', 'Done', ${after}, ${before}, ${after})
    `;
    yield* sql`
      INSERT INTO projection_thread_subagents (
        thread_id, subagent_id, spawn_call_id, status, result_body, created_at, updated_at
      ) VALUES ('thread-clock', 'other-agent', 'spawn-clock', 'completed', 'Done', ${before}, ${after})
    `;
    yield* runMigrations();
    assert.deepStrictEqual(
      yield* sql`
      SELECT result_event_sequence, live_event_sequence, result_body, status, created_at
      FROM projection_thread_subagents ORDER BY subagent_id
    `,
      [
        {
          result_event_sequence: 5,
          live_event_sequence: 2,
          result_body: "Done",
          status: "completed",
          created_at: before,
        },
        {
          result_event_sequence: null,
          live_event_sequence: null,
          result_body: "Done",
          status: "completed",
          created_at: before,
        },
      ],
    );
    assert.deepStrictEqual(
      yield* sql`
      SELECT message_id, event_sequence, created_at, updated_at
      FROM projection_thread_messages ORDER BY event_sequence ASC
    `,
      [
        { message_id: "legacy-clock", event_sequence: null, created_at: before, updated_at: after },
        { message_id: "message-clock", event_sequence: 1, created_at: before, updated_at: after },
        { message_id: "follow-up-clock", event_sequence: 7, created_at: before, updated_at: after },
      ],
    );
    assert.deepStrictEqual(
      yield* sql`
      SELECT event_sequence, sequence, created_at FROM projection_thread_activities
    `,
      [{ event_sequence: 2, sequence: 900, created_at: after }],
    );
    assert.deepStrictEqual(
      yield* sql`
      SELECT event_sequence, created_at FROM projection_thread_proposed_plans
    `,
      [{ event_sequence: 3, created_at: after }],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
