import { describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { threadStatus, watchThreadStatus } from "./threadOperations.ts";

const THREAD = ThreadId.make("0f8f5a52-4d0e-4c1b-9d56-1e7c1f9b7a01");
const AT = "2026-10-23T10:00:00.000Z";

const shell = (patch: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell =>
  ({
    id: THREAD,
    title: "Thread",
    session: null,
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "completed",
      requestedAt: AT,
      startedAt: AT,
      completedAt: AT,
      assistantMessageId: null,
    },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingChildApproval: false,
    awaitedChildThreadCount: 0,
    doneOverride: null,
    ...patch,
  }) as unknown as OrchestrationThreadShell;

describe("threadStatus", () => {
  it("counts a plan the finished turn left for the user as needing the user", () => {
    expect(threadStatus(shell({ hasActionableProposedPlan: true }))).toEqual({
      word: "needs the user",
      waitingOn: "plan",
    });
    // Still working on it: not yet the user's.
    expect(
      threadStatus(
        shell({
          hasActionableProposedPlan: true,
          latestTurn: { ...shell().latestTurn!, state: "running" },
        }),
      ).word,
    ).toBe("working");
  });

  it("puts an approval ahead of the running turn that waits on it", () => {
    expect(
      threadStatus(
        shell({
          hasPendingApprovals: true,
          latestTurn: { ...shell().latestTurn!, state: "running" },
        }),
      ),
    ).toEqual({ word: "needs the user", waitingOn: "approval" });
  });
});

describe("watchThreadStatus", () => {
  it.effect("keeps a change that lands while the first reading is taken", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      let current = shell({ latestTurn: { ...shell().latestTurn!, state: "running" } });
      let reads = 0;
      const readings = yield* watchThreadStatus(
        {
          subscribeEvents: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
          // The turn ends during the first read: the read sees it running,
          // and its event is published before anything listens to the stream.
          readShell: () =>
            Effect.gen(function* () {
              reads += 1;
              const seen = current;
              if (reads === 1) {
                current = shell();
                yield* PubSub.publish(events, {
                  aggregateKind: "thread",
                  aggregateId: THREAD,
                  sequence: 2,
                  type: "thread.turn-diff-completed",
                } as unknown as OrchestrationEvent);
              }
              return seen;
            }),
          scheduleAnswerWaiting: Effect.succeed(new Set()),
          scheduleAnswerChanges: Stream.empty,
        },
        THREAD,
      ).pipe(Stream.take(2), Stream.runCollect);
      expect(readings.map((reading) => reading.status?.word)).toEqual(["working", "idle"]);
    }),
  );
});
