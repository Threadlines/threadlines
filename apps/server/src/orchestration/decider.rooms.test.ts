import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RoomAgentRequestId,
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
  EMPTY_AGENT_REQUEST_STATE,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

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
        agentRequests: EMPTY_AGENT_REQUEST_STATE,
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
  describe("room tools", () => {
    const callerTurn = TurnId.make("turn-caller");
    const working = () => session({ status: "running", activeTurnId: callerTurn });

    // Apply decided events, so a test can walk a request through its steps.
    async function apply(
      model: OrchestrationReadModel,
      events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
    ): Promise<OrchestrationReadModel> {
      let next = model;
      for (const event of events) {
        next = await Effect.runPromise(
          projectEvent(next, {
            ...event,
            sequence: next.snapshotSequence + 1,
          } as OrchestrationEvent),
        );
      }
      return next;
    }
    const threadOf = (model: OrchestrationReadModel) =>
      model.threads.find((entry) => entry.id === threadId)!;

    let requestNumber = 0;
    function request(
      kind: "ask" | "review" | "hand_off",
      overrides: Partial<
        Extract<OrchestrationCommand, { type: "thread.agent-request.submit" }>
      > = {},
    ): Extract<OrchestrationCommand, { type: "thread.agent-request.submit" }> {
      requestNumber += 1;
      return {
        type: "thread.agent-request.submit",
        commandId: CommandId.make(`cmd-request-${requestNumber}`),
        threadId,
        requestId: RoomAgentRequestId.make(`request-${requestNumber}`),
        kind,
        from: { participantId: null },
        to: { participantId: astraId },
        callerTurnId: callerTurn,
        chainEpoch: 0,
        message: {
          messageId: MessageId.make(`request-message-${requestNumber}`),
          text: "check the retry logic",
        },
        ...(kind === "hand_off"
          ? {}
          : {
              sideTurnId: SideTurnId.make(
                `0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f${String(requestNumber).padStart(2, "0")}`,
              ),
            }),
        ...(kind === "review"
          ? {
              reviewInput: {
                basis: { kind: "uncommitted", files: 2, truncated: false, capturedAt: now },
                diff: "diff --git a/retry.ts b/retry.ts",
              },
            }
          : {}),
        createdAt: now,
        ...overrides,
      } as Extract<OrchestrationCommand, { type: "thread.agent-request.submit" }>;
    }

    it("lets the agent at work ask another during its turn, and refuses every other case", async () => {
      const model = readModel({ session: working() });
      const events = await decideEvents(request("review"), model);
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.agent-request-submitted",
        "thread.side-turn-started",
      ]);
      expect(events[0]?.payload).toMatchObject({
        participantId: astraId,
        fromAgent: { participantId: null },
        requestKind: "review",
        reviewInput: { basis: { files: 2 } },
      });
      expect(events[2]?.payload).toMatchObject({
        sideTurn: { kind: "review", askedBy: { participantId: null } },
      });

      const refused = async (command: OrchestrationCommand, thread: Partial<OrchestrationThread>) =>
        Exit.isFailure(await decide(command, readModel(thread)));
      // An agent that does not hold the thread.
      expect(
        await refused(
          request("ask", { from: { participantId: astraId }, to: { participantId: null } }),
          { session: working() },
        ),
      ).toBe(true);
      // No turn in flight.
      expect(await refused(request("ask"), { session: session() })).toBe(true);
      // After Stop, until the user writes.
      expect(
        await refused(request("ask"), {
          session: working(),
          agentRequests: { ...EMPTY_AGENT_REQUEST_STATE, hold: true },
        }),
      ).toBe(true);
      // Three requests since the user wrote, hand-offs included.
      expect(
        await refused(request("hand_off"), {
          session: working(),
          agentRequests: { ...EMPTY_AGENT_REQUEST_STATE, requestsSinceUser: 3 },
        }),
      ).toBe(true);
      // Someone is already answering on the side.
      expect(
        await refused(request("ask"), {
          session: working(),
          sideTurn: {
            sideTurnId: SideTurnId.make("0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f99"),
            participantId: astraId,
            messageId: MessageId.make("other-question"),
            status: "running",
            startedAt: now,
          },
        }),
      ).toBe(true);
    });

    it("hands off once the calling turn completes, and routes the reply back exactly once", async () => {
      let model = readModel({ session: working() });
      const handOff = request("hand_off");
      model = await apply(model, await decideEvents(handOff, model));
      expect(threadOf(model).agentRequests.open[0]).toMatchObject({ status: "pending" });
      expect(threadOf(model).agentRequests.requestsSinceUser).toBe(1);

      // The calling turn completed (the reactor's call): the target's turn joins the queue.
      model = await apply(
        model,
        await decideEvents(
          {
            type: "thread.agent-request.queue",
            commandId: CommandId.make("cmd-queue"),
            threadId,
            requestId: handOff.requestId,
            createdAt: now,
          },
          model,
        ),
      );
      expect(threadOf(model).queuedFollowUps).toMatchObject([
        {
          messageId: handOff.message.messageId,
          participantId: astraId,
          fromAgent: { participantId: null },
        },
      ]);

      // Sending it, once the caller is idle, keeps who wrote it, and the
      // request is running.
      model = { ...model, threads: [{ ...threadOf(model), session: session() }] };
      const sent = await decideEvents(
        {
          type: "thread.follow-up.send-queued",
          commandId: CommandId.make("cmd-send"),
          threadId,
          messageId: handOff.message.messageId,
          createdAt: "2026-01-01T00:00:09.000Z",
        },
        model,
      );
      expect(sent.find((event) => event.type === "thread.message-sent")?.payload).toMatchObject({
        fromAgent: { participantId: null },
        requestId: handOff.requestId,
        requestKind: "hand_off",
        createdAt: now,
      });
      expect(sent.some((event) => event.type === "thread.agent-requests-reset")).toBe(false);
      model = await apply(model, sent);
      expect(threadOf(model).agentRequests.open[0]).toMatchObject({ status: "running" });

      const settle = {
        type: "thread.agent-request.settle" as const,
        commandId: CommandId.make("cmd-settle"),
        threadId,
        requestId: handOff.requestId,
        outcome: "answered" as const,
        reply: {
          messageId: MessageId.make(`hand-off-reply:${handOff.requestId}`),
          text: "fixed it",
        },
        createdAt: now,
      };
      model = await apply(model, await decideEvents(settle, model));
      const thread = threadOf(model);
      expect(thread.agentRequests.open).toEqual([]);
      expect(
        thread.messages.find((message) => message.id === handOff.message.messageId),
      ).toMatchObject({
        requestOutcome: "answered",
      });
      // The reply is queued for the thread's own agent, written by astra.
      expect(thread.queuedFollowUps?.at(-1)).toMatchObject({
        messageId: settle.reply.messageId,
        fromAgent: { participantId: astraId },
      });
      // Settling again finds nothing open: no second reply.
      expect(Exit.isFailure(await decide(settle, model))).toBe(true);

      // The reply runs on the thread's own agent's current model, changed
      // since the hand-off was made.
      const changedModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-sol" };
      model = {
        ...model,
        threads: [
          {
            ...threadOf(model),
            modelSelection: changedModel,
            session: session({ participantId: astraId }),
          },
        ],
      };
      const replySent = await decideEvents(
        {
          type: "thread.follow-up.send-queued",
          commandId: CommandId.make("cmd-send-reply"),
          threadId,
          messageId: settle.reply.messageId,
          createdAt: "2026-01-01T00:00:10.000Z",
        },
        model,
      );
      expect(
        replySent.find((event) => event.type === "thread.turn-start-requested")?.payload,
      ).toMatchObject({ modelSelection: changedModel });
    });

    it("ends the agents' chain on Stop, until the user writes again", async () => {
      let model = readModel({ session: working() });
      const ask = request("ask");
      model = await apply(model, await decideEvents(ask, model));
      const handOff = request("hand_off");
      model = await apply(model, await decideEvents(handOff, model));

      const stopped = await decideEvents(
        {
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-stop"),
          threadId,
          turnId: callerTurn,
          createdAt: now,
        },
        model,
      );
      expect(stopped.map((event) => event.type)).toEqual([
        "thread.turn-interrupt-requested",
        "thread.agent-requests-held",
        "thread.agent-request-settled",
        "thread.agent-request-settled",
        "thread.side-turn-interrupt-requested",
      ]);
      model = await apply(model, stopped);
      expect(threadOf(model).agentRequests).toMatchObject({ hold: true, chainEpoch: 1, open: [] });
      // A request from before Stop is refused even once the hold is gone.
      expect(Exit.isFailure(await decide(request("ask"), model))).toBe(true);

      const userTurn = await decideEvents(
        turnStart(null),
        readModel({ ...threadOf(model), session: session() }),
      );
      expect(userTurn.some((event) => event.type === "thread.agent-requests-reset")).toBe(true);
    });

    it("ends the agents' chain when the session is stopped, too", async () => {
      let model = readModel({ session: working() });
      model = await apply(model, await decideEvents(request("hand_off"), model));
      const stopped = await decideEvents(
        {
          type: "thread.session.stop",
          commandId: CommandId.make("cmd-session-stop"),
          threadId,
          createdAt: now,
        },
        model,
      );
      expect(stopped.map((event) => event.type)).toEqual([
        "thread.session-stop-requested",
        "thread.agent-requests-held",
        "thread.agent-request-settled",
      ]);
      model = await apply(model, stopped);
      expect(threadOf(model).agentRequests).toMatchObject({ hold: true, chainEpoch: 1, open: [] });
    });

    it("changes an added agent's model only when it has nothing in flight", async () => {
      const change = {
        type: "thread.participant.update" as const,
        commandId: CommandId.make("cmd-model"),
        threadId,
        participantId: astraId,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-sol" },
        createdAt: now,
      };
      expect(await decideEvents(change, readModel())).toMatchObject([
        { type: "thread.participant-updated", payload: { modelSelection: { model: "gpt-6-sol" } } },
      ]);
      let busy = readModel({ session: working() });
      busy = await apply(busy, await decideEvents(request("hand_off"), busy));
      expect(Exit.isFailure(await decide(change, busy))).toBe(true);
    });

    describe("invites", () => {
      const guestId = ThreadParticipantId.make("5c4d3e2f-1a0b-4c9d-8e7f-6a5b4c3d2e1f");
      const plainThread = () => readModel({ participants: [], session: working() });
      function invite(
        overrides: Partial<
          NonNullable<
            Extract<OrchestrationCommand, { type: "thread.agent-request.submit" }>["invite"]
          >
        > = {},
      ) {
        return {
          ...request("review"),
          kind: "invite" as const,
          to: { participantId: guestId },
          invite: {
            guest: {
              handle: "GPT-6 Astra",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-6-astra",
              },
            },
            reason: "A second model should check the retry math.",
            suggestion: "review" as const,
            billing: {
              instanceId: ProviderInstanceId.make("codex"),
              label: "Codex · ChatGPT Pro",
              perUse: false,
            },
            ...overrides,
          },
        };
      }
      const respond = (
        requestId: RoomAgentRequestId,
        choice: "review" | "teammate" | "decline",
      ): OrchestrationCommand => ({
        type: "thread.agent-invite.respond",
        commandId: CommandId.make(`cmd-respond-${choice}`),
        threadId,
        requestId,
        choice,
        createdAt: now,
      });
      const revert: OrchestrationCommand = {
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert"),
        threadId,
        turnCount: 0,
        createdAt: now,
      };
      /** The guest's review finished with this text. */
      const answered = async (model: OrchestrationReadModel, text: string) => {
        const thread = threadOf(model);
        const sideTurn = thread.sideTurn!;
        const withAnswer: OrchestrationReadModel = {
          ...model,
          threads: [
            {
              ...thread,
              messages: [
                ...thread.messages,
                {
                  id: MessageId.make(`side-answer:${sideTurn.sideTurnId}`),
                  role: "assistant",
                  text,
                  participantId: sideTurn.participantId,
                  sideTurnId: sideTurn.sideTurnId,
                  turnId: null,
                  streaming: false,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
            },
          ],
        };
        return apply(
          withAnswer,
          await decideEvents(
            {
              type: "thread.side-turn.settle",
              commandId: CommandId.make("cmd-review-done"),
              threadId,
              sideTurnId: sideTurn.sideTurnId,
              outcome: "completed",
              createdAt: now,
            },
            withAnswer,
          ),
        );
      };

      it("asks the user, and a review only leaves the thread a plain one whose agent gets the review back", async () => {
        let model = plainThread();
        const ask = invite();
        model = await apply(model, await decideEvents(ask, model));
        let thread = threadOf(model);
        expect(thread.agentRequests.open).toMatchObject([
          { kind: "invite", status: "awaiting_user" },
        ]);
        expect(thread.participants).toMatchObject([{ id: guestId, guest: true }]);
        expect(thread.sideTurn ?? null).toBeNull();
        // Nothing may be rewound while the user still has to answer.
        expect(Exit.isFailure(await decide(revert, model))).toBe(true);

        // The caller's turn ends; the invite still waits for the user.
        model = { ...model, threads: [{ ...thread, session: session() }] };
        model = await apply(model, await decideEvents(respond(ask.requestId, "review"), model));
        thread = threadOf(model);
        expect(thread.sideTurn).toMatchObject({
          participantId: guestId,
          kind: "review",
          askedBy: { participantId: null },
        });
        expect(
          thread.messages.find((message) => message.id === ask.message.messageId),
        ).toMatchObject({ invite: { choice: "review", automatic: false } });
        // The review is its own message, like any independent review.
        expect(
          thread.messages.find((message) => message.id === thread.sideTurn?.messageId),
        ).toMatchObject({
          requestKind: "review",
          sideTurnId: thread.sideTurn?.sideTurnId,
          reviewInput: ask.reviewInput,
        });

        model = await answered(model, "The backoff never caps.");
        thread = threadOf(model);
        expect(thread.agentRequests.open).toEqual([]);
        expect(thread.queuedFollowUps).toMatchObject([
          {
            text: "The backoff never caps.",
            fromAgent: { participantId: guestId },
            requestId: ask.requestId,
          },
        ]);
        // Still a plain thread: the guest never joined.
        expect(thread.participants).toMatchObject([{ id: guestId, guest: true }]);
        expect(Exit.isFailure(await decide(revert, model))).toBe(true);
        const withoutReply = { ...model, threads: [{ ...thread, queuedFollowUps: [] }] };
        expect(Exit.isSuccess(await decide(revert, withoutReply))).toBe(true);

        // Stop takes the reply back: it stays in the chat, marked, and is
        // never taken for a turn's message.
        model = await apply(
          model,
          await decideEvents(
            {
              type: "thread.turn.interrupt",
              commandId: CommandId.make("cmd-stop-reply"),
              threadId,
              createdAt: now,
            },
            model,
          ),
        );
        thread = threadOf(model);
        expect(thread.queuedFollowUps).toEqual([]);
        expect(thread.messages.find((message) => message.requestKind === "reply")).toMatchObject({
          requestOutcome: "cancelled",
        });
      });

      it("adds the agent to the thread, which makes it a room", async () => {
        let model = plainThread();
        const ask = invite({ suggestion: "teammate" });
        model = await apply(model, await decideEvents(ask, model));
        model = await apply(model, await decideEvents(respond(ask.requestId, "teammate"), model));
        const thread = threadOf(model);
        expect(thread.participants).toMatchObject([{ id: guestId, leftAt: null }]);
        expect(thread.participants[0]?.guest).toBeUndefined();
        expect(Exit.isFailure(await decide(revert, model))).toBe(true);
      });

      it("hears no more invites after not now, until the user writes", async () => {
        let model = plainThread();
        const ask = invite();
        model = await apply(model, await decideEvents(ask, model));
        model = await apply(model, await decideEvents(respond(ask.requestId, "decline"), model));
        const thread = threadOf(model);
        expect(thread.agentRequests).toMatchObject({ open: [], invitesPaused: true });
        expect(thread.sideTurn ?? null).toBeNull();
        expect(
          thread.messages.find((message) => message.id === ask.message.messageId)?.requestOutcome,
        ).toBe("declined");
        const again = invite();
        expect(
          Exit.isFailure(
            await decide(
              {
                ...again,
                to: {
                  participantId: ThreadParticipantId.make("6d5e4f3a-2b1c-4d0e-9f8a-7b6c5d4e3f2a"),
                },
              },
              model,
            ),
          ),
        ).toBe(true);

        const userTurn = await decideEvents(
          turnStart(null),
          readModel({ ...thread, session: session() }),
        );
        model = await apply(
          model,
          userTurn.filter((event) => event.type === "thread.agent-requests-reset"),
        );
        expect(threadOf(model).agentRequests.invitesPaused).toBe(false);
      });

      it("takes a waiting invite back on Stop", async () => {
        let model = plainThread();
        const ask = invite();
        model = await apply(model, await decideEvents(ask, model));
        const stopped = await decideEvents(
          {
            type: "thread.turn.interrupt",
            commandId: CommandId.make("cmd-stop-invite"),
            threadId,
            turnId: callerTurn,
            createdAt: now,
          },
          model,
        );
        model = await apply(model, stopped);
        expect(threadOf(model).agentRequests).toMatchObject({ open: [], hold: true });
        expect(Exit.isFailure(await decide(respond(ask.requestId, "review"), model))).toBe(true);
      });

      it("still ends the chain on Stop once the review is over, so its reply cannot slip out", async () => {
        const guest = {
          ...astra,
          id: guestId,
          leftAt: now,
          guest: true,
        };
        const stopped = await decideEvents(
          {
            type: "thread.turn.interrupt",
            commandId: CommandId.make("cmd-stop-guest"),
            threadId,
            createdAt: now,
          },
          readModel({ participants: [guest], session: working() }),
        );
        expect(stopped.map((event) => event.type)).toEqual([
          "thread.turn-interrupt-requested",
          "thread.agent-requests-held",
        ]);
        // A thread no agent was ever brought into is left as it was.
        const plain = await decideEvents(
          {
            type: "thread.turn.interrupt",
            commandId: CommandId.make("cmd-stop-plain"),
            threadId,
            createdAt: now,
          },
          plainThread(),
        );
        expect(plain.map((event) => event.type)).toEqual(["thread.turn-interrupt-requested"]);
      });

      it("starts the review at once without asking", async () => {
        const model = plainThread();
        const events = await decideEvents(invite({ autoChoice: "review" }), model);
        expect(events.map((event) => event.type)).toEqual([
          "thread.participant-added",
          "thread.message-sent",
          "thread.agent-request-submitted",
          "thread.message-sent",
          "thread.side-turn-started",
        ]);
        expect(events[1]?.payload).toMatchObject({
          invite: { choice: "review", automatic: true },
        });
        expect(events[2]?.payload).toMatchObject({ request: { status: "running" } });
      });
    });
  });
});
