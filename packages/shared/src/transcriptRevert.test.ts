import { describe, expect, it } from "vite-plus/test";

import {
  retainTurnItemsAfterRevert,
  retainMessagesAfterRevert,
  revertMessages,
} from "./transcriptRevert.ts";

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

describe("retainTurnItemsAfterRevert", () => {
  it("keeps what a kept turn showed and drops what came after the first removed message", () => {
    const messages = [
      message("u1", "user"),
      message("a1", "assistant", { turnId: "t1" }),
      message("u2", "user"),
      message("a2", "assistant", { turnId: "t2" }),
    ];
    // Pages placed by event order: one in each turn, each before its turn's reply.
    const after = (index: number) => messages[index]!.eventSequence + 0.5;
    const at = "2026-01-01T00:00:00.000Z";
    const pages = [
      { id: "page-t1", turnId: "t1", createdAt: at, eventSequence: after(0) },
      { id: "page-t2", turnId: "t2", createdAt: at, eventSequence: after(2) },
      // Turn 1's page that arrived late, behind turn 2's first message.
      { id: "page-t1-late", turnId: "t1", createdAt: at, eventSequence: after(2) + 0.1 },
      // The same for a kept turn that was stopped before it wrote a message.
      { id: "page-t0-late", turnId: "t0", createdAt: at, eventSequence: after(2) + 0.2 },
    ];
    const reverted = revertMessages({
      messages,
      idOf: (entry) => entry.id,
      retainedTurnIds: new Set(["t0", "t1"]),
      turnCount: 1,
    });
    expect(retainTurnItemsAfterRevert(pages, reverted).map((page) => page.id)).toEqual([
      "page-t1",
      "page-t1-late",
      "page-t0-late",
    ]);
  });

  it("keeps everything when a revert removes no message", () => {
    const messages = [message("u1", "user"), message("a1", "assistant", { turnId: "t1" })];
    const reverted = revertMessages({
      messages,
      idOf: (entry) => entry.id,
      retainedTurnIds: new Set(["t1"]),
      turnCount: 1,
    });
    const pages = [
      { id: "page", turnId: "t9", createdAt: "2026-01-01T00:00:00.000Z", eventSequence: 99 },
    ];
    expect(retainTurnItemsAfterRevert(pages, reverted)).toBe(pages);
  });
});
