import { SideTurnId, ThreadId, ThreadParticipantId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  parseParticipantSessionKey,
  parseSessionKey,
  participantSessionKey,
  sessionKeyThreadId,
  sideSessionKey,
} from "./threadParticipants.ts";

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

  it("keeps a side answer's runtime apart from the agent it copies", () => {
    const threadId = ThreadId.make("5f0c2a4e-1111-4222-8333-944455556666");
    const agentId = ThreadParticipantId.make("7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d");
    const sideTurnId = SideTurnId.make("0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70");
    const sideKey = sideSessionKey(threadId, sideTurnId, agentId);
    expect(parseSessionKey(sideKey)).toEqual({
      kind: "side",
      threadId,
      sideTurnId,
      participantId: agentId,
    });
    expect(parseSessionKey(sideSessionKey(threadId, sideTurnId, null))).toMatchObject({
      kind: "side",
      participantId: null,
    });
    // Code that only knows working sessions never takes it for the agent.
    expect(parseParticipantSessionKey(sideKey)).toEqual({ threadId: sideKey, participantId: null });
    expect(sessionKeyThreadId(sideKey)).toBe(sideKey);
    expect(parseSessionKey(participantSessionKey(threadId, agentId))).toEqual({
      kind: "main",
      threadId,
      participantId: agentId,
    });
  });
});
