import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeTurnLatencyTracker } from "./turnLatency.ts";

const threadId = ThreadId.make("thread-latency");
const eventBase = (turnId: string, eventId: string) => ({
  eventId: EventId.make(eventId),
  provider: ProviderDriverKind.make("claudeAgent"),
  threadId,
  turnId: TurnId.make(turnId),
  createdAt: "2026-01-01T00:00:00.000Z",
});
const assistantDelta = (turnId: string, eventId: string): ProviderRuntimeEvent => ({
  ...eventBase(turnId, eventId),
  type: "content.delta",
  itemId: RuntimeItemId.make("msg-1"),
  payload: { streamKind: "assistant_text", delta: "text" },
});
const turnCompleted = (turnId: string, eventId: string): ProviderRuntimeEvent => ({
  ...eventBase(turnId, eventId),
  type: "turn.completed",
  payload: { state: "completed" },
});

const turn = {
  requestedAtMs: 1_000,
  provider: "claudeAgent",
  instanceId: "claudeAgent",
  model: "claude-opus-5-5",
  attachmentCount: 0,
};
const sample = (firstOutputMs: number) => ({
  provider: "claudeAgent",
  model: "claude-opus-5-5",
  attachmentCount: 0,
  sessionStarted: false,
  handoffMs: 400,
  firstOutputMs,
});

describe("makeTurnLatencyTracker", () => {
  it("ignores other turns' events while a turn is being sent", () => {
    const tracker = makeTurnLatencyTracker();
    const { handoffMs, sendId } = tracker.sending(threadId, { ...turn, nowMs: 1_400 });
    expect(handoffMs).toBe(400);
    // The previous turn still streaming, and a turn the provider ran on its own ending.
    expect(tracker.observe(assistantDelta("turn-1", "evt-late"), 1_500)).toBeUndefined();
    expect(tracker.observe(turnCompleted("turn-own", "evt-own-done"), 1_550)).toBeUndefined();
    expect(tracker.sent(threadId, sendId, TurnId.make("turn-2"))).toBeUndefined();
    expect(tracker.observe(assistantDelta("turn-1", "evt-later"), 1_600)).toBeUndefined();

    expect(tracker.observe(assistantDelta("turn-2", "evt-first"), 3_000)).toEqual(sample(2_000));
    expect(tracker.observe(assistantDelta("turn-2", "evt-second"), 3_100)).toBeUndefined();
  });

  it("leaves a newer send's timing alone when an older send finishes", () => {
    const tracker = makeTurnLatencyTracker();
    const older = tracker.sending(threadId, { ...turn, nowMs: 1_400 });
    const newer = tracker.sending(threadId, { ...turn, requestedAtMs: 2_000, nowMs: 2_400 });
    expect(tracker.sent(threadId, older.sendId, TurnId.make("turn-a"))).toBeUndefined();
    tracker.notSent(threadId, older.sendId);
    expect(tracker.observe(assistantDelta("turn-a", "evt-a"), 2_500)).toBeUndefined();
    expect(tracker.sent(threadId, newer.sendId, TurnId.make("turn-b"))).toBeUndefined();
    expect(tracker.observe(assistantDelta("turn-b", "evt-b"), 3_000)).toEqual(sample(1_000));
  });

  it("counts output that arrives before the send returns", () => {
    const tracker = makeTurnLatencyTracker();
    const { sendId } = tracker.sending(threadId, { ...turn, nowMs: 1_400 });
    expect(tracker.observe(assistantDelta("turn-2", "evt-first"), 1_700)).toBeUndefined();
    expect(tracker.sent(threadId, sendId, TurnId.make("turn-2"))).toEqual(sample(700));
    expect(tracker.observe(assistantDelta("turn-2", "evt-second"), 1_800)).toBeUndefined();
  });
});
