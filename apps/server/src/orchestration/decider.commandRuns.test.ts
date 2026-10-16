import {
  CommandId,
  CommandRequestId,
  CommandRunId,
  MessageId,
  ThreadId,
  ThreadParticipantId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationCommandRun,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-01-01T00:00:00.000Z";
const THREAD = ThreadId.make("thread-commands");
const TURN = TurnId.make("turn-1");
const RUN = CommandRunId.make("run-1");

// Only what the command rules read; the rest of a thread plays no part in them.
const readModelWith = (thread: Partial<OrchestrationThread>): OrchestrationReadModel =>
  ({
    snapshotSequence: 1,
    updatedAt: now,
    projects: [],
    threads: [
      {
        id: THREAD,
        deletedAt: null,
        latestTurn: null,
        session: null,
        messages: [],
        participants: [],
        queuedFollowUps: [],
        agentRequests: { open: [], requestsSinceUser: 0 },
        childRequests: { open: [], startsSinceUser: 0, sendsSinceUser: 0 },
        commandRequests: [],
        commandRuns: [],
        ...thread,
      },
    ],
  }) as unknown as OrchestrationReadModel;

const run = (overrides: Partial<OrchestrationCommandRun> = {}): OrchestrationCommandRun => ({
  runId: RUN,
  terminalId: "terminal-run",
  mode: "run",
  dialect: "posix",
  command: "pnpm install",
  source: { kind: "request", requestId: CommandRequestId.make("request-1") },
  turnId: TURN,
  participantId: null,
  cwd: "/repo",
  autoSend: true,
  status: "finished",
  startedAt: now,
  finishedAt: now,
  exitCode: 0,
  error: null,
  hasOutput: true,
  heldReason: null,
  outputSentAt: null,
  outputMessageId: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const decide = (command: OrchestrationCommand, readModel: OrchestrationReadModel) =>
  Effect.runPromise(decideOrchestrationCommand({ command, readModel })).then((decided) =>
    Array.isArray(decided) ? decided : [decided],
  );

const deliver = (automatic: boolean): OrchestrationCommand => ({
  type: "thread.command-run.deliver-output",
  commandId: CommandId.make("command-output:run-1"),
  threadId: THREAD,
  runId: RUN,
  automatic,
  message: { messageId: MessageId.make("command-output:run-1"), text: "I ran this command" },
  createdAt: now,
});

describe("decider suggested commands", () => {
  it("only starts a code-block run from an agent reply still in the thread", async () => {
    const start = (messageId: string): OrchestrationCommand => ({
      type: "thread.command-run.start",
      commandId: CommandId.make(`start-${messageId}`),
      threadId: THREAD,
      run: {
        runId: RUN,
        terminalId: "terminal-run",
        mode: "run",
        dialect: "posix",
        command: "pnpm install",
        source: { kind: "message", messageId: MessageId.make(messageId) },
        turnId: TURN,
        participantId: null,
        cwd: "/repo",
        autoSend: false,
      },
      createdAt: now,
    });
    const readModel = readModelWith({
      messages: [
        { id: MessageId.make("reply"), role: "assistant", turnId: TURN },
        { id: MessageId.make("prompt"), role: "user", turnId: TURN },
      ] as unknown as OrchestrationThread["messages"],
    });

    expect(await decide(start("reply"), readModel)).toMatchObject([
      { type: "thread.command-run-started" },
    ]);
    await expect(decide(start("prompt"), readModel)).rejects.toThrow(/no longer part/);
    await expect(decide(start("gone"), readModel)).rejects.toThrow(/no longer part/);
  });

  it("steers output into the agent's running turn and marks it sent", async () => {
    const events = await decide(
      deliver(true),
      readModelWith({
        session: {
          status: "running",
          activeTurnId: TurnId.make("turn-2"),
        } as OrchestrationThread["session"],
        commandRuns: [run()],
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      "thread.follow-up-submitted",
      "thread.command-run-updated",
    ]);
    expect(events[1]?.payload).toMatchObject({
      progress: { runId: RUN, outputMessageId: "command-output:run-1" },
    });
  });

  it("queues output for an idle agent, like a message the user typed", async () => {
    const events = await decide(deliver(true), readModelWith({ commandRuns: [run()] }));
    expect(events.map((event) => event.type)).toEqual([
      "thread.follow-up-queued",
      "thread.command-run-updated",
    ]);
  });

  it("holds automatic output once Stop was pressed, but still sends it by hand", async () => {
    const readModel = readModelWith({
      latestTurn: { turnId: TURN } as OrchestrationThread["latestTurn"],
      commandRuns: [run({ status: "running", finishedAt: null })],
    });
    const stopEvents = await decide(
      {
        type: "thread.turn.interrupt",
        commandId: CommandId.make("stop"),
        threadId: THREAD,
        createdAt: now,
      },
      readModel,
    );
    expect(
      stopEvents.find((event) => event.type === "thread.command-run-updated")?.payload,
    ).toMatchObject({
      progress: { runId: RUN, autoSend: false, heldReason: "stopped" },
    });

    const held = readModelWith({ commandRuns: [run({ autoSend: false, heldReason: "stopped" })] });
    await expect(decide(deliver(true), held)).rejects.toThrow(/no longer sends its output/);
    expect((await decide(deliver(false), held)).map((event) => event.type)).toContain(
      "thread.command-run-updated",
    );
  });

  it("never sends output to another agent when its own left the room", async () => {
    await expect(
      decide(
        deliver(true),
        readModelWith({
          commandRuns: [run({ participantId: ThreadParticipantId.make("agent-gone") })],
        }),
      ),
    ).rejects.toThrow(/left the room/);
  });

  it("never lets a take-back of one send undo a later one", async () => {
    const takeBack = (messageId: string): OrchestrationCommand => ({
      type: "thread.command-run.update",
      commandId: CommandId.make(`take-back-${messageId}`),
      threadId: THREAD,
      progress: {
        runId: RUN,
        heldReason: "undelivered",
        outputSentAt: null,
        outputMessageId: null,
      },
      ifOutputMessageId: MessageId.make(messageId),
      createdAt: now,
    });
    const resent = readModelWith({
      commandRuns: [
        run({ outputSentAt: now, outputMessageId: MessageId.make("command-output:run-1:second") }),
      ],
    });
    await expect(decide(takeBack("command-output:run-1"), resent)).rejects.toThrow(/sent again/);
    expect(await decide(takeBack("command-output:run-1:second"), resent)).toMatchObject([
      { type: "thread.command-run-updated", payload: { progress: { heldReason: "undelivered" } } },
    ]);
  });

  it("takes queued output back when its agent leaves the room before it went out", async () => {
    const LEFT = ThreadParticipantId.make("agent-left");
    const messageId = MessageId.make("command-output:run-1");
    const events = await decide(
      {
        type: "thread.follow-up.send-queued",
        commandId: CommandId.make("send-queued-output"),
        threadId: THREAD,
        messageId,
        createdAt: now,
      },
      readModelWith({
        // The agent it was queued for is no longer among the participants.
        queuedFollowUps: [
          {
            messageId,
            text: "I ran this command",
            attachments: [],
            participantId: LEFT,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: now,
          },
        ] as unknown as OrchestrationThread["queuedFollowUps"],
        commandRuns: [run({ participantId: LEFT, outputSentAt: now, outputMessageId: messageId })],
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      "thread.follow-up-unqueued",
      "thread.command-run-updated",
    ]);
    expect(events[1]?.payload).toMatchObject({
      progress: { runId: RUN, heldReason: "agent-left", outputSentAt: null },
    });
  });
});
