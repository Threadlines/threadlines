/**
 * DrainableWorker - A queue-based worker that exposes a `drain()` effect.
 *
 * Wraps the common `Queue.unbounded` + `Effect.forever` pattern and adds
 * a signal that resolves when the queue is empty **and** the current item
 * has finished processing. This lets tests replace timing-sensitive
 * `Effect.sleep` calls with deterministic `drain()`.
 *
 * @module DrainableWorker
 */
import * as Cause from "effect/Cause";
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface DrainableWorker<A> {
  /**
   * Enqueue a work item and track it for `drain()`.
   *
   * This wraps `Queue.offer` so drain state is updated atomically with the
   * enqueue path instead of inferring it from queue internals.
   */
  readonly enqueue: (item: A) => Effect.Effect<void>;

  /**
   * Resolves when the queue is empty and the worker is idle (not processing).
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * Create a drainable worker that processes items from an unbounded queue.
 *
 * The worker is forked into the current scope and will be interrupted when
 * the scope closes. A finalizer shuts down the queue.
 *
 * @param process - The effect to run for each queued item.
 * @returns A `DrainableWorker` with `queue` and `drain`.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<A>(), TxQueue.shutdown);
    const outstanding = yield* TxRef.make(0);

    yield* TxQueue.take(queue).pipe(
      Effect.tap((a) =>
        Effect.ensuring(
          process(a),
          TxRef.update(outstanding, (n) => n - 1),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue = (element: A): Effect.Effect<boolean, never, never> =>
      TxQueue.offer(queue, element).pipe(
        Effect.tap(() => TxRef.update(outstanding, (n) => n + 1)),
        Effect.tx,
      );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });

export interface KeyedDrainableWorkerOptions<K, A> {
  readonly keyOf: (item: A) => K;
  readonly maxConcurrency: number;
}

interface QueueNode<A> {
  readonly head: A;
  readonly tail: QueueNode<A> | null;
}

/** Persistent FIFO queue (Okasaki banker's queue) with O(1) amortized append and pop, safe under STM retries. */
interface KeyedLane<A> {
  readonly front: QueueNode<A> | null;
  readonly back: QueueNode<A> | null;
}

function laneIsEmpty<A>(lane: KeyedLane<A> | undefined): boolean {
  return lane === undefined || (lane.front === null && lane.back === null);
}

function laneEnqueue<A>(lane: KeyedLane<A> | undefined, item: A): KeyedLane<A> {
  if (lane === undefined) {
    return { front: { head: item, tail: null }, back: null };
  }
  return { front: lane.front, back: { head: item, tail: lane.back } };
}

function laneDequeue<A>(lane: KeyedLane<A>): readonly [item: A, rest: KeyedLane<A> | null] | null {
  let front = lane.front;
  let back = lane.back;
  if (front === null) {
    if (back === null) {
      return null;
    }
    while (back !== null) {
      front = { head: back.head, tail: front };
      back = back.tail;
    }
  }
  const item = front!.head;
  const nextFront = front!.tail;
  if (nextFront === null && back === null) {
    return [item, null] as const;
  }
  return [item, { front: nextFront, back }] as const;
}

interface KeyedDrainableWorkerState<K, A> {
  readonly lanesByKey: Map<K, KeyedLane<A>>;
  readonly queuedKeys: Set<K>;
  readonly activeKeys: Set<K>;
  readonly outstanding: number;
}

/**
 * Create a drainable worker sharded by key.
 *
 * Items sharing a key run strictly FIFO one at a time, while distinct keys run
 * concurrently up to `maxConcurrency`. Keys with more queued work rotate to the
 * back of the ready queue after each item so one busy key cannot starve others.
 */
export const makeKeyedDrainableWorker = <K, A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
  options: KeyedDrainableWorkerOptions<K, A>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const concurrency = Math.max(1, Math.floor(options.maxConcurrency));
    const readyKeys = yield* Effect.acquireRelease(TxQueue.unbounded<K>(), TxQueue.shutdown);
    const stateRef = yield* TxRef.make<KeyedDrainableWorkerState<K, A>>({
      lanesByKey: new Map(),
      queuedKeys: new Set(),
      activeKeys: new Set(),
      outstanding: 0,
    });

    const releaseKey = (key: K): Effect.Effect<void> =>
      TxRef.modify(stateRef, (state) => {
        const activeKeys = new Set(state.activeKeys);
        activeKeys.delete(key);
        const outstanding = Math.max(0, state.outstanding - 1);
        const lane = state.lanesByKey.get(key);
        if (!laneIsEmpty(lane) && !state.queuedKeys.has(key)) {
          const queuedKeys = new Set(state.queuedKeys);
          queuedKeys.add(key);
          return [true, { ...state, activeKeys, queuedKeys, outstanding }] as const;
        }
        return [false, { ...state, activeKeys, outstanding }] as const;
      }).pipe(
        Effect.flatMap((shouldRequeue) =>
          shouldRequeue ? TxQueue.offer(readyKeys, key) : Effect.void,
        ),
        Effect.tx,
        Effect.asVoid,
      );

    const takeNextForKey = (key: K) =>
      TxRef.modify(stateRef, (state) => {
        const queuedKeys = new Set(state.queuedKeys);
        queuedKeys.delete(key);
        const lane = state.lanesByKey.get(key);
        const dequeued = lane === undefined ? null : laneDequeue(lane);
        if (dequeued === null) {
          const lanesByKey = new Map(state.lanesByKey);
          lanesByKey.delete(key);
          return [null, { ...state, lanesByKey, queuedKeys }] as const;
        }
        const [item, rest] = dequeued;
        const lanesByKey = new Map(state.lanesByKey);
        if (rest === null) {
          lanesByKey.delete(key);
        } else {
          lanesByKey.set(key, rest);
        }
        const activeKeys = new Set(state.activeKeys);
        activeKeys.add(key);
        return [{ key, item } as const, { ...state, lanesByKey, queuedKeys, activeKeys }] as const;
      }).pipe(Effect.tx);

    const workerLoop = TxQueue.take(readyKeys).pipe(
      Effect.flatMap(takeNextForKey),
      Effect.flatMap((taken) =>
        taken === null
          ? Effect.void
          : process(taken.item).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.void,
              ),
              Effect.ensuring(releaseKey(taken.key)),
            ),
      ),
      Effect.forever,
    );

    for (let index = 0; index < concurrency; index += 1) {
      yield* Effect.forkScoped(workerLoop);
    }

    const enqueue: DrainableWorker<A>["enqueue"] = (item) => {
      const key = options.keyOf(item);
      return TxRef.modify(stateRef, (state) => {
        const lanesByKey = new Map(state.lanesByKey);
        lanesByKey.set(key, laneEnqueue(lanesByKey.get(key), item));
        const outstanding = state.outstanding + 1;
        if (state.queuedKeys.has(key) || state.activeKeys.has(key)) {
          return [false, { ...state, lanesByKey, outstanding }] as const;
        }
        const queuedKeys = new Set(state.queuedKeys);
        queuedKeys.add(key);
        return [true, { ...state, lanesByKey, queuedKeys, outstanding }] as const;
      }).pipe(
        Effect.flatMap((shouldOffer) =>
          shouldOffer ? TxQueue.offer(readyKeys, key) : Effect.void,
        ),
        Effect.tx,
        Effect.asVoid,
      );
    };

    const drain: DrainableWorker<A>["drain"] = TxRef.get(stateRef).pipe(
      Effect.tap((state) => (state.outstanding > 0 ? Effect.txRetry : Effect.void)),
      Effect.asVoid,
      Effect.tx,
    );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });
