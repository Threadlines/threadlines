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
  EMPTY_AGENT_REQUEST_STATE,
  EMPTY_CHILD_REQUEST_STATE,
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
    pullRequestAutoFix: false,
    pullRequestAutoMerge: null,
    linkedPullRequests: [],
    agentRequests: EMPTY_AGENT_REQUEST_STATE,
    parentThreadId: null,
    parentTurnId: null,
    attachedToParent: false,
    parentAttachmentEpoch: 0,
    handedBackAt: null,
    handedBackTurnId: null,
    archivedWithParentAt: null,
    childRequests: EMPTY_CHILD_REQUEST_STATE,
    participants: [],
    doneOverride: null,
    lastSeenAt: null,
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
    diffStatBaselineTurnCount: 0,
    session: failedSession,
    ...overrides,
  };
}

function makeReadModel(thread: OrchestrationThread): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: now,
    projects: [
      {
        id: thread.projectId,
        kind: "workspace",
        title: "Retry",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
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
  it("retries the turn's own message, not an invite or a steer that came during it", async () => {
    const thread = makeThread();
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: retryCommand,
        readModel: makeReadModel({
          ...thread,
          messages: [
            ...thread.messages,
            {
              id: MessageId.make("message-invite"),
              role: "user",
              text: "Check the retry math.",
              fromAgent: { participantId: null },
              requestKind: "invite",
              turnId: null,
              streaming: false,
              createdAt: "2026-01-01T00:00:03.500Z",
              updatedAt: "2026-01-01T00:00:03.500Z",
            },
            // The user steered this into the turn before it failed.
            {
              id: MessageId.make("message-steer"),
              role: "user",
              text: "also update the docs",
              turnId: TurnId.make("turn-failed"),
              streaming: false,
              createdAt: "2026-01-01T00:00:03.700Z",
              updatedAt: "2026-01-01T00:00:03.700Z",
            },
          ],
        }),
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];
    expect(
      events.find((event) => event.type === "thread.turn-start-requested")?.payload,
    ).toMatchObject({ messageId: MessageId.make("message-user-2") });
  });

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
        providerMessageId: expect.any(String),
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
    if (events[1]?.type !== "thread.turn-start-requested") {
      throw new Error("Expected retry turn start event.");
    }
    expect(events[1].payload.providerMessageId).not.toBe(events[1].payload.messageId);
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

  it("keeps a closed error closed until the session fails again", async () => {
    const run = async (readModel: OrchestrationReadModel, command: OrchestrationCommand) => {
      const decided = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
      const events = Array.isArray(decided) ? decided : [decided];
      let projected = readModel;
      for (const event of events) {
        projected = await Effect.runPromise(
          projectEvent(projected, { ...event, sequence: projected.snapshotSequence + 1 }),
        );
      }
      return { events, session: projected.threads[0]?.session ?? null, readModel: projected };
    };
    const dismiss = (lastError: string, lastErrorAt: string | null, createdAt: string) =>
      ({
        type: "thread.error.dismiss",
        commandId: CommandId.make(`cmd-dismiss-${createdAt}`),
        threadId,
        lastError,
        lastErrorAt,
        createdAt,
      }) as const;
    const setSession = (session: OrchestrationSession) =>
      ({
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-session-${session.status}-${session.updatedAt}`),
        threadId,
        session,
        createdAt: session.updatedAt,
      }) as const;
    const failure = failedSession.lastError ?? "";

    // A close aimed at an error the user never saw does nothing.
    const stale = await run(
      makeReadModel(makeThread()),
      dismiss("an older error", null, "2026-01-01T00:00:04.500Z"),
    );
    expect(stale.events).toEqual([]);

    const closed = await run(
      makeReadModel(makeThread()),
      dismiss(failure, null, "2026-01-01T00:00:04.500Z"),
    );
    expect(closed.session?.lastErrorDismissedAt).toBe("2026-01-01T00:00:04.500Z");

    // The session stopping, and the retry starting, carry the same failure.
    const stopped = await run(
      closed.readModel,
      setSession({ ...failedSession, status: "stopped", updatedAt: "2026-01-01T00:00:05.000Z" }),
    );
    expect(stopped.session?.lastErrorDismissedAt).toBe("2026-01-01T00:00:04.500Z");
    const retried = await run(stopped.readModel, {
      ...retryCommand,
      createdAt: "2026-01-01T00:00:06.000Z",
    });
    expect(retried.session).toMatchObject({
      status: "starting",
      lastError: failure,
      lastErrorDismissedAt: "2026-01-01T00:00:04.500Z",
    });

    // Stopping the retry before it starts is not a new failure.
    const stoppedWhileStarting = await run(
      retried.readModel,
      setSession({ ...failedSession, status: "stopped", updatedAt: "2026-01-01T00:00:06.500Z" }),
    );
    expect(stoppedWhileStarting.session?.lastErrorDismissedAt).toBe("2026-01-01T00:00:04.500Z");
    const retriedAgain = await run(stoppedWhileStarting.readModel, {
      ...retryCommand,
      createdAt: "2026-01-01T00:00:06.700Z",
    });

    // The retry failing to start the same way is a new failure, so it shows,
    // even though a start failure leaves the session `ready`: its writer says so.
    const failedAgain = await run(
      retriedAgain.readModel,
      setSession({
        ...failedSession,
        status: "ready",
        lastErrorAt: "2026-01-01T00:00:07.000Z",
        updatedAt: "2026-01-01T00:00:07.000Z",
      }),
    );
    expect(failedAgain.session).toMatchObject({
      lastError: failure,
      lastErrorAt: "2026-01-01T00:00:07.000Z",
    });
    expect(failedAgain.session?.lastErrorDismissedAt).toBeUndefined();

    // A close sent for the first failure, landing after the second, leaves
    // the second showing.
    const late = await run(
      failedAgain.readModel,
      dismiss(failure, null, "2026-01-01T00:00:07.500Z"),
    );
    expect(late.events).toEqual([]);
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

describe("decider continue at reset", () => {
  const run = async (readModel: OrchestrationReadModel, command: OrchestrationCommand) => {
    const decided = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
    const events = Array.isArray(decided) ? decided : [decided];
    let projected = readModel;
    for (const event of events) {
      projected = await Effect.runPromise(
        projectEvent(projected, { ...event, sequence: projected.snapshotSequence + 1 }),
      );
    }
    return { events, session: projected.threads[0]?.session ?? null, readModel: projected };
  };
  const limitText = "You've hit your session limit · resets 2:20pm (America/New_York)";
  const resetsAt = "2026-01-01T05:00:00.000Z";
  // A usage limit landing on the thread's failed turn, as ingestion records it.
  const limitHit = (settingOn: boolean, at = "2026-01-01T00:00:04.000Z") =>
    ({
      type: "thread.session.set",
      commandId: CommandId.make(`cmd-limit-${at}`),
      threadId,
      session: { ...failedSession, lastError: limitText, updatedAt: at },
      usageLimit: { window: "session", resetsAt },
      continueAfterUsageLimits: settingOn,
      createdAt: at,
    }) as const;
  const typed = (thread: OrchestrationThread): OrchestrationThread => ({
    ...thread,
    session: null,
    messages: thread.messages.map((message) =>
      message.role === "user" ? { ...message, composer: "typed" as const } : message,
    ),
  });
  const fire = (lastErrorAt: string, createdAt: string) =>
    ({
      type: "thread.continue-at-reset.fire",
      commandId: CommandId.make(`cmd-fire-${createdAt}`),
      threadId,
      lastErrorAt,
      messageId: MessageId.make(`message-continue-${createdAt}`),
      createdAt,
    }) as const;

  it("waits for a limit the user's own turn hit only when the setting is on", async () => {
    const off = await run(makeReadModel(typed(makeThread())), limitHit(false));
    expect(off.session?.lastErrorUsageLimit).toEqual({ window: "session", resetsAt });
    expect(off.session?.continueAtReset).toBeUndefined();

    const on = await run(makeReadModel(typed(makeThread())), limitHit(true));
    expect(on.session?.continueAtReset).toEqual({ resetsAt, at: "2026-01-01T05:01:00.000Z" });

    // A turn another thread's agent asked for doesn't belong to the user.
    const requested = await run(makeReadModel(makeThread({ session: null })), limitHit(true));
    expect(requested.session?.continueAtReset).toBeUndefined();
  });

  it("continues with a new message at reset, unless the user sent one first", async () => {
    const armed = await run(makeReadModel(typed(makeThread())), limitHit(true));
    const lastErrorAt = armed.session?.lastErrorAt ?? "";

    const continued = await run(armed.readModel, fire(lastErrorAt, "2026-01-01T05:01:30.000Z"));
    expect(continued.session?.continueAtReset).toBeUndefined();
    expect(continued.session?.status).toBe("starting");
    const sent = continued.readModel.threads[0]?.messages.at(-1);
    expect(sent).toMatchObject({
      role: "user",
      text: "Continue where you left off.",
      trigger: "usageLimitReset",
    });
    expect(continued.events.map((event) => event.type)).toContain("thread.turn-start-requested");

    // The user's own message lands first: the wait is over and the fire refused.
    const userSent = await run(armed.readModel, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-user-send"),
      threadId,
      message: {
        messageId: MessageId.make("message-user-3"),
        role: "user",
        text: "keep going",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: "2026-01-01T05:01:00.000Z",
    });
    expect(userSent.session?.continueAtReset).toBeUndefined();
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: fire(lastErrorAt, "2026-01-01T05:01:30.000Z"),
          readModel: userSent.readModel,
        }),
      ),
    ).rejects.toThrow("no longer waiting");
  });

  it("lets the user's message overtake a continue on its way, never both", async () => {
    const armed = await run(makeReadModel(typed(makeThread())), limitHit(true));
    const continued = await run(
      armed.readModel,
      fire(armed.session?.lastErrorAt ?? "", "2026-01-01T05:01:30.000Z"),
    );
    const continueId = MessageId.make("message-continue-2026-01-01T05:01:30.000Z");
    const userSend = (createdAt: string) =>
      ({
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-user-${createdAt}`),
        threadId,
        message: {
          messageId: MessageId.make(`message-user-${createdAt}`),
          role: "user",
          text: "actually, stop and fix the tests",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        composer: "typed",
        createdAt,
      }) as const;

    // Still starting: the user's message waits, marked to overtake it; no second start.
    const starting = await run(continued.readModel, userSend("2026-01-01T05:01:31.000Z"));
    expect(starting.events.map((event) => event.type)).not.toContain("thread.turn-start-requested");
    const queued = starting.readModel.threads[0]?.queuedFollowUps ?? [];
    expect(queued).toMatchObject([{ overtakes: continueId }]);

    // The continue never reached the agent: it is marked not sent.
    const skipped = await run(starting.readModel, {
      type: "thread.continue-at-reset.skip",
      commandId: CommandId.make("cmd-skip"),
      threadId,
      messageId: continueId,
      createdAt: "2026-01-01T05:01:32.000Z",
    });
    expect(skipped.readModel.threads[0]?.messages.find((m) => m.id === continueId)).toMatchObject({
      notSent: true,
    });

    // It did reach the agent and its turn runs: the queued message is steered in.
    const steered = await run(starting.readModel, {
      type: "thread.follow-up.send-queued",
      commandId: CommandId.make("cmd-steer-overtaking"),
      threadId,
      messageId: MessageId.make("message-user-2026-01-01T05:01:31.000Z"),
      steerIntoTurnId: TurnId.make("turn-continue"),
      createdAt: "2026-01-01T05:01:33.000Z",
    });
    expect(
      steered.events.find((event) => event.type === "thread.follow-up-submitted")?.payload,
    ).toMatchObject({
      turnId: TurnId.make("turn-continue"),
      text: "actually, stop and fix the tests",
    });

    // Sent while the continue's turn already runs: a steer into that turn.
    const running = {
      ...continued.readModel,
      threads: continued.readModel.threads.map((thread) => ({
        ...thread,
        session:
          thread.session === null
            ? null
            : {
                ...thread.session,
                status: "running" as const,
                activeTurnId: TurnId.make("turn-continue"),
              },
      })),
    };
    const late = await run(running, userSend("2026-01-01T05:01:40.000Z"));
    expect(late.events.map((event) => event.type)).toContain("thread.follow-up-submitted");
    expect(late.events.map((event) => event.type)).not.toContain("thread.turn-start-requested");
  });

  it("keeps a continued thread going after its next limit, without the setting", async () => {
    const armed = await run(makeReadModel(typed(makeThread())), limitHit(true));
    const continued = await run(
      armed.readModel,
      fire(armed.session?.lastErrorAt ?? "", "2026-01-01T05:01:30.000Z"),
    );
    const again = await run(continued.readModel, {
      ...limitHit(false, "2026-01-01T05:30:00.000Z"),
      usageLimit: { window: "weekly", resetsAt: "2026-01-03T00:00:00.000Z" },
    });
    expect(again.session?.continueAtReset).toEqual({
      resetsAt: "2026-01-03T00:00:00.000Z",
      at: "2026-01-03T00:01:00.000Z",
    });
  });

  it("turned on after the reset passed, continues at the next check; archiving ends the wait", async () => {
    const hit = await run(makeReadModel(typed(makeThread())), limitHit(false));
    const lastErrorAt = hit.session?.lastErrorAt ?? "";
    const late = await run(hit.readModel, {
      type: "thread.continue-at-reset.set",
      commandId: CommandId.make("cmd-switch-on"),
      threadId,
      lastErrorAt,
      enabled: true,
      createdAt: "2026-01-01T06:00:00.000Z",
    });
    expect(late.session?.continueAtReset).toEqual({ resetsAt, at: "2026-01-01T06:00:00.000Z" });

    const archived = await run(late.readModel, {
      type: "thread.archive",
      commandId: CommandId.make("cmd-archive"),
      threadId,
    });
    expect(archived.session?.continueAtReset).toBeUndefined();
  });
});
