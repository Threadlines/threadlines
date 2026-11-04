import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadParticipantId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThreadActivity,
  EMPTY_AGENT_REQUEST_STATE,
  EMPTY_CHILD_REQUEST_STATE,
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

  describe("questions answered with a message", () => {
    const question = (
      requestId: string,
      eventSequence: number,
      extra: { readonly payload?: object; readonly participantId?: ThreadParticipantId },
    ): OrchestrationThreadActivity => ({
      id: EventId.make(`activity-${requestId}`),
      eventSequence,
      tone: "info",
      kind: "user-input.requested",
      summary: "User input requested",
      payload: {
        requestId,
        questions: [
          {
            id: "question-1",
            header: "Question",
            question: "Postgres or SQLite?",
            options: [],
            multiSelect: false,
          },
        ],
        isBlocking: false,
        ...extra.payload,
      },
      turnId: TurnId.make("turn-follow-up"),
      ...(extra.participantId !== undefined ? { participantId: extra.participantId } : {}),
      createdAt: "2026-01-01T00:00:02.500Z",
    });
    const [thread] = readModelAfterProviderDelivery.threads;
    // The turn is over with three questions open: one its own agent asked to
    // be answered with a message, one answered through the provider, and one
    // another agent in the room asked.
    const readModel: OrchestrationReadModel = {
      ...readModelAfterProviderDelivery,
      threads: [
        {
          ...thread!,
          proposedPlans: [
            {
              id: "plan-waiting",
              turnId: TurnId.make("turn-follow-up"),
              planMarkdown: "# Plan",
              implementedAt: null,
              implementationThreadId: null,
              dismissedAt: null,
              createdAt: now,
              updatedAt: now,
            },
          ],
          activities: [
            question("async-own", 1, { payload: { responseMode: "message" } }),
            question("provider-answered", 2, {}),
            question("async-other-agent", 3, {
              payload: { responseMode: "message" },
              participantId: ThreadParticipantId.make("agent-b"),
            }),
          ],
          queuedFollowUps: [
            {
              messageId: MessageId.make("message-queued-earlier"),
              text: "and the docs",
              attachments: [],
              composer: "typed",
              runtimeMode: "approval-required",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              createdAt: "2026-01-01T00:00:02.000Z",
            },
          ],
        },
      ],
    };
    const decide = async (command: OrchestrationCommand) => {
      const decided = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
      return (Array.isArray(decided) ? decided : [decided]).flatMap((event) =>
        event.type === "thread.activity-appended" &&
        event.payload.activity.kind === "user-input.resolved"
          ? [event.payload.activity.payload]
          : [],
      );
    };
    const typed = (messageId: string) => ({
      messageId: MessageId.make(messageId),
      role: "user" as const,
      text: "Postgres, and keep going",
      attachments: [],
    });

    it("a message the user types closes its agent's open ones", async () => {
      const closing = { requestId: "async-own", reason: "user-message" };
      expect(
        await decide({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-typed-turn"),
          threadId: ThreadId.make("thread-follow-up"),
          message: typed("message-typed-turn"),
          composer: "typed",
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: "2026-01-01T00:00:05.000Z",
        }),
      ).toEqual([closing]);
      // Typed with a plan waiting, which the turn implements.
      expect(
        await decide({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-typed-plan-turn"),
          threadId: ThreadId.make("thread-follow-up"),
          message: typed("message-typed-plan-turn"),
          composer: "typed",
          sourceProposedPlan: {
            threadId: ThreadId.make("thread-follow-up"),
            planId: "plan-waiting",
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: "2026-01-01T00:00:05.000Z",
        }),
      ).toEqual([closing]);
      // Typed while the agent works: queued or steered, the same.
      expect(
        await decide({
          type: "thread.follow-up.submit",
          commandId: CommandId.make("cmd-typed-follow-up"),
          threadId: ThreadId.make("thread-follow-up"),
          turnId: TurnId.make("turn-follow-up"),
          message: typed("message-typed-follow-up"),
          composer: "typed",
          createdAt: "2026-01-01T00:00:05.000Z",
        }),
      ).toEqual([closing]);
    });

    it("a message the user did not just type leaves them open", async () => {
      // Words the user did not write (an agent's, the server's automation).
      expect(
        await decide({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-untyped-turn"),
          threadId: ThreadId.make("thread-follow-up"),
          message: typed("message-untyped-turn"),
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: "2026-01-01T00:00:05.000Z",
        }),
      ).toEqual([]);
      // A steer that missed its turn, queued again after the question came.
      expect(
        await decide({
          type: "thread.follow-up.submit",
          commandId: CommandId.make("cmd-requeued"),
          threadId: ThreadId.make("thread-follow-up"),
          turnId: TurnId.make("turn-follow-up"),
          message: typed("message-requeued"),
          delivery: "queue",
          composer: "typed",
          requeued: true,
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      ).toEqual([]);
      // A message queued before the question, sent once the turn is over.
      expect(
        await decide({
          type: "thread.follow-up.send-queued",
          commandId: CommandId.make("cmd-send-queued-earlier"),
          threadId: ThreadId.make("thread-follow-up"),
          messageId: MessageId.make("message-queued-earlier"),
          createdAt: "2026-01-01T00:00:05.000Z",
        }),
      ).toEqual([]);
    });
  });
});
