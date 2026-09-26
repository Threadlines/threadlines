import {
  CheckpointRef,
  MessageId,
  ProviderInstanceId,
  SideTurnId,
  ThreadParticipantId,
  TurnId,
  type OrchestrationMessage,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildRoomCatchUp, ROOM_JOIN_MESSAGE_COUNT, type RoomCatchUpInput } from "./roomCatchUp.ts";

const at = "2026-01-01T00:00:00.000Z";
const astraId = ThreadParticipantId.make("agent-astra");
const astra = {
  id: astraId,
  handle: "GPT-6 Astra",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
  joinedAt: at,
  leftAt: null,
};

let nextSequence = 0;
function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  participantId: ThreadParticipantId | null = null,
  extra: Partial<OrchestrationMessage> = {},
): OrchestrationMessage {
  nextSequence += 1;
  return {
    id: MessageId.make(id),
    eventSequence: nextSequence,
    role,
    text,
    ...(participantId !== null ? { participantId } : {}),
    turnId: null,
    streaming: false,
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

const main = { cursor: null, lane: "main" } as const;

function thread(
  messages: ReadonlyArray<OrchestrationMessage>,
  overrides: Partial<RoomCatchUpInput["thread"]> = {},
): RoomCatchUpInput["thread"] {
  return {
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "fable-5-1" },
    participants: [astra],
    messages,
    checkpoints: [],
    ...overrides,
  };
}

describe("buildRoomCatchUp", () => {
  it("sends nothing in an ordinary thread", () => {
    const messages = [message("u1", "user", "hi"), message("u2", "user", "now")];
    expect(
      buildRoomCatchUp({
        thread: thread(messages, { participants: [] }),
        participantId: null,
        messageId: MessageId.make("u2"),
        ...main,
      }),
    ).toBeUndefined();
  });

  it("tells an agent what the others said and changed since it last took part", () => {
    const messages = [
      message("u1", "user", "fix the reconnect bug"),
      message("a1", "assistant", "Fixed it."),
      message("u2", "user", "review Fable's change", astraId),
      message("a2", "assistant", "One ordering issue remains.", astraId),
      message("u3", "user", "what did astra find?"),
    ];
    const note = buildRoomCatchUp({
      thread: thread(messages, {
        checkpoints: [
          {
            turnId: TurnId.make("turn-astra"),
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.make("ref-2"),
            status: "ready",
            files: [{ path: "connection.ts", kind: "modified", additions: 4, deletions: 1 }],
            assistantMessageId: MessageId.make("a2"),
            completedAt: at,
          },
        ],
      }),
      participantId: null,
      messageId: MessageId.make("u3"),
      ...main,
    })?.note;

    expect(note).toContain("since you were last caught up");
    expect(note).toContain("User, to GPT-6 Astra (gpt-6-astra):\nreview Fable's change");
    expect(note).toContain("GPT-6 Astra (gpt-6-astra):\nOne ordering issue remains.");
    expect(note).toContain("connection.ts +4 -1");
    // The agent's own earlier words, and the message being sent, are not repeated.
    expect(note).not.toContain("Fixed it.");
    expect(note).not.toContain("what did astra find?");
  });

  it("sends nothing to an agent that is already up to date", () => {
    const messages = [
      message("u1", "user", "review", astraId),
      message("a1", "assistant", "Done.", astraId),
      message("u2", "user", "and the tests?", astraId),
    ];
    expect(
      buildRoomCatchUp({
        thread: thread(messages),
        participantId: astraId,
        messageId: MessageId.make("u2"),
        ...main,
      })?.note,
    ).toBeUndefined();
  });

  it("gives a late joiner the recent messages and says how many were left out", () => {
    const messages = [
      ...Array.from({ length: ROOM_JOIN_MESSAGE_COUNT + 3 }, (_, index) =>
        message(`m${index}`, index % 2 === 0 ? "user" : "assistant", `message ${index}`),
      ),
      message("now", "user", "astra, take a look", astraId),
    ];
    const note = buildRoomCatchUp({
      thread: thread(messages),
      participantId: astraId,
      messageId: MessageId.make("now"),
      ...main,
    })?.note;

    expect(note).toContain("You were just brought into this thread.");
    expect(note).toContain("(3 earlier messages left out.)");
    expect(note).not.toContain("message 2\n");
    expect(note).toContain(`message ${ROOM_JOIN_MESSAGE_COUNT + 2}`);
  });

  it("delivers a side exchange that landed before the agent's own reply", () => {
    const sideTurnId = SideTurnId.make("0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70");
    const messages = [
      message("u1", "user", "fix the reconnect bug"),
      message("s1", "user", "is that approach safe?", astraId, { sideTurnId }),
      message("s2", "assistant", "Mostly; watch the retry cap.", astraId, { sideTurnId }),
      message("a1", "assistant", "Fixed it."),
      message("u2", "user", "and now?"),
    ];
    const caughtUp = buildRoomCatchUp({
      thread: thread(messages),
      participantId: null,
      messageId: MessageId.make("u2"),
      // It was told everything up to its last turn's start.
      cursor: {
        conversationId: "c1",
        throughSequence: messages[0]!.eventSequence!,
        partialMessageIds: [],
      },
      lane: "main",
    });

    expect(caughtUp?.note).toContain("(asked on the side):\nis that approach safe?");
    expect(caughtUp?.note).toContain("(answering on the side):\nMostly; watch the retry cap.");
    expect(caughtUp?.note).not.toContain("Fixed it.");
    expect(caughtUp?.cursor.throughSequence).toBe(messages[3]!.eventSequence);
  });

  it("sends a reply again in full once it has finished streaming", () => {
    const messages = [
      message("u1", "user", "review it", astraId),
      message(
        "a1",
        "assistant",
        "One ordering issue remains, and the retry cap is off by one.",
        astraId,
      ),
      message("u2", "user", "what did astra find?"),
    ];
    const caughtUp = buildRoomCatchUp({
      thread: thread(messages),
      participantId: null,
      messageId: MessageId.make("u2"),
      cursor: {
        conversationId: "c1",
        throughSequence: messages[1]!.eventSequence!,
        partialMessageIds: [MessageId.make("a1")],
      },
      lane: "main",
    });

    expect(caughtUp?.note).toContain(
      "(finished since you last saw it):\nOne ordering issue remains",
    );
    expect(caughtUp?.cursor.partialMessageIds).toEqual([]);
  });
});
