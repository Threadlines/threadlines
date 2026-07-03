import type { OrchestrationEvent } from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * Window used to coalesce the domain-event firehose for shell subscribers.
 *
 * During a streaming turn the engine emits an event roughly every 50ms per
 * active thread. Shell consumers only render the latest state of each
 * aggregate (sidebar rows), so forwarding every event just multiplies
 * projection queries and WebSocket pushes per subscriber. 150ms keeps the
 * sidebar visibly live while capping the per-thread resolve/push rate at
 * ~7/s regardless of delta rate.
 */
export const SHELL_STREAM_COALESCE_WINDOW_MILLIS = 150;

/**
 * Coalesces orchestration events to the latest event per aggregate within a
 * time window.
 *
 * Within each window only the highest-sequence event per aggregate survives;
 * flushes emit in ascending sequence order so downstream per-environment
 * sequence guards (which drop lower-than-last-applied sequences) never
 * discard a coalesced update. Because the source delivers events in sequence
 * order, batches are monotonic across windows too. Any events still pending
 * when the source completes are flushed before the stream ends.
 */
export const coalesceLatestAggregateEvents = (
  source: Stream.Stream<OrchestrationEvent>,
  window: Duration.Input = Duration.millis(SHELL_STREAM_COALESCE_WINDOW_MILLIS),
): Stream.Stream<OrchestrationEvent> =>
  Stream.unwrap(
    Effect.sync(() => {
      const pending = new Map<string, OrchestrationEvent>();

      const stash = (event: OrchestrationEvent): Stream.Stream<OrchestrationEvent> => {
        const key = `${event.aggregateKind}:${event.aggregateId}`;
        const existing = pending.get(key);
        if (existing === undefined || event.sequence >= existing.sequence) {
          pending.set(key, event);
        }
        return Stream.empty;
      };

      const flush = (): Stream.Stream<OrchestrationEvent> => {
        if (pending.size === 0) {
          return Stream.empty;
        }
        const events = Array.from(pending.values()).toSorted(
          (left, right) => left.sequence - right.sequence,
        );
        pending.clear();
        return Stream.fromIterable(events);
      };

      const stashedWithFinalFlush = Stream.concat(
        Stream.flatMap(source, stash),
        Stream.suspend(flush),
      );

      // "left" halt: the source (plus its final flush) decides the lifetime;
      // the ticker is interrupted with it instead of keeping the stream open.
      return Stream.merge(stashedWithFinalFlush, Stream.flatMap(Stream.tick(window), flush), {
        haltStrategy: "left",
      });
    }),
  );
