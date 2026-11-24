import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { makeDailyAnalyticsCounter } from "./DailyCounter.ts";
import { AnalyticsService } from "./Services/AnalyticsService.ts";

describe("DailyCounter", () => {
  it.effect("aggregates increments by key and flushes on schedule and scope close", () =>
    Effect.gen(function* () {
      const recorded: Array<{
        readonly event: string;
        readonly properties: Readonly<Record<string, unknown>> | undefined;
      }> = [];

      yield* Effect.scoped(
        Effect.gen(function* () {
          const counter = yield* makeDailyAnalyticsCounter<{
            readonly tool: string;
            readonly outcome: string;
          }>({
            event: "test.counter",
            keyOf: ({ tool, outcome }) => `${tool}\u0000${outcome}`,
            interval: Duration.hours(1),
          });

          counter.increment({ tool: "open", outcome: "ok" });
          counter.increment({ tool: "open", outcome: "ok" });
          counter.increment({ tool: "open", outcome: "error" });

          yield* TestClock.adjust(Duration.hours(1));
          assert.deepStrictEqual(recorded, [
            { event: "test.counter", properties: { tool: "open", outcome: "ok", count: 2 } },
            { event: "test.counter", properties: { tool: "open", outcome: "error", count: 1 } },
          ]);

          // New increments flush on scope close (server shutdown).
          counter.increment({ tool: "close", outcome: "ok" }, 3);
        }),
      ).pipe(
        Effect.provideService(AnalyticsService, {
          record: (event, properties) => Effect.sync(() => recorded.push({ event, properties })),
          flush: Effect.void,
          consent: {
            isEnabledSync: () => true,
            onDisabled: () => () => {},
          },
        }),
      );

      assert.deepStrictEqual(recorded.at(-1), {
        event: "test.counter",
        properties: { tool: "close", outcome: "ok", count: 3 },
      });
    }),
  );

  it.effect("ignores opted-out increments and clears pending counts on opt-out", () =>
    Effect.gen(function* () {
      const recorded: Array<{
        readonly event: string;
        readonly properties: Readonly<Record<string, unknown>> | undefined;
      }> = [];
      let enabled = false;
      const listeners = new Set<() => void>();
      const setEnabled = (next: boolean) => {
        const prev = enabled;
        enabled = next;
        if (prev && !next) {
          for (const listener of listeners) listener();
        }
      };

      yield* Effect.scoped(
        Effect.gen(function* () {
          const counter = yield* makeDailyAnalyticsCounter<{ readonly tool: string }>({
            event: "test.consent",
            keyOf: ({ tool }) => tool,
            interval: Duration.hours(1),
          });

          // Opted out: ignored, never carried forward if enabled later.
          counter.increment({ tool: "opted_out" }, 5);

          setEnabled(true);
          counter.increment({ tool: "before_opt_out" }, 2);
          // Toggling off drops pending counts immediately.
          setEnabled(false);

          setEnabled(true);
          counter.increment({ tool: "after_opt_in" }, 1);
          yield* counter.flush;
        }),
      ).pipe(
        Effect.provideService(AnalyticsService, {
          record: (event, properties) => Effect.sync(() => recorded.push({ event, properties })),
          flush: Effect.void,
          consent: {
            isEnabledSync: () => enabled,
            onDisabled: (listener) => {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
          },
        }),
      );

      assert.deepStrictEqual(recorded, [
        { event: "test.consent", properties: { tool: "after_opt_in", count: 1 } },
      ]);
    }),
  );
});
