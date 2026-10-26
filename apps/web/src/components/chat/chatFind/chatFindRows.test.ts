import type { RoomAgentRequestId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage } from "../../../types";
import type { MessagesTimelineRow } from "../MessagesTimeline.logic";
import { type ChatFindRowContext, findableRowBlocks } from "./chatFindRows";

function messageRow(
  message: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "text">,
  placement: Partial<Pick<MessagesTimelineRow, "agentLine">> = {},
): MessagesTimelineRow {
  return {
    kind: "message",
    id: message.id,
    createdAt: "2026-04-13T12:00:00.000Z",
    message: { streaming: false, createdAt: "2026-04-13T12:00:00.000Z", ...message },
    settledNote: false,
    turnSummary: null,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
    assistantTurnInProgress: false,
    padTop: false,
    ...placement,
  };
}

const requestId = "request-1" as RoomAgentRequestId;
const context: ChatFindRowContext = {
  cwd: "/repo",
  skills: [],
  visualizations: true,
  sideAnswerRequests: new Set([requestId]),
};

describe("findableRowBlocks", () => {
  it("reads the conversation's own words", () => {
    expect(
      findableRowBlocks(
        messageRow({ id: "m1" as ChatMessage["id"], role: "assistant", text: "The **answer**." }),
        context,
      ),
    ).toEqual(["The answer."]);
    expect(
      findableRowBlocks(
        messageRow({ id: "m2" as ChatMessage["id"], role: "user", text: "Please look" }),
        context,
      ),
    ).toEqual(["Please look"]);
    // An agent's message to another reads as the markdown it is drawn as.
    expect(
      findableRowBlocks(
        messageRow({
          id: "m5" as ChatMessage["id"],
          role: "user",
          text: "Done, **merged**.\n\n- Tests pass",
          fromAgent: { participantId: null },
          requestKind: "hand_off",
        }),
        context,
      ),
    ).toEqual(["Done, merged.", "Tests pass"]);
  });

  it("skips rows that only say where an answer already in the chat went", () => {
    const sideReply = messageRow({
      id: "m3" as ChatMessage["id"],
      role: "user",
      text: "The full answer, repeated",
      fromAgent: { participantId: null },
      requestKind: "reply",
      requestId,
    });
    const echo = messageRow(
      {
        id: "m4" as ChatMessage["id"],
        role: "user",
        text: "The full answer, repeated",
        fromAgent: { participantId: null },
        requestKind: "reply",
      },
      {
        agentLine: {
          placement: "single",
          agent: null,
          turnId: null,
          heads: true,
          nested: null,
          echoesAnswer: true,
          asWritten: null,
        },
      },
    );
    expect(findableRowBlocks(sideReply, context)).toBeNull();
    expect(findableRowBlocks(echo, context)).toBeNull();
  });
});
