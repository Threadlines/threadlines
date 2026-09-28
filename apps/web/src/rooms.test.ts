import { scopeThreadRef } from "@threadlines/client-runtime";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  ThreadParticipantId,
  TurnId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "./providerInstances";
import {
  buildRoomAgentLabels,
  describeRoomAgentMessage,
  describeRoomReviewBasis,
  hasRoomHistory,
  isRoom,
  isRoomWaitChosen,
  matchRoomAgents,
  resolveRoomDelivery,
  resolveRoomRecipient,
  roomActivityAgent,
  roomAgentKey,
  roomTurnOwners,
  useRoomRecipientStore,
} from "./rooms";

const astraId = ThreadParticipantId.make("agent-astra");
const astra = {
  id: astraId,
  handle: "astra",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
  joinedAt: "2026-01-01T00:00:00.000Z",
  leftAt: null,
};

describe("rooms", () => {
  it("addresses the agent that worked last unless the user chose another", () => {
    const thread = { participants: [astra], session: { participantId: astraId } };
    expect(resolveRoomRecipient(thread, undefined)).toBe(astraId);
    expect(resolveRoomRecipient(thread, null)).toBeNull();
    // A choice of an agent that has since left falls back to the thread's own agent.
    const left = {
      participants: [{ ...astra, leftAt: "2026-01-02T00:00:00.000Z" }],
      session: null,
    };
    expect(resolveRoomRecipient(left, astraId)).toBeNull();
  });

  it("reads as a plain thread once its added agents all left, keeping their names", () => {
    const left = {
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus-9" },
      participants: [{ ...astra, leftAt: "2026-01-02T00:00:00.000Z" }],
    };
    expect(isRoom({ participants: [astra] })).toBe(true);
    // No room icon, filter, picker or "@" agents any more...
    expect(isRoom(left)).toBe(false);
    // ...but what the agent wrote still says who wrote it, and revert stays off.
    expect(hasRoomHistory(left)).toBe(true);
    expect(
      buildRoomAgentLabels(left, [], (model) => model.name)?.get(roomAgentKey(astraId)),
    ).toMatchObject({
      name: "gpt-6-astra",
      left: true,
    });
  });

  it("tells which agent a reading came from, older unnamed ones by their turn", () => {
    const owners = roomTurnOwners([
      { role: "assistant", turnId: TurnId.make("turn-own"), participantId: undefined },
      { role: "assistant", turnId: TurnId.make("turn-astra"), participantId: astraId },
    ]);
    // Named: an added agent's reading says whose it is.
    expect(roomActivityAgent({ participantId: astraId, turnId: null }, owners)).toBe(astraId);
    // Unnamed: the thread's own agent's, unless its turn was another agent's.
    expect(roomActivityAgent({ turnId: TurnId.make("turn-own") }, owners)).toBeNull();
    expect(roomActivityAgent({ turnId: TurnId.make("turn-astra") }, owners)).toBe(astraId);
    expect(roomActivityAgent({ turnId: null }, owners)).toBeNull();
  });

  it("names every agent by its model and numbers agents on the same model", () => {
    const entries = [
      {
        instanceId: ProviderInstanceId.make("codex"),
        models: [{ slug: "gpt-6-astra", name: "GPT-6 Astra" }],
      },
    ] as unknown as ReadonlyArray<ProviderInstanceEntry>;
    const secondAstraId = ThreadParticipantId.make("agent-astra-2");
    const labels = buildRoomAgentLabels(
      {
        modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus-9" },
        participants: [astra, { ...astra, id: secondAstraId }],
      },
      entries,
      (model) => model.name,
    );
    // A model this client does not know keeps its id.
    expect(labels?.get(roomAgentKey(null))?.name).toBe("opus-9");
    expect(labels?.get(roomAgentKey(astraId))?.name).toBe("GPT-6 Astra");
    expect(labels?.get(roomAgentKey(secondAstraId))?.name).toBe("GPT-6 Astra 2");
  });

  it("keeps the model's name first when the user names an agent", () => {
    const entries = [
      {
        instanceId: ProviderInstanceId.make("codex"),
        models: [{ slug: "gpt-6-astra", name: "GPT-6 Astra" }],
      },
    ] as unknown as ReadonlyArray<ProviderInstanceEntry>;
    const secondAstraId = ThreadParticipantId.make("agent-astra-2");
    const labels = buildRoomAgentLabels(
      {
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
        agentRole: "Researcher",
        participants: [{ ...astra, id: secondAstraId, role: "Reviewer" }],
      },
      entries,
      (model) => model.name,
    );
    // Names never change the numbering, so clearing one brings back the same label.
    expect(labels?.get(roomAgentKey(null))?.name).toBe("GPT-6 Astra (Researcher)");
    expect(labels?.get(roomAgentKey(secondAstraId))).toMatchObject({
      name: "GPT-6 Astra 2 (Reviewer)",
      modelName: "GPT-6 Astra 2",
      role: "Reviewer",
    });
  });

  it("asks another agent now while one works, and queues when asked to or when it cannot", () => {
    const delivery = (overrides: Partial<Parameters<typeof resolveRoomDelivery>[0]>) =>
      resolveRoomDelivery({
        recipientId: astraId,
        holderId: null,
        holderBusy: true,
        recipientDriverKind: "codex",
        waitChosen: false,
        ...overrides,
      });
    expect(delivery({})).toBe("ask");
    expect(delivery({ waitChosen: true })).toBe("queue");
    // A provider that cannot answer read-only on the side always waits.
    expect(delivery({ recipientDriverKind: "cursor" })).toBe("queue");
    // The agent at work gets a steer, and an idle room just sends.
    expect(delivery({ holderId: astraId })).toBe("direct");
    expect(delivery({ holderBusy: false })).toBe("direct");
  });

  it("keeps a Send when done pick for one message while one turn works", () => {
    const threadRef = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread-room"));
    const [firstTurn, nextTurn] = [TurnId.make("turn-1"), TurnId.make("turn-2")];
    const store = useRoomRecipientStore.getState();
    const waitChosen = (turnId: TurnId) =>
      isRoomWaitChosen(useRoomRecipientStore.getState().waitChosen, threadRef, turnId);
    store.chooseWait(threadRef, firstTurn, true);
    expect(waitChosen(firstTurn)).toBe(true);
    // Once that turn is over, the next message is asked now again.
    expect(waitChosen(nextTurn)).toBe(false);
    // So is the one after a send.
    store.chooseWait(threadRef, null, false);
    expect(waitChosen(firstTurn)).toBe(false);
  });

  it("matches agents typed after @ however their names are spaced", () => {
    const agents = [{ name: "Opus 5.5" }, { name: "GPT-6 Astra" }, { name: "GPT-6 Astra 2" }];
    const names = (query: string) => matchRoomAgents(agents, query).map((agent) => agent.name);
    expect(names("astra")).toEqual(["GPT-6 Astra", "GPT-6 Astra 2"]);
    expect(names("gpt6astra2")).toEqual(["GPT-6 Astra 2"]);
    expect(names("opus5")).toEqual(["Opus 5.5"]);
    expect(names("")).toHaveLength(3);
    expect(names("retry.ts")).toEqual([]);
  });

  it("names who wrote an agent's message, who it is for, and how its request ended", () => {
    const entries = [
      {
        instanceId: ProviderInstanceId.make("codex"),
        models: [{ slug: "gpt-6-astra", name: "GPT-6 Astra" }],
      },
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        models: [{ slug: "opus-5-5", name: "Opus 5.5" }],
      },
    ] as unknown as ReadonlyArray<ProviderInstanceEntry>;
    const room = (leftAt: string | null) =>
      buildRoomAgentLabels(
        {
          modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus-5-5" },
          participants: [{ ...astra, leftAt }],
        },
        entries,
        (model) => model.name,
      );
    const describeMessage = (
      message: Parameters<typeof describeRoomAgentMessage>[0]["message"],
      openStatus: "pending" | "queued" | "running" | null = null,
      leftAt: string | null = null,
    ) => describeRoomAgentMessage({ message, labels: room(leftAt), openStatus });
    const handOff = {
      fromAgent: { participantId: null },
      participantId: astraId,
      requestKind: "hand_off" as const,
    };

    // The user's own messages are not agents' messages.
    expect(describeMessage({ participantId: astraId })).toBeNull();
    expect(describeMessage(handOff, "pending")).toMatchObject({
      from: "Opus 5.5",
      to: "GPT-6 Astra",
      kind: "handed off, starts when Opus 5.5 finishes",
      outcomeNote: null,
    });
    // The reply comes back the other way, and never carries a failure note.
    expect(
      describeMessage({
        fromAgent: { participantId: astraId },
        requestKind: "reply",
        requestOutcome: "failed",
      }),
    ).toMatchObject({ from: "GPT-6 Astra", to: "Opus 5.5", kind: "reply", outcomeNote: null });
    expect(
      describeMessage({ ...handOff, requestKind: "review", requestOutcome: "stopped" }),
    ).toMatchObject({
      kind: null,
      review: true,
      outcomeNote: "Stopped before GPT-6 Astra answered.",
    });
    expect(
      describeMessage({ ...handOff, requestOutcome: "cancelled" }, null, "2026-01-02T00:00:00.000Z")
        ?.outcomeNote,
    ).toBe("Cancelled: GPT-6 Astra left the room.");
    expect(describeMessage({ ...handOff, requestOutcome: "answered" })?.outcomeNote).toBeNull();
  });

  it("says what an independent review was shown", () => {
    const time = () => "10:32";
    expect(
      describeRoomReviewBasis(
        { kind: "uncommitted", files: 4, truncated: false, capturedAt: "2026-01-01T10:32:00Z" },
        time,
      ),
    ).toBe("Uncommitted changes, 4 files, captured 10:32");
    expect(
      describeRoomReviewBasis(
        {
          kind: "range",
          base: "0123456789abcdef0123456789abcdef01234567",
          head: "main",
          files: 1,
          truncated: true,
          capturedAt: "2026-01-01T10:32:00Z",
        },
        time,
      ),
    ).toBe("Changes from 0123456 to main, 1 file, captured 10:32, cut to fit");
  });
});
