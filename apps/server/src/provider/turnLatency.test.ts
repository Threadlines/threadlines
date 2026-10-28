import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
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
  sessionStartedEarly: false,
};
const sample = (firstOutputMs: number) => ({
  provider: "claudeAgent",
  model: "claude-opus-5-5",
  attachmentCount: 0,
  sessionStarted: false,
  sessionStartedEarly: false,
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

  it("names the start a turn waited on, and an early one it didn't", () => {
    const tracker = makeTurnLatencyTracker();
    const coldStart = { kind: "fresh" as const, startMs: 250 };
    // The message arrived at 1000; the agent started for it from 1050 to 1300.
    tracker.sessionStarted(threadId, {
      beganAtMs: 1_050,
      atMs: 1_300,
      instanceId: "claudeAgent",
      timing: coldStart,
    });
    const cold = tracker.sending(threadId, { ...turn, nowMs: 1_400 });
    tracker.sent(threadId, cold.sendId, TurnId.make("turn-1"));
    expect(tracker.observe(assistantDelta("turn-1", "evt-1"), 2_000)).toEqual({
      ...sample(1_000),
      sessionStarted: true,
      sessionStart: coldStart,
    });

    // The next message goes to the agent already running.
    const warm = tracker.sending(threadId, { ...turn, requestedAtMs: 3_000, nowMs: 3_400 });
    tracker.sent(threadId, warm.sendId, TurnId.make("turn-2"));
    expect(tracker.observe(assistantDelta("turn-2", "evt-2"), 4_000)).toEqual(sample(1_000));

    // A start already underway when the message came was only partly its wait.
    tracker.sessionStarted(threadId, {
      beganAtMs: 4_500,
      atMs: 5_300,
      instanceId: "claudeAgent",
      timing: { kind: "resume", startMs: 800 },
    });
    const overlapping = tracker.sending(threadId, { ...turn, requestedAtMs: 5_000, nowMs: 5_400 });
    tracker.sent(threadId, overlapping.sendId, TurnId.make("turn-3"));
    expect(tracker.observe(assistantDelta("turn-3", "evt-3"), 6_000)).toEqual({
      ...sample(1_000),
      sessionStarted: true,
    });

    // Started while the user typed, before the message: named, but not waited on.
    const earlyStart = { kind: "resume" as const, startMs: 1_500 };
    tracker.sessionStarted(threadId, {
      beganAtMs: 5_000,
      atMs: 6_500,
      instanceId: "claudeAgent",
      timing: earlyStart,
    });
    const early = tracker.sending(threadId, {
      ...turn,
      requestedAtMs: 7_000,
      nowMs: 7_400,
      sessionStartedEarly: true,
    });
    tracker.sent(threadId, early.sendId, TurnId.make("turn-4"));
    expect(tracker.observe(assistantDelta("turn-4", "evt-4"), 8_000)).toEqual({
      ...sample(1_000),
      sessionStartedEarly: true,
      sessionStart: earlyStart,
    });
  });

  it("keeps a turn when the runtime it replaced exits late", () => {
    const tracker = makeTurnLatencyTracker();
    const start = { kind: "same_provider_restart" as const, startMs: 200 };
    tracker.sessionStarted(threadId, {
      beganAtMs: 1_100,
      atMs: 1_300,
      instanceId: "claudeAgent",
      timing: start,
    });
    const { sendId } = tracker.sending(threadId, { ...turn, nowMs: 1_400 });
    tracker.sent(threadId, sendId, TurnId.make("turn-1"));
    // The old runtime's exit, stamped while the new one was starting, arrives now.
    const lateExit: ProviderRuntimeEvent = {
      eventId: EventId.make("evt-old-exit"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      threadId,
      createdAt: new Date(1_200).toISOString(),
      type: "session.exited",
      payload: {},
    };
    expect(tracker.observe(lateExit, 1_500)).toBeUndefined();
    expect(tracker.observe(assistantDelta("turn-1", "evt-1"), 2_000)).toEqual({
      ...sample(1_000),
      sessionStarted: true,
      sessionStart: start,
    });
  });
});
