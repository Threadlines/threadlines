import {
  EnvironmentId,
  GENERAL_CHATS_PROJECT_ID,
  ProjectId,
  ProviderInstanceId,
  SideTurnId,
  ThreadId,
  ThreadParticipantId,
} from "@threadlines/contracts";
import {
  parseSessionKey,
  participantSessionKey,
  sideSessionKey,
} from "@threadlines/shared/threadParticipants";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { ProjectInstructions } from "../provider/Services/ProjectInstructions.ts";
import { ProjectBriefRepositoryLive } from "./ProjectBriefRepository.ts";
import { ProjectContext, ProjectContextLive } from "./ProjectContext.ts";
import { ProjectNoteRepositoryLive } from "./ProjectNoteRepository.ts";
import { ProjectInstructionsLive } from "./ProjectInstructionsLive.ts";

const layer = it.layer(
  Layer.mergeAll(ProjectContextLive, ProjectInstructionsLive).pipe(
    Layer.provideMerge(ProjectBriefRepositoryLive),
    Layer.provideMerge(ProjectNoteRepositoryLive),
    Layer.provideMerge(ProjectionProjectRepositoryLive),
    Layer.provideMerge(ProjectionThreadRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const at = "2026-11-18T00:00:00.000Z";

const addProject = (projectId: ProjectId, title: string) =>
  Effect.flatMap(ProjectionProjectRepository, (projects) =>
    projects.upsert({
      projectId,
      kind: "workspace",
      title,
      workspaceRoot: `/tmp/${projectId}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    }),
  );

const addThread = (
  threadId: ThreadId,
  projectId: ProjectId,
  extra: Partial<Parameters<ProjectionThreadRepository["Service"]["upsert"]>[0]> = {},
) =>
  Effect.flatMap(ProjectionThreadRepository, (threads) =>
    threads.upsert({
      threadId,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      effectiveCwd: null,
      goal: null,
      latestTurnId: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      pinnedAt: null,
      latestUserMessageAt: null,
      pendingApprovalCount: 0,
      pendingUserInputCount: 0,
      blockingUserInputCount: 0,
      hasActionableProposedPlan: 0,
      deletedAt: null,
      ...extra,
    }),
  );

const instructionsFor = (sessionKey: ThreadId) =>
  Effect.flatMap(ProjectInstructions, (lookup) =>
    lookup.forSession({ sessionKey, runtimeMode: "full-access" }),
  );

layer("ProjectContext", (it) => {
  it.effect("a save from behind another device's is refused and loses nothing", () =>
    Effect.gen(function* () {
      const context = yield* ProjectContext;
      const projectId = ProjectId.make("project-stale");
      yield* addProject(projectId, "Stale");

      const first = yield* context.setBrief({ projectId, text: "Use pnpm.", expectedRevision: 0 });
      assert.strictEqual(first.outcome, "saved");
      assert.strictEqual(first.brief.revision, 1);

      // Another page still holds revision 0.
      const late = yield* context.setBrief({ projectId, text: "Use npm.", expectedRevision: 0 });
      assert.strictEqual(late.outcome, "stale");
      assert.strictEqual(late.brief.text, "Use pnpm.");
      assert.strictEqual(late.brief.revision, 1);
      assert.strictEqual(yield* context.briefText(projectId), "Use pnpm.");

      const next = yield* context.setBrief({ projectId, text: "Use bun.", expectedRevision: 1 });
      assert.strictEqual(next.outcome, "saved");
      assert.strictEqual(next.brief.revision, 2);

      const snapshot = yield* context.changes.pipe(Stream.runHead);
      assert.deepStrictEqual(
        snapshot._tag === "Some"
          ? snapshot.value.briefs.find((brief) => brief.projectId === projectId)?.text
          : undefined,
        "Use bun.",
      );
    }),
  );

  it.effect("a copied project's brief fills only an empty one", () =>
    Effect.gen(function* () {
      const context = yield* ProjectContext;
      const fresh = ProjectId.make("project-copied");
      const written = ProjectId.make("project-written");
      yield* addProject(fresh, "Copied");
      yield* addProject(written, "Written");
      yield* context.setBrief({ projectId: written, text: "Mine.", expectedRevision: 0 });

      yield* context.adoptBrief(fresh, "From the other computer.");
      yield* context.adoptBrief(written, "From the other computer.");

      assert.strictEqual(yield* context.briefText(fresh), "From the other computer.");
      assert.strictEqual(yield* context.briefText(written), "Mine.");
    }),
  );

  it.effect("General Chats have no brief", () =>
    Effect.gen(function* () {
      const context = yield* ProjectContext;
      const refused = yield* context
        .setBrief({ projectId: GENERAL_CHATS_PROJECT_ID, text: "x", expectedRevision: 0 })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "ProjectContextError");
    }),
  );

  it.effect("a thread's session gets the brief as it is when it starts", () =>
    Effect.gen(function* () {
      const context = yield* ProjectContext;
      const projectId = ProjectId.make("project-brief");
      const threadId = ThreadId.make("thread-brief");
      yield* addProject(projectId, "Shop");
      yield* addThread(threadId, projectId);

      assert.strictEqual(yield* instructionsFor(threadId), undefined);
      yield* context.setBrief({ projectId, text: "Prices are in cents.", expectedRevision: 0 });
      const text = yield* instructionsFor(threadId);
      assert.include(text ?? "", 'Project brief for "Shop"');
      assert.include(text ?? "", "Prices are in cents.");

      yield* context.setBrief({ projectId, text: "Prices are in euros.", expectedRevision: 1 });
      assert.include((yield* instructionsFor(threadId)) ?? "", "Prices are in euros.");

      // Cleared: nothing to add.
      yield* context.setBrief({ projectId, text: "", expectedRevision: 2 });
      assert.strictEqual(yield* instructionsFor(threadId), undefined);
    }),
  );

  it.effect("a fenced thread, a General Chat and a side answer get no brief", () =>
    Effect.gen(function* () {
      const context = yield* ProjectContext;
      const projectId = ProjectId.make("project-closed");
      yield* addProject(projectId, "Closed");
      yield* context.setBrief({ projectId, text: "Secret plans.", expectedRevision: 0 });

      // Session keys carry ids in the app's own form.
      const open = ThreadId.make("6f1c2a52-3b7e-4c1d-9a8e-2f4b5c6d7e8f");
      const fenced = ThreadId.make("thread-fenced");
      const general = ThreadId.make("thread-general");
      yield* addThread(open, projectId);
      yield* addThread(fenced, projectId, {
        remoteOrigin: {
          linkDeviceId: "device-windows",
          environmentId: EnvironmentId.make("env-windows"),
          environmentLabel: "Windows PC",
          threadId: ThreadId.make("windows-parent"),
          threadTitle: "Ship the release",
        },
      });
      yield* addThread(general, GENERAL_CHATS_PROJECT_ID);

      assert.include((yield* instructionsFor(open)) ?? "", "Secret plans.");
      // A room agent's working session is the thread's too.
      const roomAgent = participantSessionKey(
        open,
        ThreadParticipantId.make("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"),
      );
      assert.include((yield* instructionsFor(roomAgent)) ?? "", "Secret plans.");
      assert.strictEqual(yield* instructionsFor(fenced), undefined);
      assert.strictEqual(yield* instructionsFor(general), undefined);
      const side = sideSessionKey(
        open,
        SideTurnId.make("0b9d8c7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e"),
        null,
      );
      assert.strictEqual(parseSessionKey(side).kind, "side");
      assert.strictEqual(yield* instructionsFor(side), undefined);
    }),
  );
});
