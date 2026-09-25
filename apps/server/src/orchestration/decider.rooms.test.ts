import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
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
      readModel({ session: session({ pendingBackgroundTaskCount: 1 }) }),
    );
    expect(Exit.isFailure(backgroundWork)).toBe(true);

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
});
