import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OutsideTurnOrigin,
  OutsideAgentConnectionId,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
  type ThreadParticipantId,
  TurnId,
} from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const now = "2026-10-23T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString();
const projectId = ProjectId.make("project-1");
const THREAD = ThreadId.make("outside-thread");
const CONNECTION = OutsideAgentConnectionId.make("connection-1");
const AGENT = { connectionId: CONNECTION, name: "Claude Code" };
const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };

const emptyModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  updatedAt: now,
  projects: [
    {
      id: projectId,
      kind: "workspace",
      title: "threadlines",
      workspaceRoot: "/repo",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [],
};

type Planned = Omit<OrchestrationEvent, "sequence">;

/** Decide a command, project its events, and hand back both. */
async function run(current: OrchestrationReadModel, command: OrchestrationCommand) {
  const decided = await Effect.runPromise(
    decideOrchestrationCommand({ command, readModel: current }),
  );
  const events = (Array.isArray(decided) ? decided : [decided]) as ReadonlyArray<Planned>;
  let next = current;
  let sequence = current.snapshotSequence;
  for (const event of events) {
    sequence += 1;
    next = await Effect.runPromise(
      projectEvent(next, { ...event, sequence } as OrchestrationEvent),
    );
  }
  return { events, model: { ...next, snapshotSequence: sequence } };
}

/** The decider's refusal: its typed reason (if any) and words. */
async function refusal(current: OrchestrationReadModel, command: OrchestrationCommand) {
  const exit = await Effect.runPromiseExit(
    decideOrchestrationCommand({ command, readModel: current }),
  );
  if (!Exit.isFailure(exit)) throw new Error("expected a refusal");
  const error = Cause.squash(exit.cause) as { refusal?: string; detail: string };
  return { refusal: error.refusal, detail: error.detail };
}

/** A thread the outside agent started, as Supervised. */
const outsideThread = () =>
  run(emptyModel, {
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId: THREAD,
    projectId,
    title: "Fix the flaky test",
    modelSelection: model,
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    outsideOrigin: AGENT,
    createdAt: at(1),
  });

const outsideTurn = (
  messageId: string,
  maxRuntimeMode: RuntimeMode = "approval-required",
): OrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make(`turn-${messageId}`),
  threadId: THREAD,
  message: { messageId: MessageId.make(messageId), role: "user", text: "Go", attachments: [] },
  runtimeMode: "approval-required",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  fromOutside: { ...AGENT, access: "start", maxRuntimeMode },
  createdAt: at(2),
});

const raiseTo = (runtimeMode: RuntimeMode): OrchestrationCommand => ({
  type: "thread.runtime-mode.set",
  commandId: CommandId.make(`raise-${runtimeMode}`),
  threadId: THREAD,
  runtimeMode,
  createdAt: at(3),
});

describe("decider outside agents", () => {
  it("labels the thread and every message the agent writes with its name", async () => {
    const created = await outsideThread();
    expect(created.model.threads[0]?.outsideOrigin).toEqual(AGENT);

    const turn = await run(created.model, outsideTurn("first"));
    const sent = turn.events.find((event) => event.type === "thread.message-sent");
    const requested = turn.events.find((event) => event.type === "thread.turn-start-requested");
    expect(sent?.payload).toMatchObject({ fromOutside: AGENT });
    // The turn carries the ceiling it was accepted under.
    expect(requested?.payload).toMatchObject({
      fromOutside: { ...AGENT, access: "start", maxRuntimeMode: "approval-required" },
    });
    expect(turn.model.threads[0]?.messages[0]?.fromOutside).toEqual(AGENT);
  });

  it("refuses the agent's turn, by type, once the user raised the thread above its ceiling", async () => {
    const created = await outsideThread();
    // A raise that lands first wins: the decider sees both in order.
    const raised = await run(created.model, raiseTo("full-access"));
    expect(await refusal(raised.model, outsideTurn("after-raise"))).toEqual({
      refusal: "above_ceiling",
      detail: expect.stringContaining("above what Claude Code may use"),
    });
    // The other order: the turn is in, and a later raise doesn't undo it.
    const turn = await run(created.model, outsideTurn("before-raise"));
    const after = await run(turn.model, raiseTo("full-access"));
    expect(after.model.threads[0]?.runtimeMode).toBe("full-access");
  });

  it("refuses the agent's Stop, by type, in a thread the user raised above its ceiling", async () => {
    const created = await outsideThread();
    const turn = await run(created.model, outsideTurn("first"));
    const stop = (raised: OrchestrationReadModel) =>
      refusal(raised, {
        type: "thread.turn.interrupt",
        commandId: CommandId.make("stop"),
        threadId: THREAD,
        fromOutside: { ...AGENT, access: "start", maxRuntimeMode: "approval-required" },
        createdAt: at(4),
      });
    const raised = await run(turn.model, raiseTo("full-access"));
    expect((await stop(raised.model)).refusal).toBe("above_ceiling");
    // Within the ceiling, it stops like the Stop button.
    const stopped = await run(turn.model, {
      type: "thread.turn.interrupt",
      commandId: CommandId.make("stop-ok"),
      threadId: THREAD,
      fromOutside: { ...AGENT, access: "start", maxRuntimeMode: "approval-required" },
      createdAt: at(4),
    });
    expect(stopped.events.map((event) => event.type)).toContain("thread.turn-interrupt-requested");
  });

  it("refuses the agent's turn as busy while a turn runs or waits on an approval", async () => {
    const created = await outsideThread();
    const running = await run(created.model, outsideTurn("first"));
    // Accepted and about to start: the session is starting.
    expect((await refusal(running.model, outsideTurn("second"))).refusal).toBe("thread_busy");

    // Later the turn is over, but its approval still waits for the user.
    const settled = await run(running.model, {
      type: "thread.session.set",
      commandId: CommandId.make("settle"),
      threadId: THREAD,
      session: {
        threadId: THREAD,
        status: "ready",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: at(4),
      },
      createdAt: at(4),
    });
    const waiting = await run(settled.model, {
      type: "thread.activity.append",
      commandId: CommandId.make("approval"),
      threadId: THREAD,
      activity: {
        id: EventId.make("approval-1"),
        tone: "approval",
        kind: "approval.requested",
        summary: "Run the tests",
        payload: { requestId: "request-1", requestType: "command_execution_approval" },
        turnId: TurnId.make("turn-1"),
        createdAt: at(5),
      },
      createdAt: at(5),
    });
    expect(await refusal(waiting.model, outsideTurn("third"))).toEqual({
      refusal: "thread_busy",
      detail: expect.stringContaining("approve"),
    });
  });

  it("refuses a turn from an agent that didn't start the thread", async () => {
    const created = await outsideThread();
    const other: OrchestrationCommand = {
      ...outsideTurn("stranger"),
      fromOutside: {
        connectionId: OutsideAgentConnectionId.make("connection-2"),
        name: "Codex",
        maxRuntimeMode: "full-access",
      },
    } as OrchestrationCommand;
    const refused = await refusal(created.model, other);
    expect(refused.refusal).toBeUndefined();
    expect(refused.detail).toContain("didn't start this thread");
  });

  it("lets Work reach a thread the user started, marks the agent it reached, and clears it by agent", async () => {
    const created = await userThread();
    const work = {
      ...AGENT,
      access: "work" as const,
      maxRuntimeMode: "approval-required" as const,
    };
    expect((await refusal(created.model, outsideTurn("start-level"))).detail).toContain(
      "didn't start this thread",
    );
    const sent = await run(created.model, {
      ...outsideTurn("work-level"),
      fromOutside: work,
    } as OrchestrationCommand);
    expect(threadOf(sent.model).outsideWork).toEqual([
      { participantId: null, connections: [AGENT], since: at(2) },
    ]);

    const clear: OrchestrationCommand = {
      type: "thread.outside-work.clear",
      commandId: CommandId.make("clear"),
      threadId: THREAD,
      participantId: null,
      createdAt: at(9),
    };
    const cleared = await run(sent.model, clear);
    expect(threadOf(cleared.model).outsideWork).toEqual([]);
    // Nothing left to clear: no event.
    expect(
      (await run(cleared.model, { ...clear, commandId: CommandId.make("again") })).events,
    ).toEqual([]);
  });

  it("answers only an open question, at Work, asked by the agent holding the thread, never an approval", async () => {
    const created = await userThread();
    const ready = await run(created.model, readySession());
    const asked = await run(ready.model, question("q-1", undefined));
    const withApproval = await run(asked.model, approval("a-1"));
    const fromOtherAgent = await run(withApproval.model, question("q-2", "participant-2" as never));
    const work = {
      ...AGENT,
      access: "work" as const,
      maxRuntimeMode: "approval-required" as const,
    };
    const respond = (
      requestId: string,
      fromOutside: OutsideTurnOrigin = work,
    ): OrchestrationCommand => ({
      type: "thread.user-input.respond",
      commandId: CommandId.make(`respond-${requestId}`),
      threadId: THREAD,
      requestId: requestId as never,
      answers: { "Which one?": "The first" },
      fromOutside,
      createdAt: at(8),
    });
    const current = fromOtherAgent.model;
    expect((await refusal(current, respond("q-1", { ...work, access: "start" }))).detail).toContain(
      "can't answer questions",
    );
    expect((await refusal(current, respond("a-1"))).detail).toContain("approval");
    expect((await refusal(current, respond("q-9"))).detail).toContain("isn't open");
    expect((await refusal(current, respond("q-2"))).detail).toContain("doesn't hold the thread");

    const answered = await run(current, respond("q-1"));
    expect(answered.events[0]?.payload).toMatchObject({
      fromOutside: work,
      participantId: null,
    });
    expect(threadOf(answered.model).outsideWork?.[0]?.connections).toEqual([AGENT]);

    // The answer's own turn passes over its question; any other outside turn
    // waits, and so does it while an approval waits too.
    const questionsOnly = (await run(asked.model, question("q-3", undefined))).model;
    const answerTurn = (answering?: string): OrchestrationCommand =>
      ({
        ...outsideTurn(`answer-${answering ?? "none"}`),
        fromOutside: work,
        ...(answering !== undefined ? { answering: answering as never } : {}),
      }) as OrchestrationCommand;
    expect((await refusal(questionsOnly, answerTurn())).detail).toContain("answer a question");
    expect((await refusal(questionsOnly, answerTurn("q-3"))).detail).toContain("answer a question");
    expect((await refusal(current, answerTurn("q-1"))).detail).toContain("approve");
    const onlyOne = (await run(asked.model, readySession())).model;
    expect((await run(onlyOne, answerTurn("q-1"))).events[0]?.type).toBe("thread.message-sent");
  });
});

/** A thread the user started, as Supervised. */
const userThread = () =>
  run(emptyModel, {
    type: "thread.create",
    commandId: CommandId.make("create-user"),
    threadId: THREAD,
    projectId,
    title: "Tidy the docs",
    modelSelection: model,
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    createdAt: at(1),
  });

const threadOf = (current: OrchestrationReadModel) =>
  current.threads.find((thread) => thread.id === THREAD)!;

const readySession = (): OrchestrationCommand => ({
  type: "thread.session.set",
  commandId: CommandId.make("ready"),
  threadId: THREAD,
  session: {
    threadId: THREAD,
    status: "ready",
    providerName: "codex",
    runtimeMode: "approval-required",
    activeTurnId: null,
    lastError: null,
    updatedAt: at(3),
  },
  createdAt: at(3),
});

const question = (
  requestId: string,
  participantId: ThreadParticipantId | undefined,
): OrchestrationCommand => ({
  type: "thread.activity.append",
  commandId: CommandId.make(`question-${requestId}`),
  threadId: THREAD,
  activity: {
    id: EventId.make(`question-${requestId}`),
    tone: "info",
    kind: "user-input.requested",
    summary: "A question",
    payload: {
      requestId,
      questions: [
        {
          id: "Which one?",
          header: "Pick",
          question: "Which one?",
          options: [{ label: "The first", description: "" }],
          multiSelect: false,
        },
      ],
    },
    turnId: TurnId.make("turn-1"),
    ...(participantId !== undefined ? { participantId } : {}),
    createdAt: at(4),
  },
  createdAt: at(4),
});

const approval = (requestId: string): OrchestrationCommand => ({
  type: "thread.activity.append",
  commandId: CommandId.make(`approval-${requestId}`),
  threadId: THREAD,
  activity: {
    id: EventId.make(`approval-${requestId}`),
    tone: "approval",
    kind: "approval.requested",
    summary: "Run the tests",
    payload: { requestId, requestType: "command_execution_approval" },
    turnId: TurnId.make("turn-1"),
    createdAt: at(5),
  },
  createdAt: at(5),
});
