import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-retry");

const failedSession: OrchestrationSession = {
  threadId,
  status: "error",
  providerName: "claudeAgent",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  providerSessionId: "provider-session-1",
  providerThreadId: "provider-thread-1",
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: "API Error: Unable to connect to API (ECONNRESET)",
  updatedAt: "2026-01-01T00:00:04.000Z",
};

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: threadId,
    projectId: ProjectId.make("project-retry"),
    title: "Retry",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-fable-5",
    },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    effectiveCwd: null,
    goal: null,
    latestTurn: {
      turnId: TurnId.make("turn-failed"),
      state: "error",
      requestedAt: "2026-01-01T00:00:01.000Z",
      startedAt: "2026-01-01T00:00:02.000Z",
      completedAt: "2026-01-01T00:00:03.000Z",
      assistantMessageId: null,
    },
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    pinnedAt: null,
    deletedAt: null,
    messages: [
      {
        id: MessageId.make("message-user-1"),
        role: "user",
        text: "first ask",
        turnId: null,
        streaming: false,
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: MessageId.make("message-assistant-1"),
        role: "assistant",
        text: "first answer",
        turnId: TurnId.make("turn-earlier"),
        streaming: false,
        createdAt: "2026-01-01T00:00:02.000Z",
        updatedAt: "2026-01-01T00:00:02.000Z",
      },
      {
        id: MessageId.make("message-user-2"),
        role: "user",
        text: "ask that failed",
        skills: [
          {
            name: "review",
            path: "/tmp/project/.codex/skills/review/SKILL.md",
          },
        ],
        turnId: null,
        streaming: false,
        createdAt: "2026-01-01T00:00:03.000Z",
        updatedAt: "2026-01-01T00:00:03.000Z",
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: failedSession,
    ...overrides,
  };
}

function makeReadModel(thread: OrchestrationThread): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: now,
    projects: [],
    threads: [thread],
  };
}

const retryCommand: Extract<OrchestrationCommand, { type: "thread.turn.retry" }> = {
  type: "thread.turn.retry",
  commandId: CommandId.make("cmd-turn-retry"),
  threadId,
  createdAt: "2026-01-01T00:00:05.000Z",
};

describe("decider turn retry", () => {
  it("re-requests the last user message without appending a new one", async () => {
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: retryCommand,
        readModel: makeReadModel(makeThread()),
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.type)).toEqual([
      "thread.session-set",
      "thread.turn-start-requested",
    ]);
    expect(events[0]).toMatchObject({
      payload: {
        threadId,
        session: {
          status: "starting",
          providerName: "claudeAgent",
          providerSessionId: "provider-session-1",
          activeTurnId: null,
          lastError: "API Error: Unable to connect to API (ECONNRESET)",
        },
      },
    });
    expect(events[1]).toMatchObject({
      causationEventId: events[0]?.eventId,
      payload: {
        threadId,
        messageId: MessageId.make("message-user-2"),
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        skills: [
          {
            name: "review",
            path: "/tmp/project/.codex/skills/review/SKILL.md",
          },
        ],
      },
    });
  });

  it("emits events the projector can apply", async () => {
    const readModel = makeReadModel(makeThread());
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: retryCommand,
        readModel,
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];

    let projected = readModel;
    let sequence = readModel.snapshotSequence;
    for (const event of events) {
      sequence += 1;
      projected = await Effect.runPromise(projectEvent(projected, { ...event, sequence }));
    }

    const thread = projected.threads.find((entry) => entry.id === threadId);
    expect(thread?.session).toMatchObject({
      status: "starting",
      activeTurnId: null,
      lastError: "API Error: Unable to connect to API (ECONNRESET)",
    });
    // Retry must not append a duplicate user bubble.
    expect(thread?.messages).toHaveLength(3);
  });

  it("rejects retrying while a turn is in flight", async () => {
    const runningThread = makeThread({
      session: {
        ...failedSession,
        status: "running",
        activeTurnId: TurnId.make("turn-active"),
      },
    });

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: retryCommand,
          readModel: makeReadModel(runningThread),
        }),
      ),
    ).rejects.toThrow("already has a turn in flight");
  });

  it("rejects retrying while a turn start is pending", async () => {
    const startingThread = makeThread({
      session: {
        ...failedSession,
        status: "starting",
      },
    });

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: retryCommand,
          readModel: makeReadModel(startingThread),
        }),
      ),
    ).rejects.toThrow("already has a turn in flight");
  });

  it("rejects retrying when the session has no error", async () => {
    const settledThread = makeThread({
      session: {
        ...failedSession,
        status: "ready",
        lastError: null,
      },
    });

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: retryCommand,
          readModel: makeReadModel(settledThread),
        }),
      ),
    ).rejects.toThrow("has no failed turn to retry");
  });

  it("rejects retrying a thread without user messages", async () => {
    const emptyThread = makeThread({ messages: [] });

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: retryCommand,
          readModel: makeReadModel(emptyThread),
        }),
      ),
    ).rejects.toThrow("has no user message to retry");
  });
});
