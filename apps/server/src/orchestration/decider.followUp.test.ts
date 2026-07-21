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
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
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
});
