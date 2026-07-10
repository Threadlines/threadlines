import {
  EventId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vitest";

import {
  initialSleepInhibitionState,
  reduceSleepInhibitionState,
  shouldInhibitSleep,
  type SleepInhibitionInput,
  type SleepInhibitionState,
} from "./sleepInhibitionState.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const turnStarted = (threadId: string): ProviderRuntimeEvent => ({
  type: "turn.started",
  eventId: EventId.make(`evt-start-${threadId}`),
  provider: ProviderDriverKind.make("codex"),
  threadId: ThreadId.make(threadId),
  createdAt: NOW,
  turnId: TurnId.make(`turn-${threadId}`),
  payload: {},
});

const turnCompleted = (threadId: string): ProviderRuntimeEvent => ({
  type: "turn.completed",
  eventId: EventId.make(`evt-complete-${threadId}`),
  provider: ProviderDriverKind.make("codex"),
  threadId: ThreadId.make(threadId),
  createdAt: NOW,
  turnId: TurnId.make(`turn-${threadId}`),
  payload: { state: "completed" },
});

const sessionExited = (threadId: string): ProviderRuntimeEvent => ({
  type: "session.exited",
  eventId: EventId.make(`evt-exit-${threadId}`),
  provider: ProviderDriverKind.make("codex"),
  threadId: ThreadId.make(threadId),
  createdAt: NOW,
  payload: {},
});

const runtimeInput = (event: ProviderRuntimeEvent): SleepInhibitionInput => ({
  kind: "runtime-event",
  event,
});

const reduceAll = (
  state: SleepInhibitionState,
  inputs: ReadonlyArray<SleepInhibitionInput>,
): SleepInhibitionState => inputs.reduce(reduceSleepInhibitionState, state);

describe("reduceSleepInhibitionState", () => {
  it("inhibits while any thread has a turn in flight", () => {
    let state = initialSleepInhibitionState(true);
    expect(shouldInhibitSleep(state)).toBe(false);

    state = reduceAll(state, [
      runtimeInput(turnStarted("thread-1")),
      runtimeInput(turnStarted("thread-2")),
      runtimeInput(turnCompleted("thread-1")),
    ]);
    expect(shouldInhibitSleep(state)).toBe(true);

    state = reduceSleepInhibitionState(state, runtimeInput(turnCompleted("thread-2")));
    expect(shouldInhibitSleep(state)).toBe(false);
  });

  it("clears a thread when its session exits mid-turn", () => {
    const state = reduceAll(initialSleepInhibitionState(true), [
      runtimeInput(turnStarted("thread-1")),
      runtimeInput(sessionExited("thread-1")),
    ]);
    expect(shouldInhibitSleep(state)).toBe(false);
  });

  it("keeps tracking turns while disabled so re-enabling engages immediately", () => {
    let state = reduceAll(initialSleepInhibitionState(true), [
      { kind: "settings", enabled: false },
      runtimeInput(turnStarted("thread-1")),
    ]);
    expect(shouldInhibitSleep(state)).toBe(false);

    state = reduceSleepInhibitionState(state, { kind: "settings", enabled: true });
    expect(shouldInhibitSleep(state)).toBe(true);
  });

  it("returns the same reference for inputs that change nothing", () => {
    const active = reduceSleepInhibitionState(
      initialSleepInhibitionState(true),
      runtimeInput(turnStarted("thread-1")),
    );

    expect(reduceSleepInhibitionState(active, runtimeInput(turnStarted("thread-1")))).toBe(active);
    expect(reduceSleepInhibitionState(active, runtimeInput(turnCompleted("thread-other")))).toBe(
      active,
    );
    expect(reduceSleepInhibitionState(active, { kind: "settings", enabled: true })).toBe(active);
    expect(
      reduceSleepInhibitionState(active, {
        kind: "runtime-event",
        event: {
          type: "thread.started",
          eventId: EventId.make("evt-unrelated"),
          provider: ProviderDriverKind.make("codex"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
          payload: {},
        },
      }),
    ).toBe(active);
  });
});
