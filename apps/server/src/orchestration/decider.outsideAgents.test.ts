import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  OutsideAgentConnectionId,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
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
  fromOutside: { ...AGENT, maxRuntimeMode },
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
      fromOutside: { ...AGENT, maxRuntimeMode: "approval-required" },
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
        fromOutside: { ...AGENT, maxRuntimeMode: "approval-required" },
        createdAt: at(4),
      });
    const raised = await run(turn.model, raiseTo("full-access"));
    expect((await stop(raised.model)).refusal).toBe("above_ceiling");
    // Within the ceiling, it stops like the Stop button.
    const stopped = await run(turn.model, {
      type: "thread.turn.interrupt",
      commandId: CommandId.make("stop-ok"),
      threadId: THREAD,
      fromOutside: { ...AGENT, maxRuntimeMode: "approval-required" },
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
});
