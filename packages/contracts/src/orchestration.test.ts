import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ChatAttachment,
  ChatAttachmentListLenient,
  ClientOrchestrationCommand,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ModelSelection,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationThreadSearchInput,
  OrchestrationGetTurnDiffInput,
  OrchestrationLatestTurn,
  ProjectCreatedPayload,
  ProjectMetaUpdatedPayload,
  OrchestrationProposedPlan,
  OrchestrationSession,
  ProjectCreateCommand,
  ThreadMetaUpdatedPayload,
  ThreadTurnStartCommand,
  ThreadCreatedPayload,
  ThreadForkContextPayload,
  ThreadTurnDiff,
  ThreadTurnStartRequestedPayload,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const decodeTurnDiffInput = Schema.decodeUnknownEffect(OrchestrationGetTurnDiffInput);
const decodeFullThreadDiffInput = Schema.decodeUnknownEffect(OrchestrationGetFullThreadDiffInput);
const decodeThreadSearchInput = Schema.decodeUnknownEffect(OrchestrationThreadSearchInput);
const decodeThreadTurnDiff = Schema.decodeUnknownEffect(ThreadTurnDiff);
const decodeProjectCreateCommand = Schema.decodeUnknownEffect(ProjectCreateCommand);
const decodeProjectCreatedPayload = Schema.decodeUnknownEffect(ProjectCreatedPayload);
const decodeProjectMetaUpdatedPayload = Schema.decodeUnknownEffect(ProjectMetaUpdatedPayload);
const decodeThreadTurnStartCommand = Schema.decodeUnknownEffect(ThreadTurnStartCommand);
const decodeThreadTurnStartRequestedPayload = Schema.decodeUnknownEffect(
  ThreadTurnStartRequestedPayload,
);
const decodeOrchestrationLatestTurn = Schema.decodeUnknownEffect(OrchestrationLatestTurn);
const decodeOrchestrationProposedPlan = Schema.decodeUnknownEffect(OrchestrationProposedPlan);
const decodeOrchestrationSession = Schema.decodeUnknownEffect(OrchestrationSession);
const encodeThreadCreatedPayload = Schema.encodeEffect(ThreadCreatedPayload);

function getOptionValue(
  options: ReadonlyArray<{ id: string; value: unknown }> | undefined,
  id: string,
): unknown {
  return options?.find((option) => option.id === id)?.value;
}
const decodeThreadCreatedPayload = Schema.decodeUnknownEffect(ThreadCreatedPayload);
const decodeChatAttachment = Schema.decodeUnknownEffect(ChatAttachment);
const decodeClientOrchestrationCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeOrchestrationCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeThreadMetaUpdatedPayload = Schema.decodeUnknownEffect(ThreadMetaUpdatedPayload);
const decodeThreadForkContextPayload = Schema.decodeUnknownEffect(ThreadForkContextPayload);

it.effect("parses turn diff input when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
    });
    assert.strictEqual(parsed.fromTurnCount, 1);
    assert.strictEqual(parsed.toTurnCount, 2);
  }),
);

it.effect("parses turn diff input with whitespace ignoring enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
      ignoreWhitespace: true,
    });
    assert.strictEqual(parsed.ignoreWhitespace, true);
  }),
);

it.effect("parses full thread diff input with whitespace ignoring enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeFullThreadDiffInput({
      threadId: "thread-1",
      toTurnCount: 2,
      ignoreWhitespace: true,
    });
    assert.strictEqual(parsed.ignoreWhitespace, true);
  }),
);

it.effect("trims and validates bounded thread search input", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadSearchInput({
      query: "  navbar spacing  ",
      projectIds: ["project-1"],
      limit: 25,
    });
    assert.strictEqual(parsed.query, "navbar spacing");
    assert.deepStrictEqual(parsed.projectIds, ["project-1"]);
    assert.strictEqual(parsed.limit, 25);
  }),
);

it.effect("rejects an empty thread search query", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(decodeThreadSearchInput({ query: "   ", limit: 25 }));
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("rejects turn diff input when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeTurnDiffInput({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("rejects thread turn diff when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeThreadTurnDiff({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
        diff: "patch",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims branded ids and command string fields at decode boundaries", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreateCommand({
      type: "project.create",
      commandId: " cmd-1 ",
      projectId: " project-1 ",
      title: " Project Title ",
      workspaceRoot: " /tmp/workspace ",
      defaultModelSelection: {
        provider: "codex",
        model: " gpt-5.2 ",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.commandId, "cmd-1");
    assert.strictEqual(parsed.projectId, "project-1");
    assert.strictEqual(parsed.title, "Project Title");
    assert.strictEqual(parsed.workspaceRoot, "/tmp/workspace");
    assert.strictEqual(parsed.createWorkspaceRootIfMissing, undefined);
    assert.deepStrictEqual(parsed.defaultModelSelection, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.2",
    });
  }),
);

it.effect("decodes project.create with createWorkspaceRootIfMissing enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreateCommand({
      type: "project.create",
      commandId: "cmd-1",
      projectId: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      createWorkspaceRootIfMissing: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.createWorkspaceRootIfMissing, true);
  }),
);

it.effect("decodes historical project.created payloads with a default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.instanceId, "codex");
  }),
);

it.effect("decodes project.meta-updated payloads with explicit default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectMetaUpdatedPayload({
      projectId: "project-1",
      defaultModelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.instanceId, "claudeAgent");
  }),
);

it.effect("rejects command fields that become empty after trim", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeProjectCreateCommand({
        type: "project.create",
        commandId: "cmd-1",
        projectId: "project-1",
        title: "  ",
        workspaceRoot: "/tmp/workspace",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes thread.turn.start defaults for provider and runtime mode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-1",
      threadId: "thread-1",
      message: {
        messageId: "msg-1",
        role: "user",
        text: "hello",
        attachments: [],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection, undefined);
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("preserves structured skill references in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-skill",
      threadId: "thread-1",
      message: {
        messageId: "msg-skill",
        role: "user",
        text: "Use $review",
        attachments: [],
        skills: [
          {
            name: "review",
            path: "/tmp/project/.codex/skills/review/SKILL.md",
          },
        ],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.deepStrictEqual(parsed.message.skills, [
      {
        name: "review",
        path: "/tmp/project/.codex/skills/review/SKILL.md",
      },
    ]);
  }),
);

it.effect("preserves explicit provider and runtime mode in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-2",
      threadId: "thread-1",
      message: {
        messageId: "msg-2",
        role: "user",
        text: "hello",
        attachments: [],
      },
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.instanceId, "codex");
    assert.strictEqual(parsed.runtimeMode, "full-access");
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("accepts bootstrap metadata in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-bootstrap",
      threadId: "thread-1",
      message: {
        messageId: "msg-bootstrap",
        role: "user",
        text: "hello",
        attachments: [],
      },
      bootstrap: {
        createThread: {
          projectId: "project-1",
          title: "Bootstrap thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        prepareWorktree: {
          projectCwd: "/tmp/workspace",
          baseBranch: "main",
          branch: "t3code/example",
        },
        runSetupScript: true,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.bootstrap?.createThread?.projectId, "project-1");
    assert.strictEqual(parsed.bootstrap?.prepareWorktree?.baseBranch, "main");
    assert.strictEqual(parsed.bootstrap?.runSetupScript, true);
  }),
);

it.effect("decodes thread.created runtime mode for historical events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread title",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.modelSelection.instanceId, "codex");
  }),
);

it.effect("decodes thread.meta-updated payloads with explicit provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadMetaUpdatedPayload({
      threadId: "thread-1",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.instanceId, "claudeAgent");
  }),
);

it.effect("decodes thread archive, unarchive, pin, and unpin commands", () =>
  Effect.gen(function* () {
    const archive = yield* decodeOrchestrationCommand({
      type: "thread.archive",
      commandId: "cmd-archive-1",
      threadId: "thread-1",
    });
    const unarchive = yield* decodeOrchestrationCommand({
      type: "thread.unarchive",
      commandId: "cmd-unarchive-1",
      threadId: "thread-1",
    });
    const pin = yield* decodeOrchestrationCommand({
      type: "thread.pin",
      commandId: "cmd-pin-1",
      threadId: "thread-1",
    });
    const unpin = yield* decodeOrchestrationCommand({
      type: "thread.unpin",
      commandId: "cmd-unpin-1",
      threadId: "thread-1",
    });

    assert.strictEqual(archive.type, "thread.archive");
    assert.strictEqual(unarchive.type, "thread.unarchive");
    assert.strictEqual(pin.type, "thread.pin");
    assert.strictEqual(unpin.type, "thread.unpin");
  }),
);

it.effect("decodes thread archived, unarchived, pinned, and unpinned events", () =>
  Effect.gen(function* () {
    const archived = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-archive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.archived",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-archive-1",
      causationEventId: null,
      correlationId: "cmd-archive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        archivedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const unarchived = yield* decodeOrchestrationEvent({
      sequence: 2,
      eventId: "event-unarchive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.unarchived",
      occurredAt: "2026-01-02T00:00:00.000Z",
      commandId: "cmd-unarchive-1",
      causationEventId: null,
      correlationId: "cmd-unarchive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });
    const pinned = yield* decodeOrchestrationEvent({
      sequence: 3,
      eventId: "event-pin-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.pinned",
      occurredAt: "2026-01-03T00:00:00.000Z",
      commandId: "cmd-pin-1",
      causationEventId: null,
      correlationId: "cmd-pin-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        pinnedAt: "2026-01-03T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
    });
    const unpinned = yield* decodeOrchestrationEvent({
      sequence: 4,
      eventId: "event-unpin-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.unpinned",
      occurredAt: "2026-01-04T00:00:00.000Z",
      commandId: "cmd-unpin-1",
      causationEventId: null,
      correlationId: "cmd-unpin-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        updatedAt: "2026-01-04T00:00:00.000Z",
      },
    });

    if (archived.type !== "thread.archived") {
      throw new Error(`Expected thread.archived, got ${archived.type}`);
    }
    assert.strictEqual(archived.payload.archivedAt, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(unarchived.type, "thread.unarchived");
    if (pinned.type !== "thread.pinned") {
      throw new Error(`Expected thread.pinned, got ${pinned.type}`);
    }
    assert.strictEqual(pinned.payload.pinnedAt, "2026-01-03T00:00:00.000Z");
    assert.strictEqual(unpinned.type, "thread.unpinned");
  }),
);

it.effect("accepts provider-scoped model options in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-options",
      threadId: "thread-1",
      message: {
        messageId: "msg-options",
        role: "user",
        text: "hello",
        attachments: [],
      },
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.instanceId, "codex");
    assert.strictEqual(getOptionValue(parsed.modelSelection?.options, "reasoningEffort"), "high");
    assert.strictEqual(getOptionValue(parsed.modelSelection?.options, "fastMode"), true);
  }),
);

it.effect("normalizes legacy object-shaped modelSelection.options on decode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Legacy options thread",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          effort: "max",
          fastMode: true,
          // Falsy/garbage entries are dropped, matching migration 026.
          emptyStr: "   ",
          nullish: null,
          nested: { foo: 1 },
        },
      },
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.modelSelection.instanceId, ProviderInstanceId.make("claudeAgent"));
    assert.deepStrictEqual(parsed.modelSelection.options, [
      { id: "effort", value: "max" },
      { id: "fastMode", value: true },
    ]);
  }),
);

it.effect("normalizes legacy object-shaped defaultModelSelection.options on decode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: "project-1",
      title: "Legacy default project",
      workspaceRoot: "/tmp/legacy",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
        options: { reasoningEffort: "low" },
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.deepStrictEqual(parsed.defaultModelSelection?.options, [
      { id: "reasoningEffort", value: "low" },
    ]);
  }),
);

it.effect(
  "normalizes legacy object-shaped options on decode and re-encodes as canonical array",
  () =>
    Effect.gen(function* () {
      const decoded = yield* decodeThreadCreatedPayload({
        threadId: "thread-1",
        projectId: "project-1",
        title: "Round trip thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
          options: { fastMode: true },
        },
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const encoded = yield* encodeThreadCreatedPayload(decoded);
      assert.deepStrictEqual(encoded.modelSelection.options, [{ id: "fastMode", value: true }]);
    }),
);

it.effect("accepts a title seed in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-title-seed",
      threadId: "thread-1",
      message: {
        messageId: "msg-title-seed",
        role: "user",
        text: "hello",
        attachments: [],
      },
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

it.effect("accepts a source proposed plan reference in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-source-plan",
      threadId: "thread-2",
      message: {
        messageId: "msg-source-plan",
        role: "user",
        text: "implement this",
        attachments: [],
      },
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes thread.fork client command defaults", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeClientOrchestrationCommand({
      type: "thread.fork",
      commandId: "cmd-fork-1",
      threadId: "thread-fork",
      sourceThreadId: "thread-source",
      sourceMessageId: "msg-source",
      message: {
        messageId: "msg-fork",
        role: "user",
        text: "Continue from here",
      },
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      workspaceMode: "current",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.type, "thread.fork");
    if (parsed.type !== "thread.fork") {
      return;
    }
    assert.strictEqual(parsed.includeAttachments, true);
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
    assert.strictEqual(parsed.modelSelection.instanceId, "codex");
    assert.strictEqual(parsed.workspaceMode, "current");
  }),
);

it.effect("decodes thread fork context payload", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadForkContextPayload({
      sourceThreadId: "thread-source",
      sourceThreadTitle: "Source thread",
      sourceMessageId: "msg-source",
      sourceMessageRole: "assistant",
      sourceMessageText: "Use this result",
      sourceMessageCreatedAt: "2026-01-01T00:00:00.000Z",
      workspaceMode: "current",
      includedMessageCount: 3,
      includedToolSummaryCount: 1,
      includedAttachmentCount: 1,
      omittedAttachmentCount: 2,
      contextText: "carried context",
      attachments: [
        {
          type: "image",
          id: "threadfork_attachment_1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 12,
        },
      ],
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.4",
      },
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    assert.strictEqual(parsed.workspaceMode, "current");
    assert.strictEqual(parsed.attachments.length, 1);
    assert.strictEqual(parsed.omittedAttachmentCount, 2);
  }),
);

it.effect(
  "decodes thread.turn-start-requested defaults for provider, runtime mode, and interaction mode",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeThreadTurnStartRequestedPayload({
        threadId: "thread-1",
        messageId: "msg-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      assert.strictEqual(parsed.modelSelection, undefined);
      assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
      assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
      assert.strictEqual(parsed.sourceProposedPlan, undefined);
      assert.strictEqual(parsed.providerContext, undefined);
      assert.strictEqual(parsed.providerAttachments, undefined);
    }),
);

it.effect("decodes thread.turn-start-requested source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes thread.turn-start-requested title seed when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

it.effect("decodes thread.turn-start-requested provider context when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-fork",
      messageId: "msg-fork",
      providerContext: "background context",
      providerAttachments: [
        {
          type: "image",
          id: "threadfork_attachment_2",
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 24,
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.providerContext, "background context");
    assert.strictEqual(parsed.providerAttachments?.[0]?.name, "screen.png");
  }),
);

it.effect("decodes latest turn source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationLatestTurn({
      turnId: "turn-2",
      state: "running",
      requestedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes orchestration session runtime mode defaults", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationSession({
      threadId: "thread-1",
      status: "idle",
      providerName: null,
      providerSessionId: null,
      providerThreadId: null,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
  }),
);

it.effect("defaults proposed plan implementation metadata for historical rows", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-1",
      turnId: "turn-1",
      planMarkdown: "# Plan",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, null);
    assert.strictEqual(parsed.implementationThreadId, null);
  }),
);

it.effect("preserves proposed plan implementation metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-2",
      turnId: "turn-2",
      planMarkdown: "# Plan",
      implementedAt: "2026-01-02T00:00:00.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, "2026-01-02T00:00:00.000Z");
    assert.strictEqual(parsed.implementationThreadId, "thread-2");
  }),
);

// ── ModelSelection: instance-keyed wire shape + legacy decoder ────────
//
// `ModelSelection` is routing-keyed on `instanceId` — never a driver kind.
// Persisted and in-flight payloads from pre-instance builds carry a
// `provider` field whose value was a driver kind; those payloads are migrated
// at the wire boundary by
// promoting `provider` to the default instance id for that driver
// (built-in drivers use the driver kind slug as their default instance id, so
// the migration is a 1:1 rename).
//
// These tests pin the rollback/fork tolerance invariant: legacy payloads
// decode cleanly for fork-provided drivers, and the decoded form uses
// `instanceId` uniformly regardless of origin.

const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);
const encodeModelSelection = Schema.encodeUnknownEffect(ModelSelection);

it.effect("ModelSelection migrates legacy `provider` field to `instanceId`", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      model: "gpt-5-codex",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex"));
    assert.strictEqual(parsed.model, "gpt-5-codex");
    assert.deepStrictEqual(parsed.options, [{ id: "reasoningEffort", value: "high" }]);
  }),
);

it.effect("ModelSelection accepts an explicit instanceId routing key", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

it.effect("ModelSelection prefers explicit instanceId over legacy provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

it.effect(
  "ModelSelection decodes unknown driver kinds via legacy provider (rollback / fork invariant)",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeModelSelection({
        provider: "ollama",
        model: "llama3:70b",
        options: [{ id: "temperature", value: "0.4" }],
      });
      assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("ollama"));
      assert.strictEqual(parsed.model, "llama3:70b");
    }),
);

it.effect("ModelSelection encodes to the canonical instanceId wire form", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeModelSelection({
      provider: "ollama",
      model: "llama3:70b",
      options: [{ id: "temperature", value: "0.4" }],
    });
    const encoded = yield* encodeModelSelection(decoded);
    assert.deepStrictEqual(encoded, {
      instanceId: "ollama",
      model: "llama3:70b",
      options: [{ id: "temperature", value: "0.4" }],
    });
  }),
);

it.effect("ModelSelection rejects malformed instance ids", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeModelSelection({
        instanceId: "1invalid", // must start with a letter
        model: "x",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

const decodeLenientAttachments = Schema.decodeUnknownEffect(ChatAttachmentListLenient);
const encodeLenientAttachments = Schema.encodeEffect(ChatAttachmentListLenient);

it.effect("ChatAttachmentListLenient keeps decodable attachments and drops unknown kinds", () =>
  Effect.gen(function* () {
    const image = {
      type: "image",
      id: "attachment-1",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 1024,
    };
    const file = {
      type: "file",
      kind: "pdf",
      id: "attachment-2",
      name: "datasheet.pdf",
      mimeType: "application/pdf",
      sizeBytes: 689467,
    };
    const newerBuildKind = {
      type: "file",
      kind: "archive",
      id: "attachment-3",
      name: "bundle.zip",
      mimeType: "application/zip",
      sizeBytes: 4096,
    };
    const decoded = yield* decodeLenientAttachments([
      file,
      image,
      newerBuildKind,
      { garbage: true },
    ]);
    assert.deepStrictEqual(decoded, [file, image]);
  }),
);

it.effect("ChatAttachmentListLenient round-trips retained attachments on encode", () =>
  Effect.gen(function* () {
    const image = {
      type: "image",
      id: "attachment-1",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 1024,
    };
    const decoded = yield* decodeLenientAttachments([image]);
    const encoded = yield* encodeLenientAttachments(decoded);
    assert.deepStrictEqual(encoded, [image]);
  }),
);

it.effect("ChatAttachment decodes persisted image attachments (back-compat)", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeChatAttachment({
      type: "image",
      id: "thread-1-00000000-0000-4000-8000-000000000001",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 1024,
    });
    assert.strictEqual(parsed.type, "image");
  }),
);

it.effect("ChatAttachment decodes file attachments with a kind", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeChatAttachment({
      type: "file",
      kind: "pdf",
      id: "thread-1-00000000-0000-4000-8000-000000000002",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
    });
    assert.strictEqual(parsed.type, "file");
    if (parsed.type === "file") {
      assert.strictEqual(parsed.kind, "pdf");
    }
  }),
);

it.effect("ChatAttachment rejects unknown file kinds", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeChatAttachment({
        type: "file",
        kind: "archive",
        id: "thread-1-00000000-0000-4000-8000-000000000003",
        name: "bundle.zip",
        mimeType: "application/zip",
        sizeBytes: 2048,
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);
