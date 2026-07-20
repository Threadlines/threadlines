import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeKeyedSequentialWorker } from "./KeyedSequentialWorker.ts";

describe("makeKeyedSequentialWorker", () => {
  it.live("processes items for different keys concurrently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const blockerStarted = yield* Deferred.make<void>();
        const releaseBlocker = yield* Deferred.make<void>();
        const otherProcessed = yield* Deferred.make<void>();

        const worker = yield* makeKeyedSequentialWorker((key: string, _item: string) =>
          Effect.gen(function* () {
            if (key === "blocked-thread") {
              yield* Deferred.succeed(blockerStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseBlocker);
              return;
            }
            yield* Deferred.succeed(otherProcessed, undefined).pipe(Effect.orDie);
          }),
        );

        yield* worker.enqueue("blocked-thread", "slow start");
        yield* Deferred.await(blockerStarted);

        // The blocked key must not stall the other key's item.
        yield* worker.enqueue("fast-thread", "turn");
        yield* Deferred.await(otherProcessed);

        yield* Deferred.succeed(releaseBlocker, undefined);
        yield* worker.drain;
      }),
    ),
  );

  it.live("preserves FIFO order within a key, including items enqueued mid-processing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();

        const worker = yield* makeKeyedSequentialWorker((_key: string, item: string) =>
          Effect.gen(function* () {
            if (item === "first") {
              yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseFirst);
            }
            processed.push(item);
          }),
        );

        yield* worker.enqueue("thread", "first");
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue("thread", "second");
        yield* worker.enqueue("thread", "third");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* worker.drain;

        expect(processed).toEqual(["first", "second", "third"]);
      }),
    ),
  );

  it.live("drain waits for queued and active work across all keys", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const drained = yield* Deferred.make<void>();
        const processed: string[] = [];

        const worker = yield* makeKeyedSequentialWorker((_key: string, item: string) =>
          Effect.gen(function* () {
            if (item === "blocking") {
              yield* Deferred.succeed(started, undefined).pipe(Effect.orDie);
              yield* Deferred.await(release);
            }
            processed.push(item);
          }),
        );

        yield* worker.enqueue("a", "blocking");
        yield* Deferred.await(started);
        yield* worker.enqueue("b", "queued-behind-nothing");
        yield* worker.enqueue("a", "queued-behind-blocking");

        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(drained);

        expect(processed).toContain("blocking");
        expect(processed).toContain("queued-behind-nothing");
        expect(processed).toContain("queued-behind-blocking");
      }),
    ),
  );

  it.live("a failing item stops only its own key and does not wedge drain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];

        const worker = yield* makeKeyedSequentialWorker((_key: string, item: string) =>
          Effect.gen(function* () {
            if (item === "explode") {
              return yield* Effect.fail(new Error("boom"));
            }
            processed.push(item);
          }),
        );

        yield* worker.enqueue("bad", "explode");
        yield* worker.enqueue("good", "survives");
        yield* worker.drain;

        expect(processed).toEqual(["survives"]);

        // The failed key accepts new work with a fresh runner afterwards.
        yield* worker.enqueue("bad", "recovered");
        yield* worker.drain;
        expect(processed).toEqual(["survives", "recovered"]);
      }),
    ),
  );
});
