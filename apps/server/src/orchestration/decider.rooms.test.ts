import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SIDE_ANSWER_OUTCOME_ACTIVITY_KIND,
  SideTurnId,
  ThreadId,
  ThreadParticipantId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-room");
const astraId = ThreadParticipantId.make("7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d");

const astra = {
  id: astraId,
  handle: "astra",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
  joinedAt: now,
  leftAt: null,
};

function session(overrides: Partial<OrchestrationSession> = {}): OrchestrationSession {
  return {
    threadId,
    status: "ready",
    providerName: "claudeAgent",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: now,
    ...overrides,
  };
}

function readModel(overrides: Partial<OrchestrationThread> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: now,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project-room"),
        title: "Room",
        modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "fable-5-1" },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        effectiveCwd: null,
        goal: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        pinnedAt: null,
        pullRequestAutoFix: false,
        pullRequestAutoMerge: null,
        linkedPullRequests: [],
        participants: [astra],
        doneOverride: null,
        lastSeenAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        diffStatBaselineTurnCount: 0,
        session: session(),
        ...overrides,
      },
    ],
  };
}

function turnStart(
  participantId: ThreadParticipantId | null,
): Extract<OrchestrationCommand, { type: "thread.turn.start" }> {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make("cmd-turn"),
    threadId,
    message: {
      messageId: MessageId.make("message-turn"),
      role: "user",
      text: "take a look",
      attachments: [],
    },
    participantId,
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: "2026-01-01T00:00:05.000Z",
  };
}

const decide = (command: OrchestrationCommand, model: OrchestrationReadModel) =>
  Effect.runPromiseExit(decideOrchestrationCommand({ command, readModel: model }));

async function decideEvents(
  command: OrchestrationCommand,
  model: OrchestrationReadModel,
): Promise<ReadonlyArray<Omit<OrchestrationEvent, "sequence">>> {
  const decided = await Effect.runPromise(
    decideOrchestrationCommand({ command, readModel: model }),
  );
  return Array.isArray(decided)
    ? (decided as ReadonlyArray<Omit<OrchestrationEvent, "sequence">>)
    : [decided as Omit<OrchestrationEvent, "sequence">];
}

describe("decider rooms", () => {
  it("adds an agent and refuses a second one with the same handle", async () => {
    const add = (id: string, handle: string): OrchestrationCommand => ({
      type: "thread.participant.add",
      commandId: CommandId.make(`cmd-add-${id}`),
      threadId,
      participant: {
        id: ThreadParticipantId.make(id),
        handle,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-sol" },
      },
      createdAt: now,
    });

    const [added] = await decideEvents(
      add("1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e", "sol"),
      readModel(),
    );
    expect(added).toMatchObject({
      type: "thread.participant-added",
      payload: {
        participant: { id: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e", handle: "sol", leftAt: null },
      },
    });

    const duplicate = await decide(
      add("2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f", "ASTRA"),
      readModel(),
    );
    expect(Exit.isFailure(duplicate)).toBe(true);
  });

  it("hands the session slot to the addressed agent", async () => {
    const events = await decideEvents(turnStart(astraId), readModel());

    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.session-set",
      "thread.turn-start-requested",
    ]);
    expect(events[0]?.payload).toMatchObject({ role: "user", participantId: astraId });
    // The previous holder's provider ids describe a different runtime.
    expect(events[1]?.payload).toMatchObject({
      session: {
        status: "starting",
        participantId: astraId,
        providerName: null,
        providerSessionId: null,
        providerInstanceId: "codex",
      },
    });
    expect(events[2]?.payload).toMatchObject({ participantId: astraId });
  });

  it("hands the slot back with the thread's own agent's provider, so a switch is still seen", async () => {
    const events = await decideEvents(
      {
        ...turnStart(null),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-sol" },
      },
      readModel({
        session: session({
          participantId: astraId,
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
        }),
      }),
    );
    // Not the requested provider: the reactor compares the two to decide on a handoff.
    expect(events[1]?.payload).toMatchObject({
      session: { participantId: null, providerInstanceId: "claudeAgent" },
    });
  });

  it("refuses another agent while the slot holder is still working", async () => {
    const running = await decide(
      turnStart(astraId),
      readModel({ session: session({ status: "running", activeTurnId: TurnId.make("turn-1") }) }),
    );
    expect(Exit.isFailure(running)).toBe(true);

    const backgroundWork = await decide(
      turnStart(astraId),
      readModel({
        session: session({ pendingBackgroundTaskCount: 1, awaitedBackgroundTaskCount: 1 }),
      }),
    );
    expect(Exit.isFailure(backgroundWork)).toBe(true);

    // A dev server it left running is not work it will wake up for.
    const devServer = await decide(
      turnStart(astraId),
      readModel({
        session: session({ pendingBackgroundTaskCount: 1, awaitedBackgroundTaskCount: 0 }),
      }),
    );
    expect(Exit.isSuccess(devServer)).toBe(true);

    // The holder itself keeps its existing behavior.
    const sameAgent = await decide(
      turnStart(null),
      readModel({ session: session({ status: "running", activeTurnId: TurnId.make("turn-1") }) }),
    );
    expect(Exit.isSuccess(sameAgent)).toBe(true);
  });

  it("queues a message for another agent instead of steering the one at work", async () => {
    const running = readModel({
      session: session({ status: "running", activeTurnId: TurnId.make("turn-1") }),
    });
    const [queued] = await decideEvents(
      {
        type: "thread.follow-up.submit",
        commandId: CommandId.make("cmd-follow-up"),
        threadId,
        turnId: TurnId.make("turn-1"),
        message: {
          messageId: MessageId.make("message-for-astra"),
          role: "user",
          text: "look at this next",
          attachments: [],
        },
        participantId: astraId,
        createdAt: now,
      },
      running,
    );
    expect(queued).toMatchObject({
      type: "thread.follow-up-queued",
      payload: { followUp: { messageId: "message-for-astra", participantId: astraId } },
    });

    // Released once the turn is over, it goes to the agent it waited for.
    const idleWithQueue = readModel({
      queuedFollowUps: [
        {
          messageId: MessageId.make("message-for-astra"),
          text: "look at this next",
          attachments: [],
          participantId: astraId,
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        },
      ],
    });
    const released = await decideEvents(
      {
        type: "thread.follow-up.send-queued",
        commandId: CommandId.make("cmd-send-queued"),
        threadId,
        messageId: MessageId.make("message-for-astra"),
        createdAt: now,
      },
      idleWithQueue,
    );
    expect(
      released.find((event) => event.type === "thread.turn-start-requested")?.payload,
    ).toMatchObject({ participantId: astraId });
  });

  it("stamps agent messages with the slot holder as author", async () => {
    const [event] = await decideEvents(
      {
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-delta"),
        threadId,
        messageId: MessageId.make("assistant-1"),
        delta: "Looks good.",
        createdAt: now,
      },
      readModel({ session: session({ participantId: astraId, status: "running" }) }),
    );
    expect(event?.payload).toMatchObject({ role: "assistant", participantId: astraId });
  });

  it("keeps the author ingestion saw even after the slot moves on", async () => {
    // The slot already went back to the thread's own agent, but this late
    // flush came from the added agent's runtime.
    const [event] = await decideEvents(
      {
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-complete"),
        threadId,
        messageId: MessageId.make("assistant-2"),
        participantId: astraId,
        completesTurn: true,
        createdAt: now,
      },
      readModel({ session: session({ status: "starting" }) }),
    );
    expect(event?.payload).toMatchObject({ role: "assistant", participantId: astraId });
  });

  it("has no revert in a room", async () => {
    const reverted = await decide(
      {
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert"),
        threadId,
        turnCount: 1,
        createdAt: now,
      },
      readModel(),
    );
    expect(Exit.isFailure(reverted)).toBe(true);
  });

  it("keeps a working agent in the room until its turn ends", async () => {
    const remove: OrchestrationCommand = {
      type: "thread.participant.remove",
      commandId: CommandId.make("cmd-remove"),
      threadId,
      participantId: astraId,
      createdAt: now,
    };
    const whileWorking = await decide(
      remove,
      readModel({ session: session({ participantId: astraId, status: "running" }) }),
    );
    expect(Exit.isFailure(whileWorking)).toBe(true);

    const [removed] = await decideEvents(remove, readModel());
    expect(removed).toMatchObject({
      type: "thread.participant-removed",
      payload: { participantId: astraId },
    });
  });

  it("names any agent, and keeps an added agent's reasoning on it", async () => {
    const update = (
      participantId: ThreadParticipantId | null,
      change: {
        readonly role?: string | null;
        readonly modelOptions?: [] | [{ id: string; value: string }];
      },
    ): OrchestrationCommand => ({
      type: "thread.participant.update",
      commandId: CommandId.make("cmd-update"),
      threadId,
      participantId,
      ...change,
      createdAt: now,
    });
    const [renamed] = await decideEvents(
      update(astraId, {
        role: "Reviewer",
        modelOptions: [{ id: "reasoningEffort", value: "high" }],
      }),
      readModel(),
    );
    expect(renamed).toMatchObject({
      type: "thread.participant-updated",
      payload: {
        participantId: astraId,
        role: "Reviewer",
        modelSelection: {
          instanceId: astra.modelSelection.instanceId,
          model: astra.modelSelection.model,
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      },
    });
    // The thread's own agent can be named; its options live with the thread.
    expect(Exit.isSuccess(await decide(update(null, { role: "Researcher" }), readModel()))).toBe(
      true,
    );
    expect(
      Exit.isFailure(
        await decide(
          update(null, { modelOptions: [{ id: "reasoningEffort", value: "high" }] }),
          readModel(),
        ),
      ),
    ).toBe(true);
  });

  describe("side answers", () => {
    const sideTurnId = SideTurnId.make("0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70");
    const working = session({ status: "running", activeTurnId: TurnId.make("turn-1") });
    const ask = (
      participantId: ThreadParticipantId | null,
    ): Extract<OrchestrationCommand, { type: "thread.side-turn.start" }> => ({
      type: "thread.side-turn.start",
      commandId: CommandId.make("cmd-side"),
      threadId,
      sideTurnId,
      participantId,
      message: { messageId: MessageId.make("message-side"), role: "user", text: "is this right?" },
      createdAt: "2026-01-01T00:00:05.000Z",
    });
    const answering = {
      sideTurnId,
      participantId: astraId,
      messageId: MessageId.make("message-side"),
      status: "running" as const,
      startedAt: now,
    };

    it("asks another agent while one works, with the question outside any turn", async () => {
      const [question, started] = await decideEvents(ask(astraId), readModel({ session: working }));
      expect(question).toMatchObject({
        type: "thread.message-sent",
        payload: { participantId: astraId, sideTurnId, turnId: null, role: "user" },
      });
      expect(started).toMatchObject({
        type: "thread.side-turn-started",
        payload: {
          sideTurn: { sideTurnId, participantId: astraId, status: "starting" },
          modelSelection: astra.modelSelection,
        },
      });
    });

    it("refuses a side answer from the agent holding the thread, or a second one", async () => {
      // The thread's own agent holds it: that is a normal message.
      expect(Exit.isFailure(await decide(ask(null), readModel({ session: working })))).toBe(true);
      // An id already used: it would pick up that answer's late words.
      const earlierQuestion = {
        id: MessageId.make("message-earlier"),
        role: "user" as const,
        text: "earlier",
        participantId: astraId,
        sideTurnId,
        turnId: null,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      };
      expect(
        Exit.isFailure(
          await decide(ask(astraId), readModel({ session: working, messages: [earlierQuestion] })),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          await decide(ask(astraId), readModel({ session: working, sideTurn: answering })),
        ),
      ).toBe(true);
      // Outside a room there is no one else to ask.
      expect(
        Exit.isFailure(
          await decide(ask(astraId), readModel({ participants: [], session: working })),
        ),
      ).toBe(true);
    });

    it("keeps an answering agent from taking the thread or leaving it", async () => {
      const model = readModel({ sideTurn: answering });
      expect(Exit.isFailure(await decide(turnStart(astraId), model))).toBe(true);
      expect(
        Exit.isFailure(
          await decide(
            {
              type: "thread.participant.remove",
              commandId: CommandId.make("cmd-remove"),
              threadId,
              participantId: astraId,
              createdAt: now,
            },
            model,
          ),
        ),
      ).toBe(true);
    });

    const sideAnswer = (text: string, streaming: boolean) => ({
      id: MessageId.make("answer"),
      role: "assistant" as const,
      text,
      participantId: astraId,
      sideTurnId,
      turnId: null,
      streaming,
      createdAt: now,
      updatedAt: now,
    });

    it("ignores a stop or finish for a side answer that is not the current one", async () => {
      const stale = SideTurnId.make("11111111-2222-4333-8444-555566667777");
      const model = readModel({ sideTurn: answering, messages: [sideAnswer("Yes.", false)] });
      expect(
        Exit.isFailure(
          await decide(
            {
              type: "thread.side-turn.settle",
              commandId: CommandId.make("cmd-settle"),
              threadId,
              sideTurnId: stale,
              outcome: "completed",
              createdAt: now,
            },
            model,
          ),
        ),
      ).toBe(true);
      const [settled] = await decideEvents(
        {
          type: "thread.side-turn.settle",
          commandId: CommandId.make("cmd-settle-current"),
          threadId,
          sideTurnId,
          outcome: "completed",
          answerMessageId: MessageId.make("answer"),
          createdAt: now,
        },
        model,
      );
      expect(settled).toMatchObject({
        type: "thread.side-turn-settled",
        payload: {
          sideTurnId,
          participantId: astraId,
          outcome: "completed",
          answerMessageId: "answer",
        },
      });
    });

    it("finishes a stopped answer in one step and takes nothing after it", async () => {
      const halfWritten = sideAnswer("The cap is", true);
      const events = await decideEvents(
        {
          type: "thread.side-turn.settle",
          commandId: CommandId.make("cmd-settle-stop"),
          threadId,
          sideTurnId,
          outcome: "interrupted",
          createdAt: now,
        },
        readModel({ sideTurn: answering, messages: [halfWritten] }),
      );
      // Its text is closed and why it ended is recorded with the settle
      // itself, so a restart's settle leaves the same trail as a live one.
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.activity-appended",
        "thread.side-turn-settled",
      ]);
      expect(events[0]).toMatchObject({ payload: { messageId: "answer", streaming: false } });
      expect(events[1]).toMatchObject({
        payload: {
          activity: {
            kind: SIDE_ANSWER_OUTCOME_ACTIVITY_KIND,
            sideTurnId,
            payload: { outcome: "interrupted" },
          },
        },
      });
      // A flush that arrives after is refused, not written over the answer.
      const lateWords = await decide(
        {
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("cmd-late"),
          threadId,
          messageId: halfWritten.id,
          sideTurnId,
          delta: " off by one.",
          createdAt: now,
        },
        readModel({ messages: [{ ...halfWritten, streaming: false }] }),
      );
      expect(Exit.isFailure(lateWords)).toBe(true);
    });
  });
});
