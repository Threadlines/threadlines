/**
 * KeyedSequentialWorker - per-key FIFO processing with cross-key concurrency.
 *
 * Every item is processed (no coalescing). Items sharing a key run strictly
 * in enqueue order on a single runner fiber; items with different keys run
 * concurrently on independent runner fibers. Runner fibers exist only while
 * their key has work. `drain()` resolves when no key has queued or active
 * work, mirroring `DrainableWorker.drain`.
 *
 * `process` must handle its own errors: a failing item terminates that key's
 * runner and discards the key's remaining queued items (other keys are
 * unaffected). Wrap `process` with error logging/recovery at the call site,
 * as `DrainableWorker` callers already do.
 *
 * @module KeyedSequentialWorker
 */
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface KeyedSequentialWorker<K, A> {
  /** Enqueue an item for its key, preserving per-key FIFO order. */
  readonly enqueue: (key: K, item: A) => Effect.Effect<void>;

  /** Resolves when no key has queued or active work. */
  readonly drain: Effect.Effect<void>;
}

interface KeyedSequentialWorkerState<K, A> {
  readonly pendingByKey: Map<K, ReadonlyArray<A>>;
  readonly activeKeys: Set<K>;
}

export const makeKeyedSequentialWorker = <K, A, E, R>(
  process: (key: K, item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<KeyedSequentialWorker<K, A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const activations = yield* Effect.acquireRelease(TxQueue.unbounded<K>(), TxQueue.shutdown);
    const stateRef = yield* TxRef.make<KeyedSequentialWorkerState<K, A>>({
      pendingByKey: new Map(),
      activeKeys: new Set(),
    });

    const takeNext = (key: K) =>
      TxRef.modify(stateRef, (state) => {
        const pending = state.pendingByKey.get(key);
        if (pending === undefined || pending.length === 0) {
          const pendingByKey = new Map(state.pendingByKey);
          pendingByKey.delete(key);
          const activeKeys = new Set(state.activeKeys);
          activeKeys.delete(key);
          return [null, { pendingByKey, activeKeys }] as const;
        }

        const pendingByKey = new Map(state.pendingByKey);
        if (pending.length === 1) {
          pendingByKey.delete(key);
        } else {
          pendingByKey.set(key, pending.slice(1));
        }
        return [pending[0] as A, { ...state, pendingByKey }] as const;
      }).pipe(Effect.tx);

    // Abnormal runner exit (process failure or interruption) leaves the key
    // marked active, which would wedge `drain` and block future activations.
    const clearKey = (key: K) =>
      TxRef.update(stateRef, (state) => {
        const pendingByKey = new Map(state.pendingByKey);
        pendingByKey.delete(key);
        const activeKeys = new Set(state.activeKeys);
        activeKeys.delete(key);
        return { pendingByKey, activeKeys };
      }).pipe(Effect.tx);

    const runLoop = (key: K): Effect.Effect<void, E, R> =>
      takeNext(key).pipe(
        Effect.flatMap((item) => {
          if (item === null) {
            return Effect.void;
          }
          return process(key, item).pipe(Effect.flatMap(() => runLoop(key)));
        }),
      );

    // Cleanup must not run on normal exit: `takeNext` already deactivated the
    // key atomically, and a concurrent enqueue may have re-activated it with a
    // fresh runner whose state an unconditional cleanup would wipe.
    const runKey = (key: K): Effect.Effect<void, E, R> =>
      runLoop(key).pipe(
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : clearKey(key))),
      );

    yield* TxQueue.take(activations).pipe(
      Effect.flatMap((key) => Effect.forkScoped(runKey(key))),
      Effect.forever,
      Effect.forkScoped,
    );

    const enqueue: KeyedSequentialWorker<K, A>["enqueue"] = (key, item) =>
      TxRef.modify(stateRef, (state) => {
        const pendingByKey = new Map(state.pendingByKey);
        const pending = pendingByKey.get(key);
        pendingByKey.set(key, pending === undefined ? [item] : [...pending, item]);

        if (state.activeKeys.has(key)) {
          return [false, { ...state, pendingByKey }] as const;
        }

        const activeKeys = new Set(state.activeKeys);
        activeKeys.add(key);
        return [true, { pendingByKey, activeKeys }] as const;
      }).pipe(
        Effect.flatMap((shouldActivate) =>
          shouldActivate ? TxQueue.offer(activations, key) : Effect.void,
        ),
        Effect.tx,
        Effect.asVoid,
      );

    const drain: KeyedSequentialWorker<K, A>["drain"] = TxRef.get(stateRef).pipe(
      Effect.tap((state) =>
        state.pendingByKey.size > 0 || state.activeKeys.size > 0 ? Effect.txRetry : Effect.void,
      ),
      Effect.asVoid,
      Effect.tx,
    );

    return { enqueue, drain } satisfies KeyedSequentialWorker<K, A>;
  });
