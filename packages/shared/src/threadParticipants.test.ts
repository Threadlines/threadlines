import { ThreadId, ThreadParticipantId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseParticipantSessionKey, participantSessionKey } from "./threadParticipants.ts";

describe("participant session keys", () => {
  it("round-trips a room agent's key and leaves ordinary thread ids alone", () => {
    const threadId = ThreadId.make("5f0c2a4e-1111-4222-8333-944455556666");
    const agentId = ThreadParticipantId.make("7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d");
    expect(parseParticipantSessionKey(participantSessionKey(threadId, agentId))).toEqual({
      threadId,
      participantId: agentId,
    });
    expect(participantSessionKey(threadId, null)).toBe(threadId);
    // A thread whose own id contains the separator is still just a thread.
    const oddThread = ThreadId.make("project__agent__7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d");
    expect(parseParticipantSessionKey(oddThread)).toEqual({
      threadId: oddThread,
      participantId: null,
    });
  });
});
