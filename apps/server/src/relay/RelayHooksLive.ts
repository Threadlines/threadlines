/**
 * The relay client's half of event tasks: implements RelayHooks.ts (read its
 * notes first). Built inside RelayHost, which owns the relay registration
 * and the control socket, through a `RelayHookLink`; RelayHostLive provides
 * both services.
 *
 * - Every hook call to the relay (a mint, or the whole wanted state as a
 *   `PUT`) takes a fresh revision, stored before the call is sent; the relay
 *   applies a call only if its revision is newer than any it applied. Calls
 *   go one at a time, and a mint's hook joins the stored state before the
 *   next call, so no state this computer sends can retire a newer hook.
 * - The relay is known to hold exactly the stored state when
 *   `syncedRevision === revision`. Otherwise the state is sent again after
 *   every change and on every reconnect, and the control socket stays open
 *   until it is applied.
 * - When the relay answers that it no longer knows this computer, the stored
 *   credentials are dropped, the computer registers again, and `host-changed`
 *   tells the pipeline to mint every hook again.
 */
import {
  RELAY_ERROR_HOOKS_OFF,
  RELAY_ERROR_STALE_REVISION,
  type RelayControlMessage,
  type RelayHookDelivery,
  type RelayHookDeliveryId,
} from "@threadlines/contracts";
import { hookDeliveryAad, openHookDelivery } from "@threadlines/shared/relayHookSeal";
import type { StoredKeyPair } from "@threadlines/shared/relaySecure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { isRelayHostGone, type RelayApiError, relayApi } from "./relayApi.ts";
import {
  type RelayHookOpened,
  RelayHooks,
  RelayHooksError,
  type RelayHooksChange,
  type RelayHooksShape,
  type RelayHookWanted,
} from "./RelayHooks.ts";
import {
  EMPTY_RELAY_HOOK_STATE,
  type RelayHookState,
  RelayHookStateRepository,
} from "./RelayHookStateRepository.ts";
import { loadOrCreateStoredKeyPair } from "./storedKeys.ts";

const HOOK_KEY_NAME = "relay-hook-key";
/** The relay takes at most this many ids per `hook.ack`, and one ack frame a second. */
const ACK_BATCH = 100;
const ACK_INTERVAL_MS = 1_000;
/** Registering again after the relay forgot this computer happens at most this often. */
const RECOVERY_INTERVAL_MS = 10 * 60_000;
/** A state the relay couldn't take while connected is sent again after this long. */
const SYNC_RETRY_MS = 60_000;
/** A call that lost to a newer revision is retried this many times with a fresh one. */
const STALE_RETRIES = 2;

export interface RelayHookCredentials {
  readonly hostId: string;
  readonly hostSecret: string;
}

/** A hook frame from the control socket. */
export type RelayHookFrame =
  | { readonly type: "hook.delivery"; readonly delivery: RelayHookDelivery }
  | {
      readonly type: "hook.pending";
      readonly deliveryId: RelayHookDeliveryId;
      readonly hookId: RelayHookDelivery["hookId"];
      readonly receivedAt: string;
      readonly size: number;
    };

/** What the hook client needs from RelayHost. */
export interface RelayHookLink {
  /** The relay's origin; null when the configured relay address isn't valid. */
  readonly relayOrigin: string | null;
  /** This computer's stored relay credentials, or null while it isn't registered. */
  readonly credentials: Effect.Effect<RelayHookCredentials | null>;
  /** Registers this computer if it isn't yet (one registration at a time). */
  readonly register: Effect.Effect<RelayHookCredentials, RelayHooksError>;
  /** Drops the stored credentials, if they are still `hostId`'s. */
  readonly forgetHost: (hostId: string) => Effect.Effect<void>;
  /** Sends a control frame now; false when the control socket isn't open. */
  readonly sendControl: (message: RelayControlMessage) => boolean;
  readonly isConnected: () => boolean;
  /** Opens the control socket if it should be open and isn't. */
  readonly wake: () => void;
}

/** The hook client as RelayHost drives it. */
export interface RelayHooksClient {
  readonly service: RelayHooksShape;
  /** True while any hook is wanted or the relay may not hold this computer's state. */
  readonly wantsRelay: Effect.Effect<boolean>;
  /** Before the control socket opens: notices that the relay identity changed. */
  readonly beforeConnect: Effect.Effect<void>;
  /** The relay accepted the control socket (its snapshot arrived). */
  readonly connected: Effect.Effect<void>;
  /** The control socket was refused before it opened: checks the relay still knows `creds`. */
  readonly refused: (creds: RelayHookCredentials) => Effect.Effect<void>;
  /** A hook frame from the control socket; frames are handled one at a time, in order. */
  readonly receive: (frame: RelayHookFrame) => void;
}

function hooksErrorFrom(error: RelayApiError): RelayHooksError {
  if (error.status === null) {
    return new RelayHooksError({ detail: "Couldn't reach the relay. Events wait for it." });
  }
  if (error.code === RELAY_ERROR_HOOKS_OFF || (error.status === 404 && !error.code)) {
    return new RelayHooksError({ detail: "This relay doesn't take events yet." });
  }
  return new RelayHooksError({ detail: error.detail });
}

/** The same hooks with the same kept headers, in any order. */
function sameHooks(left: ReadonlyArray<RelayHookWanted>, right: ReadonlyArray<RelayHookWanted>) {
  const key = (hook: RelayHookWanted) => `${hook.hookId}\u0000${hook.keptHeaders.join(",")}`;
  const rightKeys = new Set(right.map(key));
  return left.length === right.length && left.every((hook) => rightKeys.has(key(hook)));
}

export const makeRelayHooks = (
  link: RelayHookLink,
): Effect.Effect<
  RelayHooksClient,
  never,
  RelayHookStateRepository | ServerSecretStore | Scope.Scope
> =>
  Effect.gen(function* () {
    const repo = yield* RelayHookStateRepository;
    const secrets = yield* ServerSecretStore;
    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);

    const lock = yield* Semaphore.make(1);
    const keyLock = yield* Semaphore.make(1);
    let state: RelayHookState = yield* repo.get.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("relay.hooks.state-load-failed", { cause }).pipe(
          Effect.as(EMPTY_RELAY_HOOK_STATE),
        ),
      ),
    );
    let hookKeyCache: StoredKeyPair | null = null;
    let lastRecoveryAt = 0;

    const changes = yield* PubSub.unbounded<RelayHooksChange>({ replay: 1 });
    const inbound = yield* Queue.unbounded<RelayHookFrame>();
    const opened = yield* Queue.unbounded<RelayHookOpened>();
    /** Deliveries in `opened` not yet taken by the consumer; a replay of one is skipped. */
    const queued = new Set<string>();
    const pendingAcks = new Set<RelayHookDeliveryId>();
    let ackTimer: ReturnType<typeof setTimeout> | null = null;
    let lastAckAt = 0;
    let syncRetryTimer: ReturnType<typeof setTimeout> | null = null;

    const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());

    /** Stores the state; a storage failure is logged and the state kept in memory. */
    const save = (next: RelayHookState) =>
      repo.save(next, nowIso()).pipe(
        Effect.catchCause((cause) => Effect.logWarning("relay.hooks.state-save-failed", { cause })),
        Effect.andThen(
          Effect.sync(() => {
            state = next;
          }),
        ),
      );

    /** This computer's hook key: deliveries are sealed to its public half. */
    const hookKey = keyLock
      .withPermits(1)(
        Effect.suspend(() =>
          hookKeyCache
            ? Effect.succeed(hookKeyCache)
            : loadOrCreateStoredKeyPair(secrets, HOOK_KEY_NAME).pipe(
                Effect.tap((stored) =>
                  Effect.sync(() => {
                    hookKeyCache = stored;
                  }),
                ),
              ),
        ),
      )
      .pipe(
        Effect.mapError(
          () => new RelayHooksError({ detail: "This computer's event key couldn't be loaded." }),
        ),
      );

    const wantsRelay = Effect.sync(
      () => state.active.length > 0 || state.syncedRevision < state.revision,
    );

    // ----- relay identity ---------------------------------------------------------

    /** The hooks belonged to another relay identity: they're gone with it. Lock held. */
    const resetForHostLocked = (hostId: string) =>
      Effect.gen(function* () {
        yield* save({ ...state, active: [], syncedRevision: state.revision, mintedHostId: hostId });
        yield* PubSub.publish(changes, { kind: "host-changed", hostId });
      });

    const noticeHostLocked = (creds: RelayHookCredentials) =>
      state.mintedHostId !== null && state.mintedHostId !== creds.hostId
        ? resetForHostLocked(creds.hostId)
        : Effect.void;

    /**
     * The relay said it doesn't know `gone` any more: forget it, register
     * again, and start the hooks over under the new identity. Lock held.
     */
    const recoverHostLocked = (gone: RelayHookCredentials) =>
      Effect.gen(function* () {
        // Already registered again since `gone` was read: nothing to recover.
        const current = yield* link.credentials;
        if (current && current.hostId !== gone.hostId) return current;
        if (Date.now() - lastRecoveryAt < RECOVERY_INTERVAL_MS) {
          yield* Effect.logWarning("relay.hooks.host-gone-again", { hostId: gone.hostId });
          return null;
        }
        lastRecoveryAt = Date.now();
        yield* Effect.logWarning("relay.hooks.host-gone", { hostId: gone.hostId });
        yield* link.forgetHost(gone.hostId);
        const fresh = yield* link.register;
        yield* resetForHostLocked(fresh.hostId);
        link.wake();
        return fresh;
      });

    // ----- wanted state ---------------------------------------------------------------

    /** Sends the wanted state if the relay may not hold it. Lock held. */
    const syncLocked = Effect.gen(function* () {
      const origin = link.relayOrigin;
      const creds = yield* link.credentials;
      if (!origin || !creds) return;
      yield* noticeHostLocked(creds);
      const key = yield* hookKey;
      const keyChanged = state.publicKey !== null && state.publicKey !== key.publicKey;
      if (state.syncedRevision >= state.revision && !keyChanged) return;
      for (let attempt = 0; attempt <= STALE_RETRIES; attempt += 1) {
        const revision = state.revision + 1;
        yield* save({ ...state, revision });
        const sent = yield* relayApi
          .setHooks(origin, creds.hostId, creds.hostSecret, {
            revision,
            publicKey: key.publicKey,
            active: state.active,
          })
          .pipe(Effect.result);
        if (Result.isFailure(sent)) {
          const error = sent.failure;
          if (isRelayHostGone(error)) {
            yield* recoverHostLocked(creds);
            return;
          }
          if (error.status === 404 && !error.code && state.active.length === 0) {
            // A relay without hooks has nothing to retire.
            yield* save({ ...state, syncedRevision: revision });
            return;
          }
          yield* Effect.logInfo("relay.hooks.sync-failed", { detail: error.detail });
          if (error.status === null || error.status === 429 || error.status >= 500) {
            scheduleSyncRetry();
          }
          return;
        }
        if (sent.success.applied) {
          yield* save({ ...state, syncedRevision: revision, publicKey: key.publicKey });
          return;
        }
        // The relay applied a newer revision than this computer remembers
        // (restored from a backup): go past it.
        yield* save({ ...state, revision: Math.max(state.revision, sent.success.revision) });
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("relay.hooks.sync-failed", { cause })));

    const sync = lock.withPermits(1)(syncLocked);

    /** Reconnects send the state again anyway; this covers a call that failed while connected. */
    function scheduleSyncRetry(): void {
      if (syncRetryTimer || !link.isConnected()) return;
      syncRetryTimer = setTimeout(() => {
        syncRetryTimer = null;
        runFork(sync);
      }, SYNC_RETRY_MS);
    }

    const mint: RelayHooksShape["mint"] = (input) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const origin = link.relayOrigin;
          if (!origin) {
            return yield* new RelayHooksError({ detail: "The relay address isn't valid." });
          }
          let creds = yield* link.register;
          yield* noticeHostLocked(creds);
          const key = yield* hookKey;
          const keptHeaders = [...input.keptHeaders];
          for (let attempt = 0; attempt <= STALE_RETRIES; attempt += 1) {
            const wasSynced = state.syncedRevision === state.revision;
            const revision = state.revision + 1;
            yield* save({ ...state, revision });
            const minted = yield* relayApi
              .mintHook(origin, creds.hostId, creds.hostSecret, {
                revision,
                publicKey: key.publicKey,
                keptHeaders,
              })
              .pipe(Effect.result);
            if (Result.isSuccess(minted)) {
              const hook = { hookId: minted.success.hookId, keptHeaders };
              // The relay now holds what it held plus this hook, with this key.
              yield* save({
                ...state,
                active: [...state.active, hook],
                syncedRevision: wasSynced ? revision : state.syncedRevision,
                mintedHostId: creds.hostId,
                publicKey: wasSynced ? key.publicKey : state.publicKey,
              });
              link.wake();
              return { hookId: hook.hookId, url: minted.success.url, hostId: creds.hostId };
            }
            const error = minted.failure;
            if (isRelayHostGone(error) && attempt === 0) {
              const fresh = yield* recoverHostLocked(creds);
              if (!fresh) return yield* hooksErrorFrom(error);
              creds = fresh;
              continue;
            }
            if (error.code === RELAY_ERROR_STALE_REVISION) {
              const status = yield* relayApi
                .hookStatus(origin, creds.hostId, creds.hostSecret)
                .pipe(Effect.mapError(hooksErrorFrom));
              yield* save({ ...state, revision: Math.max(state.revision, status.revision) });
              continue;
            }
            return yield* hooksErrorFrom(error);
          }
          return yield* new RelayHooksError({ detail: "The relay kept refusing the new address." });
        }),
      );

    const setActive: RelayHooksShape["setActive"] = (hooks) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const wanted = hooks.map((hook) => ({
              hookId: hook.hookId,
              keptHeaders: [...hook.keptHeaders],
            }));
            if (sameHooks(wanted, state.active)) return false;
            yield* save({ ...state, active: wanted, revision: state.revision + 1 });
            return true;
          }),
        )
        .pipe(
          Effect.tap((changed) =>
            Effect.sync(() => {
              if (!changed) return;
              runFork(sync);
              link.wake();
            }),
          ),
          Effect.asVoid,
        );

    // ----- deliveries -----------------------------------------------------------------

    function flushAcks(): void {
      ackTimer = null;
      if (pendingAcks.size === 0) return;
      const wait = lastAckAt + ACK_INTERVAL_MS - Date.now();
      if (wait > 0) {
        scheduleAckFlush(wait);
        return;
      }
      const batch = [...pendingAcks].slice(0, ACK_BATCH);
      // Not connected: the deliveries come again on connect and get acked then.
      if (!link.sendControl({ type: "hook.ack", deliveryIds: batch })) return;
      lastAckAt = Date.now();
      for (const id of batch) pendingAcks.delete(id);
      if (pendingAcks.size > 0) scheduleAckFlush(ACK_INTERVAL_MS);
    }

    function scheduleAckFlush(delayMs: number): void {
      if (ackTimer) return;
      ackTimer = setTimeout(flushAcks, Math.max(0, delayMs));
    }

    const ack: RelayHooksShape["ack"] = (deliveryIds) =>
      Effect.sync(() => {
        for (const id of deliveryIds) pendingAcks.add(id);
        scheduleAckFlush(lastAckAt + ACK_INTERVAL_MS - Date.now());
      });

    /** Fetches a delivery announced as too large for the socket; null when it can't be had now. */
    const fetchPending = (
      frame: Extract<RelayHookFrame, { type: "hook.pending" }>,
      origin: string,
      creds: RelayHookCredentials,
    ) =>
      relayApi.hookDelivery(origin, creds.hostId, creds.hostSecret, frame.deliveryId).pipe(
        Effect.catch((error) =>
          // Gone (acked or expired) needs nothing; anything else comes again on reconnect.
          (error.status === 404 && !isRelayHostGone(error)
            ? Effect.void
            : Effect.logInfo("relay.hooks.fetch-failed", {
                deliveryId: frame.deliveryId,
                detail: error.detail,
              })
          ).pipe(Effect.as(null)),
        ),
      );

    /** Opens one frame's delivery and queues it for the pipeline; one that can't be opened is acked. */
    const handleFrame = (frame: RelayHookFrame) =>
      Effect.gen(function* () {
        const origin = link.relayOrigin;
        const creds = yield* link.credentials;
        if (!origin || !creds) return;
        const announcedId =
          frame.type === "hook.delivery" ? frame.delivery.deliveryId : frame.deliveryId;
        if (queued.has(announcedId)) return;
        const delivery =
          frame.type === "hook.delivery"
            ? frame.delivery
            : yield* fetchPending(frame, origin, creds);
        if (!delivery) return;
        const key = yield* hookKey;
        const payload =
          delivery.deliveryId === announcedId
            ? yield* Effect.promise(() =>
                openHookDelivery({
                  keyPair: key,
                  aad: hookDeliveryAad(creds.hostId, delivery.hookId, delivery.deliveryId),
                  envelope: delivery.sealed,
                }),
              )
            : null;
        if (!payload) {
          // Sealed to a key this computer no longer has, or tampered with:
          // it will never open, so the relay shouldn't keep sending it.
          yield* Effect.logWarning("relay.hooks.delivery-unopenable", {
            deliveryId: announcedId,
            hookId: delivery.hookId,
          });
          yield* ack([announcedId]);
          return;
        }
        queued.add(delivery.deliveryId);
        yield* Queue.offer(opened, {
          deliveryId: delivery.deliveryId,
          hookId: delivery.hookId,
          payload,
        });
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("relay.hooks.delivery-failed", { cause })),
      );

    yield* Stream.fromQueue(inbound).pipe(Stream.runForEach(handleFrame), Effect.forkScoped);

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (ackTimer) clearTimeout(ackTimer);
        if (syncRetryTimer) clearTimeout(syncRetryTimer);
        ackTimer = null;
        syncRetryTimer = null;
      }),
    );

    const service = RelayHooks.of({
      mint,
      setActive,
      deliveries: Stream.fromQueue(opened).pipe(
        Stream.tap((delivery) =>
          Effect.sync(() => {
            queued.delete(delivery.deliveryId);
          }),
        ),
      ),
      ack,
      hostId: link.credentials.pipe(Effect.map((creds) => creds?.hostId ?? null)),
      changes: Stream.fromPubSub(changes),
      connected: Effect.sync(() => link.isConnected()),
    });

    return {
      service,
      wantsRelay,
      beforeConnect: lock.withPermits(1)(
        Effect.gen(function* () {
          const creds = yield* link.credentials;
          if (creds) yield* noticeHostLocked(creds);
        }),
      ),
      connected: Effect.gen(function* () {
        yield* sync;
        // Acks held while disconnected go out now (still at most one a second).
        if (ackTimer) clearTimeout(ackTimer);
        flushAcks();
        yield* PubSub.publish(changes, { kind: "reachable" });
      }),
      refused: (creds) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const origin = link.relayOrigin;
            if (!origin || !(yield* wantsRelay)) return;
            const current = yield* link.credentials;
            if (current?.hostId !== creds.hostId) return;
            const status = yield* relayApi
              .hookStatus(origin, creds.hostId, creds.hostSecret)
              .pipe(Effect.result);
            if (Result.isFailure(status) && isRelayHostGone(status.failure)) {
              yield* recoverHostLocked(creds);
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("relay.hooks.recovery-failed", { cause }),
            ),
          ),
        ),
      receive: (frame) => {
        Queue.offerUnsafe(inbound, frame);
      },
    } satisfies RelayHooksClient;
  });
