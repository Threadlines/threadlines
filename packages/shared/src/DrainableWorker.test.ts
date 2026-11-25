import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeDrainableWorker, makeKeyedDrainableWorker } from "./DrainableWorker.ts";

describe("makeDrainableWorker", () => {
  it.live("waits for work enqueued during active processing before draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeDrainableWorker((item: string) =>
          Effect.gen(function* () {
            if (item === "first") {
              yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseFirst);
            }

            if (item === "second") {
              yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseSecond);
            }

            processed.push(item);
          }),
        );

        yield* worker.enqueue("first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        yield* worker.enqueue("second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["first", "second"]);
      }),
    ),
  );
});

describe("makeKeyedDrainableWorker", () => {
  it.live("runs distinct keys concurrently while keeping each key strictly FIFO", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: Array<string> = [];
        const a1Started = yield* Deferred.make<void>();
        const b1Started = yield* Deferred.make<void>();
        const releaseA1 = yield* Deferred.make<void>();
        const releaseB1 = yield* Deferred.make<void>();

        const worker = yield* makeKeyedDrainableWorker(
          (item: { readonly key: string; readonly id: string }) =>
            Effect.gen(function* () {
              if (item.id === "a1") {
                yield* Deferred.succeed(a1Started, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseA1);
              }
              if (item.id === "b1") {
                yield* Deferred.succeed(b1Started, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseB1);
              }
              processed.push(item.id);
            }),
          {
            keyOf: (item) => item.key,
            maxConcurrency: 2,
          },
        );

        yield* worker.enqueue({ key: "a", id: "a1" });
        yield* worker.enqueue({ key: "a", id: "a2" });
        yield* worker.enqueue({ key: "b", id: "b1" });

        // Key "b" starts without waiting for key "a" to finish.
        yield* Deferred.await(a1Started);
        yield* Deferred.await(b1Started);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        yield* Deferred.succeed(releaseB1, undefined);
        yield* Deferred.succeed(releaseA1, undefined);
        yield* Deferred.await(drained);

        expect(processed.indexOf("a1")).toBeLessThan(processed.indexOf("a2"));
        expect(processed).toHaveLength(3);
        expect(new Set(processed)).toEqual(new Set(["a1", "a2", "b1"]));
      }),
    ),
  );
});
