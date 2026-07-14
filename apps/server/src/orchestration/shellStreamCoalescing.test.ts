import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@threadlines/contracts";
import assert from "node:assert/strict";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, it } from "vite-plus/test";

import { coalesceLatestAggregateEvents } from "./shellStreamCoalescing.ts";

function makeEvent(input: {
  sequence: number;
  aggregateKind: OrchestrationEvent["aggregateKind"];
  aggregateId: string;
  type?: OrchestrationEvent["type"];
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type:
      input.type ??
      (input.aggregateKind === "project" ? "project.meta-updated" : "thread.meta-updated"),
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === "project"
        ? ProjectId.make(input.aggregateId)
        : ThreadId.make(input.aggregateId),
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: CommandId.make(`cmd-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {} as never,
  } as OrchestrationEvent;
}

const sequencesOf = (events: Iterable<OrchestrationEvent>): number[] =>
  Array.from(events, (event) => event.sequence);

describe("coalesceLatestAggregateEvents", () => {
  it("keeps only the latest event per aggregate within a window", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const source = Stream.fromIterable([
          makeEvent({ sequence: 1, aggregateKind: "thread", aggregateId: "thread-a" }),
          makeEvent({ sequence: 2, aggregateKind: "thread", aggregateId: "thread-a" }),
          makeEvent({ sequence: 3, aggregateKind: "project", aggregateId: "project-x" }),
          makeEvent({ sequence: 4, aggregateKind: "thread", aggregateId: "thread-b" }),
          makeEvent({ sequence: 5, aggregateKind: "thread", aggregateId: "thread-a" }),
        ]);

        const collected = yield* Stream.runCollect(coalesceLatestAggregateEvents(source));

        // One event per aggregate, latest sequence wins, ascending order.
        assert.deepStrictEqual(sequencesOf(collected), [3, 4, 5]);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  it("flushes per window while the source stays open", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const firstBatch = [
          makeEvent({ sequence: 1, aggregateKind: "thread", aggregateId: "thread-a" }),
          makeEvent({ sequence: 2, aggregateKind: "thread", aggregateId: "thread-a" }),
        ];
        const secondBatch = [
          makeEvent({ sequence: 6, aggregateKind: "thread", aggregateId: "thread-a" }),
          makeEvent({ sequence: 7, aggregateKind: "thread", aggregateId: "thread-a" }),
        ];
        const source = Stream.fromIterable(firstBatch).pipe(
          Stream.concat(Stream.drain(Stream.fromEffect(Effect.sleep(Duration.millis(400))))),
          Stream.concat(Stream.fromIterable(secondBatch)),
        );

        const fiber = yield* Effect.forkChild(
          Stream.runCollect(coalesceLatestAggregateEvents(source, Duration.millis(150))),
        );
        yield* TestClock.adjust(Duration.millis(1000));
        const collected = yield* Fiber.join(fiber);

        // First window tick flushes the latest of batch one; the final flush on
        // source end emits the latest of batch two. Intermediate events are
        // coalesced away.
        assert.deepStrictEqual(sequencesOf(collected), [2, 7]);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  it("emits nothing extra for an empty source", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const collected = yield* Stream.runCollect(coalesceLatestAggregateEvents(Stream.empty));
        assert.deepStrictEqual(sequencesOf(collected), []);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  it("does not coalesce an archive removal behind a later session event", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const source = Stream.fromIterable([
          makeEvent({ sequence: 1, aggregateKind: "thread", aggregateId: "thread-a" }),
          makeEvent({
            sequence: 2,
            aggregateKind: "thread",
            aggregateId: "thread-b",
            type: "thread.archived",
          }),
          makeEvent({ sequence: 3, aggregateKind: "thread", aggregateId: "thread-b" }),
        ]);

        const collected = yield* Stream.runCollect(coalesceLatestAggregateEvents(source));

        assert.deepStrictEqual(sequencesOf(collected), [1, 2, 3]);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });
});
