/**
 * Event tasks' public addresses on the relay (docs/design/event-tasks.md),
 * as the scheduled-task pipeline sees them. The relay mints a hook per event
 * task; webhook requests to it are sealed to this computer's hook key, held
 * at the relay until acknowledged (24 hours at most), and handed over on the
 * relay control socket.
 *
 * This file is the contract between the relay client (which implements it,
 * RelayHooksLive) and the pipeline (apps/server/src/scheduled, which uses it).
 *
 * - `mint` registers this computer with the relay if it isn't yet, and gives
 *   a new hook its public address. It fails while the relay can't be
 *   reached; the caller keeps the task waiting for an address and tries again
 *   on `changes`.
 * - `setActive` is the whole wanted state: these hooks active, every other
 *   one of this computer's hooks retired. It returns once the state is stored
 *   on this computer; the relay client sends it (with a revision the relay
 *   enforces) now and on every reconnect until the relay has applied it, and
 *   keeps the relay connection open while any hook is active or a state is
 *   unsent.
 * - `deliveries` are opened and in arrival order. Delivery is at least once:
 *   a delivery comes again (after a reconnect) until `ack` names it, so the
 *   consumer acks only after storing it, and ignores a `deliveryId` it has.
 * - `changes` says when to look again: the relay became reachable (a
 *   waiting mint can be retried), or this computer got a new relay identity
 *   (`hostId` changed, every hook's address with it: mint them again).
 */
import type { RelayHookDeliveryId, RelayHookId } from "@threadlines/contracts";
import type { HookPayload } from "@threadlines/shared/relayHookSeal";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

export class RelayHooksError extends Schema.TaggedError<RelayHooksError>()("RelayHooksError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface RelayHookMinted {
  readonly hookId: RelayHookId;
  /** The full public address, mac included. */
  readonly url: string;
  /** The relay identity it was minted under. */
  readonly hostId: string;
}

export interface RelayHookWanted {
  readonly hookId: RelayHookId;
  /** Headers to keep beyond the always-kept ones (webhookTasks.ts webhookKeptHeaders). */
  readonly keptHeaders: ReadonlyArray<string>;
}

export interface RelayHookOpened {
  readonly deliveryId: RelayHookDeliveryId;
  readonly hookId: RelayHookId;
  readonly payload: HookPayload;
}

export type RelayHooksChange =
  | { readonly kind: "reachable" }
  | { readonly kind: "host-changed"; readonly hostId: string };

export interface RelayHooksShape {
  readonly mint: (input: {
    readonly keptHeaders: ReadonlyArray<string>;
  }) => Effect.Effect<RelayHookMinted, RelayHooksError>;
  readonly setActive: (hooks: ReadonlyArray<RelayHookWanted>) => Effect.Effect<void>;
  readonly deliveries: Stream.Stream<RelayHookOpened>;
  readonly ack: (deliveryIds: ReadonlyArray<RelayHookDeliveryId>) => Effect.Effect<void>;
  /** The relay identity hooks are minted under now; null before registration. */
  readonly hostId: Effect.Effect<string | null>;
  readonly changes: Stream.Stream<RelayHooksChange>;
  /** Whether the relay control socket is up now, for "Events can't reach this computer". */
  readonly connected: Effect.Effect<boolean>;
}

export class RelayHooks extends Context.Service<RelayHooks, RelayHooksShape>()(
  "threadlines/relay/RelayHooks",
) {}
