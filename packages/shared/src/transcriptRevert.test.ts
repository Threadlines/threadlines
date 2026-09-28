import { describe, expect, it } from "vite-plus/test";

import { retainMessagesAfterRevert } from "./transcriptRevert.ts";

let sequence = 0;
const message = (
  id: string,
  role: "user" | "assistant",
  extra: {
    turnId?: string;
    sideTurnId?: string;
    requestKind?: string;
    requestOutcome?: string;
  } = {},
) => {
  sequence += 1;
  return {
    id,
    role,
    turnId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    eventSequence: sequence,
    ...extra,
  };
};

describe("retainMessagesAfterRevert", () => {
  it("never counts what agents did beside a turn as a turn, and drops it with the turns it followed", () => {
    const messages = [
      message("u1", "user"),
      message("invite-declined", "user", { requestKind: "invite" }),
      message("a1", "assistant", { turnId: "t1" }),
      // A review's reply that Stop took back before it was sent.
      message("reply-stopped", "user", { requestKind: "reply", requestOutcome: "cancelled" }),
      message("u2", "user"),
      message("invite", "user", { requestKind: "invite" }),
      message("review", "user", { requestKind: "review", sideTurnId: "s1" }),
      message("review-answer", "assistant", { sideTurnId: "s1" }),
      message("a2", "assistant", { turnId: "t2" }),
      message("reply", "user", { requestKind: "reply" }),
      message("a3", "assistant", { turnId: "t3" }),
      message("invite-late", "user", { requestKind: "invite" }),
    ];
    const kept = retainMessagesAfterRevert({
      messages,
      idOf: (entry) => entry.id,
      retainedTurnIds: new Set(["t1", "t2"]),
      turnCount: 2,
    });
    expect(kept.map((entry) => entry.id)).toEqual([
      "u1",
      "invite-declined",
      "a1",
      "reply-stopped",
      "u2",
      "invite",
      "review",
      "review-answer",
      "a2",
    ]);
  });
});
