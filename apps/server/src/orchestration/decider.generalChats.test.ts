import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { resolveThreadProviderCwd } from "./generalChats.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

async function seedGeneralChatsReadModel(): Promise<OrchestrationReadModel> {
  const initial = createEmptyReadModel(now);
  return Effect.runPromise(
    projectEvent(initial, {
      sequence: 1,
      eventId: asEventId("evt-general-chats-create"),
      aggregateKind: "project",
      aggregateId: asProjectId("project-general-chats"),
      type: "project.created",
      occurredAt: now,
      commandId: asCommandId("cmd-general-chats-create"),
      causationEventId: null,
      correlationId: asCommandId("cmd-general-chats-create"),
      metadata: {},
      payload: {
        projectId: asProjectId("project-general-chats"),
        kind: "general-chat",
        title: "General Chats",
        workspaceRoot: "/tmp/state/general-chats",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

async function decide(command: OrchestrationCommand, readModel: OrchestrationReadModel) {
  return Effect.runPromise(
    Effect.flip(decideOrchestrationCommand({ command, readModel })).pipe(
      Effect.catch(() => Effect.succeed(null)),
    ),
  );
}

describe("decider general chats guards", () => {
  it("creates general chat threads without branches or worktrees", async () => {
    const readModel = await seedGeneralChatsReadModel();
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.create",
          commandId: asCommandId("cmd-thread-create"),
          threadId: asThreadId("thread-general-1"),
          projectId: asProjectId("project-general-chats"),
          title: "New General Chat",
          modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events[0]?.type).toBe("thread.created");
  });

  it("rejects general chat threads with branch or worktree options", async () => {
    const readModel = await seedGeneralChatsReadModel();
    const error = await decide(
      {
        type: "thread.create",
        commandId: asCommandId("cmd-thread-create-branch"),
        threadId: asThreadId("thread-general-2"),
        projectId: asProjectId("project-general-chats"),
        title: "New General Chat",
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: "feature/nope",
        worktreePath: null,
        createdAt: now,
      },
      readModel,
    );

    expect(error?._tag).toBe("OrchestrationCommandInvariantError");
    expect(error?.detail).toContain("General Chat threads do not support branches or worktrees");
  });

  it("rejects project.meta.update against the general chats project", async () => {
    const readModel = await seedGeneralChatsReadModel();
    const error = await decide(
      {
        type: "project.meta.update",
        commandId: asCommandId("cmd-meta-update"),
        projectId: asProjectId("project-general-chats"),
        scripts: [],
      },
      readModel,
    );

    expect(error?._tag).toBe("OrchestrationCommandInvariantError");
    expect(error?.detail).toContain("system General Chats project");
  });

  it("rejects project.delete against the general chats project", async () => {
    const readModel = await seedGeneralChatsReadModel();
    const error = await decide(
      {
        type: "project.delete",
        commandId: asCommandId("cmd-project-delete"),
        projectId: asProjectId("project-general-chats"),
      },
      readModel,
    );

    expect(error?._tag).toBe("OrchestrationCommandInvariantError");
    expect(error?.detail).toContain("system General Chats project");
  });
});

function makeThread(input: {
  id: string;
  projectId: string;
  messageId: string;
}): OrchestrationThread {
  return {
    id: asThreadId(input.id),
    projectId: asProjectId(input.projectId),
    title: "Chat about auth",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    pinnedAt: null,
    deletedAt: null,
    messages: [
      {
        id: MessageId.make(input.messageId),
        role: "user",
        text: "How should auth tokens rotate?",
        turnId: null,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function makeForkCommand(input: {
  sourceThreadId: string;
  sourceMessageId: string;
  targetProjectId: string;
}): OrchestrationCommand {
  return {
    type: "thread.fork",
    commandId: asCommandId("cmd-fork"),
    threadId: asThreadId("thread-forked"),
    sourceThreadId: asThreadId(input.sourceThreadId),
    sourceMessageId: MessageId.make(input.sourceMessageId),
    message: {
      messageId: MessageId.make("message-fork"),
      role: "user",
      text: "Continue this in the project.",
    },
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    workspaceMode: "current",
    includeAttachments: true,
    createdAt: now,
    projectId: asProjectId(input.targetProjectId),
    title: "Continued: Chat about auth",
    branch: null,
    worktreePath: null,
    forkContext: {
      sourceThreadId: asThreadId(input.sourceThreadId),
      sourceThreadTitle: "Chat about auth",
      sourceMessageId: MessageId.make(input.sourceMessageId),
      sourceMessageRole: "user",
      sourceMessageText: "How should auth tokens rotate?",
      sourceMessageCreatedAt: now,
      workspaceMode: "current",
      includedMessageCount: 1,
      includedToolSummaryCount: 0,
      includedAttachmentCount: 0,
      omittedAttachmentCount: 0,
      contextText: "context",
      attachments: [],
      modelSelection,
      createdAt: now,
    },
    providerContext: "context",
    providerAttachments: [],
  };
}

async function seedContinueInProjectReadModel(sourceProjectKind: "general-chat" | "workspace") {
  const base = await seedGeneralChatsReadModel();
  const withWorkspaceProject = await Effect.runPromise(
    projectEvent(base, {
      sequence: 2,
      eventId: asEventId("evt-workspace-create"),
      aggregateKind: "project",
      aggregateId: asProjectId("project-workspace"),
      type: "project.created",
      occurredAt: now,
      commandId: asCommandId("cmd-workspace-create"),
      causationEventId: null,
      correlationId: asCommandId("cmd-workspace-create"),
      metadata: {},
      payload: {
        projectId: asProjectId("project-workspace"),
        kind: "workspace",
        title: "Workspace Project",
        workspaceRoot: "/repos/workspace-project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
  const sourceProjectId =
    sourceProjectKind === "general-chat" ? "project-general-chats" : "project-workspace";
  return {
    ...withWorkspaceProject,
    threads: [
      makeThread({
        id: "thread-source",
        projectId: sourceProjectId,
        messageId: "message-source",
      }),
    ],
  } satisfies OrchestrationReadModel;
}

describe("decider continue-in-project forks", () => {
  it("allows cross-project forks from general chat threads", async () => {
    const readModel = await seedContinueInProjectReadModel("general-chat");
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: makeForkCommand({
          sourceThreadId: "thread-source",
          sourceMessageId: "message-source",
          targetProjectId: "project-workspace",
        }),
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events[0]?.type).toBe("thread.created");
    expect(
      events[0]?.type === "thread.created" &&
        (events[0].payload as { projectId: string }).projectId,
    ).toBe("project-workspace");
  });

  it("rejects cross-project forks from workspace threads", async () => {
    const readModel = await seedContinueInProjectReadModel("workspace");
    const error = await decide(
      makeForkCommand({
        sourceThreadId: "thread-source",
        sourceMessageId: "message-source",
        targetProjectId: "project-general-chats",
      }),
      readModel,
    );

    expect(error?._tag).toBe("OrchestrationCommandInvariantError");
    expect(error?.detail).toContain("belongs to a different project");
  });
});

describe("resolveThreadProviderCwd", () => {
  const path = {
    join: (...segments: Array<string>) => segments.join("/"),
  } as Pick<Path.Path, "join">;

  it("uses a per-thread scratch cwd for general chat threads", () => {
    const cwd = resolveThreadProviderCwd({
      thread: {
        id: asThreadId("thread-general-1"),
        projectId: asProjectId("project-general-chats"),
        worktreePath: null,
      },
      project: {
        id: asProjectId("project-general-chats"),
        kind: "general-chat",
        workspaceRoot: "/tmp/state/general-chats",
      },
      path,
    });

    expect(cwd).toBe("/tmp/state/general-chats/threads/thread-general-1");
  });

  it("uses the workspace root for workspace threads", () => {
    const cwd = resolveThreadProviderCwd({
      thread: {
        id: asThreadId("thread-a"),
        projectId: asProjectId("project-a"),
        worktreePath: null,
      },
      project: {
        id: asProjectId("project-a"),
        kind: "workspace",
        workspaceRoot: "/repos/project-a",
      },
      path,
    });

    expect(cwd).toBe("/repos/project-a");
  });

  it("prefers the worktree path for workspace threads that have one", () => {
    const cwd = resolveThreadProviderCwd({
      thread: {
        id: asThreadId("thread-a"),
        projectId: asProjectId("project-a"),
        worktreePath: "/worktrees/project-a/thread-a",
      },
      project: {
        id: asProjectId("project-a"),
        kind: "workspace",
        workspaceRoot: "/repos/project-a",
      },
      path,
    });

    expect(cwd).toBe("/worktrees/project-a/thread-a");
  });
});
