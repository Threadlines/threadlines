import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { ProjectId, ThreadId } from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { CheckpointStore } from "../checkpointing/Services/CheckpointStore.ts";
import { makeCheckpointStoreStub } from "../checkpointing/testing/CheckpointStoreStub.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { VcsDriverRegistry, type VcsDriverHandle } from "../vcs/VcsDriverRegistry.ts";
import { WorkspaceFileSystem } from "../workspace/Services/WorkspaceFileSystem.ts";
import { ProjectMedia, ProjectMediaLive } from "./ProjectMedia.ts";

// The repository's root holds the project in its `app/` folder, so summary
// paths (repository-root-relative) have to be read from inside that folder.
const repositoryRoot = NodeFs.realpathSync(
  NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "project-media-")),
);
const projectFolder = NodePath.join(repositoryRoot, "app");
for (const file of ["hero.png", "logo.svg", "brief.pdf", "b.png"]) {
  NodeFs.mkdirSync(projectFolder, { recursive: true });
  NodeFs.writeFileSync(NodePath.join(projectFolder, file), "x");
}
// A picture outside the repository, and a link to it from inside the project.
const outsideFolder = NodeFs.realpathSync(
  NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "project-media-outside-")),
);
NodeFs.writeFileSync(NodePath.join(outsideFolder, "private.png"), "secret");
NodeFs.symlinkSync(
  NodePath.join(outsideFolder, "private.png"),
  NodePath.join(projectFolder, "link.png"),
);

const layer = it.layer(
  ProjectMediaLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(CheckpointStore, makeCheckpointStoreStub())),
    Layer.provideMerge(Layer.mock(WorkspaceFileSystem)({})),
    Layer.provideMerge(
      Layer.mock(VcsDriverRegistry)({
        detect: () =>
          Effect.succeed({
            repository: { rootPath: repositoryRoot },
          } as unknown as VcsDriverHandle),
      }),
    ),
  ),
);

const insertThread = (input: {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly deleted?: boolean;
  readonly turns: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        branch, worktree_path, latest_turn_id, latest_user_message_at, pending_approval_count,
        pending_user_input_count, has_actionable_proposed_plan, created_at, updated_at, deleted_at
      )
      VALUES (
        ${input.threadId}, ${input.projectId}, ${input.title},
        '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default', NULL, NULL, NULL,
        NULL, 0, 0, 0, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z',
        ${input.deleted ? "2026-03-02T00:00:00.000Z" : null}
      )
    `;
    for (const [index, files] of input.turns.entries()) {
      const turnCount = index + 1;
      const at = `2026-03-01T00:0${turnCount}:00.000Z`;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id,
          source_proposed_plan_id, assistant_message_id, state, requested_at, started_at,
          completed_at, checkpoint_turn_count, checkpoint_ref, checkpoint_status,
          checkpoint_files_json, checkpoint_completed_at
        )
        VALUES (
          ${input.threadId}, ${`${input.threadId}-turn-${turnCount}`}, NULL, NULL, NULL,
          ${`${input.threadId}-reply-${turnCount}`}, 'completed', ${at}, ${at}, ${at},
          ${turnCount}, ${`checkpoint-${turnCount}`}, 'ready', ${JSON.stringify(files)}, ${at}
        )
      `;
    }
  });

layer("ProjectMedia", (it) => {
  it.effect("lists what each thread made inside the project folder, as it stands now", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        )
        VALUES
          ('project-media', 'Media', ${projectFolder}, NULL, '[]',
           '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', NULL),
          ('project-other', 'Other', ${projectFolder}, NULL, '[]',
           '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', NULL)
      `;
      yield* insertThread({
        threadId: "thread-a",
        projectId: "project-media",
        title: "Make the art",
        turns: [
          [
            { path: "app/hero.png", kind: "add", additions: 0, deletions: 0 },
            { path: "app/gone.png", kind: "add", additions: 0, deletions: 0 },
            { path: "app/old-logo.svg", kind: "add", additions: 3, deletions: 0 },
            { path: "app/brief.pdf", kind: "modified", additions: 0, deletions: 0 },
            { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
            // Outside the project's folder, above the repository, or a link
            // out of it: never listed.
            { path: "site/outside.png", kind: "add", additions: 0, deletions: 0 },
            { path: "app/../../escape.png", kind: "add", additions: 0, deletions: 0 },
            { path: "app/link.png", kind: "add", additions: 0, deletions: 0 },
          ],
          [
            { path: "app/hero.png", kind: "modified", additions: 0, deletions: 0 },
            { path: "app/gone.png", kind: "delete", additions: 0, deletions: 0 },
            {
              path: "app/logo.svg",
              kind: "modified",
              additions: 0,
              deletions: 0,
              previousPath: "app/old-logo.svg",
            },
            // Recorded, but no longer on disk.
            { path: "app/deleted-by-hand.png", kind: "add", additions: 0, deletions: 0 },
          ],
        ],
      });
      yield* insertThread({
        threadId: "thread-b",
        projectId: "project-media",
        title: "Second thread",
        turns: [[{ path: "app/b.png", kind: "add", additions: 0, deletions: 0 }]],
      });
      yield* insertThread({
        threadId: "thread-deleted",
        projectId: "project-media",
        title: "Deleted",
        deleted: true,
        turns: [[{ path: "app/b.png", kind: "add", additions: 0, deletions: 0 }]],
      });
      yield* insertThread({
        threadId: "thread-other",
        projectId: "project-other",
        title: "Elsewhere",
        turns: [[{ path: "app/hero.png", kind: "add", additions: 0, deletions: 0 }]],
      });

      const media = yield* ProjectMedia;
      const project = yield* media.listProjectMedia({
        projectId: ProjectId.make("project-media"),
      });
      assert.strictEqual(project.truncated, false);
      assert.deepEqual(
        project.entries
          .map((entry) => ({
            thread: entry.threadId as string,
            relativePath: entry.relativePath,
            repositoryPath: entry.repositoryPath,
            mediaKind: entry.mediaKind,
            change: entry.change,
            turn: entry.checkpointTurnCount,
            reply: entry.assistantMessageId as string | null,
          }))
          .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath)),
        [
          {
            thread: "thread-b",
            relativePath: "b.png",
            repositoryPath: "app/b.png",
            mediaKind: "picture",
            change: "added",
            turn: 1,
            reply: "thread-b-reply-1",
          },
          {
            thread: "thread-a",
            relativePath: "brief.pdf",
            repositoryPath: "app/brief.pdf",
            mediaKind: "document",
            change: "modified",
            turn: 1,
            reply: "thread-a-reply-1",
          },
          {
            thread: "thread-a",
            relativePath: "hero.png",
            repositoryPath: "app/hero.png",
            mediaKind: "picture",
            change: "added",
            turn: 2,
            reply: "thread-a-reply-2",
          },
          {
            // A rename keeps "added" from the file it came from.
            thread: "thread-a",
            relativePath: "logo.svg",
            repositoryPath: "app/logo.svg",
            mediaKind: "picture",
            change: "added",
            turn: 2,
            reply: "thread-a-reply-2",
          },
        ],
      );
      assert.deepEqual(
        project.entries.map((entry) => entry.changedAt),
        project.entries
          .map((entry) => entry.changedAt)
          .toSorted((left, right) => right.localeCompare(left)),
      );

      const oneThread = yield* media.listProjectMedia({
        projectId: ProjectId.make("project-media"),
        threadId: ThreadId.make("thread-b"),
      });
      assert.deepEqual(
        oneThread.entries.map((entry) => entry.relativePath),
        ["b.png"],
      );
    }),
  );

  it.effect("includes chat media without checkpoints and loads inline images only on request", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at)
        VALUES ('conversation-media', 'Chat', ${projectFolder}, NULL, '[]',
          '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')`;
      yield* insertThread({
        threadId: "chat-media-a",
        projectId: "conversation-media",
        title: "Screenshots",
        turns: [[{ path: "app/hero.png", kind: "modified" }]],
      });
      yield* insertThread({
        threadId: "chat-media-b",
        projectId: "conversation-media",
        title: "Other chat",
        turns: [],
      });
      const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
      const remote = "https://example.com/picture.png?a=1&b=2";
      const text = [
        `![outside](<${NodePath.join(outsideFolder, "private.png")}> )`,
        "[Existing picture](hero.png)",
        `![remote](${remote})`,
        `![inline](data:image/png;base64,${imageData})`,
        "~~~md",
        "![example](b.png)",
        "~~~",
      ].join("\n");
      const attachments = [
        {
          type: "image",
          id: "uploaded-shot",
          name: "upload.png",
          mimeType: "image/png",
          sizeBytes: 20,
        },
        {
          type: "file",
          kind: "pdf",
          id: "uploaded-pdf",
          name: "brief.pdf",
          mimeType: "application/pdf",
          sizeBytes: 50,
        },
      ];
      for (const thread of ["chat-media-a", "chat-media-b"]) {
        yield* sql`INSERT INTO projection_thread_messages
          (message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, created_at, updated_at)
          VALUES (${thread + "-message"}, ${thread}, NULL, 'user', ${thread === "chat-media-a" ? text : ""},
            ${JSON.stringify(thread === "chat-media-a" ? attachments : [{ ...attachments[0], id: "other-upload", name: "other.png" }])},
            0, '2026-03-01T00:02:00.000Z', '2026-03-01T00:02:00.000Z')`;
      }
      yield* sql`INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
        VALUES ('chat-screenshot', 'chat-media-a', NULL, 'info', 'tool.completed', 'Screenshot',
          ${JSON.stringify({
            itemType: "dynamic_tool_call",
            data: {
              item: { id: "capture" },
              result: {
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data: imageData },
                  },
                ],
              },
            },
          })}, '2026-03-01T00:03:00.000Z')`;
      const media = yield* ProjectMedia;
      const result = yield* media.listProjectMedia({
        projectId: ProjectId.make("conversation-media"),
        threadId: ThreadId.make("chat-media-a"),
      });
      assert.deepEqual(result.entries.map((entry) => entry.relativePath).toSorted(), [
        "brief.pdf",
        "capture.png",
        "hero.png",
        "image-3.png",
        "image-4.png",
        "private.png",
        "upload.png",
      ]);
      assert.isFalse(JSON.stringify(result).includes(imageData));
      const hero = result.entries.find((entry) => entry.relativePath === "hero.png");
      assert.strictEqual(hero?.change, "modified");
      const previewUrls: Array<string | null> = [];
      for (const entry of result.entries) {
        if (entry.source && entry.source.kind !== "attachment") {
          previewUrls.push(
            (yield* media.getProjectMediaPreview({
              threadId: entry.threadId,
              source: entry.source,
            })).url,
          );
        }
      }
      assert.deepEqual(
        previewUrls.toSorted(),
        [
          remote,
          `data:image/png;base64,${imageData}`,
          `data:image/png;base64,${imageData}`,
        ].toSorted(),
      );
      const all = yield* media.listProjectMedia({
        projectId: ProjectId.make("conversation-media"),
      });
      assert.strictEqual(all.entries.length, result.entries.length + 1);
      const inline = result.entries.find((entry) => entry.source?.kind === "activity")!;
      assert.deepEqual(
        yield* media.getProjectMediaPreview({
          threadId: ThreadId.make("chat-media-b"),
          source: inline.source!,
        }),
        { url: null },
      );
    }),
  );

  it.effect("keeps uncommitted reads inside the repository", () =>
    Effect.gen(function* () {
      const media = yield* ProjectMedia;
      for (const path of ["../secret.png", "/etc/hosts", "app/../../secret.png", "app/link.png"]) {
        const result = yield* media.readRepositoryFile({
          cwd: projectFolder,
          path,
          source: "worktree",
        });
        assert.deepEqual(result, { kind: "missing", relativePath: path });
      }
    }),
  );
});
