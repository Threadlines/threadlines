import {
  EventId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";

import { makeSleepInhibitionController, type SleepAssertionHolder } from "./SleepInhibitor.ts";
import type { SleepInhibitionInput } from "../sleepInhibitionState.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const turnStarted = (threadId: string): SleepInhibitionInput => ({
  kind: "runtime-event",
  event: {
    type: "turn.started",
    eventId: EventId.make(`evt-start-${threadId}`),
    provider: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make(threadId),
    createdAt: NOW,
    turnId: TurnId.make(`turn-${threadId}`),
    payload: {},
  } satisfies ProviderRuntimeEvent,
});

const turnCompleted = (threadId: string): SleepInhibitionInput => ({
  kind: "runtime-event",
  event: {
    type: "turn.completed",
    eventId: EventId.make(`evt-complete-${threadId}`),
    provider: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make(threadId),
    createdAt: NOW,
    turnId: TurnId.make(`turn-${threadId}`),
    payload: { state: "completed" },
  } satisfies ProviderRuntimeEvent,
});

function makeRecordingHolder() {
  const calls: Array<"engage" | "release"> = [];
  const holder: SleepAssertionHolder = {
    engage: Effect.sync(() => {
      calls.push("engage");
    }),
    release: Effect.sync(() => {
      calls.push("release");
    }),
  };
  return { holder, calls };
}

/** Lets this many minutes pass on the test clock between inputs. */
type ControllerStep = SleepInhibitionInput | { readonly minutes: number };

const runController = (
  steps: ReadonlyArray<ControllerStep>,
  options: { readonly shutdown?: boolean } = {},
) => {
  const { holder, calls } = makeRecordingHolder();
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const controller = yield* makeSleepInhibitionController(holder, {
          releaseGrace: "5 minutes",
        });
        for (const step of steps) {
          if ("minutes" in step) {
            yield* TestClock.adjust(`${step.minutes} minutes`);
            yield* Effect.yieldNow;
          } else {
            yield* controller.handle(step);
          }
        }
        if (options.shutdown) {
          yield* controller.shutdown;
        }
        return [...calls];
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
};

describe("makeSleepInhibitionController", () => {
  it("engages on the first active turn and releases a while after the last one", async () => {
    const turns = [
      turnStarted("thread-1"),
      turnStarted("thread-2"),
      turnCompleted("thread-1"),
      turnCompleted("thread-2"),
    ];
    expect(await runController([...turns, { minutes: 4 }])).toEqual(["engage"]);
    expect(await runController([...turns, { minutes: 5 }])).toEqual(["engage", "release"]);
  });

  // Each engage starts a helper process; a conversation's turns share one.
  it("keeps the assertion between turns that follow each other", async () => {
    const calls = await runController([
      turnStarted("thread-1"),
      turnCompleted("thread-1"),
      { minutes: 3 },
      turnStarted("thread-1"),
      turnCompleted("thread-1"),
      { minutes: 3 },
      { minutes: 3 },
    ]);
    expect(calls).toEqual(["engage", "release"]);
  });

  it("releases immediately when the setting is disabled mid-turn and re-engages on enable", async () => {
    const calls = await runController([
      turnStarted("thread-1"),
      { kind: "settings", enabled: false },
      { kind: "settings", enabled: true },
    ]);
    expect(calls).toEqual(["engage", "release", "engage"]);
  });

  it("never engages while disabled", async () => {
    const calls = await runController([
      { kind: "settings", enabled: false },
      turnStarted("thread-1"),
      turnCompleted("thread-1"),
    ]);
    expect(calls).toEqual([]);
  });

  it("releases a held assertion on shutdown exactly once", async () => {
    const held = await runController([turnStarted("thread-1")], { shutdown: true });
    expect(held).toEqual(["engage", "release"]);

    const idle = await runController([turnStarted("thread-1"), turnCompleted("thread-1")], {
      shutdown: true,
    });
    expect(idle).toEqual(["engage", "release"]);
  });
});
