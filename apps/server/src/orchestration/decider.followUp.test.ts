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
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-01-01T00:00:00.000Z";

const readModelAfterProviderDelivery: OrchestrationReadModel = {
  snapshotSequence: 1,
  updatedAt: now,
  projects: [],
  threads: [
    {
      id: ThreadId.make("thread-follow-up"),
      projectId: ProjectId.make("project-follow-up"),
      title: "Follow Up",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      effectiveCwd: null,
      goal: null,
      latestTurn: {
        turnId: TurnId.make("turn-follow-up"),
        state: "completed",
        requestedAt: "2026-01-01T00:00:01.000Z",
        startedAt: "2026-01-01T00:00:02.000Z",
        completedAt: "2026-01-01T00:00:03.000Z",
        assistantMessageId: MessageId.make("assistant-follow-up"),
      },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      pinnedAt: null,
      pullRequestAutoFix: false,
      pullRequestAutoMerge: null,
      linkedPullRequests: [],
      doneOverride: null,
      lastSeenAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      diffStatBaselineTurnCount: 0,
      session: {
        threadId: ThreadId.make("thread-follow-up"),
        status: "ready",
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-01-01T00:00:04.000Z",
      },
    },
  ],
};

describe("decider follow-up flows", () => {
  it("records accepted follow-ups after the active provider session settles", async () => {
    const command: Extract<OrchestrationCommand, { type: "thread.follow-up.accept" }> = {
      type: "thread.follow-up.accept",
      commandId: CommandId.make("cmd-follow-up-accept"),
      threadId: ThreadId.make("thread-follow-up"),
      turnId: TurnId.make("turn-follow-up"),
      message: {
        messageId: MessageId.make("message-follow-up"),
        role: "user",
        text: "steer the turn",
        attachments: [],
      },
      createdAt: "2026-01-01T00:00:05.000Z",
    };

    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command,
        readModel: readModelAfterProviderDelivery,
      }),
    );
    const event = Array.isArray(decided) ? decided[0] : decided;

    expect(event).toMatchObject({
      type: "thread.follow-up-accepted",
      payload: {
        threadId: ThreadId.make("thread-follow-up"),
        turnId: TurnId.make("turn-follow-up"),
        messageId: MessageId.make("message-follow-up"),
        role: "user",
        text: "steer the turn",
      },
    });
  });

  it("queues a steer whose turn already ended instead of refusing it", async () => {
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.follow-up.submit",
          commandId: CommandId.make("cmd-late-steer"),
          threadId: ThreadId.make("thread-follow-up"),
          turnId: TurnId.make("turn-follow-up"),
          message: {
            messageId: MessageId.make("message-late-steer"),
            role: "user",
            text: "one more thing",
            attachments: [],
          },
          createdAt: "2026-01-01T00:00:05.000Z",
        },
        readModel: readModelAfterProviderDelivery,
      }),
    );

    expect(decided).toMatchObject({
      type: "thread.follow-up-queued",
      payload: {
        followUp: {
          messageId: MessageId.make("message-late-steer"),
          text: "one more thing",
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        },
      },
    });
  });

  it("sends a queued message as a turn and takes it out of the queue in one step", async () => {
    const [thread] = readModelAfterProviderDelivery.threads;
    const readModel: OrchestrationReadModel = {
      ...readModelAfterProviderDelivery,
      threads: [
        {
          ...thread!,
          queuedFollowUps: [
            {
              messageId: MessageId.make("message-queued"),
              text: "now plan the next step",
              attachments: [],
              runtimeMode: "approval-required",
              interactionMode: "plan",
              createdAt: "2026-01-01T00:00:02.500Z",
            },
          ],
        },
      ],
    };

    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.follow-up.send-queued",
          commandId: CommandId.make("cmd-send-queued"),
          threadId: ThreadId.make("thread-follow-up"),
          messageId: MessageId.make("message-queued"),
          createdAt: "2026-01-01T00:00:05.000Z",
        },
        readModel,
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];

    expect(events.map((event) => event.type)).toEqual([
      "thread.follow-up-unqueued",
      "thread.interaction-mode-set",
      "thread.message-sent",
      "thread.session-set",
      "thread.turn-start-requested",
    ]);
    expect(events[2]).toMatchObject({
      payload: {
        messageId: MessageId.make("message-queued"),
        createdAt: "2026-01-01T00:00:05.000Z",
      },
    });
    expect(events[4]).toMatchObject({ payload: { interactionMode: "plan" } });

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.follow-up.send-queued",
            commandId: CommandId.make("cmd-send-queued-again"),
            threadId: ThreadId.make("thread-follow-up"),
            messageId: MessageId.make("message-queued"),
            createdAt: "2026-01-01T00:00:06.000Z",
          },
          readModel: readModelAfterProviderDelivery,
        }),
      ),
    ).rejects.toThrow(/not queued/);
  });
});
