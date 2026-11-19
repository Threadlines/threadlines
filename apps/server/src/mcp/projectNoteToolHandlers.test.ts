import {
  EnvironmentId,
  GENERAL_CHATS_PROJECT_ID,
  type LeadPassCeiling,
  type OrchestrationThread,
  ProjectId,
  type ProjectNotesMode,
  ProviderInstanceId,
  type RuntimeMode,
  SideTurnId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectBriefRepositoryLive } from "../projectContext/ProjectBriefRepository.ts";
import { ProjectContext, ProjectContextLive } from "../projectContext/ProjectContext.ts";
import { ProjectNoteRepositoryLive } from "../projectContext/ProjectNoteRepository.ts";
import type { McpInvocationScope } from "./McpSessionRegistry.ts";
import { makeProjectNoteToolHandlers } from "./projectNoteToolHandlers.ts";
import { roomToolsFor } from "./roomToolAccess.ts";

const layer = it.layer(
  ProjectContextLive.pipe(
    Layer.provideMerge(ProjectBriefRepositoryLive),
    Layer.provideMerge(ProjectNoteRepositoryLive),
    Layer.provideMerge(ProjectionProjectRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const at = "2026-11-18T00:00:00.000Z";

const addProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectionProjectRepository, (projects) =>
    projects.upsert({
      projectId,
      kind: "workspace",
      title: projectId,
      workspaceRoot: `/tmp/${projectId}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    }),
  );

/** A thread whose own agent is running a turn, so a write latches it at once. */
const makeThread = (
  id: string,
  projectId: ProjectId,
  extra: {
    readonly runtimeMode?: RuntimeMode;
    readonly passCeiling?: LeadPassCeiling;
    readonly fenced?: boolean;
  } = {},
): OrchestrationThread =>
  ({
    id: ThreadId.make(id),
    projectId,
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    runtimeMode: extra.runtimeMode ?? "full-access",
    interactionMode: "default",
    session: {
      threadId: ThreadId.make(id),
      status: "running",
      providerName: "codex",
      participantId: null,
      activeTurnId: TurnId.make(`${id}-turn`),
      lastError: null,
      updatedAt: at,
    },
    participants: [],
    childRequests: { passCeiling: extra.passCeiling },
    remoteOrigin:
      extra.fenced === true
        ? {
            linkDeviceId: "device-windows",
            environmentId: EnvironmentId.make("env-windows"),
            environmentLabel: "Windows PC",
            threadId: ThreadId.make("windows-parent"),
            threadTitle: "Ship the release",
          }
        : null,
    archivedAt: null,
    deletedAt: null,
  }) as unknown as OrchestrationThread;

const caller = (thread: OrchestrationThread, side?: "ask"): McpInvocationScope => ({
  threadId: thread.id,
  sessionKey: thread.id,
  participantId: null,
  generation: 1,
  agentId: "agent-test",
  browser: true,
  pages: true,
  commands: false,
  roomTools: new Set(roomToolsFor(side)),
  ...(side !== undefined ? { side: { sideTurnId: SideTurnId.make("side-1"), kind: side } } : {}),
});

/**
 * The tools over the real ProjectContext. `runtimes` is the access each
 * thread's runtime actually runs with; a thread missing from it runs none.
 */
const harness = (
  threads: ReadonlyArray<OrchestrationThread>,
  runtimes: ReadonlyMap<ThreadId, RuntimeMode>,
  mode: () => ProjectNotesMode,
) =>
  Effect.map(ProjectContext, (context) =>
    makeProjectNoteToolHandlers({
      readThread: (threadId) => Effect.succeed(threads.find((thread) => thread.id === threadId)),
      context,
      notesMode: Effect.sync(mode),
      runtimeModeOf: (sessionKey) => Effect.succeed(runtimes.get(sessionKey)),
      modelNameOf: (selection) => Effect.succeed(selection.model),
    }),
  );

const write = (title: string, text = `${title} text`) => ({
  title,
  summary: `About ${title}`,
  text,
});

const notesOf = (projectId: ProjectId) =>
  Effect.flatMap(ProjectContext, (context) =>
    context.changes.pipe(
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.map((snapshot) => ({
        notes: snapshot.notes.filter((note) => note.projectId === projectId),
        suggestions: snapshot.suggestions.filter((entry) => entry.projectId === projectId),
      })),
    ),
  );

layer("project note tools", (it) => {
  it.effect("a suggestion can't be read by its title until the user keeps it", () =>
    Effect.gen(function* () {
      const context = yield* ProjectContext;
      const projectId = ProjectId.make("project-tools-ask");
      yield* addProject(projectId);
      const writer = makeThread("ask-writer", projectId);
      const reader = makeThread("ask-reader", projectId);
      const tools = yield* harness([writer, reader], new Map(), () => "ask");

      const written = yield* tools.project_note_write(caller(writer), write("Release steps"));
      assert.strictEqual(written.outcome, "suggested");
      const read = yield* tools.project_note_read(caller(reader), { title: "Release steps" });
      assert.strictEqual(read.outcome, "not_found");

      const { suggestions } = yield* notesOf(projectId);
      assert.strictEqual(suggestions[0]?.turnId, "ask-writer-turn");
      yield* context.changeNote({
        kind: "resolveSuggestion",
        projectId,
        suggestionId: suggestions[0]!.id,
        decision: "keep",
      });
      const kept = yield* tools.project_note_read(caller(reader), { title: "release steps" });
      assert.deepInclude(kept, {
        outcome: "found",
        text: "Release steps text",
        writtenBy: 'gpt-6.1-sol, in the thread "Thread ask-writer"',
      });
    }),
  );

  it.effect("a note kept without asking is read only by runtimes within its writer's access", () =>
    Effect.gen(function* () {
      const context = yield* ProjectContext;
      const projectId = ProjectId.make("project-tools-auto");
      yield* addProject(projectId);
      const writer = makeThread("auto-writer", projectId, { runtimeMode: "auto-accept-edits" });
      const within = makeThread("auto-within", projectId, { runtimeMode: "approval-required" });
      // Lowered while its runtime kept Full access: the runtime is what counts.
      const lowered = makeThread("auto-lowered", projectId, { runtimeMode: "auto-accept-edits" });
      // No runtime the server can name: taken to be Full access.
      const unknown = makeThread("auto-unknown", projectId, { runtimeMode: "approval-required" });
      const tools = yield* harness(
        [writer, within, lowered, unknown],
        new Map([
          [writer.id, "auto-accept-edits"],
          [within.id, "approval-required"],
          [lowered.id, "full-access"],
        ]),
        () => "auto",
      );

      const written = yield* tools.project_note_write(caller(writer), write("Ports"));
      assert.strictEqual(written.outcome, "kept_limited");
      const readBy = (thread: OrchestrationThread) =>
        Effect.map(
          tools.project_note_read(caller(thread), { title: "Ports" }),
          (result) => result.outcome,
        );
      assert.strictEqual(yield* readBy(writer), "found");
      assert.strictEqual(yield* readBy(within), "found");
      assert.strictEqual(yield* readBy(lowered), "not_found");
      assert.strictEqual(yield* readBy(unknown), "not_found");

      const { notes } = yield* notesOf(projectId);
      yield* context.changeNote({
        kind: "approve",
        projectId,
        noteId: notes[0]!.id,
        updatedAt: notes[0]!.updatedAt,
      });
      assert.strictEqual(yield* readBy(lowered), "found");
      assert.strictEqual(yield* readBy(unknown), "found");
    }),
  );

  it.effect(
    "a write carries the narrowest of the thread's, the runtime's and a pass's access",
    () =>
      Effect.gen(function* () {
        const projectId = ProjectId.make("project-tools-ceiling");
        // Stored at Full, started at less (an early start at another level).
        const earlyStart = makeThread("ceiling-early", projectId);
        const onPass = makeThread("ceiling-pass", projectId, {
          passCeiling: { runtimeMode: "approval-required", interactionMode: "default" },
        });
        const tools = yield* harness(
          [earlyStart, onPass],
          new Map([
            [earlyStart.id, "auto"],
            [onPass.id, "full-access"],
          ]),
          () => "auto",
        );

        yield* tools.project_note_write(caller(earlyStart), write("Early"));
        yield* tools.project_note_write(caller(onPass), write("Pass"));
        const { notes } = yield* notesOf(projectId);
        assert.deepStrictEqual(
          notes.map((note) => [note.title, note.writerCeiling?.runtimeMode]),
          [
            ["Early", "auto"],
            ["Pass", "approval-required"],
          ],
        );
      }),
  );

  it.effect(
    "refuses writes with notes off, and both tools to side runtimes and closed threads",
    () =>
      Effect.gen(function* () {
        const context = yield* ProjectContext;
        const projectId = ProjectId.make("project-tools-refused");
        yield* addProject(projectId);
        yield* context.changeNote({
          kind: "save",
          projectId,
          title: "Style",
          summary: "Tabs",
          text: "Tabs.",
        });
        const open = makeThread("refused-open", projectId);
        const general = makeThread("refused-general", GENERAL_CHATS_PROJECT_ID);
        const fenced = makeThread("refused-fenced", projectId, { fenced: true });
        let mode: ProjectNotesMode = "off";
        const tools = yield* harness([open, general, fenced], new Map(), () => mode);

        const off = yield* tools.project_note_write(caller(open), write("Off"));
        assert.strictEqual(off.outcome, "refused");
        assert.include(off.detail, "turned project notes off");
        // Kept notes still go out.
        const read = yield* tools.project_note_read(caller(open), { title: "Style" });
        assert.strictEqual(read.outcome, "found");

        mode = "auto";
        for (const [thread, side] of [
          [open, "ask"],
          [general, undefined],
          [fenced, undefined],
        ] as const) {
          const scope = caller(thread, side);
          assert.strictEqual(
            (yield* tools.project_note_write(scope, write("Closed"))).outcome,
            "refused",
          );
          assert.strictEqual(
            (yield* tools.project_note_read(scope, { title: "Style" })).outcome,
            "refused",
          );
        }
        const { notes, suggestions } = yield* notesOf(projectId);
        assert.deepStrictEqual(
          notes.map((note) => note.title),
          ["Style"],
        );
        assert.strictEqual(suggestions.length, 0);
      }),
  );
});
