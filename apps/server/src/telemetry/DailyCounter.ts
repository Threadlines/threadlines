/**
 * DailyCounter - aggregates frequent telemetry events in memory and emits one
 * PostHog event per dimension tuple once a day (and when the server stops).
 *
 * Keeps event volume bounded on hot paths such as MCP tool calls, secret
 * redactions, and server stall samples.
 *
 * @module DailyCounter
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import { AnalyticsService } from "./Services/AnalyticsService.ts";

export type AnalyticsCounterDimensions = Readonly<Record<string, string | number | boolean>>;

export interface DailyAnalyticsCounter<T extends AnalyticsCounterDimensions> {
  readonly increment: (dimensions: T, by?: number) => void;
  readonly flush: Effect.Effect<void>;
}

export const makeDailyAnalyticsCounter = <T extends AnalyticsCounterDimensions>(options: {
  readonly event: string;
  readonly keyOf: (dimensions: T) => string;
  readonly interval?: Duration.Input;
}): Effect.Effect<DailyAnalyticsCounter<T>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const analytics = yield* Effect.serviceOption(AnalyticsService);
    const counts = new Map<string, { readonly dimensions: T; count: number }>();
    let clearGeneration = 0;

    const isAllowed = () => {
      if (Option.isNone(analytics)) return false;
      const consent = analytics.value.consent;
      return consent === undefined ? false : consent.isEnabledSync();
    };

    const unsubscribe =
      Option.isSome(analytics) && analytics.value.consent !== undefined
        ? analytics.value.consent.onDisabled(() => {
            clearGeneration += 1;
            counts.clear();
          })
        : undefined;

    const flush = Effect.suspend(() => {
      if (!isAllowed()) {
        counts.clear();
        return Effect.void;
      }
      if (counts.size === 0) return Effect.void;
      const generation = clearGeneration;
      const entries = [...counts.values()];
      counts.clear();
      return Option.isNone(analytics)
        ? Effect.void
        : Effect.forEach(
            entries,
            ({ dimensions, count }) =>
              Effect.suspend(() =>
                !isAllowed() || clearGeneration !== generation
                  ? Effect.void
                  : analytics.value.record(options.event, { ...dimensions, count }),
              ),
            { discard: true },
          );
    });

    const interval = options.interval ?? Duration.days(1);
    yield* flush.pipe(Effect.delay(interval), Effect.forever, Effect.forkScoped);
    if (unsubscribe !== undefined) {
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    }
    yield* Effect.addFinalizer(() => flush);

    return {
      increment: (dimensions, by = 1) => {
        if (by <= 0 || !isAllowed()) return;
        const key = options.keyOf(dimensions);
        const existing = counts.get(key);
        if (existing) {
          existing.count += by;
        } else {
          counts.set(key, { dimensions, count: by });
        }
      },
      flush,
    } satisfies DailyAnalyticsCounter<T>;
  });
