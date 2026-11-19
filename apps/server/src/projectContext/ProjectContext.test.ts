import {
  EnvironmentId,
  GENERAL_CHATS_PROJECT_ID,
  type OrchestrationEvent,
  ProjectId,
  type ProjectNotesMode,
  ProviderInstanceId,
  type RuntimeMode,
  SideTurnId,
  ThreadId,
  ThreadParticipantId,
  TurnId,
} from "@threadlines/contracts";
import {
  parseSessionKey,
  participantSessionKey,
  sideSessionKey,
} from "@threadlines/shared/threadParticipants";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProjectInstructions } from "../provider/Services/ProjectInstructions.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectBriefRepositoryLive } from "./ProjectBriefRepository.ts";
import { ProjectContext, ProjectContextLive } from "./ProjectContext.ts";
import { ProjectNoteRepositoryLive } from "./ProjectNoteRepository.ts";
import { makeProjectInstructions, ProjectInstructionsLive } from "./ProjectInstructionsLive.ts";
import { makeProjectNotesUndo } from "./ProjectNotesUndo.ts";

/** A fresh in-memory database each time it is built. */
const testLayer = Layer.mergeAll(ProjectContextLive, ProjectInstructionsLive).pipe(
  Layer.provideMerge(ProjectBriefRepositoryLive),
  Layer.provideMerge(ProjectNoteRepositoryLive),
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const layer = it.layer(testLayer);

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

/** A session's text as it starts with `runtimeMode`, under "Notes agents write" = `projectNotes`. */
const sessionText = (
  sessionKey: ThreadId,
  runtimeMode: RuntimeMode,
  projectNotes: ProjectNotesMode,
) =>
  makeProjectInstructions.pipe(
    Effect.flatMap((lookup) => lookup.forSession({ sessionKey, runtimeMode })),
    Effect.provide(ServerSettingsService.layerTest({ projectNotes })),
    Effect.map((text) => text ?? ""),
  );

/** An agent's project_note_write, as the tool hands it to the service. */
const agentWrite = (input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly text?: string;
  readonly mode: "ask" | "auto";
  readonly ceiling?: RuntimeMode;
  readonly turnId?: TurnId;
}) =>
  Effect.flatMap(ProjectContext, (context) =>
    context.writeAgentNote({
      projectId: input.projectId,
      title: input.title,
      summary: `About ${input.title}`,
      text: input.text ?? `${input.title} text`,
      author: { kind: "agent", threadId: input.threadId, participantId: null, agentName: "Codex" },
      turnId: input.turnId ?? null,
      writerCeiling: { runtimeMode: input.ceiling ?? "full-access", interactionMode: "default" },
      mode: input.mode,
    }),
  );

const snapshotNow = Effect.flatMap(ProjectContext, (context) =>
  context.changes.pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
);

const titlesFor = (projectId: ProjectId, runtimeMode: RuntimeMode) =>
  Effect.flatMap(ProjectContext, (context) =>
    Effect.map(context.agentNotes(projectId, runtimeMode), (notes) =>
      notes.map((note) => note.title),
    ),
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

  it.effect("an agent's note under Ask waits for the user, and Keep keeps exactly that text", () =>
    Effect.gen(function* () {
      const context = yield* ProjectContext;
      const projectId = ProjectId.make("project-ask");
      const writer = ThreadId.make("thread-ask-writer");
      const reader = ThreadId.make("thread-ask-reader");
      yield* addProject(projectId, "Ask");
      yield* addThread(reader, projectId);

      const written = yield* agentWrite({
        projectId,
        threadId: writer,
        title: "Release steps",
        text: "Tag, then push.",
        mode: "ask",
      });
      assert.strictEqual(written.outcome, "suggested");
      assert.deepStrictEqual(yield* titlesFor(projectId, "approval-required"), []);
      assert.deepStrictEqual(yield* titlesFor(projectId, "full-access"), []);
      assert.notInclude(yield* sessionText(reader, "full-access", "ask"), "Release steps");

      const first = (yield* snapshotNow).suggestions.find((entry) => entry.projectId === projectId);
      const kept = yield* context.changeNote({
        kind: "resolveSuggestion",
        projectId,
        suggestionId: first!.id,
        decision: "keep",
      });
      assert.strictEqual(kept.note?.approved, true);
      assert.deepStrictEqual(yield* titlesFor(projectId, "approval-required"), ["Release steps"]);
      assert.include(
        yield* sessionText(reader, "approval-required", "ask"),
        "- Release steps: About Release steps",
      );

      // A later write of the same title, even under Auto, is a new suggestion.
      const again = yield* agentWrite({
        projectId,
        threadId: writer,
        title: "release steps",
        text: "Push, then tag.",
        mode: "auto",
      });
      assert.strictEqual(again.outcome, "suggested");
      const waiting = (yield* snapshotNow).suggestions.filter(
        (entry) => entry.projectId === projectId,
      );
      assert.strictEqual(waiting.length, 1);
      assert.notStrictEqual(waiting[0]!.id, first!.id);
      const noteId = kept.note!.id;
      assert.strictEqual((yield* context.readNote({ projectId, noteId })).text, "Tag, then push.");

      yield* context.changeNote({
        kind: "resolveSuggestion",
        projectId,
        suggestionId: waiting[0]!.id,
        decision: "keep",
      });
      assert.strictEqual((yield* context.readNote({ projectId, noteId })).text, "Push, then tag.");
      assert.deepStrictEqual(yield* titlesFor(projectId, "full-access"), ["release steps"]);
    }),
  );

  it.effect("a note kept without asking is listed only within its writer's access", () =>
    Effect.gen(function* () {
      const context = yield* ProjectContext;
      const projectId = ProjectId.make("project-auto");
      const reader = ThreadId.make("thread-auto-reader");
      yield* addProject(projectId, "Auto");
      yield* addThread(reader, projectId);

      const written = yield* agentWrite({
        projectId,
        threadId: ThreadId.make("thread-auto-writer"),
        title: "Ports",
        mode: "auto",
        ceiling: "auto-accept-edits",
      });
      assert.strictEqual(written.outcome, "kept_limited");
      assert.deepStrictEqual(yield* titlesFor(projectId, "full-access"), []);
      assert.deepStrictEqual(yield* titlesFor(projectId, "auto"), []);
      assert.deepStrictEqual(yield* titlesFor(projectId, "auto-accept-edits"), ["Ports"]);
      assert.deepStrictEqual(yield* titlesFor(projectId, "approval-required"), ["Ports"]);
      assert.notInclude(yield* sessionText(reader, "full-access", "auto"), "Ports");
      assert.include(yield* sessionText(reader, "auto-accept-edits", "auto"), "- Ports:");

      const note = (yield* snapshotNow).notes.find((entry) => entry.projectId === projectId);
      yield* context.changeNote({ kind: "approve", projectId, noteId: note!.id });
      assert.deepStrictEqual(yield* titlesFor(projectId, "full-access"), ["Ports"]);
      assert.include(yield* sessionText(reader, "full-access", "auto"), "- Ports:");
    }),
  );

  it.effect(
    "an agent's write over a kept title is a suggestion, unless it rewrites its own limited note",
    () =>
      Effect.gen(function* () {
        const context = yield* ProjectContext;
        const projectId = ProjectId.make("project-overwrite");
        const own = ThreadId.make("thread-overwrite-own");
        const other = ThreadId.make("thread-overwrite-other");
        yield* addProject(projectId, "Overwrite");
        const userNote = yield* context.changeNote({
          kind: "save",
          projectId,
          title: "Deploy",
          summary: "How we deploy",
          text: "Only on Fridays.",
        });

        const overUser = yield* agentWrite({
          projectId,
          threadId: own,
          title: "deploy",
          text: "Any day.",
          mode: "auto",
        });
        assert.strictEqual(overUser.outcome, "suggested");
        assert.strictEqual(
          (yield* context.readNote({ projectId, noteId: userNote.note!.id })).text,
          "Only on Fridays.",
        );

        yield* agentWrite({ projectId, threadId: own, title: "Ports", text: "3000", mode: "auto" });
        const limited = (yield* snapshotNow).notes.find(
          (entry) => entry.projectId === projectId && entry.title === "Ports",
        )!;
        const overOther = yield* agentWrite({
          projectId,
          threadId: other,
          title: "Ports",
          text: "4000",
          mode: "auto",
        });
        assert.strictEqual(overOther.outcome, "suggested");
        assert.strictEqual(
          (yield* context.readNote({ projectId, noteId: limited.id })).text,
          "3000",
        );

        const rewrite = yield* agentWrite({
          projectId,
          threadId: own,
          title: "Ports",
          text: "5000",
          mode: "auto",
        });
        assert.strictEqual(rewrite.outcome, "kept_limited");
        const after = yield* context.readNote({ projectId, noteId: limited.id });
        assert.strictEqual(after.text, "5000");
        assert.strictEqual(after.approved, false);
        assert.strictEqual(
          (yield* snapshotNow).suggestions.filter((entry) => entry.projectId === projectId).length,
          2,
        );
      }),
  );

  it.effect("a refusal at a limit names only the writer's own count", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-limits");
      const busy = ThreadId.make("thread-limits-busy");
      for (let index = 0; index < 5; index++) {
        const written = yield* agentWrite({
          projectId,
          threadId: busy,
          title: `Busy ${index}`,
          mode: "ask",
        });
        assert.strictEqual(written.outcome, "suggested");
      }
      const sixth = yield* agentWrite({ projectId, threadId: busy, title: "Busy 5", mode: "ask" });
      assert.strictEqual(sixth.outcome, "refused");
      assert.include(sixth.detail, "This thread has 5 notes waiting");
      assert.notInclude(sixth.detail, "40");

      // Other threads fill the project to 40.
      for (let index = 0; index < 35; index++) {
        const written = yield* agentWrite({
          projectId,
          threadId: ThreadId.make(`thread-limits-${Math.floor(index / 5)}`),
          title: `Other ${index}`,
          mode: "ask",
        });
        assert.strictEqual(written.outcome, "suggested");
      }
      const full = yield* agentWrite({
        projectId,
        threadId: ThreadId.make("thread-limits-late"),
        title: "Late",
        mode: "ask",
      });
      assert.strictEqual(full.outcome, "refused");
      assert.notMatch(full.detail, /\d/);
    }),
  );

  it.effect("with notes off a session still lists kept notes but is not told to write one", () =>
    Effect.gen(function* () {
      const context = yield* ProjectContext;
      const projectId = ProjectId.make("project-off");
      const threadId = ThreadId.make("thread-off");
      yield* addProject(projectId, "Off");
      yield* addThread(threadId, projectId);
      yield* context.changeNote({
        kind: "save",
        projectId,
        title: "Style",
        summary: "Tabs, not spaces",
        text: "Tabs.",
      });

      const off = yield* sessionText(threadId, "full-access", "off");
      assert.include(off, "- Style: Tabs, not spaces");
      assert.notInclude(off, "project_note_write");
      assert.include(yield* sessionText(threadId, "full-access", "ask"), "project_note_write");
    }),
  );
});

// Its own database: the startup check reads every project's suggestions.
it.layer(testLayer)("ProjectNotesUndo", (it) => {
  it.effect("undone turns' suggestions go, on a revert and at startup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = ProjectId.make("project-undo");
        const reverted = ThreadId.make("thread-undo");
        const restarted = ThreadId.make("thread-undo-restarted");
        const [turn1, turn2] = [TurnId.make("turn-undo-1"), TurnId.make("turn-undo-2")];
        const turns = yield* ProjectionTurnRepository;
        for (const [turnId, count] of [
          [turn1, 1],
          [turn2, 2],
        ] as const) {
          yield* turns.upsertByTurnId({
            threadId: reverted,
            turnId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: null,
            state: "completed",
            requestedAt: at,
            startedAt: at,
            completedAt: at,
            checkpointTurnCount: count,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
            checkpointThreadDiffStat: null,
            checkpointCompletedAt: null,
          });
        }
        const write = (threadId: ThreadId, title: string, turnId?: TurnId) =>
          agentWrite({ projectId, threadId, title, mode: "ask", ...(turnId ? { turnId } : {}) });
        yield* write(reverted, "First turn", turn1);
        yield* write(reverted, "Second turn", turn2);
        yield* write(reverted, "Outside a turn");
        // The last process stopped before it dropped this one: its turn is gone.
        yield* write(restarted, "Cut off", TurnId.make("turn-undo-gone"));

        const events = yield* Queue.unbounded<OrchestrationEvent>();
        const undo = yield* makeProjectNotesUndo.pipe(
          Effect.provide(
            Layer.mock(OrchestrationEngineService)({
              streamDomainEvents: Stream.fromQueue(events),
            }),
          ),
        );
        const waiting = Effect.map(snapshotNow, (snapshot) =>
          snapshot.suggestions.map((entry) => entry.title).toSorted(),
        );
        yield* undo.start();
        assert.deepStrictEqual(yield* waiting, ["First turn", "Outside a turn", "Second turn"]);

        yield* Queue.offer(events, {
          type: "thread.reverted",
          payload: { threadId: reverted, turnCount: 1 },
        } as unknown as OrchestrationEvent);
        const context = yield* ProjectContext;
        const after = yield* context.changes.pipe(
          Stream.filter((snapshot) => snapshot.suggestions.length === 2),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        );
        assert.deepStrictEqual(
          Option.getOrThrow(after)
            .suggestions.map((entry) => entry.title)
            .toSorted(),
          ["First turn", "Outside a turn"],
        );
      }),
    ),
  );
});
