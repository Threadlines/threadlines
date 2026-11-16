import { ThreadId } from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { threadMoveRefusals } from "../orchestration/threadMoveDecisions.ts";
import { makeThreadMoveContextReader } from "./threadMoveView.ts";

const layer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("threadMoveView", (it) => {
  it.effect(
    "reads the thread, its attached children and the threads in its checkout, and nothing else",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at)
        VALUES ('project-1', 'Project', '/repo', '{"provider":"codex","model":"gpt-5-codex"}', '[]', '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:00.000Z', NULL)`;
        const thread = (
          id: string,
          worktree: string | null,
          parent: string | null = null,
          deletedAt: string | null = null,
        ) =>
          sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id, latest_user_message_at, pending_approval_count, pending_user_input_count, has_actionable_proposed_plan, parent_thread_id, attached_to_parent, created_at, updated_at, deleted_at)
          VALUES (${id}, 'project-1', ${id}, '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default', NULL, ${worktree}, NULL, NULL, 0, 0, 0, ${parent}, ${parent === null ? 0 : 1}, '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:00.000Z', ${deletedAt})`;
        yield* thread("moving", "/worktrees/a");
        yield* thread("child", "/worktrees/child", "moving");
        yield* thread("same-folder", "/worktrees/a");
        yield* thread("gone-same-folder", "/worktrees/a", null, "2026-02-25T00:00:00.000Z");
        yield* thread("project-folder", null);
        yield* thread("elsewhere", "/worktrees/b");

        const read = yield* makeThreadMoveContextReader;
        const context = yield* read(ThreadId.make("moving"));
        assert.isNotNull(context);
        assert.deepEqual(context!.view.threads.map((entry) => entry.id).toSorted(), [
          "child",
          "moving",
          "same-folder",
        ]);
        assert.deepEqual(
          context!.view.projects.map((project) => project.id),
          ["project-1"],
        );
        assert.include(
          threadMoveRefusals(context!.view, context!.thread).map((entry) => entry.code),
          "has_children",
        );
        // A thread in the project folder is matched by that folder, and no other thread works there.
        const inProject = yield* read(ThreadId.make("project-folder"));
        assert.deepEqual(
          inProject!.view.threads.map((entry) => entry.id),
          ["project-folder"],
        );
        assert.isNull(yield* read(ThreadId.make("never-was")));
      }),
  );
});
