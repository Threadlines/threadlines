/**
 * Collects a PiRpc's records for tests and waits for the ones a test expects.
 * Waiters registered before the record arrives see it; so do ones registered
 * after (they scan what was already collected first).
 *
 * @module provider/pi/testing/PiRecordLog
 */
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { PiRecord, PiRpc } from "../PiRpc.ts";

/** No matching record arrived before the wait's timeout. */
export class PiRecordTimeoutError extends Data.TaggedError("PiRecordTimeoutError") {
  override get message(): string {
    return "timed out waiting for a Pi record";
  }
}

export interface PiRecordLog {
  readonly all: ReadonlyArray<PiRecord>;
  /** The first record at or after `from` (an index into `all`) that matches. */
  readonly waitFor: (
    predicate: (record: PiRecord) => boolean,
    options?: { readonly from?: number; readonly timeout?: Duration.Input },
  ) => Effect.Effect<PiRecord, PiRecordTimeoutError>;
  /** Index of the next record to arrive. */
  readonly mark: () => number;
}

export const collectPiRecords = (rpc: PiRpc): Effect.Effect<PiRecordLog, never, Scope.Scope> =>
  Effect.gen(function* () {
    const all: Array<PiRecord> = [];
    const waiters: Array<{
      readonly from: number;
      readonly predicate: (record: PiRecord) => boolean;
      readonly done: Deferred.Deferred<PiRecord>;
    }> = [];
    yield* rpc.records.pipe(
      Stream.runForEach((record) =>
        Effect.sync(() => {
          all.push(record);
          const index = all.length - 1;
          // A copy: a matched waiter leaves the list during the loop.
          for (const waiter of Array.from(waiters)) {
            if (index >= waiter.from && waiter.predicate(record)) {
              waiters.splice(waiters.indexOf(waiter), 1);
              Deferred.doneUnsafe(waiter.done, Effect.succeed(record));
            }
          }
        }),
      ),
      Effect.forkScoped,
    );
    return {
      all,
      mark: () => all.length,
      waitFor: (predicate, options) =>
        Effect.gen(function* () {
          const from = options?.from ?? 0;
          const existing = all.slice(from).find(predicate);
          if (existing) return existing;
          const done = yield* Deferred.make<PiRecord>();
          waiters.push({ from, predicate, done });
          const found = yield* Deferred.await(done).pipe(
            Effect.timeoutOption(options?.timeout ?? Duration.seconds(20)),
          );
          return yield* Option.match(found, {
            onNone: () => Effect.fail(new PiRecordTimeoutError()),
            onSome: Effect.succeed,
          });
        }),
    } satisfies PiRecordLog;
  });
