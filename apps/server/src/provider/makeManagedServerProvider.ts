import type { ServerProvider } from "@threadlines/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import type { ServerProviderShape } from "./Services/ServerProvider.ts";
import { ServerSettingsError } from "@threadlines/contracts";

interface ProviderSnapshotState {
  readonly snapshot: ServerProvider;
  readonly enrichmentGeneration: number;
}

/** `now`, or a millisecond past `base` when the clock hasn't moved past it. */
function laterThan(base: string, now: string): string {
  if (now > base) return now;
  const baseMs = Date.parse(base);
  return Number.isFinite(baseMs) ? new Date(baseMs + 1).toISOString() : now;
}

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly maintenanceCapabilities: ServerProviderShape["maintenanceCapabilities"];
  readonly getSettings: Effect.Effect<Settings>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly initialSnapshot: (settings: Settings) => Effect.Effect<ServerProvider>;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  /**
   * Folds what the previous snapshot knew into a freshly checked one. Runs
   * inside the same atomic update that publishes the check, so a patch that
   * landed while the check ran is seen rather than lost.
   */
  readonly reconcileSnapshot?: (previous: ServerProvider, next: ServerProvider) => ServerProvider;
  readonly enrichSnapshot?: (input: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly getSnapshot: Effect.Effect<ServerProvider>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
    /**
     * Applies an enrichment to the snapshot as it is now, not as it was when
     * the enrichment started. Use it to write only the fields the enrichment
     * owns, so a patch that landed meanwhile survives.
     */
    readonly updateSnapshot: (
      update: (current: ServerProvider) => ServerProvider,
    ) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
  readonly refreshInterval?: Duration.Input;
  /** Retry one transient snapshot sooner than the normal maintenance cadence. */
  readonly shouldRetrySnapshot?: (snapshot: ServerProvider) => boolean;
  readonly retryDelay?: Duration.Input;
}): Effect.fn.Return<ServerProviderShape, ServerSettingsError, Scope.Scope> {
  const refreshSemaphore = yield* Semaphore.make(1);
  // Held while the snapshot changes and the change is published, and while
  // a subscriber joins: each subscriber sees the changes in the order they
  // happened, and one that joins misses none (`streamSnapshots`).
  const publishLock = yield* Semaphore.make(1);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const initialSettings = yield* input.getSettings;
  const initialSnapshot = yield* input.initialSnapshot(initialSettings);
  const snapshotStateRef = yield* Ref.make<ProviderSnapshotState>({
    snapshot: initialSnapshot,
    enrichmentGeneration: 0,
  });
  const settingsRef = yield* Ref.make(initialSettings);
  const enrichmentFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const retryFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const scope = yield* Effect.scope;

  const publishEnrichedSnapshot = Effect.fn("publishEnrichedSnapshot")(function* (
    generation: number,
    enrich: (current: ServerProvider) => ServerProvider,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* publishLock.withPermits(1)(
      Effect.gen(function* () {
        const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
          if (state.enrichmentGeneration !== generation) {
            return [null, state] as const;
          }
          const enriched = enrich(state.snapshot);
          if (Equal.equals(state.snapshot, enriched)) {
            return [null, state] as const;
          }
          // Later than the snapshot it builds on: the registry keeps the newer of
          // two snapshots by `checkedAt`, and a copy of the plain one that reaches
          // it second (a newly added instance is read and streamed at once) would
          // otherwise replace this one, losing what the enrichment added.
          const nextSnapshot =
            enriched.checkedAt > state.snapshot.checkedAt
              ? enriched
              : { ...enriched, checkedAt: laterThan(state.snapshot.checkedAt, now) };
          return [
            nextSnapshot,
            {
              ...state,
              snapshot: nextSnapshot,
            },
          ] as const;
        });
        if (snapshotToPublish === null) {
          return;
        }
        yield* PubSub.publish(changesPubSub, snapshotToPublish);
      }),
    );
  });

  const restartSnapshotEnrichment = Effect.fn("restartSnapshotEnrichment")(function* (
    settings: Settings,
    snapshot: ServerProvider,
    generation: number,
  ) {
    const previousFiber = yield* Ref.getAndSet(enrichmentFiberRef, null);
    if (previousFiber) {
      yield* Fiber.interrupt(previousFiber).pipe(Effect.ignore);
    }

    if (!input.enrichSnapshot) {
      return;
    }

    const fiber = yield* input
      .enrichSnapshot({
        settings,
        snapshot,
        getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
        publishSnapshot: (nextSnapshot) => publishEnrichedSnapshot(generation, () => nextSnapshot),
        updateSnapshot: (update) => publishEnrichedSnapshot(generation, update),
      })
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));

    yield* Ref.set(enrichmentFiberRef, fiber);
  });

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean; readonly scheduleRetry?: boolean },
  ) {
    const forceRefresh = options?.forceRefresh === true;
    const previousSettings = yield* Ref.get(settingsRef);
    if (!forceRefresh && !input.haveSettingsChanged(previousSettings, nextSettings)) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    }

    const checkedSnapshot = yield* input.checkProvider;
    const [nextSnapshot, nextGeneration] = yield* publishLock.withPermits(1)(
      Effect.gen(function* () {
        const changed = yield* Ref.modify(snapshotStateRef, (state) => {
          const generation = input.enrichSnapshot
            ? state.enrichmentGeneration + 1
            : state.enrichmentGeneration;
          const snapshot = input.reconcileSnapshot
            ? input.reconcileSnapshot(state.snapshot, checkedSnapshot)
            : checkedSnapshot;
          return [
            [snapshot, generation] as const,
            {
              snapshot,
              enrichmentGeneration: generation,
            },
          ] as const;
        });
        yield* PubSub.publish(changesPubSub, changed[0]);
        return changed;
      }),
    );
    yield* Ref.set(settingsRef, nextSettings);
    yield* restartSnapshotEnrichment(nextSettings, nextSnapshot, nextGeneration);
    return nextSnapshot;
  });
  const applySnapshot = (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean; readonly scheduleRetry?: boolean },
  ) => {
    const applied = refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));
    if (!input.shouldRetrySnapshot || options?.scheduleRetry === false) {
      return applied;
    }
    return applied.pipe(Effect.tap(reconcileSnapshotRetry));
  };

  function reconcileSnapshotRetry(snapshot: ServerProvider): Effect.Effect<void> {
    return Effect.gen(function* () {
      const previousFiber = yield* Ref.getAndSet(retryFiberRef, null);
      if (previousFiber) {
        yield* Fiber.interrupt(previousFiber).pipe(Effect.ignore);
      }
      if (!input.shouldRetrySnapshot?.(snapshot)) {
        return;
      }

      // A timeout is weak evidence on a busy machine. Give it one quiet retry
      // before falling back to the normal maintenance interval; repeated fast
      // probes would only make an overloaded machine worse.
      const fiber = yield* Effect.sleep(input.retryDelay ?? "60 seconds").pipe(
        Effect.flatMap(() => Ref.set(retryFiberRef, null)),
        Effect.flatMap(() => input.getSettings),
        Effect.flatMap((nextSettings) =>
          applySnapshot(nextSettings, { forceRefresh: true, scheduleRetry: false }),
        ),
        Effect.asVoid,
        Effect.ignoreCause({ log: true }),
        Effect.forkIn(scope),
      );
      yield* Ref.set(retryFiberRef, fiber);
    });
  }

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* () {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { forceRefresh: true });
  });

  // Out-of-band snapshot patch (no probe, no enrichment restart). Keeps the
  // enrichment generation untouched so an in-flight enrichment still wins its
  // own race; a lost patch is refreshed by the next provider event or probe.
  const patchSnapshot = Effect.fn("patchSnapshot")(function* (
    patch: (current: ServerProvider) => ServerProvider | null,
  ) {
    const snapshotToPublish = yield* publishLock.withPermits(1)(
      Effect.gen(function* () {
        const patched = yield* Ref.modify(snapshotStateRef, (state) => {
          const nextSnapshot = patch(state.snapshot);
          if (nextSnapshot === null || nextSnapshot === state.snapshot) {
            return [null, state] as const;
          }
          return [
            nextSnapshot,
            {
              ...state,
              snapshot: nextSnapshot,
            },
          ] as const;
        });
        if (patched !== null) yield* PubSub.publish(changesPubSub, patched);
        return patched;
      }),
    );
    if (snapshotToPublish === null) {
      return;
    }
    if (input.shouldRetrySnapshot) {
      yield* reconcileSnapshotRetry(snapshotToPublish);
    }
  });

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)),
  ).pipe(Effect.forkScoped);

  yield* Effect.forever(
    Effect.sleep(input.refreshInterval ?? "60 seconds").pipe(
      Effect.flatMap(() => refreshSnapshot()),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* applySnapshot(initialSettings, { forceRefresh: true }).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );

  return {
    get maintenanceCapabilities() {
      return input.maintenanceCapabilities;
    },
    // Reads the cached snapshot without probing or queueing behind the
    // refresh semaphore — startup paths must never wait on a slow probe.
    getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
    refresh: refreshSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    // Joined under the publish lock: the snapshot read here is the newest,
    // and every change after it is in the subscription, in order.
    get streamSnapshots() {
      return Stream.unwrap(
        publishLock.withPermits(1)(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(changesPubSub);
            const { snapshot } = yield* Ref.get(snapshotStateRef);
            return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription));
          }),
        ),
      );
    },
    patchSnapshot,
  } satisfies ServerProviderShape;
});
